import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecrets, runInput } from '../secrets.mjs';

// macOS: the helper gets the secret on stdin only, never in its arguments.
{
  const calls = [], kc = new Map();
  const exec = async (cmd, args, input = '') => {
    calls.push({ cmd, args, input });
    const [c, name] = args;
    if (c === 'secret-set') { kc.set(name, input); return { code: 0, stdout: '{"ok":true}' }; }
    if (c === 'secret-get') return { code: 0, stdout: JSON.stringify(kc.has(name) ? { ok: true, found: true, value: kc.get(name) } : { ok: true, found: false }) };
    if (c === 'secret-delete') { kc.delete(name); return { code: 0, stdout: '{"ok":true}' }; }
  };
  const s = createSecrets({ platform: 'darwin', hands: '/x/roamies-hands', exec });
  assert.equal(s.kind, 'keychain');
  assert.equal(await s.get('fish-audio'), null);
  await s.set('fish-audio', 'sk-fish-SECRET');
  assert.equal(await s.get('fish-audio'), 'sk-fish-SECRET');
  assert.ok(calls.every((c) => !c.args.join(' ').includes('SECRET')), 'never in argv');
  assert.equal(calls.find((c) => c.args[0] === 'secret-set').input, 'sk-fish-SECRET');
  await s.delete('fish-audio');
  assert.equal(await s.get('fish-audio'), null);
  await assert.rejects(s.get('../etc'), /bad secret name/);
  const broken = createSecrets({ platform: 'darwin', hands: '/x', exec: async () => ({ code: 1, stdout: '{"ok":false,"error":"keychain read failed (-25308)"}' }) });
  await assert.rejects(broken.get('fish-audio'), /-25308/);
  await assert.rejects(broken.set('fish-audio', 'k'), /keychain/);
  const garbage = createSecrets({ platform: 'darwin', hands: '/x', exec: async () => ({ code: -1, stdout: '' }) });
  await assert.rejects(garbage.set('fish-audio', 'k'), /keychain unavailable/, 'a missing helper is a failure, not a silent save');
}

// Windows: DPAPI through PowerShell, secret on stdin; only the sealed blob is written to disk.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const calls = [];
  const exec = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const script = args.at(-1);
    if (script.includes('::Protect(')) return { code: 0, stdout: `SEALED:${Buffer.from(input).toString('base64')}\r\n` };
    if (script.includes('::Unprotect(')) return { code: 0, stdout: Buffer.from(input.replace('SEALED:', ''), 'base64').toString() };
  };
  const s = createSecrets({ platform: 'win32', dataDir: dir, exec });
  assert.equal(s.kind, 'dpapi');
  await s.set('fish-audio', 'sk-fish-SECRET');
  const disk = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.ok(!disk.includes('sk-fish-SECRET') && disk.includes('SEALED:'), 'only the sealed blob on disk');
  assert.equal(await s.get('fish-audio'), 'sk-fish-SECRET');
  assert.ok(calls.every((c) => c.cmd === 'powershell.exe' && !c.args.join(' ').includes('SECRET')), 'never in argv');
  assert.ok(calls[0].args.at(-1).includes("'CurrentUser'"));
  await s.delete('fish-audio');
  assert.equal(await s.get('fish-audio'), null);
  const failing = createSecrets({ platform: 'win32', dataDir: dir, exec: async () => ({ code: 1, stdout: '' }) });
  await assert.rejects(failing.set('fish-audio', 'k'), /could not protect/);
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('"k"'), 'nothing saved in the clear when DPAPI fails');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Anywhere else (no safe store): refuses to save rather than writing plain text.
{
  const prev = process.env.ROAMIES_DATA_DIR; delete process.env.ROAMIES_DATA_DIR;
  const s = createSecrets({ platform: 'linux', dataDir: '/tmp' });
  assert.equal(s.kind, 'none');
  await assert.rejects(s.set('fish-audio', 'k'), /no safe place/);
  if (prev) process.env.ROAMIES_DATA_DIR = prev;
}

// runInput: stdin reaches the child; a missing command resolves with an error instead of throwing.
assert.equal((await runInput(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello')).stdout, 'hello');
assert.equal((await runInput('/no/such/binary', [])).code, -1);
console.log('secrets tests: passed');
