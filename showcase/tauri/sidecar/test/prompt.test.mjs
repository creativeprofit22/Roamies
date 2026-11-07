import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The system prompt is template literals in sidekick.mjs: an expression wrapped in a string (${"${x}"}) would reach
// the model as raw code instead of its value.
const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
const quoted = side.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$\{\s*["'`][^"'`]*\$\{/.test(l));
assert.deepEqual(quoted.map(([n]) => n), [], 'a ${…} inside a quoted string in a template literal is sent as text');
console.log('prompt tests: passed');
