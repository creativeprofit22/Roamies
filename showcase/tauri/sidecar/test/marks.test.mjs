// Numbered marks and crop-and-refine (pointing.mjs). Run: npm test
import assert from 'node:assert/strict';
import { pickMarks, markRect, toImage, shotMap, shotBox, refineCrop, needsRefine, scoreBox } from '../pointing.mjs';

// What pickMarks numbers must be the rect markRect hands back.
{
  const shot = [100, 50, 800, 600];
  const controls = [
    { id: 1, role: 'button', label: 'Save', bounds: [700, 60, 80, 30] },
    { id: 2, role: 'button', label: 'Open', bounds: [120, 64, 80, 26] }, // same row, further left: first
    { id: 3, role: 'text', label: 'Body', bounds: [120, 200, 600, 300] },
    { id: 4, role: 'button', label: '', bounds: [121, 201, 600, 299] }, // near-duplicate of 3: dropped
    { id: 5, role: 'button', label: 'Hidden', bounds: [300, 300, 50, 20], offscreen: true },
    { id: 6, role: 'button', label: 'Tiny', bounds: [300, 300, 4, 20] },
    { id: 7, role: 'button', label: 'Outside', bounds: [1000, 300, 50, 20] },
    { id: 8, role: 'link', label: 'Help', bounds: [400, 120, 40, 20] },
  ];
  const marks = pickMarks(controls, shot);
  assert.deepEqual(marks.map((m) => m.label), ['Open', 'Save', 'Help', 'Body'], 'reading order, filtered, deduped');
  assert.deepEqual(marks.map((m) => m.n), [1, 2, 3, 4]);
  for (const m of marks) assert.deepEqual(markRect(marks, m.n), controls.find((c) => c.id === m.id).bounds, `mark ${m.n} ↔ its control`);
  assert.throws(() => markRect(marks, 9), /marks 1–4/);
  assert.throws(() => markRect(marks, 1.5), /marks 1–4/);
  assert.throws(() => markRect([], 1), /no numbered marks/);
  // Named beats unnamed when two rects coincide.
  assert.equal(pickMarks([{ role: 'pane', label: '', bounds: [200, 200, 50, 50] }, { role: 'button', label: 'Go', bounds: [200, 200, 50, 50] }], shot)[0].label, 'Go');
  // Cap: unnamed ones go first.
  const many = Array.from({ length: 80 }, (_, i) => ({ role: 'button', label: i % 2 ? `b${i}` : '', bounds: [110 + (i % 10) * 70, 60 + Math.floor(i / 10) * 60, 60, 40] }));
  const capped = pickMarks(many, shot, { max: 30 });
  assert.equal(capped.length, 30);
  assert.ok(capped.every((m) => m.label), 'cap keeps named controls');
  assert.equal(pickMarks(many, shot, { max: 60 }).length, 60, 'fills up with unnamed ones when there is room');
  assert.deepEqual(pickMarks(undefined, shot), []);
  // toImage inverts toScreen.
  assert.deepEqual(toImage(shotMap(shot, 400, 300), [300, 150, 80, 40]), [100, 50, 40, 20]);
  console.log('mark tests: passed');
}

// Crop margin, clamping, upscale and the crop-offset round trip.
{
  // A 1920×1080 window at (0, 39), sent at 1456×819, recaptured natively at 1920×1080.
  const map = shotMap([0, 39, 1920, 1080], 1456, 819);
  assert.equal(needsRefine(map, [700, 400, 730, 420]), true, 'small box');
  assert.equal(needsRefine(map, [700, 400, 800, 420]), false, 'wide box');
  assert.equal(needsRefine({ ...map, refined: true }, [700, 400, 730, 420]), false, 'never twice');
  assert.equal(needsRefine(map, undefined), false);
  const c = refineCrop(map, [700, 400, 730, 420], [1920, 1080]);
  // 160 sent px per axis (3 × 30 < 160), in native pixels.
  assert.ok(Math.abs(c.srcRect[2] - 160 * 1920 / 1456) <= 2 && Math.abs(c.srcRect[3] - 160 * 1080 / 819) <= 2, `crop size ${c.srcRect}`);
  assert.ok(c.upscale > 1.9 && c.upscale <= 2, `upscaled about 2×: ${c.upscale}`);
  // A bigger box gets 3× its side.
  const wide = refineCrop(map, [600, 400, 670, 420], [1920, 1080]);
  assert.ok(Math.abs(wide.srcRect[2] - 210 * 1920 / 1456) <= 2, `3× side ${wide.srcRect}`);
  // Clamped to the shot at both corners.
  assert.deepEqual(refineCrop(map, [0, 0, 20, 20], [1920, 1080]).srcRect.slice(0, 2), [0, 0]);
  const far = refineCrop(map, [1440, 800, 1456, 819], [1920, 1080]).srcRect;
  assert.ok(far[0] + far[2] <= 1920 && far[1] + far[3] <= 1080, 'stays on the shot');
  // The upscale stays within the model's limits.
  const tight = refineCrop(map, [700, 400, 730, 420], [1920, 1080], { maxEdge: 300, maxTokens: Infinity });
  assert.ok(Math.max(...tight.size) <= 300, `limits: ${tight.size}`);
  // Round trip: the target drawn in the crop's pixels maps back onto the target's screen rect.
  const target = [948, 570, 40, 22];
  const crop = refineCrop(map, [710, 405, 750, 425], [1920, 1080]);
  const cmap = shotMap(crop.screenRect, ...crop.size);
  const [ix, iy, iw, ih] = toImage(cmap, target);
  shotBox(cmap, [ix, iy, ix + iw, iy + ih]).forEach((v, i) => assert.ok(Math.abs(v - target[i]) <= 1, `round trip ${v} vs ${target[i]}`));
  // Retina-style native 2× of a points rect: same round trip.
  const rmap = shotMap([0, 25, 1440, 900], 1456, 910), rcrop = refineCrop(rmap, [100, 100, 130, 120], [2880, 1800]);
  const rc = shotMap(rcrop.screenRect, ...rcrop.size), rt = [110, 120, 20, 12], ri = toImage(rc, rt);
  shotBox(rc, [ri[0], ri[1], ri[0] + ri[2], ri[1] + ri[3]]).forEach((v, i) => assert.ok(Math.abs(v - rt[i]) <= 1, `retina ${v} vs ${rt[i]}`));
  console.log('refine crop tests: passed');
}

{
  assert.deepEqual(scoreBox([0, 0, 10, 10], [0, 0, 10, 10]), { centerIn: true, iou: 1 });
  const s = scoreBox([5, 0, 10, 10], [0, 0, 10, 10]);
  assert.ok(s.centerIn && Math.abs(s.iou - 1 / 3) < 1e-9);
  assert.deepEqual(scoreBox([50, 50, 10, 10], [0, 0, 10, 10]), { centerIn: false, iou: 0 });
  assert.deepEqual(scoreBox(null, [0, 0, 10, 10]), { centerIn: false, iou: 0 });
  console.log('box score tests: passed');
}
