// Telemetry sink: schema round-trip, validation, text gate, redaction, rotation, retention, caps,
// and write-failure isolation. Writes only under a temp dir. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, cleanEvent, newRequestId, newStepId, dayOf, SCHEMA, DEFAULTS } from '../telemetry.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-telemetry-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(TMP, `t${n++}`, 'telemetry');
const read = (dir, day) => fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const T0 = new Date(2026, 9, 30, 12, 0, 0).getTime();

// ids
assert.match(newRequestId(), /^[0-9a-f]{32}$/);
assert.match(newStepId(), /^[0-9a-f]{16}$/);
assert.notEqual(newRequestId(), newRequestId());
assert.equal(dayOf(T0), '2026-10-30');

// schema round-trip: start/end/record in, the same fields out
{
  const dir = freshDir();
  let clock = T0, mono = 1000;
  const t = createTelemetry({ dir, version: '1.2.3', platform: 'win32', now: () => clock, mono: () => mono, timer: false });
  const rid = newRequestId();
  const h = t.start('agent.request', { requestId: rid, attrs: { source: 'voice' } });
  const c = t.start('agent.tool', { requestId: rid, parent: h, attrs: { name: 'point_at' } });
  clock += 40; mono += 40;
  t.end(c);
  t.record('agent.first_text', { requestId: rid, parent: h });
  clock += 60; mono += 60.5;
  t.end(h, { outcome: 'error', errorCode: 'rate_limited', attrs: { in: 120, out: 30, model: 'claude-haiku-5-5' } });
  t.end(h); // second end is ignored
  await t.close();
  const ev = read(dir, '2026-10-30');
  assert.equal(ev.length, 5);
  for (const e of ev) {
    assert.deepEqual(Object.keys(e), ['schema', 'ts', 'app_version', 'os', 'request_id', 'step_id', 'parent_step_id', 'kind', 'step', 'component', 'duration_ms', 'outcome', 'error_code', 'attrs']);
    assert.equal(e.schema, SCHEMA);
    assert.equal(e.request_id, rid);
    assert.equal(e.app_version, '1.2.3');
    assert.equal(e.os, 'win32');
    assert.equal(e.component, 'sidecar');
    assert.deepEqual(cleanEvent(e), e, 'a written event re-validates unchanged');
  }
  const [s, cs, ce, ft, se] = ev;
  assert.equal(s.kind, 'start'); assert.equal(s.parent_step_id, null);
  assert.equal(cs.parent_step_id, s.step_id);
  assert.equal(ce.step_id, cs.step_id); assert.equal(ce.duration_ms, 40); assert.equal(ce.outcome, 'ok');
  assert.equal(ft.kind, 'event'); assert.equal(ft.parent_step_id, s.step_id);
  assert.equal(se.step_id, s.step_id); assert.equal(se.duration_ms, 100.5); assert.equal(se.ts - s.ts, 100);
  assert.equal(se.outcome, 'error'); assert.equal(se.error_code, 'rate_limited');
  assert.deepEqual(se.attrs, { in: 120, out: 30, model: 'claude-haiku-5-5' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, '2026-10-30.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
}

// back-dated start
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, mono: () => 5000, timer: false });
  const h = t.start('voice.session', { at: T0 - 250 });
  t.end(h);
  await t.close();
  const [s, e] = read(dir, '2026-10-30');
  assert.equal(s.ts, T0 - 250);
  assert.equal(e.duration_ms, 250);
}

// validation: bad required fields drop the event, bad attrs drop only the attr
{
  const ok = { ts: T0, step_id: 'a'.repeat(16), kind: 'event', step: 'ui.first_bubble', component: 'webview', attrs: {} };
  assert.ok(cleanEvent(ok));
  assert.equal(cleanEvent({ ...ok, schema: 2 }), null);
  assert.equal(cleanEvent({ ...ok, ts: 'now' }), null);
  assert.equal(cleanEvent({ ...ok, request_id: 'xyz' }), null);
  assert.equal(cleanEvent({ ...ok, component: 'server' }), null);
  assert.equal(cleanEvent({ ...ok, kind: 'begin' }), null);
  assert.equal(cleanEvent({ ...ok, step: 'Has Spaces' }), null);
  assert.equal(cleanEvent({ ...ok, outcome: 'maybe' }), null);
  assert.equal(cleanEvent({ ...ok, error_code: 'Not Snake' }), null);
  assert.equal(cleanEvent(null), null);
  const c = cleanEvent({ ...ok, attrs: { n: 3, b: true, id: 'parakeet-v3', free: 'open my bank statement please', obj: { a: 1 }, nan: NaN, 'bad key': 1 } });
  assert.deepEqual(c.attrs, { n: 3, b: true, id: 'parakeet-v3' });
}

// include-text gate and redaction
{
  const key = 'sk-ant-api03-' + 'A'.repeat(40);
  const e = { ts: T0, step_id: 'b'.repeat(16), kind: 'end', step: 'agent.request', component: 'sidecar', attrs: { text: `my key is ${key}`, reply: 'Sure.', model: 'm1' } };
  assert.deepEqual(cleanEvent(e).attrs, { model: 'm1' }, 'text is dropped when include-text is off');
  const on = cleanEvent(e, { includeText: true }).attrs;
  assert.equal(on.reply, 'Sure.');
  assert.ok(!on.text.includes(key), 'secrets in text are redacted: ' + on.text);
  assert.ok(on.text.startsWith('my key is'));
  assert.equal(cleanEvent({ ...e, attrs: { tok: key.slice(0, 60) } }).attrs.tok, undefined, 'a secret-looking identifier is dropped');

  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false });
  t.record('agent.first_text', { attrs: { text: 'hello there' } });
  // other layers never contribute text, even with include-text on
  t.setIncludeText(true);
  t.ingest([{ ts: T0, step_id: 'c'.repeat(16), kind: 'event', step: 'ui.first_bubble', component: 'webview', attrs: { text: 'leak', ms: 3 } }]);
  t.record('agent.first_text', { attrs: { text: 'hello again' } });
  await t.close();
  const ev = read(dir, '2026-10-30');
  // the gate is applied at write time, so all three see include-text on; only sidecar text survives
  assert.deepEqual(ev[1].attrs, { ms: 3 });
  assert.deepEqual(ev[2].attrs, { text: 'hello again' });
  assert.ok(!fs.readFileSync(path.join(dir, '2026-10-30.jsonl'), 'utf8').includes('leak'));
}

// text recorded while include-text is off never reaches the file
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false });
  t.record('agent.first_text', { attrs: { text: 'hello there' } });
  await t.close();
  assert.deepEqual(read(dir, '2026-10-30')[0].attrs, {});
}

// ingest: other layers' events keep their ids, get version/os filled in; sidecar-claimed and junk are counted
{
  const dir = freshDir();
  const t = createTelemetry({ dir, version: '9.9.9', platform: 'linux', now: () => T0, timer: false });
  const rid = newRequestId();
  t.ingest([
    { schema: 1, ts: T0, app_version: '', os: '', request_id: rid, step_id: 'd'.repeat(16), parent_step_id: null, kind: 'start', step: 'voice.session', component: 'voice', attrs: { engine: 'parakeet' } },
    { ts: T0, step_id: 'e'.repeat(16), kind: 'event', step: 'x', component: 'sidecar' },
    'junk',
  ]);
  t.ingest('not an array');
  await t.close();
  const ev = read(dir, '2026-10-30');
  assert.equal(ev.length, 2);
  assert.equal(ev[0].request_id, rid);
  assert.equal(ev[0].app_version, '9.9.9'); assert.equal(ev[0].os, 'linux');
  assert.equal(ev[0].step_id, 'd'.repeat(16));
  assert.deepEqual(ev[1].attrs, { count: 2, reason: 'invalid' });
  assert.equal(t.stats.dropped, 2);
}

// daily rotation
{
  const dir = freshDir();
  let clock = T0;
  const t = createTelemetry({ dir, now: () => clock, timer: false });
  t.record('a.one');
  await t.flush();
  clock = new Date(2026, 9, 31, 0, 0, 1).getTime();
  t.record('a.two');
  await t.close();
  assert.deepEqual(read(dir, '2026-10-30').map((e) => e.step), ['a.one']);
  assert.deepEqual(read(dir, '2026-10-31').map((e) => e.step), ['a.two']);
}

// retention: day files older than keepDays are deleted, other files are left alone
{
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['2026-10-01.jsonl', '2026-10-16.jsonl', '2026-10-17.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, f), '');
  const t = createTelemetry({ dir, now: () => T0, timer: false, keepDays: 14 });
  t.record('a.one');
  await t.close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-17.jsonl', '2026-10-30.jsonl', 'notes.txt']);
}

// size cap: stop writing that day, leave one telemetry.capped note
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false, maxBytes: 2000 });
  for (let i = 0; i < 50; i++) t.record('a.fill', { attrs: { i } });
  await t.flush();
  for (let i = 0; i < 10; i++) t.record('a.more');
  await t.close();
  const ev = read(dir, '2026-10-30');
  assert.equal(ev.filter((e) => e.step === 'telemetry.capped').length, 1);
  assert.ok(!ev.some((e) => e.step === 'a.more'));
  assert.ok(fs.statSync(path.join(dir, '2026-10-30.jsonl')).size < 2000 + 600);
  assert.ok(t.stats.capped >= 10);
}

// queue cap: oldest dropped, counted
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false, queueCap: 10, flushAt: 1e9 });
  for (let i = 0; i < 25; i++) t.record('a.burst', { attrs: { i } });
  assert.equal(t.pending, 10);
  await t.close();
  const ev = read(dir, '2026-10-30');
  assert.deepEqual(ev.filter((e) => e.step === 'a.burst').map((e) => e.attrs.i), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(ev.find((e) => e.step === 'telemetry.dropped').attrs, { count: 15, reason: 'queue_full' });
}

// flushAt triggers a write without waiting for the timer
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false, flushAt: 5 });
  for (let i = 0; i < 5; i++) t.record('a.x');
  await new Promise((r) => setImmediate(r));
  await t.flush();
  assert.equal(read(dir, '2026-10-30').length, 5);
  await t.close();
}

// off: nothing queued, nothing written
{
  const dir = freshDir();
  const t = createTelemetry({ dir, now: () => T0, timer: false, enabled: false });
  t.end(t.start('a.x')); t.record('a.y'); t.ingest([{ ts: T0, step_id: 'f'.repeat(16), kind: 'event', step: 'ui.x', component: 'webview' }]);
  assert.equal(t.pending, 0);
  await t.close();
  assert.equal(fs.existsSync(dir), false);
  const t2 = createTelemetry({ dir, now: () => T0, timer: false });
  t2.record('a.x');
  t2.setEnabled(false);
  assert.equal(t2.pending, 0, 'turning off drops what was queued');
  await t2.close();
  assert.equal(fs.existsSync(dir), false);
}

// write failure never throws and is counted; the next good write records the loss
{
  const dir = freshDir();
  let fail = true;
  const badFs = {
    ...fsp,
    mkdir: (...a) => (fail ? Promise.reject(new Error('EACCES')) : fsp.mkdir(...a)),
    appendFile: (...a) => (fail ? Promise.reject(new Error('ENOSPC')) : fsp.appendFile(...a)),
    readdir: () => Promise.reject(new Error('EIO')),
    stat: () => Promise.reject(new Error('EIO')),
  };
  const t = createTelemetry({ dir, now: () => T0, fs: badFs, timer: false });
  t.record('a.x'); t.end(t.start('a.y'));
  await t.flush();
  assert.equal(t.stats.written, 0);
  assert.ok(t.stats.failures >= 1);
  assert.equal(t.stats.dropped, 3);
  fail = false;
  t.record('a.z');
  await t.close();
  const ev = read(dir, '2026-10-30');
  assert.deepEqual(ev.map((e) => e.step).sort(), ['a.z', 'telemetry.dropped']);
  assert.deepEqual(ev.find((e) => e.step === 'telemetry.dropped').attrs, { count: 3, reason: 'write_failed' });
  // a sync-throwing fs is also contained
  const boom = () => { throw new Error('boom'); };
  const t3 = createTelemetry({ dir, now: () => T0, timer: false, fs: { mkdir: boom, appendFile: boom, readdir: boom, stat: boom, unlink: boom } });
  t3.record('a.x');
  await t3.close();
  assert.equal(t3.stats.written, 0);
}

// overhead: start+end on the hot path (the write is batched off it) stays well under 1 ms at p95
{
  const t = createTelemetry({ dir: path.join(TMP, 'overhead'), timer: false, queueCap: 100000, flushAt: 1e9 });
  const times = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now();
    t.end(t.start('a.overhead', { requestId: newRequestId() }), { attrs: { n: i } });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`sidecar telemetry start+end p95: ${p95.toFixed(4)} ms`);
  assert.ok(p95 < 1, `p95 ${p95} ms`);
  t.setEnabled(false);
}

assert.equal(DEFAULTS.keepDays, 14);
console.log('telemetry tests passed');
