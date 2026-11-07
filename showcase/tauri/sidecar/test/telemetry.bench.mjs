// Telemetry overhead: p95 of one start+end pair on the calling thread, and heap/RSS growth while
// 20 000 pairs are queued and written to a temp dir. Run: npm run bench:telemetry
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, newRequestId } from '../telemetry.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-telemetry-bench-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const N = Number(process.env.N) || 20000;
const t = createTelemetry({ dir, version: 'bench' });

// warm up the JIT and the day file
for (let i = 0; i < 5000; i++) {
  t.end(t.start('bench.warm', { requestId: newRequestId() }));
  if (i % 100 === 99) await t.flush();
}
global.gc?.();
const mem0 = process.memoryUsage();

const times = new Float64Array(N);
const rid = newRequestId();
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  t.end(t.start('bench.step', { requestId: rid, attrs: { n: i } }), { attrs: { chars: 42 } });
  times[i] = performance.now() - t0;
  if (i % 100 === 99) await t.flush(); // one 200-event batch at a time, as the app's flush threshold does
}
await t.close();
global.gc?.();
const mem1 = process.memoryUsage();

times.sort();
const p = (q) => times[Math.floor(N * q)];
const mb = (b) => (b / 1e6).toFixed(2);
const heap = mem1.heapUsed - mem0.heapUsed, rss = mem1.rss - mem0.rss;
console.log(`start+end x${N}: p50 ${p(0.5).toFixed(4)} ms, p95 ${p(0.95).toFixed(4)} ms, p99 ${p(0.99).toFixed(4)} ms`);
console.log(`heap delta ${mb(heap)} MB, rss delta ${mb(rss)} MB, written ${t.stats.written}, dropped ${t.stats.dropped}`);
assert.ok(p(0.95) < 1, 'p95 under 1 ms');
assert.equal(t.stats.dropped, 0, 'nothing dropped');
assert.ok(heap < 5e6 && rss < 5e6, 'memory growth under 5 MB');
