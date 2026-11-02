// Reads the local telemetry day files (docs/telemetry.md) and prints or writes:
//   chain <request_id> [days]  one request's steps in time order, indented by parent
//   p95 [days]                 steps ranked by p95 duration, with error and retry rates
//   stt [days]                 voice engines compared: host.stt and host.stt_shadow by engine and role
//   report [days]              the full analysis as telemetry-report.md + telemetry-report.json (default 14 days;
//                              --out <folder>, --bench-doc <voice-engines.md>)
// Run: npm run telemetry:report -- chain <request_id>   (ROAMIES_DATA_DIR or --dir <folder> to read elsewhere)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BENCH_DOC = path.resolve(HERE, '..', '..', '..', 'docs', 'voice-engines.md');

export function telemetryDir(env = process.env) {
  return path.join(env.ROAMIES_DATA_DIR ? path.join(env.ROAMIES_DATA_DIR, 'sidekick') : path.join(os.homedir(), '.gg', 'sidekick'), 'telemetry');
}

const KINDS = new Set(['start', 'end', 'event']);

// Maps a parsed line to the schema-1 shape, or null for a schema this script doesn't know. Missing `schema` is 1.
export function upgrade(e) {
  const v = e.schema ?? 1;
  if (v !== 1) return null;
  return { ...e, schema: 1, attrs: e.attrs && typeof e.attrs === 'object' ? e.attrs : {} };
}

// Events from the newest `days` day files, plus counts of what was skipped. A bad line never throws.
export function readEvents(dir, days = 7) {
  const stats = { files: [], lines: 0, parsed: 0, malformed: 0, unsupported_schema: 0, by_schema: {} };
  const events = [];
  if (!dir || !fs.existsSync(dir)) return { events, stats };
  stats.files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days);
  for (const f of stats.files) {
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      stats.lines++;
      let e;
      try { e = JSON.parse(line); } catch { stats.malformed++; continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) { stats.malformed++; continue; }
      const v = String(e.schema ?? 1);
      stats.by_schema[v] = (stats.by_schema[v] ?? 0) + 1;
      const u = upgrade(e);
      if (!u) { stats.unsupported_schema++; continue; }
      if (!Number.isFinite(u.ts) || !KINDS.has(u.kind) || typeof u.step !== 'string' || !u.step) { stats.malformed++; continue; }
      stats.parsed++;
      events.push(u);
    }
  }
  return { events, stats };
}

export function loadEvents(dir, days = 7) {
  return readEvents(dir, days).events;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Exact nearest-rank quantiles over the raw values: prom-client's Summary set (p50/p90/p95/p99) plus max and mean.
export function quantiles(values) {
  const d = values.filter(finite).sort((a, b) => a - b), n = d.length;
  if (!n) return { n: 0, p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  return { n, p50: pct(d, 50), p90: pct(d, 90), p95: pct(d, 95), p99: pct(d, 99), max: d[n - 1], mean: d.reduce((a, b) => a + b, 0) / n };
}

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

// Per step and per component: duration quantiles of ended steps, with error, cancel and retry rates over those ends.
export function steps(events) {
  const retried = new Set(events.filter((e) => e.kind === 'start' && e.attrs?.retry).map((e) => e.step_id));
  const bySt = new Map(), byComp = new Map();
  const grp = (m, k, extra) => {
    if (!m.has(k)) m.set(k, { ...extra, durations: [], ends: 0, errors: 0, cancels: 0, retries: 0 });
    return m.get(k);
  };
  for (const e of events) {
    if (e.kind !== 'end') continue;
    const comp = e.component ?? 'unknown';
    for (const g of [grp(bySt, e.step, { step: e.step, component: comp }), grp(byComp, comp, { component: comp })]) {
      g.ends++;
      if (finite(e.duration_ms)) g.durations.push(e.duration_ms);
      if (e.outcome === 'error') g.errors++;
      if (e.outcome === 'cancelled') g.cancels++;
      if (e.attrs?.retry || retried.has(e.step_id)) g.retries++;
    }
  }
  const rows = (m) => [...m.values()].map(({ durations, ends, errors, cancels, retries, ...k }) => ({
    ...k, ...quantiles(durations), ends, errors, cancels, retries,
    error_rate: ends ? errors / ends : 0, cancel_rate: ends ? cancels / ends : 0, retry_rate: ends ? retries / ends : 0,
  })).sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1) || (a.step ?? a.component).localeCompare(b.step ?? b.component));
  return { steps: rows(bySt), components: rows(byComp) };
}

// Steps ranked by p95 duration (ended steps only), with counts, error and retry rates.
export function p95(events) {
  // Like before the full report: only ends with a duration count, so rates stay over n.
  const timed = events.filter((e) => e.kind !== 'end' || finite(e.duration_ms));
  return steps(timed).steps.filter((r) => r.n).map((r) => ({
    step: r.step, n: r.n, p50: r.p50, p95: r.p95, max: r.max, error_rate: r.errors / r.n, retry_rate: r.retries / r.n,
  }));
}

// One row per request id: wall time from its first event to its last end, its source and outcome, and its steps.
export function requests(events) {
  const by = new Map();
  for (const e of events) {
    if (!e.request_id) continue;
    if (!by.has(e.request_id)) by.set(e.request_id, []);
    by.get(e.request_id).push(e);
  }
  return [...by.entries()].map(([id, evs]) => {
    const first = Math.min(...evs.map((e) => e.ts));
    const ends = evs.filter((e) => e.kind === 'end');
    const last = Math.max(...(ends.length ? ends : evs).map((e) => e.ts));
    const req = evs.find((e) => e.step === 'agent.request' && e.kind === 'end');
    const outcome = req?.outcome ?? (ends.some((e) => e.outcome === 'error') ? 'error' : ends.some((e) => e.outcome === 'cancelled') ? 'cancelled' : 'ok');
    return {
      request_id: id, ts: first, wall_ms: last - first,
      source: evs.find((e) => e.step === 'agent.request' && e.attrs?.source)?.attrs.source ?? null,
      app_version: evs.find((e) => e.app_version)?.app_version ?? '',
      outcome, error_code: req ? req.error_code ?? null : ends.find((e) => e.error_code)?.error_code ?? null,
      steps: chain(evs, id).map((r) => ({
        step: r.step, component: r.component, depth: r.depth, at_ms: r.ts - first,
        duration_ms: r.duration_ms ?? null, outcome: r.outcome ?? null, error_code: r.error_code ?? null,
      })),
    };
  });
}

// Each step's summed duration over the summed request wall time. Nested steps overlap their parents, so the shares
// don't add up to 100 %.
export function share(reqs) {
  const total = reqs.reduce((a, r) => a + r.wall_ms, 0);
  const by = new Map();
  for (const r of reqs) {
    for (const s of r.steps) {
      if (!finite(s.duration_ms)) continue;
      const g = by.get(s.step) ?? { step: s.step, n: 0, total_ms: 0 };
      g.n++;
      g.total_ms += s.duration_ms;
      by.set(s.step, g);
    }
  }
  const rows = [...by.values()].map((g) => ({ ...g, share: total ? g.total_ms / total : null })).sort((a, b) => b.total_ms - a.total_ms);
  return { requests: reqs.length, request_ms: total, steps: rows };
}

export function slowest(reqs, n = 10) {
  return [...reqs].sort((a, b) => b.wall_ms - a.wall_ms || (a.request_id < b.request_id ? -1 : 1)).slice(0, n);
}

// Per step: ends and events with an outcome, error and cancel counts and rates. Per step and error code: counts and
// their share of that step's outcomes.
export function errors(events) {
  const by = new Map(), codes = new Map();
  for (const e of events) {
    if (e.kind === 'start' || !e.outcome) continue;
    const g = by.get(e.step) ?? { step: e.step, total: 0, errors: 0, cancels: 0 };
    g.total++;
    if (e.outcome === 'error') g.errors++;
    if (e.outcome === 'cancelled') g.cancels++;
    by.set(e.step, g);
    if (e.outcome !== 'error' && e.outcome !== 'cancelled') continue;
    const k = `${e.step}\u0000${e.error_code ?? ''}\u0000${e.outcome}`;
    const c = codes.get(k) ?? { step: e.step, outcome: e.outcome, error_code: e.error_code ?? null, count: 0 };
    c.count++;
    codes.set(k, c);
  }
  const stepRows = [...by.values()].map((g) => ({ ...g, error_rate: g.errors / g.total, cancel_rate: g.cancels / g.total }))
    .sort((a, b) => b.errors + b.cancels - (a.errors + a.cancels) || a.step.localeCompare(b.step));
  const codeRows = [...codes.values()].map((c) => ({ ...c, share: c.count / by.get(c.step).total }))
    .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step) || String(a.error_code).localeCompare(String(b.error_code)));
  return { steps: stepRows, codes: codeRows };
}

// App starts, sidecar and helper restarts and crashes, and telemetry's own losses.
export function lifecycle(events) {
  const out = {
    app_starts: 0, sidecar_boots: 0, sidecar_starts: 0, sidecar_restarts: 0, sidecar_start_failures: 0,
    sidecar_exits: 0, sidecar_crashes: 0, helper_start_failures: 0, helper_crashes: 0, helper_restarted: 0,
    helper_gave_up: 0, helper_crashes_by_engine: {}, shadow_crashes: 0, shadow_crashes_by_engine: {},
    telemetry_dropped: 0, telemetry_capped: 0, host_backlog_dropped: 0,
  };
  const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const e of events) {
    const a = e.attrs ?? {}, done = e.kind === 'end' || e.kind === 'event';
    if (e.step === 'host.cold_start' && e.kind === 'end') out.app_starts++;
    else if (e.step === 'sidecar.boot' && e.kind === 'end') out.sidecar_boots++;
    else if (e.step === 'host.sidecar_start') {
      if (e.kind !== 'end') { out.sidecar_starts++; if (a.attempt > 1) out.sidecar_restarts++; }
      if (done && e.outcome === 'error') out.sidecar_start_failures++;
    } else if (e.step === 'host.sidecar_exit' && done) {
      out.sidecar_exits++;
      if (e.outcome === 'error') out.sidecar_crashes++;
    } else if (e.step === 'host.helper_start' && done && e.outcome === 'error') out.helper_start_failures++;
    else if (e.step === 'host.helper_exit' && done && e.outcome === 'error') {
      out.helper_crashes++;
      inc(out.helper_crashes_by_engine, a.engine ?? 'unknown');
      if (a.restart === true) out.helper_restarted++;
      else if (a.restart === false) out.helper_gave_up++;
    } else if (e.step === 'host.stt_shadow' && e.error_code === 'helper_crashed') {
      out.shadow_crashes++;
      inc(out.shadow_crashes_by_engine, a.engine ?? 'unknown');
    } else if (e.step === 'telemetry.dropped') out.telemetry_dropped += finite(a.count) ? a.count : 1;
    else if (e.step === 'telemetry.capped') out.telemetry_capped++;
    else if (e.step === 'host.telemetry_backlog') out.host_backlog_dropped += finite(a.dropped) ? a.dropped : 0;
  }
  return out;
}

// Oldest first: dotted numeric parts compare as numbers, anything else as strings, '' (unknown) last.
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(/[.+-]/), pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

export const MEMORY_FIELDS = ['host_mb', 'sidecar_mb', 'helper_mb', 'heap_mb'];

// `app.memory` samples by UTC day and by app version (n, p50 and max per field), and the first → last day p50 change.
export function memory(events) {
  const samples = events.filter((e) => e.step === 'app.memory');
  const group = (key) => {
    const m = new Map();
    for (const e of samples) {
      const k = key(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e.attrs ?? {});
    }
    return [...m.entries()].map(([k, rows]) => {
      const r = { key: k, n: rows.length };
      for (const f of MEMORY_FIELDS) {
        const q = quantiles(rows.map((a) => a[f]));
        r[f] = q.n ? { p50: q.p50, max: q.max } : null;
      }
      return r;
    });
  };
  const days = group((e) => new Date(e.ts).toISOString().slice(0, 10)).sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ key, ...r }) => ({ day: key, ...r }));
  const versions = group((e) => e.app_version ?? '').sort((a, b) => compareVersions(a.key, b.key)).map(({ key, ...r }) => ({ app_version: key, ...r }));
  const trend = {};
  for (const f of MEMORY_FIELDS) {
    const have = days.filter((d) => d[f]);
    trend[f] = have.length < 2 ? null : {
      from_day: have[0].day, to_day: have.at(-1).day, from: have[0][f].p50, to: have.at(-1)[f].p50, change: have.at(-1)[f].p50 - have[0][f].p50,
    };
  }
  return { samples: samples.length, days, versions, trend };
}

const nums = (rows, k) => rows.map((r) => r[k]).filter(finite).sort((a, b) => a - b);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// The engine comparison (docs/voice-engines.md): one row per engine x role from `host.stt` ends (primary) and
// `host.stt_shadow` results (shadow), with the stt_correction rate per primary engine. Skipped, crashed (helper died)
// and failed (per-take error) shadow jobs count apart; shadow rows sum sub/ins/del (jiwer's naming, the selected engine's text as reference).
export function stt(events) {
  const by = new Map();
  const corrections = new Map();
  const row = (engine, role) => {
    const k = `${engine}\u0000${role}`;
    if (!by.has(k)) by.set(k, { engine, role, takes: [], skipped: 0, crashed: 0, failed: 0 });
    return by.get(k);
  };
  for (const e of events) {
    const a = e.attrs ?? {};
    if (e.step === 'host.stt' && e.kind === 'end') row(a.engine ?? 'system', a.role ?? 'primary').takes.push(a);
    else if (e.step === 'host.stt_shadow') {
      const r = row(a.engine ?? 'unknown', 'shadow');
      if (e.outcome === 'cancelled') r.skipped++;
      else if (e.outcome === 'error' && e.error_code === 'helper_crashed') r.crashed++;
      else if (e.outcome === 'error') r.failed++;
      else r.takes.push(a);
    } else if (e.step === 'stt_correction') corrections.set(a.engine ?? 'system', (corrections.get(a.engine ?? 'system') ?? 0) + 1);
  }
  return [...by.values()].map((g) => {
    const t = g.takes, n = t.length, q = (k, p) => { const v = nums(t, k); return v.length ? pct(v, p) : null; };
    const rss = nums(t, 'peak_rss_mb');
    const sum = (k) => (g.role === 'shadow' ? nums(t, k).reduce((x, y) => x + y, 0) : null);
    return {
      engine: g.engine, role: g.role, n, skipped: g.skipped, crashed: g.crashed, failed: g.failed,
      empty_rate: n ? t.filter((a) => a.empty === true).length / n : null,
      rtf_p50: q('rtf', 50), rtf_p95: q('rtf', 95),
      final_p50: q('speech_end_to_final_ms', 50), final_p95: q('speech_end_to_final_ms', 95),
      ttfp_p50: q('time_to_first_partial_ms', 50), ttfp_p95: q('time_to_first_partial_ms', 95),
      revision_rate: mean(nums(t, 'revision_rate')),
      peak_rss_mb: rss.length ? rss[rss.length - 1] : null,
      agreement: g.role === 'shadow' ? mean(nums(t, 'agreement')) : null,
      corrections: g.role === 'primary' ? corrections.get(g.engine) ?? 0 : null,
      correction_rate: g.role === 'primary' && n ? (corrections.get(g.engine) ?? 0) / n : null,
      sub: sum('sub'), ins: sum('ins'), del: sum('del'),
    };
  }).sort((a, b) => (a.role === b.role ? b.n - a.n : a.role === 'primary' ? -1 : 1));
}

// Steps, errors and voice engines per app version, oldest first.
export function byVersion(events) {
  const m = new Map();
  for (const e of events) {
    const v = e.app_version ?? '';
    if (!m.has(v)) m.set(v, []);
    m.get(v).push(e);
  }
  return [...m.keys()].sort(compareVersions).map((v) => {
    const evs = m.get(v);
    return { app_version: v, events: evs.length, requests: new Set(evs.filter((e) => e.request_id).map((e) => e.request_id)).size, steps: steps(evs).steps, errors: errors(evs), stt: stt(evs) };
  });
}

export const REGRESSION = { p95_growth: 0.2, error_rate_points: 0.05, min_n: 5 };

// Newest known version vs the one before: p95 up >= 20 % or error rate up >= 5 points, with n >= 5 on both sides.
export function regressions(versions, rule = REGRESSION) {
  const known = versions.filter((v) => v.app_version);
  if (known.length < 2) return { from: null, to: known[0]?.app_version ?? null, flags: [] };
  const [prev, cur] = known.slice(-2);
  const flags = [];
  const before = new Map(prev.steps.map((r) => [r.step, r]));
  for (const r of cur.steps) {
    const b = before.get(r.step);
    if (!b) continue;
    if (b.n >= rule.min_n && r.n >= rule.min_n && b.p95 > 0 && r.p95 >= b.p95 * (1 + rule.p95_growth)) {
      flags.push({ step: r.step, metric: 'p95_ms', from: b.p95, to: r.p95, change: r.p95 / b.p95 - 1, n_from: b.n, n_to: r.n });
    }
    if (b.ends >= rule.min_n && r.ends >= rule.min_n && r.error_rate - b.error_rate >= rule.error_rate_points - 1e-9) {
      flags.push({ step: r.step, metric: 'error_rate', from: b.error_rate, to: r.error_rate, change: r.error_rate - b.error_rate, n_from: b.ends, n_to: r.ends });
    }
  }
  flags.sort((a, b) => (a.metric === b.metric ? b.change - a.change : a.metric === 'p95_ms' ? -1 : 1));
  return { from: prev.app_version, to: cur.app_version, flags };
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, ''));

// The offline `--bench` tables ("### Own voice …", "### LibriSpeech …") and the "Test machine" note from
// docs/voice-engines.md, or null when the file can't be read.
export function benchResults(docPath = DEFAULT_BENCH_DOC) {
  let text;
  try { text = fs.readFileSync(docPath, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  const mi = lines.findIndex((l) => l.startsWith('Test machine:'));
  const machine = mi < 0 ? null : lines.slice(mi, lines.findIndex((l, i) => i > mi && !l.trim())).join(' ').trim();
  const tables = [];
  lines.forEach((l, i) => {
    if (!/^### (Own voice|LibriSpeech)/.test(l)) return;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (!lines[j]?.startsWith('|')) return;
    const columns = cells(lines[j]);
    const rows = [];
    for (j += 2; j < lines.length && lines[j].startsWith('|'); j++) {
      const v = cells(lines[j]);
      rows.push(Object.fromEntries(columns.map((c, k) => [c, v[k] ?? ''])));
    }
    tables.push({ title: l.slice(4).trim(), columns, rows });
  });
  return { source: docPath, machine, tables };
}

// The JSON summary: every section of the Markdown report, raw numbers.
export function buildReport(events, stats, opts = {}) {
  const reqs = requests(events);
  const st = steps(events);
  const versions = byVersion(events);
  const tss = events.map((e) => e.ts);
  return {
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    dir: opts.dir ?? null,
    days: opts.days ?? null,
    input: { ...stats, events: events.length, first_ts: tss.length ? Math.min(...tss) : null, last_ts: tss.length ? Math.max(...tss) : null },
    regression_rule: REGRESSION,
    regressions: regressions(versions),
    steps: st.steps,
    components: st.components,
    share: share(reqs),
    slowest: slowest(reqs, 10),
    errors: errors(events),
    lifecycle: lifecycle(events),
    memory: memory(events),
    stt: stt(events),
    bench: opts.benchDoc === null ? null : benchResults(opts.benchDoc ?? DEFAULT_BENCH_DOC),
    bench_doc: opts.benchDoc ?? DEFAULT_BENCH_DOC,
    by_version: versions,
  };
}

const num = (v, d = 1) => (v === null || v === undefined ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(d));
const pcnt = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)} %`);
const code = (s) => (s ? `\`${s}\`` : '–');
const ver = (v) => v || 'unknown';
const table = (head, rows) => (rows.length
  ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
  : '_None._');

const stepTable = (rows, key = 'step') => table(
  [key, ...(key === 'step' ? ['component'] : []), 'n', 'p50 ms', 'p90 ms', 'p95 ms', 'p99 ms', 'max ms', 'errors', 'cancels', 'retries'],
  rows.filter((r) => r.n).map((r) => [code(r[key]), ...(key === 'step' ? [r.component] : []), r.n, num(r.p50), num(r.p90), num(r.p95), num(r.p99), num(r.max),
    pcnt(r.error_rate), pcnt(r.cancel_rate), pcnt(r.retry_rate)]),
);
const errorTable = (rows) => table(['step', 'outcomes', 'errors', 'error rate', 'cancels', 'cancel rate'],
  rows.filter((r) => r.errors || r.cancels).map((r) => [code(r.step), r.total, r.errors, pcnt(r.error_rate), r.cancels, pcnt(r.cancel_rate)]));
const codeTable = (rows) => table(['step', 'outcome', 'code', 'count', 'share of step'],
  rows.map((r) => [code(r.step), r.outcome, code(r.error_code), r.count, pcnt(r.share)]));
const sttTable = (rows) => table(
  ['engine', 'role', 'n', 'skipped', 'crashed', 'failed', 'empty', 'rtf p50 / p95', 'speech end → final ms p50 / p95', 'first partial ms p50 / p95',
    'revision', 'agreement', 'S / I / D', 'corrections', 'correction rate', 'peak MB'],
  rows.map((r) => [r.engine, r.role, r.n, r.skipped, r.crashed, r.failed, pcnt(r.empty_rate), `${num(r.rtf_p50, 2)} / ${num(r.rtf_p95, 2)}`,
    `${num(r.final_p50, 0)} / ${num(r.final_p95, 0)}`, `${num(r.ttfp_p50, 0)} / ${num(r.ttfp_p95, 0)}`, pcnt(r.revision_rate),
    pcnt(r.agreement), r.role === 'shadow' ? `${r.sub} / ${r.ins} / ${r.del}` : '–', num(r.corrections), pcnt(r.correction_rate), num(r.peak_rss_mb, 0)]),
);
const memCell = (m) => (m ? `${num(m.p50)} / ${num(m.max)}` : '–');
const memTable = (rows, key) => table([key, 'samples', ...MEMORY_FIELDS.map((f) => `${f} p50 / max`)],
  rows.map((r) => [key === 'app_version' ? ver(r[key]) : r[key], r.n, ...MEMORY_FIELDS.map((f) => memCell(r[f]))]));

export function formatMarkdown(s) {
  const out = [];
  const h = (t) => out.push('', t, '');
  const day = (ts) => (ts === null ? '–' : new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  out.push('# Roamies telemetry report', '');
  out.push(`Generated ${s.generated_at} from \`${s.dir ?? '?'}\` (newest ${s.days ?? '?'} day files). Percentiles are exact`
    + ' (nearest rank over every raw value). See docs/telemetry.md for what each metric means.');

  h('## Input');
  const i = s.input;
  out.push(table(['day files', 'lines', 'events', 'malformed (skipped)', 'unsupported schema (skipped)', 'by schema', 'from', 'to'],
    [[i.files.length ? `${i.files.length} (${i.files[0]} … ${i.files.at(-1)})` : '0', i.lines, i.events, i.malformed, i.unsupported_schema,
      Object.entries(i.by_schema).map(([k, v]) => `v${k}: ${v}`).join(', ') || '–', day(i.first_ts), day(i.last_ts)]]));
  if (!i.events) out.push('', '**No events.** Is Record Telemetry on, and is `--dir` right?');

  h('## Regressions');
  const r = s.regressions;
  if (!r.from) out.push(`Needs two app versions to compare (have: ${r.to ? ver(r.to) : 'none'}).`);
  else {
    out.push(`${ver(r.from)} → ${ver(r.to)}. Flagged when p95 grows ≥ ${s.regression_rule.p95_growth * 100} % or the error rate`
      + ` rises ≥ ${s.regression_rule.error_rate_points * 100} points, with n ≥ ${s.regression_rule.min_n} on both sides.`, '');
    out.push(r.flags.length ? table(['step', 'metric', ver(r.from), ver(r.to), 'change', 'n'], r.flags.map((f) => f.metric === 'p95_ms'
      ? [code(f.step), 'p95 ms', num(f.from), num(f.to), `+${(f.change * 100).toFixed(0)} %`, `${f.n_from} → ${f.n_to}`]
      : [code(f.step), 'error rate', pcnt(f.from), pcnt(f.to), `+${(f.change * 100).toFixed(1)} pts`, `${f.n_from} → ${f.n_to}`])) : 'None flagged.');
  }

  h('## Steps');
  out.push('Ended steps, slowest p95 first. Errors, cancels and retries are rates over the step\'s ends.', '');
  out.push(stepTable(s.steps));

  h('## Components');
  out.push('All ended steps of each layer together (nested steps count in their own and their parent\'s duration).', '');
  out.push(stepTable(s.components, 'component'));

  h('## Share of request time');
  out.push(`${s.share.requests} requests, ${num(s.share.request_ms)} ms of wall time (first event → last end of each request).`
    + ' Share = the step\'s summed duration ÷ that total. Nested steps overlap their parents, so shares don\'t add up to 100 %.', '');
  out.push(table(['step', 'n', 'total ms', 'share'], s.share.steps.map((g) => [code(g.step), g.n, num(g.total_ms), pcnt(g.share)])));

  h('## Slowest requests');
  if (!s.slowest.length) out.push('_None._');
  s.slowest.forEach((q, k) => {
    out.push(`### ${k + 1}. \`${q.request_id}\`: ${num(q.wall_ms)} ms`, '');
    out.push(`${day(q.ts)} · source ${q.source ?? '–'} · version ${ver(q.app_version)} · ${q.outcome}${q.error_code ? ` (\`${q.error_code}\`)` : ''}`, '');
    out.push(table(['at ms', 'step', 'component', 'ms', 'outcome', 'code'], q.steps.map((t) => [num(t.at_ms),
      `${'  '.repeat(t.depth)}${t.depth ? '↳ ' : ''}\`${t.step}\``, t.component, num(t.duration_ms), t.outcome ?? 'open', code(t.error_code)])), '');
  });

  h('## Errors and cancels');
  out.push('Per step, over its ends and events that carry an outcome.', '');
  out.push(errorTable(s.errors.steps));
  h('### By error code');
  out.push(codeTable(s.errors.codes));

  h('## Crashes and restarts');
  const l = s.lifecycle;
  const by = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') || '–';
  out.push(table(['counter', 'count', 'detail'], [
    ['app starts (`host.cold_start`)', l.app_starts, ''],
    ['sidecar boots (`sidecar.boot`)', l.sidecar_boots, ''],
    ['sidecar starts / restarts (attempt > 1)', `${l.sidecar_starts} / ${l.sidecar_restarts}`, `${l.sidecar_start_failures} failed to start`],
    ['sidecar exits / crashes', `${l.sidecar_exits} / ${l.sidecar_crashes}`, ''],
    ['voice helper crashes', l.helper_crashes, `restarted ${l.helper_restarted}, gave up ${l.helper_gave_up}; ${by(l.helper_crashes_by_engine)}`],
    ['voice helper start failures', l.helper_start_failures, ''],
    ['shadow helper crashes', l.shadow_crashes, by(l.shadow_crashes_by_engine)],
    ['telemetry events dropped / days capped', `${l.telemetry_dropped} / ${l.telemetry_capped}`, `host backlog dropped ${l.host_backlog_dropped}`],
  ]));

  h('## Memory');
  out.push(`${s.memory.samples} \`app.memory\` samples (MB; sampled every 60 s while in use).`, '');
  out.push('### By day', '', memTable(s.memory.days, 'day'));
  out.push('', '### By version', '', memTable(s.memory.versions, 'app_version'));
  const trends = MEMORY_FIELDS.filter((f) => s.memory.trend[f]).map((f) => {
    const t = s.memory.trend[f];
    return `${f} ${num(t.from)} → ${num(t.to)} (${t.change >= 0 ? '+' : ''}${num(t.change)})`;
  });
  out.push('', trends.length ? `Trend, p50 first day → last day (${s.memory.days[0].day} → ${s.memory.days.at(-1).day}): ${trends.join('; ')}.` : 'Trend: needs samples on two days.');

  h('## Voice engines');
  out.push('Live takes from telemetry: `host.stt` (primary, the selected engine) and `host.stt_shadow` (shadow mode).'
    + ' Agreement and S / I / D compare the shadow with the selected engine\'s text; corrections are `stt_correction` events.', '');
  out.push(sttTable(s.stt));
  h('### Offline bench (docs/voice-engines.md)');
  if (!s.bench) out.push(`Not found: \`${s.bench_doc}\` (pass \`--bench-doc <path>\`).`);
  else {
    if (s.bench.machine) out.push(s.bench.machine, '');
    for (const t of s.bench.tables) out.push(`**${t.title}**`, '', table(t.columns, t.rows.map((row) => t.columns.map((c) => row[c]))), '');
  }

  h('## By version');
  for (const v of s.by_version) {
    out.push(`### ${ver(v.app_version)}`, '', `${v.events} events, ${v.requests} requests.`, '');
    out.push('**Steps**', '', stepTable(v.steps), '', '**Errors by code**', '', codeTable(v.errors.codes), '', '**Voice engines**', '', sttTable(v.stt), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function writeReport({ dir, days = 14, out, benchDoc, now } = {}) {
  const { events, stats } = readEvents(dir, days);
  const summary = buildReport(events, stats, { dir, days, benchDoc, now });
  fs.mkdirSync(out, { recursive: true });
  const md = path.join(out, 'telemetry-report.md'), json = path.join(out, 'telemetry-report.json');
  fs.writeFileSync(json, JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(md, formatMarkdown(summary));
  return { md, json, summary };
}

export function formatStt(rows) {
  const f = (v, d = 2) => (v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(d));
  const pc = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`);
  const cols = [['engine', 12], ['role', 8], ['n', 5], ['skipped', 7], ['failed', 6], ['empty', 6], ['rtf p50/p95', 12], ['final ms p50/p95', 17],
    ['ttfp ms p50/p95', 16], ['revised', 7], ['peak MB', 8], ['agree', 6], ['corrected', 9]];
  const line = (vals) => vals.map((v, i) => (i < 2 ? String(v).padEnd(cols[i][1]) : String(v).padStart(cols[i][1]))).join('  ');
  return [line(cols.map((c) => c[0])), ...rows.map((r) => line([r.engine, r.role, r.n, r.skipped, r.failed, pc(r.empty_rate),
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
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const dir = flag('--dir') ?? telemetryDir();
  const out = flag('--out');
  const benchDoc = flag('--bench-doc');
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
  if (cmd === 'report') {
    // A sibling of the telemetry folder, so retention never deletes it.
    const r = writeReport({ dir, days: Number(a) || 14, out: out ?? path.join(path.dirname(path.resolve(dir)), 'telemetry-report'), benchDoc });
    const i = r.summary.input;
    console.log(`${i.events} events from ${i.files.length} day files (${i.malformed} malformed and ${i.unsupported_schema} unsupported-schema lines skipped)`);
    console.log(r.md);
    console.log(r.json);
    return 0;
  }
  console.error('Usage: telemetry-report.mjs chain <request_id> [days] | p95 [days] | stt [days] | report [days] [--out <folder>] [--bench-doc <md>] [--dir <telemetry folder>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
