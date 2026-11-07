import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every look the app offers has a drawing and its voice; the setup guide offers the same looks.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs'), guide = src('../../../onboarding/onboarding.js');
const looks = [...side.slice(side.indexOf('const LOOKS = ['), side.indexOf('];', side.indexOf('const LOOKS = ['))).matchAll(/\['(\w+)', '([^']+)', (null|'(\w+)')\]/g)];
assert.deepEqual(looks.map((m) => m[1]), ['classic', 'jarvis', 'anime', 'sarah', 'adrian']);
const voices = Object.fromEntries(looks.map((m) => [m[1], m[4] ?? null]));
assert.equal(voices.jarvis, 'e13fa398a7f445a685316a3de6089ce7');
assert.equal(voices.anime, 'd8f3b4c1199f4568a767ec54112d2b17');
assert.equal(voices.sarah, '933563129e564b19a115bedd57b7406a');
assert.equal(voices.adrian, 'bf322df2096a46f18c579d0baa36f41d');
for (const [, id, label] of looks) assert.ok(guide.includes(`['${id}', '${label}']`), `the setup guide offers ${label}`);

// The characters draw at every size without throwing, inside their area, and the sprites are well formed.
const warns = [];
globalThis.window = { Roamie: {} };
const warn = console.warn; console.warn = (m) => warns.push(m);
new Function(src('../../../roamies/people.js'))();
console.warn = warn;
assert.deepEqual(warns, [], 'every sprite row is half or whole width');
const P = window.Roamie.people;
const th = () => 0.5;
// ken: Ken Kai, on the About page (drawn the same way, though not a look you can pick).
for (const who of ['anime', 'sarah', 'adrian', 'ken']) for (const size of ['default', 'small', 'cursor']) for (const state of [{}, { mode: 'talk', voice: 0.9 }, { happy: 1 }, { open: 0 }, { dizzy: 1 }, { sleepy: 1 }, { act: 'hype', actA: 0.2 }, { act: 'upset', actA: 0.1 }]) {
  const cells = [];
  const k = { put: (x, y, l) => { assert.ok(Number.isInteger(x) && Number.isInteger(y) && l >= 0 && l <= 4, `${who} ${size} cell`); cells.push([x, y]); }, L: 4, th };
  const st = { t: 1, mode: null, voice: null, act: null, actA: 0, open: 1, look: [0.5, -0.3], vx: 0, sq: 0, wide: 0, dizzy: 0, happy: 0, sleepy: 0, mouth: null, brow: null, ...state };
  if (size === 'cursor') P[who].cursor(k, 50, 50, 46, 43, st); else P[who].body(k, 50, 50, size === 'small' ? 6.4 : 12.75, st);
  assert.ok(cells.length > 40, `${who} ${size} draws`);
  const span = Math.max(...cells.map(([x]) => x)) - Math.min(...cells.map(([x]) => x));
  assert.ok(span < (size === 'default' ? 40 : 24), `${who} ${size} stays its size (${span})`);
}
assert.ok(!looks.some((m) => m[1] === 'ken'), 'Ken is not a pickable look');
console.log('looks tests: passed');
