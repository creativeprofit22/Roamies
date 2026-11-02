// General: sounds, start at login, and whether Sidekick may change things.
RoamiesSettings.section('general', {
  title: 'General',
  render(root, s, api, k) {
    const { el } = RoamiesKit;
    const g = s.general;
    root.append(...k.head('general', 'General'));
    root.append(el('div', { className: 'rows' },
      k.toggle({ key: 'sound', title: 'Sound effects', desc: 'Little bleeps when Sidekick talks and moves.', on: g.sound }),
      // Only an installed copy can start at login, so the row is hidden otherwise (login is null).
      g.login != null ? k.toggle({ key: 'login', title: 'Open at login', desc: 'Start with your computer.', on: g.login }) : null,
      k.toggle({ key: 'actions', title: 'Edit files and run commands', desc: (on) => (on ? 'On: Sidekick can change things, carefully.' : 'Off: Sidekick can look, never change.'), on: g.actions })));
  },
});
