// Live look tiles for Settings: each look drawn by the desktop's LED renderer (roamies/10-dither.js), small and
// playing. A slimmer twin of the panel's liveRoamie (panel/panel.js), kept separate so upstream's panel can change
// freely. Tiles are made once and kept across re-renders, so a state update never restarts them.
(() => {
  'use strict';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const LED = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const ACT_SECS = { hype: 2.8, wave: 3.1 };
  // Drawn at half scale (the app's unit), so each size shows its own art at its real size.
  const ZOOM = 0.5, UNIT = 340;
  const live = new Set();
  let pointer = null;
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });

  function make(canvas, w, h, { look, form = 'default', y = 0.55 }) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    w /= ZOOM; h /= ZOOM;
    const env = {
      w, h, dpr, t: 0, unit: UNIT, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      form,
      kit: Roamie.ditherKit({
        id: 'settings', label: 'Settings', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        // busy: it never wanders off or starts acts of its own inside a tile.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => null }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / ZOOM, y: (pointer[1] - r.top) / ZOOM, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * ZOOM, 0, 0, dpr * ZOOM, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    me.kit.appear('crt', w / 2, h * y);
    live.add({ me, canvas });
    wake();
    return me;
  }

  // One loop for every tile, running only while one is on screen.
  let running = false, last = 0;
  function frame(now) {
    const shown = [...live].filter(({ canvas }) => canvas.isConnected && canvas.offsetParent);
    if (!shown.length || document.hidden) { running = false; return; }
    const dt = Math.min(1 / 30, (now - (last || now)) / 1000); last = now;
    for (const { me } of shown) me.step(dt);
    requestAnimationFrame(frame);
  }
  function wake() { if (running) return; running = true; last = 0; requestAnimationFrame(frame); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  // The look picker: a radio group of tiles. Arrow keys move the choice; focus follows it.
  const tiles = new Map();
  function lookTiles({ looks, look, size, onpick }) {
    const g = tiles.get('_group') ?? RoamiesKit.el('div', { className: 'looks', role: 'radiogroup' });
    g.setAttribute('aria-label', 'Look');
    tiles.set('_group', g);
    g.onkeydown = (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(document.activeElement);
      const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
      next?.focus(); next?.click();
    };
    g.replaceChildren(...looks.map(({ id, name }) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = RoamiesKit.el('canvas', { ariaHidden: 'true' });
        const b = RoamiesKit.el('button', { className: 'px looktile', type: 'button' }, cv, RoamiesKit.el('span', { className: 'name', textContent: name }));
        b.setAttribute('role', 'radio');
        b.dataset.focus = `look-${id}`;
        t = { b, r: make(cv, 104, 76, { look: id, form: size }), waved: 0, pick: null };
        const wave = () => { if (t.r && Date.now() - t.waved > 3500) { t.waved = Date.now(); t.r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => t.pick?.());
        tiles.set(id, t);
      }
      const on = look === id;
      t.pick = () => { if (look !== id) { t.r?.act('hype'); onpick(id); } };
      t.r?.setForm(size);
      t.b.setAttribute('aria-checked', String(on));
      t.b.tabIndex = on ? 0 : -1;
      return t.b;
    }));
    wake();
    return g;
  }

  window.RoamiesLooks = { lookTiles };
})();
