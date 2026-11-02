// The Settings window gets live state while open, and window changes apply. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-st-'));
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ROAMIES_DATA_DIR: tmp, ROAMIES_TELEMETRY: 'off', ROAMIES_FAKE_OAUTH: '1' };
delete env.ROAMIES_USAGE;
fs.mkdirSync(path.join(tmp, '.gg')); // the auth store (API-key sign-in) lives here

const child = spawn(process.execPath, [path.join(dir, 'sidekick.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const killer = setTimeout(() => child.kill(), 15_000);
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
child.stderr.on('data', () => {});
const seen = [];
let waiter = null, buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { seen.push(JSON.parse(line)); waiter?.(); } catch {}
  }
});
const states = () => seen.filter((m) => m.type === 'settings' && m.msg?.kind === 'state');
const until = (what, pred) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000);
  const check = () => { const m = pred(); if (m) { clearTimeout(t); waiter = null; resolve(m); } };
  waiter = check; check();
});
const nthState = (n) => until(`settings state #${n}`, () => states()[n - 1]?.msg);

try {
  send({ type: 'st_hello' });
  const first = await nthState(1);
  assert.equal(first.general.sound, true);
  assert.ok(first.sections.includes('general'));
  await until('tray tooltip', () => seen.find((m) => m.type === 'tray_tooltip' && m.text.startsWith('Roamies · ')));

  const mark = seen.length;
  send({ type: 'settings_set', key: 'sound', value: false });
  await until('state with sound off', () => seen.slice(mark).find((m) => m.type === 'settings' && m.msg?.kind === 'state' && m.msg.general.sound === false));
  assert.equal(states().at(-1).msg.general.sound, false, 'window change shows in the window');
  assert.ok(seen.slice(mark).some((m) => m.type === 'ui' && m.msg?.kind === 'sound' && m.msg.on === false), 'and reaches the mascot');
  assert.ok(!seen.slice(mark).some((m) => m.type === 'ui' && m.msg?.kind === 'say'), 'quietly');

  send({ type: 'settings_set', key: 'sound', value: 'yes' });
  await until('error', () => seen.find((m) => m.type === 'settings' && m.msg?.kind === 'error' && m.msg.key === 'sound'));
  send({ type: 'settings_set', key: 'evil', value: true });
  await until('error', () => seen.find((m) => m.type === 'settings' && m.msg?.kind === 'error' && m.msg.key === 'evil'));

  send({ type: 'menu', id: 'settings' });
  await until('settings_window', () => seen.find((m) => m.type === 'settings_window'));

  // With the window closed, changes don't send window state.
  send({ type: 'st_closed' });
  await new Promise((r) => setTimeout(r, 200));
  const before = states().length;
  send({ type: 'menu', id: 'actions' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(states().length, before);

  // Closing the window mid sign-in cancels the code prompt, so the next sign-in isn't stuck as busy.
  send({ type: 'st_hello' });
  await until('state with sign-in buttons', () => states().at(-1)?.msg.ai?.oauth?.length && states().length > before);
  const asksTo = (from) => seen.slice(from).filter((m) => m.type === 'settings' && m.msg?.kind === 'ask');
  let from = seen.length;
  send({ type: 'settings_action', id: 'login:anthropic' });
  await until('code prompt in Settings', () => asksTo(from)[0]);
  send({ type: 'st_closed' });
  await new Promise((r) => setTimeout(r, 200));
  send({ type: 'st_hello' });
  from = seen.length;
  send({ type: 'settings_action', id: 'login:anthropic' });
  await until('second code prompt', () => asksTo(from)[0]);
  assert.ok(!seen.some((m) => m.msg?.kind === 'say' && /One at a time/.test(m.msg.text)), 'no login_busy');

  // "Change in setup guide" with the guide already open jumps it to the shortcuts step.
  send({ type: 'ob_hello' });
  await until('guide state', () => seen.find((m) => m.type === 'onboard' && m.msg?.kind === 'state'));
  send({ type: 'st_hello' });
  from = seen.length;
  send({ type: 'settings_action', id: 'setup_keys' });
  const jump = await until('goto', () => seen.slice(from).find((m) => m.type === 'onboard' && m.msg?.kind === 'goto'));
  assert.deepEqual(jump.msg, { kind: 'goto', step: 3 });

  // With the guide also open, sign-in results still go back to Settings, which started them.
  const logins = (from, type) => seen.slice(from).filter((m) => m.type === type && m.msg?.kind === 'login');
  const pendingAsk = asksTo(0).at(-1).msg.id;
  from = seen.length;
  send({ type: 'answer', id: pendingAsk, text: 'code' }); // fake OAuth then fails
  await until('OAuth error in Settings', () => logins(from, 'settings').find((m) => m.msg.phase === 'error'));
  from = seen.length;
  send({ type: 'settings_action', id: 'login:anthropic' });
  await until('code prompt in Settings with the guide open', () => asksTo(from)[0]);
  assert.ok(!seen.slice(from).some((m) => m.type === 'onboard' && m.msg?.kind === 'ask'), 'no code prompt in the guide');
  send({ type: 'answer', id: asksTo(from)[0].msg.id, text: 'code' });
  await until('second OAuth error in Settings', () => logins(from, 'settings').find((m) => m.msg.phase === 'error'));

  from = seen.length;
  send({ type: 'st_apikey', provider: 'nope', key: 'k' });
  await until('unknown provider error in Settings', () => logins(from, 'settings')[0]);
  const keyProvider = states().at(-1).msg.ai.apikey[0].id;
  from = seen.length;
  send({ type: 'st_apikey', provider: keyProvider, key: 'test-key' });
  const done = await until('API key done in Settings', () => logins(from, 'settings').find((m) => m.msg.phase === 'done'));
  assert.equal(done.msg.provider, keyProvider);
  assert.equal(logins(0, 'onboard').length, 0, 'no sign-in replies leaked to the guide');
} finally {
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  clearTimeout(killer);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('settings sync tests passed');
