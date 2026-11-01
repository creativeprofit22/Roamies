(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const angDamp = (a, b, lambda, dt) => {
    let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * (1 - Math.exp(-lambda * dt));
  };
  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');

  const R = (window.Roamie = { types: [], TAU, clamp, lerp, damp, rand, angDamp });
  R.register = (def) => R.types.push(def);
  R.unit = (env) => env.unit ?? Math.min(env.w, env.h);
  // Screen edges covered by the menu bar / Dock / taskbar, in CSS px. The desktop host keeps it current.
  R.safe = { top: 0, right: 0, bottom: 0, left: 0 };
  R.setSafe = (s) => { for (const k of ['top', 'right', 'bottom', 'left']) R.safe[k] = Math.max(0, +s?.[k] || 0); R.origin = { x: +s?.ox || 0, y: +s?.oy || 0 }; };
  R.origin = { x: 0, y: 0 };

  // Damped 1D spring, used for squash/pop.
  class Spring {
    constructor(k = 170, c = 11) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
    update(dt, target = 0) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * dt;
      this.x += this.v * dt;
      return this.x;
    }
    kick(v) { this.v += v; }
  }
  R.Spring = Spring;

  // Wander / seek / drag / fling body shared by every roamie.
  class Mover {
    constructor(env, o = {}) {
      this.o = Object.assign({ speed: 110, accel: 2.6, margin: 0.2, curiosity: 0.4, restMin: 0.8, restMax: 3, bounce: 0.6, friction: 1.6 }, o);
      this.x = env.spawn ? env.spawn.x : env.w * rand(0.35, 0.65);
      this.y = env.spawn ? env.spawn.y : env.h * rand(0.35, 0.65);
      this.vx = 0; this.vy = 0;
      this.tx = this.x; this.ty = this.y;
      this.mode = 'rest'; this.rest = rand(0.3, 1.5);
      this.dragging = false; this.flung = false;
      this.radius = 40;
      this.stretch = 0; this.ang = 0;
      this.grabX = 0; this.grabY = 0;
      this.onBonk = null;
    }
    get speed() { return Math.hypot(this.vx, this.vy); }
    goTo(x, y) { this.tx = x; this.ty = y; this.mode = 'go'; this.flung = false; }
    pick(env) {
      // Anchored: idle shuffles around a home spot instead of roaming the screen.
      if (this.anchor) {
        const a = this.anchor, r = a.r ?? 20;
        this.goTo(a.x + rand(-r, r), a.y + rand(-r * 0.45, r * 0.45));
        return;
      }
      const m = env.margin ?? this.o.margin, w = env.w, h = env.h;
      if (env.mouse.inside && Math.random() < this.o.curiosity * (env.curiosity ?? 1)) {
        this.goTo(clamp(env.mouse.x + rand(-70, 70), w * m, w * (1 - m)), clamp(env.mouse.y + rand(-70, 70), h * m, h * (1 - m)));
      } else {
        this.goTo(rand(w * m, w * (1 - m)), rand(h * m, h * (1 - m)));
      }
    }
    update(dt, env) {
      const o = this.o;
      const sp = o.speed * (this.speedMul ?? 1) * (env.reduced ? 0.45 : 1) * (1 - 0.85 * (env.sleepy || 0));
      if (this.dragging) {
        const nx = env.mouse.x - this.grabX, ny = env.mouse.y - this.grabY;
        this.vx = lerp(this.vx, (nx - this.x) / Math.max(dt, 1e-3), 0.35);
        this.vy = lerp(this.vy, (ny - this.y) / Math.max(dt, 1e-3), 0.35);
        this.x = nx; this.y = ny;
      } else if (this.flung) {
        const f = Math.exp(-o.friction * dt);
        this.vx *= f; this.vy *= f;
        this.x += this.vx * dt; this.y += this.vy * dt;
        if (this.speed < 35) { this.flung = false; this.mode = 'rest'; this.rest = rand(0.5, 1.2); }
      } else {
        if (this.mode === 'rest') {
          this.rest -= dt;
          if (this.rest <= 0 && !(env.sleepy > 0.5)) this.pick(env);
        }
        const dx = this.tx - this.x, dy = this.ty - this.y, d = Math.hypot(dx, dy);
        let dvx = 0, dvy = 0;
        if (this.mode === 'go') {
          const s = sp * Math.min(1, d / (sp * 0.7) + 0.08);
          dvx = (dx / (d || 1)) * s; dvy = (dy / (d || 1)) * s;
          if (d < 5) { this.mode = 'rest'; this.rest = rand(o.restMin, o.restMax); }
        }
        this.vx = damp(this.vx, dvx, o.accel, dt);
        this.vy = damp(this.vy, dvy, o.accel, dt);
        this.x += this.vx * dt; this.y += this.vy * dt;
      }
      if (!this.dragging) this.walls(env);
      const s = this.speed;
      this.stretch = damp(this.stretch, clamp(s / 1100, 0, 0.5), 9, dt);
      if (s > 8) this.ang = angDamp(this.ang, Math.atan2(this.vy, this.vx), 8, dt);
    }
    walls(env) {
      const r = this.radius, s = env.safe ?? {};
      const x0 = (s.left ?? 0) + r, x1 = env.w - (s.right ?? 0) - r, y0 = (s.top ?? 0) + r, y1 = env.h - (s.bottom ?? 0) - r;
      const hit = (axisV) => {
        if (this.flung && Math.abs(axisV) > 260 && this.onBonk) this.onBonk(Math.abs(axisV));
      };
      if (this.x < x0) { hit(this.vx); this.x = x0; this.vx = Math.abs(this.vx) * this.o.bounce; }
      if (this.x > x1) { hit(this.vx); this.x = x1; this.vx = -Math.abs(this.vx) * this.o.bounce; }
      if (this.y < y0) { hit(this.vy); this.y = y0; this.vy = Math.abs(this.vy) * this.o.bounce; }
      if (this.y > y1) { hit(this.vy); this.y = y1; this.vy = -Math.abs(this.vy) * this.o.bounce; }
    }
  }
  R.Mover = Mover;

  // Expression state: blink, happy, surprised, dizzy, sleepy, look direction.
  class Face {
    constructor() {
      this.open = 1; this.happy = 0; this.wide = 0; this.dizzy = 0; this.sleepy = 0;
      this.lookX = 0; this.lookY = 0; this.t = rand(0, 10);
      this.blinkT = -1; this.nextBlink = rand(1, 4);
      this.mood = null; this.moodT = 0;
    }
    set(mood, secs) { this.mood = mood; this.moodT = secs; }
    update(dt, env, x, y, mover) {
      this.t += dt;
      if (this.moodT > 0 && (this.moodT -= dt) <= 0) this.mood = null;
      if (mover && mover.dragging) this.set('surprised', 0.2);
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkT < 0) this.blinkT = 0;
      let bl = 0;
      if (this.blinkT >= 0) {
        this.blinkT += dt / 0.16;
        bl = Math.sin(Math.PI * Math.min(1, this.blinkT));
        if (this.blinkT >= 1) { this.blinkT = -1; this.nextBlink = Math.random() < 0.25 ? 0.18 : rand(2, 5.5); }
      }
      this.happy = damp(this.happy, this.mood === 'happy' ? 1 : 0, 12, dt);
      this.wide = damp(this.wide, this.mood === 'surprised' ? 1 : 0, 16, dt);
      this.dizzy = damp(this.dizzy, this.mood === 'dizzy' ? 1 : 0, 8, dt);
      this.sleepy = damp(this.sleepy, env.sleepy > 0.5 && !this.mood ? 1 : 0, 1.6, dt);
      const lid = 1 - this.sleepy * (0.78 + Math.sin(this.t * 0.9) * 0.12);
      this.open = this.wide > 0.5 ? 1 : clamp(Math.min(lid, 1 - bl), 0, 1);
      let lx = Math.sin(this.t * 0.37) * 0.25, ly = Math.cos(this.t * 0.29) * 0.15;
      if (env.mouse.active) {
        const dx = env.mouse.x - x, dy = env.mouse.y - y, d = Math.hypot(dx, dy) || 1;
        const s = Math.min(1, d / 200);
        lx = (dx / d) * s; ly = (dy / d) * s;
      } else if (mover && mover.speed > 12) {
        lx = Math.cos(mover.ang) * 0.7; ly = Math.sin(mover.ang) * 0.7;
      }
      this.lookX = damp(this.lookX, lx, 10, dt);
      this.lookY = damp(this.lookY, ly, 10, dt);
    }
  }
  R.Face = Face;

  // Vector eyes with every expression. size = eye height.
  R.drawEyes = (ctx, f, x, y, size, o = {}) => {
    const gap = o.gap ?? size * 1.15;
    const sclera = o.sclera ?? '#f7fbff', pupil = o.pupil ?? '#0b0f14', lw = o.lineWidth ?? Math.max(2, size * 0.16);
    ctx.save();
    ctx.translate(x, y);
    if (o.angle) ctx.rotate(o.angle);
    for (const side of [-1, 1]) {
      const ex = side * gap / 2;
      const ry = size * 0.5 * (1 + 0.28 * f.wide), rx = size * 0.4 * (1 + 0.22 * f.wide);
      const normal = 1 - Math.max(f.happy, f.dizzy);
      if (normal > 0.02) {
        ctx.globalAlpha = normal;
        const h = Math.max(0.07, f.open) * ry;
        const ey = (1 - f.open) * ry * 0.35;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(ex, ey, rx, h, 0, 0, TAU);
        if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = size * 0.8; }
        ctx.fillStyle = sclera;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.clip();
        const pr = rx * (0.62 - 0.2 * f.wide);
        const px = ex + f.lookX * (rx - pr) * 0.9, py = ey + f.lookY * (ry - pr) * 0.8;
        ctx.fillStyle = pupil;
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath(); ctx.arc(px - pr * 0.35, py - pr * 0.4, pr * 0.32, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(px + pr * 0.3, py + pr * 0.35, pr * 0.13, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = o.line ?? sclera;
      ctx.lineWidth = lw; ctx.lineCap = 'round';
      if (f.happy > 0.02) {
        ctx.globalAlpha = f.happy;
        ctx.beginPath();
        ctx.arc(ex, ry * 0.35, rx * 0.95, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      if (f.dizzy > 0.02) {
        ctx.globalAlpha = f.dizzy;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const a = i * 0.45 + f.t * 9 * side, r = (i / 40) * rx;
          i ? ctx.lineTo(ex + Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(ex, 0);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  // Mouth that blends between expressions. w = mouth width.
  R.drawMouth = (ctx, f, x, y, w, o = {}) => {
    const color = o.color ?? '#0b0f14';
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = o.lineWidth ?? Math.max(1.6, w * 0.14);
    if (f.wide > 0.5) {
      ctx.beginPath(); ctx.ellipse(0, w * 0.1, w * 0.18, w * 0.24 * f.wide, 0, 0, TAU); ctx.fill();
    } else if (f.happy > 0.4) {
      ctx.beginPath();
      ctx.moveTo(-w * 0.45, 0);
      ctx.quadraticCurveTo(0, w * 0.75 * f.happy, w * 0.45, 0);
      ctx.closePath(); ctx.fill();
      if (o.tongue) {
        ctx.save(); ctx.clip();
        ctx.fillStyle = o.tongue;
        ctx.beginPath(); ctx.ellipse(0, w * 0.42, w * 0.22, w * 0.16, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
    } else if (f.dizzy > 0.4) {
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const px = -w * 0.4 + (i / 12) * w * 0.8;
        const py = Math.sin(i * 1.3 + f.t * 6) * w * 0.08;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    } else {
      const curve = w * 0.28 * (1 - f.sleepy * 0.85);
      ctx.beginPath();
      ctx.moveTo(-w * 0.24, 0);
      ctx.quadraticCurveTo(0, curve, w * 0.24, 0);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Realistic eyes: shaded sclera, striated iris, lids made of body material, cheek squint, fixed catchlights.
  R.drawEyesPro = (ctx, f, x, y, size, o = {}) => {
    const gap = o.gap ?? size * 1.2;
    const lid = o.lid ?? '#2fbf93';
    const lash = o.lash ?? 'rgba(0,0,0,0.6)';
    const [iIn, iMid, iOut] = o.iris ?? ['#fff3c4', '#f2a531', '#5a2400'];
    const tilt = o.tilt ?? 0;
    ctx.save();
    ctx.translate(x, y);
    if (o.angle) ctx.rotate(o.angle);
    ctx.scale(o.sx ?? 1, o.sy ?? 1);
    for (const side of [-1, 1]) {
      const comp = Math.max(0, side * f.lookX) * 0.22;
      const ex = side * gap / 2 + f.lookX * size * 0.2, ey = f.lookY * size * 0.1;
      const rx = size * 0.42 * (1 - comp) * (1 + 0.1 * f.wide), ry = size * 0.5 * (1 + 0.16 * f.wide);
      ctx.save();
      ctx.translate(ex, ey);
      const ao = ctx.createRadialGradient(0, 0, Math.min(rx, ry) * 0.85, 0, 0, Math.max(rx, ry) * 1.45);
      ao.addColorStop(0, o.socket ?? 'rgba(0,0,0,0.38)');
      ao.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ao;
      ctx.beginPath(); ctx.ellipse(0, 0, rx * 1.5, ry * 1.5, 0, 0, TAU); ctx.fill();

      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const sg = ctx.createRadialGradient(-rx * 0.25, -ry * 0.3, 0, 0, 0, Math.max(rx, ry) * 1.05);
      sg.addColorStop(0, '#ffffff'); sg.addColorStop(0.65, '#eaf0f3'); sg.addColorStop(1, o.scleraEdge ?? '#9fb0bb');
      ctx.fillStyle = sg; ctx.fill();
      ctx.save();
      ctx.clip();

      const ir = Math.min(rx, ry) * (o.irisSize ?? 0.8);
      let ix = f.lookX * (rx - ir * 0.7), iy = f.lookY * (ry - ir * 0.65);
      if (f.dizzy > 0.02) {
        ix = lerp(ix, Math.cos(f.t * 9 * side) * rx * 0.32, f.dizzy);
        iy = lerp(iy, Math.sin(f.t * 9 * side) * ry * 0.32, f.dizzy);
      }
      const ig = ctx.createRadialGradient(ix, iy, ir * 0.1, ix, iy, ir);
      ig.addColorStop(0, iIn); ig.addColorStop(0.5, iMid); ig.addColorStop(1, iOut);
      ctx.fillStyle = ig;
      ctx.beginPath(); ctx.arc(ix, iy, ir, 0, TAU); ctx.fill();
      ctx.lineWidth = Math.max(0.6, ir * 0.035);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      for (let k = 0; k < 30; k++) {
        const a = (k / 30) * TAU + (k % 3) * 0.04, r0 = ir * (0.42 + (k % 2) * 0.06);
        ctx.moveTo(ix + Math.cos(a) * r0, iy + Math.sin(a) * r0);
        ctx.lineTo(ix + Math.cos(a) * ir * 0.9, iy + Math.sin(a) * ir * 0.9);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = ir * 0.13;
      ctx.beginPath(); ctx.arc(ix, iy, ir * 0.94, 0, TAU); ctx.stroke();
      const pr = ir * clamp(0.44 - 0.22 * f.wide + 0.1 * f.happy + 0.08 * f.sleepy, 0.18, 0.6);
      ctx.fillStyle = '#04060a';
      ctx.beginPath(); ctx.arc(ix, iy, pr, 0, TAU); ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath(); ctx.ellipse(-rx * 0.28, -ry * 0.3, ir * 0.3, ir * 0.2, -0.5, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.arc(rx * 0.26, ry * 0.2, ir * 0.08, 0, TAU); ctx.fill();
      ctx.strokeStyle = o.bounce ?? 'rgba(255,255,255,0.25)'; ctx.lineWidth = ir * 0.08;
      ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.82, ry * 0.82, 0, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();

      const k = ry * 0.28;
      const xo = side * rx * 1.35, xi = -side * rx * 1.35;
      const open = lerp(Math.min(f.open, o.relax ?? 1), f.open, f.wide);
      const lidY = -ry + (1 - open) * ry * 2.1 - f.wide * ry * 0.2;
      const yo = lidY - k + tilt * ry * 0.45, yi = lidY - k - tilt * ry * 0.45;
      const upper = () => { ctx.moveTo(xi, yi); ctx.quadraticCurveTo(0, lidY + k, xo, yo); };
      ctx.save(); ctx.translate(0, ry * 0.1);
      ctx.beginPath(); upper(); ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = ry * 0.26; ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.moveTo(xi, -ry * 2.2); upper(); ctx.lineTo(xo, -ry * 2.2); ctx.closePath();
      ctx.fillStyle = lid; ctx.fill();
      ctx.beginPath(); upper(); ctx.strokeStyle = lash; ctx.lineWidth = Math.max(1.5, ry * 0.12); ctx.stroke();

      const low = ry * (1.08 - f.happy * 0.72);
      const lower = () => { ctx.moveTo(xi, low + k * 0.4); ctx.quadraticCurveTo(0, low - k * (0.3 + f.happy * 1.3), xo, low + k * 0.4); };
      ctx.beginPath(); ctx.moveTo(xi, ry * 2.2); lower(); ctx.lineTo(xo, ry * 2.2); ctx.closePath();
      ctx.fillStyle = lid; ctx.fill();
      ctx.beginPath(); lower(); ctx.strokeStyle = lash; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(1, ry * 0.07); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
      ctx.strokeStyle = o.rim ?? 'rgba(0,0,0,0.3)'; ctx.lineWidth = Math.max(1, ry * 0.05); ctx.stroke();

      if (o.brow) {
        const by = -ry * (1.5 + f.wide * 0.45 - f.sleepy * 0.12) + tilt * ry * 0.2;
        const rot = side * (0.12 + f.dizzy * 0.35 - f.wide * 0.1 - tilt * 0.3);
        ctx.save(); ctx.translate(0, by); ctx.rotate(rot);
        ctx.fillStyle = o.brow;
        ctx.beginPath();
        ctx.moveTo(-side * rx * 0.95, ry * 0.08);
        ctx.quadraticCurveTo(0, -ry * 0.22, side * rx * 0.95, -ry * 0.02);
        ctx.quadraticCurveTo(0, -ry * 0.02, -side * rx * 0.95, ry * 0.08);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  };

  // Refined mouth: nothing at rest, a shaded open smile, a small "o", or a wavy dizzy line.
  R.drawMouthPro = (ctx, f, x, y, w, o = {}) => {
    const ink = o.ink ?? '#06261f', inner = o.inner ?? '#2a0a12', tongue = o.tongue;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    if (f.happy > 0.05) {
      ctx.globalAlpha = clamp(f.happy * 1.4, 0, 1);
      const h = w * 0.42 * f.happy;
      ctx.beginPath();
      ctx.moveTo(-w * 0.42, 0);
      ctx.bezierCurveTo(-w * 0.3, h * 1.2, w * 0.3, h * 1.2, w * 0.42, 0);
      ctx.quadraticCurveTo(0, h * 0.18, -w * 0.42, 0);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, inner); g.addColorStop(1, '#000');
      ctx.fillStyle = g; ctx.fill();
      if (o.tongue) {
        ctx.save(); ctx.clip();
        ctx.fillStyle = tongue;
        ctx.beginPath(); ctx.ellipse(0, h * 1.05, w * 0.2, h * 0.5, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, w * 0.06);
      ctx.beginPath(); ctx.moveTo(-w * 0.46, -w * 0.02); ctx.quadraticCurveTo(0, h * 0.22, w * 0.46, -w * 0.02); ctx.stroke();
    } else if (f.wide > 0.05) {
      ctx.globalAlpha = clamp(f.wide * 1.4, 0, 1);
      const g = ctx.createRadialGradient(0, w * 0.06, 0, 0, w * 0.06, w * 0.2);
      g.addColorStop(0, '#000'); g.addColorStop(1, inner);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, w * 0.06, w * 0.12, w * 0.17 * f.wide, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, w * 0.04); ctx.stroke();
    } else if (f.dizzy > 0.3) {
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, w * 0.06); ctx.globalAlpha = f.dizzy;
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {
        const px = -w * 0.3 + (i / 14) * w * 0.6, py = Math.sin(i * 1.2 + f.t * 7) * w * 0.05;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    } else if (o.rest !== false) {
      ctx.strokeStyle = ink; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(1.2, w * 0.05);
      ctx.beginPath(); ctx.moveTo(-w * 0.14, 0); ctx.quadraticCurveTo(0, w * 0.07 * (1 - f.sleepy), w * 0.14, 0); ctx.stroke();
    }
    ctx.restore();
  };

  // Glowing visor-style eyes: light shapes that morph per expression.
  R.drawVisorEyes = (ctx, f, x, y, size, o = {}) => {
    const gap = o.gap ?? size * 1.3, col = o.color ?? '#7ff3ff', core = o.core ?? '#f2feff';
    ctx.save();
    ctx.translate(x, y);
    if (o.angle) ctx.rotate(o.angle);
    ctx.shadowColor = col; ctx.shadowBlur = size * 0.9;
    for (const side of [-1, 1]) {
      const ex = side * gap / 2 + f.lookX * size * 0.32, ey = f.lookY * size * 0.22;
      const rx = size * 0.34 * (1 + 0.3 * f.wide), ry = size * 0.5 * (1 + 0.25 * f.wide);
      ctx.save();
      ctx.translate(ex, ey);
      const normal = 1 - Math.max(f.happy, f.dizzy);
      if (normal > 0.02) {
        ctx.globalAlpha = normal;
        const h = Math.max(0.08, f.open) * ry;
        ctx.save();
        ctx.rotate(-side * 0.22 * (1 - f.wide));
        ctx.beginPath(); ctx.ellipse(0, (1 - f.open) * ry * 0.4, rx, h, 0, 0, TAU);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, h));
        g.addColorStop(0, core); g.addColorStop(0.55, col); g.addColorStop(1, col);
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }
      ctx.lineCap = 'round';
      if (f.happy > 0.02) {
        ctx.globalAlpha = f.happy;
        ctx.strokeStyle = col; ctx.lineWidth = size * 0.2;
        ctx.beginPath(); ctx.arc(0, ry * 0.3, rx * 1.05, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
        ctx.strokeStyle = core; ctx.lineWidth = size * 0.07; ctx.stroke();
      }
      if (f.dizzy > 0.02) {
        ctx.globalAlpha = f.dizzy;
        ctx.strokeStyle = col; ctx.lineWidth = size * 0.12;
        const a = f.t * 7 * side;
        ctx.beginPath(); ctx.arc(0, 0, rx * 0.9, a, a + Math.PI * 1.4); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, rx * 0.4, -a, -a + Math.PI * 1.2); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  };

  // Smooth closed path through points (quadratic through midpoints).
  R.blobPath = (ctx, pts) => {
    const n = pts.length;
    ctx.beginPath();
    const mx = (pts[n - 1].x + pts[0].x) / 2, my = (pts[n - 1].y + pts[0].y) / 2;
    ctx.moveTo(mx, my);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    ctx.closePath();
  };

  // Cheap smooth noise for shimmer.
  R.noise = (x, y, t) =>
    Math.sin(x * 1.7 + t * 1.3) * Math.cos(y * 1.3 - t * 0.9) * 0.5 + Math.sin((x + y) * 0.9 + t * 2.1) * 0.5;

  const ICON = {
    expand: '<svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    collapse: '<svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  };

  const pointer = { x: -1e4, y: -1e4, active: false, last: performance.now(), vx: 0, vy: 0 };
  const setPointer = (x, y) => {
    const now = performance.now(), dt = Math.max(1, now - pointer.last) / 1000;
    pointer.vx = (x - pointer.x) / dt; pointer.vy = (y - pointer.y) / dt;
    pointer.x = x; pointer.y = y; pointer.active = true; pointer.last = now;
  };
  addEventListener('pointermove', (e) => setPointer(e.clientX, e.clientY), { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; });
  addEventListener('blur', () => { pointer.active = false; });

  // Desktop overlay: every roamie shares one transparent full-screen canvas. The host app calls
  // Roamie.ptr(x, y) each frame with the real cursor and makes the window click-through unless it returns true.
  R.bootDesktop = (canvas) => {
    const qs = new URLSearchParams(location.search);
    const only = window.ROAMIE_ONLY || qs.get('only')?.split(',');
    const unit = +(window.ROAMIE_UNIT || qs.get('unit') || 340);
    const ctx = canvas.getContext('2d');
    let W = innerWidth, H = innerHeight, dpr = 1, down = null;
    const defs = R.types.filter((d) => !only || only.includes(d.id));
    const cols = Math.max(1, Math.round(Math.sqrt((defs.length * W) / H))), rows = Math.ceil(defs.length / cols);
    const list = defs.map((def, i) => {
      const env = {
        w: W, h: H, dpr, t: 0, unit, margin: 0.05, curiosity: 0.3, transparent: true, safe: R.safe,
        spawn: { x: (((i % cols) + 0.5) / cols) * W, y: ((Math.floor(i / cols) + 0.5) / rows) * H },
        mouse: { x: 0, y: 0, inside: false, active: false }, sleepy: 0, reduced: reducedMQ.matches,
      };
      const c = def.create(env);
      c.mover.onBonk = (s) => { c.face?.set('dizzy', 1.8); c.bonk?.(s); };
      return { def, env, c };
    });
    const resize = () => {
      W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      for (const o of list) { o.env.w = W; o.env.h = H; o.env.dpr = dpr; o.c.resize?.(o.env); }
    };
    addEventListener('resize', resize);
    resize();
    R.tiles = list.map((o) => ({ def: o.def, creature: o.c, env: o.env }));

    const hitAt = (x, y) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].c.hidden) continue;
        const m = list[i].c.mover;
        if (Math.hypot(x - m.x, y - m.y) < m.radius * 1.1) return list[i];
      }
      return null;
    };
    R.ptr = (x, y) => {
      if (x !== pointer.x || y !== pointer.y) setPointer(x, y);
      return !!down || list.some((o) => o.c.mover.dragging || o.c.hit?.(x, y)) || !!hitAt(x, y);
    };
    canvas.addEventListener('wheel', (e) => {
      const o = list.find((q) => q.c.hit?.(e.clientX, e.clientY));
      if (o) { e.preventDefault(); o.c.wheel?.(e.deltaY); }
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // right-click opens settings instead of grabbing
      const b = list.find((q) => q.c.hit?.(e.clientX, e.clientY));
      if (b) { b.c.press?.(e.clientX, e.clientY); return; }
      const o = hitAt(e.clientX, e.clientY);
      if (!o) return;
      const m = o.c.mover;
      canvas.setPointerCapture(e.pointerId);
      down = { o, x: e.clientX, y: e.clientY, t: performance.now() };
      m.dragging = true; m.flung = false; m.grabX = e.clientX - m.x; m.grabY = e.clientY - m.y;
      o.c.grab?.(e.clientX, e.clientY);
    });
    const release = (e) => {
      if (!down) return;
      const { o, x, y, t } = down; down = null;
      const c = o.c, m = c.mover;
      m.dragging = false;
      if (Math.hypot(e.clientX - x, e.clientY - y) < 6 && performance.now() - t < 320) {
        c.face?.set('happy', 1.6); c.boop?.(e.clientX, e.clientY); m.mode = 'rest'; m.rest = 1.4;
      } else if (m.speed > 220) m.flung = true;
      else { m.mode = 'rest'; m.rest = 1; }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => { if (down) down.o.c.mover.dragging = false; down = null; });
    canvas.addEventListener('contextmenu', (e) => {
      const o = list.find((q) => q.c.hit?.(e.clientX, e.clientY)) || hitAt(e.clientX, e.clientY);
      if (!o) return;
      e.preventDefault();
      R.onContext?.(o.def.id);
    });

    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      const idle = (now - pointer.last) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const o of list) {
        const { env, c } = o, m = c.mover;
        env.t += dt; env.reduced = reducedMQ.matches; env.sleepy = idle > 12 ? 1 : 0;
        env.mouse.active = pointer.active && idle < 6;
        env.mouse.x = pointer.x; env.mouse.y = pointer.y;
        env.mouse.inside = env.mouse.active && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= W && pointer.y <= H;
        if (env.mouse.inside && !m.dragging && idle < 0.05 && Math.hypot(pointer.vx, pointer.vy) > 2600 && Math.hypot(pointer.x - m.x, pointer.y - m.y) < m.radius * 2.2) {
          c.face?.set('surprised', 0.7);
          // Anchored roamies (the sidekick) only flinch: a shove would dodge the click you were aiming.
          if (!m.anchor) {
            const dx = m.x - pointer.x, dy = m.y - pointer.y, d = Math.hypot(dx, dy) || 1;
            m.vx += (dx / d) * 260; m.vy += (dy / d) * 260;
          }
        }
        c.update(dt, env);
      }
      const order = [...list].sort((a, b) => a.c.mover.y - b.c.mover.y);
      for (const o of order) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        o.c.draw(ctx, o.env);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  R.boot = (grid, opts = {}) => {
    const tiles = [];
    const qs = new URLSearchParams(location.search);
    const solo = opts.only ?? qs.get('solo'), forcedMood = qs.get('mood');
    for (const def of R.types) {
      if (solo && def.id !== solo) continue;
      const tile = document.createElement('section');
      tile.className = 'tile';
      if (def.bg) tile.style.setProperty('--bg', def.bg);
      const canvas = document.createElement('canvas');
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${def.label}. Click to boop, drag to fling.`);
      const btn = document.createElement('button');
      btn.className = 'expand';
      btn.type = 'button';
      btn.setAttribute('aria-label', `Fullscreen ${def.label}`);
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = ICON.expand + ICON.collapse;
      tile.append(canvas, btn);
      grid.append(tile);

      const ctx = canvas.getContext('2d');
      const env = { w: 300, h: 400, dpr: 1, t: 0, unit: opts.unit, spawn: opts.spawn, mouse: { x: 0, y: 0, inside: false, active: false }, sleepy: 0, reduced: reducedMQ.matches };
      const T = { def, tile, canvas, ctx, env, visible: true, rect: null, creature: null, down: null };

      const resize = () => {
        const r = canvas.getBoundingClientRect();
        T.rect = r;
        env.dpr = Math.min(2, devicePixelRatio || 1);
        env.w = Math.max(1, r.width); env.h = Math.max(1, r.height);
        canvas.width = Math.round(env.w * env.dpr); canvas.height = Math.round(env.h * env.dpr);
        if (!T.creature) {
          if (typeof env.spawn === 'function') env.spawn = env.spawn(env);
          T.creature = def.create(env);
          const c = T.creature;
          if (c.mover) c.mover.onBonk = (s) => { c.face?.set('dizzy', 1.8); c.bonk?.(s); };
        }
        T.creature.resize?.(env);
      };
      new ResizeObserver(resize).observe(canvas);
      new IntersectionObserver(([e]) => { T.visible = e.isIntersecting; }).observe(tile);

      const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      canvas.addEventListener('pointerdown', (e) => {
        const p = local(e), c = T.creature, m = c.mover;
        env.mouse.x = p.x; env.mouse.y = p.y;
        if (c.hit?.(p.x, p.y)) { c.press?.(p.x, p.y); return; }
        const hit = !c.hidden && Math.hypot(p.x - m.x, p.y - m.y) < m.radius * 1.15;
        T.down = { x: p.x, y: p.y, t: performance.now(), hit };
        if (hit) {
          canvas.setPointerCapture(e.pointerId);
          m.dragging = true; m.flung = false; m.grabX = p.x - m.x; m.grabY = p.y - m.y;
          c.grab?.(p.x, p.y);
        }
      });
      const release = (e) => {
        const d = T.down; if (!d) return;
        T.down = null;
        const p = local(e), c = T.creature, m = c.mover;
        const moved = Math.hypot(p.x - d.x, p.y - d.y), quick = performance.now() - d.t < 320;
        if (d.hit) {
          m.dragging = false;
          if (moved < 6 && quick) {
            c.face?.set('happy', 1.6);
            c.boop?.(p.x, p.y);
            m.mode = 'rest'; m.rest = 1.4;
          } else if (m.speed > 220) {
            m.flung = true;
          } else {
            m.mode = 'rest'; m.rest = 1;
          }
        } else if (moved < 6) {
          m.goTo(p.x, p.y);
          c.face?.set('happy', 0.6);
          c.tap?.(p.x, p.y);
        }
      };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('wheel', (e) => {
        const p = local(e), c = T.creature;
        if (c.hit?.(p.x, p.y)) { e.preventDefault(); c.wheel?.(e.deltaY); }
      }, { passive: false });
      canvas.addEventListener('pointercancel', (e) => { T.creature.mover.dragging = false; T.down = null; });
      canvas.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          T.creature.face?.set('happy', 1.6);
          T.creature.boop?.(T.creature.mover.x, T.creature.mover.y);
        }
      });
      btn.addEventListener('click', () => {
        const on = !tile.classList.contains('expanded');
        for (const o of tiles) { o.tile.classList.remove('expanded'); o.tile.querySelector('.expand').setAttribute('aria-pressed', 'false'); }
        tile.classList.toggle('expanded', on);
        btn.setAttribute('aria-pressed', String(on));
        document.body.style.overflow = on ? 'hidden' : '';
      });
      tiles.push(T);
    }
    R.tiles = tiles;
    if (solo && tiles[0]) tiles[0].tile.querySelector('.expand').click();

    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || opts.locked) return;
      for (const o of tiles) if (o.tile.classList.contains('expanded')) o.tile.querySelector('.expand').click();
    });
    const refreshRects = () => { for (const T of tiles) T.rect = T.canvas.getBoundingClientRect(); };
    addEventListener('scroll', refreshRects, { passive: true });
    addEventListener('resize', refreshRects);

    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      const idle = (now - pointer.last) / 1000;
      const anyExpanded = tiles.some((o) => o.tile.classList.contains('expanded'));
      for (const T of tiles) {
        if (!T.visible || !T.creature) continue;
        if (anyExpanded && !T.tile.classList.contains('expanded')) continue;
        const { env, ctx, creature: c, rect } = T;
        env.t += dt;
        env.reduced = reducedMQ.matches;
        env.sleepy = idle > 10 ? 1 : 0;
        const r = rect || T.canvas.getBoundingClientRect();
        env.mouse.active = pointer.active && idle < 6;
        env.mouse.x = pointer.x - r.left; env.mouse.y = pointer.y - r.top;
        env.mouse.inside = env.mouse.active && env.mouse.x >= 0 && env.mouse.y >= 0 && env.mouse.x <= env.w && env.mouse.y <= env.h;
        const m = c.mover;
        if (env.mouse.inside && !m.dragging && Math.hypot(pointer.vx, pointer.vy) > 2600 && Math.hypot(env.mouse.x - m.x, env.mouse.y - m.y) < m.radius * 2.2 && idle < 0.05) {
          c.face?.set('surprised', 0.7);
          if (!m.anchor) {
            const dx = m.x - env.mouse.x, dy = m.y - env.mouse.y, d = Math.hypot(dx, dy) || 1;
            m.vx += (dx / d) * 260; m.vy += (dy / d) * 260;
          }
        }
        if (forcedMood) c.face?.set(forcedMood, 1);
        c.update(dt, env);
        ctx.setTransform(env.dpr, 0, 0, env.dpr, 0, 0);
        ctx.clearRect(0, 0, env.w, env.h);
        c.draw(ctx, env);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
})();
