// One voice request through a mocked LLM (local Anthropic-style SSE server) gives one request-id chain:
// hand-off, request, queue wait, two model turns, a tool with its safety check, first text. Then the same run with
// ROAMIES_TELEMETRY=off shows the same UI and writes no telemetry. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rid = 'cd'.repeat(16);

// Turn 1 asks for read_file on a temp file; turn 2 (after the tool result) streams the answer.
function mockLlm(file) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch {}
      if (!/\/messages$/.test(req.url.split('?')[0]) || !json.stream) { res.writeHead(404).end('{}'); return; }
      const afterTool = JSON.stringify(json.messages ?? []).includes('tool_result');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      sse('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } });
      if (!afterTool) {
        sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {} } });
        sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: file }) } });
        sse('content_block_stop', { index: 0 });
        sse('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } });
      } else {
        sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const t of ['The file ', 'says hello.']) sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
        sse('content_block_stop', { index: 0 });
        sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      }
      sse('message_stop', {});
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function run({ off }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-chain-'));
  const file = path.join(tmp, 'note.txt');
  fs.writeFileSync(file, 'hello');
  fs.mkdirSync(path.join(tmp, '.gg'));
  const server = await mockLlm(file);
  // The sign-in lives in ~/.gg/auth.json: write it with gg-core itself, in the temp home.
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ROAMIES_DATA_DIR: tmp, ROAMIES_VERSION: '9.9.9' };
  delete env.ROAMIES_USAGE; delete env.ANTHROPIC_BASE_URL; delete env.ROAMIES_TELEMETRY;
  if (off) env.ROAMIES_TELEMETRY = 'off';
  const setup = `const { AuthStorage } = await import('@kenkaiiii/gg-core');
    await new AuthStorage().setCredentials('anthropic', { accessToken: 'sk-ant-api-test', refreshToken: '', expiresAt: Date.now() + 864e5, baseUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)} });`;
  await new Promise((r, j) => spawn(process.execPath, ['--input-type=module', '-e', setup], { cwd: dir, env, stdio: 'inherit' }).on('exit', (c) => (c ? j(new Error(`auth setup exit ${c}`)) : r())));

  const child = spawn(process.execPath, [path.join(dir, 'sidekick.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const killer = setTimeout(() => child.kill(), 20_000);
  let buf = '', err = '', closed = false;
  const msgs = [];
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const close = () => { if (!closed) { closed = true; child.stdin.end(); } };
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { msgs.push(JSON.parse(line)); } catch { continue; }
      const m = msgs.at(-1).msg ?? {};
      if (m.kind === 'agent' && (m.e?.type === 'done' || m.e?.type === 'error')) setTimeout(close, 300);
    }
  });
  send({ type: 'voice', text: 'what does my note say', request_id: rid, sent_ms: Date.now() - 5 });
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(killer);
  server.close();
  const tdir = path.join(tmp, 'sidekick', 'telemetry');
  const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')) : [];
  const events = files.flatMap((f) => fs.readFileSync(path.join(tdir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code, msgs, events, err, files };
}

// What the user sees: the ui messages, without ids and times.
const view = (msgs) => msgs.filter((m) => m.type === 'ui').map((m) => m.msg)
  .map((m) => JSON.stringify(m, (k, v) => (['request_id', 'id', 'ts', 'ms'].includes(k) ? undefined : v)));

const on = await run({ off: false });
const done = on.msgs.find((m) => m.msg?.kind === 'agent' && m.msg.e?.type === 'done');
if (!done) console.error(on.msgs.map((m) => JSON.stringify(m).slice(0, 200)).join('\n'), on.err.slice(-3000));
assert.ok(done, `reply finished (exit ${on.code})\n${on.err.slice(-2000)}`);
const mine = on.events.filter((e) => e.request_id === rid);
const ends = (step) => mine.filter((e) => e.step === step && e.kind === 'end');
const one = (step) => { const s = ends(step); assert.equal(s.length, 1, `one ${step} end, got ${s.length}`); return s[0]; };

const req = one('agent.request');
assert.equal(req.outcome, 'ok');
assert.equal(req.attrs.provider, 'anthropic');
assert.ok(req.attrs.model, 'model id on the request');
assert.equal(req.attrs.calls, 2);
assert.equal(req.attrs.tools, 1);
assert.ok(req.attrs.in > 0 && req.attrs.out > 0, 'token counts');
assert.ok(req.attrs.first_text_ms >= 0);
for (const s of ['agent.handoff', 'agent.queue_wait']) assert.ok(one(s).duration_ms >= 0, s);
assert.equal(one('agent.handoff').parent_step_id, req.step_id);
const turns = ends('agent.turn');
assert.equal(turns.length, 2, 'two model turns');
for (const t of turns) {
  assert.equal(t.outcome, 'ok');
  assert.equal(t.parent_step_id, req.step_id);
  assert.ok(t.attrs.model && t.attrs.ttft_ms >= 0 && t.attrs.stream_ms >= 0, `turn timing ${JSON.stringify(t.attrs)}`);
}
const tool = one('agent.tool');
const startOf = (e) => mine.find((x) => x.kind === 'start' && x.step_id === e.step_id);
assert.equal(startOf(tool).attrs.name, 'read_file');
assert.equal(tool.outcome, 'ok');
const check = one('agent.safety');
assert.equal(check.attrs.check, 'read');
assert.equal(check.outcome, 'ok');
assert.equal(check.parent_step_id, tool.step_id, 'safety check is a child of its tool call');
assert.equal(mine.filter((e) => e.step === 'agent.first_text').length, 1);

const off = await run({ off: true });
assert.equal(off.files.length, 0, 'no telemetry written when off');
assert.deepEqual(view(off.msgs), view(on.msgs), 'same UI with telemetry on and off');
console.log('telemetry chain tests passed');
