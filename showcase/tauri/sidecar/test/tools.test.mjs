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

// Seeing, pointing and working other apps on each platform: Windows gets them all with the helper.
{
  const { screenPrompt } = await import('../tools.mjs');
  const names = (platform, hands) => createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform, hands }).tools.map((t) => t.name);
  const has = (list, n) => list.includes(n);
  const win = names('win32', 'C:\roamies-hands.exe'), winBare = names('win32', ''), mac = names('darwin', '/x/hands');
  for (const n of ['list_windows', 'read_window', 'point_at', 'act_in_app']) { assert.ok(has(win, n), `win32 + helper offers ${n}`); assert.ok(!has(winBare, n), `win32 without helper hides ${n}`); assert.ok(has(mac, n), `mac offers ${n}`); }
  const winTools = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: 'C:\roamies-hands.exe' }).tools;
  const act = winTools.find((t) => t.name === 'act_in_app').description;
  assert.match(act, /click_text/); assert.match(act, /click_at/); assert.match(act, /'ctrl\+l'/); assert.doesNotMatch(act, /cmd\+l/);
  const pointDesc = winTools.find((t) => t.name === 'point_at').description;
  assert.match(pointDesc, /Set click true/); assert.doesNotMatch(pointDesc, /isn't available/);
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
  assert.match(p.abilities, /act_in_app/, 'win32 + helper: working other apps is offered');
  assert.match(p.live, /act_in_app work/);
  assert.match(p.live, /area[^.]*Mac only/, 'asking about an area is still Mac only');
  assert.doesNotMatch(all, /working other apps[^.]*Mac only/i);
  assert.match(p.live, /administrator/, 'says admin apps cannot be worked');
  assert.ok(p.coords, 'coordinate rule is given');
  const bare = screenPrompt({ platform: 'win32', hands: '' });
  assert.match(bare.live, /pointing[^.]*Mac only/i, 'win32 without the helper: pointing is unavailable');
  assert.equal(bare.coords, '');
  assert.equal(screenPrompt({ platform: 'darwin', hands: '/x' }).live, '');
  console.log('platform tool and prompt tests: passed');
}

// Windows OCR fallback: a window with no controls still shows its recognised text, and the timing hook gets counts only.
{
  // The fake helper is node itself, run with a cwd where the verb names are scripts printing a canned reply.
  const dir = fs.mkdtempSync(path.join(TMP, 'fake-hands-'));
  const win = { id: 7, app: 'Game', title: 'Level 1', bounds: [0, 0, 800, 600] };
  const ocrUi = { ok: true, window: win, controls: [], texts: ['Start game', 'Options'], elsewhere: [], note: 'This window shares no controls.', source: 'ocr', ocr: [{ text: 'Start game' }, { text: 'Options' }], ocrMs: 42, ocrLang: 'en-US' };
  fs.writeFileSync(path.join(dir, 'ui'), `console.log(${JSON.stringify(JSON.stringify(ocrUi))})`);
  fs.writeFileSync(path.join(dir, 'windows'), `console.log(${JSON.stringify(JSON.stringify({ ok: true, windows: [win] }))})`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const timings = [];
    const t = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: process.execPath, onHandsTiming: (x) => timings.push(x) }).tools;
    const out = await t.find((x) => x.name === 'read_window').execute({ target: 'front' });
    assert.match(out, /Text on screen: Start game \| Options/);
    assert.match(out, /text recognition/);
    assert.match(out, /shares no controls/);
    assert.deepEqual(timings, [{ verb: 'ui', ms: 42, lines: 2, lang: 'en-US' }]);
    // A plain UIA reply reports no OCR time and gets no recognition caveat.
    fs.writeFileSync(path.join(dir, 'ui'), `console.log(${JSON.stringify(JSON.stringify({ ...ocrUi, source: 'uia', ocr: undefined, ocrMs: undefined, ocrLang: undefined, texts: [] }))})`);
    const plain = await t.find((x) => x.name === 'read_window').execute({ target: 'front' });
    assert.doesNotMatch(plain, /text recognition|Text on screen/);
    assert.equal(timings.length, 1);
    // Controls but none named and no OCR language: the helper's note still reaches the model.
    const noOcr = 'Windows has no text recognition language installed, so only the text this app shares is listed.';
    fs.writeFileSync(path.join(dir, 'ui'), `console.log(${JSON.stringify(JSON.stringify({ ...ocrUi, source: 'uia', ocr: undefined, ocrMs: undefined, ocrLang: undefined, texts: [], controls: [{ id: 1, role: 'button', label: '' }], note: noOcr }))})`);
    const unlabeled = await t.find((x) => x.name === 'read_window').execute({ target: 'front' });
    assert.ok(unlabeled.includes(noOcr), unlabeled);
    // point_at: an OCR word match inside a long line is used (its bounds are the words); a UIA one is not.
    const line = 'Press Escape at any time to open Options and change the difficulty level';
    const findReply = (source) => fs.writeFileSync(path.join(dir, 'find-text'), `console.log(${JSON.stringify(JSON.stringify({ ok: true, matches: [{ source, match: 'word', text: line, bounds: [300, 40, 60, 18] }] }))})`);
    let pointed;
    const made = createTools({ allowActions: () => false, ui: (m) => { if (m.e?.type === 'point') { pointed = m.e; made.pointWaits.get(m.e.id)?.(); } }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: process.execPath });
    const pointAt = made.tools.find((x) => x.name === 'point_at');
    findReply('ocr');
    await pointAt.execute({ target: 'front', text: 'Options', say: 'here' }, { toolCallId: 'ocr1' });
    assert.deepEqual(pointed.rect, [300, 40, 60, 18]);
    findReply('uia');
    await assert.rejects(pointAt.execute({ target: 'front', text: 'Options', say: 'here' }, { toolCallId: 'uia1' }), /No button, label or heading reads/);
  } finally { process.chdir(cwd); }
  console.log('windows OCR read_window tests: passed');
}

// Numbered marks: a window shot gets the window's controls drawn as numbers, and point_at mark uses the control's rect.
{
  const dir = fs.mkdtempSync(path.join(TMP, 'fake-marks-'));
  const win = { id: 9, app: 'Notepad', title: 'a.txt', bounds: [100, 50, 800, 600] };
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const reply = (v) => `console.log(${JSON.stringify(JSON.stringify(v))})`;
  // capture writes a stand-in image and reports it was sent at half size (400×300).
  script('capture', `require('fs').writeFileSync(process.argv[2], 'img'); ${reply({ ok: true, window: win, sent: [400, 300], monitors: [{ bounds: [0, 0, 1920, 1080], scale: 1 }] })}`);
  script('locate', reply({ ok: true, window: win }));
  const controls = [
    { id: 1, role: 'button', label: 'Save', bounds: [700, 60, 80, 24] },
    { id: 2, role: 'edit', label: '', bounds: [110, 100, 780, 500] },
    { id: 3, role: 'button', label: 'Hidden', bounds: [120, 900, 80, 24], offscreen: true },
  ];
  const setUi = (v) => script('ui', reply(v));
  setUi({ ok: true, window: win, controls, texts: [], source: 'uia' });
  // image copies the shot and keeps the marks it was given, so the test can check them.
  script('image', `const fs = require('fs'); const a = process.argv; fs.copyFileSync(a[2], a[3]); fs.writeFileSync('drawn.json', fs.readFileSync(a[a.indexOf('--marks') + 1])); ${reply({ ok: true, unit: 'px', sent: [400, 300] })}`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    let pointed; const timings = [];
    const made = createTools({ allowActions: () => false, ui: (m) => { if (m.e?.type === 'point') { pointed = m.e; made.pointWaits.get(m.e.id)?.(); } }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: process.execPath, onPointing: (x) => timings.push(x) });
    const shot = made.tools.find((x) => x.name === 'take_screenshot'), pointAt = made.tools.find((x) => x.name === 'point_at');
    const out = await shot.execute({ target: 'window:9' }, {});
    const text = out.content[0].text;
    assert.match(text, /Numbered marks on the image.*1 button "Save", 2 edit/);
    assert.doesNotMatch(text, /Hidden/, 'offscreen controls get no mark');
    // Marks reach the helper in sent-image pixels (half the screen size, offset by the window).
    assert.deepEqual(JSON.parse(fs.readFileSync('drawn.json', 'utf8')), [{ n: 1, rect: [300, 5, 40, 12] }, { n: 2, rect: [5, 25, 390, 250] }]);
    await pointAt.execute({ target: 'front', mark: 1, say: 'here' }, { toolCallId: 'm1' });
    assert.deepEqual(timings.map(({ kind, marks, source, path: p }) => [kind, marks ?? p, source]), [['marks', 2, 'uia'], ['locate', 'mark', undefined]]);
    assert.deepEqual(pointed.rect, [700, 60, 80, 24]);
    assert.equal(pointed.label, 'Save');
    await assert.rejects(pointAt.execute({ target: 'front', mark: 7, say: 'here' }, { toolCallId: 'm2' }), /marks 1–2/);
    // OCR window: its lines become the marks.
    setUi({ ok: true, window: win, controls: [], texts: ['Start'], source: 'ocr', ocr: [{ text: 'Start', bounds: [200, 200, 60, 20] }] });
    assert.match((await shot.execute({ target: 'window:9' }, {})).content[0].text, /1 text "Start"/);
    // A ui reply for another window (or none) means no marks, and mark is refused.
    setUi({ ok: true, window: { ...win, id: 10 }, controls, texts: [] });
    assert.doesNotMatch((await shot.execute({ target: 'front' }, {})).content[0].text, /Numbered marks/);
    await assert.rejects(pointAt.execute({ target: 'front', mark: 1, say: 'here' }, { toolCallId: 'm3' }), /no numbered marks/);
    // A whole-screen shot never asks for controls.
    fs.rmSync('ui');
    fs.rmSync('drawn.json');
    assert.doesNotMatch((await shot.execute({ target: 'screen' }, {})).content[0].text, /Numbered marks/);
    assert.ok(!fs.existsSync('drawn.json'));
  } finally { process.chdir(cwd); }
  console.log('numbered marks tests: passed');
}

// Crop-and-refine: a small box gets one closer look (native recapture, cropped and upscaled), the answer maps back.
{
  const { POINTING } = await import('../pointing.mjs');
  assert.equal(POINTING.refine, false, 'refine is off by default (docs/pointing.md)');
  POINTING.refine = true;
  const dir = fs.mkdtempSync(path.join(TMP, 'fake-refine-'));
  const win = { id: 9, app: 'Notepad', title: 'a.txt', bounds: [100, 50, 800, 600] };
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const reply = (v) => `console.log(${JSON.stringify(JSON.stringify(v))})`;
  // With --fit the shot is sent at half size (400×300); without it, at native size (800×600).
  script('capture', `require('fs').writeFileSync(process.argv[2], 'img'); const fit = process.argv.includes('--fit'); console.log(JSON.stringify({ ok: true, window: ${JSON.stringify(win)}, sent: fit ? [400, 300] : [800, 600], monitors: [{ bounds: [0, 0, 1920, 1080], scale: 1 }] }))`);
  script('locate', reply({ ok: true, window: win }));
  script('ui', reply({ ok: true, window: win, controls: [], texts: [] }));
  script('image', `const fs = require('fs'); const a = process.argv; fs.copyFileSync(a[2], a[3]); fs.appendFileSync('image-args.txt', a.slice(4).join(' ') + String.fromCharCode(10)); ${reply({ ok: true, unit: 'px', sent: [640, 640] })}`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const points = [], timings = [];
    const made = createTools({ allowActions: () => false, ui: (m) => { if (m.e?.type === 'point') { points.push(m.e); made.pointWaits.get(m.e.id)?.(); } }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '', platform: 'win32', hands: process.execPath, onPointing: (x) => timings.push(x) });
    const shot = made.tools.find((x) => x.name === 'take_screenshot'), pointAt = made.tools.find((x) => x.name === 'point_at');
    await shot.execute({ target: 'window:9' }, {});
    // A big box points straight away.
    await pointAt.execute({ target: 'front', box: [0, 0, 200, 150], say: 'here' }, { toolCallId: 'r0' });
    assert.deepEqual(points.pop().rect, [100, 50, 400, 300]);
    // A 40×12 box: no point yet, a 640×640 crop of native pixels [480, 0, 320, 320] comes back instead.
    const look = await pointAt.execute({ target: 'front', box: [300, 5, 340, 17], say: 'here' }, { toolCallId: 'r1' });
    assert.equal(points.length, 0);
    assert.match(look.content[0].text, /closer look, a 640×640 px crop .*2× zoom/);
    assert.equal(look.content[1].type, 'image');
    assert.equal(fs.readFileSync('image-args.txt', 'utf8').trim(), '--crop 480,0,320,320 --size 640,640');
    // The second answer is in crop pixels (0.5 screen px each, from the crop's origin) and points, even when small.
    await pointAt.execute({ target: 'front', box: [240, 20, 400, 68], say: 'here' }, { toolCallId: 'r2' });
    assert.deepEqual(points.pop().rect, [700, 60, 80, 24]);
    await pointAt.execute({ target: 'front', box: [240, 20, 250, 30], say: 'here' }, { toolCallId: 'r3' });
    assert.deepEqual(points.pop().rect, [700, 60, 5, 5]);
    assert.equal(fs.readFileSync('image-args.txt', 'utf8').trim().split('\n').length, 1, 'never a second refine');
    // Telemetry: the marks read per window shot, one crop, then how each point was found (refine_ms only for refine).
    assert.deepEqual(timings.map((t) => t.kind === 'locate' ? t.path : t.kind), ['marks', 'box', 'crop', 'refine', 'refine']);
    assert.equal(timings[0].marks, 0);
    assert.equal(timings[2].upscale, 2);
    assert.ok(timings[3].refineMs >= 0 && timings[2].ms >= 0);
    assert.equal(timings[1].refineMs, undefined);
    // If the helper can't crop, the small box is pointed at as given.
    await shot.execute({ target: 'window:9' }, {});
    script('image', `console.log(JSON.stringify({ ok: false, code: 'image_failed', error: 'nope' })); process.exit(1)`);
    await pointAt.execute({ target: 'front', box: [300, 5, 340, 17], say: 'here' }, { toolCallId: 'r4' });
    assert.deepEqual(points.pop().rect, [700, 60, 80, 24]);
  } finally { process.chdir(cwd); }
  POINTING.refine = false;
  console.log('crop-and-refine tests: passed');
}

// Working other apps on Windows: the plan reaches the helper, risky clicks ask first, telemetry gets kinds and codes, never text.
{
  const dir = fs.mkdtempSync(path.join(TMP, 'fake-act-'));
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), body);
  const win = { id: 4, app: 'msedge', title: 'Form' };
  // act saves the plan it was given and prints the reply in act-reply.json.
  script('act', `const fs = require('fs'); fs.writeFileSync('plan.json', process.argv[2]); console.log(fs.readFileSync('act-reply.json', 'utf8'))`);
  const actReply = (v) => fs.writeFileSync(path.join(dir, 'act-reply.json'), JSON.stringify(v));
  const ran = () => { const f = path.join(dir, 'plan.json'); if (!fs.existsSync(f)) return null; const v = JSON.parse(fs.readFileSync(f, 'utf8')); fs.rmSync(f); return v; };
  script('find-text', `console.log(${JSON.stringify(JSON.stringify({ ok: true, matches: [{ source: 'uia', match: 'word', text: 'Delete', bounds: [300, 40, 60, 18] }] }))})`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    let answer = 'no'; const acts = [], asks = [];
    const made = createTools({ allowActions: () => true, ui: (m) => { if (m.e?.type === 'point') made.pointWaits.get(m.e.id)?.(); }, ask: async (q) => { asks.push(q.placeholder); return answer; }, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Ken', platform: 'win32', hands: process.execPath, onAct: (x) => acts.push(x) });
    const act = made.tools.find((t) => t.name === 'act_in_app'), pointAt = made.tools.find((t) => t.name === 'point_at');

    actReply({ ok: true, window: win, done: ['filled Email', 'clicked Submit'] });
    const out = await act.execute({ target: 'front', steps: [{ do: 'fill', field: 'Email', text: 'ken@example.com' }, { do: 'click_text', text: 'Submit' }] }, { toolCallId: 'a1' });
    assert.match(out, /filled Email, clicked Submit/);
    assert.deepEqual(ran().steps.map((st) => st.do), ['fill', 'click_text']);
    assert.equal(asks.length, 0, 'Submit needs no yes');
    assert.deepEqual({ ...acts[0], ms: 0 }, { via: 'act_in_app', kinds: ['fill', 'click_text'], steps: 2, ms: 0, done: 2, outcome: 'ok', code: null, failedStep: null });
    assert.doesNotMatch(JSON.stringify(acts), /ken@example/, 'typed text never reaches telemetry');

    // Delete asks; "no" stops before the helper runs anything.
    acts.length = 0;
    await assert.rejects(act.execute({ steps: [{ do: 'click_text', text: 'Delete' }] }, { toolCallId: 'a2' }), /Ken said no/);
    assert.equal(ran(), null, 'nothing ran after a no');
    assert.match(asks.pop(), /Click "Delete"/);
    assert.equal(acts[0].outcome, 'cancelled'); assert.equal(acts[0].code, 'user_declined');
    answer = 'y';
    actReply({ ok: true, window: win, done: ['clicked Delete'] });
    await act.execute({ steps: [{ do: 'click_text', text: 'Delete' }] }, { toolCallId: 'a3' });
    assert.equal(ran().steps[0].confirmed, true, 'a yes is sent as confirmed');

    // Hands-off apps are refused before the helper is asked.
    await assert.rejects(act.execute({ target: 'KeePass', steps: [{ do: 'type', text: 'x' }] }, { toolCallId: 'a4' }), /Blocked for safety/);
    assert.equal(ran(), null);

    // Helper refusals reach the model as given, with their code in telemetry.
    acts.length = 0;
    const admin = 'Notepad is running as administrator, so Roamies cannot work it. Ask the user to do this step.';
    actReply({ ok: false, code: 'access_denied', error: admin });
    await assert.rejects(act.execute({ target: 'Notepad', steps: [{ do: 'type', text: 'hello' }] }, { toolCallId: 'a5' }), (e) => e.message === admin);
    assert.equal(acts[0].outcome, 'error'); assert.equal(acts[0].code, 'access_denied');
    actReply({ ok: false, code: 'not_editable', error: 'Step 2: that field is read-only.' });
    acts.length = 0; ran();
    await assert.rejects(act.execute({ steps: [{ do: 'key', key: 'tab' }, { do: 'type', text: 'x' }] }, { toolCallId: 'a6' }), /read-only/);
    assert.equal(acts[0].failedStep, 2); assert.equal(acts[0].done, 1);

    // point_at click on a risky label asks too, and sends the yes.
    asks.length = 0; answer = 'y';
    actReply({ ok: true, window: win, done: ['clicked'] });
    assert.match(await pointAt.execute({ target: 'front', text: 'Delete', say: 'here', click: true }, { toolCallId: 'p1' }), /clicked it/);
    assert.match(asks[0], /Click "Delete"/);
    const st = ran().steps[0];
    assert.equal(st.do, 'click_at'); assert.equal(st.confirmed, true);
    answer = 'no';
    await assert.rejects(pointAt.execute({ target: 'front', text: 'Delete', say: 'here', click: true }, { toolCallId: 'p2' }), /said no/);
    assert.equal(ran(), null);
  } finally { process.chdir(cwd); }
  console.log('windows act tests: passed');
}

{
  const { canSnap, snapArgs } = await import('../tools.mjs');
  assert.equal(canSnap('darwin', ''), true);
  assert.equal(canSnap('win32', 'C:\roamies-hands.exe'), true);
  assert.equal(canSnap('win32', ''), false);
  assert.equal(canSnap('linux', '/x'), false);
  assert.deepEqual(snapArgs('/tmp/a.png', 'darwin', { maxEdge: 1568, maxTokens: 1568 }), ['select', '/tmp/a.png']);
  assert.deepEqual(snapArgs('C:\t\a.png', 'win32', { maxEdge: 2000, maxTokens: 1568 }), ['select', 'C:\t\a.png', '--fit', '2000x1568']);
  assert.deepEqual(snapArgs('a.png', 'win32', { maxEdge: 1024, maxTokens: Infinity }), ['select', 'a.png', '--fit', '1024x0']);
  console.log('snap args tests: passed');
}
