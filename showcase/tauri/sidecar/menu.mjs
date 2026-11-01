// Tray menu, built from a snapshot of the sidecar's state (see snapshot() in sidekick.mjs); pure, so it's testable.
// compact (Windows, Linux): a short native menu, with everything else in the Settings window. Full (macOS): unchanged.

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pct = (vm) => Math.floor((vm.done / vm.total) * 100);
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n);

export function statusLine(v) {
  if (v.busy) return 'Sidekick is working…';
  if (v.loggingIn) return `Signing in to ${v.providerLabels[v.loggingIn] ?? v.loggingIn}…`;
  if (v.current) return `${v.current.name} · ${v.providerLabels[v.provider] ?? v.provider}`;
  return 'Not signed in';
}

export const trayTooltip = (v) => `Roamies · ${statusLine(v)}`;

function updateItem(v) {
  return { id: 'install_update', label: v.update.installing ? `Installing ${v.update.available}…` : `Install Update ${v.update.available} and Restart`, enabled: !v.update.installing };
}

function compactMenu(v) {
  return [
    { id: 'show', label: 'Show Sidekick', accel: v.keys.summon },
    { id: 'ask', label: 'Ask Sidekick…', enabled: !v.busy },
    { id: 'list', label: 'Show List', accel: v.keys.list },
    ...(v.busy ? [{ id: 'stop', label: 'Stop' }] : []),
    ...(v.update.available ? [updateItem(v)] : []),
    { sep: true },
    { id: 'settings', label: 'Settings…' },
    { id: 'quit', label: 'Quit Roamies' },
  ];
}

// One check item per registry engine with its download state; a line says which engine runs meanwhile.
function engineItems(v) {
  const items = v.engines.map((e) => {
    const state = e.status === 'ready' ? `${e.about} ✓ ready` : e.status === 'downloading' ? `downloading ${pct(e)}%` : e.status === 'error' ? 'download failed, retry' : `${e.about} · ${e.size} download`;
    return { id: `voiceengine:${e.id}`, label: `${e.label} · ${state}`, checked: v.voiceEngine === e.id };
  });
  if (v.activeEngine.id !== v.voiceEngine) items.push({ id: 'none', label: `Using ${v.activeEngine.label} until ${v.engines.find((e) => e.id === v.voiceEngine)?.label ?? v.voiceEngine} is ready`, enabled: false });
  // Shadow mode (docs/voice-engines.md): the other engine re-transcribes each take for comparison only.
  const s = v.shadow;
  if (s) items.push({ sep: true }, { id: 'voiceshadow', label: `Compare With ${s.label} in Background${!s.ready ? ' (model not downloaded)' : v.telemetry.on ? '' : ' (needs telemetry)'}`, checked: s.on });
  return items;
}

function fullMenu(v) {
  const providers = v.providers.filter((p) => p.signedIn);
  return [
    { id: 'status', label: statusLine(v), enabled: false },
    { sep: true },
    { id: 'show', label: 'Show Sidekick', accel: v.keys.summon },
    ...(v.platform === 'darwin' ? [{ id: 'snap', label: 'Ask About an Area…', accel: v.keys.snap }] : []),
    { id: 'ask', label: 'Ask Sidekick…', enabled: !v.busy },
    ...(v.voiceOk && v.voice && v.voiceReady ? [{ id: 'voicehint', label: `Hold ${v.talkSymbols} to ${v.dictating ? 'Dictate' : 'Talk'} · Tap for Hands-Free`, enabled: false }] : []),
    { id: 'stop', label: 'Stop', enabled: v.busy },
    { id: 'new', label: 'New Conversation', enabled: !v.busy && v.hasSession },
    { id: 'list', label: 'Show List', accel: v.keys.list },
    {
      label: 'Commitments',
      items: (() => {
        const open = v.commitments.slice(0, 12);
        if (!open.length) return [{ id: 'none', label: 'Nothing yet. Tell Sidekick what you plan to do.', enabled: false }];
        return open.map((c) => ({
          label: `${c.overdue ? '⚠︎ ' : ''}${trunc(c.text, 44)}${c.when ? ` · ${c.when}` : ''}`,
          items: [{ id: `done:${c.id}`, label: 'Mark Done' }, { id: `drop:${c.id}`, label: 'Drop It' }],
        }));
      })(),
    },
    { sep: true },
    {
      label: 'Model',
      items: providers.length
        ? providers.map((p) => ({ label: p.label, items: p.models.map((mm) => ({ id: `model:${p.id}:${mm.id}`, label: mm.name, checked: v.model === mm.id && v.provider === p.id })) }))
        : [{ id: 'none', label: 'Sign in to a provider first', enabled: false }],
    },
    {
      label: 'AI Providers',
      items: v.providers.map((p) => {
        if (p.signedIn) return { id: `noop:${p.id}`, label: `${p.label}  ✓ Signed in`, enabled: false };
        if (p.method === 'oauth') return { id: `login:${p.id}`, label: `Sign in to ${p.label}…`, enabled: !v.loggingIn };
        return { id: `key:${p.id}`, label: `Add ${p.label} API Key…`, enabled: !v.loggingIn };
      }),
    },
    {
      label: 'Settings',
      items: [
        ...(v.voiceOk ? [{ id: 'voice', label: `Voice Control (${v.talkSymbols})`, checked: v.voice }] : []),
        ...(v.voiceOk ? [{ label: 'Voice Mode', items: [
          { id: 'voicemode:agent', label: 'Computer Use', checked: !v.dictating },
          { id: 'voicemode:dictation', label: 'Dictation', checked: v.dictating },
        ] }] : []),
        ...(v.voiceOk && v.needsModel ? [{ label: 'Voice Engine', items: engineItems(v) }] : []),
        ...(v.voiceDl ? [v.voiceDl.status === 'downloading'
          ? { id: 'voicedl', label: `Downloading Voice… ${pct(v.voiceDl)}%`, enabled: false }
          : { id: 'voicedl', label: v.voiceDl.status === 'error' ? 'Retry Voice Download' : `Download Voice (${v.voiceDl.size})…` }] : []),
        ...(v.voiceOk && v.platform === 'darwin' ? [{ id: 'mutetalk', label: 'Mute Mac While Talking', checked: v.muteWhileTalking }] : []),
        ...(v.usage.requests ? [{ id: 'usage', label: `Today: ${v.usage.requests} requests · ${tokens(v.usage.tokens)} new tokens`, enabled: false }, { sep: true }] : []),
        { id: 'sound', label: 'Sound Effects', checked: v.sound },
        ...(v.login.supported ? [{ id: 'login', label: 'Open at Login', checked: v.login.on }] : []),
        { id: 'actions', label: 'Allow File Edits & Commands', checked: v.allowActions },
        { label: 'Telemetry', items: [
          { id: 'telemetry', label: 'Record Telemetry (stays on this computer)', checked: v.telemetry.on, enabled: !v.telemetry.locked },
          { id: 'telemetrytext', label: 'Include What Was Said', checked: v.telemetry.text, enabled: v.telemetry.on },
          { sep: true },
          { id: 'telemetryfolder', label: 'Open Telemetry Folder' },
        ] },
      ],
    },
    {
      label: `Memory (${v.facts.length})`,
      items: (() => {
        const all = v.facts, shown = all.slice(0, 15);
        if (!all.length) return [{ id: 'none', label: 'Nothing remembered yet', enabled: false }];
        return [
          ...shown.map((f) => ({ label: trunc(f.text, 52), items: [{ id: `forget:${f.id}`, label: 'Forget This' }] })),
          ...(all.length > shown.length ? [{ id: 'none', label: `…and ${all.length - shown.length} more`, enabled: false }] : []),
          { sep: true },
          { id: 'forgetall', label: 'Forget Everything…' },
        ];
      })(),
    },
    { sep: true },
    { id: 'setup', label: 'Setup Guide…' },
    { id: 'logs', label: 'Show Logs…' },
    v.update.available ? updateItem(v) : { id: 'update', label: 'Check for Updates…' },
    { id: 'about', label: `Roamies ${v.version}`, enabled: false },
    ...(v.licenses ? [{ id: 'licenses', label: 'Licences…' }] : []),
    { id: 'quit', label: 'Quit Roamies' },
  ];
}

export const trayMenu = (v, { compact = false } = {}) => (compact ? compactMenu(v) : fullMenu(v));
