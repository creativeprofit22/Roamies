// Voice model download: resume, restart on 200, checksum rejection, atomic install, pins match
// fetch-moonshine.sh, chord labels. Uses a local HTTP server and a throwaway folder. Run: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MODEL, downloadModel, installModel, isInstalled, isReady, modelDir, sizeLabel, talkLabel, totalBytes } from '../voice-model.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-model-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const blobs = { a: crypto.randomBytes(200_000), b: crypto.randomBytes(1234) };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let mode = {}; // per-file behaviour: 'drop-once' | 'no-range' | 'corrupt'
const log = [];
const server = http.createServer((req, res) => {
  const name = req.url.slice(1);
  if (!blobs[name]) { res.writeHead(404); return res.end(); }
  const body = mode[name] === 'corrupt' ? Buffer.alloc(blobs[name].length, 7) : blobs[name];
  log.push({ name, range: req.headers.range ?? null });
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (m && mode[name] !== 'no-range') {
    const from = Number(m[1]);
    res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` });
    return res.end(body.subarray(from));
  }
  res.writeHead(200, { 'Content-Length': body.length });
  if (mode[name] === 'drop-once') {
    mode[name] = null;
    res.write(body.subarray(0, 50_000), () => setTimeout(() => res.socket.destroy(), 20));
    return;
  }
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const manifest = {
  name: 'test-model', rev: 'r1',
  files: Object.entries(blobs).map(([name, b]) => ({ name, sha256: sha(b), size: b.length, url: `${base}/${name}` })),
};
const opts = (dir, extra = {}) => ({ dir, manifest, backoffMs: 1, ...extra });
const fresh = (n) => path.join(TMP, n, 'test-model');

// resume after a dropped connection: the retry asks for the rest with Range and gets 206
{
  const dir = fresh('resume');
  mode = { a: 'drop-once' }; log.length = 0;
  const seen = [];
  await installModel(opts(dir, { onProgress: (p) => seen.push(p) }));
  assert.ok(isInstalled(dir, manifest));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a')), blobs.a);
  const retry = log.filter((l) => l.name === 'a')[1];
  assert.ok(retry?.range && retry.range !== 'bytes=0-', 'retry resumes with Range: ' + JSON.stringify(log));
  assert.equal(seen.at(-1).done, seen.at(-1).total);
  assert.ok(!fs.existsSync(`${dir}.partial`), 'staging folder is gone after install');
}

// a server that ignores Range (200) restarts the file instead of appending
{
  const dir = fresh('norange');
  fs.mkdirSync(`${dir}.partial`, { recursive: true });
  fs.writeFileSync(path.join(`${dir}.partial`, 'a'), blobs.a.subarray(0, 70_000));
  mode = { a: 'no-range' }; log.length = 0;
  await installModel(opts(dir));
  assert.equal(log[0].range, 'bytes=70000-');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a')), blobs.a);
}

// checksum mismatch: rejected after retries, bad file removed, nothing installed
{
  const dir = fresh('corrupt');
  mode = { b: 'corrupt' }; log.length = 0;
  await assert.rejects(installModel(opts(dir, { retries: 2 })), /checksum mismatch for b/);
  assert.equal(log.filter((l) => l.name === 'b').length, 3, '1 try + 2 retries');
  assert.ok(!fs.existsSync(dir), 'no model dir after a failed install');
  assert.ok(!fs.existsSync(path.join(`${dir}.partial`, 'b')), 'bad file removed from staging');
  assert.ok(fs.existsSync(path.join(`${dir}.partial`, 'a')), 'verified file kept for the next try');
  // next try (server fixed) finishes without refetching the good file
  mode = {}; log.length = 0;
  await installModel(opts(dir));
  assert.deepEqual(log.map((l) => l.name), ['b']);
  assert.ok(isInstalled(dir, manifest));
}

// atomic: the model dir appears only when complete; an installed model is not fetched again
{
  const dir = fresh('atomic');
  mode = {};
  const p = installModel(opts(dir, { onProgress: () => assert.ok(!fs.existsSync(dir), 'dir must not exist mid-install') }));
  await p;
  assert.ok(isInstalled(dir, manifest));
  log.length = 0;
  await installModel(opts(dir));
  assert.equal(log.length, 0);
  fs.truncateSync(path.join(dir, 'b'), 10);
  assert.ok(!isInstalled(dir, manifest), 'a damaged file means not installed');
}

// upstream-shaped API: sizes, isReady, downloadModel with coded errors
{
  assert.equal(totalBytes(manifest), blobs.a.length + blobs.b.length);
  assert.equal(totalBytes(), MODEL.files.reduce((n, f) => n + f.size, 0));
  assert.equal(sizeLabel(), `${Math.round(totalBytes() / 1e6)} MB`);
  const dir = fresh('dl');
  mode = {};
  const seen = [];
  await downloadModel(dir, { manifest, backoffMs: 1, onProgress: (p) => seen.push(p) });
  assert.ok(isReady(dir, manifest));
  assert.equal(seen.at(-1).done, totalBytes(manifest));
  // already there: no fetch, progress reports complete
  log.length = 0; seen.length = 0;
  await downloadModel(dir, { manifest, onProgress: (p) => seen.push(p) });
  assert.equal(log.length, 0);
  assert.deepEqual(seen, [{ done: totalBytes(manifest), total: totalBytes(manifest) }]);

  mode = { b: 'corrupt' };
  await assert.rejects(downloadModel(fresh('dl-bad'), { manifest, retries: 0, backoffMs: 1 }), (e) => e.code === 'checksum');
  mode = {};
  await assert.rejects(downloadModel(fresh('dl-disk'), { manifest, statfs: async () => ({ bavail: 1, bsize: 4096 }) }), (e) => e.code === 'disk' && /disk space/.test(e.message));
  const gone = { ...manifest, files: [{ ...manifest.files[0], url: `${base}/missing` }] };
  await assert.rejects(downloadModel(fresh('dl-net'), { manifest: gone, retries: 0, backoffMs: 1 }), (e) => e.code === 'network');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(downloadModel(fresh('dl-abort'), { manifest, signal: ac.signal }), (e) => e.code === 'aborted');
}

server.close();

// the shipped manifest pins exactly what fetch-moonshine.sh pins for small
{
  const sh = fs.readFileSync(new URL('../../src-tauri/voice-rs/fetch-moonshine.sh', import.meta.url), 'utf8');
  const pins = Object.fromEntries([...sh.matchAll(/\[small\/([^\]]+)\]=([0-9a-f]{64})/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.fromEntries(MODEL.files.map((f) => [f.name, f.sha256])), pins);
  const rev = /MODEL_REV=(\S+)/.exec(sh)[1];
  assert.equal(MODEL.rev, rev);
  for (const f of MODEL.files) assert.ok(f.url.endsWith(`/small-streaming-en/${rev}/${f.name}`), f.url);
}

// model location
assert.equal(modelDir({ LOCALAPPDATA: 'C:\L' }), path.join('C:\L', 'Roamies', 'models', 'moonshine-small'));
assert.equal(modelDir({ ROAMIES_DATA_DIR: '/d', LOCALAPPDATA: 'C:\L' }), path.join('/d', 'models', 'moonshine-small'));

// chord labels
assert.equal(talkLabel(['option', 'control'], 'win32'), 'Ctrl+Alt');
assert.equal(talkLabel(['option', 'control'], 'win32', 'words'), 'Ctrl+Alt');
assert.equal(talkLabel(['command', 'shift'], 'win32'), 'Shift+Win');
assert.equal(talkLabel(['option', 'control'], 'darwin'), '⌃⌥');
assert.equal(talkLabel(['option', 'control'], 'darwin', 'words'), 'Control+Option');

console.log('voice-model tests passed');
