// Character looks for the sidekick: Anime Girl, Sarah and Adrian. Each is a head-and-shoulders hologram in the
// LED palette that fades out at the bottom like the JARVIS globe's projector, with a face that blinks, follows
// the cursor, talks with the real voice level and acts out moods. Hair moves with the body: the anime girl's
// twin tails swing, Sarah's long hair sways, Adrian's quiff bounces.
// 10-dither.js calls in here when the look is one of these, as it does jarvis.js. Pure drawing: it composes a
// small grid of levels, then writes it through the kit's put.
//
// The bodies are pixel art, one per size (default, small, cursor). Rows are the left half up to and including
// the centre column and are mirrored; a row as wide as the whole sprite is used as written (for what isn't
// symmetrical, like a side parting). Letters are levels of the LED palette, 0 darkest to 4 brightest:
//   h hair (1)  H hair shine (2)  s skin (3)  z skin shade (2)  c cloth (2)  C cloth shade (1)  k cloth light (3)
//   w white (4)  t/T hair that swings (1/2)  0-4 that level.  The face (eyes, brows, mouth) is drawn over it.
(() => {
  const R = window.Roamie;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const LV = { h: 1, H: 2, s: 3, S: 4, z: 2, c: 2, C: 1, k: 3, w: 4, t: 1, T: 2, 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 };
  const SWING = new Set(['t', 'T']);

  // eye: the viewer's-right eye's inner column (from the centre) and top row; mouth: its row; cy: the row of the
  // body point; neck: the first row that doesn't bob with the head; fade: rows at the bottom that fade out.
  const ART = {
    anime: {
      L: {
        w: 29, cy: 14, neck: 22, fade: 5, eye: [2, 12], mouth: 18, blush: [6, 17], tail: [5, 27],
        patch: [[0, 14, 'hh'], [1, 14, 'h']],
        rows: [
          '...............', '...............', '..........hhhhh', '.......hhhHHHHH', '...ww.hhHHhhhhh', '..wwwwhhhhhhhhh',
          '..twwwhhhhhhhhh', '.ttthhhhhhhhhhh', '.ttthhhhhhhhhhh', 'tttthhhhhshhhhh', 'tttthhhhssshhhh', 'ttTthhhssssshhs',
          'ttTthhsssssssss', 'ttTthhsssssssss', 'ttTthhsssssssss', 'ttTt.hsssssssss', 'ttTt.hsssssssss', 'ttTt.hhssssssss',
          'ttTt..hssssssss', 'ttTt..h.sssssss', 'tTtt.....ssssss', 'tTtt.......ssss', 'tTt.........zss', 'tTt.........zss',
          'tTt.....kkkkkzs', '.tt...kkwwwkkkw', '.tt..kkwccccwkw', '.t..kkwcccccckw', '..kkkwccccccccc', '.kkkwcccccccccc',
        ],
      },
      S: {
        w: 17, cy: 8, neck: 13, fade: 3, eye: [2, 8], mouth: 11, blush: [4, 10], tail: [4, 16],
        rows: ['........h', '.....hhhh', '..w.hhHHH', '.wwwhhhhh', 'tthhhhhhh', 'tthhhhhhh', 'tThhhshhs', 'tThhsssss', 'tThssssss', 'tThssssss', 'tT.hsssss', 'tT..sssss', 'tT....sss', 't......zs', 't....kkzs', '...kkwwkw', '.kwcccccc'],
      },
      X: {
        w: 11, cy: 4, neck: 8, fade: 1, eye: [1, 3], mouth: 5, tail: [1, 7],
        rows: ['....hh', 'w.hhhh', 'wwhhhh', 'thhsss', 'thssss', 'thssss', 't..sss', 't...zs', '..kkkw'],
      },
    },
    sarah: {
      L: {
        w: 29, cy: 14, neck: 21, fade: 5, eye: [2, 12], mouth: 18, blush: [6, 16], earring: [9, 15], tail: [11, 27],
        // A side parting on her left: the fringe sweeps across and down over the other side.
        patch: [[7, 16, 'sss'], [8, 9, 'hhhhhh'], [8, 15, 'ssss'], [9, 8, 'hhhhh'], [10, 8, 'hhh'], [26, 14, '4']],
        rows: [
          '..........hhhhh', '........hhHHHHH', '......hhHHHhhhh', '.....hhHhhhhhhh', '....hhhhhhhhhhh', '....hhhhhhhhhhh',
          '...hhhhhhhhhhhh', '...hhhhhhhhhhhh', '...hhhhhhhhhsss', '...hhhhhhhsssss', '...hhhhhsssssss', '..thhhhssssssss',
          '..thhhsssssssss', '..thhhsssssssss', '..thhhsssssssss', '..thhhhssssssss', '..tthhhssssssss', '..tthhhhsssssss',
          '..tthhhh.ssssss', '..tthhhh...ssss', '..tthhhh.....ss', '..tthhhh.....zs', '..tthhhh.....zs', '..tthhhhcccccss',
          '..tthhhcccccccs', '.tthhhccccccccc', '.tthhcccccccccc', 'cthhccccccccccc', 'ccccccccccccccc', 'ccccccccccccccc',
        ],
      },
      S: {
        w: 17, cy: 8, neck: 13, fade: 3, eye: [2, 8], mouth: 11, tail: [7, 16],
        patch: [[5, 5, 'hhhh'], [6, 5, 'hh'], [5, 10, 'ss']],
        rows: ['.....hhhh', '...hhHHHH', '..hhHhhhh', '.hhhhhhhh', '.hhhhhhhh', '.hhhhhhss', '.hhhsssss', 'thhssssss', 'thhssssss', 'thhssssss', 'thhhsssss', 'thhh.ssss', 'thhh...ss', 'thhh...zs', 'thhhcccss', 'thccccccc', 'ccccccccc'],
      },
      X: {
        w: 11, cy: 4, neck: 8, fade: 1, eye: [1, 3], mouth: 5, tail: [3, 8],
        patch: [[2, 4, 'h'], [2, 6, 'ss']],
        rows: ['..hhhh', '.hhhhh', 'hhhhss', 'hhssss', 'hhssss', 'thssss', 'th.sss', 'th..zs', 'tccccs'],
      },
    },
    adrian: {
      L: {
        w: 29, cy: 14, neck: 22, fade: 5, eye: [2, 12], mouth: 19,
        // The quiff, swept up and over to his right; a moustache.
        patch: [[0, 9, 'hhhhhhhh'], [1, 8, 'hhHHH'], [2, 9, 'HH'], [18, 13, 'hhh']],
        rows: [
          '...............', '..........hhhhh', '........hhhHHHH', '.......hhhhhhhh', '......hhhhhhhhh', '......hhhhhhhhh',
          '......hhhhhhhhh', '......hhhhsssss', '......hhsssssss', '......hssssssss', '.....zsssssssss', '....zzsssssssss',
          '....zzsssssssss', '....zzsssssssss', '.....zsssssssss', '......sssssssss', '......hssssssss', '......hhsssssss',
          '......hhhssssss', '.......hhhsssss', '........hhhhhhh', '..........hhhhh', '............zss', '............zss',
          '......CCCCCCcck', '....CCCCCCCCCck', '...CCCCCCCCCCck', '..CCCCCCCCCCCck', '.CCCCCCCCCCCCck', 'CCCCCCCCCCCCCck',
        ],
      },
      S: {
        w: 17, cy: 8, neck: 14, fade: 3, eye: [2, 8], mouth: 11,
        patch: [[0, 5, 'hhhh'], [1, 4, 'hhH'], [10, 7, 'hhh']],
        rows: ['.........', '....hhhHH', '...hhhhhh', '..hhhhhhh', '..hhhhhhh', '..hhsssss', '..hssssss', '.zsssssss', '.zsssssss', '..sssssss', '..hssssss', '..hhsssss', '...hhhhhh', '.....hhhh', '.......zs', '..CCCCcck', 'CCCCCCcck'],
      },
      X: {
        w: 11, cy: 4, neck: 8, fade: 1, eye: [1, 3], mouth: 5,
        patch: [[0, 2, 'hh']],
        rows: ['...hhh', '..hhHH', '.hhhhh', '.hssss', 'zsssss', '.sssss', '.hhsss', '..hhhh', '..CCck'],
      },
    },
    // Ken Kai, who made Roamies (shown on the About page, not a look): a textured dark fringe over faded sides,
    // and a hoodie with its drawstrings.
    ken: {
      L: {
        w: 29, cy: 14, neck: 22, fade: 5, eye: [2, 12], mouth: 18,
        patch: [[0, 10, 'hh.h'], [0, 16, 'h.hh'], [1, 9, 'hhhHhhh'], [7, 15, 'shh'], [8, 16, 'h']],
        rows: [
          '...............', '.........hhhhhh', '.......hhhhhhhh', '......hhhhHHhhh', '.....hhhhhhhhhh', '.....Hhhhhhhhhh',
          '.....HHhhhhhhhh', '.....HHhshhshhh', '.....HHssshssss', '.....Hsssssssss', '.....zsssssssss', '....zzsssssssss',
          '....zzsssssssss', '....zzsssssssss', '.....zsssssssss', '......sssssssss', '......sssssssss', '.......ssssssss',
          '.......ssssssss', '........sssssss', '..........sssss', '............sss', '............zss', '............zss',
          '........cccccCz', '.....CCCCCcccCc', '...CCCCCCCCCwCC', '..CCCCCCCCCCwCC', '.CCCCCCCCCCCwCC', 'CCCCCCCCCCCCkCC',
        ],
      },
      S: {
        w: 17, cy: 8, neck: 14, fade: 3, eye: [2, 8], mouth: 11,
        patch: [[0, 5, 'h.h'], [0, 10, 'h'], [4, 9, 'sh']],
        rows: ['.........', '....hhhhh', '...hhhHhh', '..Hhhhhhh', '..Hhhshhs', '..Hssssss', '..sssssss', '.zsssssss', '.zsssssss', '..sssssss', '..sssssss', '...ssssss', '....sssss', '......sss', '.......zs', '...CCcccz', 'CCCCCCCwC'],
      },
      X: {
        w: 11, cy: 4, neck: 8, fade: 1, eye: [1, 3], mouth: 5,
        patch: [[0, 3, 'h.hh']],
        rows: ['......', '.hhhhh', '.Hhshh', '.sssss', 'zsssss', '.sssss', '..ssss', '...zss', '..CCwC'],
      },
    },
  };
  // Mirror the half rows once. w is the whole width (odd, so there's a centre column).
  for (const who in ART) for (const sz in ART[who]) {
    const a = ART[who][sz], half = (a.w + 1) / 2;
    a.rows = a.rows.map((r) => (r.length === a.w ? r : r.length === half ? r + [...r.slice(0, -1)].reverse().join('') : (console.warn(`people.js: ${who} ${sz} row "${r}" is ${r.length} wide, not ${half} or ${a.w}`), r)));
    a.cx = half - 1;
    for (const [j, i, str] of a.patch ?? []) a.rows[j] = a.rows[j].slice(0, i) + str + a.rows[j].slice(i + str.length);
  }

  // Eyes, drawn for the viewer's-right eye and mirrored for the left. Each: open, wide, shut, happy, dizzy, sleepy.
  const EYES = {
    anime: {
      L: { open: ['00000.', '044100', '01110.', '01220.', '.222..'], wide: ['00000.', '044100', '01110.', '01110.', '01220.', '.222..'], shut: ['......', '......', '000000', '.0....'], happy: ['......', '.000..', '0...0.'], dizzy: ['0...0', '.0.0.', '..0..', '.0.0.', '0...0'], sleepy: ['......', '......', '00000.'] },
      S: { open: ['00', '40'], wide: ['00', '40', '00'], shut: ['..', '00'], happy: ['.0.', '0.0'], dizzy: ['0.0', '.0.', '0.0'], sleepy: ['..', '00'] },
      X: { open: ['0', '0'], wide: ['0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
    },
    sarah: {
      L: { open: ['.000.', '04100', '.111.'], wide: ['.000.', '04100', '01100', '.000.'], shut: ['.....', '.....', '0000.'], happy: ['.....', '.000.', '0...0'], dizzy: ['0.0', '.0.', '0.0'], sleepy: ['.....', '.....', '.000.'] },
      S: { open: ['00', '40'], wide: ['00', '40', '00'], shut: ['..', '00'], happy: ['.0.', '0.0'], dizzy: ['0.0', '.0.'], sleepy: ['..', '00'] },
      X: { open: ['0', '0'], wide: ['0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
    },
    ken: {
      L: { open: ['000', '040'], wide: ['000', '040', '000'], shut: ['...', '000'], happy: ['.0.', '0.0'], dizzy: ['0.0', '.0.', '0.0'], sleepy: ['...', '000'] },
      S: { open: ['0', '0'], wide: ['0', '0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
      X: { open: ['0', '0'], wide: ['0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
    },
    adrian: {
      L: { open: ['000', '040'], wide: ['000', '040', '000'], shut: ['...', '000'], happy: ['.0.', '0.0'], dizzy: ['0.0', '.0.', '0.0'], sleepy: ['...', '000'] },
      S: { open: ['0', '0'], wide: ['0', '0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
      X: { open: ['0', '0'], wide: ['0', '0'], shut: ['.', '0'], happy: ['0'], dizzy: ['0'], sleepy: ['.', '0'] },
    },
  };
  // Mouths, centred: closed (a small smile), talk1, talk2 (open wider), shout, o, frown, grin, flat.
  const MOUTHS = {
    L: { closed: ['0..0', '.00.'], talk1: ['.00.', '.00.'], talk2: ['.00.', '0110', '0110', '.00.'], shout: ['.00.', '0110', '0110', '0110', '.00.'], o: ['.0.', '0.0', '.0.'], frown: ['.00.', '0..0'], grin: ['000000', '044440', '.0000.'], flat: ['000'] },
    S: { closed: ['0'], talk1: ['0', '0'], talk2: ['.0.', '000', '.0.'], shout: ['.0.', '000', '000', '.0.'], o: ['0'], frown: ['.0.', '0.0'], grin: ['0.0', '.0.'], flat: ['000'] },
    X: { closed: ['0'], talk1: ['0'], talk2: ['00'], shout: ['00'], o: ['0'], frown: ['0'], grin: ['00'], flat: ['0'] },
  };

  // A grid of levels around the figure. -1 is empty; fig marks the figure itself (outlined).
  const grid = (x0, y0, w, h) => ({ x0, y0, w, h, lv: new Int8Array(w * h).fill(-1), fig: new Uint8Array(w * h) });
  const at = (G, gx, gy) => { const x = gx - G.x0, y = gy - G.y0; return x < 0 || y < 0 || x >= G.w || y >= G.h ? -1 : y * G.w + x; };
  const set = (G, gx, gy, l, fig = 0) => { const i = at(G, gx, gy); if (i >= 0) { G.lv[i] = l; if (fig) G.fig[i] = 1; } };
  const get = (G, gx, gy) => { const i = at(G, gx, gy); return i < 0 ? -1 : G.lv[i]; };
  // Stamps rows of '0'-'4' ('.' leaves the cell) with their top-left at (gx, gy), or mirrored with their top-right there.
  const stamp = (G, rows, gx, gy, mirror = false) => rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] !== '.') set(G, mirror ? gx - i : gx + i, gy + j, +row[i]);
  });
  // Dark cells all round the figure: anything empty next to a figure cell (not along the faded bottom).
  function outline(G, ok) {
    const out = [];
    for (let y = 0; y < G.h; y++) for (let x = 0; x < G.w; x++) {
      const i = y * G.w + x;
      if (G.lv[i] >= 0) continue;
      const n = (dx, dy) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < G.w && yy < G.h && G.fig[yy * G.w + xx]; };
      if ((n(1, 0) || n(-1, 0) || n(0, 1) || n(0, -1)) && ok(G.y0 + y)) out.push(i);
    }
    for (const i of out) G.lv[i] = 0;
  }
  const flush = (k, G) => { for (let y = 0; y < G.h; y++) for (let x = 0; x < G.w; x++) { const l = G.lv[y * G.w + x]; if (l >= 0) k.put(G.x0 + x, G.y0 + y, l); } };
  const spring = (st, want, k, c) => {
    const s = (st.swing ??= { x: 0, v: 0 }), dt = Math.min(0.05, st.dt ?? 0.016);
    s.v += ((want - s.x) * k - s.v * c) * dt; s.x += s.v * dt;
    return s.x;
  };

  const person = (who) => ({
    // Talking: the real voice when it's playing, else a made-up level while it talks.
    level(st) {
      if (st.mode === 'talk' && st.voice != null) return clamp(st.voice * 1.4, 0, 1);
      if (st.mode === 'talk') return clamp(0.5 + 0.5 * Math.sin(st.t * 13) * Math.abs(Math.sin(st.t * 3.1 + 1)), 0, 1);
      return 0;
    },
    // The body: cx, cy (cells) the body point, rad its radius in cells. k: { put, L, th }.
    body(k, cx, cy, rad, st) { flush(k, this.draw(k, Math.round(cx), Math.round(cy), st, rad >= 9 ? 'L' : 'S')); },
    // Pointer form: a pixel arrow tip at the hotspot (hx, hy), the head beside it.
    cursor(k, cx, cy, hx, hy, st) {
      const G = this.draw(k, cx + 2, cy + 2, st, 'X');
      const ARROW = ['4', '44', '444', '4444', '44', '.4'];
      ARROW.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') set(G, hx + i, hy + j, 4, 1); });
      outline(G, () => true);
      flush(k, G);
    },

    draw(k, cx, cy, st, size) {
      const a = ART[who][size], t = st.t, lvl = this.level(st), A = st.act;
      // Body motion: a hop on hype, a shake when upset, a droop asleep; the head bobs with a loud voice.
      const hop = A === 'hype' ? -Math.round(Math.abs(Math.sin(st.actA * 9)) * (size === 'L' ? 2 : 1)) : 0;
      const shake = A === 'upset' && st.actA % 0.9 < 0.32 ? Math.round(Math.sin(t * 48)) : 0;
      const droop = st.sleepy > 0.5 ? 1 : 0;
      const bob = size !== 'X' && st.mode === 'talk' && lvl > 0.65 ? -1 : 0;
      const x0 = cx - a.cx + shake, y0 = cy - a.cy + hop + droop;
      const G = grid(x0 - 3, y0 - 4, a.w + 6, a.rows.length + 8);
      // Swinging hair: against the way it moves, a little sway at rest, a toss on hype.
      const swing = spring(st, clamp(-(st.vx ?? 0) / 260, -2.5, 2.5) + Math.sin(t * 1.6) * 0.35 + (A === 'hype' ? Math.sin(st.actA * 9) * 1.2 : 0), 30, 6);
      const [tTop, tEnd] = a.tail ?? [0, 1];
      const fadeAt = a.rows.length - a.fade;
      a.rows.forEach((row, j) => {
        const head = j < a.neck ? bob : 0;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '.' || ch === ' ') continue;
          // The bottom rows dissolve, more each row, like a projection fading out.
          if (j >= fadeAt && (j - fadeAt + 1) / (a.fade + 1) > (size === 'L' ? k.th(x0 + i, y0 + j) : ((i + j) & 1 ? 0.3 : 0.65))) continue;
          let dx = 0;
          if (SWING.has(ch)) { const u = clamp((j - tTop) / (tEnd - tTop), 0, 1); dx = Math.round(swing * u * u); }
          set(G, x0 + i + dx, y0 + j + head, LV[ch], 1);
        }
      });
      const c = { G, a, x: x0 + a.cx, y: y0 + bob, st, t, size, lvl };
      this.face(c);
      this.extra(c);
      outline(G, (gy) => gy < y0 + fadeAt);
      return G;
    },

    face(c) {
      const { G, a, x, y, st, size, lvl } = c;
      const lx = Math.round(clamp(st.look[0], -1, 1) * (size === 'L' ? 1.2 : 0.6)), ly = Math.round(clamp(st.look[1], -1, 1) * (size === 'L' ? 0.8 : 0.4));
      const state = st.dizzy > 0.5 ? 'dizzy' : st.sleepy > 0.5 ? 'sleepy' : st.happy > 0.5 ? 'happy' : st.open < 0.35 ? 'shut' : st.wide > 0.5 ? 'wide' : 'open';
      const E = EYES[who][size][state];
      const ex = a.eye[0], ey = y + a.eye[1] + ly - (state === 'wide' ? 1 : 0);
      stamp(G, E, x + ex + lx, ey);
      stamp(G, E, x - ex + lx, ey, true);
      // Brows (where no hair covers them), from the agent's pose or the act.
      const brow = st.brow;
      if (size !== 'X' && (brow || who === 'adrian' || who === 'ken')) {
        const by = ey - (size === 'L' ? 2 : 1) - (brow === 'raised' ? 1 : 0), bw = size === 'L' ? 4 : 2;
        for (const s of [1, -1]) for (let i = 0; i < bw; i++) {
          const bx = x + s * (ex + i) + lx;
          const yy = by + ((brow === 'angry' || brow === 'determined') && i === 0 ? 1 : brow === 'sad' && i === bw - 1 ? 1 : 0);
          if (get(G, bx, yy) < 2) continue;
          set(G, bx, yy, who === 'adrian' || who === 'ken' ? 1 : 2 - (brow ? 1 : 0));
        }
      }
      // Blush: always for the anime girl, when happy for Sarah.
      if (a.blush && (who === 'anime' || st.happy > 0.5)) for (const s of [1, -1]) {
        const bx = x + s * a.blush[0] + lx, by = y + a.blush[1] + ly;
        if (size === 'L') { set(G, bx, by, 2); set(G, bx - s, by, 2); } else set(G, bx, by, 2);
      }
      // Mouth: from the voice while it talks, else the pose or act.
      let mouth = st.mouth;
      if (st.mode === 'talk') mouth = lvl > 0.62 ? 'talk2' : lvl > 0.22 ? 'talk1' : 'closed';
      if (!mouth || !MOUTHS[size][mouth]) mouth = st.happy > 0.5 ? 'grin' : 'closed';
      if (st.sleepy > 0.5) mouth = size === 'L' ? 'o' : 'flat';
      const M = MOUTHS[size][mouth];
      stamp(G, M, x + lx - Math.floor((M[0].length - 1) / 2), y + a.mouth + Math.max(0, ly));
    },

    extra(c) {
      const { G, a, x, y, st, t, size } = c;
      // Adrian's beard: a dark band round the jaw under the mouth, drawn after the mouth so the mouth stays clear.
      // Sarah's stud earring, on the side her hair's tucked.
      if (a.earring) { set(G, x + a.earring[0], y + a.earring[1], 4); }
      // The anime girl sparkles when she's thrilled.
      if (who === 'anime' && size !== 'X' && (st.act === 'hype' || st.happy > 0.5)) {
        for (let i = 0; i < 3; i++) {
          if (Math.sin(t * 7 + i * 2) < -0.2) continue;
          const ang = i * 2.1 + t * 1.3, d = size === 'L' ? 15 : 9;
          const sx = Math.round(x + Math.cos(ang) * d), sy = Math.round(y + a.cy - 4 + Math.sin(ang) * d * 0.7);
          if (size === 'L') stamp(G, ['.4.', '444', '.4.'], sx - 1, sy - 1); else set(G, sx, sy, 4);
        }
      }
      // Asleep: a small z rising beside the head.
      if (st.sleepy > 0.5 && size !== 'X') {
        const zx = x + (size === 'L' ? 12 : 7), zy = y + (size === 'L' ? 2 : 0) - (Math.floor(t * 1.5) % 2);
        stamp(G, size === 'L' ? ['444', '..4', '.4.', '4..', '444'] : ['44', '.4', '44'], zx, zy);
      }
    },
  });

  R.people = { anime: person('anime'), sarah: person('sarah'), adrian: person('adrian'), ken: person('ken') };
})();
