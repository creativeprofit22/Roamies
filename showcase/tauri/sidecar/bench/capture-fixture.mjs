// Saves one pointing-benchmark fixture from a live window: node bench/capture-fixture.mjs <name> <window:id> [dir]
// Writes <dir>/<name>/shot.jpg (native pixels, no resize) and ui.json (the helper's ui reply). cases.json is written by hand.
// Stock apps only: check the image and ui.json for names, accounts and file paths before committing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperPath } from './pointing.bench.mjs';

const [name, target, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'pointing')] = process.argv.slice(2);
if (!name || !target) { console.error('usage: node bench/capture-fixture.mjs <name> <window:id> [dir]'); process.exit(2); }
const hands = helperPath();
const out = path.join(dir, name);
fs.mkdirSync(out, { recursive: true });
const call = (...args) => JSON.parse(execFileSync(hands, args, { encoding: 'utf8' }).trim().split('\n').pop());
const ui = call('ui', target, '--budget-ms', '4000');
const shot = call('capture', path.join(out, 'shot.jpg'), target);
if (!shot.ok || !ui.ok) { console.error(JSON.stringify({ shot, ui })); process.exit(1); }
const bounds = shot.window?.bounds ?? shot.bounds;
fs.writeFileSync(path.join(out, 'ui.json'), JSON.stringify({ ...ui, shot: { bounds, native: shot.sent } }, null, 1));
console.log(`${name}: ${shot.sent?.join('×')} px, ${ui.controls?.length ?? 0} controls, ${ui.ocr?.length ?? 0} OCR lines`);
