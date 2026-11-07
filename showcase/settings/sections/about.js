// About: version, today's usage, updates, the setup guide and licences.
RoamiesSettings.section('about', {
  title: 'About',
  render(root, s, api, k) {
    const { el } = RoamiesKit;
    const a = s.about;
    const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
    root.append(...k.head('about', 'About'));
    const u = a.update;
    const update = u.available
      ? k.btn(u.installing ? 'Installing…' : `Install ${u.available} and restart`, () => api.act('install_update'), { kind: 'primary', focus: 'update', disabled: u.installing })
      : k.btn('Check for updates', () => { api.act('update'); api.announce('Checking for updates.'); }, { focus: 'update' });
    root.append(el('div', { className: 'rows' },
      k.row('Roamies', `Version ${a.version}`, update),
      k.row('Today', a.usage.requests ? `${a.usage.requests} requests · ${tokens(a.usage.tokens)} new tokens` : 'No requests yet today.')));
    root.append(el('div', { className: 'actions spaced' },
      k.btn('Open setup guide', () => api.act('setup'), { focus: 'setup' }),
      a.licenses ? k.btn('Licences', () => api.act('licenses'), { focus: 'licenses' }) : null));
  },
});
