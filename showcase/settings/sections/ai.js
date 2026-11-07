// AI: the connected model, sign-ins (OAuth and API keys) and the code-paste prompt.
RoamiesSettings.section('ai', {
  title: 'AI',
  render(root, s, api, k) {
    const { el, led, okMark } = RoamiesKit;
    const ai = s.ai, ui = api.ui;
    root.append(...k.head('ai', 'AI', 'Pick the model Sidekick thinks with, and the accounts it can use.'));

    root.append(ai.connected
      ? el('p', { className: 'connected', role: 'status' }, led(), `Connected to ${ai.connected.provider} · ${ai.connected.model}`)
      : k.empty("Not signed in yet. Sign in with an AI account you have below, and Sidekick can start helping."));

    if (ai.models.length) {
      root.append(k.group('Model', ...ai.models.map((p) => el('fieldset', { className: 'group' },
        el('legend', { textContent: p.label }),
        el('div', { className: 'rows' }, ...p.models.map((m) => k.option({
          name: 'model', value: `${p.provider}:${m.id}`, title: m.name, checked: m.selected,
          side: m.selected ? okMark('In use') : null,
          onpick: () => api.set('model', { provider: p.provider, id: m.id }),
        })))))));
    }

    const signIn = el('div', { className: 'providers' }, ...ai.oauth.map((p) => {
      const busy = ai.loggingIn === p.id;
      const b = el('button', { className: `px prov${p.connected ? ' on' : ''}${busy ? ' busy' : ''}`, type: 'button', disabled: !!ai.loggingIn && !busy },
        el('span', { textContent: p.name }), led(p.connected ? 'on' : busy ? 'busy' : ''),
        el('small', { textContent: busy ? 'Waiting for browser…' : p.connected ? 'Connected' : p.company }));
      b.dataset.focus = `prov-${p.id}`;
      b.setAttribute('aria-label', `${p.name}${p.company ? ` (${p.company})` : ''}: ${busy ? 'waiting for browser' : p.connected ? 'connected, sign in again' : 'sign in'}`);
      b.onclick = () => { ui.login.error = null; api.act(`login:${p.id}`); };
      return b;
    }));
    const group = k.group('Sign in', signIn);

    if (ui.ask) {
      const input = el('input', { id: 'code-input', type: ui.ask.mask ? 'password' : 'text', placeholder: ui.ask.placeholder || '', autocomplete: 'off', spellcheck: false });
      input.dataset.focus = 'code-input';
      const form = el('form', { className: 'inline' },
        el('label', { htmlFor: 'code-input', textContent: ui.ask.prompt || 'Paste the code from your browser' }),
        el('div', { className: 'field-row' }, el('span', { className: 'px field' }, input),
          el('button', { className: 'px btn primary', type: 'submit', textContent: 'Submit' }),
          k.btn('Cancel', () => { api.send({ type: 'answer', id: ui.ask.id, text: null }); ui.ask = null; api.rerender(); api.focusOn(`prov-${ai.loggingIn}`); }, { kind: 'text' })));
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return input.focus();
        api.send({ type: 'answer', id: ui.ask.id, text: v });
        ui.ask = null; api.rerender();
      };
      group.append(form);
    }
    if (ui.login.error) group.append(el('p', { className: 'error', role: 'alert', textContent: `That didn't work: ${ui.login.error}` }));

    // API keys: the error joins aria-describedby only while the field is invalid.
    const toggle = k.btn(ui.key.open ? 'Hide API key form' : 'Use an API key instead', () => { ui.key.open = !ui.key.open; api.rerender(); if (ui.key.open) api.focusOn('key-input'); }, { kind: 'link', focus: 'key-toggle' });
    toggle.setAttribute('aria-expanded', String(ui.key.open));
    toggle.setAttribute('aria-controls', 'key-form');
    group.append(toggle);
    if (ui.key.open) {
      const sel = el('select', { id: 'key-provider' }, ...ai.apikey.map((p) => el('option', { value: p.id, textContent: `${p.name}${p.connected ? ' (connected)' : ''}` })));
      sel.dataset.focus = 'key-provider';
      const input = el('input', { id: 'key-input', type: 'password', placeholder: 'Paste API key', autocomplete: 'off', spellcheck: false });
      input.dataset.focus = 'key-input';
      const err = ui.key.error ? el('p', { className: 'error', id: 'key-error', textContent: ui.key.error }) : null;
      if (err) err.dataset.testid = 'key-error';
      if (err) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'key-error'); }
      const busy = !!ui.key.busy;
      const form = el('form', { className: 'inline', id: 'key-form' },
        el('label', { htmlFor: 'key-provider', className: 'sr-only', textContent: 'Provider' }),
        el('div', { className: 'field-row' },
          el('span', { className: 'px field select' }, sel),
          el('label', { htmlFor: 'key-input', className: 'sr-only', textContent: 'API key' }),
          el('span', { className: 'px field' }, input),
          el('button', { className: 'px btn primary', type: 'submit', textContent: busy ? 'Saving…' : 'Save', disabled: busy })),
        err);
      form.onsubmit = (e) => {
        e.preventDefault();
        const key = input.value.trim();
        if (!key) { ui.key.error = 'Paste a key first.'; api.rerender(); return api.focusOn('key-input'); }
        ui.key.busy = sel.value; ui.key.error = null;
        api.send({ type: 'st_apikey', provider: sel.value, key });
        input.value = '';
        api.rerender(); api.focusOn('key-input');
      };
      group.append(form);
    }
    root.append(group);
  },
});
