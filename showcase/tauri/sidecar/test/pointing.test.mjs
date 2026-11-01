// Screenshot pixels → screen points for point_at / click_at. Run: npm test
import assert from 'node:assert/strict';
import { shotMap, toScreen, parseSipsSize } from '../pointing.mjs';

// Regression: an 1800×1066 pt Brave window at (0, 39) is captured at 3600×2132 px and sent at Claude's size.
// Image pixels used to be treated as points, so points landed up and left of the target.
const { resizedSize } = await import('../pointing.mjs');
const braveSent = resizedSize(3600, 2132);
assert.deepEqual(braveSent, [1419, 840]);
const brave = shotMap([0, 39, 1800, 1066], ...braveSent);
assert.deepEqual(toScreen(brave, 900, 431), [1142, 586], 'scales up and adds the window origin');
assert.deepEqual(toScreen(brave, 0, 0), [0, 39], 'image corner is the window corner');
assert.deepEqual(toScreen(brave, 1419, 840), [1800, 1105], 'far corner is the far window corner');

// A small window isn't capped, so its Retina image is twice its size in points.
const small = shotMap([400, 300, 700, 500], 1400, 1000);
assert.deepEqual(toScreen(small, 700, 500), [750, 550], 'Retina 2x maps back to points');

assert.deepEqual(parseSipsSize('/tmp/a.jpg\n  pixelWidth: 1568\n  pixelHeight: 929\n'), [1568, 929]);
assert.equal(parseSipsSize('garbage'), null);
console.log('screenshot coordinate tests: passed');

// Regression: after navigating, id 70 was a pinned post instead of SETTINGS, so Sidekick pointed at the wrong thing.
{
  const { rematch, sameBounds } = await import('../pointing.mjs');
  const read = [
    { id: 69, role: 'link', label: 'Members', bounds: [1100, 560, 80, 20] },
    { id: 70, role: 'button', label: 'SETTINGS', bounds: [1060, 620, 230, 40] },
  ];
  const settings = read[1];
  const after = [
    { id: 70, role: 'link', label: '👾 Join our Discord here (a must)', bounds: [300, 400, 500, 30] },
    { id: 71, role: 'button', label: 'SETTINGS', bounds: [1060, 700, 230, 40] },
  ];
  const fresh = Array.from({ length: 69 }, (_, i) => ({ id: i + 1, role: 'link', label: `x${i}`, bounds: [0, 0, 1, 1] })).concat(after);
  assert.equal(rematch(settings, fresh, 70)?.id, 71, 'finds SETTINGS at its new id');
  const unchanged = Array.from({ length: 68 }, (_, i) => ({ id: i + 1, role: 'link', label: `x${i}`, bounds: [0, 0, 1, 1] })).concat(read);
  assert.equal(rematch(settings, unchanged, 70)?.label, 'SETTINGS', 'same page keeps the id');
  assert.equal(rematch(settings, fresh.filter((c) => c.label !== 'SETTINGS'), 70), null, 'gone from the page: refuse');
  assert.equal(rematch({ role: 'button', label: '', bounds: [0, 0, 1, 1] }, fresh, 70), null, 'unlabelled and changed: refuse');
  assert.equal(rematch(undefined, fresh, 70), null, 'id never read: refuse');
  // Two SETTINGS buttons: take the one nearest where it was.
  const two = [{ id: 1, role: 'button', label: 'SETTINGS', bounds: [10, 10, 50, 20] }, { id: 2, role: 'button', label: 'SETTINGS', bounds: [1070, 640, 230, 40] }];
  assert.equal(rematch(settings, two, 70)?.id, 2, 'nearest match wins');
  assert.ok(sameBounds([0, 39, 1800, 1066], [0, 40, 1800, 1066]) && !sameBounds([0, 39, 1800, 1066], [200, 39, 1800, 1066]));
  console.log('stale control id tests: passed');
}

// Regression: after switching pages or apps, Sidekick pointed using what it saw for the previous request.
{
  const { shotProblem, readProblem } = await import('../pointing.mjs');
  assert.match(shotProblem(null, 3), /Take a screenshot first/);
  assert.equal(shotProblem({ turn: 3 }, 3), null, 'a screenshot from this request is fine');
  assert.match(shotProblem({ turn: 2 }, 3), /before the user's latest message/, 'a screenshot from the last request is refused');
  assert.match(shotProblem({ turn: 3, used: true }, 3), /clicked or opened since/, 'a screenshot taken before a click is refused');
  assert.equal(readProblem({ win: 7, turn: 3 }, 7, 3), null, 'this window, this request');
  assert.match(readProblem({ win: 7, turn: 2 }, 7, 3), /before the user's latest message/, 'last request: read again');
  assert.match(readProblem({ win: 7, turn: 3 }, 9, 3), /read_window on this window first/, 'another window: read it first');
  assert.match(readProblem(null, 9, 3), /read_window on this window first/);
  console.log('freshness tests: passed');
}

// Claude's resize rule (Anthropic "Coordinates and bounding boxes" doc) and which tier each model is on.
{
  const { resizedSize, roundTiesToEven, imageLimits } = await import('../pointing.mjs');
  assert.deepEqual(resizedSize(1920, 1080), [1456, 819], 'token limit, not the 1568 edge, sets a screenshot size');
  assert.deepEqual(resizedSize(1075, 1520), [924, 1307], 'token limit resizes even when both sides are under 1568');
  assert.deepEqual(resizedSize(1000, 1000), [1000, 1000], 'fits: unchanged');
  assert.deepEqual(resizedSize(2000, 1500), [1270, 952], '952.5 rounds to even (952); rounding up to 953 would not fit');
  assert.deepEqual(resizedSize(1920, 1080, 2576, 4784), [1920, 1080], 'high tier keeps 1080p');
  assert.deepEqual(resizedSize(3840, 2160, 2576, 4784), [2576, 1449], 'high tier: edge limit');
  assert.deepEqual(resizedSize(1075, 1520, 2576, 4784), [1075, 1520], 'high tier keeps the A4 scan');
  assert.deepEqual(resizedSize(3600, 2132, 1568, Infinity), [1568, 929], 'no token limit = the old 1568 cap');
  assert.equal(roundTiesToEven(2.5), 2); assert.equal(roundTiesToEven(3.5), 4); assert.equal(roundTiesToEven(3.4), 3);
  const std = { maxEdge: 1568, maxTokens: 1568 }, high = { maxEdge: 2576, maxTokens: 4784 };
  assert.deepEqual(imageLimits('claude-haiku-4-5-20251001'), std, 'the date is not a minor version');
  assert.deepEqual(imageLimits('claude-sonnet-4-6'), std);
  assert.deepEqual(imageLimits('claude-opus-4-20250514'), std);
  assert.deepEqual(imageLimits('claude-3-5-sonnet-20241022'), std, 'old id form');
  assert.deepEqual(imageLimits('claude-opus-4-7'), high);
  assert.deepEqual(imageLimits('claude-haiku-5-5'), high);
  assert.deepEqual(imageLimits('claude-fable-5-1'), high);
  assert.deepEqual(imageLimits('claude-mythos-preview'), std, 'no version: standard is safe on both tiers');
  assert.deepEqual(imageLimits('gpt-6-luna'), { maxEdge: 1568, maxTokens: Infinity }, 'other providers: long-side cap only');
  console.log('resize rule tests: passed');
}

// Points and boxes from the model are checked against the screenshot and clamped onto it.
{
  const { shotMap, shotPixel, shotBox } = await import('../pointing.mjs');
  const map = shotMap([0, 39, 1920, 1080], 1456, 819);
  assert.deepEqual(shotPixel(map, 1460, -3), [1920, 39], 'a hair outside is clamped to the edge');
  assert.throws(() => shotPixel(map, 500, 900), /1456×819/, 'below the image');
  assert.throws(() => shotPixel(map, NaN, 3), /1456×819/);
  assert.deepEqual(shotBox(map, [728, 410, 0, 0]), [0, 39, 960, 541], 'corners in any order');
  assert.deepEqual(shotBox(map, [-2, -2, 1458, 821]), [0, 39, 1920, 1080], 'slight overshoot clamped');
  assert.throws(() => shotBox(map, [0, 0, 1000, 1000 * 2]), /1456×819/, 'far outside (a 0–1000 guess)');
  assert.throws(() => shotBox(map, [1, 2, 3]), /1456×819/, 'three numbers');
  assert.throws(() => shotBox(map, [1, 2, NaN, 4]), /1456×819/, 'not a number');
  assert.throws(() => shotBox(map, [10, 10, 10, 50]), /no area.*1456×819/, 'zero width');
  console.log('point and box validation tests: passed');
}

// Fixture: a 1920×1080 pt Retina window at (0, 39), captured at 3840×2160 and sent at Claude's size.
// A model answering in the sent image's pixels (rounded) lands within 2 pt of a known target.
{
  const { shotMap, toScreen, shotBox, resizedSize } = await import('../pointing.mjs');
  const win = [0, 39, 1920, 1080], sent = resizedSize(3840, 2160);
  const map = shotMap(win, ...sent);
  // What the model sees: a screen point projected into the image Claude processes.
  const seen = ([sx, sy], [w, h]) => [Math.round((sx - win[0]) * w / win[2]), Math.round((sy - win[1]) * h / win[3])];
  for (const target of [[1503, 102], [12, 1100], [960, 600], [1900, 50]]) {
    const [x, y] = toScreen(map, ...seen(target, sent));
    assert.ok(Math.abs(x - target[0]) <= 2 && Math.abs(y - target[1]) <= 2, `lands on ${target}: got ${x}, ${y}`);
  }
  const button = [1400, 80, 120, 40]; // screen rect
  const [bx1, by1] = seen([button[0], button[1]], sent), [bx2, by2] = seen([button[0] + button[2], button[1] + button[3]], sent);
  const r = shotBox(map, [bx1, by1, bx2, by2]);
  r.forEach((v, i) => assert.ok(Math.abs(v - button[i]) <= 2, `button rect ${r} vs ${button}`));
  // The old 1568 px cap: we divided by 1568×882 but Claude looked at 1456×819, so the same target misses.
  const old = shotMap(win, 1568, 882);
  const [ox, oy] = toScreen(old, ...seen([1503, 102], sent));
  assert.ok(Math.abs(ox - 1503) > 2, `old cap misses: ${ox}, ${oy}`);
  console.log('pointing fixture tests: passed');
}

{
  const { parseWinShot } = await import('../pointing.mjs');
  assert.deepEqual(parseWinShot('size 2560 1440\r\n'), { size: [2560, 1440], sent: null });
  assert.deepEqual(parseWinShot('sent 1456 819\r\n'), { size: null, sent: [1456, 819] });
  assert.deepEqual(parseWinShot(''), { size: null, sent: null });
  console.log('windows capture output tests: passed');
}
