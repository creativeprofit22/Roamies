// Telemetry never leaves the machine: no telemetry module may use a network API. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MODULES = [
  'showcase/tauri/sidecar/telemetry.mjs',
  'showcase/tauri/src-tauri/src/telemetry.rs',
  'showcase/tauri/src-tauri/voice-core/src/telemetry.rs',
  'showcase/roamies/telemetry.js',
];
const BANNED = [
  /['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns)['"]/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/,
  /std::net/, /TcpStream/, /UdpSocket/, /reqwest/, /hyper::/, /ureq/, /opentelemetry/,
];

let checked = 0;
for (const rel of MODULES) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) continue; // modules land layer by layer; each is checked once it exists
  const src = fs.readFileSync(f, 'utf8');
  for (const re of BANNED) assert.doesNotMatch(src, re, `${rel} must not use the network (${re})`);
  checked++;
}
assert.equal(checked, MODULES.length, 'every telemetry module exists and is checked');
console.log(`telemetry offline check passed (${checked} modules)`);
