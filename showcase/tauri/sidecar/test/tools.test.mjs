// Tool schemas must be accepted by every provider (OpenAI strict mode rejects JSON Schema "format"). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-tools-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { createTools, isWinAppName, winInAppPlan } = await import('../tools.mjs');

const noop = () => {};
const { tools } = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '' });
assert.ok(tools.length > 5, 'tools built');
const formats = (node, at = '') => {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'format' && typeof v === 'string' ? [`${at} format "${v}"`] : formats(v, `${at}/${k}`)));
};
for (const t of tools) {
  const schema = t.rawInputSchema ?? z.toJSONSchema(t.parameters);
  assert.deepEqual(formats(schema), [], `${t.name} schema uses a format keyword`);
}
assert.ok(tools.some((t) => t.name === 'fetch_url'), 'fetch_url is checked');
console.log('tool schema tests: passed');

// Windows open: links (mailto: has no //) and paths go straight to Start-Process, only bare names to the app finder.
for (const t of ['mailto:a@b.com', 'ms-settings:display', 'https://x.com', 'C:\\x', '~/x']) assert.equal(isWinAppName(t), false, t);
assert.equal(isWinAppName('Spotify'), true);
console.log('windows open routing tests: passed');

// Windows "open X in <app>": a Start-menu shortcut gets the link as one quoted argument; other targets can't take one,
// so they error instead of silently opening the default browser.
const lnk = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk';
assert.deepEqual(winInAppPlan({ name: 'Google Chrome', appId: lnk, lnk: true }, 'https://youtube.com/?q="x"'), { target: lnk, arg: '"https://youtube.com/?q=%22x%22"' });
assert.deepEqual(winInAppPlan({ name: 'Google Chrome', appId: lnk, lnk: true }, 'C:\My Files\a.pdf'), { target: lnk, arg: '"C:\My Files\a.pdf"' });
for (const app of [{ name: 'Google Chrome', appId: 'Chrome' }, { name: 'Settings', appId: 'ms-settings:' }]) {
  const plan = winInAppPlan(app, 'https://youtube.com');
  assert.match(plan.error, /only in the default browser/, app.name);
  assert.equal(plan.target, undefined);
}
console.log('windows open-in-app plan tests: passed');
