// Tray toggles for file edits and sound refresh an open setup guide. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-ob-'));
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ROAMIES_DATA_DIR: tmp, ROAMIES_TELEMETRY: 'off' };
delete env.ROAMIES_USAGE;

const child = spawn(process.execPath, [path.join(dir, 'sidekick.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const killer = setTimeout(() => child.kill(), 15_000);
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
child.stderr.on('data', () => {});
const states = [];
let waiter = null, buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'onboard' && m.msg?.kind === 'state') { states.push(m.msg); waiter?.(); }
  }
});
const nextState = (n) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no guide state #${n}`)), 5000);
  const check = () => { if (states.length >= n) { clearTimeout(t); waiter = null; resolve(states[n - 1]); } };
  waiter = check; check();
});

try {
  send({ type: 'ob_hello' });
  const first = await nextState(1);
  assert.equal(first.actions, false);
  assert.equal(first.sound, true);

  send({ type: 'menu', id: 'actions' });
  assert.equal((await nextState(2)).actions, true, 'tray edits toggle reaches the guide');

  send({ type: 'menu', id: 'sound' });
  assert.equal((await nextState(3)).sound, false, 'tray sound toggle reaches the guide');

  // With the guide closed, tray toggles don't send guide state.
  send({ type: 'ob_closed' });
  send({ type: 'menu', id: 'actions' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(states.length, 3);
} finally {
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  clearTimeout(killer);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('onboard sync tests passed');
