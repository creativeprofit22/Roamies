// Privacy: the local telemetry log and the app's logs.
RoamiesSettings.section('privacy', {
  title: 'Privacy',
  render(root, s, api, k) {
    const { el } = RoamiesKit;
    const p = s.privacy;
    root.append(...k.head('privacy', 'Privacy', 'Everything here stays on this computer. Nothing is sent anywhere.'));
    root.append(el('div', { className: 'rows' },
      k.toggle({ key: 'telemetry', title: 'Record telemetry', desc: 'Saves timings and errors, to help fix problems.', on: p.telemetry, disabled: p.locked, note: p.locked ? 'Switched off for this copy of Roamies.' : null }),
      k.toggle({ key: 'telemetryText', title: 'Include what was said', desc: "Adds your words and Sidekick's answers to that log.", on: p.text, disabled: !p.telemetry, note: p.telemetry ? null : 'Turn on Record telemetry first.' })));
    root.append(el('div', { className: 'actions spaced' },
      k.btn('Open telemetry folder', () => api.act('telemetryfolder'), { focus: 'tel-folder' }),
      k.btn('Show logs', () => api.act('logs'), { focus: 'logs' })));
  },
});
