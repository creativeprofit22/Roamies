// The Settings window's view of the sidecar's state, and which settings it may change. Pure: built from the
// same snapshot as the tray menu (snapshot() in sidekick.mjs).

const pct = (vm) => Math.min(100, Math.floor((vm.done / (vm.total || 1)) * 100));

export function settingsView(v) {
  const voice = v.voiceOk ? {
    on: v.voice,
    mode: v.dictating ? 'dictation' : 'agent',
    ready: v.voiceReady,
    keys: v.keys,
    engines: v.needsModel ? v.engines.map((e) => ({ id: e.id, label: e.label, about: e.about, status: e.status, done: e.done, total: e.total, pct: pct(e), size: e.size, error: e.error ?? null, selected: v.voiceEngine === e.id })) : null,
    using: v.needsModel && v.activeEngine.id !== v.voiceEngine ? v.activeEngine.label : null,
    shadow: v.needsModel && v.shadow ? { label: v.shadow.label, on: v.shadow.on, ready: v.shadow.ready, needsTelemetry: !v.telemetry.on } : null,
    mute: v.platform === 'darwin' ? v.muteWhileTalking : null,
  } : null;
  return {
    kind: 'state',
    platform: v.platform,
    sections: ['ai', ...(voice ? ['voice'] : []), 'general', 'memory', 'privacy', 'about'],
    ai: {
      connected: v.current && v.providers.some((p) => p.id === v.provider && p.signedIn) ? { provider: v.providerLabels[v.provider] ?? v.provider, model: v.current.name } : null,
      loggingIn: v.loggingIn,
      oauth: v.oauth,
      apikey: v.apikey,
      models: v.providers.filter((p) => p.signedIn).map((p) => ({ provider: p.id, label: p.label, models: p.models.map((m) => ({ id: m.id, name: m.name, selected: v.provider === p.id && v.model === m.id })) })),
    },
    voice,
    general: { sound: v.sound, login: v.login.supported ? v.login.on : null, actions: v.allowActions },
    memory: {
      busy: v.busy,
      hasSession: v.hasSession,
      commitments: v.commitments.map((c) => ({ id: c.id, text: c.text, when: c.when ?? '', overdue: !!c.overdue })),
      facts: v.facts.map((f) => ({ id: f.id, text: f.text })),
    },
    privacy: { telemetry: v.telemetry.on, text: v.telemetry.text, locked: v.telemetry.locked },
    about: { version: v.version, usage: v.usage, update: { available: v.update.available, installing: v.update.installing }, licenses: v.licenses },
  };
}

// Every key the window may set, with the type its value must have.
export const SETTINGS_KEYS = {
  sound: 'boolean',
  login: 'boolean',
  actions: 'boolean',
  voice: 'boolean',
  voiceMode: 'voiceMode',
  voiceEngine: 'engine',
  voiceShadow: 'boolean',
  muteWhileTalking: 'boolean',
  telemetry: 'boolean',
  telemetryText: 'boolean',
  model: 'model',
};

const no = (error) => ({ ok: false, error });

export function validateSetting(key, value, v) {
  if (!Object.hasOwn(SETTINGS_KEYS, key)) return no('unknown setting');
  const type = SETTINGS_KEYS[key];
  if (type === 'boolean' && typeof value !== 'boolean') return no('expected true or false');
  if (['voice', 'voiceMode', 'voiceEngine', 'voiceShadow', 'muteWhileTalking'].includes(key) && !v.voiceOk) return no('voice is not available here');
  if (key === 'login' && !v.login.supported) return no('open at login is not available here');
  if (key === 'muteWhileTalking' && v.platform !== 'darwin') return no('only on a Mac');
  if (key === 'voiceShadow' && !v.shadow) return no('no engine to compare with');
  if (key === 'telemetry' && v.telemetry.locked) return no('telemetry is switched off for this copy');
  if (key === 'telemetryText' && !v.telemetry.on) return no('turn on telemetry first');
  if (type === 'voiceMode' && value !== 'agent' && value !== 'dictation') return no('expected agent or dictation');
  if (type === 'engine' && !(v.needsModel && typeof value === 'string' && v.engines.some((e) => e.id === value))) return no('unknown voice engine');
  if (type === 'model') {
    if (!value || typeof value !== 'object' || typeof value.provider !== 'string' || typeof value.id !== 'string') return no('expected a provider and a model');
    const p = v.providers.find((x) => x.id === value.provider);
    if (!p?.signedIn) return no('not signed in to that provider');
    if (!p.models.some((m) => m.id === value.id)) return no('unknown model');
    return { ok: true, value: { provider: p.id, id: value.id } };
  }
  return { ok: true, value };
}

// Buttons in the window, mapped to the tray actions they share. Ids with a target carry it after the colon.
const SIMPLE_ACTIONS = new Set(['new', 'forgetall_confirmed', 'telemetryfolder', 'logs', 'update', 'install_update', 'setup', 'setup_keys', 'licenses', 'list']);
export function validateAction(id, v) {
  if (typeof id !== 'string') return false;
  if (SIMPLE_ACTIONS.has(id)) {
    if (id === 'install_update') return !!v.update.available && !v.update.installing;
    if (id === 'licenses') return v.licenses;
    if (id === 'new') return !v.busy && v.hasSession;
    return true;
  }
  const [kind, ...rest] = id.split(':'), arg = rest.join(':');
  if (kind === 'done' || kind === 'drop') return v.commitments.some((c) => c.id === arg);
  if (kind === 'forget') return v.facts.some((f) => f.id === arg);
  if (kind === 'login') return !v.loggingIn && v.oauth.some((p) => p.id === arg);
  if (kind === 'voicedl') return v.voiceOk && v.needsModel && v.engines.some((e) => e.id === arg && e.status !== 'ready' && e.status !== 'downloading');
  return false;
}
