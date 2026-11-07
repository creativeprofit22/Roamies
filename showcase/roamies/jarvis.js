// JARVIS look for the sidekick: no face and no body, the way the films show Stark's AI. A globe of LED points
// with a lit heart (the Wave Sphere study), rippled by the voice. The cursor form is a HUD reticle, and the
// moments the goo blob acts out (heart, bolt, alarm, anger, flame) become HUD read-outs here.
// Everything else (following, bubbles, tools, sizes) is the same sidekick; 10-dither.js calls into this when
// the look is 'jarvis'. Pure drawing: it only writes LED cells through the kit it's given.
(() => {
  const R = window.Roamie;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  // Points spread evenly over a sphere (golden spiral). Enough to read as a globe at the default size.
  const sphere = (n) => Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  const DOTS = { default: sphere(520), small: sphere(260) };

  // HUD glyphs for the blob's moments, drawn as read-outs beside the globe: heart, bolt, alarm, anger, flame.
  const GLYPH = {
    heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
    bolt: ['...##', '..##.', '.##..', '#####', '..##.', '.##..', '##...'],
    excl: ['##', '##', '##', '##', '..', '##'],
    clock: ['..###..', '.#...#.', '#..#..#', '#..##.#', '#.....#', '.#...#.', '..###..'],
    anger: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    flame: ['..#...', '..##..', '.###.#', '.#####', '######', '##.###', '#...##', '.####.'],
  };

  R.jarvis = {
    // Voice level: rises while it talks or hears you, settles to a slow breath otherwise.
    level(st) {
      const t = st.t;
      if (st.mode === 'talk' && st.voice != null) return clamp(0.3 + st.voice * 0.9, 0, 1); // the real voice
      if (st.mode === 'talk') return clamp(0.45 + 0.35 * Math.abs(Math.sin(t * 11.3)) * Math.abs(Math.sin(t * 2.9 + 1)) + 0.2 * Math.sin(t * 23), 0, 1);
      if (st.mode === 'listen') return clamp(st.heard ?? 0.35 + 0.3 * Math.abs(Math.sin(t * 4.1)), 0, 1);
      if (st.mode === 'think') return 0.25;
      return 0.12 + 0.05 * Math.sin(t * 1.4);
    },

    // The globe. st: { t, mode, act, actA, open, look:[x,y], speed, sq, wide, dizzy, sleepy }
    // cx, cy are cells; rad the radius in cells. put(x, y, level) writes a cell, the brightest write wins.
    body(k, cx, cy, rad, st) {
      const { put, L, th } = k, t = st.t;
      const dots = rad < 9 ? DOTS.small : DOTS.default;
      const v = this.level(st);
      const mode = st.mode, A = st.act;
      // Spin: slow at rest, faster thinking, a quick whirl while 'hype'; dizzy wobbles it.
      const spinRate = mode === 'think' ? 1.6 : A === 'hype' ? 3 : st.sleepy > 0.5 ? 0.1 : 0.32;
      st.spin = (st.spin ?? 0) + spinRate * (st.dt ?? 0.016);
      const yaw = st.spin + st.look[0] * 0.5, pitch = -0.42 + st.look[1] * 0.25 + (st.dizzy > 0.5 ? Math.sin(t * 9) * 0.3 : 0);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      // Squash from the body's bounces, and a pulse out when it hears or speaks.
      const sx = 1 + st.sq * 0.05, sy = 1 - st.sq * 0.04;
      const shake = A === 'upset' && st.actA % 0.9 < 0.32 ? Math.sin(t * 48) * 0.6 : 0;
      const breath = 1 + (st.sleepy > 0.5 ? 0.03 : 0.015) * Math.sin(t * 1.4);
      const wavy = mode === 'talk' || mode === 'listen' ? v : A === 'hype' ? 0.7 : 0.12;
      for (const p of dots) {
        // Ripples run over the surface: the voice raises them, a sound wave bulging the points outward.
        const band = Math.sin(p[1] * 7 - t * (mode === 'talk' ? 9 : 3)) * 0.5 + Math.sin(Math.atan2(p[2], p[0]) * 5 + t * 4) * 0.5;
        const r = rad * breath * (1 + wavy * 0.16 * band);
        let x = p[0] * cyw + p[2] * syw, z = -p[0] * syw + p[2] * cyw;
        const y = p[1] * cp - z * sp; z = p[1] * sp + z * cp;
        const px = cx + x * r * sx + shake, py = cy + y * r * sy;
        if (z < -0.15) { if (th(Math.floor(px), Math.floor(py)) < 0.5) put(px, py, 1); continue; }
        // Lit from the top left, brighter toward the viewer and on a ripple crest.
        const lam = clamp(-x * 0.45 - y * 0.6 + z * 0.66, 0, 1);
        const lv = 1 + lam * 1.6 + Math.max(0, band) * wavy * 1.4 + (z > 0.7 ? 0.4 : 0);
        put(px, py, clamp(Math.round(lv), 1, L - 1));
      }
      // The heart: a bright core that swells with the voice; it dims to a dot asleep and closes on a blink.
      const open = st.open, sleepy = st.sleepy > 0.5;
      const hr = Math.max(1, Math.round(rad * (sleepy ? 0.1 : 0.17 + v * 0.07) * (A === 'hype' ? 1.25 : 1)));
      const hx = Math.round(cx + st.look[0] * rad * 0.18), hy = Math.round(cy + st.look[1] * rad * 0.14);
      const hh = Math.max(0, Math.round(hr * (st.wide > 0.5 ? 1.25 : Math.min(1, open))));
      for (let y = -hr - 1; y <= hr + 1; y++) for (let x = -hr - 1; x <= hr + 1; x++) {
        const d = Math.hypot(x / (hr + 0.5), y / (hh + 0.5 || 0.5));
        if (d > 1.35) continue;
        put(hx + x, hy + y, d < 0.55 ? L : d < 1 ? L - 1 : 2);
      }
      if (hh === 0) for (let x = -hr; x <= hr; x++) put(hx + x, hy, L);
      // Thinking: a short arc of light sweeping round the globe, like the HUD scanning.
      if (mode === 'think') for (let i = 0; i < 10; i++) {
        const a = t * 3.2 - i * 0.07;
        put(cx + Math.cos(a) * (rad + 2), cy + Math.sin(a) * (rad + 2) * 0.96, i < 3 ? L : i < 6 ? L - 1 : 2);
      }
    },

    // Cursor form: a HUD reticle round the body point (cx, cy), its lit heart in the middle and a tick at the
    // hotspot (hx, hy), where the arrow's tip would be. It holds still at rest (the native follower shows a still
    // picture of it while it follows); it turns while it thinks or talks.
    cursor(k, cx, cy, hx, hy, st) {
      const { put, L } = k, t = st.t, v = this.level(st), A = st.act;
      const busy = st.mode === 'think' || st.mode === 'talk' || st.mode === 'listen' || !!A;
      const spin = busy ? (st.spin = (st.spin ?? 0) + (st.mode === 'think' ? 2.4 : 0.9) * (st.dt ?? 0.016)) : (st.spin ?? 0);
      // Four ring arcs with gaps; the voice pushes them out a touch.
      const r = 4.6 + (st.mode === 'talk' || st.mode === 'listen' ? v * 1.1 : 0) + (A === 'hype' ? 0.8 * Math.abs(Math.sin(t * 6.5)) : 0);
      for (let i = 0; i < 64; i++) {
        if (((i + 4) % 16) < 3) continue;
        const a = (i / 64) * TAU + spin;
        put(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3);
      }
      // Bracket ticks at the diagonals.
      for (let q = 0; q < 4; q++) {
        const a = q * (TAU / 4) + TAU / 8 - spin * 0.3;
        for (let d = 6.4; d <= 7.4; d += 0.5) put(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2);
      }
      // The heart: a dot that closes to a line on a blink and dims asleep; a cross while it talks.
      const sleepy = st.sleepy > 0.5;
      if (sleepy) put(cx, cy, 2);
      else if (st.open < 0.35) { put(cx - 1, cy, L - 1); put(cx, cy, L); put(cx + 1, cy, L - 1); }
      else {
        put(cx, cy, L); put(cx + 1, cy, L - 1); put(cx - 1, cy, L - 1); put(cx, cy + 1, L - 1); put(cx, cy - 1, L - 1);
        if (st.mode === 'talk' && v > 0.55) for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) put(cx + dx, cy + dy, 2);
      }
      // Dizzy: the heart wanders; happy: a little arc of light over it.
      if (st.happy > 0.5) for (let i = -2; i <= 2; i++) put(cx + i, cy - 2 - (Math.abs(i) === 2 ? 0 : 1), 3);
      // The hotspot: a short bright tick from the tip toward the ring, so it still reads as a pointer.
      const dx = cx - hx, dy = cy - hy, n = Math.hypot(dx, dy) || 1;
      for (let i = 0; i <= 2; i++) put(hx + (dx / n) * i, hy + (dy / n) * i, i === 0 ? L : L - 1);
      // Thinking: one bright dot chasing round the ring.
      if (st.mode === 'think') { const a = t * 5; put(cx + Math.cos(a) * r, cy + Math.sin(a) * r, L); }
    },

    // The blob's moments as HUD read-outs: a bracketed panel with the glyph, a pulsing ring and a short label.
    // Returns nothing; draws with put. gx, gy: the panel's bottom-centre cell.
    readout(k, gx, gy, icon, a, dur, small) {
      const { put, L } = k;
      const rows = GLYPH[icon];
      if (!rows) return;
      const sc = small ? 1 : 2, w = rows[0].length * sc, h = rows.length * sc;
      // Brackets fly out from the glyph and settle; they close again at the end.
      const open = smooth(a / 0.22) * (1 - smooth((a - (dur - 0.2)) / 0.2));
      if (open < 0.02) return;
      const pad = Math.round(2 + 2 * open), x0 = gx - Math.ceil(w / 2) - pad, x1 = gx + Math.floor(w / 2) + pad, y0 = gy - h - pad * 2, y1 = gy;
      const arm = Math.max(1, Math.round(3 * open));
      for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        for (let i = 0; i <= arm; i++) { put(x + dx * i, y, L - 1); put(x, y + dy * i, L - 1); }
      }
      // A scan line drops through the panel as it opens.
      if (a < 0.4) { const sy = Math.round(y0 + (y1 - y0) * (a / 0.4)); for (let x = x0 + 1; x < x1; x++) put(x, sy, 2); }
      // The glyph: hot cells, flickering in like a projector for its first moment.
      if (a > 0.12) rows.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) if (row[i] === '#') {
          if (a < 0.3 && ((i * 7 + j * 3 + Math.floor(a * 40)) % 3) === 0) continue;
          for (let p = 0; p < sc; p++) for (let q = 0; q < sc; q++) put(gx - Math.ceil(w / 2) + i * sc + q, y0 + pad + j * sc + p, L);
        }
      });
      // A small bar under the panel fills over the moment, like a HUD timer.
      const fill = Math.round((x1 - x0 - 2) * clamp(a / dur, 0, 1));
      for (let x = 0; x <= x1 - x0 - 2; x++) put(x0 + 1 + x, y1 + 2, x <= fill ? 2 : 1);
    },
  };
})();
