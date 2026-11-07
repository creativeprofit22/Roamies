// Voice: spoken replies (Fish Audio, every platform), then on/off, mode, the Windows engines and their downloads,
// and the shortcuts (only where voice control works).
RoamiesSettings.section('voice', {
  title: 'Voice',
  render(root, s, api, k) {
    const { el, okMark, dlMeter, capsEl, capsFor, accelCaps } = RoamiesKit;
    const v = s.voice, r = s.replies, ui = api.ui;
    root.append(...k.head('voice', 'Voice', v ? 'Hear Sidekick talk, and talk back with the talk keys.' : 'Hear Sidekick talk.'));

    // Spoken replies: the mode, the voice model (with what it costs) and the Fish Audio key.
    const WHY = { 'drama-3': 'The most expressive: whispers, laughs and real excitement. Slower, and costs more.', 's2.1-pro': 'A natural, quicker pace. Feelings come through lightly, and it costs less.' };
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const price = (c) => {
      const promo = c.promo && Date.now() < Date.parse(c.promo.until) ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
      return `About ${per100(c.perM)} per 100 replies${promo}.`;
    };
    const replies = el('fieldset', { className: 'group' }, el('legend', { textContent: 'Spoken replies' }), el('div', { className: 'rows' },
      k.option({ name: 'replies', value: 'text', title: 'Text only', desc: 'Replies show in speech bubbles.', checked: r.mode === 'text', onpick: () => api.set('replies', 'text') }),
      k.option({ name: 'replies', value: 'voice', title: 'Voice and text', desc: r.key ? 'Spoken out loud with Fish Audio, and shown.' : 'Needs a Fish Audio key, added below.', checked: r.mode === 'voice',
        onpick: () => {
          if (r.key) return api.set('replies', 'voice');
          ui.fish.open = true; ui.fish.msg = 'Add your Fish Audio key to hear Sidekick talk.'; ui.fish.bad = false;
          api.rerender(); api.focusOn('fish-input');
        } })));
    if (r.mode === 'voice' && r.models.length) {
      replies.append(el('div', { className: 'rows' }, ...r.models.map((c) => k.option({ name: 'fishmodel', value: c.id, title: c.name, desc: `${WHY[c.id] ?? ''} ${price(c)}`.trim(), checked: c.id === r.model, onpick: () => api.set('fishModel', c.id) }))));
      replies.append(el('p', { className: 'note', textContent: r.free ? "Your Fish Audio account has no credit, so it's on Fish's free model." : 'Billed to your own Fish Audio account.' }));
    }

    // The key: saved encrypted by the app; the field opens in place.
    const keyRow = k.row('Fish Audio key', r.key ? `Saved in ${r.keyWhere}.` : 'Needed for spoken replies. Get one at fish.audio.',
      el('span', { className: 'side-actions' },
        k.btn(ui.fish.open ? 'Cancel' : r.key ? 'Change' : 'Add key', () => { ui.fish.open = !ui.fish.open; ui.fish.msg = null; api.rerender(); api.focusOn(ui.fish.open ? 'fish-input' : 'fish-toggle'); }, { focus: 'fish-toggle', aria: ui.fish.open ? 'Cancel adding the Fish Audio key' : r.key ? 'Change the Fish Audio key' : 'Add a Fish Audio key' }),
        r.key && !ui.fish.open ? k.btn('Remove', () => { api.act('fishkey_remove'); api.announce('Removing the Fish Audio key.'); }, { kind: 'text', focus: 'fish-remove', aria: 'Remove the Fish Audio key' }) : null));
    replies.append(el('div', { className: 'rows' }, keyRow));
    if (ui.fish.open) {
      const input = el('input', { id: 'fish-input', type: 'password', placeholder: 'Paste your Fish Audio API key', autocomplete: 'off', spellcheck: false, maxLength: 1000 });
      input.dataset.focus = 'fish-input';
      const msg = ui.fish.msg ? el('p', { className: ui.fish.bad ? 'error' : 'note', id: 'fish-msg', role: ui.fish.bad ? 'alert' : 'status', textContent: ui.fish.msg }) : null;
      if (msg) input.setAttribute('aria-describedby', 'fish-msg');
      if (ui.fish.bad) input.setAttribute('aria-invalid', 'true');
      const form = el('form', { className: 'inline' },
        el('label', { htmlFor: 'fish-input', className: 'sr-only', textContent: 'Fish Audio API key' }),
        el('div', { className: 'field-row' }, el('span', { className: 'px field' }, input),
          el('button', { className: 'px btn primary', type: 'submit', textContent: ui.fish.busy ? 'Checking…' : 'Save', disabled: ui.fish.busy })),
        msg);
      form.onsubmit = (e) => {
        e.preventDefault();
        const key = input.value.trim();
        if (!key) { Object.assign(ui.fish, { msg: 'Paste a key first.', bad: true }); api.rerender(); return api.focusOn('fish-input'); }
        Object.assign(ui.fish, { busy: true, msg: null, bad: false });
        api.send({ type: 'st_fishkey', key });
        input.value = '';
        api.rerender(); api.focusOn('fish-input');
      };
      replies.append(form);
    } else if (ui.fish.msg && (ui.fish.bad || ui.fish.forKey === !!r.key)) replies.append(el('p', { className: ui.fish.bad ? 'error' : 'note', role: 'status', textContent: ui.fish.msg }));
    root.append(replies);
    if (!v) return;

    const main = k.group('Listening', k.toggle({ key: 'voice', title: 'Voice', desc: (on) => (on ? 'On: hold the talk keys to talk.' : 'Off: type to Sidekick instead.'), on: v.on }));
    if (v.on && !v.ready) main.append(el('p', { className: 'note', textContent: 'Voice needs its speech model before it can listen. Download one below.' }));
    root.append(main);

    root.append(el('fieldset', { className: 'group' }, el('legend', { textContent: 'Voice mode' }), el('div', { className: 'rows' },
      k.option({ name: 'voicemode', value: 'agent', title: 'Computer Use', desc: 'Sidekick hears you and does it.', checked: v.mode === 'agent', onpick: () => api.set('voiceMode', 'agent') }),
      k.option({ name: 'voicemode', value: 'dictation', title: 'Dictation', desc: 'Types what you say into the app in front.', checked: v.mode === 'dictation', onpick: () => api.set('voiceMode', 'dictation') }))));

    if (v.engines) {
      const rows = v.engines.map((e) => {
        let side;
        if (e.status === 'downloading') side = dlMeter(e, `${e.label} download`);
        else if (e.status === 'ready') side = e.selected ? okMark('In use') : okMark('Ready');
        else side = k.btn(e.status === 'error' ? 'Retry' : `Download ${e.size}`.trim(), () => api.act(`voicedl:${e.id}`), { focus: `dl-${e.id}`, aria: `${e.status === 'error' ? 'Retry downloading' : 'Download'} ${e.label}` });
        const opt = k.option({ name: 'engine', value: e.id, title: e.label, desc: e.about, checked: e.selected, side, onpick: () => api.set('voiceEngine', e.id) });
        if (e.status === 'error' && e.error) opt.querySelector('label').append(el('p', { className: 'bad', role: 'alert', textContent: e.error }));
        return opt;
      });
      const g = el('fieldset', { className: 'group' }, el('legend', { textContent: 'Speech engine' }), el('div', { className: 'rows' }, ...rows));
      if (v.using) g.append(el('p', { className: 'note', textContent: `Using ${v.using} until the one you picked is downloaded.` }));
      if (v.shadow) {
        const why = !v.shadow.ready ? `Download ${v.shadow.label} first.` : v.shadow.needsTelemetry ? 'Turn on Record telemetry in Privacy first.' : null;
        g.append(el('div', { className: 'rows' }, k.toggle({ key: 'voiceShadow', title: `Compare with ${v.shadow.label} in background`, desc: 'Runs both engines and logs which heard you better. Stays on this computer.', on: v.shadow.on, disabled: !!why && !v.shadow.on, note: why })));
      }
      root.append(g);
    }

    if (v.mute != null) root.append(k.group('While talking', k.toggle({ key: 'muteWhileTalking', title: 'Mute other sounds', desc: 'Quiets your Mac while you hold the talk keys.', on: v.mute })));

    const keys = el('div', { className: 'rows' },
      k.row('Talk', 'Hold, talk, let go.', capsEl(capsFor(v.keys.talk, null, api.isMac))),
      k.row('Show or hide Sidekick', null, capsEl(accelCaps(v.keys.summon, api.isMac))),
      k.row('Show list', null, capsEl(accelCaps(v.keys.list, api.isMac))),
      ...(v.canSnap && v.keys.snap ? [k.row('Ask about an area', null, capsEl(accelCaps(v.keys.snap, api.isMac)))] : []));
    root.append(k.group('Shortcuts', keys, el('div', { className: 'actions spaced' }, k.btn('Change in setup guide', () => api.act('setup_keys'), { focus: 'keys-change' }))));
  },
});
