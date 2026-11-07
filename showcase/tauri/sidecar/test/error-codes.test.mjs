// Every error bubble in the sidecar carries a stable telemetry error code (say(text, 'concerned', { code })).
// Concerned-looking notices that aren't failures are listed here. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidekick.mjs'), 'utf8');
const NOT_ERRORS = [/I forgot \$\{n\} thing/, /Reminder: /];
const lines = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\bsay\(/.test(l) && /'concerned'/.test(l));
assert.ok(lines.length >= 10, 'found the error bubbles');
const missing = lines.filter(([, l]) => /'concerned'\s*\)/.test(l) && !NOT_ERRORS.some((re) => re.test(l)));
assert.deepEqual(missing.map(([n]) => n), [], `error bubbles without an error code at lines ${missing.map(([n]) => n)}`);
console.log('error code tests passed');
