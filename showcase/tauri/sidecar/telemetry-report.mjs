// Reads the local telemetry day files (docs/telemetry.md) and prints:
//   chain <request_id> [days]  one request's steps in time order, indented by parent
//   p95 [days]                 steps ranked by p95 duration, with error and retry rates
//   stt [days]                 voice engines compared: host.stt and host.stt_shadow by engine and role
// Run: npm run telemetry:report -- chain <request_id>   (ROAMIES_DATA_DIR or --dir <folder> to read elsewhere)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function telemetryDir(env = process.env) {
  return path.join(env.ROAMIES_DATA_DIR ? path.join(env.ROAMIES_DATA_DIR, 'sidekick') : path.join(os.homedir(), '.gg', 'sidekick'), 'telemetry');
}

export function loadEvents(dir, days = 7) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days);
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

// One row per step (start and end merged) or point event, in start order, with its depth under its parents.
export function chain(events, requestId) {
  const mine = events.filter((e) => e.request_id === requestId);
  const steps = new Map();
  for (const e of mine) {
    const s = steps.get(e.step_id) ?? { step_id: e.step_id, parent: e.parent_step_id, step: e.step, component: e.component, ts: e.ts, kind: e.kind, attrs: {} };
    if (e.kind === 'start' || e.kind === 'event') { s.ts = e.ts; s.parent = e.parent_step_id ?? s.parent; }
    if (e.kind === 'end') { s.duration_ms = e.duration_ms; s.outcome = e.outcome; s.error_code = e.error_code; s.ended = true; }
    if (e.kind === 'event') s.outcome = 'event';
    Object.assign(s.attrs, e.attrs ?? {});
    steps.set(e.step_id, s);
  }
  const depth = (s, seen = new Set()) => {
    const p = s.parent && steps.get(s.parent);
    if (!p || seen.has(p.step_id)) return 0;
    seen.add(p.step_id);
    return 1 + depth(p, seen);
  };
  const rows = [...steps.values()].sort((a, b) => a.ts - b.ts || (a.step < b.step ? -1 : 1));
  const t0 = rows[0]?.ts ?? 0;
  return rows.map((s) => ({ ...s, at_ms: s.ts - t0, depth: depth(s) }));
}

// Steps ranked by p95 duration (ended steps only), with counts, error and retry rates.
export function p95(events) {
  const by = new Map();
  const retried = new Set(events.filter((e) => e.kind === 'start' && e.attrs?.retry).map((e) => e.step_id));
  for (const e of events) {
    if (e.kind !== 'end' || typeof e.duration_ms !== 'number') continue;
    const g = by.get(e.step) ?? { step: e.step, durations: [], errors: 0, retries: 0 };
    g.durations.push(e.duration_ms);
    if (e.outcome === 'error') g.errors++;
    if (e.attrs?.retry || retried.has(e.step_id)) g.retries++;
    by.set(e.step, g);
  }
  return [...by.values()].map((g) => {
    const d = g.durations.sort((a, b) => a - b), n = d.length;
    return { step: g.step, n, p50: pct(d, 50), p95: pct(d, 95), max: d[n - 1], error_rate: g.errors / n, retry_rate: g.retries / n };
  }).sort((a, b) => b.p95 - a.p95);
}

const nums = (rows, k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// The engine comparison (docs/voice-engines.md): one row per engine x role from `host.stt` ends (primary) and
// `host.stt_shadow` results (shadow), with the stt_correction rate per primary engine. Skipped shadow jobs count apart.
export function stt(events) {
  const by = new Map();
  const corrections = new Map();
  const row = (engine, role) => {
    const k = `${engine}\u0000${role}`;
    if (!by.has(k)) by.set(k, { engine, role, takes: [], skipped: 0 });
    return by.get(k);
  };
  for (const e of events) {
    const a = e.attrs ?? {};
    if (e.step === 'host.stt' && e.kind === 'end') row(a.engine ?? 'system', a.role ?? 'primary').takes.push(a);
    else if (e.step === 'host.stt_shadow') {
      const r = row(a.engine ?? 'unknown', 'shadow');
      if (e.outcome === 'cancelled') r.skipped++; else r.takes.push(a);
    } else if (e.step === 'stt_correction') corrections.set(a.engine ?? 'system', (corrections.get(a.engine ?? 'system') ?? 0) + 1);
  }
  return [...by.values()].map((g) => {
    const t = g.takes, n = t.length, q = (k, p) => { const v = nums(t, k); return v.length ? pct(v, p) : null; };
    const rss = nums(t, 'peak_rss_mb');
    return {
      engine: g.engine, role: g.role, n, skipped: g.skipped,
      empty_rate: n ? t.filter((a) => a.empty === true).length / n : null,
      rtf_p50: q('rtf', 50), rtf_p95: q('rtf', 95),
      final_p50: q('speech_end_to_final_ms', 50), final_p95: q('speech_end_to_final_ms', 95),
      ttfp_p50: q('time_to_first_partial_ms', 50), ttfp_p95: q('time_to_first_partial_ms', 95),
      revision_rate: mean(nums(t, 'revision_rate')),
      peak_rss_mb: rss.length ? rss[rss.length - 1] : null,
      agreement: g.role === 'shadow' ? mean(nums(t, 'agreement')) : null,
      correction_rate: g.role === 'primary' && n ? (corrections.get(g.engine) ?? 0) / n : null,
    };
  }).sort((a, b) => (a.role === b.role ? b.n - a.n : a.role === 'primary' ? -1 : 1));
}

export function formatStt(rows) {
  const f = (v, d = 2) => (v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(d));
  const pc = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`);
  const cols = [['engine', 12], ['role', 8], ['n', 5], ['skipped', 7], ['empty', 6], ['rtf p50/p95', 12], ['final ms p50/p95', 17],
    ['ttfp ms p50/p95', 16], ['revised', 7], ['peak MB', 8], ['agree', 6], ['corrected', 9]];
  const line = (vals) => vals.map((v, i) => (i < 2 ? String(v).padEnd(cols[i][1]) : String(v).padStart(cols[i][1]))).join('  ');
  return [line(cols.map((c) => c[0])), ...rows.map((r) => line([r.engine, r.role, r.n, r.skipped, pc(r.empty_rate),
    `${f(r.rtf_p50)}/${f(r.rtf_p95)}`, `${f(r.final_p50, 0)}/${f(r.final_p95, 0)}`, `${f(r.ttfp_p50, 0)}/${f(r.ttfp_p95, 0)}`,
    pc(r.revision_rate), f(r.peak_rss_mb, 0), pc(r.agreement), pc(r.correction_rate)]))].join('\n');
}

const ms = (v) => (typeof v === 'number' ? `${v.toFixed(1)} ms` : '');
const attrText = (a) => Object.entries(a).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(1) : v}`).join(' ');

export function formatChain(rows) {
  return rows.map((r) => [
    `+${String(r.at_ms).padStart(6)} ms`,
    r.component.padEnd(7),
    `${'  '.repeat(r.depth)}${r.step}`.padEnd(30),
    ms(r.duration_ms).padStart(11),
    (r.outcome ?? (r.ended ? '' : 'open')).padEnd(9),
    r.error_code ?? '',
    attrText(r.attrs),
  ].join('  ').trimEnd()).join('\n');
}

export function formatP95(rows) {
  const head = ['step'.padEnd(26), 'n'.padStart(5), 'p50'.padStart(11), 'p95'.padStart(11), 'max'.padStart(11), 'errors'.padStart(7), 'retries'.padStart(7)].join('  ');
  return [head, ...rows.map((r) => [r.step.padEnd(26), String(r.n).padStart(5), ms(r.p50).padStart(11), ms(r.p95).padStart(11), ms(r.max).padStart(11),
    `${Math.round(r.error_rate * 100)}%`.padStart(7), `${Math.round(r.retry_rate * 100)}%`.padStart(7)].join('  '))].join('\n');
}

function main(argv) {
  const args = [...argv];
  let dir = telemetryDir();
  const i = args.indexOf('--dir');
  if (i >= 0) { dir = args[i + 1]; args.splice(i, 2); }
  const [cmd, a, b] = args;
  if (cmd === 'chain' && a) {
    const rows = chain(loadEvents(dir, Number(b) || 7), a);
    if (!rows.length) { console.error(`No events for ${a} in ${dir}`); return 1; }
    console.log(formatChain(rows));
    return 0;
  }
  if (cmd === 'p95') {
    console.log(formatP95(p95(loadEvents(dir, Number(a) || 7))));
    return 0;
  }
  if (cmd === 'stt') {
    console.log(formatStt(stt(loadEvents(dir, Number(a) || 7))));
    return 0;
  }
  console.error('Usage: telemetry-report.mjs chain <request_id> [days] | p95 [days] | stt [days]  [--dir <telemetry folder>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
