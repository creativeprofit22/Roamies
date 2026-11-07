// The macOS tools against a fake hands helper: act_in_app drops read-only steps, screenshots use the helper's own
// resize, and an app that isn't installed gives a plain answer. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') { console.log('hands tests: skipped (macOS only)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hands-test-'));
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'TextEdit', title: 'notes.txt', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') { const p = JSON.parse(a[1]); o = p.app === 'NoSuchAppRoamiesTest' ? { ok: false, error: 'No matching window is open.' } : { ok: true, done: p.steps.map((s) => s.do), window: win }; }
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`, { mode: 0o755 });
process.env.ROAMIES_HANDS = fake;
const { createTools } = await import('../tools.mjs');
const noop = async () => {};
const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const tool = (n) => tools.find((t) => t.name === n);
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ctx = { toolCallId: 't1' };

// read_window / take_screenshot inside act_in_app steps are dropped, not a failed call.
fs.writeFileSync(log, '');
const r = await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'cmd+end' }, { do: 'read_window' }, { do: 'type', text: 'hi' }] }, ctx);
assert.match(r, /key, type/);
const act = calls().find((c) => c[0] === 'act');
assert.deepEqual(JSON.parse(act[1]).steps.map((s) => s.do), ['key', 'type']);
assert.ok(!calls().some((c) => c[0] === 'capture'), 'no window pictures taken while it works in an app');
await assert.rejects(tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'read_window' }] }, ctx), /only read the window/);

// Screenshots ask the helper to shrink to 1568 px and use the size it reports.
fs.writeFileSync(log, '');
const shot = await tool('take_screenshot').execute({ target: 'TextEdit' }, ctx);
assert.match(shot.content[0].text, /800×600 px/);
assert.ok(calls().some((c) => c[0] === 'capture' && c[3] === '1568'));
// Shot at once with nothing shown on screen: no window lookup first, no preview copy for an animation.
assert.ok(!calls().some((c) => c[0] === 'locate'), 'no locate round trip before the shot');
assert.equal(calls().find((c) => c[0] === 'capture').length, 4, 'no preview thumbnail requested');

// An app that isn't installed: one clear answer instead of "No matching window".
await assert.rejects(tool('act_in_app').execute({ target: 'NoSuchAppRoamiesTest', steps: [{ do: 'key', key: 'return' }] }, ctx), /no app called "NoSuchAppRoamiesTest"/);
await assert.rejects(tool('open').execute({ target: 'NoSuchAppRoamiesTest' }, ctx), /no app called "NoSuchAppRoamiesTest"/);

// A bare web address opens as a link (in the app asked for), not as an app called "example.com".
const opened = await tool('open').execute({ target: 'example.invalid-tld-roamies.test', app: 'NoSuchAppRoamiesTest' }, ctx).catch((e) => String(e.message));
assert.match(opened, /no app called "NoSuchAppRoamiesTest"/, 'treated as a link opened in the named app');

fs.rmSync(dir, { recursive: true, force: true });
console.log('hands tests: passed');

// Live "where am I" line: app, window title and page, without query strings; '' when nothing is known.
{
  const { frontLine } = await import('../tools.mjs');
  const l = frontLine({ app: 'Google Chrome', title: 'Inbox (3) - me@example.com - Gmail', url: 'https://mail.google.com/mail/u/0/?tab=rm&token=SECRET#inbox' }, 'Ken');
  assert.match(l, /Right now Ken is in Google Chrome — "Inbox \(3\) - me@example.com - Gmail" \(mail\.google\.com\/mail\/u\/0\)/);
  assert.match(l, /overrides any app or page from earlier/);
  assert.ok(!/SECRET|tab=/.test(l), 'query string dropped');
  assert.equal(frontLine({ app: 'Notes', url: 'file:///Users/x/secret.txt' }), '- Right now The user is in Notes. This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.');
  assert.equal(frontLine({}), '');
  assert.equal(frontLine(null), '');
  console.log('front line tests: passed');
}
