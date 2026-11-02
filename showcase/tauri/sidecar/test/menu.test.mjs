// Tray menu: compact (Windows, Linux) and full (macOS, unchanged). Run: npm test
import assert from 'node:assert/strict';
import { trayMenu, trayTooltip } from '../menu.mjs';
import { snap } from './fixtures/snapshot.mjs';

const flat = (items) => items.flatMap((i) => [i, ...(i.items ? flat(i.items) : [])]);
const ids = (items) => flat(items).filter((i) => i.id).map((i) => i.id);

// Compact: short, plain rows; Stop and the update only when relevant; no greyed-out info rows.
const idle = trayMenu(snap(), { compact: true });
assert.deepEqual(ids(idle), ['show', 'ask', 'list', 'settings', 'quit']);
assert.ok(idle.every((i) => !i.items), 'no submenus');
assert.ok(idle.every((i) => i.sep || i.enabled !== false), 'no disabled rows while idle');
assert.equal(idle.find((i) => i.id === 'show').accel, 'Ctrl+Shift+Space');
assert.equal(idle.find((i) => i.id === 'list').accel, 'Ctrl+Shift+L');

const busy = trayMenu(snap({ busy: true, update: { available: '2.0.0', installing: false } }), { compact: true });
assert.deepEqual(ids(busy), ['show', 'ask', 'list', 'stop', 'install_update', 'settings', 'quit']);
assert.equal(busy.find((i) => i.id === 'ask').enabled, false);
assert.equal(busy.find((i) => i.id === 'install_update').label, 'Install Update 2.0.0 and Restart');
assert.ok(busy.length <= 8);

const installing = trayMenu(snap({ update: { available: '2.0.0', installing: true } }), { compact: true });
assert.equal(installing.find((i) => i.id === 'install_update').enabled, false);

// The status line moves to the tooltip.
assert.equal(trayTooltip(snap()), 'Roamies · Claude Sonnet · Anthropic');
assert.equal(trayTooltip(snap({ busy: true })), 'Roamies · Sidekick is working…');
assert.equal(trayTooltip(snap({ current: null })), 'Roamies · Not signed in');
assert.equal(trayTooltip(snap({ loggingIn: 'openai' })), 'Roamies · Signing in to OpenAI…');

// Full menu (macOS): the same id set as before the Settings window existed.
const norm = (id) => id.replace(/^(done|drop|forget|key|login|noop|voiceengine):.*/, '$1:*').replace(/^model:.*/, 'model:*');
const full = trayMenu(snap({ platform: 'darwin', voiceDl: { status: 'error', done: 0, total: 1, size: '60 MB' } }));
const BEFORE = ['status', 'show', 'snap', 'ask', 'voicehint', 'stop', 'new', 'list', 'done:*', 'drop:*', 'model:*', 'noop:*', 'key:*',
  'voice', 'voicemode:agent', 'voicemode:dictation', 'voiceengine:*', 'voiceshadow', 'voicedl', 'mutetalk', 'usage', 'sound', 'login',
  'actions', 'telemetry', 'telemetrytext', 'telemetryfolder', 'forget:*', 'forgetall', 'setup', 'logs', 'update', 'about', 'licenses', 'quit'];
assert.deepEqual([...new Set(ids(full).map(norm))].sort(), [...BEFORE].sort());
assert.ok(!ids(full).includes('settings'), 'macOS keeps no Settings… row');
assert.ok(flat(full).some((i) => i.label?.startsWith('⚠︎ ')), 'macOS keeps its overdue mark');
const fullEmpty = trayMenu(snap({ platform: 'darwin', facts: [], commitments: [], providers: [] }));
assert.ok(ids(fullEmpty).includes('none'));
assert.ok(ids(trayMenu(snap({ update: { available: '2.0.0', installing: false } }))).includes('install_update'));

console.log('menu tests passed');
