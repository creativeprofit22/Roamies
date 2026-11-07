// The LED version of a screenshot is coloured pixel by pixel once; the screenshot animation, the photo flying home and
// any other size or crop reuse it (redoing it every frame made screenshots jittery). Runs the browser-side tool code
// with a fake canvas. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let pixelPasses = 0;
const fakeCtx = () => new Proxy({}, {
  get: (_, k) => k === 'getImageData' ? (x, y, w, h) => { pixelPasses++; return { data: new Uint8ClampedArray(w * h * 4) }; }
    : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'measureText' ? () => ({ width: 40 }) : () => {},
  set: () => true,
});
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), lerp = (a, b, u) => a + (b - a) * u;
const window = { Roamie: { clamp, lerp }, devicePixelRatio: 2 };
const document = { createElement: () => ({ getContext: fakeCtx }) };
vm.runInNewContext(fs.readFileSync(new URL('../../../roamies/agent-tools.js', import.meta.url), 'utf8'), { window, document, Math, Map, WeakMap, Uint8ClampedArray });

const R = window.Roamie, T = R.agentTools.screenshot, L = 6;
const c = {
  P: 5, R: 70, W: 1600, H: 1000, bx: 300, by: 700, L, PAL: Array.from({ length: L + 1 }, (_, i) => [i * 40, i * 40, i * 40]),
  S() {}, sq: { kick() {} }, spawn() {}, put() {}, disc() {}, look() {}, th: () => 0.5, css: () => '#000', now: 0,
};
const image = { complete: true, naturalWidth: 2000, naturalHeight: 1400 };
const st = { d: {}, age: 0, variant: 'window', seed: 1, target: [400, 120, 1400, 820], image, finish() { st.done = true; } };
T.start(st, c);
for (let i = 0; i < 600 && !st.done; i++) { st.age += 1 / 60; T.update(st, c, 1 / 60); T.over(st, c, fakeCtx()); }
assert.ok(st.done, 'screenshot performance finished');
assert.equal(pixelPasses, 1, 'screenshot animation colours the picture once');

// Panning a live window view: a new crop every frame, still no new pixel pass.
for (let i = 0; i < 60; i++) assert.ok(R.ledImage(image, [i * 7, i * 3, 900 - i, 600 - i], 300, 200, c));
assert.ok(R.ledTint(image, c));
assert.equal(pixelPasses, 1, 'new crops and sizes reuse the coloured picture');
console.log('screenshot frame tests: passed');
