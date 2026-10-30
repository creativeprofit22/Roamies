// Voice model download (Windows voice): resume, checksum, ready marker. Uses a local server, never the real model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadModel, isReady, totalBytes } from '../voicemodel.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-model-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const A = Buffer.alloc(300_000, 7), B = Buffer.from('hello vocab\n');
const files = { 'enc.onnx': A, 'vocab.txt': B };
let requests = [], cutAfter = null, corrupt = false;
const server = http.createServer((req, res) => {
  const body = files[req.url.slice(1)];
  requests.push({ url: req.url, range: req.headers.range });
  if (!body) { res.writeHead(404).end(); return; }
  const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
  const slice = body.subarray(from);
  res.writeHead(from ? 206 : 200, { 'content-length': slice.length });
  if (cutAfter != null) { res.write(slice.subarray(0, cutAfter), () => setTimeout(() => res.destroy(), 30)); cutAfter = null; return; }
  res.end(corrupt ? Buffer.alloc(slice.length, 1) : slice);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const model = {
  id: 'test-model',
  base: `http://127.0.0.1:${server.address().port}/`,
  files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
};
const opts = { model, retryDelay: 1 };

// A first try that drops mid-file resumes with a Range request, then everything verifies.
const dir = path.join(TMP, 'a');
assert.equal(isReady(dir, model), false);
cutAfter = 100_000;
const seen = [];
await downloadModel(dir, { ...opts, onProgress: (p) => seen.push(p) });
assert.equal(isReady(dir, model), true);
assert.deepEqual(fs.readFileSync(path.join(dir, 'enc.onnx')), A);
assert.ok(requests.some((r) => r.url === '/enc.onnx' && r.range === 'bytes=100000-'), 'resumed from where it stopped');
assert.deepEqual(seen.at(-1), { done: totalBytes(model), total: totalBytes(model) });
assert.ok(seen.every((p) => p.done <= p.total), 'progress never overshoots');
assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.part')), false, 'no leftovers');

// Already there: verified from disk, nothing fetched.
requests = [];
await downloadModel(dir, opts);
assert.equal(requests.length, 0);

// A part file left by a quit app is picked up.
const dir2 = path.join(TMP, 'b');
fs.mkdirSync(dir2);
fs.writeFileSync(path.join(dir2, 'enc.onnx.part'), A.subarray(0, 250_000));
requests = [];
await downloadModel(dir2, opts);
assert.equal(isReady(dir2, model), true);
assert.equal(requests.find((r) => r.url === '/enc.onnx').range, 'bytes=250000-');

// Bad bytes never become a ready model.
const dir3 = path.join(TMP, 'c');
corrupt = true;
await assert.rejects(downloadModel(dir3, { ...opts, retries: 0 }), (e) => e.code === 'checksum');
assert.equal(isReady(dir3, model), false);
assert.equal(fs.existsSync(path.join(dir3, 'enc.onnx')), false);
corrupt = false;

// A wrong id in the marker or a truncated file means not ready.
fs.writeFileSync(path.join(dir2, 'ready.json'), JSON.stringify({ id: 'other' }));
assert.equal(isReady(dir2, model), false);
await downloadModel(dir2, opts);
fs.truncateSync(path.join(dir2, 'vocab.txt'), 3);
assert.equal(isReady(dir2, model), false);

// Stopping reports 'aborted'; a missing file is a network error after retries.
const ac = new AbortController(); ac.abort();
await assert.rejects(downloadModel(path.join(TMP, 'd'), { ...opts, signal: ac.signal }), (e) => e.code === 'aborted');
await assert.rejects(downloadModel(path.join(TMP, 'e'), { ...opts, model: { ...model, files: [{ name: 'missing.bin', size: 5, sha256: 'x' }] }, retries: 1 }), (e) => e.code === 'network');

server.close();
console.log('voice model download tests: passed');
