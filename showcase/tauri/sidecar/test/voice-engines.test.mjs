// Voice engine registry (voice-engines.json): choice rule, shape, download manifests, and that the pins,
// installer helpers and licences match what the build scripts ship. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_ENGINE, ENGINES, chooseEngine, engine, manifestFor } from '../voice-engines.mjs';

const readyOf = (...ids) => (id) => ids.includes(id);

// choice rule
assert.deepEqual(chooseEngine({ configured: 'parakeet', ready: readyOf('moonshine', 'parakeet') }), { id: 'parakeet', ready: true });
assert.deepEqual(chooseEngine({ configured: 'moonshine', ready: readyOf('moonshine') }), { id: 'moonshine', ready: true });
assert.deepEqual(chooseEngine({ configured: 'parakeet', ready: readyOf('moonshine') }), { id: 'moonshine', ready: true }, 'configured missing falls back');
assert.deepEqual(chooseEngine({ configured: 'moonshine', ready: readyOf('parakeet') }), { id: 'parakeet', ready: true }, 'falls back past the default');
assert.deepEqual(chooseEngine({ configured: 'parakeet', ready: readyOf() }), { id: 'parakeet', ready: false }, 'none ready keeps the configured one');
assert.deepEqual(chooseEngine({ configured: 'whisper', ready: readyOf() }), { id: DEFAULT_ENGINE, ready: false }, 'unknown id means the default');
assert.deepEqual(chooseEngine({ configured: undefined, ready: readyOf('parakeet') }), { id: 'parakeet', ready: true });

// registry shape
assert.equal(DEFAULT_ENGINE, 'moonshine');
assert.ok(engine(DEFAULT_ENGINE), 'default is listed');
assert.equal(engine('nope'), null);
assert.deepEqual(ENGINES.map((e) => e.id), ['moonshine', 'parakeet'], 'preferred order');
for (const key of ['id', 'helper', 'crate']) assert.equal(new Set(ENGINES.map((e) => e[key])).size, ENGINES.length, `${key} unique`);
assert.equal(new Set(ENGINES.map((e) => e.model.dir)).size, ENGINES.length, 'model folders unique');
assert.equal(engine('moonshine').streaming, true);
assert.equal(engine('parakeet').streaming, false);
for (const e of ENGINES) {
  assert.equal(typeof e.label, 'string');
  assert.equal(typeof e.streaming, 'boolean');
  assert.ok(Array.isArray(e.args));
  assert.ok(e.model.files.length > 0);
  for (const f of e.model.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${e.id}/${f.name}`);
    assert.ok(Number.isInteger(f.size) && f.size > 0, `${e.id}/${f.name} size`);
  }
}

// manifests: folder, marker revision, one https URL per file
for (const e of ENGINES) {
  const m = manifestFor(e);
  assert.equal(m.name, e.model.dir);
  assert.equal(m.rev, e.model.rev);
  assert.equal(m.files.length, e.model.files.length);
  for (const f of m.files) assert.ok(f.url.startsWith('https://') && f.url.endsWith(`/${f.name}`), f.url);
}
assert.equal(manifestFor(engine('moonshine')).name, 'moonshine-small', 'existing downloads stay valid');

const src = (p) => fs.readFileSync(new URL(`../../src-tauri/${p}`, import.meta.url), 'utf8');
const shas = (m) => Object.fromEntries(m.files.map((f) => [f.name, f.sha256]));

// Moonshine pins match fetch-moonshine.sh (small)
{
  const sh = src('voice-rs/fetch-moonshine.sh'), m = manifestFor(engine('moonshine'));
  const pins = Object.fromEntries([...sh.matchAll(/\[small\/([^\]]+)\]=([0-9a-f]{64})/g)].map((x) => [x[1], x[2]]));
  assert.deepEqual(shas(m), pins);
  assert.equal(m.rev, /MODEL_REV=(\S+)/.exec(sh)[1]);
}

// Parakeet pins match voice-win/fetch-model.sh (revision and every file hash)
{
  const sh = src('voice-win/fetch-model.sh'), m = manifestFor(engine('parakeet'));
  const rev = /^REV=(\w+)$/m.exec(sh)?.[1];
  assert.ok(rev && m.files.every((f) => f.url.includes(`/resolve/${rev}/`)), 'revision differs from fetch-model.sh');
  const pins = Object.fromEntries([...sh.matchAll(/^\s+"(\S+) ([0-9a-f]{64})"$/gm)].map((x) => [x[1], x[2]]));
  assert.deepEqual(shas(m), pins);
}

// the Windows installer ships every helper and every engine's licence folder
{
  const conf = JSON.parse(src('tauri.windows.conf.json')).bundle;
  for (const e of ENGINES) {
    assert.ok(conf.externalBin.includes(`binaries/${e.helper}`), `${e.helper} missing from externalBin`);
    assert.ok(Object.values(conf.resources).includes(e.model.licence.bundled), `${e.id} licence not bundled`);
  }
  assert.ok(fs.readdirSync(new URL('../../src-tauri/voice-win/licenses/', import.meta.url)).length > 0, 'Parakeet licence files');
}

console.log('voice engine tests: passed');
