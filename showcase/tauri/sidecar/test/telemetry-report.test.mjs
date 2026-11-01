// The report script: chain, p95, stt, and the full report on the fixture log. Run: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchResults, buildReport, chain, compareVersions, formatChain, formatStt, loadEvents, p95, quantiles, readEvents, stt } from '../telemetry-report.mjs';

const rid = 'ef'.repeat(16);
const ev = (kind, step, step_id, ts, extra = {}) => ({ schema: 1, ts, request_id: rid, step_id, parent_step_id: null, kind, step, component: 'sidecar', duration_ms: null, outcome: null, error_code: null, attrs: {}, ...extra });
const events = [
  ev('start', 'agent.request', 'a', 1000),
  ev('start', 'agent.turn', 'b', 1010, { parent_step_id: 'a' }),
  ev('end', 'agent.turn', 'b', 1300, { parent_step_id: 'a', duration_ms: 290, outcome: 'ok', attrs: { ttft_ms: 120 } }),
  ev('start', 'host.voice_session', 'h', 900, { component: 'host' }),
  ev('end', 'host.voice_session', 'h', 990, { component: 'host', duration_ms: 90, outcome: 'ok' }),
  ev('end', 'agent.request', 'a', 1400, { duration_ms: 400, outcome: 'error', error_code: 'tool_error' }),
  ev('event', 'agent.first_text', 'c', 1200, { parent_step_id: 'a' }),
  ev('start', 'agent.request', 'x', 5000, { request_id: 'aa'.repeat(16), attrs: { retry: true } }),
  ev('end', 'agent.request', 'x', 5100, { request_id: 'aa'.repeat(16), duration_ms: 100, outcome: 'ok' }),
];

const rows = chain(events, rid);
assert.deepEqual(rows.map((r) => r.step), ['host.voice_session', 'agent.request', 'agent.turn', 'agent.first_text']);
assert.deepEqual(rows.map((r) => r.depth), [0, 0, 1, 1]);
assert.equal(rows[0].at_ms, 0);
assert.equal(rows[1].error_code, 'tool_error');
assert.equal(rows[2].attrs.ttft_ms, 120);
assert.match(formatChain(rows), /agent\.turn\s+290\.0 ms\s+ok/);

const ranked = p95(events);
assert.equal(ranked[0].step, 'agent.request');
assert.equal(ranked[0].n, 2);
assert.equal(ranked[0].p95, 400);
assert.equal(ranked[0].error_rate, 0.5);
assert.equal(ranked[0].retry_rate, 0.5);
// An end without a duration doesn't count, so rates stay within n (they could pass 100 %).
const untimed = p95([...events, ev('end', 'agent.request', 'z', 6000, { outcome: 'error' })]);
assert.deepEqual([untimed[0].n, untimed[0].error_rate], [2, 0.5]);

// Engine comparison: host.stt ends by engine and role, shadow results apart from skipped ones, corrections per primary.
const host = (kind, step, id, attrs, extra = {}) => ev(kind, step, id, 2000, { component: 'host', attrs, ...extra });
const sttEvents = [
  host('start', 'host.stt', 's0', {}),
  host('end', 'host.stt', 's1', { engine: 'moonshine', role: 'primary', rtf: 0.5, speech_end_to_final_ms: 100, time_to_first_partial_ms: 900, revision_rate: 0.1, peak_rss_mb: 300, empty: false }),
  host('end', 'host.stt', 's2', { engine: 'moonshine', role: 'primary', rtf: 0.7, speech_end_to_final_ms: 300, time_to_first_partial_ms: 1100, revision_rate: 0.3, peak_rss_mb: 320, empty: true }),
  host('end', 'host.stt', 's3', { engine: 'parakeet', role: 'primary', rtf: 0.1, speech_end_to_final_ms: 500, peak_rss_mb: 800, empty: false }),
  host('event', 'host.stt_shadow', 's4', { engine: 'parakeet', role: 'shadow', rtf: 0.07, agreement: 0.8, peak_rss_mb: 810 }),
  host('event', 'host.stt_shadow', 's5', { engine: 'parakeet', role: 'shadow', rtf: 0.09, agreement: 1, peak_rss_mb: 805 }),
  host('event', 'host.stt_shadow', 's6', { engine: 'parakeet', role: 'shadow' }, { outcome: 'cancelled', error_code: 'battery_saver' }),
  // A per-take error from a live shadow helper is a failure, not a crash.
  host('event', 'host.stt_shadow', 's8', { engine: 'parakeet', role: 'shadow' }, { outcome: 'error', error_code: 'no_input' }),
  ev('event', 'stt_correction', 's7', 2100, { attrs: { kind: 'reask', engine: 'moonshine', edit_distance: 3 } }),
];
const cmp = stt(sttEvents);
assert.deepEqual(cmp.map((r) => [r.engine, r.role, r.n]), [['moonshine', 'primary', 2], ['parakeet', 'primary', 1], ['parakeet', 'shadow', 2]]);
const [moon, para, shadow] = cmp;
assert.equal(moon.empty_rate, 0.5);
assert.deepEqual([moon.rtf_p50, moon.rtf_p95, moon.final_p95, moon.ttfp_p50, moon.peak_rss_mb], [0.5, 0.7, 300, 900, 320]);
assert.ok(Math.abs(moon.revision_rate - 0.2) < 1e-9);
assert.equal(moon.correction_rate, 0.5);
assert.deepEqual([para.ttfp_p50, para.revision_rate, para.correction_rate, para.agreement], [null, null, 0, null]);
assert.deepEqual([shadow.skipped, shadow.agreement, shadow.peak_rss_mb, shadow.correction_rate], [1, 0.9, 810, null]);
assert.deepEqual([shadow.n, shadow.crashed, shadow.failed], [2, 0, 1]);
assert.match(formatStt(cmp), /moonshine\s+primary\s+2\s+0\s+0\s+50%/);
assert.match(formatStt(cmp), /parakeet\s+shadow\s+2\s+1\s+1\s/);

// CLI on a day file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-report-'));
const dir = path.join(tmp, 'sidekick', 'telemetry');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '2026-10-31.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'telemetry-report.mjs');
const out = execFileSync(process.execPath, [script, 'chain', rid], { env: { ...process.env, ROAMIES_DATA_DIR: tmp }, encoding: 'utf8' });
assert.match(out, /host\.voice_session/);
assert.match(execFileSync(process.execPath, [script, 'p95', '--dir', dir], { encoding: 'utf8' }), /^step/);
assert.match(execFileSync(process.execPath, [script, 'stt', '--dir', dir], { encoding: 'utf8' }), /^engine\s+role/);
// Full report on the committed fixture: two versions, both engines, 3 malformed lines and 1 schema-2 line.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'telemetry');
const { events: fx, stats } = readEvents(fixture, 14);
assert.deepEqual([stats.files.length, stats.lines, stats.parsed, stats.malformed, stats.unsupported_schema], [2, 107, 103, 3, 1]);
assert.deepEqual(stats.by_schema, { 1: 104, 2: 1 });
assert.equal(loadEvents(fixture, 14).length, 103);
assert.deepEqual(quantiles([3, 1, 2, 4]), { n: 4, p50: 2, p90: 4, p95: 4, p99: 4, max: 4, mean: 2.5 });
assert.equal(quantiles([]).n, 0);

const rep = buildReport(fx, stats, { dir: fixture, days: 14 });
const step = (name) => rep.steps.find((r) => r.step === name);
const turn = step('agent.turn');
assert.deepEqual([turn.n, turn.p50, turn.p90, turn.p95, turn.p99, turn.max], [11, 200, 240, 900, 900, 900]);
const req = step('agent.request');
assert.deepEqual([req.n, req.p50, req.p95, req.max, req.errors, req.cancels], [11, 300, 1000, 1000, 2, 1]);
assert.ok(Math.abs(req.error_rate - 2 / 11) < 1e-9 && Math.abs(req.cancel_rate - 1 / 11) < 1e-9);
assert.equal(rep.steps[0].step, 'host.helper_exit');
const comp = Object.fromEntries(rep.components.map((r) => [r.component, r]));
assert.deepEqual([comp.host.n, comp.host.p50, comp.host.max, comp.sidecar.n, comp.sidecar.p50, comp.sidecar.max], [19, 80, 30000, 26, 230, 1000]);
assert.ok(Math.abs(comp.sidecar.error_rate - 3 / 26) < 1e-9);

assert.deepEqual([rep.share.requests, rep.share.request_ms], [11, 4800]);
const shareOf = Object.fromEntries(rep.share.steps.map((r) => [r.step, r]));
assert.deepEqual(['agent.request', 'agent.turn', 'host.stt', 'agent.tool'].map((s) => shareOf[s].total_ms), [3700, 2600, 880, 50]);
assert.ok(Math.abs(shareOf['agent.turn'].share - 2600 / 4800) < 1e-9);

assert.equal(rep.slowest.length, 10);
const top = rep.slowest[0];
assert.deepEqual([top.request_id, top.wall_ms, top.source, top.app_version, top.outcome], ['b5'.padEnd(32, '0'), 1100, 'voice', '0.5.0', 'ok']);
assert.deepEqual(
  top.steps.filter((s) => s.duration_ms != null).map((s) => [s.step, s.depth, s.at_ms, s.duration_ms]),
  [['host.stt', 0, 0, 80], ['agent.request', 0, 100, 1000], ['agent.turn', 1, 150, 900]],
);
assert.deepEqual([rep.slowest[1].outcome, rep.slowest[1].error_code], ['error', 'rate_limited']);
assert.ok(rep.slowest[2].steps.some((s) => s.step === 'agent.tool' && s.error_code === 'tool_error'));

const errOf = Object.fromEntries(rep.errors.steps.map((r) => [r.step, r]));
assert.deepEqual([errOf['agent.request'].total, errOf['agent.request'].errors, errOf['agent.request'].cancels], [11, 2, 1]);
assert.deepEqual([errOf['host.stt_shadow'].total, errOf['host.stt_shadow'].error_rate, errOf['host.stt_shadow'].cancel_rate], [2, 0.5, 0.5]);
const code = (s, c) => rep.errors.codes.find((r) => r.step === s && r.error_code === c);
assert.equal(code('agent.request', 'rate_limited').count, 2);
assert.deepEqual([code('agent.request', 'user_stop').outcome, code('agent.request', 'user_stop').count], ['cancelled', 1]);
assert.equal(code('host.helper_exit', 'helper_crashed').share, 1);

const life = rep.lifecycle;
assert.deepEqual(
  [life.app_starts, life.sidecar_boots, life.sidecar_starts, life.sidecar_restarts, life.sidecar_exits, life.sidecar_crashes,
    life.helper_crashes, life.helper_restarted, life.helper_gave_up, life.shadow_crashes, life.telemetry_dropped],
  [2, 3, 3, 1, 1, 1, 2, 1, 1, 1, 3],
);
assert.deepEqual(life.helper_crashes_by_engine, { moonshine: 1, parakeet: 1 });
assert.deepEqual(life.shadow_crashes_by_engine, { moonshine: 1 });

assert.equal(rep.memory.samples, 4);
assert.deepEqual(
  rep.memory.days.map((d) => [d.day, d.n, d.host_mb.p50, d.host_mb.max, d.helper_mb.p50]),
  [['2026-10-30', 2, 100, 110, 300], ['2026-10-31', 2, 120, 140, 800]],
);
assert.deepEqual(rep.memory.versions.map((d) => d.app_version), ['0.4.0', '0.5.0']);
assert.deepEqual([rep.memory.trend.helper_mb.from, rep.memory.trend.helper_mb.to, rep.memory.trend.helper_mb.change], [300, 800, 500]);

const sttOf = (e, r) => rep.stt.find((x) => x.engine === e && x.role === r);
const pp = sttOf('parakeet', 'primary'), mp = sttOf('moonshine', 'primary'), ps = sttOf('parakeet', 'shadow'), ms = sttOf('moonshine', 'shadow');
assert.deepEqual([pp.n, pp.rtf_p50, pp.rtf_p95, pp.final_p50, pp.final_p95, pp.ttfp_p50, pp.empty_rate, pp.corrections, pp.peak_rss_mb], [6, 0.07, 0.1, 320, 350, null, 0, 1, 800]);
assert.ok(Math.abs(pp.correction_rate - 1 / 6) < 1e-9);
assert.deepEqual([mp.n, mp.rtf_p50, mp.final_p50, mp.ttfp_p50, mp.ttfp_p95, mp.empty_rate, mp.correction_rate], [5, 0.6, 120, 1000, 1100, 0.2, 0.2]);
assert.ok(Math.abs(mp.revision_rate - 0.1) < 1e-9);
assert.deepEqual([ps.n, ps.sub, ps.ins, ps.del, ps.correction_rate], [2, 3, 1, 0, null]);
assert.ok(Math.abs(ps.agreement - 0.85) < 1e-9);
assert.deepEqual([ms.n, ms.skipped, ms.crashed, ms.sub, ms.ins, ms.del], [2, 1, 1, 3, 1, 1]);
assert.equal(ms.failed, 0);
assert.ok(Math.abs(ms.agreement - 0.9) < 1e-9);

assert.deepEqual([rep.regressions.from, rep.regressions.to], ['0.4.0', '0.5.0']);
assert.deepEqual(rep.regressions.flags.map((f) => [f.step, f.from, f.to, f.n_from, f.n_to]), [['agent.turn', 140, 900, 5, 6], ['agent.request', 240, 1000, 5, 6]]);
assert.deepEqual(rep.by_version.map((v) => [v.app_version, v.events, v.requests]), [['0.4.0', 43, 5], ['0.5.0', 60, 6]]);
assert.equal(rep.by_version[0].steps.find((r) => r.step === 'agent.turn').p95, 140);
assert.deepEqual(rep.by_version[0].stt.map((r) => [r.engine, r.role]), [['moonshine', 'primary'], ['parakeet', 'shadow']]);
assert.ok(compareVersions('0.10.0', '0.9.1') > 0);

// Offline bench tables come from the real docs/voice-engines.md, so a heading rename fails here.
const bench = benchResults();
assert.match(bench.machine, /Test machine/);
assert.ok(bench.tables[0].title.startsWith('Own voice') && bench.tables[1].title.startsWith('LibriSpeech'));
assert.equal(bench.tables[0].rows.find((r) => r['Engine / model'] === 'Moonshine small streaming').WER, '8.6 %');
assert.ok(bench.tables[1].rows.some((r) => r['Engine / model'].startsWith('Parakeet')));
assert.equal(benchResults(path.join(tmp, 'missing.md')), null);

// CLI report writes both files; the Markdown has every section; an empty folder still writes a report.
const outDir = path.join(tmp, 'out');
const printed = execFileSync(process.execPath, [script, 'report', '--dir', fixture, '--out', outDir], { encoding: 'utf8' });
assert.match(printed, /3 malformed and 1 unsupported-schema/);
const json = JSON.parse(fs.readFileSync(path.join(outDir, 'telemetry-report.json'), 'utf8'));
assert.equal(json.steps.find((r) => r.step === 'agent.turn').p95, 900);
const md = fs.readFileSync(path.join(outDir, 'telemetry-report.md'), 'utf8');
for (const h of ['Input', 'Regressions', 'Steps', 'Components', 'Share of request time', 'Slowest requests', 'Errors and cancels', 'Crashes and restarts', 'Memory', 'Voice engines', 'By version']) {
  assert.match(md, new RegExp(`^## ${h}$`, 'm'), h);
}
assert.match(md, /Moonshine small streaming \| 8\.6 %/);
const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir);
execFileSync(process.execPath, [script, 'report', '--dir', emptyDir, '--out', path.join(tmp, 'out-empty')], { encoding: 'utf8' });
assert.ok(fs.existsSync(path.join(tmp, 'out-empty', 'telemetry-report.json')));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('telemetry report tests passed');
