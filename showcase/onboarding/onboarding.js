// Setup guide: Welcome → Permissions → Connect AI → Shortcuts → Find me.
// The Sidekick lives on the left: it drops in on each step, points at what needs doing, cheers when
// something gets done and listens when you test your voice. Talks to the app through Tauri commands;
// opened in a plain browser it runs a simulated preview instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const invoke = window.__TAURI__?.core?.invoke ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const sfx = (name, arg) => Roamie.sfx?.play(name, arg);

  // ---------------------------------------------------------------- the Sidekick
  const canvas = $('roamie'), ctx = canvas.getContext('2d'), quipEl = $('quip'), tailEl = $('quip-tail');
  const HOME = { x: 150, y: 330 };
  let W = innerWidth, H = innerHeight, dpr = 1, K = null, clock = 0, actUntil = 0, poseFn = null;
  const env = {
    w: W, h: H, dpr, t: 0, unit: 330, transparent: true, spawn: { ...HOME },
    safe: { left: 30, right: W - 290, top: 70, bottom: 50 },
    mouse: { x: 0, y: 0, inside: false, active: false }, sleepy: 0, reduced: reduced.matches,
  };
  const sidekick = Roamie.ditherKit({
    id: 'guide', label: 'Guide', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
    pal: [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]],
    // busy: no random acts; pose: whatever the current step wants, except while acting something out.
    // calm while a quip is up: the act keeps its gesture but drops its icon, which would sit on the bubble.
    plugin: (kit) => { K = kit; return { busy: () => true, calm: () => !!quipText && clock < quipUntil, pose: () => (clock < actUntil ? null : poseFn?.(clock) ?? null) }; },
  }).create(env);
  const m = sidekick.mover;
  sidekick.vanish(null, true);

  const POSE = {
    point: (dx, dy) => (t) => ({ arms: 1, tr: [dx, dy + Math.sin(t * 4) * 0.05], tl: [-0.85, 0.5], mouth: 'grin' }),
    think: () => (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    listen: () => (t) => ({ arms: 1, tr: [0.98 + Math.sin(t * 7) * 0.04 * voice.level, -0.42 - voice.level * 0.1], tl: [-0.62, 0.88], oy: -voice.level * 3, mouth: 'flat', brow: 'raised' }),
    wait: () => (t) => ({ arms: 0.7, tl: [-0.45, 0.95 + Math.sin(t * 2.2) * 0.03], tr: [0.45, 0.95 - Math.sin(t * 2.2) * 0.03], mouth: 'flat' }),
  };
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  function act(name) {
    if (!K) return;
    K.startAct(name);
    actUntil = clock + (ACT_SECS[name] ?? 3) + (sidekick.hidden ? 0.8 : 0);
  }
  function moveTo(x, y) {
    y = clamp(y, 150, H - 100);
    m.anchor = { x, y, r: 6 };
    if (!sidekick.hidden) m.goTo(x, y);
  }
  // Swap in for a new step: leave the old spot with the step's exit, arrive with its entrance.
  const OUT = { materialize: 'crt', crt: 'materialize', drop: 'materialize' };
  let entering = 0;
  async function enter(variant, y = HOME.y) {
    const my = ++entering;
    y = clamp(y, 150, H - 100);
    m.anchor = { x: HOME.x, y, r: 6 };
    if (!sidekick.hidden && !reduced.matches) {
      sidekick.vanish(OUT[variant]);
      await wait(620);
      if (my !== entering) return;
    } else if (!sidekick.hidden) sidekick.vanish(null, true);
    sidekick.appear(reduced.matches ? 'crt' : variant, HOME.x, y);
  }

  // Short speech bubble above the head, typed out with the Sidekick's voice blips.
  let quipText = '', quipShown = 0, quipUntil = 0;
  function quip(text, secs = 2.4) {
    quipText = text; quipShown = 0; quipUntil = clock + secs + text.length * 0.035;
    quipEl.textContent = '';
    quipEl.classList.add('on');
    sfx('pop');
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now; clock += dt; env.t += dt; env.reduced = reduced.matches;
    // Eyes follow the cursor; when it's outside the window, they rest on the panel instead of wandering.
    if (!env.mouse.active) Object.assign(env.mouse, { x: 520, y: m.y - 20, inside: true, active: true, idle: true });
    sidekick.update(dt, env);
    if (env.mouse.idle) Object.assign(env.mouse, { active: false, idle: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save(); sidekick.draw(ctx, env); ctx.restore();
    if (quipText) {
      if (quipShown < quipText.length) {
        const before = Math.floor(quipShown);
        quipShown = Math.min(quipText.length, quipShown + dt * 42);
        const n = Math.floor(quipShown);
        if (n !== before) {
          quipEl.textContent = quipText.slice(0, n);
          if (n % 3 === 0 && /\w/.test(quipText[n - 1])) sfx('blip', 0.9 + Math.random() * 0.3);
        }
      }
      if (clock > quipUntil) { quipEl.classList.remove('on'); if (clock > quipUntil + 0.3) quipText = ''; }
      // Bubble sits just above the head; the stepped tail hangs from it, pointing at the Sidekick.
      const qx = clamp(m.x, 125, W - 125), qy = m.y - (K?.R ?? 50) * 1.45 - 6;
      quipEl.style.left = `${qx}px`; quipEl.style.top = `${qy}px`;
      tailEl.style.left = `${clamp(m.x, qx - 100, qx + 100)}px`; tailEl.style.top = `${qy - 0.5}px`;
    }
    voice.drawMeter(dt);
    requestAnimationFrame(frame);
  }
  function resize() {
    W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    Object.assign(env, { w: W, h: H, dpr });
    env.safe.right = W - 290;
    sidekick.resize(env);
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { Object.assign(env.mouse, { x: e.clientX, y: e.clientY, inside: true, active: true }); }, { passive: true });
  document.addEventListener('mouseleave', () => { env.mouse.active = false; });
  resize();
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- shared bits
  let state = null, cur = -1;
  const { el, led, okMark, PC_MOD, capsEl, fillCaps, dlMeter, fillMeter, pctOf } = window.RoamiesKit;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const CHEERS = ['Got it!', 'Nice!', 'Perfect.', 'Yes!'];
  const isMac = () => state?.platform === 'darwin';
  const MODE = new URLSearchParams(location.search).get('mode');
  const at = (name) => STEPS[cur]?.name === name;

  const capsFor = (mods, key) => RoamiesKit.capsFor(mods, key, isMac);
  const accelCaps = (accel) => RoamiesKit.accelCaps(accel, isMac);
  const TRAY_SVG = '<svg class="trayicon" viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><rect x="30" y="3" width="2" height="2"/><rect x="27" y="6" width="2" height="2"/><rect x="30" y="6" width="2" height="2"/><rect x="33" y="6" width="2" height="2"/><rect x="30" y="9" width="2" height="2"/><rect x="6" y="12" width="2" height="2"/><rect x="9" y="12" width="2" height="2"/><rect x="12" y="12" width="2" height="2"/><rect x="15" y="12" width="2" height="2"/><rect x="3" y="15" width="2" height="2"/><rect x="6" y="15" width="2" height="2"/><rect x="9" y="15" width="2" height="2"/><rect x="12" y="15" width="2" height="2"/><rect x="15" y="15" width="2" height="2"/><rect x="18" y="15" width="2" height="2"/><rect x="0" y="18" width="2" height="2"/><rect x="3" y="18" width="2" height="2"/><rect x="9" y="18" width="2" height="2"/><rect x="12" y="18" width="2" height="2"/><rect x="18" y="18" width="2" height="2"/><rect x="21" y="18" width="2" height="2"/><rect x="0" y="21" width="2" height="2"/><rect x="3" y="21" width="2" height="2"/><rect x="9" y="21" width="2" height="2"/><rect x="12" y="21" width="2" height="2"/><rect x="18" y="21" width="2" height="2"/><rect x="21" y="21" width="2" height="2"/><rect x="0" y="24" width="2" height="2"/><rect x="3" y="24" width="2" height="2"/><rect x="6" y="24" width="2" height="2"/><rect x="9" y="24" width="2" height="2"/><rect x="12" y="24" width="2" height="2"/><rect x="15" y="24" width="2" height="2"/><rect x="18" y="24" width="2" height="2"/><rect x="21" y="24" width="2" height="2"/><rect x="3" y="27" width="2" height="2"/><rect x="6" y="27" width="2" height="2"/><rect x="9" y="27" width="2" height="2"/><rect x="12" y="27" width="2" height="2"/><rect x="15" y="27" width="2" height="2"/><rect x="18" y="27" width="2" height="2"/><rect x="6" y="30" width="2" height="2"/><rect x="9" y="30" width="2" height="2"/><rect x="12" y="30" width="2" height="2"/><rect x="15" y="30" width="2" height="2"/></svg>';

  // ---------------------------------------------------------------- step 1: permissions
  const perms = {
    sys: { mic: 'unknown', speech: 'granted', speechNeeded: false, screen: 'unknown', accessibility: 'unknown' },
    files: { Desktop: 'unknown', Documents: 'unknown', Downloads: 'unknown' },
    asked: {}, waiting: null, poll: null, since: 0, seen: new Set(), guiding: null,
    // Screen Recording only turns green after one test screenshot works: idle → checking → ok | failed.
    shot: 'idle',
    rows() {
      // Windows: nothing to grant, but voice needs its speech model (downloaded once) and an unblocked mic.
      if (!isMac()) {
        const vm = state?.voiceModel;
        if (!state?.voice || !vm) return [];
        return [
          { id: 'mic', title: 'Microphone', desc: this.sys.input === false ? 'No microphone found yet. Plug one in.' : 'So you can talk to me.', pane: 'privacy-microphone', settingsOnly: true },
          { id: 'voice', title: 'My voice', desc: vm.status === 'error' ? vm.error : vm.status === 'downloading' ? `Downloading ${vm.size}. You can keep going.` : vm.status === 'ready' ? 'Speech stays on this PC.' : `One-time download, ${vm.size}. Speech stays on this PC.` },
        ];
      }
      return [
        { id: 'mic', title: 'Microphone', desc: 'So you can talk to me.', pane: 'Privacy_Microphone' },
        ...(this.sys.speechNeeded ? [{ id: 'speech', title: 'Speech recognition', desc: 'Turns your voice into text.', pane: 'Privacy_SpeechRecognition' }] : []),
        { id: 'screen', title: 'Screen recording', pane: 'Privacy_ScreenCapture', bad: this.shot === 'failed',
          desc: this.shot === 'failed' ? "Can't see yet. Reopen me." : this.shot === 'checking' ? 'Taking one test screenshot.' : 'So I can see your screen.' },
        { id: 'accessibility', title: 'Control apps', desc: 'Fill in forms and click for you.', pane: 'Privacy_Accessibility' },
        { id: 'files', title: 'Your files', desc: 'Desktop, Documents, Downloads.', pane: 'Privacy_FilesAndFolders' },
      ];
    },
    status(id) {
      if (id === 'files') {
        const v = Object.values(this.files);
        return v.every((s) => s === 'granted') ? 'granted' : v.some((s) => s === 'denied') ? 'denied' : 'unknown';
      }
      if (id === 'voice') return state?.voiceModel?.status === 'ready' ? 'granted' : 'unknown';
      if (id === 'screen' && this.sys.screen === 'granted') return this.shot === 'ok' ? 'granted' : 'unknown';
      return this.sys[id] ?? 'unknown';
    },
    // A voice download that's under way counts: it carries on after the guide closes.
    done() { return this.rows().every((r) => this.status(r.id) === 'granted' || (r.id === 'voice' && state.voiceModel.status === 'downloading')); },
    async allow(r) {
      if (r.settingsOnly) { this.asked[r.id] = true; invoke('open_settings', { pane: r.pane }); quip('Switch microphone access on!'); this.render(); return; }
      if (r.id === 'voice') { send({ type: 'ob_voice_model' }); act('hype'); quip('Downloading! Keep going', 3); return; }
      this.waiting = r.id; this.asked[r.id] = true; this.render();
      poseFn = POSE.point(1.7, -0.1);
      if (r.id === 'files') { quip('Click OK when it asks!'); send({ type: 'ob_files', request: true }); return; }
      if (r.id === 'screen' || r.id === 'accessibility') {
        // Straight to the Settings pane, skipping macOS's "Open System Settings?" dialog; the panel under
        // Settings has my icon to drag into the list. Screen Recording only counts after a relaunch.
        this.waiting = null;
        this.openSettings(r);
        quip('Drag me into the list!', 5);
        this.render();
        return;
      }
      quip('Click Allow when it asks!');
      const res = await invoke('perm_request', { kind: r.id });
      this.apply(res);
      if (this.waiting === r.id) this.waiting = null;
      this.render();
      // macOS hands focus back to whatever app was in front before its dialog, burying the guide.
      invoke('focus_guide').catch(() => {});
    },
    // Drag-me-in panel under System Settings (macOS), for the pane that's being switched on.
    guide(kind) { this.guiding = kind; invoke('perm_guide', { kind }).catch(() => {}); },
    unguide() { if (!this.guiding) return; this.guiding = null; invoke('perm_guide', { kind: null }).catch(() => {}); },
    openSettings(r) { invoke('open_settings', { pane: r.pane }); if (r.id === 'screen' || r.id === 'accessibility') this.guide(r.id); },
    apply(res) {
      if (!res || res.unsupported || res.error) return;
      for (const k of ['mic', 'speech', 'screen', 'accessibility']) if (res[k]) this.sys[k] = res[k];
      this.sys.speechNeeded = !!res.speechNeeded;
      if (typeof res.input === 'boolean') this.sys.input = res.input;
      this.checkShot();
    },
    async checkShot() {
      if (!isMac() || this.shot !== 'idle' || this.sys.screen !== 'granted') return;
      this.shot = 'checking'; this.render();
      const res = await invoke('screen_check').catch(() => null);
      this.shot = res?.seen || res?.unsupported ? 'ok' : 'failed';
      if (this.shot === 'failed' && at('perms')) { act('upset'); quip('Switch me on, then Reopen', 5); }
      this.render();
    },
    applyFiles(status) {
      this.files = { ...this.files, ...status };
      if (this.waiting === 'files') { this.waiting = null; invoke('focus_guide').catch(() => {}); }
    },
    render() {
      const list = $('perm-rows');
      const rows = this.rows();
      $('perm-lead').textContent = isMac() ? 'Only used when you ask me something.' : rows.length ? 'One download so I can hear you. Your voice never leaves this PC.' : 'Nothing to allow here. Just one choice below.';
      const firstPending = rows.find((r) => this.status(r.id) !== 'granted');
      list.replaceChildren(...rows.map((r) => {
        const st = this.status(r.id);
        let side;
        if (r.id === 'voice' && st === 'granted') side = okMark('Ready');
        else if (r.id === 'voice' && state.voiceModel.status === 'downloading') side = dlMeter(state.voiceModel);
        else if (r.id === 'voice') side = el('button', { className: `px btn ${state.voiceModel.status === 'error' ? 'ghost' : 'primary'}`, type: 'button', textContent: state.voiceModel.status === 'error' ? 'Retry' : 'Download', onclick: () => this.allow(r) });
        else if (r.id === 'screen' && this.shot === 'checking') side = el('span', { className: 'waiting', textContent: 'Checking…' });
        else if (r.id === 'screen' && this.shot === 'failed') side = el('span', { className: 'pair' },
          el('button', { className: 'px btn ghost', type: 'button', textContent: 'Reopen', onclick: () => { quip('Be right back!'); setTimeout(() => invoke('relaunch'), 400); } }),
          el('button', { className: 'px btn primary', type: 'button', textContent: 'Try again', onclick: () => { this.shot = 'idle'; this.checkShot(); } }));
        else if (st === 'granted') side = okMark(this.asked[r.id] || !isMac() ? 'Allowed' : 'Already allowed');
        else if (this.waiting === r.id) side = el('span', { className: 'waiting', textContent: 'Waiting for you…' });
        else if (r.id === 'screen' && this.asked.screen) side = el('span', { className: 'pair' },
          el('button', { className: 'px btn ghost', type: 'button', textContent: 'Settings', onclick: () => { this.openSettings(r); quip('Switch on Roamies'); } }),
          el('button', { className: 'px btn primary', type: 'button', textContent: 'Reopen', onclick: () => { quip('Be right back!'); setTimeout(() => invoke('relaunch'), 400); } }));
        else if (st === 'denied' || this.asked[r.id]) side = el('button', { className: 'px btn ghost', type: 'button', textContent: 'Open Settings', onclick: () => { this.openSettings(r); quip(isMac() ? 'Switch Roamies on!' : 'Turn on desktop apps!', 4); } });
        else if (!isMac()) side = el('span', { className: 'waiting', textContent: 'Checking…' });
        else side = el('button', { className: 'px btn primary', type: 'button', textContent: 'Allow', onclick: () => this.allow(r) });
        const li = el('li', { className: `px row${st === 'granted' ? ' granted' : r === firstPending ? ' focus' : ''}`, id: `perm-${r.id}` },
          el('div', {}, el('h2', { textContent: r.title }), el('p', { textContent: r.desc, title: r.desc, className: r.bad || (r.id === 'voice' && state.voiceModel.status === 'error') ? 'bad' : '' })), side);
        return li;
      }));
      // Not an OS permission, but the agent's other half: settle it here too.
      const sw = el('button', { className: 'px switch', type: 'button', role: 'switch' });
      sw.setAttribute('aria-checked', String(!!state?.actions));
      sw.setAttribute('aria-label', 'Let me edit files, run commands and use apps');
      // The line under the title follows the switch, so it never says Off while the switch is on.
      const actionsDesc = (on) => (on ? 'On: I can change files, run commands, and click and type in other apps, carefully.' : 'Off: I can look, never change or click.');
      const swDesc = el('p', { textContent: actionsDesc(!!state?.actions) });
      sw.onclick = () => { const on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(on)); swDesc.textContent = actionsDesc(on); send({ type: 'set_actions', on }); if (on) { act('hype'); quip("I'll be careful!"); } };
      list.append(el('li', { className: 'px row' },
        el('div', {}, el('h2', { textContent: 'Edit files, run commands and use apps' }), swDesc), sw));
      // Only an installed copy can start at login, so the row is hidden otherwise (login is null).
      if (state?.login != null) {
        const ls = el('button', { className: 'px switch', type: 'button', role: 'switch' });
        ls.setAttribute('aria-checked', String(!!state.login));
        ls.setAttribute('aria-label', 'Open Roamies at login');
        ls.onclick = () => { const on = ls.getAttribute('aria-checked') !== 'true'; ls.setAttribute('aria-checked', String(on)); send({ type: 'set_login', on }); if (on) quip("See you every morning!"); };
        list.append(el('li', { className: 'px row' },
          el('div', {}, el('h2', { textContent: 'Open at login' }), el('p', { textContent: 'Start with your computer.' })), ls));
      }

      if (this.guiding && this.status(this.guiding) === 'granted') this.unguide();

      const screenStuck = isMac() && this.asked.screen && this.status('screen') !== 'granted';
      if (screenStuck && !this.hinted && this.waiting !== 'screen') { this.hinted = true; setTimeout(() => at('perms') && quip('Switched me on? Hit Reopen', 5), 6000); }

      // Cheer for anything that just turned green.
      for (const r of rows) {
        const g = this.status(r.id) === 'granted';
        if (g && !this.seen.has(r.id)) { this.seen.add(r.id); if (at('perms') && this.since && clock - this.since > 0.8) { act('hype'); quip(pick(CHEERS)); } }
      }
      if (at('perms')) {
        if (firstPending && this.waiting == null) { poseFn = POSE.point(1.7, -0.1); aim($(`perm-${firstPending.id}`)); }
        else if (!firstPending) { poseFn = null; moveTo(HOME.x, HOME.y); }
      }
      nav();
    },
    enter() {
      perms.since = clock;
      for (const r of perms.rows()) if (perms.status(r.id) === 'granted') perms.seen.add(r.id);
      perms.render();
      // Hint after the first status check, so it matches what's actually left to allow.
      setTimeout(() => {
        if (!at('perms')) return;
        const left = perms.rows().filter((r) => perms.status(r.id) !== 'granted').length;
        if (!isMac()) quip(left === 0 ? 'Already sorted!' : perms.status('mic') === 'denied' ? 'Unblock the mic' : 'Grab my voice!');
        else quip(left === 0 ? 'Already sorted!' : left === 1 ? 'Just one to allow' : 'Tap Allow on each one');
      }, 900);
      const tick = async () => {
        perms.apply(await invoke('perm_status'));
        // Probe folders only after Allow was tapped in this run: reading them is the permission prompt.
        if (perms.asked.files) send({ type: 'ob_files', request: false });
        perms.render();
      };
      tick();
      perms.poll = setInterval(tick, 1500);
    },
    leave() { clearInterval(perms.poll); perms.poll = null; poseFn = null; perms.unguide(); },
    // Download progress updates the meter in place; rebuilding the rows would steal keyboard focus.
    progress() {
      const meter = document.querySelector('#perm-voice .dl');
      if (meter && state.voiceModel.status === 'downloading') fillMeter(meter, state.voiceModel);
      else this.render();
    },
  };
  // Line the Sidekick up with a row so it points right at it.
  function aim(node) {
    if (!node) return;
    const r = node.getBoundingClientRect();
    moveTo(HOME.x, r.top + r.height / 2 + 6);
  }

  // ---------------------------------------------------------------- step 2: connect AI
  const ai = {
    busy: null, keyOpen: false,
    render() {
      const conn = $('connected');
      conn.hidden = !state?.connected;
      if (state?.connected) conn.replaceChildren(led(), `Connected to ${state.connected.provider} · ${state.connected.model}`);
      $('providers').replaceChildren(...(state?.oauth ?? []).map((p) => {
        const busy = ai.busy === p.id;
        const b = el('button', { className: `px prov${p.connected ? ' on' : ''}${busy ? ' busy' : ''}`, type: 'button' },
          el('span', { textContent: p.name }), led(p.connected ? 'on' : busy ? 'busy' : ''),
          el('small', { textContent: busy ? 'Waiting for browser…' : p.connected ? 'Connected' : p.company }));
        b.disabled = !!ai.busy && ai.busy !== p.id;
        b.onclick = () => ai.login(p);
        return b;
      }));
      const sel = $('key-provider');
      if (!sel.options.length) for (const p of state?.apikey ?? []) sel.append(el('option', { value: p.id, textContent: p.name }));
      nav();
    },
    login(p) {
      if (ai.busy) return;
      ai.busy = p.id; $('login-error').hidden = true; ai.render();
      poseFn = POSE.think();
      quip("Sign in there. I'll wait!", 3.2);
      send({ type: 'ob_login', provider: p.id });
    },
    onLogin(msg) {
      if (msg.phase === 'browser') return;
      ai.busy = null; poseFn = null;
      if (msg.phase === 'done') { act('hype'); quip('Ooh, a brain!'); $('code-form').hidden = true; }
      else { const e = $('login-error'); e.hidden = false; e.textContent = e.title = `That didn't work: ${msg.error}`; quip('Hmm. Try again?'); }
      ai.render();
    },
    enter() {
      ai.render();
      setTimeout(() => at('ai') && quip(state?.connected ? 'Already connected!' : 'Pick one you have'), 700);
      if (state?.connected) setTimeout(() => at('ai') && act('hype'), 900);
      else poseFn = POSE.point(1.7, 0.05);
      aim($('providers'));
    },
    leave() { poseFn = null; },
  };
  let askId = null;
  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('code-input').value.trim();
    if (!v || !askId) return;
    send({ type: 'answer', id: askId, text: v });
    askId = null; $('code-form').hidden = true; $('code-input').value = '';
  });
  $('key-toggle').addEventListener('click', () => {
    ai.keyOpen = !ai.keyOpen;
    $('key-form').hidden = !ai.keyOpen;
    $('key-toggle').setAttribute('aria-expanded', String(ai.keyOpen));
    if (ai.keyOpen) $('key-input').focus();
  });
  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('key-input').value.trim();
    if (!key) return $('key-input').focus();
    ai.busy = $('key-provider').value; ai.render();
    poseFn = POSE.think();
    send({ type: 'ob_apikey', provider: ai.busy, key });
    $('key-input').value = '';
  });

  // ---------------------------------------------------------------- step 3: shortcuts
  const MAC_CHORDS = [['control', 'option'], ['option', 'command'], ['control', 'command'], ['control', 'shift'], ['option', 'shift']];
  // Windows: no Win key (letting go of it opens Start) and no Alt+Shift (it switches keyboard layout).
  const PC_CHORDS = [['control', 'option'], ['control', 'shift']];
  const chords = () => (isMac() ? MAC_CHORDS : PC_CHORDS);
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const voice = {
    level: 0, target: 0, bars: [], listening: false, streaming: true,
    drawMeter(dt) {
      voice.level += (voice.target - voice.level) * Math.min(1, dt * (voice.target > voice.level ? 30 : 8));
      voice.target *= Math.exp(-dt * 3);
      const inChat = at('chat'), meter = inChat ? $('chat-meter') : $('meter');
      if (!(inChat ? $('chat-talk').classList.contains('on') : voice.listening)) { if (meter.childElementCount) meter.replaceChildren(); return; }
      voice.bars.push(voice.level); if (voice.bars.length > 14) voice.bars.shift();
      if (meter.childElementCount !== voice.bars.length) meter.replaceChildren(...voice.bars.map(() => el('i')));
      [...meter.children].forEach((b, i) => { b.style.height = `${2 + voice.bars[i] * 12}px`; });
    },
    on(msg) {
      if (!at('keys')) return;
      const heard = $('heard');
      if (msg.type === 'state' && msg.state === 'listening') {
        // Engines that don't stream (Parakeet) send no partials, so say the text comes at the end.
        voice.streaming = msg.streaming !== false;
        voice.listening = true; heard.textContent = voice.streaming ? 'Listening…' : "Listening… I'll write it out when you stop"; poseFn = POSE.listen(); sfx('listen');
      } else if (msg.type === 'level') voice.target = clamp(msg.v, 0, 1);
      else if (msg.type === 'partial') { if (voice.streaming) heard.textContent = msg.text; }
      else if (msg.type === 'state' && msg.state === 'processing') { voice.listening = false; if (!voice.streaming) heard.textContent = 'Writing it out…'; }
      else if (msg.type === 'final') {
        voice.listening = false; poseFn = null;
        heard.textContent = `“${msg.text}”`;
        act('hype'); quip('I heard you!'); sfx('heard');
      } else if (msg.type === 'state' && msg.state === 'idle') { voice.listening = false; if (poseFn) poseFn = null; }
      else if (msg.type === 'error') {
        voice.listening = false; poseFn = null;
        heard.textContent = msg.code === 'permission' ? 'I need the Microphone (step 2) to hear you.' : msg.code === 'unavailable' ? 'My voice isn’t ready yet. Give me a moment.' : msg.code === 'nothing_heard' ? "Didn't catch that. Try again?" : 'Something went wrong. Try again?';
        quip(msg.code === 'permission' ? 'I can’t hear you yet' : 'Again?');
      }
    },
  };
  // Recorder for the two letter-key shortcuts: 'summon' (show/hide) and 'snap' (ask about an area).
  const keys = {
    recording: null,
    render() {
      const k = state?.keys; if (!k) return;
      $('talk-row').hidden = !state.voice;
      $('chords').replaceChildren(...chords().map((c) => {
        const on = same(c, k.talk);
        const b = el('button', { className: 'px chord', type: 'button', role: 'radio', tabIndex: on ? 0 : -1 }, capsEl(capsFor(c)));
        b.setAttribute('aria-checked', String(on));
        b.setAttribute('aria-label', `Hold ${c.map((x) => (isMac() ? x[0].toUpperCase() + x.slice(1) : PC_MOD[x])).join(' and ')}`);
        b.onclick = () => { if (!on) { send({ type: 'set_keys', talk: c }); quip('Ooh, fancy.'); } };
        return b;
      }));
      keys.tryLabel();
      $('snap-line').hidden = !state?.canSnap || !k.snap;
      $('draw-tip').hidden = !isMac();
      for (const w of ['summon', 'snap']) if (keys.recording !== w && k[w]) fillCaps($(`${w}-caps`), accelCaps(k[w]));
      nav();
    },
    // Windows can only try talking once the speech model is downloaded.
    tryLabel() {
      const k = state?.keys, vm = state?.voiceModel; if (!k) return;
      const tl = $('try-label');
      if (!isMac() && vm && vm.status !== 'ready') tl.replaceChildren(vm.status === 'downloading' ? `Try it once my voice has downloaded (${pctOf(vm)}%).` : 'Download my voice in step 2 to try it.');
      else tl.replaceChildren('Try it: hold ', capsEl(capsFor(k.talk)), ' and say hi');
    },
    record(which) {
      if (keys.recording) keys.stop();
      keys.recording = which;
      $('keys-error').hidden = true;
      $(`${which}-caps`).textContent = 'Press keys…';
      $(`${which}-caps`).parentElement.classList.add('recording');
      $(`${which}-change`).textContent = 'Cancel';
      poseFn = POSE.wait(); quip('Press your new combo');
    },
    stop() {
      const w = keys.recording;
      keys.recording = null;
      if (w) { $(`${w}-caps`).parentElement.classList.remove('recording'); $(`${w}-change`).textContent = 'Change'; }
      poseFn = null;
      keys.render();
    },
    enter() { keys.render(); aim($('chords')); setTimeout(() => at('keys') && quip(state?.voice ? 'Try talking to me!' : 'Your shortcuts'), 700); },
    leave() { if (keys.recording) keys.stop(); poseFn = null; voice.listening = false; },
  };
  for (const id of ['chords', 'looks', 'sizes']) $(id).addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const btns = [...$(id).children], i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const n = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[n].click(); requestAnimationFrame(() => $(id).children[n]?.focus());
  });
  for (const w of ['summon', 'snap']) $(`${w}-change`).addEventListener('click', () => (keys.recording === w ? keys.stop() : keys.record(w)));
  addEventListener('keydown', (e) => {
    if (!keys.recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') return keys.stop();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { $('keys-error').hidden = false; $('keys-error').textContent = isMac() ? 'Hold Control, Option or Command too.' : 'Hold Ctrl or Alt too.'; return; }
    if (!/^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(e.code)) return;
    const which = keys.recording;
    keys.stop();
    send({ type: 'set_keys', [which]: [...mods, e.code].join('+') });
    act('hype'); quip('Got it!');
  }, true);

  // ---------------------------------------------------------------- step 4: find me
  const find = {
    enter() {
      const k = state?.keys;
      const recap = $('recap');
      recap.replaceChildren();
      if (state?.voice && k) recap.append(el('dt', {}, capsEl(capsFor(k.talk))), el('dd', { textContent: 'Hold to talk to me' }));
      if (k) recap.append(el('dt', {}, capsEl(accelCaps(k.summon))), el('dd', { textContent: 'Show or hide me' }));
      if (k?.snap && state?.canSnap) recap.append(el('dt', {}, capsEl(accelCaps(k.snap))), el('dd', { textContent: 'Ask about an area of the screen' }));
      const tray = el('span', { className: 'caps' }); const cap = el('kbd', { className: 'px cap' }); cap.innerHTML = TRAY_SVG; tray.append(cap);
      recap.append(el('dt', {}, tray), el('dd', { textContent: isMac() ? 'Everything else, in the menu bar' : 'Everything else, in the system tray' }));
      // Windows keeps tray icons at the bottom right, and new ones start hidden behind the ^ arrow.
      const mac = isMac();
      $('h-4').textContent = mac ? 'Find me up here' : 'Find me down here';
      $('find-where').textContent = mac ? 'I live in your menu bar. Click ' : 'I live in the system tray, at the bottom right of your taskbar. Click ';
      $('find-tip').hidden = mac;
      $('find-bar').classList.toggle('taskbar', !mac);
      poseFn = POSE.point(1.25, mac ? -1.45 : 1.2);
      setTimeout(() => at('find') && quip(mac ? 'I live up there!' : 'I live down there!'), 750);
    },
    leave() { poseFn = null; },
  };

  // ---------------------------------------------------------------- the get-to-know-you chat
  // Four questions from the AI (sidekick.mjs runs it): each reply shows as a reaction, the question as the
  // heading and a nudge under the answer box. Answer by typing (Enter sends) or holding the talk keys: the words
  // appear in the box as you speak and send when you let go. The end lists what it learned, each removable.
  // How a turn appears. Words come in as the model streams them and are sorted the way the sidecar splits a
  // turn (intro.mjs splitTurn): sentences before the last question are the reaction, that question is the
  // heading, anything after it the nudge. A sentence shows only once it's complete, so a question never starts
  // out in the reaction and jumps up. Each slot reveals its words one at a time, in reading order (reaction,
  // heading, nudge), at a steady pace that speeds up to catch up, so uneven chunks never show as lurches.
  const SENTENCES = /[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g;
  const splitStream = (raw, final) => {
    const parts = raw.replace(/\s+/g, ' ').match(SENTENCES)?.map((x) => x.trim()).filter(Boolean) ?? [];
    // The last sentence counts once it has its stop and the stream has moved past it (or the reply is over).
    if (!final && parts.length && (!/[.!?…]["'”’)]*$/.test(parts.at(-1)) || !/\s$/.test(raw))) parts.pop();
    let qi = -1;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].includes('?')) { qi = i; break; }
    return qi < 0 ? { lead: parts.join(' '), question: null, hint: '' } : { lead: parts.slice(0, qi).join(' '), question: parts[qi], hint: parts.slice(qi + 1).join(' ') };
  };
  const reveal = (() => {
    const slots = {};
    const slot = (id) => (slots[id] ??= { el: $(id), words: [], n: 0, stale: false });
    const word = (w, fresh) => el('span', { className: fresh ? 'chat-w in' : 'chat-w', textContent: w });
    const paint = (s, n, fresh = false) => {
      for (let i = s.n; i < n; i++) s.el.append(...(i ? [' '] : []), word(s.words[i], fresh));
      s.n = n;
    };
    let raf = 0, last = 0, acc = 0;
    const order = ['chat-lead', 'chat-q', 'chat-hint'];
    const tick = (t) => {
      raf = 0;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t;
      const s = order.map(slot).find((x) => x.next || x.n < x.words.length);
      if (!s) { last = 0; return; }
      // Its turn: last turn's dimmed text gives way to the new text's first word in the same frame.
      if (s.next) { s.words = s.next; s.next = null; s.stale = false; s.el.classList.remove('stale'); s.el.replaceChildren(); s.n = 0; paint(s, 1, !REDUCED()); acc = 0; onReveal(); raf = requestAnimationFrame(tick); return; }
      // About 11 words a second (a bit faster than they're read), quicker when it's behind.
      const behind = s.words.length - s.n;
      acc += dt * (11 + Math.max(0, behind - 4) * 2.5);
      const k = Math.floor(acc);
      if (k > 0 || REDUCED()) { acc -= k; paint(s, Math.min(s.words.length, s.n + (REDUCED() ? behind : Math.max(1, k))), !REDUCED()); }
      onReveal();
      raf = requestAnimationFrame(tick);
    };
    let onReveal = () => {};
    return {
      set onReveal(f) { onReveal = f; },
      // Aim a slot at its text. Shown words that still match stay; new ones reveal. A changed word (the final
      // text tidied a little) is put right in place, without starting over. A stale slot (last turn's heading,
      // left dim until the new one starts) is cleared first, so the new text reveals from its first word.
      to(id, text) {
        const s = slot(id), words = text ? text.split(' ') : [];
        // Stale: the new text waits (s.next) until the reveal reaches this slot, in reading order.
        if (s.stale) { if (words.length) { s.next = words; if (!raf) raf = requestAnimationFrame(tick); } return; }
        const keep = Math.min(s.n, words.length);
        if (s.words.slice(0, keep).some((w, i) => w !== words[i]) || keep < s.n) { s.words = words; s.el.replaceChildren(); s.n = 0; paint(s, keep); }
        s.words = words;
        if (!raf && s.n < words.length) raf = requestAnimationFrame(tick);
      },
      // Show a slot's text at once (a fixed line, not something being said).
      now(id, text) { const s = slot(id); s.stale = false; s.next = null; s.el.classList.remove('stale'); s.words = text ? text.split(' ') : []; s.el.replaceChildren(); s.n = 0; paint(s, s.words.length); },
      // Keep what it says, dimmed, until something new starts in it.
      dim(id) { const s = slot(id); if (s.n) { s.stale = true; s.el.classList.add('stale'); } },
      shown: (id) => slot(id).n,
      done: () => order.every((id) => !slot(id).next && slot(id).n >= slot(id).words.length),
    };
  })();
  const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  reveal.onReveal = () => chat.slots();

  const chat = {
    status: 'idle', // idle → thinking ⇄ asking → done | skipped | no_model | failed
    n: 0, total: 4, text: '', facts: [], heard: false, before: '', fixed: '',
    enter() {
      if (chat.status === 'idle') {
        chat.status = 'thinking';
        send({ type: 'chat_start' });
        setTimeout(() => at('chat') && act('wave'), 700);
      }
      chat.voiceHint();
      chat.render();
    },
    leave() { poseFn = null; Roamie.voiceOut?.stop(); },
    over: () => ['done', 'skipped', 'no_model', 'failed'].includes(chat.status),
    nav() {
      const over = chat.over();
      $('next').textContent = over ? (cur === STEPS.length - 1 ? 'Done' : 'Continue') : 'Send';
      $('next').disabled = !over && (chat.status !== 'asking' || !$('chat-input').value.trim());
      $('back').disabled = cur === 0 || !over;
      $('skip').hidden = over;
      $('skip').textContent = 'Skip these questions';
    },
    next() { if (chat.over()) return false; chat.send(); return true; },
    skip() {
      if (chat.over()) return false;
      send({ type: 'chat_skip' });
      chat.status = 'skipped';
      Roamie.voiceOut?.stop();
      chat.render();
      if (MODE === 'chat') finish();
      return true;
    },
    send(text = $('chat-input').value.trim()) {
      if (!text || chat.status !== 'asking') return;
      Roamie.voiceOut?.stop();
      send({ type: 'chat_answer', text });
      $('chat-input').value = '';
      chat.text = '';
      chat.status = 'thinking';
      reveal.to('chat-lead', ''); reveal.to('chat-hint', ''); reveal.dim('chat-q');
      chat.render();
    },
    on(msg) {
      if (msg.kind === 'chat') {
        const e = msg.e;
        if (e.type === 'start') chat.text = '';
        else if (e.type === 'text') { chat.text += e.text; if (chat.status === 'thinking') chat.stream(false); }
        else if (e.type === 'emote' && at('chat')) act(e.action);
        return;
      }
      if (msg.kind === 'chat_state') {
        if (msg.status === 'busy') return;
        chat.status = msg.status;
        if (msg.n != null) { chat.n = msg.n; chat.total = msg.total; }
      } else if (msg.kind === 'chat_turn') {
        Object.assign(chat, { status: 'asking', n: msg.n, total: msg.total, lead: msg.lead, question: msg.question, hint: msg.hint });
        // The sidecar's split is the final word; it matches what's streamed, so this only finishes it off.
        reveal.to('chat-lead', msg.lead || ''); reveal.to('chat-q', msg.question || 'Tell me more?'); reveal.to('chat-hint', msg.hint || '');
        $('chat-say').textContent = [msg.lead, msg.question].filter(Boolean).join(' ');
        if (at('chat')) setTimeout(() => $('chat-input').focus({ preventScroll: true }), 50);
      } else if (msg.kind === 'chat_done') {
        Object.assign(chat, { status: msg.skipped ? 'skipped' : 'done', done: msg.text ?? '', facts: msg.facts ?? [] });
        if (!msg.skipped) { reveal.to('chat-lead', chat.done); reveal.to('chat-hint', ''); reveal.dim('chat-q'); reveal.to('chat-q', 'Nice to meet you'); $('chat-say').textContent = `Nice to meet you. ${chat.done}`; }
        if (at('chat') && !msg.skipped) act('hype');
      } else if (msg.kind === 'chat_facts') chat.facts = msg.facts ?? [];
      chat.render();
    },
    // Which slots show: "Thinking" holds the reaction's place until its first words arrive (same height, so
    // nothing below moves), and the nudge appears with its first word.
    slots() {
      const busy = chat.status === 'thinking' && !reveal.shown('chat-lead');
      $('chat-busy').hidden = !busy;
      $('chat-lead').hidden = busy;
      // The nudge keeps its two lines reserved while the chat runs (visibility, not display), so it appearing
      // never pushes the answer box up.
      $('chat-hint').hidden = chat.over();
      $('chat-hint').classList.toggle('empty', !reveal.shown('chat-hint'));
    },
    // What's streamed so far, sorted into its slots.
    stream(final) {
      const t = splitStream(chat.text, final);
      reveal.to('chat-lead', t.lead);
      if (t.question) reveal.to('chat-q', t.question);
      reveal.to('chat-hint', t.hint);
      chat.render();
    },
    render() {
      const st = chat.status, asking = st === 'asking', thinking = st === 'thinking';
      $('chat-count').textContent = chat.over() ? '' : `Question ${Math.min(chat.total, chat.n + 1)} of ${chat.total}`;
      // On its own (from the menu), the LED bar counts the questions instead of the setup steps.
      if (MODE === 'chat') {
        const done = chat.over() ? chat.total : chat.n;
        if ($('progress').childElementCount !== chat.total) $('progress').replaceChildren(...Array.from({ length: chat.total }, () => el('li')));
        [...$('progress').children].forEach((li, j) => { li.className = j < done ? 'done' : ''; if (j === done) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
      }
      // Fixed lines (not something it's saying) show at once; a turn's words reveal as they stream (above).
      const FIXED = {
        skipped: ['Maybe later', 'No problem. Get to Know Me is in the Roamies panel any time.'],
        no_model: ['I need a brain first', 'Connect an AI account in the Roamies panel, then try Get to Know Me again.'],
        failed: ["That didn't work", "I couldn't reach the AI. Try Get to Know Me from the Roamies panel in a moment."],
      };
      if (FIXED[st] && chat.fixed !== st) { chat.fixed = st; reveal.now('chat-q', FIXED[st][0]); reveal.now('chat-lead', FIXED[st][1]); reveal.now('chat-hint', ''); }
      else if (thinking && !chat.n && !reveal.shown('chat-q')) reveal.now('chat-q', 'Getting to know you');
      $('chat-form').hidden = chat.over();
      $('chat-input').disabled = !asking;
      chat.slots();
      if (at('chat') && !$('chat-talk').classList.contains('on')) poseFn = thinking ? POSE.think() : asking ? POSE.wait() : null;
      $('chat-facts').hidden = st !== 'done' || !chat.facts.length;
      $('chat-facts-list').replaceChildren(...chat.facts.map((f) => {
        const b = el('button', { className: 'link', type: 'button', textContent: 'Remove' });
        b.setAttribute('aria-label', `Forget: ${f.text}`);
        b.onclick = () => { send({ type: 'chat_forget', id: f.id }); chat.facts = chat.facts.filter((x) => x.id !== f.id); chat.render(); };
        return el('li', { className: 'px row fact-row' }, el('span', { className: 'fact', textContent: f.text, title: f.text }), b);
      }));
      nav();
    },
    // The talk keys answer too: hold, speak, let go.
    voiceHint() {
      const can = !!(state?.voice && state.keys && (isMac() || state.voiceModel?.status === 'ready'));
      $('chat-talk').hidden = !can;
      if (can) $('chat-talk-keys').replaceChildren(capsEl(capsFor(state.keys.talk)));
    },
    voice(msg) {
      const input = $('chat-input'), talk = $('chat-talk');
      if (chat.status !== 'asking') return;
      if (msg.type === 'state' && msg.state === 'listening') {
        chat.heard = false; chat.before = input.value; input.value = ''; input.placeholder = 'Listening…';
        talk.classList.add('on'); poseFn = POSE.listen(); sfx('listen'); Roamie.voiceOut?.stop();
      } else if (msg.type === 'level') voice.target = clamp(msg.v, 0, 1);
      else if (msg.type === 'partial') input.value = msg.text;
      else if (msg.type === 'final') {
        chat.heard = true; talk.classList.remove('on'); input.placeholder = 'Type your answer…';
        sfx('heard'); chat.send(String(msg.text ?? '').trim());
      } else if (msg.type === 'state' && msg.state === 'idle') {
        talk.classList.remove('on'); input.placeholder = 'Type your answer…';
        if (!chat.heard && !input.value) input.value = chat.before;
        if (chat.status === 'asking') poseFn = POSE.wait();
      } else if (msg.type === 'error') {
        talk.classList.remove('on'); input.placeholder = 'Type your answer…'; input.value = chat.before;
        poseFn = POSE.wait();
        quip(msg.code === 'permission' ? 'I can’t hear you yet' : 'Didn’t catch that');
      }
      nav();
    },
  };
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); chat.send(); });
  $('chat-input').addEventListener('input', () => nav());

  // ---------------------------------------------------------------- flow
  // ---------------------------------------------------------------- step 0: look and size
  // Picked here, previewed on the guide right away, saved by the app (Settings has the same choices).
  const LOOKS = [['classic', 'Roamie'], ['jarvis', 'JARVIS'], ['anime', 'Anime Girl'], ['sarah', 'Sarah'], ['adrian', 'Adrian']], SIZES = [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']];
  const LOOK_QUIPS = { classic: 'Classic me!', jarvis: 'At your service.', anime: 'Yay, hi hi!', sarah: 'Hey, nice to meet you!', adrian: 'Alright, let\'s do this.' }, SIZE_QUIPS = { default: 'Full size!', small: 'Fun size!', cursor: 'Tiny pointer me!' };
  const look = {
    radios(id, list, value, pickIt) {
      $(id).replaceChildren(...list.map(([v, label]) => {
        const on = v === value;
        const b = el('button', { className: 'px chord', type: 'button', role: 'radio', tabIndex: on ? 0 : -1 }, el('span', { className: 'px cap', textContent: label }));
        b.setAttribute('aria-checked', String(on));
        b.onclick = () => { if (!on) pickIt(v); };
        return b;
      }));
    },
    render() {
      $('h-0').textContent = `Hi, I'm ${(LOOKS.find(([v]) => v === (state?.look ?? 'classic')) ?? LOOKS[0])[1]}.`;
      look.radios('looks', LOOKS, state?.look ?? 'classic', (v) => { state.look = v; sidekick.setLook?.(v); send({ type: 'ob_look', look: v }); quip(LOOK_QUIPS[v]); look.render(); });
      look.radios('sizes', SIZES, state?.size ?? 'default', (v) => { state.size = v; sidekick.setForm?.(v); send({ type: 'ob_size', size: v }); quip(SIZE_QUIPS[v]); look.render(); });
    },
  };

  const ALL = [
    { name: 'welcome', enter: 'drop', next: "Let's go", onEnter: () => { look.render(); setTimeout(() => { if (at('welcome')) { act('wave'); quip('Hi there!'); } }, 650); } },
    // Windows: the voice download is optional, so it can be skipped.
    { name: 'perms', enter: 'materialize', next: 'Continue', onEnter: perms.enter, onLeave: perms.leave, ready: () => perms.done(), get skip() { return !isMac(); } },
    { name: 'ai', enter: 'crt', next: 'Continue', onEnter: ai.enter, onLeave: ai.leave, ready: () => !!state?.connected, skip: true },
    { name: 'keys', enter: 'materialize', next: 'Continue', onEnter: keys.enter, onLeave: keys.leave },
    { name: 'chat', enter: 'crt', next: 'Send', onEnter: () => chat.enter(), onLeave: () => chat.leave(), nav: () => chat.nav(), onNext: () => chat.next(), onSkip: () => chat.skip() },
    { name: 'find', enter: 'drop', next: 'Done', onEnter: find.enter, onLeave: find.leave },
  ];
  // ?mode=chat: only the get-to-know-you chat (from the menu's Get to Know Me…).
  const STEPS = MODE === 'chat' ? ALL.filter((s) => s.name === 'chat') : ALL;
  const sectionOf = (s) => $(`step-${s.name}`);
  for (const s of ALL) if (!STEPS.includes(s)) sectionOf(s).hidden = true;
  const sections = STEPS.map(sectionOf);
  $('progress').replaceChildren(...STEPS.map(() => el('li')));

  // Required steps unlock after a while anyway, so a missed permission event can never trap anyone.
  let stuckTimer = null, escape = false;
  function nav() {
    const s = STEPS[cur]; if (!s) return;
    const ready = !s.ready || s.ready();
    $('next').textContent = s.next;
    $('next').disabled = !ready && !escape;
    $('back').disabled = cur === 0;
    $('back').hidden = STEPS.length === 1;
    $('skip').hidden = !(s.skip && !ready) && !(escape && !ready);
    $('skip').textContent = s.skip ? 'Skip for now' : 'Continue anyway';
    s.nav?.();
  }
  function go(i) {
    if (i === cur || i < 0 || i >= STEPS.length) return;
    STEPS[cur]?.onLeave?.();
    clearTimeout(stuckTimer); escape = false;
    sections.forEach((sec, j) => { sec.hidden = j !== i; });
    [...$('progress').children].forEach((li, j) => {
      li.className = j < i ? 'done' : '';
      if (j === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    // Screen readers only: sighted users read the LED bar.
    $('step-name').textContent = `Step ${i + 1} of ${STEPS.length}: ${sections[i].dataset.name}`;
    cur = i;
    send({ type: 'ob_step', step: i });
    enter(STEPS[i].enter);
    STEPS[i].onEnter?.();
    if (STEPS[i].ready) stuckTimer = setTimeout(() => { escape = true; nav(); }, 25000);
    nav();
    const h = sections[i].querySelector('h1');
    h.tabIndex = -1; h.focus({ preventScroll: true });
  }
  async function finish() {
    $('next').disabled = true;
    STEPS[cur]?.onLeave?.();
    if (!reduced.matches) { sidekick.vanish('materialize'); await wait(700); }
    if (MODE === 'chat') return invoke('guide_close');
    send({ type: 'ob_done' });
    const canTalk = state?.voice && state.keys && (isMac() || state.voiceModel?.status === 'ready');
    const talk = canTalk ? capsFor(state.keys.talk).join(isMac() ? '' : '+') : null;
    const where = isMac() ? 'up here' : 'down here';
    invoke('onboarding_finish', { text: talk ? `Here I am! Hold ${talk} to talk, or click my icon ${where} anytime.` : `Here I am! Click my icon ${where} anytime.` });
  }
  const forward = () => (cur === STEPS.length - 1 ? finish() : go(cur + 1));
  $('next').addEventListener('click', () => { if (!STEPS[cur]?.onNext?.()) forward(); });
  $('back').addEventListener('click', () => go(cur - 1));
  $('skip').addEventListener('click', () => { if (!STEPS[cur]?.onSkip?.()) forward(); });

  // ---------------------------------------------------------------- messages from the app
  window.__onboard = (msg) => {
    switch (msg.kind) {
      case 'state': {
        const first = !state;
        state = msg;
        if (Roamie.sfx) Roamie.sfx.enabled = msg.sound !== false;
        if (first) { sidekick.setLook?.(msg.look); sidekick.setForm?.(msg.size); }
        if (at('welcome')) look.render();
        if (first) go(MODE === 'chat' ? 0 : clamp(msg.step | 0, 0, STEPS.length - 1));
        else { if (at('perms')) perms.render(); if (at('ai')) ai.render(); if (at('keys')) keys.render(); }
        break;
      }
      case 'goto': if (state) go(clamp(msg.step | 0, 0, STEPS.length - 1)); break;
      case 'login': ai.onLogin(msg); break;
      case 'ask':
        askId = msg.id;
        $('code-label').textContent = msg.prompt || 'Paste the code from your browser';
        $('code-input').type = msg.mask ? 'password' : 'text';
        $('code-input').placeholder = msg.placeholder || '';
        $('code-form').hidden = false; $('code-input').focus();
        quip('Paste the code here');
        break;
      case 'cancel_ask': if (askId === msg.id) { askId = null; $('code-form').hidden = true; } break;
      case 'files': perms.applyFiles(msg.status); if (at('perms')) perms.render(); break;
      case 'keys':
        if (state) state.keys = msg.keys;
        if (msg.error) { const e = $('keys-error'); e.hidden = false; e.textContent = e.title = msg.error; quip('Hmm, taken.'); }
        else $('keys-error').hidden = true;
        keys.render();
        break;
      case 'say': quip(msg.text, 3); break;
      case 'voice': if (at('chat')) chat.voice(msg); else voice.on(msg); break;
      case 'speech': Roamie.voiceOut?.handle(msg); break;
      case 'chat': case 'chat_state': case 'chat_turn': case 'chat_done': case 'chat_facts': chat.on(msg); break;
      case 'mode': if (msg.mode === 'chat' && !at('chat')) { const i = STEPS.findIndex((s) => s.name === 'chat'); if (i >= 0) go(i); } break;
      case 'voice_model':
        if (!state) break;
        state.voiceModel = { status: msg.status, done: msg.done, total: msg.total, error: msg.error, size: msg.size, engine: msg.engine };
        if (at('perms')) perms.progress();
        if (at('keys')) keys.tryLabel();
        break;
    }
  };
  // Move the window from the top strip; double-click does nothing (no zoom for a fixed-size guide).
  $('drag').addEventListener('mousedown', (e) => { if (e.button === 0 && e.detail === 1) invoke('drag_window').catch(() => {}); });
  send({ type: 'ob_hello' });
  invoke('focus_guide').catch(() => {});

  // ---------------------------------------------------------------- preview (plain browser only)
  function preview() {
    const q = new URLSearchParams(location.search);
    // ?speech=1 previews an older Mac that also needs Speech recognition; ?granted=1 a Mac that already allowed everything.
    const old = q.get('speech') === '1', pre = q.get('granted') === '1' ? 'granted' : 'unknown';
    const win = q.get('platform') === 'win32';
    // ?platform=win32 previews Windows (&blocked=1: microphone switched off in Privacy settings; &model=downloading|ready|error).
    const sys = win ? { type: 'perms', mic: q.get('blocked') === '1' ? 'denied' : 'granted', input: true } : { type: 'perms', mic: pre, speech: old ? pre : 'granted', speechNeeded: old, screen: pre, accessibility: pre };
    const st = {
      kind: 'state', platform: q.get('platform') || 'darwin', canSnap: true, step: +(q.get('step') || 0), sound: true, look: q.get('look') || 'classic', size: q.get('size') || 'default', voice: true, actions: false, login: true, filesAsked: false,
      keys: q.get('platform') === 'win32' ? { talk: ['control', 'option'], summon: 'Control+Shift+KeyS', snap: 'Control+Shift+KeyA' } : { talk: ['control', 'option'], summon: 'Control+Alt+KeyS', snap: 'Control+Alt+KeyA' }, connected: null,
      voiceModel: win ? { status: q.get('model') || 'missing', done: q.get('model') === 'downloading' ? 60000000 : 0, total: 142300974, error: q.get('model') === 'error' ? 'Download failed. Check your internet.' : null, size: '142 MB' } : null,
      oauth: [['anthropic', 'Claude', 'Anthropic'], ['openai', 'ChatGPT', 'OpenAI'], ['gemini', 'Gemini', 'Google'], ['xai', 'Grok', 'xAI'], ['moonshot', 'Kimi', 'Moonshot']].map(([id, name, company]) => ({ id, name, company, connected: false })),
      apikey: [['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'], ['glm', 'Z.AI (GLM)']].map(([id, name]) => ({ id, name, connected: false })),
    };
    let filesAsked = false;
    const reply = (m, ms = 0) => setTimeout(() => window.__onboard?.(m), ms);
    if (st.platform === 'win32' && !q.get('model')) { st.voiceModel = { status: 'downloading', done: 0, total: 142300974, error: null, size: '142 MB' }; const t = setInterval(() => { const vm = st.voiceModel; vm.done = Math.min(vm.total, vm.done + 15e6); if (vm.done === vm.total) { vm.status = 'ready'; clearInterval(t); } window.__onboard?.({ kind: 'voice_model', ...vm }); }, 700); }
    return async (cmd, args) => {
      if (cmd === 'perm_status') return { ...sys };
      // &shot=fail: the test screenshot fails.
      if (cmd === 'screen_check') { await wait(900); return { seen: q.get('shot') !== 'fail' }; }
      if (cmd === 'perm_request') { await wait(600); if (args.kind !== 'screen') sys[args.kind] = 'granted'; else setTimeout(() => { sys.screen = 'granted'; }, 2500); return { ...sys }; }
      if (cmd === 'onboarding_finish') { document.body.style.opacity = '0.4'; return; }
      if (cmd !== 'sidecar_send') return;
      const m = args.msg;
      if (m.type === 'ob_hello') reply(st, 50);
      else if (m.type === 'ob_files') { if (m.request) filesAsked = true; reply({ kind: 'files', status: Object.fromEntries(['Desktop', 'Documents', 'Downloads'].map((f) => [f, filesAsked ? 'granted' : 'unknown'])) }, m.request ? 1200 : 0); }
      else if (m.type === 'ob_login') {
        reply({ kind: 'login', provider: m.provider, phase: 'browser' }, 300);
        setTimeout(() => { st.connected = { provider: 'Anthropic', model: 'Claude Haiku 5.5' }; st.oauth[0].connected = true; reply({ kind: 'login', provider: m.provider, phase: 'done' }); reply({ ...st }); }, 1800);
      } else if (m.type === 'set_keys') { if (m.talk) st.keys.talk = m.talk; if (m.summon) st.keys.summon = m.summon; if (m.snap) st.keys.snap = m.snap; reply({ kind: 'keys', keys: st.keys }); }
      else if (m.type === 'chat_start' || m.type === 'chat_answer') {
        // A canned chat: &chat=nomodel previews not being signed in.
        if (q.get('chat') === 'nomodel') return reply({ kind: 'chat_state', status: 'no_model' }, 300);
        const turns = [
          ["[wave] Hi Ken, I'm Roamie! I'm here to help you get things done and keep you on track. I've got four quick questions.", 'What are you working on these days?', ''],
          ['Night shifts and NP exam prep, that is a lot to juggle.', 'What does a normal week look like for you?', 'Could be the hospital, flashcards in Anki, or something else entirely.'],
          ['Phone, Anki and Google Docs, a tight little setup.', "What's the actual thing you're going for right now?", 'Could be passing the boards, a new role, or something else entirely.'],
          ['Passing the boards in March, love it.', 'Okay, last one: have you used AI helpers before?', ''],
        ];
        const n = (st.chatN = m.type === 'chat_start' ? 0 : (st.chatN ?? 0) + 1);
        reply({ kind: 'chat_state', status: 'thinking', n, total: 4 });
        reply({ kind: 'chat', e: { type: 'start' } }, 100);
        if (n >= 4) {
          reply({ kind: 'chat_done', text: 'ChatGPT a couple of times, nice. Thanks for telling me about yourself, Ken! Passing your NP boards in March is a great place to start.', facts: [
            { id: 'a', text: 'Ken is a night-shift nurse studying for the NP board exam.' }, { id: 'b', text: "Ken's goal: pass the NP boards in March." },
            { id: 'c', text: 'Ken uses his phone, Anki and Google Docs to study.' }, { id: 'd', text: 'Ken has used ChatGPT a couple of times.' }] }, 1400);
        } else {
          // Streamed a few words at a time, as a model sends it, then the turn split into its parts.
          const [lead, question, hint] = turns[n];
          const words = [lead.replace('[wave] ', ''), question, hint].filter(Boolean).join(' ').split(' ');
          let t = 500;
          for (let i = 0; i < words.length; i += 3) { t += 70 + ((i * 37) % 90); reply({ kind: 'chat', e: { type: 'text', text: (i ? ' ' : '') + words.slice(i, i + 3).join(' ') } }, t); }
          reply({ kind: 'chat_turn', n, total: 4, lead: lead.replace('[wave] ', ''), question, hint }, t + 250);
        }
      } else if (m.type === 'chat_skip') { /* nothing comes back */ }
      else if (m.type === 'set_actions') { st.actions = m.on; }
      else if (m.type === 'set_login') { st.login = m.on; }
      else if (m.type === 'ob_voice_model' && st.voiceModel) {
        const vm = st.voiceModel; Object.assign(vm, { status: 'downloading', done: 0, error: null });
        const t = setInterval(() => {
          vm.done = Math.min(vm.total, vm.done + vm.total / 40);
          if (vm.done >= vm.total) { vm.status = 'ready'; clearInterval(t); }
          reply({ kind: 'voice_model', ...vm });
        }, 150);
      }
    };
  }
})();
