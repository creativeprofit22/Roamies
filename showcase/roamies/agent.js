// Agent layer for the sidekick. Speech and thought bubbles are drawn on the same LED grid as the body,
// text is dot-matrix on a finer grid, and talking/thinking drive the pose, face and voice blips.
// API: agent.say(text) / agent.think(text) return handles with append(), end() and a `closed` promise.
(() => {
  const R = window.Roamie;
  const { clamp, lerp } = R;

  // ---------- dot-matrix glyphs: real font, supersampled, thresholded to two brightness levels ----------
  const CW = 6, CH = 10, SS = 4;
  const glyphs = new Map();
  let gcan = null, gctx = null;
  const glyph = (ch) => {
    let g = glyphs.get(ch);
    if (g) return g;
    if (!gcan) {
      gcan = document.createElement('canvas'); gcan.width = CW * SS; gcan.height = CH * SS;
      gctx = gcan.getContext('2d', { willReadFrequently: true });
    }
    gctx.clearRect(0, 0, gcan.width, gcan.height);
    gctx.fillStyle = '#fff'; gctx.textAlign = 'center'; gctx.textBaseline = 'alphabetic';
    gctx.font = `700 ${9 * SS}px Menlo, "SF Mono", ui-monospace, monospace`;
    gctx.fillText(ch, 2.5 * SS, 8 * SS);
    const px = gctx.getImageData(0, 0, gcan.width, gcan.height).data;
    const pts = [];
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW - 1; x++) {
      let a = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) a += px[((y * SS + j) * gcan.width + x * SS + i) * 4 + 3];
      a /= SS * SS * 255;
      if (a > 0.5) pts.push(x, y, 2); else if (a > 0.26) pts.push(x, y, 1);
    }
    g = pts; glyphs.set(ch, g);
    return g;
  };

  // Emoji: drawn as two cells of coloured LED dots. They take two UTF-16 units (a surrogate pair, or a symbol
  // plus its emoji selector), which is also two columns in the layout, so wrapping and streaming line up.
  const EMOJI = /\p{Extended_Pictographic}/u;
  const emojis = new Map();
  let ecan = null, ectx = null;
  // Returns [x, y, r, g, b, ...] dots on a (2*CW-1) x CH grid, or null if this font can't draw it.
  const emojiGlyph = (cluster) => {
    if (emojis.has(cluster)) return emojis.get(cluster);
    const EW = CW * 2 - 1, S = 8;
    if (!ecan) { ecan = document.createElement('canvas'); ecan.width = EW * S; ecan.height = CH * S; ectx = ecan.getContext('2d', { willReadFrequently: true }); }
    ectx.clearRect(0, 0, ecan.width, ecan.height);
    ectx.textAlign = 'center'; ectx.textBaseline = 'middle';
    ectx.font = `${CH * S * 0.82}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ectx.fillText(cluster, (EW * S) / 2, (CH * S) / 2 + S * 0.3);
    const px = ectx.getImageData(0, 0, ecan.width, ecan.height).data;
    const pts = [];
    for (let y = 0; y < CH; y++) for (let x = 0; x < EW; x++) {
      let r = 0, g = 0, bl = 0, a = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const o = ((y * S + j) * ecan.width + x * S + i) * 4, al = px[o + 3] / 255;
        r += px[o] * al; g += px[o + 1] * al; bl += px[o + 2] * al; a += al;
      }
      if (a / (S * S) > 0.35) pts.push(x, y, Math.round(r / a), Math.round(g / a), Math.round(bl / a));
    }
    const g = pts.length ? pts : null;
    emojis.set(cluster, g);
    return g;
  };
  // At index j of s: the emoji that starts there and how many units it covers, or null.
  const emojiAt = (s, j) => {
    const cp = s.codePointAt(j);
    if (cp == null || !(cp > 0xffff || EMOJI.test(String.fromCodePoint(cp)))) return null;
    const len = (c) => (c > 0xffff ? 2 : 1), ri = (c) => c >= 0x1f1e6 && c <= 0x1f1ff;
    let n = len(cp);
    if (ri(cp) && ri(s.codePointAt(j + 2))) n = 4; // a flag is two regional letters
    for (;;) {
      const c = s.codePointAt(j + n);
      if (c == null) break;
      if (c === 0x200d && s.codePointAt(j + n + 1) != null) n += 1 + len(s.codePointAt(j + n + 1)); // joined: 👨‍👩‍👧
      else if (c === 0xfe0f || c === 0x20e3 || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0xe0020 && c <= 0xe007f)) n += len(c);
      else break;
    }
    const cluster = s.slice(j, j + n);
    if (!EMOJI.test(cluster) && cp <= 0xffff) return null;
    if (!EMOJI.test(cluster) && !ri(cp)) return null; // other astral characters (rare scripts) stay as text
    return { cluster, n };
  };

  const wrap = (text, cols) => {
    const lines = [];
    let i = 0;
    const n = text.length;
    while (i <= n) {
      let end = i, lastSpace = -1;
      while (end < n && text[end] !== '\n' && end - i < cols) { if (text[end] === ' ') lastSpace = end; end++; }
      if (end < n && text[end] !== '\n' && end - i >= cols && lastSpace > i) end = lastSpace;
      // Never cut an emoji (a surrogate pair) across two lines.
      else if (end < n && end > i + 1 && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      lines.push({ start: i, s: text.slice(i, end) });
      if (end >= n) break;
      i = text[end] === ' ' || text[end] === '\n' ? end + 1 : end;
    }
    return lines;
  };

  const spring = (s, target, k, c, dt) => { s.v += ((target - s.x) * k - s.v * c) * dt; s.x += s.v * dt; return s.x; };
  const sp = (x = 0) => ({ x, v: 0 });
  const deferred = () => { let res; const p = new Promise((r) => (res = r)); p.resolve = res; return p; };

  R.agentPlugin = (k) => {
    const { m, face, PAL, L, th, put, setPx } = k;
    const DARK = PAL[0], EDGE = PAL[Math.max(1, L - 2)], RIM = PAL[L - 1], HOT = PAL[L];
    const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const tcan = document.createElement('canvas');
    const tctx = tcan.getContext('2d');
    let b = null, dying = [], now = 0, W = 800, H = 600, mouthT = 0, mouthMode = null, gestT = 0;
    let tool = null, lastPose = null, lookAt = null, actUntil = 0, typedAt = -9;
    const glyphParts = [];
    // Context handed to tool performances.
    const C = {
      k, PAL, L, th, put, disc: k.disc, sq: k.sq, face, spawn: k.spawn, S: k.S, css,
      get P() { return k.P; }, get R() { return k.R; }, get now() { return now; }, get W() { return W; }, get H() { return H; },
      get bx() { return m.x + (lastPose?.ox ?? 0); }, get by() { return m.y + (lastPose?.oy ?? 0); },
      look: (x, y) => { lookAt = [x, y]; },
      spawnGlyph: (g, x, y) => glyphParts.push({ g, x, y, vy: -60, life: 1 }),
    };

    // Presence: in auto mode the sidekick hides when idle and comes back for anything it has to do.
    const ORDER = ['materialize', 'crt', 'drop'];
    const forcedVariant = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('enter') : null;
    const presence = { auto: false, idle: 3, summonIdle: 9, lastActive: 0, summoned: false, cursor: null, n: 0 };
    let SAFE = R.safe;
    // The visible screen: overlay minus menu bar / Dock / taskbar.
    const bounds = () => ({ l: SAFE.left, t: SAFE.top, r: W - SAFE.right, b: H - SAFE.bottom });

    // Station: the sidekick keeps a home spot and idles around it. When the cursor works nearby it
    // scoots to the closest spot that's clear of the cursor; dropping it somewhere makes that home.
    const station = { x: null, y: null, flee: 0, moving: false, quietUntil: 0, held: false };
    // Teach mode: fly next to a control, point at it, light it up, say the step. One at a time.
    let guide = null;
    const AVOID = () => k.R * 5;
    const spotOK = (x, y) => {
      const S = bounds(), r = k.R;
      return x >= S.l + r * 1.6 && x <= S.r - r * 1.6 && y >= S.t + r * 1.8 && y <= S.b - r * 1.5;
    };
    const pickSpot = (cx, cy, fromX, fromY) => {
      const S = bounds(), r = k.R, c = [];
      const xs = [S.l + r * 2.4, (S.l + S.r) / 2, S.r - r * 2.4], ys = [S.t + r * 2.4, (S.t + S.b) / 2, S.b - r * 1.9];
      for (const x of xs) for (const y of ys) if (x !== xs[1] || y !== ys[1]) c.push([x, y]);
      if (fromX != null) for (const rr of [3.5, 5, 7]) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.push([fromX + Math.cos(a) * rr * r, fromY + Math.sin(a) * rr * r]); }
      const usable = c.filter(([x, y]) => spotOK(x, y));
      const clear = usable.filter(([x, y]) => cx == null || Math.hypot(x - cx, y - cy) >= AVOID());
      // Shortest trip from where it is; the very first spot prefers the bottom-right corner.
      const ref = fromX != null ? [fromX, fromY] : [S.r, S.b];
      if (clear.length) return clear.sort((p, q) => Math.hypot(p[0] - ref[0], p[1] - ref[1]) - Math.hypot(q[0] - ref[0], q[1] - ref[1]))[0];
      if (usable.length && cx != null) return usable.sort((p, q) => Math.hypot(q[0] - cx, q[1] - cy) - Math.hypot(p[0] - cx, p[1] - cy))[0];
      return [(S.l + S.r) / 2, (S.t + S.b) / 2];
    };
    const setStation = (x, y) => { station.x = x; station.y = y; m.anchor = { x, y, r: k.R * 0.35 }; };
    const nextVariant = () => (ORDER.includes(forcedVariant) ? forcedVariant : ORDER[presence.n++ % ORDER.length]);
    const visible = () => k.presence === 'shown' || k.presence === 'in';
    // Bubbles and tools wait until the body has (nearly) arrived.
    const stage = () => k.presence === 'shown' || (k.presence === 'in' && k.presU > 0.72);
    // Appear at home, unless the cursor is there now: then at the nearest spot that's clear of it.
    const spot = () => {
      const [cx, cy] = presence.cursor ?? [null, null];
      const clearOf = (x, y) => cx == null || Math.hypot(x - cx, y - cy) >= AVOID();
      if (station.x != null && spotOK(station.x, station.y) && clearOf(station.x, station.y)) return [station.x, station.y];
      const p = pickSpot(cx, cy, station.x, station.y);
      setStation(p[0], p[1]);
      return p;
    };
    const ensureShown = () => {
      presence.lastActive = now;
      if (visible()) return;
      const [x, y] = spot();
      k.appear(nextVariant(), x, y);
    };
    const MAX_COLS = 36, MAX_LINES = 6, THINK_COLS = 28, THINK_LINES = 2, METER = 7;
    const T = () => clamp(k.P * 0.42, 1.4, 2.4);

    const make = (kind) => ({
      kind, text: '', lines: [{ start: 0, s: '' }], shown: 0, at: [], ended: false, age: 0, wait: 0,
      x: sp(m.x - 40), y: sp(m.y - k.R * 2), w: sp(k.P * 6), h: sp(k.P * 4), pop: sp(0), cloud: sp(kind === 'thought' ? 1 : 0),
      scroll: sp(0), follow: true, expanded: false, closing: 0, dwell: 0, hover: false, trail: 0, mood: null,
      tail: { x: sp(m.x), y: sp(m.y) }, below: false, closed: deferred(), revealed: deferred(), speed: kind === 'thought' ? 75 : 38,
    });

    const handle = (bb) => ({
      append(s) { if (!bb.ended) { bb.text += s; bb.lines = wrap(bb.text, bb.kind === 'thought' ? THINK_COLS : MAX_COLS); } return this; },
      end() { bb.ended = true; return this; },
      get closed() { return bb.closed; },
      get revealed() { return bb.revealed; },
    });

    const open = (kind, text, opts = {}) => {
      if (b && kind === 'speech' && b.kind === 'thought' && !b.closing) {
        // Morph the thought cloud straight into the speech bubble.
        b.kind = 'speech'; b.text = ''; b.lines = [{ start: 0, s: '' }]; b.shown = 0; b.at = []; b.ended = false;
        b.speed = 38; b.scroll = sp(0); b.follow = true; b.dwell = 0; b.wait = 0.12;
        const old = b.closed; b.closed = deferred(); b.revealed = deferred(); old.resolve();
        b.pop.v += 4;
      } else {
        if (b) close(b);
        b = make(kind);
        const tip = tipPoint();
        b.x.x = tip.x - k.P * 4; b.y.x = tip.y - k.P * 6; b.tail.x.x = tip.x; b.tail.y.x = tip.y;
        k.S('pop');
      }
      b.mood = opts.mood ?? null;
      // point: hand target in body radii (e.g. [0.3, -1.6] points up) held while the bubble is open.
      b.point = opts.point ?? null;
      if (b.mood === 'happy') face.set('happy', 0.9);
      const h = handle(b);
      if (text) h.append(text);
      if (!opts.stream) h.end();
      return h;
    };

    const close = (bb) => {
      if (bb.closing) return;
      bb.closing = 0.0001;
      dying.push(bb);
      if (b === bb) b = null;
      k.S('poof');
      const gx0 = bb.x.x, gy0 = bb.y.x;
      for (let i = 0; i < 26; i++) k.spawn(gx0 + Math.random() * bb.w.x, gy0 + Math.random() * bb.h.x, (Math.random() - 0.5) * 60, -Math.random() * 80, 260, Math.random() < 0.5 ? L : L - 1, 0, 1.6);
    };

    const tipPoint = () => ({ x: m.x + Math.sign((b?.x.x ?? m.x) + (b?.w.x ?? 0) / 2 - m.x) * k.R * 0.25, y: b?.below ? m.y + k.R * 0.95 : m.y - k.R * 1.02 });

    // ---- layout targets ----
    const innerSize = (bb) => {
      const t = T();
      if (bb.kind === 'thought' && !bb.text) return { cols: 7, rows: 1, w: 7 * CW * t, h: CH * t };
      const maxCols = bb.kind === 'thought' ? THINK_COLS : bb.expanded ? Math.min(64, Math.floor((W - 80) / (CW * t))) : MAX_COLS;
      const maxRows = bb.kind === 'thought' ? THINK_LINES : bb.expanded ? Math.max(MAX_LINES, Math.floor((H * 0.62) / (CH * t))) : MAX_LINES;
      if (bb.input) {
        const src = bb.text ? bb.lines : wrap(bb.input.placeholder || ' ', MAX_COLS);
        // A live transcript arrives in jumps, so its bubble is full width from the start and only grows down.
        let cols = bb.input.listen ? MAX_COLS : 18;
        for (const l of src) cols = Math.max(cols, Math.min(l.s.length + 1, MAX_COLS));
        const rows = clamp(src.length, 1, MAX_LINES);
        const meter = bb.input.listen ? (METER + 1) * k.P : 0;
        return { cols, rows, maxRows: MAX_LINES, w: cols * CW * t, h: rows * CH * t + meter };
      }
      const shownLines = bb.lines.filter((l) => l.start < Math.max(1, bb.shown) || l === bb.lines[0]);
      let cols = 4;
      for (const l of (bb.expanded ? bb.lines : shownLines)) cols = Math.max(cols, Math.min(l.s.length, maxCols));
      if (bb.lines.length > 1) cols = Math.max(cols, Math.min(maxCols, 18));
      const rows = clamp(bb.expanded ? bb.lines.length : shownLines.length, 1, maxRows);
      return { cols, rows, maxRows, w: cols * CW * t, h: rows * CH * t };
    };

    const pad = () => k.P * 3;

    const step = (bb, dt, env) => {
      bb.age += dt;
      const P = k.P;
      // reveal
      if (bb.wait > 0) bb.wait -= dt;
      else if (bb.shown < bb.text.length) {
        const backlog = bb.text.length - bb.shown;
        const speed = bb.speed * (backlog > 120 ? 3 : backlog > 50 ? 1.6 : 1) * (bb.expanded ? 3 : 1);
        const before = Math.floor(bb.shown);
        bb.shown = Math.min(bb.text.length, bb.shown + speed * dt);
        for (let i = before; i < Math.floor(bb.shown); i++) {
          bb.at[i] = now;
          const ch = bb.text[i];
          if (bb.kind === 'speech') {
            if ('.!?'.includes(ch)) bb.wait = 0.2; else if (ch === ',') bb.wait = 0.08; else if (ch === '\n') bb.wait = 0.25;
            if (ch === '!') { k.sq.kick(3); bb.pop.v += 2.5; }
            if (/[aeiouy]/i.test(ch)) k.S('blip', 0.85 + (ch.charCodeAt(0) % 7) * 0.06);
            mouthMode = /[aeiouAEIOU]/.test(ch) ? (/[oO]/.test(ch) ? 'talk2' : 'talk1') : /\s/.test(ch) ? null : 'flat';
            mouthT = 0.09;
          } else if (i % 9 === 0) k.S('tick');
          if (bb.wait) break;
        }
      } else if (bb.text.length && Math.floor(bb.shown) >= bb.text.length) {
        bb.revealed.resolve();
      }
      const done = bb.ended && bb.shown >= bb.text.length;
      const inner = innerSize(bb);
      const tw = Math.ceil((inner.w + pad() * 2) / P) * P, thh = Math.ceil((inner.h + pad() * 2) / P) * P;
      // Input bubbles track their text tightly (near-critical damping) so new lines never outrun the frame.
      const [sk, sc] = bb.input ? [460, 42] : [190, 15];
      spring(bb.w, tw, sk, sc, dt); spring(bb.h, thh, sk, sc, dt);
      spring(bb.pop, bb.closing ? 0 : 1, 240, 15, dt);
      spring(bb.cloud, bb.kind === 'thought' ? 1 : 0, 120, 13, dt);
      // scroll: follow the newest line while speaking
      const totalLines = bb.lines.filter((l) => l.start <= bb.shown).length;
      const maxScroll = Math.max(0, (bb.expanded ? bb.lines.length : totalLines) - inner.rows);
      if (bb.follow) bb.scrollTarget = maxScroll;
      bb.scrollTarget = clamp(bb.scrollTarget ?? 0, 0, Math.max(0, bb.lines.length - inner.rows));
      spring(bb.scroll, bb.scrollTarget, bb.input ? 300 : 120, bb.input ? 34 : 18, dt);
      bb.overflow = bb.lines.length > inner.rows;
      bb.rows = inner.rows; bb.cols = inner.cols;
      // Placement: above the head, else below, else beside; always fully inside the visible screen.
      const S = bounds(), edge = P * (bb.cloud.x > 0.05 ? 5 : 2);
      const gap = (k.R * 0.5 + P * 2) * (bb.cloud.x > 0.5 ? 1.9 : 1);
      const lift = bb.kind === 'speech' && tool?.def.head ? tool.def.head * k.R : 0; // room for props above the head
      const w = bb.w.x, h = bb.h.x, L0 = S.l + edge, T0 = S.t + edge, R0 = S.r - edge, B0 = S.b - edge;
      const skew = clamp((m.x - W / 2) * -0.15, -w * 0.3, w * 0.3);
      const place = {
        above: { x: m.x - w / 2 + skew, y: m.y - k.R * 1.1 - gap - lift - h },
        below: { x: m.x - w / 2 + skew, y: m.y + k.R * 1.1 + gap },
        right: { x: m.x + k.R * 1.2 + gap, y: m.y - k.R * 0.35 - h / 2 },
        left: { x: m.x - k.R * 1.2 - gap - w, y: m.y - k.R * 0.35 - h / 2 },
      };
      const fits = (sd, slack = 0) => {
        const c = place[sd];
        return sd === 'above' || sd === 'below' ? c.y >= T0 - slack && c.y + h <= B0 + slack : c.x >= L0 - slack && c.x + w <= R0 + slack;
      };
      const roomRight = m.x < (S.l + S.r) / 2;
      // Keep the current side while it still fits, so the bubble doesn't flicker between sides.
      if (!bb.side || !fits(bb.side, P * 2)) {
        bb.side = ['above', 'below', roomRight ? 'right' : 'left', roomRight ? 'left' : 'right'].find((sd) => fits(sd))
          ?? (m.y - T0 > B0 - m.y ? 'above' : 'below');
      }
      bb.below = bb.side === 'below';
      const tgt = place[bb.side], maxX = Math.max(L0, R0 - w), maxY = Math.max(T0, B0 - h);
      spring(bb.x, clamp(tgt.x, L0, maxX), 70, 11, dt); spring(bb.y, clamp(tgt.y, T0, maxY), 70, 11, dt);
      // Hard clamp after the spring: lag or overshoot must never push it past the edge.
      bb.x.x = clamp(bb.x.x, L0, maxX); bb.y.x = clamp(bb.y.x, T0, maxY);
      const beside = bb.side === 'left' || bb.side === 'right';
      const tip = beside
        ? { x: m.x + (bb.side === 'right' ? 1 : -1) * k.R * 0.92, y: m.y - k.R * 0.25 }
        : { x: m.x + clamp((bb.x.x + w / 2 - m.x) * 0.25, -k.R * 0.4, k.R * 0.4), y: bb.below ? m.y + k.R * 0.95 : m.y - k.R * 0.98 };
      spring(bb.tail.x, tip.x, 90, 9, dt); spring(bb.tail.y, tip.y, 90, 9, dt);
      bb.trail = clamp(bb.trail + dt * (bb.kind === 'thought' ? 3 : -4), 0, 1);
      // lifetime
      if (bb.closing) { bb.closing += dt; return; }
      if (done) {
        if (!bb.hover && !bb.expanded) bb.dwell += dt;
        const linger = clamp(2.2 + bb.text.length * 0.03, 2.6, bb.overflow ? 16 : 9);
        if (bb.kind === 'speech' && bb.dwell > linger) close(bb);
        if (bb.kind === 'thought' && bb.dwell > 0.4) close(bb);
      }
    };

    // ---- grid drawing (bubble chrome lives on the LED grid) ----
    const shapeFn = (bb, x0, y0, x1, y1) => {
      const cr = 2, ix0 = x0 + cr, ix1 = x1 - cr, iy0 = y0 + cr, iy1 = y1 - cr;
      const cloud = bb.cloud.x, rb = 2.6 * cloud, bumps = [];
      if (cloud > 0.05) {
        const nx = Math.max(2, Math.round((x1 - x0) / 5)), ny = Math.max(1, Math.round((y1 - y0) / 5));
        for (let i = 0; i <= nx; i++) { const x = lerp(x0 + 1, x1 - 1, i / nx); bumps.push([x, y0 + 0.6, rb + (i % 2) * 0.8 * cloud], [x, y1 - 0.6, rb + ((i + 1) % 2) * 0.8 * cloud]); }
        for (let j = 1; j < ny; j++) { const y = lerp(y0 + 1, y1 - 1, j / ny); bumps.push([x0 + 0.6, y, rb], [x1 - 0.6, y, rb]); }
      }
      return (x, y, grow) => {
        const dx = Math.max(ix0 - x, 0, x - ix1), dy = Math.max(iy0 - y, 0, y - iy1);
        if (dx * dx + dy * dy <= (cr + grow) * (cr + grow)) return true;
        for (const [bx, by, r] of bumps) if ((x - bx) ** 2 + (y - by) ** 2 <= (r + grow) ** 2) return true;
        return false;
      };
    };

    const drawBubbleGrid = (bb) => {
      const P = k.P;
      const fade = bb.closing ? clamp(1 - bb.closing / 0.3, 0, 1) : clamp(bb.age / 0.22, 0, 1);
      if (fade <= 0) return;
      const pop = clamp(bb.pop.x, 0, 1.08);
      const beside = bb.side === 'left' || bb.side === 'right';
      const ax = beside ? (bb.side === 'right' ? bb.x.x : bb.x.x + bb.w.x) : bb.tail.x.x;
      const ay = beside ? clamp(bb.tail.y.x, bb.y.x, bb.y.x + bb.h.x) : bb.below ? bb.y.x : bb.y.x + bb.h.x;
      const X = (v) => ax + (v - ax) * pop, Y = (v) => ay + (v - ay) * pop;
      const x0 = Math.round(X(bb.x.x) / P), y0 = Math.round(Y(bb.y.x) / P);
      const x1 = Math.round(X(bb.x.x + bb.w.x) / P) - 1, y1 = Math.round(Y(bb.y.x + bb.h.x) / P) - 1;
      if (x1 - x0 < 3 || y1 - y0 < 2) return;
      const inside = shapeFn(bb, x0, y0, x1, y1);
      const on = (gx, gy) => th(gx, gy) < fade;
      // tail: a tapered, lagging pixel wedge (speech) or rising beads (thought)
      const tbx = beside ? (bb.side === 'right' ? x0 : x1) : clamp(bb.tail.x.x, X(bb.x.x) + P * 4, X(bb.x.x + bb.w.x) - P * 4) / P;
      const tby = beside ? clamp(bb.tail.y.x / P, y0 + 3, y1 - 3) : bb.below ? y0 : y1;
      const tipx = bb.tail.x.x / P, tipy = bb.tail.y.y === undefined ? bb.tail.y.x / P : bb.tail.y.x / P;
      const beads = [];
      const speechTail = 1 - bb.cloud.x;
      if (speechTail > 0.05) {
        const n = Math.max(4, Math.ceil(Math.hypot(tipx - tbx, tipy - tby)));
        const cxp = lerp(tbx, tipx, 0.5) + (bb.tail.x.v || 0) * -0.004, cyp = lerp(tby, tipy, 0.5);
        for (let i = 0; i <= n; i++) {
          const u = i / n, a = (1 - u) * (1 - u), bq = 2 * (1 - u) * u, c = u * u;
          beads.push([a * tbx + bq * cxp + c * tipx, a * tby + bq * cyp + c * tipy, lerp(2.4, 0.5, u) * speechTail]);
        }
      }
      if (bb.cloud.x > 0.05) {
        const tr = bb.trail;
        [[0.25, 1.9], [0.55, 1.3], [0.82, 0.8]].forEach(([u, r], i) => {
          if (tr < i * 0.3) return;
          const bob = Math.sin(now * 4 - i * 0.9) * 0.5;
          beads.push([lerp(tbx, tipx, u), lerp(tby + (bb.below ? -2 : 2), tipy, u) + bob, r * bb.cloud.x, true]);
        });
      }
      const disc = (cx, cy, r, lvl, solidLvl, pass) => {
        const rr = Math.ceil(r + 1);
        for (let yy = -rr; yy <= rr; yy++) for (let xx = -rr; xx <= rr; xx++) {
          const gx = Math.round(cx) + xx, gy = Math.round(cy) + yy, d2 = (gx - cx) ** 2 + (gy - cy) ** 2;
          if (!on(gx, gy)) continue;
          if (pass === 0 && d2 <= (r + 1) ** 2) setPx(gx, gy, EDGE, 255);
          if (pass === 1 && d2 <= r * r) setPx(gx, gy, DARK, 235, true);
        }
      };
      // pass 0: tail and body borders; pass 1: fills, so the tail joins the bubble seamlessly
      for (const [cx, cy, r, free] of beads) if (!free) disc(cx, cy, r, 0, 0, 0);
      const ex = bb.cloud.x > 0.05 ? 5 : 2;
      for (let gy = y0 - ex; gy <= y1 + ex; gy++) for (let gx = x0 - ex; gx <= x1 + ex; gx++)
        if (on(gx, gy) && inside(gx, gy, 1) && !inside(gx, gy, 0)) setPx(gx, gy, EDGE, 255);
      for (const [cx, cy, r, free] of beads) if (free) disc(cx, cy, r, 0, 0, 0);
      for (const [cx, cy, r] of beads) disc(cx, cy, r, 0, 0, 1);
      for (let gy = y0 - ex; gy <= y1 + ex; gy++) for (let gx = x0 - ex; gx <= x1 + ex; gx++) {
        if (!on(gx, gy) || !inside(gx, gy, 0)) continue;
        const glass = gy - y0 < 1 && gx - x0 > 2 && gx - x0 < 6;
        setPx(gx, gy, glass ? RIM : DARK, 235, true);
      }
      // running light around the rim while text is arriving
      const streaming = bb.shown < bb.text.length || (bb.kind === 'thought' && !bb.closing) || (bb.input?.focused && !bb.input.processing && !bb.closing);
      if (streaming && bb.cloud.x < 0.5) {
        const pw = x1 - x0, ph = y1 - y0, per = 2 * (pw + ph);
        for (let j = 0; j < 4; j++) {
          let q = (Math.floor(now * 28) - j * 1 + per * 10) % per, gx, gy;
          if (q < pw) { gx = x0 + q; gy = y0 - 1; } else if ((q -= pw) < ph) { gx = x1 + 1; gy = y0 + q; } else if ((q -= ph) < pw) { gx = x1 - q; gy = y1 + 1; } else { q -= pw; gx = x0 - 1; gy = y1 - q; }
          if (inside(gx, gy, 1)) setPx(gx, gy, j === 0 ? HOT : RIM, 255);
        }
      }
      bb.grid = { x0, y0, x1, y1 };
      const ip = Math.round(pad() / P);
      // thinking dots
      if (bb.kind === 'thought' && !bb.text && fade > 0.5) {
        const cy = Math.round((y0 + y1) / 2), cx = Math.round((x0 + x1) / 2);
        for (let i = -1; i <= 1; i++) {
          const lit = Math.floor(now * 5) % 3 === i + 1;
          const lift = lit ? -1 : 0;
          for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) put(cx + i * 4 + xx - 1, cy + yy - 1 + lift, lit ? L : L - 2);
        }
      }
      // listening: scrolling LED waveform of the voice level, a sweep while the transcript finalises
      if (bb.input?.listen) {
        const inp = bb.input, bot = y1 - ip + 1, top = bot - METER + 1, xa = x0 + ip, xb = x1 - ip;
        const n = Math.max(1, Math.floor((xb - xa) / 2) + 1);
        while (inp.levels.length < n) inp.levels.unshift(0);
        if (inp.levels.length > n) inp.levels.splice(0, inp.levels.length - n);
        for (let i = 0; i < n; i++) {
          const gx = xa + i * 2;
          let v = inp.levels[i];
          if (inp.processing) v = 0.15 + 0.7 * Math.max(0, Math.sin(now * 9 - i * 0.55)) ** 3;
          const h = Math.max(1, Math.round(v * METER));
          for (let j = 0; j < METER; j++) {
            const gy = bot - j;
            if (j < h) put(gx, gy, j === h - 1 ? L : j >= METER - 2 ? L : L - 1);
            else if (j === 0) put(gx, gy, 1);
          }
        }
        void top;
      }
      // scrollbar and "more" chevron for long text
      if (bb.overflow && bb.kind === 'speech') {
        const bx = x1 - 1, top = y0 + ip, bot = y1 - ip, len = bot - top;
        const total = bb.lines.length, frac = bb.rows / total, pos = bb.scroll.x / Math.max(1, total - bb.rows);
        const tl = Math.max(2, Math.round(len * frac)), t0 = top + Math.round((len - tl) * clamp(pos, 0, 1));
        for (let gy = top; gy <= bot; gy++) put(bx, gy, gy >= t0 && gy < t0 + tl ? L - 1 : 1);
        const atEnd = bb.scroll.x >= total - bb.rows - 0.05;
        if (!atEnd || !bb.ended) {
          const cx = Math.round((x0 + x1) / 2), cy = y1 - 1 + (Math.sin(now * 6) > 0 ? 1 : 0);
          if (bb.ended) { put(cx - 2, cy - 1, L); put(cx - 1, cy, L); put(cx, cy + 1 - 1, L); put(cx + 1, cy, L); put(cx + 2, cy - 1, L); }
        }
      }
    };

    // ---- fine dot-matrix text layer ----
    const drawText = (ctx, env, bb) => {
      const ph = bb.input && !bb.text;
      if (!bb.grid || (!bb.text && !bb.input)) return;
      const P = k.P, t = T(), dpr = env.dpr || 1;
      const fade = bb.closing ? clamp(1 - bb.closing / 0.25, 0, 1) : clamp((bb.age - 0.08) / 0.2, 0, 1);
      if (fade <= 0 || bb.pop.x < 0.6) return;
      const ix = bb.grid.x0 * P + pad() - P * 0.5, iy = bb.grid.y0 * P + pad() - P * 0.5;
      const iw = bb.cols * CW * t, ih = bb.rows * CH * t;
      const cw = Math.ceil(iw * dpr) + 2, chh = Math.ceil(ih * dpr) + 2;
      if (tcan.width !== cw || tcan.height !== chh) { tcan.width = cw; tcan.height = chh; }
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tctx.clearRect(0, 0, iw + 2, ih + 2);
      const dim = bb.kind === 'thought' || ph;
      const paths = [new Path2D(), new Path2D(), new Path2D()];
      const lines = ph ? wrap(bb.input.placeholder || '', MAX_COLS) : bb.lines;
      const emojiDots = [];
      const s0 = ph ? 0 : bb.scroll.x, first = Math.max(0, Math.floor(s0)), last = Math.min(lines.length - 1, first + bb.rows);
      const dot = t * 0.82, shown = ph ? 1e9 : Math.floor(bb.shown);
      const shownLines = lines.filter((l) => l.start < shown).length;
      const fadeTop = s0 > 0.02, fadeBot = s0 + bb.rows < shownLines - 0.02;
      for (let li = first; li <= last; li++) {
        const line = lines[li], ly = (li - s0) * CH;
        for (let j = 0; j < line.s.length; j++) {
          const idx = line.start + j;
          if (idx >= shown) break;
          const ch = line.s[j];
          if (ch === ' ') continue;
          const em = emojiAt(line.s, j);
          if (em) {
            const eg = idx + em.n <= shown || ph ? emojiGlyph(em.cluster) : null;
            if (eg) for (let q = 0; q < eg.length; q += 5) {
              const py = ly + eg[q + 1];
              if (py < -0.5 || py > bb.rows * CH - 0.5) continue;
              emojiDots.push(j * CW + eg[q], py, eg[q + 2], eg[q + 3], eg[q + 4]);
            }
            j += em.n - 1;
            continue;
          }
          const g = glyph(ch), age = ph ? 9 : now - (bb.at[idx] ?? 0);
          const fresh = age < 0.08, drop = fresh ? -0.6 : 0;
          for (let q = 0; q < g.length; q += 3) {
            const py = ly + g[q + 1] + drop;
            if (py < -0.5 || py > bb.rows * CH - 0.5) continue;
            const edgeA = Math.min(1, fadeTop ? ((py + 1) / CH) * 1.6 : 1, fadeBot ? ((bb.rows * CH - py) / CH) * 1.6 : 1);
            const gx = j * CW + g[q];
            if (edgeA < 1 && th(gx, Math.round(py)) > edgeA) continue;
            if (fade < 1 && th(gx + 7, Math.round(py) + 3) > fade) continue;
            const lvl = fresh ? 0 : dim ? 2 : g[q + 2] === 2 ? 1 : 2;
            paths[lvl].rect(gx * t, py * t, dot, dot);
          }
        }
      }
      if (bb.input?.focused && !bb.input.listen && Math.floor((now - bb.input.caretAt) * 2.2) % 2 === 0) {
        // caret after the last typed character (or at the start, over the placeholder)
        let li = 0, col = 0;
        if (bb.text) { li = bb.lines.length - 1; col = Math.min(bb.lines[li].s.length, bb.text.length - bb.lines[li].start); }
        if (col >= bb.cols) col = bb.cols - 1;
        const cy = (li - s0) * CH;
        if (cy > -1 && cy < bb.rows * CH) paths[1].rect((col * CW + 0.5) * t, (cy + 0.5) * t, dot * 1.1, (CH - 1.5) * t);
      }
      tctx.fillStyle = '#ffffff'; tctx.fill(paths[0]);
      tctx.fillStyle = css(dim ? PAL[L - 2] : HOT); tctx.fill(paths[1]);
      tctx.fillStyle = css(dim ? PAL[L - 2] : RIM, dim ? 0.85 : 0.75); tctx.fill(paths[2]);
      for (let q = 0; q < emojiDots.length; q += 5) {
        tctx.fillStyle = `rgba(${emojiDots[q + 2]},${emojiDots[q + 3]},${emojiDots[q + 4]},${dim ? 0.6 : 1})`;
        tctx.fillRect(emojiDots[q] * t, emojiDots[q + 1] * t, dot, dot);
      }
      // Clip to the frame as it is this instant: it may still be growing, or shrinking away on close.
      const ip = Math.round(pad() / P), meterCells = bb.input?.listen ? METER + 1 : 0;
      const cx1 = (bb.grid.x1 + 1 - ip) * P + P * 0.5, cy1 = (bb.grid.y1 + 1 - ip - meterCells) * P + P * 0.5;
      const cwid = Math.min(iw + t, cx1 - ix), chgt = Math.min(ih + t, cy1 - iy);
      if (cwid <= t || chgt <= t) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(ix, iy, cwid, chgt); ctx.clip();
      ctx.shadowColor = css(RIM, 0.7); ctx.shadowBlur = t * 3;
      ctx.drawImage(tcan, 0, 0, cw, chh, ix, iy, cw / dpr, chh / dpr);
      ctx.restore();
    };

    // ---- tool chip: an LED tag under the blob with a spinner, label and progress ----
    const chipGeom = (st) => {
      const t = T(), P = k.P, text = (st.label + (st.detail ? '  ' + st.detail : '')).slice(0, 34);
      const w = Math.ceil((text.length * CW * t + P * 9) / P), h = Math.ceil((CH * t + P * 3) / P);
      const S = bounds(), below = !b || b.side !== 'below';
      const cy = below ? m.y + k.R * 1.32 : m.y - k.R * 1.5 - h * P;
      const x0 = Math.round(clamp(m.x - (w * P) / 2, S.l + 8, S.r - w * P - 8) / P), y0 = Math.round(clamp(cy, S.t + 8, S.b - h * P - 8) / P);
      return { text, w, h, x0, y0, t };
    };
    const drawChip = (st) => {
      const g = chipGeom(st), pop = clamp(st.age / 0.15, 0, 1) * (1 - clamp((st.out - 0.5) / 0.35, 0, 1));
      if (pop <= 0) return;
      const { x0, y0, w, h } = g;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if ((x === 0 || x === w - 1) && (y === 0 || y === h - 1)) continue;
        if (th(x0 + x, y0 + y) > pop) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        setPx(x0 + x, y0 + y, edge ? EDGE : DARK, 235, !edge);
      }
      const cx = x0 + 3, cy = y0 + Math.floor(h / 2);
      if (!st.status) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2, lit = (Math.floor(now * 14) - i + 80) % 8;
          put(cx + Math.round(Math.cos(a) * 1.6), cy + Math.round(Math.sin(a) * 1.6), lit < 3 ? L - lit : 1);
        }
      } else if (st.status === 'ok') { put(cx - 1, cy, L); put(cx, cy + 1, L); put(cx + 1, cy, L); put(cx + 2, cy - 1, L); }
      else { put(cx - 1, cy - 1, L); put(cx + 1, cy + 1, L); put(cx, cy, L); put(cx + 1, cy - 1, L); put(cx - 1, cy + 1, L); }
      if (st.p != null) for (let x = 6; x < w - 2; x++) put(x0 + x, y0 + h - 2, x - 6 < (w - 8) * st.p ? L - 1 : 1);
    };
    const drawChipText = (ctx, env, st) => {
      const g = chipGeom(st), t = g.t, P = k.P, pop = clamp((st.age - 0.08) / 0.15, 0, 1) * (1 - clamp((st.out - 0.45) / 0.3, 0, 1));
      if (pop <= 0) return;
      const x = (g.x0 + 6) * P, y = (g.y0 * P) + (g.h * P - CH * t) / 2 + t * 0.5;
      const p1 = new Path2D(), p2 = new Path2D(), split = st.label.length;
      const chipEmoji = [];
      for (let j = 0; j < g.text.length; j++) {
        const em = emojiAt(g.text, j);
        if (em) {
          const eg = emojiGlyph(em.cluster);
          if (eg) for (let q = 0; q < eg.length; q += 5) chipEmoji.push(x + (j * CW + eg[q]) * t, y + eg[q + 1] * t, eg[q + 2], eg[q + 3], eg[q + 4]);
          j += em.n - 1;
          continue;
        }
        const gl = glyph(g.text[j]);
        for (let q = 0; q < gl.length; q += 3) (j < split ? p1 : p2).rect(x + (j * CW + gl[q]) * t, y + gl[q + 1] * t, t * 0.82, t * 0.82);
      }
      ctx.save();
      ctx.globalAlpha = pop;
      ctx.shadowColor = css(RIM, 0.7); ctx.shadowBlur = t * 3;
      ctx.fillStyle = css(HOT); ctx.fill(p1);
      ctx.fillStyle = css(PAL[L - 2]); ctx.fill(p2);
      for (let q = 0; q < chipEmoji.length; q += 5) { ctx.fillStyle = `rgb(${chipEmoji[q + 2]},${chipEmoji[q + 3]},${chipEmoji[q + 4]})`; ctx.fillRect(chipEmoji[q], chipEmoji[q + 1], t * 0.82, t * 0.82); }
      ctx.restore();
    };

    const hitBubble = (bb, x, y) => bb && !bb.closing && x >= bb.x.x && x <= bb.x.x + bb.w.x && y >= bb.y.x && y <= bb.y.x + bb.h.x;

    const api = {
      say: (text, opts) => { ensureShown(); return open('speech', text, opts); },
      think: (text, opts = {}) => {
        ensureShown();
        const h = open('thought', text, { ...opts, stream: true });
        if (!opts.quiet) k.S('hmm');
        if (opts.dur) setTimeout(() => { h.end(); }, opts.dur * 1000);
        return h;
      },
      hush: () => { if (b) close(b); },
      // Act out an emote (wave, hype, upset, remind, motivate). Skipped while a tool is on stage.
      act: (name) => { if (tool) return false; ensureShown(); actUntil = now + (k.presence === 'in' ? 4.2 : 3.3); k.startAct(name); return true; },
      show: ({ summoned = false, variant } = {}) => {
        presence.lastActive = now; presence.summoned = summoned;
        if (visible()) return false;
        const [x, y] = spot();
        return k.appear(variant ?? nextVariant(), x, y);
      },
      hide: ({ instant = false, variant } = {}) => {
        if (b) close(b);
        if (tool) tool.finish(true);
        presence.summoned = false;
        return k.vanish(instant ? null : variant ?? nextVariant(), instant);
      },
      toggle: () => (visible() ? api.hide() : api.show({ summoned: true })),
      // First-run hello: drop in from the menu bar right under the tray icon (x in overlay px) and point up at it.
      intro: (x, text) => {
        // The raised hand (not the body) goes under the icon: the hand reaches HAND_DX radii right of
        // the body, so the body sits that much to the left. Near the right edge it can't, so it shifts
        // and the hand angles over instead.
        const S = bounds(), r = k.R, HAND_DX = 0.35;
        const px = clamp(x - HAND_DX * r, S.l + r * 1.7, S.r - r * 1.7), py = S.t + r * 2.1;
        const reach = clamp((x - px) / r, -1.2, 1.2);
        if (visible()) k.vanish(null, true);
        setStation(px, py);
        presence.summoned = true; presence.lastActive = now;
        k.appear('drop', px, py);
        return api.say(text, { mood: 'happy', point: [reach, -1.75] });
      },
      // Make (x, y) home and move there now, e.g. to restore where the user last left it.
      // rect: [x, y, w, h] in overlay px. Resolves when the Sidekick has arrived and the step is showing.
      point: ({ rect, say: text, step, of, label }) => {
        ensureShown();
        const [rx, ry, rw, rh] = rect, cx = rx + rw / 2, cy = ry + rh / 2, R0 = k.R, S = bounds();
        // Stand beside the target on whichever side has room (prefer the right), a little below it,
        // so the raised mitt reaches it and the speech bubble doesn't cover it.
        const room = { right: S.r - (rx + rw), left: rx - S.l, below: S.b - (ry + rh), above: ry - S.t };
        const side = room.right > R0 * 3.4 ? 'right' : room.left > R0 * 3.4 ? 'left' : room.below > R0 * 3.4 ? 'below' : 'above';
        const off = R0 * 2.3;
        let px = side === 'right' ? rx + rw + off : side === 'left' ? rx - off : cx;
        let py = side === 'below' ? ry + rh + off : side === 'above' ? ry - off : cy + R0 * 0.6;
        px = clamp(px, S.l + R0 * 1.6, S.r - R0 * 1.6); py = clamp(py, S.t + R0 * 1.8, S.b - R0 * 1.5);
        // Hand target in body radii, pointing from the body toward the control's near edge.
        const tx = clamp(cx, rx + 6, rx + rw - 6), ty = clamp(cy, ry + 6, ry + rh - 6);
        let hx = (tx - px) / R0, hy = (ty - py) / R0;
        const len = Math.hypot(hx, hy) || 1, reach = Math.min(len, 1.7);
        hx = (hx / len) * reach; hy = (hy / len) * reach;
        if (guide?.bubble) guide.bubble.end?.();
        const g = { rect, tx, ty, hand: [hx, hy], px, py, text, step, of, label, started: now, arrived: false, done: deferred() };
        guide = g;
        setStation(px, py); m.goTo(px, py); station.moving = true; station.quietUntil = now + 30;
        presence.summoned = true; presence.lastActive = now;
        k.S('pip');
        return g.done;
      },
      endGuide: () => { if (guide) { guide.bubble?.end?.(); guide = null; station.quietUntil = now + 1; } },
      place: (x, y) => {
        setStation(x, y); m.x = x; m.y = y; m.vx = m.vy = 0; m.mode = 'rest'; m.rest = 1;
        station.moving = false; station.flee = 0; station.quietUntil = now + 1;
      },
      setAuto: (on, idle) => { presence.auto = !!on; if (idle) presence.idle = idle; presence.lastActive = now; },
      get visible() { return visible(); },
      get station() { return { ...station }; },
      get presence() { return k.presence; },
      // A listening bubble: live transcript plus a voice meter. set() takes the latest transcript.
      listen: (opts = {}) => {
        ensureShown();
        const h = open('speech', '', { stream: true });
        const bb = b;
        bb.input = { placeholder: opts.placeholder ?? 'Listening…', focused: true, caretAt: now, listen: true, level: 0, target: 0, levels: [], processing: false };
        bb.wait = 0;
        k.S('listen');
        return {
          set(text) {
            let i = 0;
            while (i < text.length && i < bb.text.length && text[i] === bb.text[i]) i++;
            for (let j = i; j < text.length; j++) bb.at[j] = now;
            bb.text = text; bb.lines = wrap(text, MAX_COLS); bb.shown = text.length;
            return this;
          },
          level(v) { bb.input.target = clamp(v, 0, 1); return this; },
          processing() { bb.input.processing = true; return this; },
          close() { if (b === bb) close(bb); },
          get open() { return b === bb && !bb.closing; },
          get closed() { return h.closed; },
        };
      },
      // An input bubble: the host feeds it keystrokes with set(); it never times out.
      prompt: (opts = {}) => {
        ensureShown();
        const h = open('speech', '', { stream: true });
        const bb = b;
        bb.input = { placeholder: opts.placeholder ?? '', mask: !!opts.mask, focused: true, caretAt: now, onPress: opts.onPress };
        bb.wait = 0;
        return {
          set(value) {
            const v = bb.input.mask ? '•'.repeat(value.length) : value;
            const prev = bb.text.length;
            if (v.length > prev) { k.S('key', 0.9 + Math.random() * 0.25); k.sq.kick(1.2); typedAt = now; }
            else if (v.length < prev) k.S('tick');
            bb.text = v; bb.lines = wrap(v, MAX_COLS); bb.shown = v.length;
            for (let i = prev; i < v.length; i++) bb.at[i] = now;
            bb.input.caretAt = now;
            return this;
          },
          focus(on) { bb.input.focused = on; bb.input.caretAt = now; return this; },
          close() { if (b === bb) close(bb); },
          get closed() { return h.closed; },
        };
      },
      // A status bubble (e.g. download progress): set() replaces the text in place; it stays up until close().
      status: (text) => {
        ensureShown();
        const h = open('speech', text, { stream: true });
        const bb = b;
        return {
          set(t) {
            if (bb.closing || t === bb.text) return this;
            bb.text = t; bb.lines = wrap(t, MAX_COLS); bb.shown = t.length;
            for (let i = 0; i < t.length; i++) bb.at[i] ??= now;
            return this;
          },
          close() { if (b === bb) close(bb); },
          get open() { return b === bb && !bb.closing; },
          get closed() { return h.closed; },
        };
      },
      tool: (name, opts = {}) => {
        const def = R.agentTools?.[name];
        if (!def) throw new Error(`unknown tool ${name}`);
        ensureShown();
        if (tool) tool.finish(true);
        const st = {
          name, def, variant: opts.variant ?? def.variants[0], label: opts.label ?? def.label, detail: opts.detail ?? '',
          age: 0, out: 0, status: null, p: null, d: {}, seed: Math.random() * 999, closed: deferred(),
        };
        st.live = !!opts.live;
        st.finish = (ok = true) => {
          if (st.status) return;
          // Live calls: when the animation reaches its end before the real tool, hold there (spinner keeps going).
          if (st.live && st.real === undefined) { st.parked = true; return; }
          const final = st.live ? st.real && ok : ok;
          st.status = final ? 'ok' : 'fail'; k.S(final ? 'done' : 'error');
        };
        tool = st;
        def.start?.(st, C);
        k.S('toolstart');
        if (opts.dur) setTimeout(() => st.finish(true), opts.dur * 1000);
        const done = (ok = true) => {
          if (!st.live) return st.finish(ok);
          if (st.real !== undefined) return;
          st.real = ok;
          // The terminal plays its own failure beat; every other tool fails on the spot.
          if (!ok && st.name === 'run') { st.variant = 'fail'; return; }
          if (st.parked || !ok) st.finish(ok);
        };
        // target(rect): the real area being worked on (e.g. the window being captured), in overlay px.
        if (opts.rect) { st.target = opts.rect; st.targetName = opts.rectName; }
        return { progress(p) { st.p = p; return this; }, target(rect, name) { st.target = rect; st.targetName = name; st.def.retarget?.(st, C); return this; }, done(ok = true) { done(ok); return this; }, get closed() { return st.closed; }, state: st };
      },
      get busy() { return !!(b || tool); },
      get bubble() { return b; },
    };

    const plugin = {
      api,
      busy: () => !!(b || tool),
      // A bubble is up: emotes keep their gestures but drop icons and particles, so the text stays readable.
      calm: () => !!(b && !b.closing),
      hit: (x, y) => hitBubble(b, x, y),
      press: () => {
        if (!b) return;
        if (b.input) { b.input.onPress?.(); return; }
        if (b.overflow || b.expanded) { b.expanded = !b.expanded; b.follow = false; b.dwell = 0; k.S('expand'); if (!b.expanded) b.scrollTarget = 0; }
        else close(b);
      },
      wheel: (dy) => {
        if (!b) return;
        b.follow = false; b.dwell = 0;
        b.scrollTarget = (b.scrollTarget ?? 0) + dy / 40;
        if (b.scrollTarget >= b.lines.length - b.rows) b.follow = b.ended ? false : true;
      },
      pose: (dt) => {
        lookAt = null;
        if (now < actUntil && !tool) { lastPose = null; return null; }
        const tp = tool ? tool.def.pose(tool, C) : null;
        const bp = bubblePose(dt);
        let p = tp ?? bp;
        if (tp && bp && b?.kind === 'speech' && mouthT > 0) p = { ...tp, mouth: bp.mouth };
        if (tool && tool.status && tool.out > 0.35) p = p && { ...p, arms: tool.out > 0.6 ? 0 : p.arms };
        lastPose = p;
        return p;
      },
    };
    function bubblePose(dt) {
      {
        const t = now;
        if (!b) return null;
        if (b.input?.listen) {
          const lv = b.input.level, wig = Math.sin(t * 7) * 0.04 * lv;
          return {
            arms: 1, tr: [0.98 + wig, -0.42 - lv * 0.08], tl: [-0.62, 0.88 + Math.sin(t * 2) * 0.03],
            ox: k.R * 0.05, oy: -lv * k.R * 0.06, mouth: b.input.processing ? 'o' : 'flat', brow: 'raised',
          };
        }
        if (b.input) {
          const typing = now - typedAt < 0.35, bob = Math.sin(t * 2.2) * 0.03;
          return { arms: 0.8, tl: [-0.42, 0.95 + bob], tr: [0.42, 0.95 - bob], oy: typing ? -k.R * 0.025 : 0, mouth: typing ? 'o' : 'flat', brow: b.text ? null : 'raised' };
        }
        if (b.kind === 'thought') {
          return {
            arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], ox: Math.sin(t * 1.3) * k.R * 0.04,
            mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised',
          };
        }
        const talking = b.shown < b.text.length;
        gestT += dt * (talking ? 1 : 0.3);
        const g = Math.sin(gestT * 3.1), g2 = Math.sin(gestT * 1.7 + 1);
        const brow = b.mood === 'annoyed' ? 'angry' : b.mood === 'concerned' ? 'raised' : b.mood === 'determined' ? 'determined' : null;
        if (b.point) {
          const bob = Math.sin(t * 5) * 0.06;
          return { arms: 1, tr: [b.point[0], b.point[1] + bob], tl: [-0.9, 0.45], mouth: mouthT > 0 ? mouthMode : 'grin', brow: 'raised' };
        }
        return {
          arms: talking ? 1 : 0.4,
          tr: [0.95 + g * 0.08, 0.05 - Math.max(0, g) * 0.35], tl: [-0.98 - g2 * 0.06, 0.25 - Math.max(0, g2) * 0.18],
          oy: talking ? -Math.abs(Math.sin(gestT * 9)) * k.R * 0.03 : 0,
          mouth: mouthT > 0 ? mouthMode : b.mood === 'annoyed' ? 'frown' : null, brow,
        };
      }
    }
    return {
      ...plugin,
      update: (dt, env) => {
        now += dt; W = env.w; H = env.h; SAFE = env.safe ?? R.safe;
        if (guide) {
          presence.lastActive = now;
          const g = guide, d = Math.hypot(m.x - g.px, m.y - g.py);
          if (!g.arrived && (d < k.R * 0.35 || now - g.started > 0.9)) {
            g.arrived = true; g.arrivedAt = now;
            m.x = g.px; m.y = g.py; m.vx = m.vy = 0;
            k.S('ping'); k.sq.kick(6);
            g.bubble = api.say(g.text, { mood: 'happy', point: g.hand });
            setTimeout(() => g.done.resolve(), 400);
          }
          if (g.arrived && now - g.arrivedAt > 45) api.endGuide();
        }
        if (env.mouse?.active || presence.cursor == null) presence.cursor = [env.mouse?.x ?? W / 2, env.mouse?.y ?? H / 2];
        const onStage = stage();
        if (presence.auto) {
          const hover = env.mouse?.active && Math.hypot(env.mouse.x - m.x, env.mouse.y - m.y) < k.R * 1.5;
          const busyNow = b || dying.length || tool || now < actUntil || m.dragging || m.flung || hover || k.presence === 'in';
          if (busyNow) presence.lastActive = now;
          const idleFor = presence.summoned ? presence.summonIdle : presence.idle;
          if (k.presence === 'shown' && now - presence.lastActive > idleFor) { presence.summoned = false; k.vanish(nextVariant()); }
        }
        if (!onStage) {
          // Bubbles closed by hide() still need to finish dissolving (unseen) so their promises settle.
          for (let i = dying.length - 1; i >= 0; i--) { dying[i].closing += dt; if (dying[i].closing > 0.35) { dying[i].closed.resolve(); dying.splice(i, 1); } }
          return;
        }
        mouthT -= dt;
        if (k.presence === 'shown') {
          if (station.x == null) setStation(m.x, m.y);
          const held = m.dragging || m.flung;
          if (held && !station.held) station.from = [m.x, m.y];
          // Dropped somewhere new: that's home now, and the cursor gets a moment to move off.
          // A plain click (press without moving it) isn't a move.
          if (station.held && !held && station.from && Math.hypot(m.x - station.from[0], m.y - station.from[1]) > k.R * 0.5) {
            setStation(m.x, m.y); station.quietUntil = now + 2.5; station.moving = false;
          }
          station.held = held;
          // While pointing at a step, stay put: the user's cursor is supposed to come over here.
          if (!held && env.mouse && !guide) {
            const cx = env.mouse.x, cy = env.mouse.y, dBody = Math.hypot(cx - m.x, cy - m.y);
            // Pointing right at it or its bubble means "I want this"; hovering around it means "you're in my way".
            const onIt = dBody < m.radius * 1.1 || (b && hitBubble(b, cx, cy));
            const pad = k.R * 0.7;
            const nearBubble = b && !b.closing && cx > b.x.x - pad && cx < b.x.x + b.w.x + pad && cy > b.y.x - pad && cy < b.y.x + b.h.x + pad;
            const near = dBody < k.R * 3 || nearBubble;
            station.flee = near && !onIt && now > station.quietUntil ? station.flee + dt : Math.max(0, station.flee - dt * 2);
            if (station.flee > 0.45 && !station.moving) {
              const [x, y] = pickSpot(cx, cy, m.x, m.y);
              k.stopAct?.(); setStation(x, y); m.goTo(x, y);
              station.moving = true; station.flee = 0; k.S('hop'); k.sq.kick(4);
            }
          }
          if (station.moving && Math.hypot(m.x - station.x, m.y - station.y) < k.R * 0.4) { station.moving = false; m.mode = 'rest'; m.rest = 0.6; }
        }
        m.speedMul = station.moving ? 2.6 : b ? (b.kind === 'thought' ? 0.15 : 0.35) : 1;
        if (b?.input?.listen) {
          const inp = b.input;
          inp.level = R.damp(inp.level, inp.target, inp.target > inp.level ? 30 : 8, dt);
          inp.target *= Math.exp(-dt * 3);
          inp.acc = (inp.acc ?? 0) + dt;
          if (inp.acc > 0.045) { inp.acc = 0; inp.levels.push(inp.level); }
        }
        if (b) {
          b.hover = env.mouse.active && hitBubble(b, env.mouse.x, env.mouse.y);
          step(b, dt, env);
          if (b?.input?.listen && !tool) { face.lookX = R.damp(face.lookX, 0.25, 6, dt); face.lookY = R.damp(face.lookY, 0.05, 6, dt); }
          else if (b && (b.kind === 'thought' || b.input) && !tool) { face.lookX = R.damp(face.lookX, clamp((b.x.x + b.w.x / 2 - m.x) / 160, -0.9, 0.9), 6, dt); face.lookY = R.damp(face.lookY, b.below ? 0.8 : -0.85, 6, dt); }
        }
        if (tool) {
          tool.age += dt;
          tool.def.update?.(tool, C, dt);
          if (tool.status) { tool.out += dt; if (tool.out > 0.9) { tool.closed.resolve(); tool = null; } }
        }
        if (lookAt) {
          const dx = lookAt[0] - m.x, dy = lookAt[1] - m.y, dd = Math.hypot(dx, dy) || 1, s = Math.min(1, dd / 120);
          face.lookX = R.damp(face.lookX, (dx / dd) * s, 9, dt); face.lookY = R.damp(face.lookY, (dy / dd) * s, 9, dt);
        }
        for (let i = glyphParts.length - 1; i >= 0; i--) { const g = glyphParts[i]; g.y += g.vy * dt; g.vy *= 0.97; g.life -= dt * 1.2; if (g.life <= 0) glyphParts.splice(i, 1); }
        for (let i = dying.length - 1; i >= 0; i--) {
          step(dying[i], dt, env);
          if (dying[i].closing > 0.35) { dying[i].closed.resolve(); dying.splice(i, 1); }
        }
      },
      gridUnder: () => { if (tool && stage()) tool.def.grid?.(tool, C); },
      gridOver: () => {
        if (!stage()) return;
        if (tool) { tool.def.top?.(tool, C); drawChip(tool); }
        for (const g of glyphParts) {
          const gx = Math.round(g.x / k.P), gy = Math.round(g.y / k.P), lv = g.life > 0.4 ? L : L - 2;
          put(gx - 1, gy, lv); put(gx, gy, lv); put(gx + 1, gy, lv);
          if (g.g === '+') { put(gx, gy - 1, lv); put(gx, gy + 1, lv); }
        }
        for (const bb of dying) drawBubbleGrid(bb);
        if (b) drawBubbleGrid(b);
      },
      over: (ctx, env) => {
        if (!stage()) return;
        if (guide?.arrived) {
          const g = guide, [rx, ry, rw, rh] = g.rect, age = now - g.arrivedAt;
          const pulse = 0.5 + 0.5 * Math.sin(age * 5), grow = Math.min(1, age / 0.25);
          const pad = 5 + (1 - grow) * 14, x0 = rx - pad, y0 = ry - pad, w = rw + pad * 2, h = rh + pad * 2;
          const P = k.P, col = (a) => css(PAL[L], a);
          ctx.save();
          // soft glow + stepped LED frame (pixel corners, like the rest of the app)
          ctx.shadowColor = col(0.9); ctx.shadowBlur = 10 + pulse * 10;
          ctx.strokeStyle = col(0.9); ctx.lineWidth = 2;
          const c = Math.max(P * 2, 6);
          ctx.beginPath();
          ctx.moveTo(x0 + c, y0); ctx.lineTo(x0 + w - c, y0); ctx.lineTo(x0 + w - c, y0 + P); ctx.lineTo(x0 + w, y0 + P); ctx.lineTo(x0 + w, y0 + c);
          ctx.lineTo(x0 + w, y0 + h - c); ctx.lineTo(x0 + w, y0 + h - P); ctx.lineTo(x0 + w - c, y0 + h - P); ctx.lineTo(x0 + w - c, y0 + h);
          ctx.lineTo(x0 + c, y0 + h); ctx.lineTo(x0 + c, y0 + h - P); ctx.lineTo(x0, y0 + h - P); ctx.lineTo(x0, y0 + h - c);
          ctx.lineTo(x0, y0 + c); ctx.lineTo(x0, y0 + P); ctx.lineTo(x0 + c, y0 + P); ctx.closePath();
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.fillStyle = col(0.08 + pulse * 0.06); ctx.fill();
          // a ripple every 1.4 s, so the eye finds it
          const rp = (age % 1.4) / 1.4;
          if (rp < 0.7) { ctx.strokeStyle = col(0.5 * (1 - rp / 0.7)); ctx.lineWidth = 1.5; ctx.strokeRect(x0 - rp * 18, y0 - rp * 18, w + rp * 36, h + rp * 36); }
          // marching LED dots from the mitt to the frame
          const hx = m.x + g.hand[0] * k.R, hy = m.y + g.hand[1] * k.R;
          const ex = clamp(hx, x0, x0 + w), ey = clamp(hy, y0, y0 + h), dist = Math.hypot(ex - hx, ey - hy);
          if (dist > 14) {
            const n = Math.floor(dist / 8), off = (age * 30) % 8;
            for (let i = 1; i < n; i++) {
              const u = (i * 8 + off) / dist; if (u >= 1) break;
              ctx.fillStyle = col(0.35 + 0.5 * u); ctx.fillRect(Math.round(hx + (ex - hx) * u) - 1, Math.round(hy + (ey - hy) * u) - 1, 3, 3);
            }
          }
          // step badge: "2/4" on a tag at the frame's top-left
          if (g.step) {
            const t = g.of ? `${g.step}/${g.of}` : String(g.step);
            ctx.font = '700 12px "Martian Mono", ui-monospace, monospace';
            const tw = ctx.measureText(t).width + 14, th = 20, bx = x0, by = y0 >= th + 6 ? y0 - th - 4 : y0 + h + 4;
            ctx.fillStyle = col(1); ctx.fillRect(bx, by, tw, th);
            ctx.fillStyle = css(PAL[0], 1); ctx.textBaseline = 'middle'; ctx.fillText(t, bx + 7, by + th / 2 + 0.5);
          }
          ctx.restore();
        }
        if (tool) {
          ctx.save();
          if (b?.grid) {
            const P = k.P, g = b.grid;
            ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect((g.x0 - 2) * P, (g.y0 - 2) * P, (g.x1 - g.x0 + 5) * P, (g.y1 - g.y0 + 5) * P);
            ctx.clip('evenodd');
          }
          tool.def.over?.(tool, C, ctx); drawChipText(ctx, env, tool);
          ctx.restore();
        }
        for (const bb of dying) drawText(ctx, env, bb);
        if (b) drawText(ctx, env, b);
      },
    };
  };
})();
