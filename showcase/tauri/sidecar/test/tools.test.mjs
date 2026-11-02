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

// Seeing and pointing on each platform: Windows gets them with the helper, act_in_app stays macOS only.
{
  const { screenPrompt } = await import('../tools.mjs');
  const names = (platform, hands) => createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform, hands }).tools.map((t) => t.name);
  const has = (list, n) => list.includes(n);
  const win = names('win32', 'C:\roamies-hands.exe'), winBare = names('win32', ''), mac = names('darwin', '/x/hands');
  for (const n of ['list_windows', 'read_window', 'point_at']) { assert.ok(has(win, n), `win32 + helper offers ${n}`); assert.ok(!has(winBare, n), `win32 without helper hides ${n}`); assert.ok(has(mac, n), `mac offers ${n}`); }
  assert.ok(!has(win, 'act_in_app') && !has(winBare, 'act_in_app') && has(mac, 'act_in_app'), 'act_in_app is macOS only');
  const winTools = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: 'C:\roamies-hands.exe' }).tools;
  for (const t of winTools.filter((t) => ['take_screenshot', 'read_window', 'point_at', 'list_windows'].includes(t.name))) {
    assert.doesNotMatch(t.description, /act_in_app|click_text/, `${t.name} on Windows doesn't mention Mac-only tools`);
  }
  assert.match(winTools.find((t) => t.name === 'take_screenshot').description, /screen:<n>/);
  // Model input never reaches the helper's command line unchecked.
  const byName = (n) => winTools.find((t) => t.name === n);
  await assert.rejects(byName('point_at').execute({ target: '--fake-exe', text: 'Save', say: 'here' }, { toolCallId: 'a' }), /Blocked for safety/);
  await assert.rejects(byName('point_at').execute({ target: 'front', text: '--budget-ms', say: 'here' }, { toolCallId: 'a' }), /Blocked for safety/);
  await assert.rejects(byName('take_screenshot').execute({ target: 'KeePass' }, {}), /Blocked for safety/);
  await assert.rejects(byName('read_window').execute({ target: '-x' }), /Blocked for safety/);
  await assert.rejects(byName('read_window').execute({ target: 'screen:2' }), /not a screen/);
  // An app whose name starts with "screen" is still a window to read, not a monitor.
  await assert.rejects(byName('read_window').execute({ target: 'ScreenToGif' }), (e) => !/not a screen/.test(e.message));

  const p = screenPrompt({ platform: 'win32', hands: 'C:\roamies-hands.exe' });
  const all = Object.values(p).join(' ');
  assert.match(all, /point_at/);
  assert.doesNotMatch(all, /pointing[^.]*Mac only/i, 'win32 + helper: pointing is not called Mac only');
  assert.match(p.live, /Mac only/, 'still says what is Mac only (asking about an area, working other apps)');
  assert.ok(p.coords, 'coordinate rule is given');
  const bare = screenPrompt({ platform: 'win32', hands: '' });
  assert.match(bare.live, /pointing[^.]*Mac only/i, 'win32 without the helper: pointing is unavailable');
  assert.equal(bare.coords, '');
  assert.equal(screenPrompt({ platform: 'darwin', hands: '/x' }).live, '');
  console.log('platform tool and prompt tests: passed');
}
