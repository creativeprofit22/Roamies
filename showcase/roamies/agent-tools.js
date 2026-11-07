// Tool-call performances for the sidekick. Each tool has a pose, pixel props drawn on the LED grid,
// optional effects above everything, and a few variants. The agent layer runs them via agent.tool().
(() => {
  const R = window.Roamie;
  const { clamp, lerp } = R;
  const T = (R.agentTools = {});
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

  // ----- sprite helpers (grid cells) -----
  const box = (c, x0, y0, w, h, fill, edge, round = true) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cornerX = x === 0 || x === w - 1, cornerY = y === 0 || y === h - 1;
      if (round && cornerX && cornerY) continue;
      c.put(x0 + x, y0 + y, cornerX || cornerY ? edge : fill);
    }
  };
  const ring = (c, cx, cy, r, lvl, a0 = 0, a1 = Math.PI * 2) => {
    const n = Math.max(8, Math.ceil(r * 7));
    for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); c.put(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), lvl); }
  };
  const seg = (c, x0, y0, x1, y1, lvl, thick = 1) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(lerp(x0, x1, i / n)), y = Math.round(lerp(y0, y1, i / n));
      c.put(x, y, lvl); if (thick > 1) { c.put(x + 1, y, lvl); c.put(x, y + 1, lvl); }
    }
  };
  // A real picture (a screenshot, a peek at a window) in the Sidekick's own look: its LED colours from dark glass to
  // bright mint, with the dot grid's gaps running through it. Full resolution underneath, so words stay readable.
  // The per-pixel colouring runs once per picture; every size and crop after that is a scaled copy plus the cached
  // dot grid, so animating or panning never redoes pixel work.
  const tints = new WeakMap();
  R.ledTint = (img, c) => {
    if (!img?.complete || !img.naturalWidth) return null;
    const have = tints.get(img);
    if (have?.pal === c.PAL) return have.cv;
    const PAL = c.PAL, L = c.L, W = img.naturalWidth, H = img.naturalHeight, lut = new Uint8ClampedArray(256 * 3);
    for (let n = 0; n < 256; n++) {
      const v = Math.pow(clamp((n / 255 - 0.04) / 0.82, 0, 1), 0.8) * L, a = Math.min(L - 1, Math.floor(v)), f = v - a;
      const c0 = PAL[a], c1 = PAL[Math.min(L, a + 1)];
      for (let q = 0; q < 3; q++) lut[n * 3 + q] = c0[q] + (c1[q] - c0[q]) * f;
    }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, W, H), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) * 3;
      d[i] = lut[n]; d[i + 1] = lut[n + 1]; d[i + 2] = lut[n + 2]; d[i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    tints.set(img, { pal: PAL, cv });
    return cv;
  };
  // The LED grid's dark gaps for a W×H device-pixel area, laid over a tinted picture.
  const gapsCache = new Map();
  R.ledGaps = (W, H, c) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), pitch = c.P * dpr, gap = Math.max(1, Math.round(pitch * 0.22));
    const key = `${W}x${H}:${pitch}`;
    if (gapsCache.has(key)) return gapsCache.get(key);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    // One path, one fill: where a row and a column of gaps cross it's darkened once, not twice.
    g.beginPath();
    for (let k = 0; k * pitch < W; k++) { const x = Math.ceil(k * pitch + pitch - gap); g.rect(x, 0, Math.ceil((k + 1) * pitch) - x, H); }
    for (let k = 0; k * pitch < H; k++) { const y = Math.ceil(k * pitch + pitch - gap); g.rect(0, y, W, Math.ceil((k + 1) * pitch) - y); }
    g.fillStyle = 'rgba(0, 0, 0, 0.58)'; g.fill();
    if (gapsCache.size > 12) gapsCache.delete(gapsCache.keys().next().value);
    gapsCache.set(key, cv);
    return cv;
  };
  // src is the part of the image to use [x, y, w, h]; cached per size.
  const pics = new Map();
  R.ledImage = (img, src, w, h, c) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (!img?.complete || !img.naturalWidth || W < 4 || H < 4) return null;
    if (!img.__ledId) img.__ledId = Math.random().toString(36).slice(2);
    const key = `${img.__ledId}:${src.map(Math.round).join(',')}:${W}x${H}:${c.P}`;
    if (pics.has(key)) return pics.get(key);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(R.ledTint(img, c), src[0], src[1], src[2], src[3], 0, 0, W, H);
    g.drawImage(R.ledGaps(W, H, c), 0, 0);
    if (pics.size > 24) pics.delete(pics.keys().next().value);
    pics.set(key, cv);
    return cv;
  };
  const whole = (img) => [0, 0, img.naturalWidth, img.naturalHeight];

  // Dark silhouette one cell larger than a sprite, so props read against the body.
  const halo = (c, x0, y0, w, h) => { for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) c.put(x0 + x, y0 + y, 0); };
  const check = (c, cx, cy, lvl) => { seg(c, cx - 3, cy, cx - 1, cy + 2, lvl, 2); seg(c, cx - 1, cy + 2, cx + 3, cy - 2, lvl, 2); };
  const cross = (c, cx, cy, lvl) => { seg(c, cx - 2, cy - 2, cx + 2, cy + 2, lvl, 2); seg(c, cx + 2, cy - 2, cx - 2, cy + 2, lvl, 2); };

  // A size in cells, shrunk with the body (c.z); `tight` props (small and cursor forms) use single-cell details.
  const zs = (c, n, min = 1) => Math.max(min, Math.round(n * c.z));
  const tight = (c) => c.z < 0.75;
  const check3 = (c, cx, cy, lvl) => { c.put(cx - 1, cy, lvl); c.put(cx, cy + 1, lvl); c.put(cx + 1, cy, lvl); c.put(cx + 2, cy - 1, lvl); };
  const cross3 = (c, cx, cy, lvl) => { for (const [x, y] of [[-1, -1], [1, 1], [0, 0], [1, -1], [-1, 1]]) c.put(cx + x, cy + y, lvl); };

  const paper = (c, cx, cy, st, opts = {}) => {
    const sm = tight(c);
    const w = opts.w ?? zs(c, 16, 7), h = opts.h ?? zs(c, 20, 9), x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2), L = c.L;
    const appear = opts.appear ?? 1, crumble = opts.crumble ?? 0, F = zs(c, 4, 2);
    const vis = (x, y) => c.th(x, y) < appear && !(crumble && c.th(x * 3 + 1, y * 5) < crumble * 1.2 - (y - y0) / h * 0.3);
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      const gx = x0 + x, gy = y0 + y;
      if (!vis(gx, gy)) continue;
      if (x - (w - F) > y + 1) continue;
      const out = x < 0 || y < 0 || x >= w || y >= h || x - (w - F) === y + 1;
      if (out) { c.put(gx, gy, 0); continue; }
      if (x - (w - F) > y) continue;
      const edge = x === 0 || y === h - 1 || y === 0 || x === w - 1 || x - (w - F) === y;
      c.put(gx, gy, edge ? L - 1 : L);
    }
    for (let y = 0; y < F; y++) for (let x = 0; x <= y; x++) if (vis(x0 + w - F + x, y0 + y)) c.put(x0 + w - F + x, y0 + y, x === y || y === F - 1 ? 1 : L - 2);
    const lines = opts.lines ?? 5, seed = st.seed + (opts.page ?? 0) * 13, top = sm ? 2 : 4, ix = sm ? 1 : 2, band = sm ? [0] : [-1, 0, 1];
    for (let i = 0; i < lines; i++) {
      const ly = y0 + top + i * 2;
      if (ly >= y0 + h - 2) break;
      let len = Math.round((w - ix * 2 - 1) * (0.45 + hash(seed + i) * 0.55));
      if (opts.write != null) len = i < opts.write.line ? len : i === opts.write.line ? Math.round(len * opts.write.u) : 0;
      const hi = opts.hi === i;
      if (hi) for (let x = 1; x < w - 1; x++) for (const yy of band) if (vis(x0 + x, ly + yy)) c.put(x0 + x, ly + yy, L - 2);
      for (let x = 0; x < len; x++) {
        if (!vis(x0 + ix + x, ly)) continue;
        const struck = opts.strike?.includes(i);
        c.put(x0 + ix + x, ly, struck ? L - 2 : hi ? 0 : 1);
      }
      if (opts.strike?.includes(i) && len) for (let x = -1; x <= len; x++) { c.put(x0 + ix + x, ly, 0); }
    }
    return { x0, y0, w, h };
  };

  const camera = (c, cx, cy, st, flash) => {
    const L = c.L;
    halo(c, cx - 10, cy - 6, 21, 14); halo(c, cx - 6, cy - 9, 8, 4);
    box(c, cx - 10, cy - 6, 21, 14, 1, L - 1);
    box(c, cx - 6, cy - 9, 8, 4, L - 1, L - 1, false);
    for (let x = cx - 9; x <= cx + 9; x++) c.put(x, cy - 3, 0);
    for (let x = cx + 4; x <= cx + 8; x++) for (let y = cy - 5; y <= cy - 4; y++) c.put(x, y, flash > 0.2 ? L : 2);
    c.disc(cx, cy + 1, 6, 6, 0);
    c.disc(cx, cy + 1, 5, 5, L);
    c.disc(cx, cy + 1, 4, 4, 0);
    c.disc(cx, cy + 1, 2, 2, 1);
    c.put(cx - 2, cy - 1, L); c.put(cx - 1, cy - 1, L); c.put(cx - 2, cy, L);
    if (Math.sin(c.now * 8) > 0) { c.put(cx - 8, cy - 5, L); c.put(cx - 7, cy - 5, L); }
  };

  const pencil = (c, x, y, ang) => {
    const dx = Math.cos(ang), dy = Math.sin(ang), L = c.L, n = zs(c, 12, 6), wide = !tight(c);
    for (let i = -1; i < n + 1; i++) { const px = Math.round(x - dx * i), py = Math.round(y - dy * i); for (let a = -1; a <= (wide ? 2 : 1); a++) for (let b2 = -1; b2 <= 1; b2++) c.put(px + a, py + b2, 0); }
    for (let i = 0; i < n; i++) {
      const px = Math.round(x - dx * i), py = Math.round(y - dy * i);
      const lvl = i < 2 ? (i === 0 ? 1 : L) : i > n - 2 ? L - 2 : i % 2 ? L - 1 : L;
      c.put(px, py, lvl); if (wide) c.put(px + 1, py, i < 1 ? 0 : lvl);
    }
  };

  const magnifier = (c, cx, cy, r = 4) => {
    const L = c.L, hl = zs(c, 5, 3), t2 = tight(c) ? 1 : 2;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y);
      if (d <= r - 0.6 && c.th(cx + x, cy + y) < 0.25) c.put(cx + x, cy + y, 2);
    }
    ring(c, cx, cy, r + 1.4, 0); ring(c, cx, cy, r - 1, 0);
    ring(c, cx, cy, r, L); ring(c, cx, cy, r + 0.7, L - 1);
    c.put(cx - 2, cy - 2, L); c.put(cx - 1, cy - 2, L);
    seg(c, cx + r, cy + r, cx + r + hl, cy + r + hl, 0, t2); seg(c, cx + r + 1, cy + r, cx + r + hl + 1, cy + r + hl, 0, t2); seg(c, cx + r - 1, cy + r - 1, cx + r + hl - 1, cy + r + hl - 1, L - 1, t2);
  };

  const globe = (c, cx, cy, r, rot) => {
    const L = c.L;
    c.disc(cx, cy, r + 1, r + 1, 0);
    c.disc(cx, cy, r, r, 1);
    for (let y = -r; y <= r; y++) {
      const hw = Math.sqrt(Math.max(0, r * r - y * y));
      for (let k = 0; k < 4; k++) {
        const ph = rot + (k * Math.PI) / 4, s = Math.sin(ph), front = Math.cos(ph) > 0;
        c.put(Math.round(cx + hw * s), cy + y, front ? L - 1 : 2);
      }
      if (y === 0 || Math.abs(y) === Math.round(r / 2)) for (let x = -Math.floor(hw); x <= Math.floor(hw); x++) c.put(cx + x, cy + y, L - 2);
    }
    ring(c, cx, cy, r + 0.4, L - 1);
    c.put(cx - Math.round(r * 0.5), cy - Math.round(r * 0.55), L);
  };

  const terminal = (c, x0, y0, w, h, st, lines, status) => {
    const L = c.L, sm = tight(c), z = c.z, bar = sm ? 1 : 2, top = sm ? 3 : 4, ind = sm ? 1 : 2;
    halo(c, x0, y0, w, h);
    box(c, x0, y0, w, h, 0, L - 1);
    for (let x = 1; x < w - 1; x++) for (let y = 1; y <= bar; y++) c.put(x0 + x, y0 + y, 1);
    (sm ? [2, 4, 6] : [2, 5, 8]).forEach((x, i) => { const l = i === 0 ? L : L - 2; c.put(x0 + x, y0 + 1, l); if (!sm) c.put(x0 + x + 1, y0 + 1, l); });
    const rows = Math.max(1, Math.floor((h - top - 2) / 2));
    const first = Math.max(0, lines.length - rows), room = w - ind - 3;
    const lenOf = (ln) => Math.min(room - (ln.prompt ? 2 : 0), Math.max(ln.len ? 1 : 0, Math.round(ln.len * z)));
    lines.slice(first).forEach((ln, i) => {
      const y = y0 + top + i * 2, tx = x0 + ind + (ln.prompt ? (sm ? 2 : 3) : 0);
      if (ln.prompt) { c.put(x0 + ind, y, L); if (!sm) c.put(x0 + ind + 1, y, L - 1); }
      for (let x = 0; x < lenOf(ln); x++) c.put(tx + x, y, ln.lvl ?? L - 1);
    });
    const last = lines[lines.length - 1];
    if (!status && Math.sin(c.now * 10) > 0) {
      const y = y0 + top + Math.min(rows - 1, lines.length - 1 - first) * 2;
      const x = x0 + ind + (last?.prompt ? (sm ? 2 : 3) : 0) + (last ? lenOf(last) : 0) + 1;
      c.put(x, y, L); if (!sm) c.put(x, y - 1, L);
    }
    if (status) {
      if (sm) { const cx = x0 + w - 4, cy = y0 + h - 4; c.disc(cx, cy, 2, 2, 1); (status === 'ok' ? check3 : cross3)(c, cx, cy, L); }
      else { const cx = x0 + w - 7, cy = y0 + h - 6; c.disc(cx, cy, 5, 5, 1); (status === 'ok' ? check : cross)(c, cx, cy, L); }
    }
  };

  const brackets = (c, x0, y0, x1, y1, lvl, len = 4) => {
    for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      for (let i = 0; i < len; i++) { c.put(x + sx * i, y, lvl); c.put(x, y + sy * i, lvl); c.put(x + sx * i, y + sy, lvl - 1); c.put(x + sx, y + sy * i, lvl - 1); }
    }
  };

  // ----- JARVIS props: HUD panels floating beside the globe, the way Stark's readouts hang in the air. No paper,
  // pencils or dark backing: bracket corners, a faint dot lattice for the glass, light bars for text, a scan line.
  const J = {};
  // A panel's cells beside the body, on the roomier side (kept for the whole call so it doesn't jump).
  J.place = (c, st, w, h, dy = 0) => {
    const side = st.d.side ?? (st.d.side = c.side || (c.mx < c.W * 0.62 ? 1 : -1)), P = c.P;
    const x0 = Math.round((c.mx + side * (c.R * 1.25 + P * 2)) / P) - (side < 0 ? w : 0);
    return { x0, y0: Math.round(c.by / P + dy) - Math.floor(h / 2), w, h, side };
  };
  // Corner brackets that fly out as it opens (u 0..1), and the glass: a sparse dot lattice.
  J.frame = (c, x0, y0, w, h, u = 1, lvl = c.L - 1) => {
    if (u <= 0.02) return;
    const arm = Math.max(1, Math.round(Math.min(w, h) * 0.28 * u));
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x0 + w - 1, y0, -1, 1], [x0, y0 + h - 1, 1, -1], [x0 + w - 1, y0 + h - 1, -1, -1]]) {
      for (let i = 0; i <= arm; i++) { c.put(x + dx * i, y, lvl); c.put(x, y + dy * i, lvl); }
    }
    for (let y = 2; y < h - 2; y += 2) for (let x = 2; x < w - 2; x += 3) if (c.th(x0 + x, y0 + y) < u) c.put(x0 + x, y0 + y, 1);
  };
  // A header strip: a short bright tag, then dashes; a dot runs along it while busy.
  J.header = (c, x0, y, w, busy) => {
    const L = c.L, tag = Math.max(2, Math.round(w * 0.18));
    for (let x = 0; x < tag; x++) c.put(x0 + 2 + x, y, L - 1);
    for (let x = tag + 2; x < w - 4; x++) if (x % 3 !== 2) c.put(x0 + 2 + x, y, 2);
    if (busy) { const n = w - 6 - tag, i = Math.floor(c.now * 14) % Math.max(1, n); c.put(x0 + 4 + tag + i, y, L); }
  };
  // Text as light bars. state(i) gives { len 0..1 of the line drawn, lvl }; returns the rows' y.
  J.bars = (c, x0, y0, w, h, seed, n, state) => {
    const ys = [], room = w - 5;
    for (let i = 0; i < n; i++) {
      const y = y0 + i * 2;
      if (y > y0 + h) break;
      ys.push(y);
      const s = state(i), full = Math.max(2, Math.round(room * (0.4 + hash(seed + i) * 0.6))), len = Math.round(full * (s.len ?? 1));
      for (let x = 0; x < len; x++) c.put(x0 + 2 + x, y, s.dash && x % 2 ? 1 : s.lvl);
      if (s.caret && Math.sin(c.now * 12) > -0.3) { c.put(x0 + 2 + len, y, c.L); c.put(x0 + 2 + len, y - 1, c.L - 1); }
    }
    return ys;
  };
  // Targeting reticle: four ring arcs with gaps, ticks at the diagonals that pull in and brighten on a lock.
  J.reticle = (c, cx, cy, r, spin, lock = 0) => {
    const L = c.L, lv = lock ? L : L - 1, n = Math.max(24, Math.round(r * 9));
    for (let i = 0; i < n; i++) { if ((i * 16 / n + 2) % 4 < 1) continue; const a = (i / n) * Math.PI * 2 + spin; c.put(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), lv); }
    const d0 = r + 2.2 - lock * 1.6;
    for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2 + Math.PI / 4 - spin * 0.4; for (let d = d0; d <= d0 + 1; d += 0.5) c.put(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), lock ? L - 1 : 2); }
    c.put(cx, cy, L);
  };
  // A status mark under a panel's corner: ring and tick, or a cross.
  J.mark = (c, cx, cy, ok) => {
    if (tight(c)) { (ok ? check3 : cross3)(c, cx, cy, c.L); return; }
    ring(c, cx, cy, 3.6, c.L - 1); (ok ? check3 : cross3)(c, cx, cy, c.L);
  };
  J.read = (st, c) => {
    const d = st.d, L = c.L, sm = tight(c);
    if (st.variant === 'search') {
      // Three small panels; the reticle sweeps across them and locks onto the match.
      const pw = zs(c, 9, 6), ph = zs(c, 11, 7), gap = zs(c, 3, 2), all = pw * 3 + gap * 2;
      const g = J.place(c, st, all, ph);
      const u = clamp(st.age / 0.3, 0, 1);
      for (let i = 0; i < 3; i++) {
        const x0 = g.x0 + i * (pw + gap);
        J.frame(c, x0, g.y0, pw, ph, u, d.hit && i === 1 ? L : L - 2);
        J.bars(c, x0 - 1, g.y0 + 2, pw, ph - 4, st.seed + i * 7, 3, (j) => ({ lvl: d.hit && i === 1 && j === 1 ? L : 2 }));
      }
      const sweep = d.hit ? 0 : Math.sin(st.age * 2.6), rx = g.x0 + all / 2 + sweep * (pw + gap), ry = g.y0 + Math.round(ph / 2);
      J.reticle(c, Math.round(rx), ry, zs(c, 4, 3), st.age * 2, d.hit ? 1 : 0);
      return;
    }
    const w = zs(c, 20, 11), h = zs(c, 16, 10), g = J.place(c, st, w, h);
    const flip = d.flip ?? 0, x0 = g.x0 + Math.round(g.side * flip * 4), open = clamp(st.age / 0.3, 0, 1) * (1 - flip * 0.7);
    if (st.variant === 'many') for (let i = Math.min(2, d.pages - d.page - 1); i >= 1; i--) J.frame(c, x0 + i * 2, g.y0 - i * 2, w, h, open, 2);
    J.frame(c, x0, g.y0, w, h, open);
    J.header(c, x0, g.y0 + 1, w, !st.status);
    const top = sm ? 3 : 4, line = d.line ?? 0, u = d.u ?? 0;
    const ys = J.bars(c, x0, g.y0 + top, w, h - top - 2, st.seed + d.page * 13, 6, (i) => ({ lvl: i < line ? L - 2 : i === line ? L : 2 }));
    // The reading head: a bright tick at the edge and a scan line on the line being read.
    const y = ys[Math.min(line, ys.length - 1)];
    if (y != null) { c.put(x0 + 1, y, L); const sx = x0 + 2 + Math.round(u * (w - 5)); c.put(sx, y - 1, L - 1); c.put(sx, y + 1, L - 1); }
    if (st.variant === 'many') for (let i = 0; i < d.pages; i++) for (let k = 0; k < 2; k++) c.put(x0 + i * 3 + k, g.y0 + h + 1, i <= d.page ? L : 1);
  };
  J.write = (st, c) => {
    const d = st.d, L = c.L, sm = tight(c), w = zs(c, 20, 11), h = zs(c, 16, 10), top = sm ? 3 : 4;
    const g = J.place(c, st, w, h), seed = st.seed;
    if (st.variant === 'delete') {
      // Marked lines flash, then the panel folds shut to a line and winks out.
      const k = d.crumble ?? 0, hh = Math.max(1, Math.round(h * (1 - ease(k)))), y0 = g.y0 + Math.floor((h - hh) / 2);
      if (k >= 1) return;
      J.frame(c, g.x0, y0, w, hh, 1, k > 0 ? L : L - 1);
      if (hh > top + 2) J.bars(c, g.x0, y0 + top, w, hh - top - 2, seed, 6, () => ({ lvl: Math.sin(c.now * 18) > 0 ? L : L - 2, dash: k > 0 }));
      else for (let x = 1; x < w - 1; x++) c.put(g.x0 + x, y0, L);
      return;
    }
    // Create: the panel opens from a line; edit and create then fill in line by line behind a blinking caret.
    const open = st.variant === 'create' ? ease(d.appear ?? 0) : clamp(st.age / 0.3, 0, 1);
    const hh = Math.max(1, Math.round(h * open)), y0 = g.y0 + Math.floor((h - hh) / 2);
    J.frame(c, g.x0, y0, w, hh, open);
    if (open < 1) { for (let x = 1; x < w - 1; x++) c.put(g.x0 + x, y0 + Math.floor(hh / 2), L - 1); return; }
    J.header(c, g.x0, g.y0 + 1, w, !st.status);
    const line = d.wline ?? 0, u = d.wu ?? 0, struck = st.variant === 'edit' ? [2, 4] : [];
    J.bars(c, g.x0, g.y0 + top, w, h - top - 2, seed, d.lines, (i) => (
      i < line ? { lvl: struck.includes(i) ? 2 : L - 2, dash: struck.includes(i) } : i === line ? { len: u, lvl: L - 1, caret: !st.status } : { len: 0, lvl: 1 }));
    if (st.status) J.mark(c, g.x0 + w - (sm ? 3 : 5), g.y0 + h - (sm ? 3 : 5), st.status === 'ok');
  };
  J.run = (st, c) => {
    const d = st.d, L = c.L, sm = tight(c), z = c.z, w = zs(c, 26, 14), h = zs(c, 18, 11), top = sm ? 3 : 4;
    const pop = clamp(st.age / 0.18, 0, 1) * (1 - clamp((st.out - 0.4) / 0.4, 0, 1));
    if (pop < 0.3) return;
    const g = J.place(c, st, w, h, -c.R * 0.2 / c.P);
    J.frame(c, g.x0, g.y0, w, h, pop, st.status === 'fail' ? L : L - 1);
    J.header(c, g.x0, g.y0 + 1, w, !st.status);
    const rows = Math.max(1, Math.floor((h - top - (d.bar != null ? 4 : 2)) / 2)), lines = d.lines, first = Math.max(0, lines.length - rows), room = w - 7;
    lines.slice(first).forEach((ln, i) => {
      const y = g.y0 + top + i * 2, n = Math.min(room, Math.round(ln.len * z));
      // A chevron for the command line, light bars for its output.
      if (ln.prompt) { c.put(g.x0 + 2, y - 1, L - 1); c.put(g.x0 + 3, y, L); c.put(g.x0 + 2, y + 1, L - 1); }
      for (let x = 0; x < n; x++) c.put(g.x0 + (ln.prompt ? 5 : 2) + x, y, ln.lvl === 1 ? 2 : ln.lvl ?? L - 1);
      if (!st.status && i + first === lines.length - 1 && Math.sin(c.now * 10) > 0) c.put(g.x0 + (ln.prompt ? 5 : 2) + n + 1, y, L);
    });
    if (d.bar != null) {
      const y = g.y0 + h - 3, bw = w - 4;
      for (let x = 0; x < bw; x++) if (x % 3 !== 2) c.put(g.x0 + 2 + x, y, x < Math.round(bw * d.bar) ? L : 1);
    }
    if (st.status) J.mark(c, g.x0 + w - (sm ? 3 : 5), g.y0 + h - (sm ? 3 : 5), st.status === 'ok');
  };
  // The web: a radar above the globe, its arm sweeping; search pings contacts, fetch sends waves out.
  // Where the radar sits (px): above the globe's shoulder, or just beside a small globe or the reticle.
  J.webAt = (c) => (c.side ? [c.mx + c.side * (c.R * 1.25 + c.P * (3 + zs(c, 8, 4))), c.by] : [c.mx + c.R * 0.95, c.by - c.R * 1.3]);
  J.web = (st, c) => {
    const d = st.d, L = c.L, P = c.P, r = zs(c, 8, 4), at = J.webAt(c);
    const gx = Math.round(at[0] / P), gy = Math.round(at[1] / P), a = st.age * 3.2;
    J.reticle(c, gx, gy, r, st.age * 0.6, 0);
    for (let i = 0; i < r * 2; i++) { const t = a - i * 0.06, k = 1 - i / (r * 2); for (let q = 1; q < r; q++) if (i === 0 || q % 2 === i % 2) c.put(Math.round(gx + Math.cos(t) * q), Math.round(gy + Math.sin(t) * q), i === 0 ? L - 1 : k > 0.6 ? 2 : 1); }
    if (st.variant === 'search') {
      for (let i = 0; i < 4; i++) {
        const ang = hash(st.seed + i) * Math.PI * 2, dist = r * (0.35 + hash(st.seed + i * 3) * 0.5), since = ((a - ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        if (since < 2.2) { const x = Math.round(gx + Math.cos(ang) * dist), y = Math.round(gy + Math.sin(ang) * dist); c.put(x, y, since < 0.8 ? L : L - 2); if (since < 0.5) { c.put(x + 1, y, L - 1); c.put(x - 1, y, L - 1); c.put(x, y + 1, L - 1); c.put(x, y - 1, L - 1); } }
      }
    } else for (let i = 0; i < 3; i++) {
      const rr = r + 2 + ((st.age * 9 * c.z + i * zs(c, 4)) % zs(c, 12, 6));
      const n = Math.round(rr * 4);
      for (let k = 0; k <= n; k++) { if (k % 3 === 2) continue; const t = lerp(-Math.PI * 0.9, -Math.PI * 0.1, k / n); c.put(Math.round(gx + Math.cos(t) * rr), Math.round(gy + Math.sin(t) * rr), rr > r + zs(c, 9, 5) ? 1 : 2); }
    }
  };

  // ===== SCREENSHOT =====  variants: screen | region | window
  // aim:  a dotted laser sight runs from the lens to the target while the corner brackets spring out,
  //       overshoot a touch and lock on; the frame lights up with chasing LEDs and a crosshair.
  // scan: an LED scanline sweeps down the target.
  // snap: flash, a shutter blink across the frame, sparks off the flash bulb.
  // then: the shot shrinks into a little pixel photo that arcs back into the camera.
  // In live mode a window shot waits (brackets breathing around the lens) until the real window is
  // located, then frames exactly that window.
  const SHOT = { aim: 0.62, scan: 0.62, blink: 0.24, eject: 0.3, fly: 0.55 };
  const springTo = (d, tgt, dt, k = 150, damp = 13) => {
    for (let i = 0; i < 4; i++) {
      d.vel[i] += ((tgt[i] - d.cur[i]) * k - d.vel[i] * damp) * dt;
      d.cur[i] += d.vel[i] * dt;
    }
  };
  // Looking at the screen (a screenshot): just the tag under the Roamie while the shot
  // is taken, nothing played over the screen. It stays up at least a moment so it can be read.
  T.look = {
    variants: ['screen', 'window'], label: 'looking at your screen',
    update(st) { if (st.age > 0.5 && !st.status) st.finish(true); },
    pose: () => null, // its usual face and pose: nothing to act out
  };
  T.screenshot = {
    variants: ['screen', 'region', 'window'], label: 'screenshot', sound: 'focus',
    lens(c) { return [c.bx, c.by + c.R * 0.42 + c.P]; },
    guess(st, c) {
      const pad = 14;
      if (st.variant === 'screen') return [pad, pad, c.W - pad, c.H - pad];
      if (st.variant === 'window') { const w = c.W * 0.46, h = c.H * 0.42, x = c.bx < c.W / 2 ? c.W * 0.48 : c.W * 0.06; return [x, c.H * 0.1, x + w, c.H * 0.1 + h]; }
      const w = c.W * 0.28, h = c.H * 0.24, x = c.bx < c.W / 2 ? c.W * 0.62 : c.W * 0.1;
      return [x, c.H * 0.16, x + w, c.H * 0.16 + h];
    },
    beside(st, c) {
      const asp = st.image?.naturalWidth ? clamp(st.image.naturalHeight / st.image.naturalWidth, 0.4, 1.2) : 0.62;
      const w = clamp(c.W * 0.26, 220, 420), h = w * asp, right = c.bx < c.W / 2;
      const x = right ? c.bx + c.R * 1.6 : c.bx - c.R * 1.6 - w, y = clamp(c.by - h / 2, 14, c.H - h - 14);
      return T.screenshot.fit([x, y, x + w, y + h], c);
    },
    // Window rect from the screen → frame it on this overlay (clamped to what's visible here).
    fit(t, c) { const m = 4; return [Math.max(m, t[0]), Math.max(m, t[1]), Math.min(c.W - m, t[2]), Math.min(c.H - m, t[3])]; },
    start(st, c) {
      const d = st.d, [lx, ly] = T.screenshot.lens(c);
      d.cur = [lx - c.R * 0.5, ly - c.R * 0.4, lx + c.R * 0.5, ly + c.R * 0.4];
      d.vel = [0, 0, 0, 0];
      d.rect = st.target ? T.screenshot.fit(st.target, c) : st.live && st.variant === 'window' ? null : T.screenshot.guess(st, c);
      d.searching = !d.rect;
      d.aimAt = d.searching ? Infinity : 0.12;
    },
    retarget(st, c) {
      const d = st.d, r = T.screenshot.fit(st.target, c);
      if (r[2] - r[0] < 20 || r[3] - r[1] < 20) return; // on another display: keep the guess
      d.rect = r;
      if (d.searching) { d.searching = false; d.aimAt = st.age; }
    },
    update(st, c, dt) {
      const d = st.d, a = st.age, [lx, ly] = T.screenshot.lens(c);
      if (d.searching) {
        const p = 0.5 + 0.5 * Math.sin(a * 6), s = c.R * (0.5 + 0.16 * p);
        springTo(d, [lx - s * 1.25, ly - s, lx + s * 1.25, ly + s], dt, 90, 14);
        // Never located (another display, or it closed): frame the shot beside the Sidekick, shaped like the picture,
        // instead of a made-up spot on screen that looks like it shot something random.
        if (a > 4 || (st.image && a > 1.2)) { d.rect = T.screenshot.beside(st, c); d.searching = false; d.aimAt = a; }
        return;
      }
      const t = a - d.aimAt, r = d.rect;
      if (t < 0) return;
      // aim
      if (st.variant === 'region' && t < SHOT.aim) {
        const u = ease(clamp(t / SHOT.aim, 0, 1));
        springTo(d, [r[0], r[1], lerp(r[0] + 10, r[2], u), lerp(r[1] + 10, r[3], u)], dt, 200, 16);
      } else springTo(d, r, dt);
      if (t > SHOT.aim * 0.78 && !d.locked) { d.locked = a; c.S('focus'); for (let i = 0; i < 4; i++) d.vel[i] += (i < 2 ? 1 : -1) * 160; }
      // scan, then snap
      const snapT = SHOT.aim + SHOT.scan;
      if (t > SHOT.aim && !d.scanning) { d.scanning = 1; c.S('scan'); }
      if (t >= snapT && !d.snapped) {
        d.snapped = a; d.flash = 1; c.S('shutter'); c.sq.kick(8);
        const bx = c.bx + c.P * 6, by = c.by + c.R * 0.42 - c.P * 4;
        for (let i = 0; i < 14; i++) { const ang = (i / 14) * Math.PI * 2, sp = 140 + hash(st.seed + i) * 160; c.spawn(bx, by, Math.cos(ang) * sp, Math.sin(ang) * sp - 40, 260, c.L, 0, 2.2); }
      }
      if (d.flash) d.flash = Math.max(0, d.flash - dt * 2.6);
      // the photo pops out of the frame, then flies home
      if (d.snapped) {
        const since = a - d.snapped;
        if (since > SHOT.blink + SHOT.eject + SHOT.fly && !d.gulped) { d.gulped = 1; c.sq.kick(10); c.S('gulp'); st.finish(true); }
        const fu = (since - SHOT.blink - SHOT.eject) / SHOT.fly;
        if (fu > 0 && fu < 1 && Math.random() < dt * 40) {
          const ph = T.screenshot.photo(st, c);
          if (ph) c.spawn(ph.cx + (Math.random() - 0.5) * ph.w * 0.6, ph.cy + (Math.random() - 0.5) * ph.h * 0.4, (Math.random() - 0.5) * 50, -20 - Math.random() * 40, 30, Math.random() < 0.5 ? c.L : c.L - 1, 0, 2.6);
        }
      }
    },
    // The polaroid's settled size (px), before it flies home.
    photoSize(st, c) {
      const r = st.d.rect, pw = clamp(c.R * 1.5, 54, 110);
      return [pw, pw * clamp((r[3] - r[1]) / Math.max(1, r[2] - r[0]), 0.45, 1.3)];
    },
    // Where the little photo is right now (px), or null.
    photo(st, c) {
      const d = st.d;
      if (!d.snapped || d.gulped || !d.rect) return null;
      const since = st.age - d.snapped - SHOT.blink;
      if (since < 0) return null;
      const r = d.rect, [lx, ly] = T.screenshot.lens(c), [pw, ph] = T.screenshot.photoSize(st, c);
      const fcx = (r[0] + r[2]) / 2, fcy = (r[1] + r[3]) / 2;
      if (since < SHOT.eject) {
        // the shot pops out of the frame as a polaroid: it starts at half the frame and settles, bouncing
        const u = ease(since / SHOT.eject), pop = 1 + Math.sin(u * Math.PI) * 0.12;
        const w0 = Math.max(pw, (r[2] - r[0]) * 0.42), h0 = Math.max(ph, (r[3] - r[1]) * 0.42);
        return { cx: fcx, cy: fcy, w: lerp(w0, pw, u) * pop, h: lerp(h0, ph, u) * pop };
      }
      const u = ease(clamp((since - SHOT.eject) / SHOT.fly, 0, 1));
      const x = lerp(fcx, lx, u), y = lerp(fcy, ly, u) - Math.sin(u * Math.PI) * c.R * 1.6, s = lerp(1, 0.22, u);
      return { cx: x, cy: y, w: pw * s, h: ph * s };
    },
    pose(st, c) {
      const d = st.d, rec = d.snapped && st.age - d.snapped < 0.25 ? 0.12 : 0;
      const r = d.rect ?? d.cur, tx = (r[0] + r[2]) / 2, ty = (r[1] + r[3]) / 2;
      c.look(tx, ty);
      const aiming = d.rect && !d.snapped;
      return {
        arms: 1, tl: [-0.72, 0.42 + rec], tr: [0.72, 0.42 + rec], oy: rec * c.R,
        mouth: d.snapped ? 'grin' : d.searching ? 'o' : 'flat', brow: aiming ? 'determined' : d.searching ? 'raised' : null,
      };
    },
    grid(st, c) {
      if (st.out > 0.4) return;
      const d = st.d, P = c.P, cx = Math.round(c.bx / P), cy = Math.round((c.by + c.R * 0.42) / P);
      camera(c, cx, cy, st, d.flash);
      // flash bulb starburst
      if (d.flash > 0.25) {
        const n = Math.round(d.flash * 6), fx = cx + 6, fy = cy - 5;
        for (let k = 2; k <= n; k++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [1, -1], [-1, -1]]) c.put(fx + dx * k, fy + dy * k, k === n ? c.L - 1 : c.L);
      }
    },
    top(st, c) {
      const d = st.d, P = c.P, L = c.L, a = st.age;
      const g = (v) => Math.round(v / P);
      const [x0, y0, x1, y1] = d.cur.map(g);
      const t = a - d.aimAt;
      const done = d.snapped && a - d.snapped > SHOT.blink;
      if (!done) {
        // corner brackets: thick pixel L's that scale with the target
        const span = Math.min(x1 - x0, y1 - y0);
        const len = Math.max(3, Math.min(14, Math.round(span * 0.14)));
        const blink = d.locked && !d.snapped && a - d.locked < 0.3 ? Math.sin(a * 40) > 0 : true;
        if (blink) brackets(c, x0, y0, x1, y1, L, len);
      }
      if (d.searching || !d.rect || done) { T.screenshot.drawPhoto(st, c); return; }
      const [lx, ly] = T.screenshot.lens(c);
      const [r0, r1, r2, r3] = d.rect.map(g);
      const tcx = (r0 + r2) / 2, tcy = (r1 + r3) / 2;
      // laser sight: marching dots from the lens to the target centre, fading once locked
      const sight = d.locked ? 1 - clamp((a - d.locked) / 0.4, 0, 1) : clamp(t / 0.15, 0, 1);
      if (sight > 0.05) {
        const sx = g(lx), sy = g(ly), n = Math.max(1, Math.ceil(Math.hypot(tcx - sx, tcy - sy)));
        const skip = Math.ceil((c.R * 1.1) / P);
        for (let i = skip; i < n; i += 2) {
          if (c.th(i, 7) > sight) continue;
          const x = Math.round(lerp(sx, tcx, i / n)), y = Math.round(lerp(sy, tcy, i / n));
          c.put(x, y, (i - Math.floor(a * 24)) % 8 < 2 ? L : L - 2);
        }
      }
      if (d.locked) {
        // chasing LED perimeter
        const off = Math.floor(a * 14);
        for (let x = r0 + 1; x < r2; x++) { if ((x + off) % 4 === 0) c.put(x, r1, L - 1); if ((x - off) % 4 === 0) c.put(x, r3, L - 1); }
        for (let y = r1 + 1; y < r3; y++) { if ((y - off) % 4 === 0) c.put(r0, y, L - 1); if ((y + off) % 4 === 0) c.put(r2, y, L - 1); }
        // crosshair
        if (!d.snapped) {
          const cxg = Math.round(tcx), cyg = Math.round(tcy);
          for (const k of [2, 3, 4]) { c.put(cxg + k, cyg, L); c.put(cxg - k, cyg, L); c.put(cxg, cyg + k, L); c.put(cxg, cyg - k, L); }
          c.put(cxg, cyg, L - 1);
        }
      }
      // scanline with a dithered trail
      if (d.scanning && !d.snapped) {
        const u = clamp((t - SHOT.aim) / SHOT.scan, 0, 1), sy = Math.round(lerp(r1 + 1, r3 - 1, ease(u)));
        for (let x = r0 + 1; x < r2; x++) {
          c.put(x, sy, L);
          for (let k = 1; k <= 5; k++) if (sy - k > r1 && c.th(x, sy - k) < 1 - k / 6) c.put(x, sy - k, k < 3 ? L - 1 : L - 2);
        }
      }
      // region marquee
      if (st.variant === 'region' && !d.snapped) {
        for (let x = x0; x <= x1; x += 2) { c.put(x, y0, L - 2); c.put(x, y1, L - 2); }
        for (let y = y0; y <= y1; y += 2) { c.put(x0, y, L - 2); c.put(x1, y, L - 2); }
      }
      T.screenshot.drawPhoto(st, c);
    },
    // The shot as a little LED polaroid: bright border, a thicker strip at the bottom, dithered picture.
    drawPhoto(st, c) {
      const ph = T.screenshot.photo(st, c);
      if (!ph) return;
      const P = c.P, L = c.L;
      const w = Math.max(4, Math.round(ph.w / P)), h = Math.max(4, Math.round(ph.h / P));
      const gx = Math.round(ph.cx / P - w / 2), gy = Math.round(ph.cy / P - h / 2);
      const strip = Math.max(1, Math.round(h * 0.16));
      for (let y = -1; y <= h + strip; y++) for (let x = -1; x <= w; x++) {
        const edge = x === -1 || x === w || y === -1 || y === h + strip;
        if (edge) { c.put(gx + x, gy + y, 0); continue; }
        const border = x === 0 || x === w - 1 || y === 0 || y >= h - 1;
        if (border) c.put(gx + x, gy + y, L);
        // With the real shot, the picture area is dark glass; over() prints the shot into it.
        else c.put(gx + x, gy + y, st.image ? 0 : c.th(gx + x, gy + y) < 0.12 + 0.3 * (y / h) ? 2 : 1);
      }
      // a tiny "sun" and horizon in the picture so it reads as a photo (until the real shot arrives)
      if (!st.image && w > 9 && h > 8) {
        c.put(gx + w - 4, gy + 2, L); c.put(gx + w - 3, gy + 2, L); c.put(gx + w - 4, gy + 3, L); c.put(gx + w - 3, gy + 3, L);
        for (let x = 1; x < w - 1; x++) c.put(gx + x, gy + Math.round(h * 0.62) + (x % 5 < 2 ? 0 : 1), L - 1);
      }
    },
    // The polaroid's picture area in px, on the same grid as its LED frame.
    photoBox(st, c) {
      const ph = T.screenshot.photo(st, c);
      if (!ph) return null;
      const P = c.P, w = Math.max(4, Math.round(ph.w / P)), h = Math.max(4, Math.round(ph.h / P));
      const gx = Math.round(ph.cx / P - w / 2), gy = Math.round(ph.cy / P - h / 2);
      return w > 3 && h > 3 ? [(gx + 1) * P, (gy + 1) * P, (w - 2) * P, (h - 2) * P] : null;
    },
    over(st, c, ctx) {
      const d = st.d;
      if (!d.rect || d.searching) return;
      const [x0, y0, x1, y1] = d.cur, a = st.age;
      // The shot it actually took, so a window hidden behind others still shows what was captured: faint while
      // aiming, printed in full where the scanline has passed, gone as the shutter closes. Then on the polaroid.
      if (st.image?.complete) {
        const t = a - d.aimAt, alpha = !d.snapped ? clamp(t / 0.3, 0, 1) : 1 - clamp((a - d.snapped) / SHOT.blink, 0, 1);
        const ins = c.P * 2, w = x1 - x0 - ins * 2, h = y1 - y0 - ins * 2, r = d.rect;
        // Built once at the frame's resting size and scaled while the brackets spring: a new size every frame meant
        // re-dithering the whole screenshot every frame.
        const fw = r[2] - r[0] - ins * 2, fh = r[3] - r[1] - ins * 2;
        const full = fw > 24 && fh > 24 ? R.ledImage(st.image, whole(st.image), fw, fh, c) : null;
        if (full && t >= 0 && alpha > 0 && w > 24 && h > 24) {
          const u = d.snapped ? 1 : d.scanning ? ease(clamp((t - SHOT.aim) / SHOT.scan, 0, 1)) : 0;
          ctx.save();
          ctx.globalAlpha = alpha * 0.3; ctx.drawImage(full, x0 + ins, y0 + ins, w, h);
          if (u > 0) { ctx.beginPath(); ctx.rect(x0 + ins, y0 + ins, w, h * u); ctx.clip(); ctx.globalAlpha = alpha; ctx.drawImage(full, x0 + ins, y0 + ins, w, h); }
          ctx.restore();
        }
        // While it pops out bigger than its settled size, scale the frame's picture; small sizes are cheap to build.
        const box = T.screenshot.photoBox(st, c), [pw, ph] = T.screenshot.photoSize(st, c);
        const pic = box && (box[2] > pw || box[3] > ph ? full : R.ledImage(st.image, whole(st.image), box[2], box[3], c));
        if (pic) ctx.drawImage(pic, ...box);
      }
      // soft tint + app-name tag on the real window while aiming
      if (st.target && st.targetName && !(d.snapped && a - d.snapped > SHOT.blink)) {
        const land = clamp(1 - Math.abs(d.cur[0] - d.rect[0]) / 60, 0, 1);
        if (land > 0.02) {
          ctx.save();
          ctx.fillStyle = c.css(c.PAL[c.L], 0.05 * land); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          ctx.font = '700 12px "Martian Mono", ui-monospace, monospace';
          const name = st.targetName.toUpperCase();
          const tw = Math.ceil(ctx.measureText(name).width) + 20, th = 22, tx = Math.round(x0), ty = Math.round(y0 >= th + 6 ? y0 - th - 6 : y0 + 6);
          ctx.globalAlpha = land;
          ctx.fillStyle = c.css(c.PAL[0], 0.94); ctx.fillRect(tx, ty, tw, th);
          ctx.fillStyle = c.css(c.PAL[c.L], 1); ctx.fillRect(tx, ty, 3, th);
          ctx.strokeStyle = c.css(c.PAL[c.L], 0.8); ctx.lineWidth = 1; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
          ctx.fillStyle = c.css(c.PAL[c.L], 1); ctx.textBaseline = 'middle'; ctx.fillText(name, tx + 11, ty + th / 2 + 1);
          ctx.restore();
        }
      }
      // scanline glow band
      if (d.scanning && !d.snapped) {
        const u = clamp((a - d.aimAt - SHOT.aim) / SHOT.scan, 0, 1), sy = lerp(d.rect[1], d.rect[3], ease(u));
        const gr = ctx.createLinearGradient(0, sy - 40, 0, sy + 6);
        gr.addColorStop(0, c.css(c.PAL[c.L], 0)); gr.addColorStop(0.85, c.css(c.PAL[c.L], 0.16)); gr.addColorStop(1, c.css(c.PAL[c.L], 0));
        ctx.fillStyle = gr; ctx.fillRect(d.rect[0], sy - 40, d.rect[2] - d.rect[0], 46);
      }
      if (!d.snapped) return;
      const since = a - d.snapped, r = d.rect;
      // flash
      if (d.flash > 0) { ctx.fillStyle = c.css(c.PAL[c.L], d.flash * 0.42); ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); }
      // shutter blink: dark bars close from top and bottom, then open again
      if (since < SHOT.blink) {
        const u = since / SHOT.blink, close = Math.sin(u * Math.PI), half = ((r[3] - r[1]) / 2) * close;
        const P = c.P, hh = Math.round(half / P) * P;
        ctx.fillStyle = c.css(c.PAL[0], 0.9);
        ctx.fillRect(r[0], r[1], r[2] - r[0], hh); ctx.fillRect(r[0], r[3] - hh, r[2] - r[0], hh);
        ctx.fillStyle = c.css(c.PAL[c.L], 0.9);
        ctx.fillRect(r[0], r[1] + hh - 2, r[2] - r[0], 2); ctx.fillRect(r[0], r[3] - hh, r[2] - r[0], 2);
      }
    },
  };

  // ===== READ =====  variants: file | many | search
  T.read = {
    variants: ['file', 'many', 'search'], label: 'read',
    start(st) { st.d.page = 0; st.d.pages = st.variant === 'many' ? 3 + Math.floor(hash(st.seed) * 3) : 1; st.d.flip = 0; },
    update(st, c, dt) {
      const d = st.d;
      if (st.variant === 'search') {
        d.found = d.found ?? 1.6 + hash(st.seed) * 0.8;
        if (st.age > d.found && !d.hit) { d.hit = 1; c.S('ping'); c.face.set('surprised', 0.4); }
        if (st.age > d.found + 1) st.finish(true);
        return;
      }
      const per = st.variant === 'many' ? 1.25 : 2.6;
      const p = Math.floor(st.age / per);
      if (p !== d.page) {
        if (p >= d.pages) { st.finish(true); return; }
        d.page = p; d.flip = 1; c.S('page');
      }
      d.flip = Math.max(0, d.flip - dt * 4);
      d.line = Math.floor(((st.age % per) / per) * 6);
      d.u = (((st.age % per) / per) * 6) % 1;
    },
    pose(st, c) {
      const d = st.d;
      if (st.variant === 'search') {
        const sweep = Math.sin(st.age * 2.6), lift = d.hit ? -0.25 : 0;
        const mx = 0.1 + sweep * 0.55, my = 0.45 + Math.cos(st.age * 1.9) * 0.18 + lift;
        c.look(c.bx + mx * c.R * 2, c.by + my * c.R);
        d.mag = [mx, my];
        return { arms: 1, tl: [-0.95, 0.4], tr: [mx + 0.35, my + 0.35], mouth: d.hit ? 'o' : 'flat', brow: d.hit ? 'raised' : 'determined' };
      }
      const u = d.u ?? 0;
      c.look(c.bx + lerp(-0.4, 0.4, u) * c.R, c.by + c.R);
      const sway = Math.sin(st.age * 2) * 0.03;
      return { arms: 1, tl: [-0.52, 1.25 + sway], tr: [0.52, 1.25 - sway], oy: -d.flip * c.R * 0.04, mouth: 'flat', brow: null };
    },
    grid(st, c) {
      if (c.jv) return J.read(st, c);
      const d = st.d, P = c.P, wide = st.variant === 'search' ? zs(c, 34) : zs(c, 16, 7);
      const cx = Math.round(c.bx / P) + Math.round(c.side * wide / 2), cy = Math.round((c.by + (c.side ? c.R * 0.2 : c.R * 0.82)) / P);
      if (st.out > 0.5) return;
      if (st.variant === 'search') {
        [[-12, 3], [0, 5], [12, 3]].forEach(([dx, dy], i) => paper(c, cx + zs(c, dx, -99), cy + zs(c, dy) - 1, st, { w: zs(c, 10, 6), h: zs(c, 13, 8), lines: 3, page: i, hi: d.hit && i === 1 ? 1 : null }));
        const [mx, my] = d.mag ?? [0, 0.5];
        magnifier(c, c.side ? cx + Math.round(mx * wide / 2) : Math.round((c.bx + mx * c.R * 1.6) / P), c.side ? cy - 1 : Math.round((c.by + my * c.R) / P), zs(c, 5, 3));
        if (d.hit) { const n = tight(c) ? 2 : 3, by = cy - zs(c, 8, 5) - Math.round(Math.abs(Math.sin(st.age * 9)) * 2); for (let y = 0; y < n; y++) c.put(cx + 2, by + y, c.L); c.put(cx + 2, by + n + 1, c.L); }
        return;
      }
      if (st.variant === 'many' && d.page < d.pages - 1) for (let i = 2; i >= 1; i--) paper(c, cx + i, cy - i, st, { page: d.page + i, lines: 0 });
      const slide = d.flip * 6 * c.z;
      paper(c, cx - Math.round(slide), cy + Math.round(slide * 0.3), st, { page: d.page, hi: d.line, lines: 6 });
      if (st.variant === 'many') {
        const n = d.pages, x0 = cx - n;
        for (let i = 0; i < n; i++) c.put(x0 + i * 2, cy + zs(c, 10, 5), i <= d.page ? c.L : 1);
      }
    },
  };

  // ===== WRITE =====  variants: edit | create | delete
  T.write = {
    variants: ['edit', 'create', 'delete'], label: 'write',
    start(st) { st.d.lines = 6; },
    update(st, c, dt) {
      const d = st.d;
      if (st.variant === 'delete') {
        d.crumble = clamp((st.age - 0.7) / 1.1, 0, 1);
        if (d.crumble > 0 && !d.cr) { d.cr = 1; c.S('crunch'); }
        if (d.crumble > 0 && Math.random() < dt * 40) c.spawn(c.bx + R.rand(-0.4, 0.4) * c.R, c.by + c.R * R.rand(0.3, 1), R.rand(-40, 40), R.rand(-30, 20), 420, R.rand(0, 1) < 0.5 ? c.L - 1 : c.L - 2, 0, 1.1);
        if (st.age > 2.2) st.finish(true);
        return;
      }
      const t0 = st.variant === 'create' ? 0.7 : 0.2;
      d.appear = st.variant === 'create' ? clamp(st.age / 0.7, 0, 1) : 1;
      const w = Math.max(0, st.age - t0) / 0.42;
      d.wline = Math.floor(w); d.wu = w % 1;
      if (d.appear >= 1 && d.wline < d.lines && Math.random() < dt * 9) c.S('scribble');
      if (st.variant === 'edit' && d.wline !== d.lastPlus && d.wline < d.lines && d.wline > 0) {
        d.lastPlus = d.wline;
        const minus = d.wline === 2 || d.wline === 4;
        c.spawnGlyph(minus ? '-' : '+', c.bx - c.R * 0.1, c.by + c.R * 0.2);
      }
      if (d.wline >= d.lines + 1) st.finish(true);
    },
    pose(st, c) {
      const d = st.d;
      if (st.variant === 'delete') {
        const shake = d.crumble ? Math.sin(st.age * 50) * 0.04 : 0;
        c.look(c.bx, c.by + c.R);
        return { arms: d.crumble > 0.7 ? 0.5 : 1, tl: [-0.5 + shake, 1.0], tr: [0.5 + shake, 1.0], mouth: d.crumble ? 'frown' : 'o', brow: d.crumble ? 'raised' : null };
      }
      const line = Math.min(d.wline ?? 0, d.lines - 1), u = d.wu ?? 0;
      const zig = Math.sin(u * Math.PI * 10) * 0.05;
      const px = lerp(-1.3, -0.62, u), py = 0.38 + line * 0.13 + zig;
      d.pen = [px, py];
      c.look(c.bx + px * c.R, c.by + py * c.R);
      return { arms: 1, tl: [-1.6, 0.85], tr: [px + 0.36, py + 0.42], mouth: st.variant === 'create' && d.appear < 1 ? 'o' : 'flat', brow: 'determined' };
    },
    grid(st, c) {
      const d = st.d, P = c.P;
      if (st.out > 0.5) return;
      if (c.jv) return J.write(st, c);
      if (st.variant === 'delete') {
        if (d.crumble < 1) paper(c, Math.round(c.bx / P + c.side * zs(c, 16, 7) / 2), Math.round((c.by + (c.side ? c.R * 0.2 : c.R * 0.66)) / P), st, { crumble: d.crumble, lines: 6 });
        return;
      }
      // In front: the paper at the left hand. Beside a small body or the pointer: just past it, pen and all.
      const shift = c.side ? c.side * zs(c, 16, 7) * P / 2 + c.R * 0.95 : 0;
      const cx = Math.round((c.bx - c.R * 0.95 + shift) / P), cy = Math.round((c.by + (c.side ? c.R * 0.2 : c.R * 0.78)) / P);
      const strike = st.variant === 'edit' ? [2, 4].filter((i) => i < (d.wline ?? 0)) : [];
      paper(c, cx, cy, st, { appear: d.appear, write: { line: d.wline ?? 0, u: d.wu ?? 0 }, lines: d.lines, strike });
      const [px, py] = d.pen ?? [-0.6, 0.4];
      pencil(c, Math.round((c.bx + px * c.R + shift) / P) + 1, Math.round((c.by + py * c.R - (c.side ? c.R * 0.58 : 0)) / P), -2.3);
    },
  };

  // ===== RUN (terminal) =====  variants: ok | fail | progress
  T.run = {
    variants: ['ok', 'progress', 'fail'], label: 'run',
    start(st) { st.d.lines = [{ prompt: true, len: 0 }]; st.d.typed = 0; st.d.cmdLen = 8 + Math.floor(hash(st.seed) * 6); },
    update(st, c, dt) {
      const d = st.d, L = d.lines;
      if (st.age < 0.9) {
        const n = Math.floor(st.age / 0.9 * d.cmdLen);
        if (n > L[0].len) { L[0].len = n; c.S('key', 0.8 + hash(n + st.seed) * 0.5); }
        d.typing = true;
        return;
      }
      d.typing = false;
      const outT = st.age - 0.9, total = st.variant === 'progress' ? 2.6 : 1.8;
      if (st.variant === 'progress') d.bar = clamp(outT / (total - 0.3), 0, 1);
      const want = Math.min(7, Math.floor(outT / 0.22));
      while (L.length - 1 < want) L.push({ len: 3 + Math.floor(hash(L.length + st.seed) * 12), lvl: L.length % 3 ? c.L - 2 : 1 });
      if (outT > total && !st.status) {
        if (st.variant === 'fail') { L.push({ len: 9, lvl: c.L }); st.finish(false); c.face.set(null, 0); }
        else st.finish(true);
      }
    },
    pose(st, c) {
      const d = st.d, side = c.side || (c.bx < c.W * 0.62 ? 1 : -1);
      d.side = side;
      const ty = d.typing ? Math.sin(st.age * 26) : 0;
      c.look(c.bx + side * c.R * 2, c.by - c.R * 0.1);
      const fail = st.status === 'fail';
      return {
        arms: 1, tl: [-0.36 + side * 0.15, 0.8 - Math.max(0, ty) * 0.14], tr: [0.36 + side * 0.15, 0.8 - Math.max(0, -ty) * 0.14],
        ox: side * c.R * 0.05, mouth: fail ? 'frown' : st.status === 'ok' ? 'grin' : 'flat', brow: fail ? 'angry' : 'determined',
      };
    },
    grid(st, c) {
      if (c.jv) return J.run(st, c);
      const d = st.d, P = c.P, w = zs(c, 30, 15), h = zs(c, 21, 12);
      const side = d.side ?? 1;
      const x0 = Math.round(((c.side ? c.mx : c.bx) + side * (c.R * 1.35 + (c.side ? P * 2 : 0))) / P) - (side < 0 ? w : 0), y0 = Math.round((c.by - (c.side ? h * P / 2 : c.R * 0.9)) / P);
      const pop = clamp(st.age / 0.18, 0, 1) * (1 - clamp((st.out - 0.4) / 0.4, 0, 1));
      if (pop < 0.3) return;
      terminal(c, x0, y0, w, h, st, d.lines, st.status);
      if (d.bar != null) {
        const y = y0 + h - (tight(c) ? 2 : 3), bw = w - 4;
        for (let x = 0; x < bw; x++) { c.put(x0 + 2 + x, y, x < Math.round(bw * d.bar) ? c.L : 1); if (!tight(c)) c.put(x0 + 2 + x, y - 1, x < Math.round(bw * d.bar) ? c.L - 1 : 1); }
      }
      // little cable of light from the blob's hands to the terminal while typing
      if (d.typing && c.k.form !== 'cursor') for (let i = 0; i < 3; i++) { const u = ((c.now * 2 + i / 3) % 1); c.put(Math.round(lerp(c.bx / P + side * zs(c, 4), x0 + (side > 0 ? 0 : w), u)), Math.round(lerp((c.by + c.R * 0.6) / P, y0 + h / 2, u)), c.L); }
    },
  };

  // ===== WEB =====  variants: search | fetch
  T.web = {
    variants: ['search', 'fetch'], label: 'web', head: 0.9,
    start(st) { st.d.packets = []; st.d.got = 0; },
    update(st, c, dt) {
      const d = st.d;
      if (st.variant === 'fetch' && st.age > 0.4 && st.age < 2.4 && Math.random() < dt * 9) {
        const a = Math.random() * Math.PI * 2, r = Math.max(c.W, c.H) * 0.6;
        d.packets.push({ x: c.bx + Math.cos(a) * r, y: c.by + Math.sin(a) * r, u: 0, sp: R.rand(0.9, 1.5) });
      }
      for (let i = d.packets.length - 1; i >= 0; i--) {
        const p = d.packets[i]; p.u += dt * p.sp;
        if (p.u >= 1) { d.packets.splice(i, 1); d.got++; if (d.got % 3 === 1) c.S('ping'); }
      }
      if (st.age > (st.variant === 'fetch' ? 2.9 : 2.4)) st.finish(true);
      if (st.variant === 'search' && Math.random() < dt * 3) c.S('tick');
    },
    pose(st, c) {
      const lift = Math.sin(st.age * 3) * 0.05;
      c.look(c.bx + c.R * 0.8, c.by - c.R * 1.4);
      return { arms: 1, tl: [-0.98, 0.35], tr: [0.82, -0.72 + lift], mouth: 'o', brow: 'raised' };
    },
    grid(st, c) {
      const P = c.P, d = st.d;
      if (st.out > 0.5) return;
      if (c.jv) return J.web(st, c);
      const gx = Math.round((c.mx + c.R * 0.86) / P), gy = Math.round((c.by - c.R * 1.38 + Math.sin(st.age * 3) * c.R * 0.05) / P), r = zs(c, 8, 4);
      globe(c, gx, gy, r, st.age * 2.4);
      if (st.variant === 'search') {
        const a = st.age * 3, mx = gx + Math.round(Math.cos(a) * zs(c, 12, 7)), my = gy + Math.round(Math.sin(a) * zs(c, 8, 5));
        magnifier(c, mx, my, zs(c, 4, 3));
      } else {
        for (let i = 0; i < 3; i++) {
          const rr = r + 2 + ((st.age * 9 * c.z + i * zs(c, 4)) % zs(c, 12, 6));
          ring(c, gx, gy, rr, rr > r + zs(c, 8, 4) ? 1 : 2, -Math.PI * 0.95, -Math.PI * 0.05);
        }
      }
    },
    top(st, c) {
      const P = c.P, [gx, gy] = c.jv ? J.webAt(c) : [c.mx + c.R * 0.86, c.by - c.R * 1.38];
      for (const p of st.d.packets) {
        const u = ease(p.u), x = lerp(p.x, gx, u), y = lerp(p.y, gy, u);
        c.put(Math.round(x / P), Math.round(y / P), c.L); c.put(Math.round(x / P) + 1, Math.round(y / P), c.L - 1);
      }
    },
  };
})();
