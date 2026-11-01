// The report script: one request's chain in order with depth, steps ranked by p95. Run: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chain, formatChain, formatStt, p95, stt } from '../telemetry-report.mjs';

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
assert.match(formatStt(cmp), /moonshine\s+primary\s+2\s+0\s+50%/);

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
fs.rmSync(tmp, { recursive: true, force: true });
console.log('telemetry report tests passed');
