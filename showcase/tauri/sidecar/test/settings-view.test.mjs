// Settings window view model and what it may change. Run: npm test
import assert from 'node:assert/strict';
import { SETTINGS_KEYS, settingsView, validateAction, validateSetting } from '../settings-view.mjs';
import { snap } from './fixtures/snapshot.mjs';

// Sections per platform; voice hidden without VOICE_OK.
const win = settingsView(snap());
assert.equal(win.kind, 'state');
assert.deepEqual(win.sections, ['ai', 'appearance', 'voice', 'general', 'memory', 'privacy', 'about']);
assert.equal(win.voice.mute, null, 'mute-while-talking is macOS only');
assert.equal(win.voice.engines.length, 2);
assert.equal(win.voice.engines.find((e) => e.id === 'moonshine').selected, true);
assert.equal(settingsView(snap({ platform: 'darwin', needsModel: false })).voice.mute, true);
assert.equal(settingsView(snap({ platform: 'darwin', needsModel: false })).voice.engines, null);
const noVoice = settingsView(snap({ voiceOk: false }));
assert.deepEqual(noVoice.sections, ['ai', 'appearance', 'voice', 'general', 'memory', 'privacy', 'about'], 'voice stays for spoken replies');
assert.equal(noVoice.voice, null);
assert.equal(settingsView(snap({ platform: 'win32', canSnap: true })).voice.canSnap, true, 'snap shortcut listed on Windows');
assert.equal(settingsView(snap({ platform: 'win32', canSnap: false })).voice.canSnap, false);
assert.equal(settingsView(snap({ login: { supported: false, on: false } })).general.login, null);

// AI: connected model and per-provider model list for signed-in providers only.
assert.deepEqual(win.ai.connected, { provider: 'Anthropic', model: 'Claude Sonnet' });
assert.deepEqual(win.ai.models.map((p) => p.provider), ['anthropic']);
assert.equal(win.ai.models[0].models.find((m) => m.selected).id, 'sonnet');

// Empty states: not signed in, nothing remembered, no commitments.
const empty = settingsView(snap({ current: null, providers: snap().providers.map((p) => ({ ...p, signedIn: false, models: [] })), facts: [], commitments: [] }));
assert.equal(empty.ai.connected, null);
assert.deepEqual(empty.ai.models, []);
assert.deepEqual(empty.memory.facts, []);
assert.deepEqual(empty.memory.commitments, []);
assert.equal(win.memory.commitments[0].overdue, true);

// Downloading state carries a percentage.
const dl = settingsView(snap({ engines: [{ id: 'parakeet', label: 'Parakeet', about: '', status: 'downloading', done: 30, total: 120, size: '600 MB' }] }));
assert.equal(dl.voice.engines[0].pct, 25);

// validateSetting: unknown keys, wrong types, models from providers you're not signed in to.
const v = snap();
assert.equal(validateSetting('nope', true, v).ok, false);
assert.equal(validateSetting('__proto__', true, v).ok, false);
assert.equal(validateSetting('sound', 'false', v).ok, false);
assert.deepEqual(validateSetting('sound', false, v), { ok: true, value: false });
for (const k of Object.keys(SETTINGS_KEYS)) if (SETTINGS_KEYS[k] === 'boolean') assert.equal(validateSetting(k, 1, v).ok, false, k);
assert.equal(validateSetting('voice', true, snap({ voiceOk: false })).ok, false);
assert.equal(validateSetting('muteWhileTalking', true, v).ok, false, 'not on Windows');
assert.equal(validateSetting('muteWhileTalking', true, snap({ platform: 'darwin' })).ok, true);
assert.equal(validateSetting('login', true, snap({ login: { supported: false, on: false } })).ok, false);
assert.equal(validateSetting('telemetry', true, snap({ telemetry: { on: false, text: false, locked: true } })).ok, false);
assert.equal(validateSetting('telemetryText', true, snap({ telemetry: { on: false, text: false, locked: false } })).ok, false);
assert.equal(validateSetting('voiceMode', 'dictation', v).ok, true);
assert.equal(validateSetting('voiceMode', 'shout', v).ok, false);
assert.equal(validateSetting('voiceEngine', 'parakeet', v).ok, true);
assert.equal(validateSetting('voiceEngine', 'whisper', v).ok, false);
assert.deepEqual(validateSetting('model', { provider: 'anthropic', id: 'opus', extra: 1 }, v), { ok: true, value: { provider: 'anthropic', id: 'opus' } });
assert.equal(validateSetting('model', { provider: 'openai', id: 'gpt' }, v).ok, false, 'not signed in');
assert.equal(validateSetting('model', { provider: 'anthropic', id: 'gpt' }, v).ok, false, 'unknown model');
assert.equal(validateSetting('model', 'anthropic:opus', v).ok, false);

// validateAction: allowlisted ids only, with their targets.
assert.equal(validateAction('forgetall_confirmed', v), true);
assert.equal(validateAction('forgetall', v), false, 'the window confirms first');
assert.equal(validateAction('quit', v), false);
assert.equal(validateAction('done:c1', v), true);
assert.equal(validateAction('drop:c9', v), false);
assert.equal(validateAction('forget:f1', v), true);
assert.equal(validateAction('login:anthropic', v), true);
assert.equal(validateAction('login:anthropic', snap({ loggingIn: 'openai' })), false);
assert.equal(validateAction('voicedl:parakeet', v), true);
assert.equal(validateAction('voicedl:moonshine', v), false, 'already ready');
assert.equal(validateAction('install_update', v), false);
assert.equal(validateAction('install_update', snap({ update: { available: '2.0.0', installing: false } })), true);
assert.equal(validateAction('new', snap({ busy: true })), false);
assert.equal(validateAction('licenses', snap({ licenses: false })), false);
assert.equal(validateAction(42, v), false);

// Panel features folded into Settings: looks, size, spoken replies, recent activity, Get to know me.
assert.deepEqual(win.appearance, { look: 'classic', size: 'default', looks: [{ id: 'classic', name: 'Roamie' }, { id: 'jarvis', name: 'JARVIS' }], sizes: [{ id: 'default', name: 'Default' }, { id: 'small', name: 'Small' }, { id: 'cursor', name: 'Cursor' }] });
assert.equal(win.replies.mode, 'text');
assert.equal(win.replies.key, false);
assert.deepEqual(win.replies.models.map((m) => m.id), ['drama-3', 's2.1-pro']);
assert.equal(win.replies.keyWhere, 'Windows, encrypted for your account');
assert.equal(settingsView(snap({ platform: 'darwin' })).replies.keyWhere, 'your Keychain');
assert.deepEqual(win.memory.recent, [{ at: 1, kind: 'ask', text: 'What is up?' }]);
assert.equal(win.memory.intro, false);
assert.deepEqual(validateSetting('look', 'jarvis', v), { ok: true, value: 'jarvis' });
assert.equal(validateSetting('look', 'ken', v).ok, false, 'only real looks');
assert.equal(validateSetting('look', 1, v).ok, false);
assert.deepEqual(validateSetting('size', 'cursor', v), { ok: true, value: 'cursor' });
assert.equal(validateSetting('size', 'huge', v).ok, false);
assert.deepEqual(validateSetting('replies', 'text', v), { ok: true, value: 'text' });
assert.equal(validateSetting('replies', 'voice', v).ok, false, 'voice needs a Fish Audio key');
assert.equal(validateSetting('replies', 'voice', snap({ fishKey: true })).ok, true);
assert.equal(validateSetting('replies', 'shout', snap({ fishKey: true })).ok, false);
assert.equal(validateSetting('fishModel', 's2.1-pro', v).ok, true);
assert.equal(validateSetting('fishModel', 'free', v).ok, false);
assert.equal(validateAction('intro', v), true);
assert.equal(validateAction('intro', snap({ intro: true })), false, 'already chatting');
assert.equal(validateAction('fishkey_remove', v), false, 'no key to remove');
assert.equal(validateAction('fishkey_remove', snap({ fishKey: true })), true);
assert.equal(validateAction('fishkey', v), false, 'the window sends the key itself (st_fishkey)');

console.log('settings view tests passed');
