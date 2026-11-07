// Appearance: which look the Roamie has (each with its own name and voice) and how big it is on screen.
RoamiesSettings.section('appearance', {
  title: 'Appearance',
  render(root, s, api, k) {
    const { el } = RoamiesKit;
    const a = s.appearance;
    root.append(...k.head('appearance', 'Appearance', 'Each look has its own name and voice.'));

    const tiles = window.RoamiesLooks?.lookTiles({
      looks: a.looks, look: a.look, size: a.size,
      onpick: (id) => { api.set('look', id); api.announce(`Look: ${a.looks.find((x) => x.id === id)?.name ?? id}.`); },
    });
    root.append(k.group('Look', tiles ?? el('div', { className: 'rows' }, ...a.looks.map((x) => k.option({ name: 'look', value: x.id, title: x.name, checked: x.id === a.look, onpick: () => api.set('look', x.id) })))));

    const SIZE_DESC = { default: 'The full face.', small: 'Smaller, out of the way.', cursor: 'A little arrow pointer.' };
    root.append(el('fieldset', { className: 'group' }, el('legend', { textContent: 'Size' }), el('div', { className: 'rows' },
      ...a.sizes.map((x) => k.option({ name: 'size', value: x.id, title: x.name, desc: SIZE_DESC[x.id], checked: x.id === a.size, onpick: () => api.set('size', x.id) })))));
  },
});
