// Pointing benchmark: its scoring and summary, and that every fixture is well formed (the model run itself is not in CI).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, MODE_FLAGS, loadFixtures, percentile, summarize, table } from '../bench/pointing.bench.mjs';

assert.equal(percentile([], 50), null);
assert.equal(percentile([30, 10, 20], 50), 20);
assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
assert.equal(percentile([5, NaN, 1], 50), 1);

const truth = [100, 100, 40, 20];
const s = summarize([
  { mode: 'raw', truth, rect: [100, 100, 40, 20], ms: 1000, path: 'box' }, // exact
  { mode: 'raw', truth, rect: [90, 95, 80, 40], ms: 3000, path: 'box' }, // centre in, IoU 0.25
  { mode: 'raw', truth, rect: null, ms: null, path: null }, // never pointed
  { mode: 'marks', truth, rect: [100, 100, 40, 20], ms: 1500, path: 'mark' },
]);
assert.deepEqual(s.raw, { n: 3, center: 0.667, iou50: 0.333, paths: { box: 2, none: 1 }, p50: 1000, p95: 3000 });
assert.deepEqual(s.marks, { n: 1, center: 1, iou50: 1, paths: { mark: 1 }, p50: 1500, p95: 1500 });
const t = table(s).split('\n');
assert.equal(t.length, 4);
assert.match(t[1], /^\|( --- \|)+$/);
assert.match(t[2], /^\| raw \| 3 \| 67% \| 33% \| 1000 \| 3000 \| box 2, none 1 \|$/);

// Each mode switches exactly the two pointing paths.
assert.deepEqual(MODES, Object.keys(MODE_FLAGS));
for (const m of MODES) assert.deepEqual(Object.keys(MODE_FLAGS[m]).sort(), ['marks', 'refine']);

// Fixtures: 6–10 windows, every truth on its window, and the ui reply is for that window.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pointing');
const fixtures = loadFixtures(dir);
assert.ok(fixtures.length >= 6 && fixtures.length <= 10, `${fixtures.length} fixtures`);
for (const f of fixtures) {
  const [x, y, w, h] = f.ui.shot.bounds;
  assert.deepEqual(f.ui.window.bounds, f.ui.shot.bounds, f.name);
  assert.equal(f.ui.shot.native.length, 2, f.name);
  for (const c of f.cases) {
    assert.ok(c.ask && c.truth.length === 4, `${f.name}: ${c.ask}`);
    const [tx, ty, tw, th] = c.truth;
    assert.ok(tw > 0 && th > 0 && tx >= x && ty >= y && tx + tw <= x + w && ty + th <= y + h, `${f.name}: ${c.ask} truth off the window`);
  }
}
console.log('pointing bench tests: passed');
