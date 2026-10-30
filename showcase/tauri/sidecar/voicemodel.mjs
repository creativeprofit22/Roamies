// The speech model for voice on Windows: NVIDIA Parakeet TDT 0.6B v3, int8 ONNX export (CC-BY-4.0,
// huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), pinned to one commit and checked by SHA-256.
// Downloaded once into the user's local app data; interrupted downloads resume where they stopped.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  base: 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/',
  files: [
    { name: 'encoder-model.int8.onnx', size: 652183999, sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
    { name: 'decoder_joint-model.int8.onnx', size: 18202004, sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
    { name: 'vocab.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
};

export const totalBytes = (model = MODEL) => model.files.reduce((n, f) => n + f.size, 0);
export const sizeLabel = (model = MODEL) => `${Math.round(totalBytes(model) / 1e6)} MB`;

export function modelDir(model = MODEL) {
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Roamies') : path.join(os.homedir(), '.gg', 'sidekick');
  return path.join(root, 'models', model.id);
}

const READY = 'ready.json';

/** Downloaded and verified: the marker is written only after every file's checksum matched. */
export function isReady(dir, model = MODEL) {
  try {
    if (JSON.parse(readFileSync(path.join(dir, READY), 'utf8')).id !== model.id) return false;
    return model.files.every((f) => statSync(path.join(dir, f.name)).size === f.size);
  } catch { return false; }
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Fetches every missing file, verifies it and writes the ready marker.
 * onProgress({ done, total }) runs often; throttle it in the caller.
 * Errors carry a code: 'disk' (not enough space), 'checksum', 'network' or 'aborted'.
 */
export async function downloadModel(dir, { model = MODEL, onProgress = () => {}, signal, fetchImpl = fetch, retries = 4, retryDelay = 2000 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const total = totalBytes(model);
  const have = async (f) => {
    for (const p of [path.join(dir, f.name), path.join(dir, `${f.name}.part`)]) {
      try { return Math.min((await fs.stat(p)).size, f.size); } catch {}
    }
    return 0;
  };
  const counts = await Promise.all(model.files.map(have));
  let done = counts.reduce((a, b) => a + b, 0);
  try {
    const free = await fs.statfs(dir);
    // Room for what's left plus a little slack.
    if (free.bavail * free.bsize < total - done + 50e6) throw fail('disk', `Not enough free disk space: the voice model needs ${sizeLabel(model)}.`);
  } catch (e) { if (e.code === 'disk') throw e; }
  onProgress({ done, total });

  for (const f of model.files) {
    const final = path.join(dir, f.name), part = `${final}.part`;
    if (existsSync(final) && statSync(final).size === f.size) {
      if (await sha256(final) === f.sha256) continue;
      await fs.rm(final, { force: true });
      done -= f.size; onProgress({ done, total });
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw fail('aborted', 'Download stopped.');
      let start = 0;
      try { start = (await fs.stat(part)).size; } catch {}
      if (start > f.size) { await fs.rm(part, { force: true }); done -= start; start = 0; }
      try {
        if (start < f.size) {
          const res = await fetchImpl(model.base + f.name, { headers: start ? { Range: `bytes=${start}-` } : {}, signal, redirect: 'follow' });
          // 206: resuming. 200: the server sent it all, so start over. 416: what's there is already complete or wrong.
          if (res.status === 416) { await fs.rm(part, { force: true }); done -= start; onProgress({ done, total }); throw fail('network', 'Range not satisfiable'); }
          if (!res.ok || !res.body) throw fail('network', `HTTP ${res.status}`);
          const resumed = res.status === 206 && start > 0;
          if (!resumed && start) { done -= start; start = 0; }
          // Each chunk is written before the next is read, so a dropped connection keeps everything that arrived.
          const fh = await fs.open(part, resumed ? 'a' : 'w');
          try {
            for await (const chunk of res.body) { await fh.write(chunk); done += chunk.length; onProgress({ done, total }); }
          } finally { await fh.close(); }
        }
        if ((await fs.stat(part)).size !== f.size) throw fail('network', 'Download ended early');
        if (await sha256(part) !== f.sha256) {
          await fs.rm(part, { force: true });
          done -= f.size; onProgress({ done, total });
          throw fail('checksum', `${f.name} didn't match its checksum`);
        }
        await fs.rename(part, final);
        break;
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw fail('aborted', 'Download stopped.');
        if (attempt >= retries) throw e.code === 'checksum' ? e : fail('network', `Couldn't download the voice model (${e.message}).`);
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
      }
    }
  }
  await fs.writeFile(path.join(dir, READY), JSON.stringify({ id: model.id, at: new Date().toISOString() }));
  onProgress({ done: total, total });
}
