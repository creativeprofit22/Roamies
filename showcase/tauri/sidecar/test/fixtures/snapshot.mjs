// A synthetic snapshot() for the pure menu and settings-view tests.
export function snap(over = {}) {
  return {
    platform: 'win32', version: '1.2.3', licenses: true,
    busy: false, loggingIn: null, hasSession: true,
    providerLabels: { anthropic: 'Anthropic', openai: 'OpenAI' },
    current: { name: 'Claude Sonnet' }, provider: 'anthropic', model: 'sonnet',
    providers: [
      { id: 'anthropic', label: 'Anthropic', signedIn: true, method: 'oauth', models: [{ id: 'sonnet', name: 'Claude Sonnet' }, { id: 'opus', name: 'Claude Opus' }] },
      { id: 'openai', label: 'OpenAI', signedIn: false, method: 'apikey', models: [] },
    ],
    oauth: [{ id: 'anthropic', name: 'Claude', company: 'Anthropic', connected: true }],
    apikey: [{ id: 'openai', name: 'OpenAI', connected: false }],
    keys: { summon: 'Ctrl+Shift+Space', list: 'Ctrl+Shift+L', snap: 'Ctrl+Shift+S' }, talkSymbols: 'Ctrl+Win',
    update: { available: null, installing: false },
    voiceOk: true, needsModel: true, voice: true, voiceReady: true, dictating: false,
    voiceEngine: 'moonshine', activeEngine: { id: 'moonshine', label: 'Moonshine' },
    engines: [
      { id: 'moonshine', label: 'Moonshine', about: 'fast', status: 'ready', done: 10, total: 10, size: '60 MB' },
      { id: 'parakeet', label: 'Parakeet', about: 'accurate', status: 'missing', done: 0, total: 0, size: '600 MB' },
    ],
    shadow: { label: 'Parakeet', ready: false, on: false },
    voiceDl: null, muteWhileTalking: true,
    telemetry: { on: true, text: false, locked: false },
    usage: { requests: 3, tokens: 1500 },
    sound: true, login: { supported: true, on: false }, allowActions: false,
    facts: [{ id: 'f1', text: 'Likes tea' }],
    commitments: [{ id: 'c1', text: 'Ship it', when: 'today', overdue: true }],
    ...over,
  };
}
