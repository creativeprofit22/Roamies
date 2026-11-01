// Lists & memory: open commitments, remembered facts, and forgetting.
RoamiesSettings.section('memory', {
  title: 'Lists & memory',
  render(root, s, api, k) {
    const { el } = RoamiesKit;
    const m = s.memory;
    root.append(...k.head('memory', 'Lists & memory', 'What Sidekick is keeping track of for you.'));

    const list = m.commitments.length
      ? el('ul', { className: 'facts' }, ...m.commitments.map((c) => el('li', {}, k.row(c.text,
        el('p', {}, ...(c.overdue ? [el('span', { className: 'overdue', textContent: 'Overdue' }), c.when ? ` · ${c.when}` : ''] : [c.when])),
        el('span', { className: 'side-actions' },
          k.btn('Done', () => api.act(`done:${c.id}`), { focus: `done-${c.id}`, aria: `Mark done: ${c.text}` }),
          k.btn('Drop', () => api.act(`drop:${c.id}`), { kind: 'text', focus: `drop-${c.id}`, aria: `Drop: ${c.text}` }))))))
      : k.empty('Nothing on your list. Ask Sidekick to remind you of something.');
    root.append(k.group('Your list', list, el('div', { className: 'actions spaced' }, k.btn('Show list', () => api.act('list'), { focus: 'show-list' }))));

    const facts = m.facts.length
      ? el('ul', { className: 'facts' }, ...m.facts.map((f) => el('li', {}, k.row(f.text, null,
        k.btn('Forget', () => api.act(`forget:${f.id}`), { kind: 'text', focus: `forget-${f.id}`, aria: `Forget: ${f.text}` })))))
      : k.empty('Nothing remembered yet. Tell Sidekick about yourself and it keeps it here.');
    const memory = k.group('What Sidekick remembers', facts);
    if (m.facts.length) memory.append(el('div', { className: 'actions spaced' }, k.btn('Forget everything…', () => api.confirmForget('forget-all'), { focus: 'forget-all' })));
    root.append(memory);

    root.append(k.group('Conversation', el('div', { className: 'actions' },
      k.btn('Start a new conversation', () => { api.act('new'); api.announce('Started a new conversation.'); }, { focus: 'new-chat', disabled: m.busy || !m.hasSession })),
    el('p', { className: 'note', textContent: m.busy ? 'Sidekick is working. Try again when it finishes.' : m.hasSession ? 'Sidekick starts fresh but keeps what it remembers.' : 'No conversation yet.' })));
  },
});
