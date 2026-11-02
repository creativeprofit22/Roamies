// Screenshots reach the model resized (Retina pixels, then capped), so its x/y are image pixels, not screen points.
export function shotMap([x, y, w, h], imgW, imgH) {
  return { origin: [x, y], sx: w / imgW, sy: h / imgH, size: [imgW, imgH] };
}

export function toScreen(map, x, y) {
  return [Math.round(map.origin[0] + x * map.sx), Math.round(map.origin[1] + y * map.sy)];
}

export function parseSipsSize(out) {
  const w = +/pixelWidth:\s*(\d+)/.exec(out)?.[1], h = +/pixelHeight:\s*(\d+)/.exec(out)?.[1];
  return w > 0 && h > 0 ? [w, h] : null;
}

export const sameBounds = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1);

const same = (a, b) => a.role === b.role && (a.label ?? '').trim() === (b.label ?? '').trim();

// read_window ids are list positions, so after the page changes the same id can be another control.
// expected: what read_window listed at that id; fresh: the window's controls now. Returns the live control or null.
export function rematch(expected, fresh, id) {
  if (!expected) return null;
  const now = fresh[id - 1];
  if (now && same(expected, now)) return now;
  if (!(expected.label ?? '').trim()) return null; // nothing to recognise it by
  const [ex, ey] = expected.bounds ?? [0, 0];
  const hits = fresh.filter((c) => same(expected, c));
  hits.sort((a, b) => Math.hypot(a.bounds[0] - ex, a.bounds[1] - ey) - Math.hypot(b.bounds[0] - ex, b.bounds[1] - ey));
  return hits[0] ?? null;
}

const OLD_LOOK = "That's from before the user's latest message, and the screen may have changed since (another page, tab or app). Look again first.";

/** Why a screenshot can't be used to point any more, or null if it still can. */
export function shotProblem(shot, turn) {
  if (!shot) return 'Take a screenshot first, then give x, y in its pixels.';
  if (shot.turn !== turn) return `The screenshot: ${OLD_LOOK}`;
  if (shot.used) return 'Something was clicked or opened since that screenshot, so it may be out of date. Take a new screenshot.';
  return null;
}

/** Why a read_window list can't be used for this window any more, or null if it still can. */
export function readProblem(read, windowId, turn) {
  if (!read || read.win !== windowId) return 'Call read_window on this window first, then use its ids.';
  if (read.turn !== turn) return `The read_window list: ${OLD_LOOK}`;
  return null;
}

// Anthropic's resize rule ("Coordinates and bounding boxes" doc, reference TypeScript port): the largest
// aspect-preserving size within an edge limit and a visual-token budget of 28×28 px patches.
// Sending exactly this size means the model's pixel coordinates map 1:1 onto the image we sent.
export function roundTiesToEven(v) {
  const f = Math.floor(v);
  if (v - f !== 0.5) return Math.round(v);
  return f % 2 === 0 ? f : f + 1;
}

export function resizedSize(width, height, maxEdge = 1568, maxTokens = 1568) {
  const fits = (w, h) => Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && Math.ceil(w / 28) * Math.ceil(h / 28) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) { const [h, w] = resizedSize(height, width, maxEdge, maxTokens); return [w, h]; }
  const aspect = width / height;
  let lo = 1, hi = width; // lo always fits; hi never fits
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspect), 1))) lo = mid; else hi = mid;
  }
  return [lo, Math.max(roundTiesToEven(lo / aspect), 1)];
}

const STANDARD = { maxEdge: 1568, maxTokens: 1568 }, HIGH = { maxEdge: 2576, maxTokens: 4784 };
// Anthropic's Vision doc: Claude 4.7 and later use the high-resolution tier, everything else the standard one.
// Unknown Claude ids get standard: a standard-size image is never resized by the high tier, so it stays 1:1.
// Other providers publish no such rule, so they keep the plain 1568 px long-side cap with no token limit.
export function imageLimits(model) {
  const id = String(model ?? '').toLowerCase();
  if (!id.includes('claude')) return { maxEdge: 1568, maxTokens: Infinity };
  // claude-<family>-<major>[-<minor>] or the old claude-<major>-<minor>-<family>; 8-digit dates aren't a minor.
  const m = /claude-(?:[a-z]+-)?(\d{1,2})(?:[-.](\d{1,2}))?(?=$|[-.:@/_])/.exec(id);
  if (!m) return STANDARD;
  const major = +m[1], minor = +(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7) ? HIGH : STANDARD;
}

// A model answer may sit a hair outside the image (an edge pixel); farther than this is a wrong guess.
const slack = (side) => Math.max(4, side * 0.02);
const outside = ([w, h]) => `must be inside the ${w}×${h} screenshot (0–${w}, 0–${h}), in its pixels, not a 0–1000 scale`;
function clampAxis(v, side, size) {
  if (v < -slack(side) || v > side + slack(side)) throw new Error(`x, y ${outside(size)}.`);
  return Math.min(side, Math.max(0, v));
}

/** Screenshot pixel → screen point, refusing values that aren't on the screenshot. */
export function shotPixel(map, x, y) {
  const size = map.size;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`x and y must be numbers; they ${outside(size)}.`);
  return toScreen(map, clampAxis(x, size[0], size), clampAxis(y, size[1], size));
}

/** Box [x1, y1, x2, y2] in screenshot pixels → screen rect [x, y, w, h] (the overlay's format). */
export function shotBox(map, box) {
  const size = map.size;
  const bad = `box must be [x1, y1, x2, y2] (top-left and bottom-right corners) and ${outside(size)}.`;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error(bad);
  const [x1, x2] = [box[0], box[2]].sort((a, b) => a - b), [y1, y2] = [box[1], box[3]].sort((a, b) => a - b);
  let a, b;
  try {
    a = [clampAxis(x1, size[0], size), clampAxis(y1, size[1], size)];
    b = [clampAxis(x2, size[0], size), clampAxis(y2, size[1], size)];
  } catch { throw new Error(bad); }
  if (a[0] === b[0] || a[1] === b[1]) throw new Error(`That box has no area. ${bad}`);
  const [sx1, sy1] = toScreen(map, ...a), [sx2, sy2] = toScreen(map, ...b);
  return [sx1, sy1, Math.max(1, sx2 - sx1), Math.max(1, sy2 - sy1)];
}

// The Windows capture script prints "size W H" (the screen, when it isn't what we sized for) or "sent w h".
export function parseWinShot(stdout) {
  const get = (k) => { const m = new RegExp(String.raw`^${k} (\d+) (\d+)\s*$`, 'm').exec(String(stdout ?? '')); return m ? [+m[1], +m[2]] : null; };
  return { size: get('size'), sent: get('sent') };
}

// Which helper monitor ({bounds:[x,y,w,h]}) holds a rect: the one containing its centre, else the largest overlap,
// else the nearest. Returns the index into monitors, or -1 when there are none.
export function monitorFor(monitors, [x, y, w, h]) {
  const list = Array.isArray(monitors) ? monitors : [];
  if (!list.length) return -1;
  const cx = x + w / 2, cy = y + h / 2;
  const b = (m) => m?.bounds ?? [0, 0, 0, 0];
  const inside = list.findIndex((m) => { const [mx, my, mw, mh] = b(m); return cx >= mx && cx < mx + mw && cy >= my && cy < my + mh; });
  if (inside >= 0) return inside;
  const overlap = (m) => { const [mx, my, mw, mh] = b(m); return Math.max(0, Math.min(x + w, mx + mw) - Math.max(x, mx)) * Math.max(0, Math.min(y + h, my + mh) - Math.max(y, my)); };
  const gap = (m) => { const [mx, my, mw, mh] = b(m); return Math.hypot(Math.max(mx - cx, 0, cx - (mx + mw)), Math.max(my - cy, 0, cy - (my + mh))); };
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    const o = overlap(list[i]) - overlap(list[best]);
    if (o > 0 || (o === 0 && overlap(list[best]) === 0 && gap(list[i]) < gap(list[best]))) best = i;
  }
  return best;
}
