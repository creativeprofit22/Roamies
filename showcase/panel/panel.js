// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Behavior and About.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id or 'fish'), the row action waiting for its
  // Confirm, and how far down the long lists it shows (a page at a time) and what the memory search holds.
  const PAGE = 10, MORE = 20;
  const ui = { key: null, arm: null, facts: PAGE, commits: PAGE, q: '' };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  const leave = (from, id) => { from.closest('.item')?.classList.add('leaving'); setTimeout(() => act(id), REDUCED.matches ? 0 : 190); };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null), desc ? el('p', { textContent: desc }) : null),
    ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint }) : null),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12, w = Math.min(300, innerWidth - gut * 2);
    t.style.width = `${w}px`;
    const h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => { const x = e.target.closest?.('[data-tip]'); if (x && x.matches(':focus-visible')) showTip(x); else hideTip(); });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'More emotion. Slower, and costs more.', 's2.1-pro': 'Natural pace. Less emotion, costs less.' };
  const WHY_LONG = {
    'drama-3': 'The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.',
    's2.1-pro': 'A natural, quicker pace. Feelings only come through lightly.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
  };
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : 'this computer');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Sign in on the Model page' : '');
    now.title = now.textContent;
    // The sidebar marks a page that needs you: an update to install, or no account to answer with.
    mark('about', state.update.available ? 'update ready' : null);
    react();
    mark('model', s.state === 'off' ? 'not signed in' : null);
  }
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Roamies
  // The same LED renderer as on the desktop and in the setup guide, drawn small: one in the header (the Roamie
  // you have, reacting to what's going on) and one per look on the Appearance page. One loop draws them all,
  // only while the panel is up and each canvas is on screen.
  const LED = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // A Roamie on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art (the full face, the small one, the pointer) at its real size next to the others.
  const ZOOM = 0.5, UNIT = 340;
  function liveRoamie(canvas, w, h, { look = 'classic', y = 0.56, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's Roamie: your look, reacting to what's going on. A short line beside it when something changes.
  // The same size and detail as the look tiles (fewer dots than that and the faces turn to noise).
  const avatar = liveRoamie($('avatar'), 100, 74, { y: 0.55 });
  const QUIPS = { classic: 'Classic me!', jarvis: 'At your service.', anime: 'Yay, hi hi!', sarah: 'Hey, nice to meet you!', adrian: "Alright, let's do this." };
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('now');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    if (seen.look && state.look !== seen.look) { avatar.setLook(state.look); avatar.act('wave'); quip(QUIPS[state.look] ?? 'Hi!'); }
    else avatar.setLook(state.look);
    avatar.setForm(state.size);
    if (state.update.available && state.update.available !== seen.update && seen.look) { avatar.act('hype'); quip(`Roamies ${state.update.available} is here!`); }
    seen.look = state.look; seen.update = state.update.available;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update;
    const mac = state.os === 'mac';
    return [
      u.available ? el('div', { className: 'px update', role: 'group', 'aria-label': 'Update' },
        el('p', { textContent: `Roamies ${u.available} is ready` }),
        btn(u.installing ? 'Installing…' : 'Install', () => act('install_update'), { kind: 'primary', k: 'install', disabled: u.installing, aria: `Install Roamies ${u.available} and restart` })) : null,
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          btn('Ask', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy, aria: `Ask ${state.name}` }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${state.name}`, () => act('show', true), { k: 'show' }))),
      group('Recent', 'Newest first.', null,
        state.recent.length
          ? el('ul', { className: 'list' }, state.recent.map((r) => el('li', { className: `item ${r.kind}` },
            el('span', { className: 'mark', 'aria-hidden': 'true' }),
            el('span', { className: 'text', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
            el('span', { className: 'meta', textContent: ago(r.at) }))))
          : el('p', { className: 'empty', textContent: 'Nothing yet. Ask me something.' }),
        state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} new tokens` }) : null),
    ];
  }

  // ---------------------------------------------------------------- Memory
  function memory() {
    const f = state.facts, c = state.commitments;
    return [
      group('What I remember', "What you've told me.", f.length,
        f.length > PAGE ? el('div', { className: 'find' }, el('span', { className: 'px field' },
          el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
            on: { input: (e) => { ui.q = e.target.value; ui.facts = PAGE; factList(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; factList(); } } } }))) : null,
        el('div', { className: 'group', id: 'facts-box' }, factRows()),
        el('div', { className: 'spread' },
          btn('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro }),
          f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null)),
      group('Commitments', "I'll remind you when they're due.", c.length,
        c.length
          ? el('ul', { className: 'list' }, c.slice(0, ui.commits).map((x) => el('li', { className: 'item' },
            el('span', { className: 'mark', 'aria-hidden': 'true' }),
            el('span', { className: 'text', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
            el('span', { className: 'row-btns' },
              link('Done', (e) => leave(e.currentTarget, `done:${x.id}`), { k: `done:${x.id}`, aria: `Done: ${x.text}` }),
              armed('Drop', 'Confirm', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`)))))
          : el('p', { className: 'empty', textContent: 'Nothing yet. Tell me your plans.' }),
        c.length > ui.commits ? link(`Show ${Math.min(MORE, c.length - ui.commits)} more`, () => { ui.commits += MORE; render('more-commits'); }, { k: 'more-commits' }) : null),
    ];
  }
  // The memory list, a page at a time; searching looks through all of it.
  function factRows() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const shown = hits.slice(0, ui.facts);
    return [
      shown.length
        ? el('ul', { className: 'list' }, shown.map((x) => el('li', { className: 'item' },
          el('span', { className: 'mark', 'aria-hidden': 'true' }),
          el('span', { className: 'text', textContent: x.text, title: x.text }),
          armed('Forget', 'Confirm', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`))))
        : el('p', { className: 'empty', textContent: q ? `Nothing matches "${ui.q.trim()}".` : 'Nothing yet. Tell me about yourself.' }),
      hits.length > shown.length ? link(`Show ${Math.min(MORE, hits.length - shown.length)} more`, () => { ui.facts += MORE; factList('more-facts'); }, { k: 'more-facts', aria: `Show ${Math.min(MORE, hits.length - shown.length)} more of ${hits.length}` }) : null,
    ].filter(Boolean);
  }
  // Searching or paging redraws just the list, so the search field keeps its focus and caret.
  function factList(focusKey) {
    const box = $('facts-box');
    if (!box) return render(focusKey);
    box.replaceChildren(...factRows());
    if (focusKey) (box.querySelector(`[data-k="${focusKey}"]`) ?? $('find-facts'))?.focus();
  }

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or 'fish'.
  function keyForm(id, label, onsave) {
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `${label} key`, 'aria-label': `${label} API key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v); input.value = ''; ui.key = null; render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); ui.key = null; render(`addkey:${id}`); } });
    return el('div', { className: 'keyform', hidden: ui.key !== id }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
  }

  // Settings, one page per concern.
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? el('span', { className: 'px field select' },
      el('select', { 'aria-label': 'Model', 'data-k': 'model', on: { change: (e) => act(`model:${e.target.value}`) } },
        model ? null : el('option', { value: '', textContent: 'Pick a model', disabled: true, selected: true }),
        on.map((p) => el('optgroup', { label: p.label }, p.models.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === model })))))) : null;
    return [
      group('Model', 'Which AI answers you.', null,
        select ?? el('p', { className: 'empty', textContent: 'Sign in to an account below first.' })),
      group('Accounts', 'Sign in to use their models.', null,
        el('div', { className: 'group' }, state.providers.filter((p) => p.on || p.method).map((p) => [
          el('div', { className: 'setting' },
            el('span', {}, p.label),
            p.on ? el('span', { className: 'ok' }, el('span', { className: 'led on', 'aria-hidden': 'true' }), 'Signed in')
              : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Signing in…' })
              : p.method === 'oauth' ? link('Sign in', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: `Sign in to ${p.label}`, disabled: !!state.loggingIn })
              : link(ui.key === p.id ? 'Cancel' : 'Add key', () => { ui.key = ui.key === p.id ? null : p.id; render(ui.key ? `key-${p.id}` : `addkey:${p.id}`); }, { k: `addkey:${p.id}`, aria: `Add ${p.label} API key` })),
          p.on || p.method !== 'key' ? null : keyForm(p.id, p.label, (key) => send({ type: 'panel_key', provider: p.id, key })),
        ]).flat())),
    ];
  }
  function appearancePage() {
    return [
      group('Look', 'Each look has its own name and voice.', null, lookTiles()),
      group('Size', 'How big I am on your screen.', null, picks('Size', state.sizes, state.size, (x) => act(`size:${x}`), 'size')),
    ];
  }
  // The looks as live tiles: each one's character, playing, at the size picked below. Kept between renders (a state update mustn't restart
  // them); hovering or focusing one makes it wave; picking it makes it cheer.
  const tiles = new Map();
  function lookTiles() {
    const g = tiles.get('_group') ?? el('div', { className: 'looks', role: 'radiogroup', 'aria-label': 'Look' });
    tiles.set('_group', g);
    g.replaceChildren(...state.looks.map(([id, name]) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = el('canvas', { 'aria-hidden': 'true' });
        const b = el('button', { className: 'px looktile', type: 'button', role: 'radio', 'data-k': `look:${id}` }, cv, el('span', { className: 'name', textContent: name }));
        const r = liveRoamie(cv, 104, 76, { look: id, y: 0.55, form: state.size });
        t = { b, r, waved: 0 };
        const wave = () => { if (r && Date.now() - t.waved > 3500) { t.waved = Date.now(); r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => { if (state.look !== id) { r?.act('hype'); act(`look:${id}`); } });
        tiles.set(id, t);
        r?.appear('crt');
      }
      t.r?.setForm(state.size);
      const on = state.look === id;
      t.b.setAttribute('aria-checked', String(on)); t.b.tabIndex = on ? 0 : -1;
      return t.b;
    }));
    return g;
  }
  function voicePage() {
    const v = state.voice;
    return [
      group('Spoken replies', 'Hear me as well as read me.', null,
        picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies, (x) => {
          if (x === 'voice' && !state.fishKey) { ui.key = 'fish'; render('key-fish'); note('Add a Fish Audio key to hear me talk.'); return; }
          act(`replies:${x}`);
        }, 'replies'),
        state.replies === 'voice' && state.fishModels?.length ? [
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
          el('p', { className: `why${state.fishFree ? ' late' : ''}`, textContent: state.fishFree ? "No credit left, so it's on Fish's free tier" : WHY[state.fishModel] ?? '' }),
        ] : null,
        el('div', { className: 'setting' },
          el('span', {}, 'Fish Audio key', el('small', { textContent: state.fishKey ? `Saved in ${where()}` : 'Needed for spoken replies' })),
          el('span', { className: 'row-btns' },
            link(ui.key === 'fish' ? 'Cancel' : state.fishKey ? 'Change' : 'Add', () => { ui.key = ui.key === 'fish' ? null : 'fish'; render(ui.key ? 'key-fish' : 'addkey:fish'); }, { k: 'addkey:fish', aria: state.fishKey ? 'Change the Fish Audio key' : 'Add a Fish Audio key' }),
            state.fishKey && ui.key !== 'fish' ? armed('Remove', 'Confirm', 'fishkey-remove', 'fishkey_remove', 'Remove the Fish Audio key') : null)),
        keyForm('fish', 'Fish Audio', (key) => send({ type: 'panel_fishkey', key }))),
      v ? group('Talking to me', 'Speak instead of typing.', null,
        toggle('Voice control', v.download
          ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
          : `Hold ${v.keys} to talk`, v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        v.mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null) : null,
    ];
  }
  function behaviorPage() {
    return [
      group('Behavior', 'What I may do, and when I start.', null,
        toggle('Sound effects', null, state.sound, () => act('sound'), 'sound'),
        toggle('Allow file edits and commands', 'Change files and run commands', state.actions, () => act('actions'), 'actions'),
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null),
    ];
  }
  // Who made Roamies: Ken, live (he's drawn like the looks but isn't one), and where to find him.
  const KEN = [
    ['Skool', 'Learn with Ken, or support him', 'https://www.skool.com/kenkai', "Open Ken Kai's Skool community"],
    ['YouTube', '@kenkaidoesai', 'https://www.youtube.com/@kenkaidoesai', "Open Ken Kai's YouTube channel"],
    ['TikTok', '@ggkenkai', 'https://www.tiktok.com/@ggkenkai', "Open Ken Kai's TikTok"],
  ];
  let ken = null;
  function maker() {
    if (!ken) {
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const r = liveRoamie(cv, 100, 74, { look: 'ken', y: 0.55 });
      const card = el('div', { className: 'maker' }, cv, el('span', {}, 'Ken Kai', el('small', { textContent: 'Creator of Roamies' })));
      let waved = 0;
      card.addEventListener('pointerenter', () => { if (r && Date.now() - waved > 3500) { waved = Date.now(); r.act('wave'); } });
      r?.appear('crt');
      ken = card;
    }
    return ken;
  }
  function aboutPage() {
    const u = state.update;
    return [
      group('Made by', null, null, maker(),
        KEN.map(([label, hint, url, aria]) => el('div', { className: 'setting' },
          el('span', {}, label, el('small', { textContent: hint })),
          link('Open', () => send({ type: 'open_link', url }), { k: `ken-${label.toLowerCase()}`, aria })))),
      group('Updates', null, null,
        el('div', { className: 'setting' },
          el('span', {}, `Roamies ${state.version}`, el('small', { className: u.result && !u.result.ok && !u.available ? 'late' : '', role: 'status',
            textContent: u.available ? `${u.available} is ready to install` : u.checking ? 'Checking for updates…' : u.result?.ok ? "You're up to date" : u.result ? "Couldn't check just now. Try again in a bit." : 'Updates install by themselves' })),
          u.available ? null : link('Check now', () => act('update'), { k: 'update', disabled: u.checking, aria: 'Check for updates' })),
        u.available ? btn(u.installing ? 'Installing…' : `Install ${u.available} and restart`, () => act('install_update'), { kind: 'primary', k: 'install-s', disabled: u.installing }) : null),
      group('Help', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Quit Roamies', () => act('quit'), { k: 'quit' }))),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, model: modelPage, appearance: appearancePage, voice: voicePage, behavior: behaviorPage, about: aboutPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    pane.replaceChildren(...PANES[tab]().flat().filter(Boolean));
    pane.closest('.body').scrollTop = scroll;
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });

  let noteTimer = 0;
  function note(text, bad = false) {
    const n = $('note');
    n.textContent = text; n.title = text; n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key || disarm()) { ui.key = null; render(was ?? undefined); } else hide(); return; }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // The Roamie switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null;
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => { if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"]')) { disarm(); render(); } }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      // Forgetting shrinks the list: keep the page in range.
      ui.facts = Math.max(PAGE, Math.min(ui.facts, state.facts.length)); ui.commits = Math.max(PAGE, Math.min(ui.commits, state.commitments.length));
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
    }
    else if (m.kind === 'note') note(m.text, m.bad);
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Roamies panel (preview with sample data)';
    const at = Date.now();
    const s = {
      version: '0.9.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: true, method: 'oauth', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', models: [] },
        { id: 'gemini', label: 'Google Gemini', on: false, method: 'oauth', models: [] },
        { id: 'openrouter', label: 'OpenRouter', on: false, method: 'key', models: [] },
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the Roamies 1.0 launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso' }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      name: 'Roamie', look: 'classic', looks: [['classic', 'Roamie'], ['jarvis', 'JARVIS'], ['anime', 'Anime Girl'], ['sarah', 'Sarah'], ['adrian', 'Adrian']],
      size: 'default', sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      replies: 'voice', fishKey: true, fishModel: 'drama-3', fishFree: false,
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      voice: { on: true, keys: '⌃⌥', ready: true, mac: true, mute: true, download: null },
      sound: true, actions: false, login: { on: true },
      update: { available: new URLSearchParams(location.search).has('update') ? '0.9.1' : null, installing: false, checking: false, result: null },
      intro: false,
    };
    const q = new URLSearchParams(location.search);
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], usage: null });
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}` }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
    }
    if (q.get('tab')) setTimeout(() => show(q.get('tab')), 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      // A look change comes back as new state, as from the sidecar, so the Roamie's reaction can be seen.
      const id = args.msg?.id ?? '';
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = s.looks.find(([v]) => v === s.look)?.[1] ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();
