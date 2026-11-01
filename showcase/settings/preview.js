// Plain-browser stand-in for the app, with synthetic data only. Never used inside Tauri.
// ?platform=win32|darwin  ?model=downloading|ready|error  ?fail=apikey (first save fails)  ?empty=1
window.RoamiesSettingsPreview = () => {
  if (window.__TAURI__) return null;
  const q = new URLSearchParams(location.search);
  const platform = q.get('platform') || 'win32', mac = platform === 'darwin', empty = q.get('empty') === '1';
  const model = q.get('model') || 'ready';
  let failKey = q.get('fail') === 'apikey';
  const MB = 1e6;
  const s = {
    kind: 'state', platform,
    sections: ['ai', 'voice', 'general', 'memory', 'privacy', 'about'],
    ai: {
      connected: empty ? null : { provider: 'Anthropic', model: 'Claude Sonnet 4.5' },
      loggingIn: null,
      oauth: [['anthropic', 'Claude', 'Anthropic'], ['openai', 'ChatGPT', 'OpenAI'], ['gemini', 'Gemini', 'Google'], ['xai', 'Grok', 'xAI'], ['moonshot', 'Kimi', 'Moonshot']].map(([id, name, company]) => ({ id, name, company, connected: !empty && id === 'anthropic' })),
      apikey: [['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'], ['glm', 'Z.AI (GLM)']].map(([id, name]) => ({ id, name, connected: false })),
      models: empty ? [] : [{ provider: 'anthropic', label: 'Anthropic', models: [['sonnet', 'Claude Sonnet 4.5', true], ['opus', 'Claude Opus 4.1', false], ['haiku', 'Claude Haiku 4.5', false]].map(([id, name, selected]) => ({ id, name, selected })) }],
    },
    voice: {
      on: true, mode: 'agent', ready: model === 'ready',
      keys: mac ? { talk: ['control', 'option'], summon: 'Control+Alt+KeyS', snap: 'Control+Alt+KeyA', list: 'Control+Alt+KeyL' } : { talk: ['control', 'option'], summon: 'Control+Shift+KeyS', snap: 'Control+Shift+KeyA', list: 'Control+Shift+KeyL' },
      engines: mac ? null : [
        { id: 'moonshine', label: 'Moonshine', about: 'Fast, small, English.', status: model === 'downloading' ? 'downloading' : model === 'error' ? 'error' : 'ready', done: model === 'downloading' ? 60 * MB : 0, total: 142 * MB, pct: model === 'downloading' ? 42 : 0, size: '142 MB', error: model === 'error' ? "Couldn't download it. Check your internet connection and try again." : null, selected: true },
        { id: 'parakeet', label: 'Parakeet', about: 'Slower, more accurate.', status: 'missing', done: 0, total: 0, pct: 0, size: '640 MB', error: null, selected: false },
      ],
      using: null,
      shadow: mac ? null : { label: 'Parakeet', on: false, ready: false, needsTelemetry: false },
      mute: mac ? true : null,
    },
    general: { sound: true, login: false, actions: false },
    memory: {
      busy: false, hasSession: !empty,
      commitments: empty ? [] : [{ id: 'c1', text: 'Send the invoice to Sam', when: 'yesterday 5pm', overdue: true }, { id: 'c2', text: 'Book the dentist', when: 'Friday', overdue: false }],
      facts: empty ? [] : [{ id: 'f1', text: 'Prefers short answers' }, { id: 'f2', text: 'Works in Berlin time' }],
    },
    privacy: { telemetry: true, text: false, locked: false },
    about: { version: '0.9.0', usage: { requests: empty ? 0 : 12, tokens: 48200 }, update: { available: null, installing: false }, licenses: true },
  };
  const out = (m, ms = 30) => setTimeout(() => window.__settings?.(structuredClone(m)), ms);
  const state = (ms) => out(s, ms);
  const setters = {
    sound: (v) => { s.general.sound = v; }, login: (v) => { s.general.login = v; }, actions: (v) => { s.general.actions = v; },
    voice: (v) => { s.voice.on = v; }, voiceMode: (v) => { s.voice.mode = v; }, muteWhileTalking: (v) => { s.voice.mute = v; },
    voiceEngine: (v) => { for (const e of s.voice.engines ?? []) e.selected = e.id === v; }, voiceShadow: (v) => { if (s.voice.shadow) s.voice.shadow.on = v; },
    telemetry: (v) => { s.privacy.telemetry = v; if (!v) s.privacy.text = false; }, telemetryText: (v) => { s.privacy.text = v; },
    model: (v) => { for (const p of s.ai.models) for (const m of p.models) m.selected = p.provider === v.provider && m.id === v.id; const m = s.ai.models.flatMap((p) => p.models).find((x) => x.selected); if (m) s.ai.connected.model = m.name; },
  };
  const download = (id) => {
    const e = s.voice.engines.find((x) => x.id === id);
    Object.assign(e, { status: 'downloading', done: 0, total: e.total || 640 * MB, error: null, pct: 0 });
    const t = setInterval(() => {
      e.done = Math.min(e.total, e.done + e.total / 20); e.pct = Math.floor((e.done / e.total) * 100);
      if (e.done >= e.total) { e.status = 'ready'; clearInterval(t); if (s.voice.shadow && id === 'parakeet') s.voice.shadow.ready = true; state(); }
      else out({ kind: 'voice_model', engines: s.voice.engines }, 0);
    }, 200);
  };
  let asked = 0;
  return async (cmd, args) => {
    if (cmd !== 'sidecar_send') return;
    const m = args.msg;
    if (m.type === 'st_hello') state(60);
    else if (m.type === 'settings_set') {
      if (!setters[m.key]) { out({ kind: 'error', key: m.key, error: 'unknown setting' }); return state(); }
      setters[m.key](m.value); state();
    } else if (m.type === 'settings_action') {
      const [kind, id] = m.id.split(':');
      if (kind === 'done' || kind === 'drop') s.memory.commitments = s.memory.commitments.filter((c) => c.id !== id);
      else if (kind === 'forget') s.memory.facts = s.memory.facts.filter((f) => f.id !== id);
      else if (kind === 'forgetall_confirmed') s.memory.facts = [];
      else if (kind === 'voicedl') download(id);
      else if (kind === 'new') s.memory.hasSession = false;
      else if (kind === 'login') {
        s.ai.loggingIn = id; state();
        out({ kind: 'login', provider: id, phase: 'browser' }, 300);
        // Anthropic asks for a pasted code, like the real sign-in; the others finish on their own.
        if (id === 'anthropic') out({ kind: 'ask', id: `a${++asked}`, prompt: 'Paste the code from the browser here.', placeholder: 'code#state' }, 700);
        else setTimeout(() => { finishLogin(id); }, 1600);
        return;
      }
      state();
    } else if (m.type === 'answer') {
      const id = s.ai.loggingIn;
      if (m.text == null) { s.ai.loggingIn = null; out({ kind: 'login', provider: id, phase: 'error', error: 'Sign-in cancelled.' }); state(); }
      else setTimeout(() => finishLogin(id), 500);
    } else if (m.type === 'st_apikey') {
      if (failKey) { failKey = false; return out({ kind: 'login', provider: m.provider, phase: 'error', error: '401 invalid x-api-key' }, 500); }
      const p = s.ai.apikey.find((x) => x.id === m.provider); p.connected = true;
      if (!s.ai.models.some((x) => x.provider === p.id)) s.ai.models.push({ provider: p.id, label: p.name, models: [{ id: 'auto', name: `${p.name} Auto`, selected: !s.ai.connected }] });
      s.ai.connected ??= { provider: p.name, model: `${p.name} Auto` };
      out({ kind: 'login', provider: m.provider, phase: 'done' }, 500); state(520);
    }
  };
  function finishLogin(id) {
    const p = s.ai.oauth.find((x) => x.id === id); p.connected = true; s.ai.loggingIn = null;
    if (!s.ai.models.some((x) => x.provider === id)) s.ai.models.push({ provider: id, label: p.company, models: [{ id: 'm1', name: `${p.name} Default`, selected: !s.ai.connected }] });
    s.ai.connected ??= { provider: p.company, model: `${p.name} Default` };
    out({ kind: 'login', provider: id, phase: 'done' }); state(40);
  }
};
