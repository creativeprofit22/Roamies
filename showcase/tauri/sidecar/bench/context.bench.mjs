// Context benchmark: npm run bench:context -- [--runs 200] [--seed 1] [--repeat 1] [--budget 100000] [--sessions <dir>] [--json <file>]
//   live: [--live] [--live-runs 3] [--live-requests 12] [--live-budget 30000] [--model <id>]
// --repeat n reruns on seeds seed…seed+n−1 and only reports on_target if every run clears the target.
// What the history trim (fitContext) costs in prompt cache: the baseline (bench/context-baseline.mjs, the rules before
// screenshot batching) against the current rules in store.mjs, on the same days of work. The current rules run with
// token-rate calibration as the sidecar does (a per-day letters-per-token rate measured after each call); the baseline
// predates it and stays at the fixed 3.6.
// Offline (default, free): days of real requests, resampled from saved conversations (~/.gg/sidekick/sessions; the
// screenshot markers there turned back into screenshots), go through each policy the way the agent runs them (the trimmed
// history replaces the old one) and a model of Anthropic's prompt cache: breakpoints where gg-ai puts them (request
// anchor at 1 h, tail at 5 min), a 20-block lookback, entries expiring between requests. Paired by day.
// --live: sends the same histories to the signed-in model (16-token replies) and reads the provider's own cache numbers
// and time to first token. Spends tokens (an estimate prints first); not run in CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fitContext, CONTEXT_POLICY, calibrateCharsPerToken, contextChars, CHARS_PER_TOKEN } from '../store.mjs';
import { baselineFitContext } from './context-baseline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POLICIES = { baseline: baselineFitContext, [CONTEXT_POLICY]: fitContext };
// Policies that take the measured rate (charsPerToken) like the sidecar's transformContext; opts.calibrate overrides.
const CALIBRATED = new Set([fitContext]);
// Anthropic prices in input-token units: reads 0.1×, writes 2× for the 1 h anchor, 1.25× for the 5 min tail.
export const PRICE = { read: 0.1, write1h: 2, write5m: 1.25 };
const SHOT = "[A screenshot was here and you did see it when you answered; the image was removed afterwards to save space, so its absence doesn't mean you didn't see it. The screen has likely changed since: look again before describing or pointing at what's on it now.]";
const LOOKBACK = 20, TTL_1H = 3600e3, TTL_5M = 300e3, CALL_MS = 4000;
// Sizes from telemetry: system prompt and tools (~10k tokens), the live block on each request (~1.8k chars), and a
// screenshot on Claude 5-class models (high-res images, up to 4784 tokens). charsPerToken is how the cache model counts
// text, i.e. the content's true rate (lower it for number-heavy days).
export const DEFAULTS = { budget: 100_000, systemTokens: 10_000, liveChars: 1800, imageTokens: 4784, charsPerToken: 3.6 };

// ---------- workload ----------

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isRequest = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text' && p.text !== SHOT));
const unshot = (parts) => (Array.isArray(parts) ? parts.map((p) => (p?.type === 'text' && p.text === SHOT ? { type: 'image', mediaType: 'image/png', data: 'IMG' } : p)) : parts);

function paired(steps) {
  const calls = new Set(), results = new Set();
  for (const m of steps) {
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) if (p.type === 'tool_call') calls.add(p.id);
    if (m.role === 'tool') for (const r of m.content) results.add(r.toolCallId);
  }
  return [...calls].every((id) => results.has(id)) && [...results].every((id) => calls.has(id));
}

/** Requests ({ user, steps }) from saved conversations: screenshots put back, reasoning dropped (signed for its model). */
export function loadRequests(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return out; }
  for (const n of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    let cur = null;
    for (const m of s.messages ?? []) {
      if (isRequest(m)) {
        cur = { user: { role: 'user', content: typeof m.content === 'string' ? m.content : unshot(m.content) }, steps: [] };
        out.push(cur);
      } else if (cur && m.role === 'assistant') {
        const content = Array.isArray(m.content) ? m.content.filter((p) => p.type !== 'thinking') : m.content;
        if (!Array.isArray(content) || content.length) cur.steps.push({ role: 'assistant', content });
      } else if (cur && m.role === 'tool') {
        cur.steps.push({ role: 'tool', content: m.content.map((r) => ({ ...r, content: unshot(r.content) })) });
      }
    }
  }
  // A request must end on an answer, and every tool call needs its result, or the provider refuses the history.
  return out.filter((r) => r.steps.length && r.steps.at(-1).role === 'assistant' && paired(r.steps));
}

/** Stand-in requests when there are no saved conversations: a question, a look, an app task with screenshots. */
export function syntheticRequests() {
  const call = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_call', id, name, args: { target: 'front' } }] });
  const shot = (id) => ({ role: 'tool', content: [{ type: 'tool_result', toolCallId: id, content: [{ type: 'text', text: 'Screenshot of the Chrome window. ' + 'm'.repeat(2700) }, { type: 'image', mediaType: 'image/png', data: 'IMG' }] }] });
  const text = (id, n) => ({ role: 'tool', content: [{ type: 'tool_result', toolCallId: id, content: 'r'.repeat(n) }] });
  const say = (t) => ({ role: 'assistant', content: t });
  const req = (q, steps) => ({ user: { role: 'user', content: q }, steps });
  const task = (k) => {
    const steps = [];
    for (let i = 0; i < k; i++) {
      const id = `s${k}_${i}`;
      if (i % 2 === 0) steps.push(call(id, 'take_screenshot'), shot(id));
      else steps.push(call(id, 'act_in_app'), text(id, 1800));
    }
    return req(`do the thing ${k}`, [...steps, say('Done.')]);
  };
  return [
    req('what time is it in Tokyo?', [say('It is 3 am in Tokyo.')]),
    req('what is this?', [call('l1', 'take_screenshot'), shot('l1'), say('That is a settings page.')]),
    req('open my mail', [call('o1', 'open'), text('o1', 60), say('Opened.')]),
    task(4), task(8),
  ];
}

/** One request, deep-copied with tool call ids and screenshots made unique to this copy. */
function instance(r, k) {
  let img = 0;
  const fix = (m) => JSON.parse(JSON.stringify(m), (key, v) => (key === 'id' || key === 'toolCallId' ? `${v}_${k}` : key === 'data' && v === 'IMG' ? `IMG${k}_${img++}` : v));
  return { user: fix(r.user), steps: r.steps.map(fix) };
}

/** A day: short (8–20 requests), medium (21–45) or long (60–160), with gaps between requests. */
export function makeDay(rand, requests, opts = DEFAULTS) {
  const u = rand();
  const [bucket, lo, hi] = u < 0.5 ? ['short', 8, 20] : u < 0.85 ? ['medium', 21, 45] : ['long', 60, 160];
  const n = lo + Math.floor(rand() * (hi - lo + 1));
  const live = 'L'.repeat(opts.liveChars);
  const reqs = [];
  for (let k = 0; k < n; k++) {
    const r = instance(requests[Math.floor(rand() * requests.length)], k);
    const c = r.user.content;
    r.user.content = typeof c === 'string' ? `${live}\n${c}` : [{ type: 'text', text: live }, ...c];
    // Mostly back-to-back; a quarter a few minutes apart; some after a break (the 5-minute cache entries lapse).
    const g = rand();
    r.gapMs = k === 0 ? 0 : g < 0.6 ? 10e3 + rand() * 110e3 : g < 0.85 ? 120e3 + rand() * 170e3 : 360e3 + rand() * 2040e3;
    reqs.push(r);
  }
  return { bucket, requests: reqs };
}

// ---------- prompt cache model ----------

function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const blockMemo = new WeakMap();
/** A message's top-level content blocks (what Anthropic's lookback counts): [{ h1, h2, tokens }]. */
function blocks(m, opts) {
  const memo = blockMemo.get(m);
  if (memo) return memo;
  const tok = (p) => (p?.type === 'image' ? opts.imageTokens : JSON.stringify(p?.type === 'text' ? p.text : p ?? '').length / opts.charsPerToken);
  const nested = (c) => (Array.isArray(c) ? c.reduce((n, p) => n + tok(p), 0) : String(c ?? '').length / opts.charsPerToken);
  const parts = typeof m.content === 'string' ? [m.content] : m.content;
  const out = parts.map((p) => {
    const key = m.role + JSON.stringify(p);
    const tokens = m.role === 'tool' ? nested(p.content) + 20 : typeof p === 'string' ? p.length / opts.charsPerToken : tok(p);
    return { h1: fnv(key, 2166136261), h2: fnv(key, 0x9747b28c), tokens };
  });
  blockMemo.set(m, out);
  return out;
}

/** Prompt cache for one conversation: call() takes what's sent and returns the usage the provider would report. */
export function createCache(opts = DEFAULTS) {
  const entries = new Map();
  let now = 0, prevSent = null;
  const live = (k) => (entries.get(k) ?? -1) > now;
  const keep = (k, until) => entries.set(k, Math.max(entries.get(k) ?? 0, until));
  return {
    advance(ms) { now += ms; },
    call(messages) {
      const body = messages.filter((m) => m.role !== 'system');
      const flat = [], at = [];
      let a = 0x12345678, b = 0x9abcdef0;
      body.forEach((m, i) => {
        for (const blk of blocks(m, opts)) {
          a = Math.imul(a ^ blk.h1, 0x9E3779B1) >>> 0;
          b = Math.imul(b ^ blk.h2, 0x85EBCA77) >>> 0;
          flat.push({ key: `${a}:${b}`, tokens: blk.tokens });
          at.push(i);
        }
      });
      const prefix = [0];
      for (const f of flat) prefix.push(prefix.at(-1) + f.tokens);
      const upTo = (j) => (j < 0 ? 0 : prefix[j + 1]);
      const lastBlockOf = (pred) => { for (let j = flat.length - 1; j >= 0; j--) if (pred(body[at[j]], at[j])) return j; return -1; };
      // Breakpoints as gg-ai places them with 1 h retention: the request's own message (1 h) and the tail (5 min);
      // on a request's first call, the previous request and the tail, both 1 h.
      const reqIdx = body.map((m, i) => (isRequest(m) ? i : -1)).filter((i) => i >= 0);
      const tail = lastBlockOf((m) => m.role === 'user' || m.role === 'tool');
      const anchor = reqIdx.length ? lastBlockOf((m, i) => i === reqIdx.at(-1)) : -1;
      const marks = anchor === tail
        ? [[reqIdx.length > 1 ? lastBlockOf((m, i) => i === reqIdx.at(-2)) : -1, TTL_1H], [tail, TTL_1H]]
        : [[anchor, TTL_1H], [tail, TTL_5M]];
      let hit = -1;
      for (const [bp] of marks) {
        for (let j = bp; j >= 0 && j >= bp - LOOKBACK; j--) if (live(flat[j].key)) { hit = Math.max(hit, j); break; }
      }
      const sys = opts.systemTokens, warm = live('system');
      const read = (warm ? sys : 0) + upTo(hit);
      const end = upTo(tail);
      const mid = anchor === tail ? end : Math.max(upTo(anchor), upTo(hit));
      const write1h = (warm ? 0 : sys) + Math.max(0, mid - upTo(hit));
      const write5m = Math.max(0, end - Math.max(mid, upTo(hit)));
      for (const [bp, ttl] of marks) if (bp >= 0) keep(flat[bp].key, now + ttl);
      if (hit >= 0) keep(flat[hit].key, now + TTL_5M);
      keep('system', now + TTL_1H);
      const sent = sys + end;
      const rewritten = prevSent != null && read < prevSent ? prevSent - read : 0;
      prevSent = sent;
      now += CALL_MS;
      return { read, write1h, write5m, sent, rewritten, broke: rewritten > 256 };
    },
  };
}

export const costOf = (u) => (u.input ?? 0) + u.read * PRICE.read + u.write1h * PRICE.write1h + u.write5m * PRICE.write5m;
const countImages = (msgs) => msgs.reduce((n, m) => n + (JSON.stringify(m.content).match(/"type":"image"/g)?.length ?? 0), 0);

/** One day through one policy, the way the agent runs it; `send` (live) replaces the cache model with the provider. */
export async function runDay(day, policy, opts = DEFAULTS, send = null) {
  const cache = createCache(opts);
  let hist = [{ role: 'system', content: 'sys' }];
  const calibrate = opts.calibrate ?? CALIBRATED.has(policy);
  let rate = CHARS_PER_TOKEN;
  const t = { calls: 0, read: 0, write1h: 0, write5m: 0, cost: 0, sent: 0, maxSent: 0, breaks: 0, rewritten: 0, images: 0, trims: 0, trimmedTokens: 0, ttft: [] };
  for (const r of day.requests) {
    cache.advance(r.gapMs);
    if (send?.advance) await send.advance(r.gapMs);
    hist.push(r.user);
    for (const m of r.steps) {
      if (m.role === 'assistant') {
        // Counted from the output, so the baseline (which reports nothing) is measured the same way.
        const before = hist.length, chars = JSON.stringify(hist).length;
        hist = policy(hist, calibrate ? { budgetTokens: opts.budget, charsPerToken: rate } : { budgetTokens: opts.budget });
        if (hist.length < before) { t.trims++; t.trimmedTokens += Math.max(0, chars - JSON.stringify(hist).length) / opts.charsPerToken; }
        const u = send ? await send(hist) : cache.call(hist);
        // As sidekick.mjs measureTokens: the provider's (or the model's) total, images taken out, over the letters sent.
        if (calibrate) rate = calibrateCharsPerToken(contextChars(hist), (u.input ?? 0) + u.read + u.write1h + u.write5m - countImages(hist) * opts.imageTokens, rate);
        t.calls++; t.read += u.read; t.write1h += u.write1h; t.write5m += u.write5m; t.cost += costOf(u); t.sent += u.sent;
        t.maxSent = Math.max(t.maxSent, u.sent);
        t.images += countImages(hist);
        if (u.broke) { t.breaks++; t.rewritten += u.rewritten; }
        if (u.ttft != null) t.ttft.push(u.ttft);
      }
      hist.push(m);
    }
  }
  return t;
}

// ---------- stats ----------

const pct = (xs, q) => { const v = [...xs].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil((q / 100) * v.length) - 1))] : null; };
const mean = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);

/** Mean with a 95 % bootstrap interval (seeded, so reruns print the same interval). */
export function meanCI(xs, seed = 7, n = 2000) {
  if (!xs.length) return { mean: null, lo: null, hi: null };
  const rand = rng(seed), ms = [];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rand() * xs.length)]; ms.push(s / xs.length); }
  return { mean: mean(xs), lo: pct(ms, 2.5), hi: pct(ms, 97.5) };
}

/** Saving on the total bill (1 − Σ current / Σ baseline) with a 95 % bootstrap interval over days. */
export function totalCI(rows, seed = 11, n = 2000) {
  const s = (rs) => 1 - rs.reduce((x, r) => x + r.B.cost, 0) / rs.reduce((x, r) => x + r.A.cost, 0);
  const rand = rng(seed), ms = [];
  for (let i = 0; i < n; i++) ms.push(s(rows.map(() => rows[Math.floor(rand() * rows.length)])));
  return { mean: s(rows), lo: pct(ms, 2.5), hi: pct(ms, 97.5) };
}

/** Paired per-day comparison; saving = 1 − current / baseline. Pairs are [baseline, current]. */
export function compare(days, A = 'baseline', B = CONTEXT_POLICY) {
  const rows = days.map((d) => ({ bucket: d.bucket, A: d.results[A], B: d.results[B] }));
  const group = (rs) => {
    const sum = (k, side) => rs.reduce((n, r) => n + r[side][k], 0);
    const both = (k) => [sum(k, 'A') / sum('calls', 'A'), sum(k, 'B') / sum('calls', 'B')];
    const writes = (side) => sum('write1h', side) + sum('write5m', side);
    const saving = rs.map((r) => 1 - r.B.cost / r.A.cost);
    return {
      days: rs.length, calls: [sum('calls', 'A'), sum('calls', 'B')],
      cost_saving: meanCI(saving), cost_saving_p10: pct(saving, 10), cost_saving_p90: pct(saving, 90),
      total_cost_saving: totalCI(rs),
      write_saving: 1 - writes('B') / writes('A'),
      cost_per_call: both('cost'), breaks_per_call: both('breaks'), resent_per_call: both('rewritten'),
      write_per_call: [writes('A') / sum('calls', 'A'), writes('B') / sum('calls', 'B')],
      sent_per_call: both('sent'), screenshots_seen_per_call: both('images'),
      trims: [sum('trims', 'A'), sum('trims', 'B')], trimmed_tokens: [sum('trimmedTokens', 'A'), sum('trimmedTokens', 'B')],
      ttft_p50: [pct(rs.flatMap((r) => r.A.ttft), 50), pct(rs.flatMap((r) => r.B.ttft), 50)],
    };
  };
  const out = { all: group(rows) };
  for (const k of [...new Set(rows.map((r) => r.bucket))]) if (k !== 'all') out[k] = group(rows.filter((r) => r.bucket === k));
  return out;
}

const pc = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)} %`);
const n0 = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-US'));
const pair = (xs, f = n0) => `${f(xs[0])} → ${f(xs[1])}`;

export function formatTable(cmp, title) {
  const ttft = Object.values(cmp)[0].ttft_p50[0] != null;
  const ci = (c) => `${pc(c.mean)} (${pc(c.lo)} … ${pc(c.hi)})`;
  const head = ['days', 'total cost saving (95 % CI)', 'typical day saving (95 % CI)', 'worst / best 10 % of days', 'cost / call', 'cache writes / call', 'breaks / call',
    're-sent / call', 'sent / call', 'screenshots seen / call', 'trims', 'tokens trimmed', ...(ttft ? ['time to first token p50'] : [])];
  const rows = Object.entries(cmp).map(([k, g]) => [k, g.days, ci(g.total_cost_saving), ci(g.cost_saving),
    `${pc(g.cost_saving_p10)} / ${pc(g.cost_saving_p90)}`, pair(g.cost_per_call), pair(g.write_per_call),
    pair(g.breaks_per_call, (x) => x.toFixed(2)), pair(g.resent_per_call), pair(g.sent_per_call), pair(g.screenshots_seen_per_call, (x) => x.toFixed(2)),
    pair(g.trims), pair(g.trimmed_tokens), ...(ttft ? [pair(g.ttft_p50, (x) => `${Math.round(x)} ms`)] : [])]);
  return [`**${title}** (baseline → ${CONTEXT_POLICY}; saving = 1 − ${CONTEXT_POLICY} / baseline, paired by day)`, '',
    `| | ${head.join(' | ')} |`, `|---|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** On target when the total bill's saving clears the telemetry report's target across its whole 95 % interval. */
export function verdict(cmp, target) {
  const s = cmp.all.total_cost_saving;
  return s.lo >= target ? 'on_target' : s.hi < target ? 'missed' : 'unclear';
}

// ---------- live ----------

function png(w, h, seed) {
  const crc = (buf) => { const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(buf) >>> 0); return c; };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, t, data, crc(Buffer.concat([t, data]))]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = (x * 7 + seed * 31) & 255; row[2 + x * 3] = (seed * 53) & 255; row[3 + x * 3] = (x >> 3) & 255; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function liveSender(session, nonce, imageSize, filler, maxGapMs) {
  const { stream } = await import('@kenkaiiii/gg-ai');
  const { z } = await import('zod');
  const images = new Map();
  const real = (msgs) => JSON.parse(JSON.stringify(msgs), (k, v) => {
    if (k !== 'data' || typeof v !== 'string' || !v.startsWith('IMG')) return v;
    if (!images.has(v)) images.set(v, png(imageSize[0], imageSize[1], images.size + 1));
    return images.get(v);
  });
  // The run nonce leads the system prompt, so no two runs share a cache entry.
  const system = `Benchmark run ${nonce}. You are Roamies, a desktop sidekick. Reply with one short word.\n${filler}`;
  let prevSent = null;
  const send = async (hist) => {
    const names = new Set();
    for (const m of hist) if (m.role === 'assistant' && Array.isArray(m.content)) for (const q of m.content) if (q.type === 'tool_call') names.add(q.name);
    const tools = [...names].sort().map((name) => ({ name, description: `The ${name} tool.`, parameters: z.object({}).passthrough() }));
    const creds = await session.auth.resolveCredentials(session.model.provider);
    const t0 = performance.now();
    let ttft = null;
    const res = stream({
      provider: session.model.provider, model: session.model.id,
      messages: [{ role: 'system', content: system }, ...real(hist.filter((m) => m.role !== 'system'))],
      tools, toolChoice: 'none', maxTokens: 16, cacheRetention: 'long', promptCacheKey: `roamies-bench-${nonce}`,
      apiKey: creds.accessToken, accountId: creds.accountId, projectId: creds.projectId, baseUrl: session.baseUrl, userAgent: session.userAgent,
    });
    for await (const e of res) if (ttft == null && /delta/.test(e.type)) ttft = performance.now() - t0;
    const u = (await res.response).usage ?? {};
    const read = u.cacheRead ?? 0, write = u.cacheWrite ?? 0, sent = read + write + (u.inputTokens ?? 0);
    const rewritten = prevSent != null && read < prevSent ? prevSent - read : 0;
    prevSent = sent;
    // The provider reports one write total: priced at the 5-minute rate (most writes are mid-request tails), so live
    // costs undercount the 1 h writes a little on both sides alike.
    return { input: u.inputTokens ?? 0, read, write1h: 0, write5m: write, sent, rewritten, broke: rewritten > 256, ttft };
  };
  // Real gaps would make a live run take hours: waits are capped, so 5-minute entries survive more often than offline.
  send.advance = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, maxGapMs)));
  return send;
}

// ---------- main ----------

function parseArgs(argv) {
  const o = {
    runs: 200, seed: 1, budget: DEFAULTS.budget, json: path.join(HERE, '..', 'bench-context.json'),
    sessions: path.join(process.env.ROAMIES_DATA_DIR ?? path.join(os.homedir(), '.gg'), 'sidekick', 'sessions'),
    repeat: 1, live: false, liveRuns: 3, liveRequests: 12, liveBudget: 30_000, model: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--runs') o.runs = +v();
    else if (a === '--seed') o.seed = +v();
    else if (a === '--budget') o.budget = +v();
    else if (a === '--sessions') o.sessions = v();
    else if (a === '--json') o.json = v();
    else if (a === '--repeat') o.repeat = +v();
    else if (a === '--live') o.live = true;
    else if (a === '--live-runs') o.liveRuns = +v();
    else if (a === '--live-requests') o.liveRequests = +v();
    else if (a === '--live-budget') o.liveBudget = +v();
    else if (a === '--model') o.model = v();
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

export async function offline({ runs, seed, budget, requests, ...over }) {
  const opts = { ...DEFAULTS, ...over, budget };
  const rand = rng(seed), days = [];
  for (let i = 0; i < runs; i++) {
    const day = makeDay(rand, requests, opts);
    const results = {};
    for (const [name, fn] of Object.entries(POLICIES)) results[name] = await runDay(day, fn, opts);
    days.push({ bucket: day.bucket, requests: day.requests.length, results });
  }
  return { days, compare: compare(days) };
}

async function live(o, requests, out) {
  const { signIn } = await import('./pointing.bench.mjs');
  const { imageLimits, resizedSize } = await import('../pointing.mjs');
  const session = await signIn(o.model);
  const lim = imageLimits(session.model.id);
  const size = resizedSize(2560, 1440, lim.maxEdge, lim.maxTokens);
  // Live days test where the policies differ, at a price: half the requests are screenshot tasks, and a smaller history
  // budget makes trims happen within a dozen requests. The offline table, not this one, says what a typical day saves.
  const opts = { ...DEFAULTS, budget: o.liveBudget, imageTokens: Math.ceil(size[0] / 28) * Math.ceil(size[1] / 28) };
  const shots = requests.filter((r) => JSON.stringify(r.steps).split('"type":"image"').length > 3);
  const pool = shots.length ? [...requests, ...Array.from({ length: Math.max(1, Math.round(requests.length / shots.length)) }, () => shots).flat()] : requests;
  const filler = 'Roamies rules: answer plainly, point when asked, never act without consent. '.repeat(Math.round((DEFAULTS.systemTokens * DEFAULTS.charsPerToken) / 76));
  const rand = rng(o.seed + 1000), days = [];
  for (let i = 0; i < o.liveRuns; i++) {
    let day;
    do day = makeDay(rand, pool, opts); while (day.bucket === 'long');
    day.requests = day.requests.slice(0, o.liveRequests);
    for (const r of day.requests) r.gapMs = Math.min(r.gapMs, 20e3);
    days.push({ bucket: 'all', day, results: {}, modelled: {} });
  }
  let est = 0;
  for (const d of days) for (const [name, fn] of Object.entries(POLICIES)) { d.modelled[name] = await runDay(d.day, fn, opts); est += d.modelled[name].read + d.modelled[name].write1h + d.modelled[name].write5m; }
  console.log(`\nLive: ${o.liveRuns} days × ${o.liveRequests} requests × ${Object.keys(POLICIES).length} policies on ${session.model.id}, history budget ${n0(o.liveBudget)}: about ${n0(est)} input tokens (mostly cache reads).`);
  for (const [i, d] of days.entries()) {
    // Alternate which policy goes first, so drift over the run doesn't favour one.
    const order = i % 2 ? Object.entries(POLICIES).reverse() : Object.entries(POLICIES);
    for (const [name, fn] of order) {
      const send = await liveSender(session, `${Date.now().toString(36)}-${i}-${name}`, size, filler, 20e3);
      d.results[name] = await runDay(d.day, fn, opts, send);
      const r = d.results[name];
      console.log(`  day ${i + 1} ${name}: ${r.calls} calls, read ${n0(r.read)}, write ${n0(r.write5m)}, ${r.breaks} breaks`);
    }
  }
  const measured = compare(days), modelled = compare(days.map((d) => ({ bucket: 'all', results: d.modelled })));
  // Does the cache model the offline numbers rest on match the provider? Compares the policy difference, day by day.
  const gap = days.map((d) => (d.results[CONTEXT_POLICY].cost - d.results.baseline.cost) / d.results.baseline.cost
    - (d.modelled[CONTEXT_POLICY].cost - d.modelled.baseline.cost) / d.modelled.baseline.cost);
  out.live = { model: session.model.id, runs: o.liveRuns, requests: o.liveRequests, budget: o.liveBudget, image_size: size, measured, modelled, model_gap: gap };
  console.log(`
Model check: measured saving minus modelled saving, per day: ${gap.map((g) => `${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)} pts`).join(', ')}.`);
  console.log('\n' + formatTable(measured, `Live, measured on ${session.model.id}`));
  console.log('\n' + formatTable(modelled, 'The same live days through the cache model (checks the model against the provider)'));
}

async function main(argv) {
  const o = parseArgs(argv);
  const { CACHE_TARGET } = await import('../telemetry-report.mjs');
  let requests = loadRequests(o.sessions), source = `${requests.length} requests saved in ${o.sessions}`;
  if (requests.length < 10) { requests = syntheticRequests(); source = 'built-in stand-in requests (fewer than 10 saved)'; }
  const t0 = performance.now();
  const off = await offline({ runs: o.runs, seed: o.seed, budget: o.budget, requests });
  const out = { generated_at: new Date().toISOString(), source, runs: o.runs, seed: o.seed, budget: o.budget, price: PRICE, defaults: DEFAULTS, target: CACHE_TARGET.cost_drop, offline: off.compare };
  out.verdict = verdict(off.compare, CACHE_TARGET.cost_drop);
  console.log(`Context benchmark: ${o.runs} days resampled from ${source}; history budget ${n0(o.budget)} tokens (${((performance.now() - t0) / 1000).toFixed(1)} s).\n`);
  console.log(formatTable(off.compare, 'Offline (prompt cache model)'));
  if (o.repeat > 1) {
    // The same run on fresh days (the next seeds): how much the answer moves with the sample.
    out.repeats = [{ seed: o.seed, total: off.compare.all.total_cost_saving, typical: off.compare.all.cost_saving.mean }];
    for (let k = 1; k < o.repeat; k++) {
      const r = await offline({ runs: o.runs, seed: o.seed + k, budget: o.budget, requests });
      out.repeats.push({ seed: o.seed + k, total: r.compare.all.total_cost_saving, typical: r.compare.all.cost_saving.mean });
    }
    const ts = out.repeats.map((r) => r.total.mean);
    console.log(`\n**Repeats** (${o.repeat} runs × ${o.runs} days, seeds ${o.seed}–${o.seed + o.repeat - 1})\n\n| seed | total cost saving (95 % CI) | typical day saving |\n|---|---|---|`);
    for (const r of out.repeats) console.log(`| ${r.seed} | ${pc(r.total.mean)} (${pc(r.total.lo)} … ${pc(r.total.hi)}) | ${pc(r.typical)} |`);
    console.log(`\nTotal cost saving across runs: ${pc(Math.min(...ts))} to ${pc(Math.max(...ts))}, mean ${pc(mean(ts))}.`);
    // Any run whose interval falls below the target makes the verdict no better than unclear.
    if (out.verdict === 'on_target' && out.repeats.some((r) => r.total.lo < CACHE_TARGET.cost_drop)) out.verdict = 'unclear';
    if (out.verdict === 'unclear' && out.repeats.every((r) => r.total.hi < CACHE_TARGET.cost_drop)) out.verdict = 'missed';
  }
  console.log(`\nVerdict against the ${CACHE_TARGET.cost_drop * 100} % target (total cost saving, 95 % interval): ${out.verdict}.`);
  if (o.live) await live(o, requests, out);
  fs.writeFileSync(o.json, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${o.json}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[bench] ${e.stack ?? e.message}`); process.exit(1); });
}
