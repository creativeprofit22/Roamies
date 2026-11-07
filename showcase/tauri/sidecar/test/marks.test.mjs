// Pen marks drawn while talking → words for the model. Run: npm test
import assert from 'node:assert/strict';
import { describeMarks, placeOf, shapeOf } from '../marks.mjs';

const ring = (cx, cy, r, n = 40, turn = 1.05) => Array.from({ length: n }, (_, i) => {
  const a = (i / (n - 1)) * Math.PI * 2 * turn;
  return [Math.round(cx + r * Math.cos(a)), Math.round(cy + r * 0.7 * Math.sin(a))];
});
const line = (x0, y0, x1, y1, n = 20) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);
const zigzag = (x, y) => Array.from({ length: 24 }, (_, i) => [x + (i % 2 ? 60 : 0), y + i * 2]);

assert.equal(shapeOf(ring(400, 300, 80)), 'circle', 'a loop is a circle');
assert.equal(shapeOf(ring(400, 300, 80, 40, 0.92)), 'circle', 'a loop that stops a little short is still a circle');
assert.equal(shapeOf(line(100, 500, 400, 506)), 'underline', 'flat and straight is an underline');
assert.equal(shapeOf(line(100, 100, 300, 400)), 'line', 'straight and steep is a line');
assert.equal(shapeOf(zigzag(200, 200)), 'scribble', 'back and forth is a scribble');
assert.equal(shapeOf([[10, 10], [12, 11], [13, 13]]), 'dot', 'a click is a dot');
assert.equal(shapeOf([]), null);

const rect = [0, 0, 900, 600];
assert.equal(placeOf([450, 300], rect), 'the middle');
assert.equal(placeOf([50, 40], rect), 'the top left');
assert.equal(placeOf([880, 300], rect), 'the right');
assert.equal(placeOf([450, 590], rect), 'the bottom');
assert.equal(placeOf([-20, 900], rect), 'the bottom left', 'points outside the area clamp to its edge');

assert.equal(describeMarks([ring(450, 300, 80)], rect), "My pen marks are drawn on it in teal: I circled something at the middle. That's what I mean.");
assert.equal(
  describeMarks([ring(450, 300, 80), line(300, 560, 600, 562), line(100, 100, 800, 500)], rect),
  "My pen marks are drawn on it in teal: I circled something at the middle, underlined something at the bottom, then drew a line from the top left to the bottom right. That's what I mean.",
);
assert.equal(describeMarks([], rect), '');
assert.equal(describeMarks(undefined, rect), '');
console.log('pen mark tests: passed');
