// A request id sent with a voice message reaches every component's events in the day file. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-tel-'));
const rid = 'ab'.repeat(16);
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ROAMIES_DATA_DIR: tmp, ROAMIES_VERSION: '9.9.9' };
delete env.ROAMIES_USAGE;

const child = spawn(process.execPath, [path.join(dir, 'sidekick.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const killer = setTimeout(() => child.kill(), 10_000);
let out = '', closed = false;
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const close = () => { if (!closed) { closed = true; child.stdin.end(); } };
child.stderr.on('data', () => {});
child.stdout.on('data', (d) => {
  out += d;
  // With no sign-in the request ends at once with not_signed_in; the agent's reply is a `say`.
  if (/Sign in to an AI provider/.test(out)) close();
});

const ev = (component, step, kind, extra = {}) => ({
  schema: 1, ts: Date.now(), request_id: rid, step_id: (component === 'voice' ? '1' : '2').repeat(16), parent_step_id: null,
  kind, step, component, duration_ms: kind === 'end' ? 12 : null, outcome: kind === 'end' ? 'ok' : null, error_code: null, attrs: {}, ...extra,
});
send({ type: 'telemetry', events: [
  ev('voice', 'voice.session', 'start', { attrs: { engine: 'moonshine' } }),
  ev('voice', 'voice.session', 'end'),
  ev('host', 'host.voice_session', 'start'),
  ev('host', 'host.voice_session', 'end'),
  ev('webview', 'ui.listen_shown', 'event', { step_id: '3'.repeat(16) }),
] });
send({ type: 'voice', text: 'what time is it', request_id: rid });
setTimeout(close, 6000);

const code = await new Promise((r) => child.on('exit', r));
clearTimeout(killer);
const tdir = path.join(tmp, 'sidekick', 'telemetry');
const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')) : [];
// With telemetry forced off (npm run test:telemetry-off) the same session writes nothing.
if (process.env.ROAMIES_TELEMETRY === 'off') {
  assert.equal(files.length, 0, 'no day file with telemetry off');
  assert.match(out, /Sign in to an AI provider/, 'same reply with telemetry off');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('telemetry propagation tests passed (telemetry off)');
  process.exit(0);
}
assert.equal(files.length, 1, `one day file expected, got ${files} (exit ${code})`);
const lines = fs.readFileSync(path.join(tdir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const mine = lines.filter((e) => e.request_id === rid);
const comps = new Set(mine.map((e) => e.component));
for (const c of ['voice', 'host', 'webview', 'sidecar']) assert.ok(comps.has(c), `${c} events carry the request id`);
const req = mine.filter((e) => e.step === 'agent.request');
assert.deepEqual(req.map((e) => e.kind), ['start', 'end']);
assert.equal(req[1].outcome, 'error');
assert.equal(req[1].error_code, 'not_signed_in');
assert.equal(req[0].step_id, req[1].step_id);
assert.equal(req[0].attrs.source, 'voice');
assert.equal(req[0].attrs.text, undefined, 'no text without include-text');
assert.ok(mine.every((e) => e.schema === 1 && e.app_version && e.os), 'sink stamps version and os');
assert.ok(mine.filter((e) => e.component !== 'sidecar').every((e) => e.app_version === '9.9.9'), 'version stamped on forwarded events');
if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(tdir, files[0])).mode & 0o777, 0o600);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('telemetry propagation tests passed');
