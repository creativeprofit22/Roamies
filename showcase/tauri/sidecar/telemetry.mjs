// Local telemetry: step start/end and one-off events from every layer, written as JSON lines to
// <dir>/YYYY-MM-DD.jsonl. The only telemetry file writer; schema and defaults are in docs/telemetry.md.
// Hot path (start/end/record) only builds an object and queues it; checking, redaction and writing
// happen in batches. A failed write is counted and dropped, never thrown.
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { redactText } from '@kenkaiiii/gg-ai';

export const SCHEMA = 1;
export const DEFAULTS = Object.freeze({ flushMs: 2000, flushAt: 200, queueCap: 2000, maxBytes: 20 * 1024 * 1024, keepDays: 14 });
export const COMPONENTS = ['host', 'voice', 'sidecar', 'webview'];
const KINDS = ['start', 'end', 'event'];
const OUTCOMES = ['ok', 'error', 'cancelled'];
const TEXT_KEYS = new Set(['text', 'reply']);
const IDENT = /^[\w.:/-]{0,64}$/;
const STEP = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const CODE = /^[a-z0-9_]{1,48}$/;
const KEY = /^[A-Za-z0-9_]{1,32}$/;
const RID = /^[0-9a-f]{32}$/;
const SID = /^[0-9a-f]{16}$/;
const MAX_ATTRS = 24;
const TEXT_MAX = 2000;

export const newRequestId = () => randomBytes(16).toString('hex');
export const newStepId = () => randomBytes(8).toString('hex');

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar day of an epoch-ms time, as the day file's name. */
export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const nullOr = (v, ok) => (v === null || v === undefined ? null : ok(v) ? v : undefined);

/** A checked copy of `e` with fields in schema order, or null if a required field is bad. Bad attrs are dropped. */
export function cleanEvent(e, { includeText = false, redact = redactText } = {}) {
  if (!e || typeof e !== 'object') return null;
  const schema = e.schema ?? SCHEMA;
  if (schema !== SCHEMA) return null;
  if (!Number.isInteger(e.ts) || e.ts <= 0) return null;
  const request_id = nullOr(e.request_id, (v) => typeof v === 'string' && RID.test(v));
  const parent_step_id = nullOr(e.parent_step_id, (v) => typeof v === 'string' && SID.test(v));
  const duration_ms = nullOr(e.duration_ms, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const outcome = nullOr(e.outcome, (v) => OUTCOMES.includes(v));
  const error_code = nullOr(e.error_code, (v) => typeof v === 'string' && CODE.test(v));
  if ([request_id, parent_step_id, duration_ms, outcome, error_code].includes(undefined)) return null;
  if (typeof e.step_id !== 'string' || !SID.test(e.step_id)) return null;
  if (!KINDS.includes(e.kind) || !COMPONENTS.includes(e.component)) return null;
  if (typeof e.step !== 'string' || e.step.length > 64 || !STEP.test(e.step)) return null;
  const attrs = {};
  let n = 0;
  for (const [k, v] of Object.entries(e.attrs && typeof e.attrs === 'object' ? e.attrs : {})) {
    if (n >= MAX_ATTRS || !KEY.test(k)) continue;
    let out;
    if (TEXT_KEYS.has(k)) {
      if (includeText && typeof v === 'string') out = redact(v.slice(0, TEXT_MAX * 2), { maxStringLength: TEXT_MAX });
    } else if (typeof v === 'boolean') out = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out = Math.round(v * 1000) / 1000;
    else if (typeof v === 'string' && IDENT.test(v) && redact(v) === v) out = v;
    if (out !== undefined) { attrs[k] = out; n++; }
  }
  return {
    schema: SCHEMA, ts: e.ts,
    app_version: typeof e.app_version === 'string' ? e.app_version.slice(0, 32) : '',
    os: typeof e.os === 'string' ? e.os.slice(0, 16) : '',
    request_id, step_id: e.step_id, parent_step_id, kind: e.kind, step: e.step, component: e.component,
    duration_ms: duration_ms === null ? null : Math.round(duration_ms * 1000) / 1000,
    outcome, error_code, attrs,
  };
}

/**
 * The sidecar's telemetry: start/end/record its own steps, ingest other layers' events, write batches.
 * `fs` (promises API), `now` (epoch ms) and `mono` (monotonic ms) can be injected for tests.
 */
export function createTelemetry({
  dir, version = '', platform = process.platform, includeText = false, enabled = true,
  fs = fsp, now = Date.now, mono = () => performance.now(), redact = redactText, timer = true, ...opts
} = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let queue = [], on = !!enabled, text = !!includeText;
  const sizes = new Map(), capped = new Set();
  const lost = { queue_full: 0, write_failed: 0, invalid: 0 };
  const stats = { written: 0, dropped: 0, failures: 0, capped: 0 };
  let dirReady = false, prunedFor = '', chain = Promise.resolve(), scheduled = false;

  const push = (e) => {
    if (!on) return;
    if (queue.length >= cfg.queueCap) { queue.shift(); lost.queue_full++; stats.dropped++; }
    queue.push(e);
    if (queue.length >= cfg.flushAt && !scheduled) { scheduled = true; setImmediate(() => { scheduled = false; flush(); }); }
  };
  const base = (step, kind, { requestId = null, parent = null, attrs = {}, at } = {}) => ({
    schema: SCHEMA, ts: Math.round(at ?? now()), app_version: version, os: platform, request_id: requestId ?? null,
    step_id: newStepId(), parent_step_id: parent?.id ?? parent ?? null, kind, step, component: 'sidecar',
    duration_ms: null, outcome: null, error_code: null, attrs,
  });

  /** Starts a step; the handle goes to end(). `at` back-dates the start (epoch ms). */
  function start(step, o = {}) {
    const e = base(step, 'start', o);
    const h = { id: e.step_id, requestId: e.request_id, parent: e.parent_step_id, step, t0: mono() - (o.at != null ? Math.max(0, now() - o.at) : 0), ended: false };
    push(e);
    return h;
  }
  function end(h, { outcome = 'ok', errorCode = null, attrs = {} } = {}) {
    if (!h || h.ended) return;
    h.ended = true;
    push({ ...base(h.step, 'end', { requestId: h.requestId, parent: h.parent, attrs }), step_id: h.id, duration_ms: mono() - h.t0, outcome, error_code: errorCode });
  }
  function record(step, { outcome = null, errorCode = null, ...o } = {}) {
    push({ ...base(step, 'event', o), outcome, error_code: errorCode });
  }
  /** Events from the host, voice helper or webview. Text attrs never come from other layers. */
  function ingest(events) {
    if (!on || !Array.isArray(events)) return;
    for (const raw of events.slice(0, cfg.queueCap)) {
      if (!raw || typeof raw !== 'object' || !COMPONENTS.includes(raw.component) || raw.component === 'sidecar') { lost.invalid++; stats.dropped++; continue; }
      const attrs = {};
      for (const [k, v] of Object.entries(raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {})) if (!TEXT_KEYS.has(k)) attrs[k] = v;
      push({ ...raw, app_version: raw.app_version || version, os: raw.os || platform, attrs });
    }
  }

  async function ensureDir() {
    if (dirReady) return;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    dirReady = true;
  }
  async function sizeOf(day) {
    if (!sizes.has(day)) sizes.set(day, await fs.stat(path.join(dir, `${day}.jsonl`)).then((s) => s.size, () => 0));
    return sizes.get(day);
  }
  async function prune(today) {
    if (prunedFor === today) return;
    prunedFor = today;
    const cutoff = dayOf(now() - (cfg.keepDays - 1) * 864e5);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) await fs.unlink(path.join(dir, f)).catch(() => {});
    }
    for (const d of [...capped]) if (d < cutoff) capped.delete(d);
  }
  // Retention holds even when off or idle; no ensureDir so an off switch never creates the folder.
  async function sweep() { try { await prune(dayOf(now())); } catch {} }

  async function write() {
    for (const [reason, count] of Object.entries(lost)) {
      if (count) { lost[reason] = 0; queue.push({ ...base('telemetry.dropped', 'event', { attrs: { count, reason } }) }); }
    }
    const batch = queue; queue = [];
    await sweep();
    if (!batch.length) return;
    const groups = new Map();
    for (const e of batch) {
      const c = cleanEvent(e, { includeText: text, redact });
      if (!c) { lost.invalid++; stats.dropped++; continue; }
      const day = dayOf(c.ts);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(JSON.stringify(c) + '\n');
    }
    for (const [day, lines] of groups) {
      if (capped.has(day)) { stats.capped += lines.length; continue; }
      let size, out = '', n = 0;
      try { size = await sizeOf(day); } catch { size = 0; }
      for (const l of lines) {
        const b = Buffer.byteLength(l);
        if (size + b > cfg.maxBytes) break;
        out += l; size += b; n++;
      }
      if (n < lines.length) {
        capped.add(day);
        stats.capped += lines.length - n;
        const note = JSON.stringify(cleanEvent({ ...base('telemetry.capped', 'event', { attrs: { bytes: cfg.maxBytes } }), ts: lines.length ? JSON.parse(lines[n]).ts : now() })) + '\n';
        out += note; size += Buffer.byteLength(note);
      }
      if (!out) continue;
      try {
        await ensureDir();
        await fs.appendFile(path.join(dir, `${day}.jsonl`), out, { mode: 0o600 });
        sizes.set(day, size);
        stats.written += n;
      } catch {
        dirReady = false; sizes.delete(day);
        stats.failures++; stats.dropped += n; lost.write_failed += n;
      }
    }
  }
  /** Writes what's queued; resolves when done. Never rejects. */
  function flush() {
    chain = chain.then(() => (on ? write() : ((queue = []), sweep()))).catch(() => { stats.failures++; });
    return chain;
  }
  chain = chain.then(sweep);
  const iv = timer ? setInterval(flush, cfg.flushMs) : null;
  iv?.unref?.();

  return {
    start, end, record, ingest, flush,
    async close() { if (iv) clearInterval(iv); await flush(); },
    setEnabled(v) { on = !!v; if (!on) queue = []; },
    setIncludeText(v) { text = !!v; },
    get enabled() { return on; },
    get includeText() { return text; },
    get pending() { return queue.length; },
    stats,
    dir,
  };
}
