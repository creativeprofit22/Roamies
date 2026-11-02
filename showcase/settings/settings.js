// Settings window shell: nav, message routing and focus. Each pane lives in sections/*.js and re-renders from
// the sidecar's live state; the window never keeps its own copy of a setting. Opened in a plain browser,
// preview.js stands in for the app.
(() => {
  'use strict';
  const { el } = RoamiesKit;
  const $ = (id) => document.getElementById(id);
  const defs = new Map();
  let state = null, current = null, invoke = async () => {};

  // Transient window-only state: sign-in progress, the code prompt and inline errors.
  const ui = { ask: null, login: { error: null }, key: { open: false, busy: null, error: null }, errors: {} };
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const announce = (text) => { const a = $('announce'); a.textContent = ''; setTimeout(() => { a.textContent = text; }, 40); };
  const focusOn = (id) => requestAnimationFrame(() => document.querySelector(`[data-focus="${id}"]`)?.focus());

  const api = {
    ui, send, announce, focusOn,
    isMac: () => state?.platform === 'darwin',
    set(key, value) { delete ui.errors[key]; send({ type: 'settings_set', key, value }); },
    act(id) { send({ type: 'settings_action', id }); },
    rerender: () => render(),
    show: (id) => show(id),
    confirmForget(trigger) {
      const d = $('forget-dialog');
      d.returnValue = '';
      d.showModal();
      d.addEventListener('close', () => {
        if (d.returnValue === 'confirm') { api.act('forgetall_confirmed'); announce('Forgot everything.'); }
        focusOn(trigger);
      }, { once: true });
    },
  };

  // Small builders shared by the panes.
  const kit = {
    head(id, title, lead) {
      const h = el('h1', { id: `h-${id}`, tabIndex: -1, textContent: title });
      return lead ? [h, el('p', { className: 'lead', textContent: lead })] : [h];
    },
    group(title, ...kids) { return el('section', { className: 'group' }, el('h2', { textContent: title }), ...kids); },
    btn(label, onclick, { kind = 'ghost', focus, aria, disabled } = {}) {
      const b = el('button', { className: kind === 'link' ? 'link' : `px btn ${kind}`, type: 'button', textContent: label, onclick, disabled: !!disabled });
      if (focus) b.dataset.focus = focus;
      if (aria) b.setAttribute('aria-label', aria);
      return b;
    },
    row(title, desc, side, { id, cls = '' } = {}) {
      const t = el('h3', { textContent: title });
      const d = desc == null ? null : typeof desc === 'string' ? el('p', { textContent: desc }) : desc;
      if (id) { t.id = `${id}-t`; if (d) d.id = `${id}-d`; }
      return el('div', { className: `px row ${cls}` }, el('div', {}, t, d), side ?? el('span'));
    },
    toggle({ key, title, desc, on, disabled, note }) {
      const id = `sw-${key}`;
      const sw = el('button', { className: 'px switch', type: 'button', disabled: !!disabled });
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(!!on));
      sw.setAttribute('aria-labelledby', `${id}-t`);
      sw.dataset.focus = id;
      sw.dataset.testid = `${id}-${on ? 'on' : 'off'}`;
      const d = el('p', { textContent: typeof desc === 'function' ? desc(!!on) : desc });
      const err = ui.errors[key] ? el('p', { className: 'bad', id: `${id}-e`, role: 'alert', textContent: ui.errors[key] }) : null;
      sw.setAttribute('aria-describedby', [`${id}-d`, err && `${id}-e`].filter(Boolean).join(' '));
      sw.onclick = () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(next));
        sw.dataset.testid = `${id}-${next ? 'on' : 'off'}`;
        if (typeof desc === 'function') d.textContent = desc(next);
        api.set(key, next);
      };
      const r = kit.row(title, d, sw, { id });
      if (err) r.firstChild.append(err);
      if (note) r.firstChild.append(el('p', { className: 'note', textContent: note }));
      return r;
    },
    // A framed radio row; `side` sits outside the label so its buttons don't pick the option.
    option({ name, value, title, desc, checked, onpick, side, focus }) {
      const id = `${name}-${value}`.replace(/[^\w-]/g, '_');
      const input = el('input', { type: 'radio', name, value, id, checked: !!checked });
      input.dataset.focus = focus ?? id;
      input.onchange = () => input.checked && onpick();
      const label = el('label', { htmlFor: id }, el('h3', { textContent: title }), desc ? el('p', { textContent: desc }) : null);
      return el('div', { className: 'px opt' }, input, label, side ?? el('span'));
    },
    empty(text) { return el('p', { className: 'px empty', textContent: text }); },
  };

  function tabs() {
    $('tabs').replaceChildren(...state.sections.filter((id) => defs.has(id)).map((id) => {
      const b = el('button', { className: 'px tab', type: 'button', textContent: defs.get(id).title, onclick: () => show(id) });
      b.dataset.focus = `tab-${id}`;
      b.setAttribute('aria-controls', `pane-${id}`);
      if (id === current) b.setAttribute('aria-current', 'page');
      return el('li', {}, b);
    }));
  }

  function show(id) {
    if (!state?.sections.includes(id) || !defs.has(id)) return;
    current = id;
    history.replaceState(null, '', `#${id}`);
    $('main').scrollTop = 0;
    render();
  }

  function render() {
    if (!state) return;
    // Keep focus and anything typed across a re-render (state arrives whenever anything changes).
    const active = document.activeElement?.dataset?.focus;
    const typed = [...document.querySelectorAll('input[data-focus]:not([type=radio]), select[data-focus]')].map((n) => [n.dataset.focus, n.value]);
    $('loading').hidden = true;
    tabs();
    for (const [id, def] of defs) {
      const root = $(`pane-${id}`);
      if (!root) continue;
      root.hidden = id !== current;
      if (id !== current) { root.replaceChildren(); continue; }
      root.replaceChildren();
      def.render(root, state, api, kit);
    }
    for (const [f, v] of typed) { const n = document.querySelector(`[data-focus="${f}"]`); if (n && v) n.value = v; }
    if (active) document.querySelector(`[data-focus="${active}"]`)?.focus({ preventScroll: true });
  }

  window.RoamiesSettings = { section(id, def) { defs.set(id, def); }, kit };

  window.__settings = (msg) => {
    switch (msg.kind) {
      case 'state': {
        state = msg;
        const want = location.hash.slice(1);
        if (!current || !state.sections.includes(current)) current = state.sections.includes(want) ? want : state.sections[0];
        render();
        break;
      }
      case 'error':
        ui.errors[msg.key] = msg.error;
        announce(`Couldn't change that: ${msg.error}`);
        render();
        break;
      case 'login': {
        const viaKey = ui.key.busy === msg.provider;
        if (msg.phase === 'browser') { announce('Finish signing in in your browser.'); break; }
        if (msg.phase === 'done') {
          ui.login.error = null; ui.ask = null;
          Object.assign(ui.key, { busy: null, error: null, open: viaKey ? false : ui.key.open });
          announce('Connected.');
        } else if (viaKey) {
          ui.key.busy = null; ui.key.error = `That key didn't work: ${msg.error}`;
          announce(ui.key.error);
          render(); focusOn('key-input'); return;
        } else {
          ui.login.error = msg.error; ui.ask = null;
          announce(`Sign-in didn't work: ${msg.error}`);
        }
        render();
        break;
      }
      case 'ask':
        ui.ask = { id: msg.id, prompt: msg.prompt, placeholder: msg.placeholder, mask: !!msg.mask };
        if (current !== 'ai') current = 'ai';
        render(); focusOn('code-input');
        break;
      case 'cancel_ask':
        if (ui.ask?.id === msg.id) { ui.ask = null; render(); }
        break;
      case 'voice_model':
        if (state?.voice && msg.engines?.length) { state.voice.engines = msg.engines; if (current === 'voice') render(); }
        break;
    }
  };

  addEventListener('DOMContentLoaded', () => {
    invoke = window.__TAURI__?.core?.invoke ?? window.RoamiesSettingsPreview?.() ?? invoke;
    send({ type: 'st_hello' });
    invoke('focus_guide').catch(() => {});
  });
})();
