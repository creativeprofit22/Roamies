// Every child process the sidecar starts must hide its console window on Windows. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALL = /(?<![.\w])(execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\(/g;
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/;

// The text of a call from its opening paren to the matching close.
function callText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

let sites = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/child_process/.test(src)) continue;
  assert.match(src, IMPORT, `${f}: import child_process with named imports so spawn sites can be checked`);
  const names = new Set(src.match(IMPORT)[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  for (const m of src.matchAll(CALL)) {
    if (!names.has(m[1])) continue;
    sites++;
    const line = src.slice(0, m.index).split('\n').length;
    // windowsHide: true must come last in its options object so a caller's options can't switch it off.
    assert.match(callText(src, m.index + m[1].length), /windowsHide:\s*true\s*\}/, `${f}:${line} ${m[1]} must pass { windowsHide: true } last`);
  }
}
assert.ok(sites >= 3, `found ${sites} spawn sites; the scan is broken`);

console.log(`spawn tests: passed (${sites} sites)`);
