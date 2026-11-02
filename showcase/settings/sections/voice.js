// Voice: on/off, mode, the Windows engines and their downloads, and the shortcuts.
RoamiesSettings.section('voice', {
  title: 'Voice',
  render(root, s, api, k) {
    const { el, okMark, dlMeter, capsEl, capsFor, accelCaps } = RoamiesKit;
    const v = s.voice;
    root.append(...k.head('voice', 'Voice', 'Hold the talk keys and speak to Sidekick.'));

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

    const mac = api.isMac();
    const keys = el('div', { className: 'rows' },
      k.row('Talk', 'Hold, talk, let go.', capsEl(capsFor(v.keys.talk, null, api.isMac))),
      k.row('Show or hide Sidekick', null, capsEl(accelCaps(v.keys.summon, api.isMac))),
      k.row('Show list', null, capsEl(accelCaps(v.keys.list, api.isMac))),
      ...(mac && v.keys.snap ? [k.row('Ask about an area', null, capsEl(accelCaps(v.keys.snap, api.isMac)))] : []));
    root.append(k.group('Shortcuts', keys, el('div', { className: 'actions spaced' }, k.btn('Change in setup guide', () => api.act('setup_keys'), { focus: 'keys-change' }))));
  },
});
