// Windows voice model delivery: Moonshine small streaming English is too big to bundle (135.7 MiB), so it is
// downloaded on first enable into a per-user folder. Files land in a `<dir>.partial` staging folder, resume
// with HTTP Range, are checked against the sha256s pinned in src-tauri/voice-rs/fetch-moonshine.sh, and the
// folder is renamed into place only when every file verifies, so the helper never sees a partial model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21';
export const MODEL = {
  name: 'moonshine-small',
  rev: 'quantized_26_08_21',
  files: [
    ['frontend.model.ort', '09b1210ae30dc5f0f3e45f0ebab914c254741323114f53fbbe5ae62cca35058f', 26944],
    ['frontend.weights.ort', '7ef97521bd4bad3928f5bb6808586f4fcc6e92bd5990394112eed7d4052ec338', 7769464],
    ['encoder.ort', '2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993', 44148576],
    ['adapter.ort', 'c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762', 2870368],
    ['cross_kv.ort', 'e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6', 5356536],
    ['decoder_kv.ort', '1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b', 81878600],
    ['streaming_config.json', '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a', 512],
    ['tokenizer.bin', '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d', 249974],
  ].map(([name, sha256, size]) => ({ name, sha256, size, url: `${BASE}/${name}` })),
};
const MARKER = '.verified';

export function modelDir(env = process.env, manifest = MODEL) {
  if (env.ROAMIES_DATA_DIR) return path.join(env.ROAMIES_DATA_DIR, 'models', manifest.name);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Roamies', 'models', manifest.name);
}

export function isInstalled(dir, manifest = MODEL) {
  try {
    if (fs.readFileSync(path.join(dir, MARKER), 'utf8').trim() !== manifest.rev) return false;
    return manifest.files.every((f) => fs.statSync(path.join(dir, f.name)).size === f.size);
  } catch {
    return false;
  }
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

// One attempt at one file: resumes from what's on disk; a 200 answer to a Range request restarts it.
async function fetchFile(f, file, { fetchImpl, signal, progress }) {
  let have = size(file);
  if (have > f.size) { fs.rmSync(file, { force: true }); have = 0; }
  if (have < f.size) {
    const res = await fetchImpl(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal });
    if (res.status === 200) have = 0;
    else if (res.status !== 206) { await res.body?.cancel(); throw new Error(`HTTP ${res.status} for ${f.name}`); }
    progress(have);
    const fh = await fs.promises.open(file, have ? 'a' : 'w');
    try {
      for await (const chunk of res.body) {
        await fh.write(chunk);
        have += chunk.length;
        progress(have);
      }
    } finally {
      await fh.close();
    }
  }
  if (size(file) !== f.size || (await sha256(file)) !== f.sha256) {
    fs.rmSync(file, { force: true });
    progress(0);
    throw new Error(`checksum mismatch for ${f.name}`);
  }
}

// Installs the model into `dir` (no-op if already there). onProgress({ done, total }) in bytes.
export async function installModel({ dir = modelDir(), manifest = MODEL, onProgress = () => {}, signal, fetchImpl = fetch, retries = 3, backoffMs = 1000 } = {}) {
  if (isInstalled(dir, manifest)) return dir;
  const staging = `${dir}.partial`;
  fs.mkdirSync(staging, { recursive: true });
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  const got = new Map(manifest.files.map((f) => [f.name, Math.min(size(path.join(staging, f.name)), f.size)]));
  const report = () => onProgress({ done: [...got.values()].reduce((a, b) => a + b, 0), total });
  report();
  for (const f of manifest.files) {
    const file = path.join(staging, f.name);
    const progress = (n) => { got.set(f.name, n); report(); };
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchFile(f, file, { fetchImpl, signal, progress });
        break;
      } catch (e) {
        if (signal?.aborted || attempt >= retries) throw e;
        await sleep(backoffMs * 2 ** attempt, signal);
      }
    }
  }
  fs.writeFileSync(path.join(staging, MARKER), manifest.rev);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return dir;
}

// The shape sidekick.mjs's voice-model UX expects (shared with voicemodel.mjs, the Parakeet download).
export const totalBytes = (manifest = MODEL) => manifest.files.reduce((n, f) => n + f.size, 0);
export const sizeLabel = (manifest = MODEL) => `${Math.round(totalBytes(manifest) / 1e6)} MB`;
export const isReady = (dir, manifest = MODEL) => isInstalled(dir, manifest);

const fail = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

// installModel with errors coded 'disk' (not enough space), 'checksum', 'network' or 'aborted'.
export async function downloadModel(dir, { manifest = MODEL, onProgress = () => {}, signal, fetchImpl = fetch, retries, backoffMs, statfs = fs.promises.statfs } = {}) {
  if (isInstalled(dir, manifest)) { onProgress({ done: totalBytes(manifest), total: totalBytes(manifest) }); return dir; }
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  let free = Infinity;
  try { const st = await statfs(parent); free = st.bavail * st.bsize; } catch {}
  // Room for the whole model plus a little slack (what's already staged is small next to it).
  if (free < totalBytes(manifest) + 50e6) throw fail('disk', `Not enough free disk space: the voice model needs ${sizeLabel(manifest)}.`);
  try {
    return await installModel({ dir, manifest, onProgress, signal, fetchImpl, ...(retries != null && { retries }), ...(backoffMs != null && { backoffMs }) });
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw fail('aborted', 'Download stopped.', e);
    if (/checksum mismatch/.test(e?.message)) throw fail('checksum', e.message, e);
    throw fail('network', `Couldn't download the voice model (${e?.message ?? e}).`, e);
  }
}

const WIN_KEY = { control: 'Ctrl', option: 'Alt', shift: 'Shift', command: 'Win' };
const MAC_SYMBOL = { control: '⌃', option: '⌥', shift: '⇧', command: '⌘' };
const MAC_WORD = { control: 'Control', option: 'Option', shift: 'Shift', command: 'Command' };
const ORDER = ['control', 'option', 'shift', 'command'];

// The talk chord as shown to the user: ⌃⌥ / Control+Option on macOS, Ctrl+Alt on Windows.
export function talkLabel(mods, platform = process.platform, style = 'symbols') {
  const sorted = [...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (platform === 'win32') return sorted.map((m) => WIN_KEY[m]).join('+');
  return style === 'symbols' ? sorted.map((m) => MAC_SYMBOL[m]).join('') : sorted.map((m) => MAC_WORD[m]).join('+');
}
