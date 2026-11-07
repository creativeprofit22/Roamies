// Pen marks drawn on screen while talking (⌃⌥ held, macOS): each stroke is read as a circle, an underline, a line,
// a scribble or a dot, and placed in the marked area, so the model hears what was pointed at as well as seeing it.
// Strokes are [[x, y], ...] in global screen points; rect is the captured area [x, y, w, h] in the same points.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 'dot' | 'circle' | 'scribble' | 'underline' | 'line' | 'curve' */
export function shapeOf(pts) {
  if (!pts?.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const diag = Math.hypot(w, h);
  if (diag < 12) return 'dot';
  let len = 0, turns = 0, prev = null;
  for (let i = 1; i < pts.length; i++) {
    len += dist(pts[i - 1], pts[i]);
    const dx = pts[i][0] - pts[i - 1][0];
    if (Math.abs(dx) < 2) continue;
    const dir = Math.sign(dx);
    if (prev !== null && dir !== prev) turns++;
    prev = dir;
  }
  const gap = dist(pts[0], pts[pts.length - 1]);
  if (turns >= 4 && len > 3 * diag) return 'scribble';
  if (gap < 0.35 * diag && len > 1.6 * diag) return 'circle';
  if (len < 1.2 * gap) return h < 0.3 * w ? 'underline' : 'line';
  return 'curve';
}

/** 'the top left', 'the middle', 'the right'… of rect, for a point. */
export function placeOf([x, y], [rx, ry, rw, rh]) {
  const col = ['left', '', 'right'][Math.min(2, Math.max(0, Math.floor(((x - rx) / rw) * 3)))];
  const row = ['top', '', 'bottom'][Math.min(2, Math.max(0, Math.floor(((y - ry) / rh) * 3)))];
  return `the ${[row, col].filter(Boolean).join(' ') || 'middle'}`;
}

const centre = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

/** One sentence for the model about the marks, in drawing order. */
export function describeMarks(strokes, rect) {
  const parts = (strokes ?? []).filter((s) => s?.length).slice(0, 8).map((pts) => {
    const shape = shapeOf(pts), where = placeOf(centre(pts), rect);
    if (shape === 'dot') return `tapped ${where}`;
    if (shape === 'circle') return `circled something at ${where}`;
    if (shape === 'scribble') return `scribbled over something at ${where}`;
    if (shape === 'underline') return `underlined something at ${where}`;
    if (shape === 'line') return `drew a line from ${placeOf(pts[0], rect)} to ${placeOf(pts[pts.length - 1], rect)}`;
    return `drew around ${where}`;
  });
  if (!parts.length) return '';
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
  return `My pen marks are drawn on it in teal: I ${said}. That's what I mean.`;
}
