// The webview telemetry module's measure(): a performance.mark pair becomes one start/end step with the request id
// and the measured duration; nothing is sent when telemetry is off. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'roamies', 'telemetry.js'), 'utf8');
const sent = [];
const timers = [];
const window = { __TAURI__: { core: { invoke: async (cmd, { msg }) => { sent.push(...msg.events); } } } };
const ctx = vm.createContext({ window, performance, crypto, Date, Math, Array, Uint8Array, setTimeout: (f) => { timers.push(f); return timers.length; }, addEventListener: () => {} });
vm.runInContext(src, ctx);
const tel = window.RoamiesTelemetry;
const flush = () => { while (timers.length) timers.shift()(); };
const rid = '12'.repeat(16);

performance.mark('recv');
const t = performance.now(); while (performance.now() - t < 5);
performance.mark('painted');
tel.measure('ui.reply_paint', 'recv', 'painted', { requestId: rid });
flush();
assert.equal(sent.length, 2);
const [start, end] = sent;
assert.deepEqual([start.kind, end.kind], ['start', 'end']);
assert.equal(start.step, 'ui.reply_paint');
assert.equal(end.request_id, rid);
assert.equal(start.step_id, end.step_id);
assert.equal(end.component, 'webview');
assert.equal(end.outcome, 'ok');
assert.ok(end.duration_ms >= 4 && end.duration_ms < 1000, `duration ${end.duration_ms}`);
assert.ok(Math.abs(end.ts - start.ts - end.duration_ms) <= 1);
assert.equal(performance.getEntriesByName('recv').length, 0, 'marks cleared');

tel.measure('ui.reply_paint', 'nope', 'missing', { requestId: rid });
flush();
assert.equal(sent.length, 2, 'missing marks send nothing');

sent.length = 0;
tel.setEnabled(false);
performance.mark('a'); performance.mark('b');
tel.measure('ui.reply_paint', 'a', 'b', { requestId: rid });
flush();
assert.equal(sent.length, 0, 'nothing sent when off');
assert.equal(performance.getEntriesByName('a').length, 0, 'marks cleared when off too');
console.log('webview telemetry tests passed');
