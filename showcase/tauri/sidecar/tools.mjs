// The agent's tools: screen capture, reading and working other apps (macOS "hands" helper), files, commands,
// web pages and memory. Every file, command, URL and open goes through safety.mjs first.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { monitorFor, parseSipsSize, parseWinShot, readProblem, rematch, resizedSize, sameBounds, shotBox, shotMap, shotPixel, shotProblem } from './pointing.mjs';
import { performance } from 'node:perf_hooks';
import * as safety from './safety.mjs';
import { ASK, BLOCK, SAFE, isYes } from './safety.mjs';
import { LIST_SCRIPT, closest, createAppFinder, launchTarget, parseApps } from './winapps.mjs';
import { addCommitment, addFact, forgetFact, parseDue, updateCommitment } from './store.mjs';

const HOME = os.homedir();
export const expand = (p) => path.resolve(String(p).replace(/^~(?=$|\/|\\)/, HOME));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters)` : s);
// windowsHide: no console window flashing up for each command or screenshot on Windows.
export const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 60_000, ...opts, windowsHide: true }, (err, stdout, stderr) => res({ err, stdout: String(stdout), stderr: String(stderr) })));
// Windows "open": Start-Process gets the target through an environment variable, so nothing in it is ever
// parsed as a command (cmd's start split URLs at "&", and quotes in names broke it).
// With arg (one already-quoted argument, e.g. a link for a browser shortcut) it goes the same way, in ROAMIES_ARG.
export const winOpen = (target, arg) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath $env:ROAMIES_OPEN${arg ? ' -ArgumentList $env:ROAMIES_ARG' : ''}`], { env: { ...process.env, ROAMIES_OPEN: target, ...(arg ? { ROAMIES_ARG: arg } : {}) } });
// Start-menu launch targets (shell:AppsFolder links, shortcuts, ms-settings:) go the same safe way.
export const winLaunch = (target) => winOpen(target);
// "Open this link in Chrome" on Windows: only a Start-menu shortcut (.lnk) can be handed the link as an argument;
// shell:AppsFolder and ms-settings: targets can't take one, so those get a plain error instead of a silent default.
export function winInAppPlan(app, file) {
  if (!app?.lnk) return { error: `I can't open links or files in ${app?.name ?? 'that app'} on Windows, only in the default browser or app. Ask again without naming an app.` };
  // Quoted so a path with spaces stays one argument; Windows paths can't hold ", and in a link it's %22.
  return { target: launchTarget(app), arg: `"${String(file).replace(/"/g, '%22')}"` };
}
const notFound = (t, apps) => {
  const near = closest(t, apps);
  return new Error(`Couldn't find an app called "${t}". ${near.length ? `Closest Start-menu apps: ${near.join(', ')}.` : 'No similar apps found.'}`);
};
// A bare Start-menu app name (not a link like mailto:/ms-settings:/https:, nor a path), so it goes to the app finder.
export const isWinAppName = (t) => {
  t = String(t).trim();
  const isPath = /^[~/.]/.test(t) || /^[a-z]:\\/i.test(t);
  return !isPath && !/^[a-z][a-z0-9+.-]*:/i.test(t);
};
// Windows Start-menu apps, listed once per sidecar session (PowerShell takes about a second) and re-listed on a miss.
// Listing errors (timeout, no PowerShell, blocked by policy) throw, so they aren't mistaken for "not installed".
const appFinder = createAppFinder({
  list: async () => {
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64')], { timeout: 30_000 });
    const apps = parseApps(r.stdout);
    if (r.err && !apps.length) throw Object.assign(new Error('Start-menu app list failed'), { detail: winSaid(r.stderr) });
    return apps;
  },
});
// Windows error text comes in the system language, so it's only ever a short detail after an English message.
const winSaid = (stderr) => { const d = String(stderr ?? '').trim().split(/\r?\n/)[0].slice(0, 120); return d ? ` (Windows said: ${d})` : ''; };
const actionsOff = `File edits and commands are switched off. Tell the user to turn on "Allow File Edits & Commands" in the ${process.platform === 'darwin' ? 'menu bar' : 'system tray'} menu if they want this.`;

// "hands": the bundled screen helper (macOS: hands/main.swift; Windows x64: hands-win, see docs/hands.md).
const HANDS = process.env.ROAMIES_HANDS || '';
// What the model is told about seeing and pointing on each platform (sidekick.mjs puts these in its prompt).
export function screenPrompt({ platform = process.platform, hands = HANDS } = {}) {
  const mac = platform === 'darwin', winSees = platform === 'win32' && !!hands;
  return {
    abilities: mac ? ' and work other apps for them: fill in forms, type, click buttons (read_window, then act_in_app)'
      : winSees ? ', and list and read app windows and point at things on screen (list_windows, read_window, point_at)' : '',
    coords: mac || winSees ? 'Screenshot coordinates are always absolute pixels of your latest screenshot, never a 0–1000 scale; for anything bigger than an icon, give point_at a box.\n' : '',
    howTo: mac ? '"how do I add a layer mask"' : 'a how-to',
    live: mac ? ''
      : winSees ? ' take_screenshot works here: the whole screen, one monitor (screen:2, list_windows lists them) or one app window, so look when asked what is on screen. list_windows, read_window and point_at work here too, so when asked where something is, point at it. Asking about an area and working other apps (act_in_app, clicking or typing for them) are Mac only for now; point and tell them what to click.'
      : ' take_screenshot works here (it always captures the whole screen), so look when asked what is on screen. Asking about an area, reading app windows, pointing and working other apps are Mac only for now.',
  };
}
const STALE_ID = 'The page changed since read_window, so that id is out of date. Call read_window again and use the new ids.';
// The text point_at should use: a whole label or heading (exact or word match), not the words buried in a
// paragraph, which is what a guessed word like "version" or "settings" tends to hit.
function pickTextMatch(matches, find) {
  const q = String(find).trim();
  return (matches ?? []).find((m) => m.match !== 'partial' && m.text.trim().length <= Math.max(40, q.length * 3)) ?? null;
}
// read_window and act_in_app output: visible controls first, then up to 15 scrolled out of view.
function controlList(controls, texts = [], canAct = true) {
  const vis = controls.filter((c) => !c.offscreen), off = controls.filter((c) => c.offscreen).slice(0, 15);
  const line = (c) => `${c.id} ${c.role}${c.label ? ` "${c.label}"` : ''}${c.value ? ` = "${c.value}"` : ''}${c.focused ? ' (focused)' : ''}`;
  const labels = new Set(controls.map((c) => c.label));
  const words = texts.filter((t) => !labels.has(t));
  return vis.map(line).join('\n')
    + (off.length ? `\nFurther down (${canAct ? 'point_at or click_text scrolls' : 'point_at with their text scrolls'} to them): ${off.map((c) => `${c.id} "${c.label || c.role}"`).join(', ')}` : '')
    + (words.length ? `\nText on screen: ${words.join(' | ')}` : '');
}
// A safety verdict: blocked throws with the reason, otherwise returns the checked absolute path.
const allowed = (v) => { if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`); return v.path; };
// Resizes an image to exactly the size the model processes (Anthropic's edge + visual-token rule for Claude,
// see imageLimits in pointing.mjs), never enlarging small ones, so its pixel coordinates map 1:1. Returns the sent [w, h].
export async function fitImage(file, { maxEdge = 1568, maxTokens = 1568 } = {}) {
  const size = async () => parseSipsSize((await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])).stdout);
  const s = await size();
  if (!s) return s;
  const [w, h] = resizedSize(s[0], s[1], maxEdge, maxTokens);
  if (w === s[0] && h === s[1]) return s;
  await run('sips', ['-z', String(h), String(w), file]); // -z takes height, then width
  return size();
}
export const imageBlock = async (file, mediaType) => {
  const data = (await fs.readFile(file)).toString('base64');
  fs.unlink(file).catch(() => {});
  return { type: 'image', mediaType, data };
};

// deps: what the tools need from the app (settings, overlay, input bubble, menu). State lives per instance.
export function createTools({ allowActions, ui, ask, openUrl, onCommitments, showList, fmtWhen, commitmentsText, userName, onCheck = null, imageLimits = () => ({ maxEdge: 1568, maxTokens: 1568 }), platform = process.platform, hands: handsBin = HANDS }) {
  const MAC = platform === 'darwin', WIN = platform === 'win32';
  // Seeing and pointing need the helper; working other apps (act_in_app, clicks) is macOS only for now.
  const CAN_SEE = MAC || (WIN && !!handsBin), CAN_ACT = MAC;
  const pxUnit = WIN ? { unit: 'px' } : {}; // Windows rects are physical pixels; the host converts them per monitor
  // Each safety check reports its verdict and time (telemetry agent.safety); the checks themselves are unchanged.
  const timed = (check, fn) => (...a) => {
    const t0 = performance.now(), v = fn(...a);
    onCheck?.({ check, level: typeof v === 'boolean' ? (v ? ASK : SAFE) : v.level, ms: performance.now() - t0 });
    return v;
  };
  const checkRead = timed('read', safety.checkRead), checkWrite = timed('write', safety.checkWrite), checkUrl = timed('url', safety.checkUrl);
  const checkOpen = timed('open', safety.checkOpen), classifyCommand = timed('command', safety.classifyCommand), isRiskyClick = timed('click', safety.isRiskyClick);
  const checkTarget = timed('screen_target', safety.checkScreenTarget), checkFind = timed('find_text', safety.checkFindText);
  // Model-written targets and text reach the helper's command line, so each is checked first (no "-flags", no hands-off apps).
  const screenTarget = (t) => { const v = checkTarget(t); if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`); return String(t).trim(); };
  const findText = (t) => { const v = checkFind(t); if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`); return t; };
  // A target as the helper takes it: bare app names become app:<name>.
  const spec = (t) => (/^(front|screen|screen:\d+|window:\d+|app:.*)$/i.test(t) ? t : `app:${t}`);
  let axNudged = 0;
  const pointWaits = new Map(); // point_at call id → resolve, settled when the overlay has shown the step
  let lastShot = null; // how the latest screenshot's pixels map to screen points (see pointing.mjs)
  let winScreen = null; // Windows: the DPI-aware primary screen size the last capture saw, [w, h]
  let lastRead = null; // { win, controls } from the latest read_window, to catch ids that went stale
  // Bumped for every new request: what was seen before it may be another page, tab or app by now.
  let turn = 0;
  async function checkShot() {
    const problem = shotProblem(lastShot, turn);
    if (problem) throw new Error(problem);
    if (lastShot.win != null) {
      const now = await hands('locate', `window:${lastShot.win}`).catch(() => null);
      if (!sameBounds(now?.window?.bounds, lastShot.bounds)) throw new Error('That window moved or closed since the screenshot. Take a new screenshot first.');
    }
  }
  async function shotPoint(x, y) { await checkShot(); return shotPixel(lastShot, x, y); }
  async function shotRect(box) { await checkShot(); return shotBox(lastShot, box); }
  // The control that read_window listed at this id, wherever it is now.
  async function liveControls(spec) {
    const fresh = await hands('ui', spec);
    const problem = readProblem(lastRead, fresh.window.id, turn);
    if (problem) throw new Error(problem);
    return (id) => {
      const c = rematch(lastRead.controls[id - 1], fresh.controls, id);
      if (!c) throw new Error(STALE_ID);
      return c;
    };
  }
  async function hands(...args) {
    if (!handsBin) throw new Error(MAC ? 'This needs the Roamies app on macOS.' : WIN ? "Reading and pointing at other apps isn't available on this PC (the Roamies screen helper only ships for 64-bit Intel/AMD Windows)." : "Reading and pointing at other apps isn't available on this system.");
    const r = await run(handsBin, args, { timeout: 120_000 });
    let res;
    try { res = JSON.parse(r.stdout.trim().split('\n').pop() || '{}'); } catch { throw new Error(`hands helper failed: ${r.stderr.trim().slice(0, 200) || 'no output'}`); }
    if (res.ok === false && !res.cancelled) {
      if (MAC && /Accessibility/i.test(res.error ?? '')) {
        // Open the exact Settings pane (once a minute at most) so the fix is one click away.
        if (Date.now() - axNudged > 60_000) { axNudged = Date.now(); openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); }
        throw new Error('Accessibility is off for Roamies, so I can\'t read or control other apps yet. I just opened System Settings → Privacy & Security → Accessibility: switch on Roamies there, then ask again. Tell the user exactly that, briefly.');
      }
      throw new Error(res.error || 'That did not work.');
    }
    return res;
  }
  // A yes/no in an input bubble. Stop (or the turn ending) counts as no.
  async function confirm(question, ctx) {
    const answer = await ask({ placeholder: question }, ctx?.signal);
    return isYes(answer);
  }

  // target: "screen", "front" (the window you're working in), an app name ("browser", "Safari", "Figma"),
  // or "window:<id>" from list_windows. Apps that are open but hidden or minimised are brought forward.
  async function screenshot({ target = 'screen' } = {}, ctx) {
    const file = path.join(os.tmpdir(), `sidekick-${Date.now()}.jpg`);
    let sent = null;
    if (CAN_SEE) {
      const s = spec(screenTarget(String(target || 'screen').trim()));
      // Find the window first so the camera animation can frame the real thing (screen points), then shoot.
      if (!/^screen(:\d+)?$/i.test(s) && ctx?.toolCallId) {
        const at = await hands('locate', s).catch(() => null);
        if (at?.window) {
          ui({ kind: 'agent', e: { type: 'tool_target', id: ctx.toolCallId, window: at.window, ...pxUnit } });
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      // Sent at exactly the size the model processes; any other size gets resized again and coordinates drift.
      // Windows: the helper resizes (same rule, shared test vectors) and says the size it sent.
      const limits = imageLimits();
      const res = WIN
        ? await hands('capture', file, s, '--fit', `${limits.maxEdge}x${Number.isFinite(limits.maxTokens) ? limits.maxTokens : 0}`)
        : await hands('capture', file, s);
      const size = WIN ? (Array.isArray(res.sent) ? res.sent : null) : await fitImage(file, limits);
      const bounds = res.window?.bounds ?? res.bounds;
      let where = {};
      if (WIN && bounds) {
        const i = monitorFor(res.monitors, bounds);
        where = { unit: 'px', monitor: i + 1, scale: res.monitors?.[i]?.scale ?? 1 };
      }
      lastShot = size && bounds ? { ...shotMap(bounds, ...size), bounds, win: res.window?.id ?? null, turn, ...where } : null;
      const what = res.window ? `the ${res.window.app} window${res.window.title ? ` "${res.window.title}"` : ''}` : /^screen:\d+$/i.test(s) ? `monitor ${s.slice(7)}` : 'the whole screen';
      const dims = size ? ` (${size[0]}×${size[1]} px; give absolute pixel coordinates in this ${size[0]}×${size[1]} image, not a 0–1000 scale: x, y for point_at${CAN_ACT ? ' or click_at' : ''}, or a box [x1, y1, x2, y2] for point_at)` : '';
      return { content: [{ type: 'text', text: `Screenshot of ${what}${dims}.` }, await imageBlock(file, 'image/jpeg')] };
    } else if (WIN) {
      // No helper (e.g. Windows on ARM): primary screen only, and no pointing, so lastShot stays empty.
      lastShot = null;
      // DPI-aware (or scaled displays capture only the top-left part), resized to exactly the size the model
      // processes, and the file path passed by environment variable so odd characters in it can't break the script.
      // The target size depends on the screen size, so the script refuses (exit 3, prints "size W H") when the screen
      // isn't the one we computed for; the first shot per session and a display change cost one extra short run.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        "Add-Type -Name D -Namespace RoamiesWin -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
        '[RoamiesWin.D]::SetProcessDPIAware() | Out-Null',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        'if ($env:ROAMIES_EXPECT -ne "$($b.Width) $($b.Height)") { Write-Output "size $($b.Width) $($b.Height)"; exit 3 }',
        '$t=$env:ROAMIES_SIZE.Split(" ");$w=[int]$t[0];$h=[int]$t[1]',
        '$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
        '[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
        '$o=New-Object System.Drawing.Bitmap $w,$h',
        "$g=[System.Drawing.Graphics]::FromImage($o);$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($i,0,0,$w,$h)",
        '$o.Save($env:ROAMIES_SHOT,[System.Drawing.Imaging.ImageFormat]::Jpeg)',
        'Write-Output "sent $($o.Width) $($o.Height)"',
      ].join(';');
      // -EncodedCommand (UTF-16LE base64): no quoting for Windows' command line to mangle.
      const shoot = (screen) => {
        const limits = imageLimits();
        const env = { ...process.env, ROAMIES_SHOT: file, ROAMIES_EXPECT: screen ? screen.join(' ') : '', ROAMIES_SIZE: screen ? resizedSize(screen[0], screen[1], limits.maxEdge, limits.maxTokens).join(' ') : '' };
        return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env });
      };
      let r = await shoot(winScreen);
      let out = parseWinShot(r.stdout);
      if (out.size) { winScreen = out.size; r = await shoot(winScreen); out = parseWinShot(r.stdout); }
      if (r.err || !out.sent) throw new Error('Screen capture failed.');
      sent = out.sent;
    } else {
      let r = await run('grim', [file]);
      if (r.err) r = await run('gnome-screenshot', ['-f', file]);
      if (r.err) throw new Error('No screenshot tool found (install grim or gnome-screenshot).');
    }
    const data = (await fs.readFile(file)).toString('base64');
    fs.unlink(file).catch(() => {});
    const dims = sent ? ` (${sent[0]}×${sent[1]} px)` : '';
    return { content: [{ type: 'text', text: `Screenshot of the main display${dims}.` }, { type: 'image', mediaType: 'image/jpeg', data }] };
  }

  const tools = [
    {
      name: 'take_screenshot',
      description: WIN && CAN_SEE
        ? "Look at the user's screen. target: 'front' = just the window they're working in (best default when they say 'this' or 'here'), an app name like 'browser', 'Chrome', 'Notepad' or 'Excel' (works even if it's behind other windows), 'window:<id>' from list_windows, 'screen' for the main monitor, or 'screen:<n>' for monitor n (list_windows lists them)."
        : WIN ? "Look at the user's screen (always the whole main monitor)."
          : "Look at the user's screen. target: 'front' = just the window they're working in (best default when they say 'this' or 'here'), an app name like 'browser', 'Safari', 'Figma' or 'Notes' (works even if it's hidden behind other windows), 'window:<id>' from list_windows, or 'screen' for everything.",
      parameters: z.object({ target: z.string().optional() }), execute: screenshot,
    },
    ...(CAN_SEE ? [
      {
        name: 'list_windows', description: WIN ? 'List the open app windows (app, title, id), front to back, and the monitors (screen:<n>).' : 'List the open app windows (app, title, id), front to back.',
        parameters: z.object({}),
        execute: async () => {
          const res = await hands('windows');
          const wins = res.windows.map((w) => `window:${w.id}  ${w.app}${w.title ? ` — ${w.title}` : ''}${w.frontApp ? '  (frontmost app)' : ''}`).join('\n') || 'No windows open.';
          const mons = WIN && Array.isArray(res.monitors) ? res.monitors.map((m, i) => `screen:${i + 1}  ${m.bounds[2]}×${m.bounds[3]} at ${Math.round((m.scale ?? 1) * 100)}%${m.primary ? ' (main)' : ''}`) : [];
          return mons.length ? `${wins}\nMonitors:\n${mons.join('\n')}` : wins;
        },
      },
      {
        name: 'read_window',
        description: CAN_ACT
          ? "List the buttons, links, fields, checkboxes and other controls in an app's front window (id, role, label, value), plus the text on screen and the text scrolled out of view above and below it, so you can read a whole page without scrolling or a screenshot. Needed before act_in_app steps that use ids. To point at or click something by its visible words you don't need this: use point_at or click_text with text. target: 'front', an app name, or 'browser'."
          : "List the buttons, links, fields, checkboxes and other controls in an app's front window (id, role, label, value), plus the text on screen and the text scrolled out of view above and below it, so you can read a whole page without scrolling or a screenshot. To point at something by its visible words you don't need this: use point_at with text. target: 'front', an app name, 'browser' or 'window:<id>'.",
        parameters: z.object({ target: z.string().optional() }),
        execute: async ({ target = 'front' }) => {
          const t = screenTarget(String(target || 'front'));
          if (/^screen(:\d+)?$/i.test(t)) throw new Error("read_window reads one app window: use 'front', an app name or 'window:<id>', not a screen.");
          const [res, all] = await Promise.all([hands('ui', spec(t)), hands('windows').catch(() => null)]);
          lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
          const others = (all?.windows ?? []).filter((w) => w.app === res.window.app && w.id !== res.window.id).length;
          const head = `${res.window.app}${res.window.title ? ` — ${res.window.title}` : ''}${others ? ` (front window; ${res.window.app} has ${others} more, which point_at with text also searches)` : ''}`;
          if (!res.controls.length) return `${head}\n${res.note}`;
          return `${head}\n${controlList(res.controls, res.texts, CAN_ACT)}${res.elsewhere?.length ? `\nElsewhere on the page (scrolled out of view): ${res.elsewhere.join(' | ')}` : ''}`;
        },
      },
      {
        name: 'point_at',
        description: `Teach by showing: fly to something on screen and point at it while you explain one step. Use it to walk the user through how to do something (e.g. 'how do I add a layer mask'), one point_at per step, in order, with a short instruction each (under 12 words). Three ways to say where, best first: text, the exact words shown on screen (button and link labels, headings, version numbers, menu names; searches every window of the target app, or the whole screen with target 'screen', so no read_window is needed first); id from read_window, for controls without visible words; or x, y or box [x1, y1, x2, y2] in absolute pixels of your latest screenshot (never 0–1000), only when neither finds it; prefer a box for anything bigger than an icon. ${CAN_ACT ? 'Set click true only if the user asked you to do it for them; otherwise just point and let them click.' : "Clicking for them isn't available here: just point and tell them what to click."} wait_for_user true pauses until they do the step (or 20 s), for multi-step lessons.`,
        parameters: z.object({
          target: z.string().optional(),
          id: z.number().int().optional(), text: z.string().min(1).max(80).optional(), x: z.number().optional(), y: z.number().optional(),
          box: z.array(z.number()).optional(),
          say: z.string().min(1).max(120),
          step: z.number().int().optional(), of: z.number().int().optional(),
          click: z.boolean().optional(), wait_for_user: z.boolean().optional(),
        }),
        executionMode: 'sequential',
        execute: async ({ target = 'front', id, text: find, x, y, box, say: text, step, of: total, click, wait_for_user }, ctx) => {
          const t = screenTarget(String(target || 'front')), where = spec(t);
          let rect, label = '', at, liveId;
          if (id != null) {
            const c = (await liveControls(where))(id);
            if (c.offscreen) throw new Error(`"${c.label || c.role}" is further down the page. Use point_at with its text instead; that scrolls to it.`);
            rect = c.bounds; label = c.label || c.role; liveId = c.id;
          } else if (find) {
            // "front" searches every window of the front app; text is often in a window behind the frontmost one.
            const res = await hands('find-text', where, findText(find), 'scroll');
            const m = pickTextMatch(res.matches, find);
            if (!m) {
              const near = (res.matches ?? []).slice(0, 3).map((x) => `"${x.text.replace(/\s+/g, ' ').slice(0, 50)}"`).join(', ');
              throw new Error(`No button, label or heading reads "${find}"${near ? ` (it only appears inside longer text: ${near})` : ''}. Point at the exact words shown on screen; if you don't know them, take a screenshot first.`);
            }
            rect = m.bounds; label = m.text;
            if (click) at = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
          } else if (box != null) {
            rect = await shotRect(box);
            if (click) at = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
          } else if (x != null && y != null) {
            at = await shotPoint(x, y);
            rect = [at[0] - 14, at[1] - 14, 28, 28];
          } else throw new Error('Give an id from read_window, text shown on screen, or x, y or a box from a screenshot.');
          // The overlay flies there, points, shows the step and holds; this tool resolves once it's on screen.
          const done = new Promise((resolve) => pointWaits.set(ctx.toolCallId, resolve));
          ui({ kind: 'agent', e: { type: 'point', id: ctx.toolCallId, rect, say: text, step, of: total, label, ...pxUnit } });
          await done;
          if (click && !CAN_ACT) return `Pointed at ${label || 'the spot'}. Clicking isn't available on Windows yet, so ask the user to click it.`;
          if (click) {
            if (!allowActions()) throw new Error(actionsOff);
            if (id != null) await hands('act', JSON.stringify({ steps: [{ do: 'click', id: liveId }], ...(t === 'front' ? {} : { app: t }) }));
            else await hands('act', JSON.stringify({ steps: [{ do: 'click_at', x: at[0], y: at[1], global: true }], ...(t === 'front' || t === 'screen' ? {} : { app: t }) }));
            if (lastShot) lastShot.used = true;
          } else if (wait_for_user) {
            // Give them time to do it themselves before the next step.
            await new Promise((r) => setTimeout(r, 6000));
          }
          return `Pointed at ${label || 'the spot'}${click ? ' and clicked it' : ''}.`;
        },
      },
    ] : []),
    ...(CAN_ACT ? [
      {
        name: 'act_in_app',
        description: "Do things in another app for the user: click, fill in forms, pick from dropdowns and date pickers, scroll, press keys. Steps run in order; put a whole task in one call. {do:'click_text', text} clicks a link, button or tab by its visible words (no read_window needed). {do:'fill', field, text} fills one text field: field is its label or placeholder as shown (or id), it replaces the text and checks it took; use one fill per field, never click a label and type. {do:'choose', field, option} picks an option in a dropdown, select menu, type-to-search box or picker: it opens it, types or scrolls through the list (hundreds of options, even lists that only load rows as they scroll) and picks; field is its label or id. Never scroll a dropdown list yourself. Many identical buttons or fields (a Reply under every post): add near, words from that item (author or first words of the post), to click_text or fill and it uses the one belonging to that item, scrolling to it. {do:'scroll', direction:'down'|'up'|'left'|'right', amount, text or id} scrolls the page, or the list or panel under that text or control; needed only for content that loads as you scroll: {do:'scroll', direction:'down', to_end:true} keeps going until the feed stops loading more, in one step; then read_window lists everything that loaded. Things already on the page don't need scrolling: click_text, fill and point_at find them anywhere on it and scroll there themselves. {do:'click', id}; {do:'key', key} e.g. 'return', 'tab', 'escape', 'cmd+l'; {do:'type', text} only when the cursor is already in a text field; {do:'click_at', x, y} absolute pixels in your latest screenshot (never 0–1000), last resort; {do:'wait', seconds}. Dates: fill the date field with the date as the page shows dates (e.g. 10/30/2026); if a calendar opens instead, choose the month and year, then click_text the day (its label often reads like 'Choose Friday, October 30th, 2026'). After the steps the result lists the window's controls and text as they are now (after scrolls too), with fresh ids and field values, so check them there instead of calling read_window again. Never submit payments, send messages or delete things unless the user clearly asked for exactly that; showing or pointing at a button is not a request to click it. Clicks on delete, pay, send or sign-out buttons always ask the user first, so when they asked you to click one, call act_in_app right away instead of asking in your reply; the app asks them.",
        parameters: z.object({
          target: z.string().optional(),
          steps: z.array(z.object({
            do: z.enum(['click_text', 'fill', 'choose', 'scroll', 'set', 'focus', 'click', 'type', 'key', 'click_at', 'wait']),
            id: z.number().int().optional(), field: z.string().optional(), text: z.string().optional(), option: z.string().optional(), near: z.string().optional(),
            key: z.string().optional(), direction: z.enum(['down', 'up', 'left', 'right']).optional(), amount: z.number().int().optional(), to_end: z.boolean().optional(),
            x: z.number().optional(), y: z.number().optional(), seconds: z.number().optional(),
          })).min(1).max(40),
        }),
        executionMode: 'sequential',
        execute: async ({ target = 'front', steps }, ctx) => {
          if (!allowActions()) throw new Error(actionsOff);
          const asked = String(target || 'front');
          // Stay on the exact window read for this request: an app can have several, and keystrokes must land in this one.
          const sameApp = lastRead?.turn === turn && (asked === 'front' || (lastRead.app ?? '').toLowerCase().includes(asked.toLowerCase()) || (asked.toLowerCase() === 'browser'));
          const t = sameApp ? `window:${lastRead.win}` : asked;
          // Ids up to the first click come from read_window; after a click the helper re-reads the page itself.
          const firstClick = steps.findIndex((s) => s.do === 'click' || s.do === 'click_text');
          const upTo = firstClick < 0 ? steps.length : firstClick + 1;
          const spec = t === 'front' || t.startsWith('window:') ? t : `app:${t}`;
          const live = steps.slice(0, upTo).some((s) => s.id != null) ? await liveControls(spec) : null;
          const mapped = [];
          for (const [i, s] of steps.entries()) {
            if (s.do === 'click_at' && s.x != null && s.y != null) { const [x, y] = await shotPoint(s.x, s.y); mapped.push({ ...s, x, y, global: true }); }
            else if (live && i < upTo && s.id != null) { const c = live(s.id); mapped.push({ ...s, id: c.id, label: c.label }); }
            else mapped.push(s);
          }
          // Delete, pay, send, sign out: ask first, whatever the request was. The helper refuses these clicks without it.
          for (const s of mapped) {
            const label = s.do === 'click_text' ? s.text : s.do === 'click' ? s.label : s.do === 'choose' ? s.option : null;
            if (label && isRiskyClick(label)) {
              if (!(await confirm(`Click "${label}"${asked === 'front' ? '' : ` in ${asked}`}? It could delete, pay, send or sign out. Type y to let me.`, ctx))) {
                throw new Error(`${userName} said no, so I didn't click "${label}" (nothing after it ran either).`);
              }
              s.confirmed = true;
            }
            delete s.label;
          }
          const plan = { steps: mapped, ...(t === 'front' ? {} : t.startsWith('window:') ? { window: +t.slice(7) } : { app: t }) };
          let res;
          try {
            try { res = await hands('act', JSON.stringify(plan)); }
            catch (err) {
              // The window read earlier closed (a date picker or popup): use the app's front window instead.
              if (!plan.window || !/No matching window/.test(String(err?.message ?? err))) throw err;
              delete plan.window;
              if (asked !== 'front' && lastRead?.app) plan.app = lastRead.app;
              res = await hands('act', JSON.stringify(plan));
            }
          } finally { if (lastShot && mapped.some((s) => s.do !== 'wait')) lastShot.used = true; }
          if (!res.controls) return `In ${res.window.app}: ${res.done.join(', ')}.`;
          lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
          return `In ${res.window.app}: ${res.done.join(', ')}.\nNow showing: ${res.window.title || res.window.app}\n${controlList(res.controls, res.texts)}`;
        },
      },
    ] : []),
    {
      name: 'read_file', description: 'Read a text file. Paths may start with ~. Files with passwords or keys (.ssh, .env, auth.json, keychains) are off limits.',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path: p }) => clip(await fs.readFile(allowed(checkRead(p, HOME)), 'utf8'), 60_000),
    },
    {
      name: 'list_files', description: 'List the files and folders in a directory.',
      parameters: z.object({ dir: z.string() }),
      execute: async ({ dir }) => {
        const ents = await fs.readdir(allowed(checkRead(dir, HOME)), { withFileTypes: true });
        return ents.slice(0, 300).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') + (ents.length > 300 ? `\n…and ${ents.length - 300} more` : '');
      },
    },
    {
      name: 'search_files', description: 'Search file contents under a specific folder for a text pattern (regex). Not your whole home folder: that trips macOS privacy prompts. To find files by name anywhere, use run_command with mdfind.',
      parameters: z.object({ pattern: z.string(), dir: z.string() }),
      execute: async ({ pattern, dir }) => {
        const d = allowed(checkRead(dir, HOME, { recursive: true }));
        // -e and -- keep a pattern like "--pre=cmd" from being read as an option (rg --pre runs programs).
        let r = await run('rg', ['-n', '--max-count', '5', '--max-columns', '200', '-e', pattern, '--', d]);
        if (r.err?.code === 'ENOENT') r = await run('grep', ['-rnI', '-m', '5', '-E', '-e', pattern, '--', d]);
        return clip(r.stdout || 'No matches.', 12_000);
      },
    },
    {
      name: 'write_file', description: 'Create or overwrite a text file with the given content (missing folders are made). Use this, not run_command, to create or change files: a new file needs no yes from the user; overwriting asks them.',
      parameters: z.object({ path: z.string(), content: z.string() }), executionMode: 'sequential',
      execute: async ({ path: p, content }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        const exists = await fs.stat(expand(p)).then(() => true, () => false);
        const v = checkWrite(p, HOME, { exists });
        const f = allowed(v);
        if (v.level === ASK && !(await confirm(`${v.reason} Type y to let me.`, ctx))) throw new Error(`${userName} said no, so I didn't write ${p}.`);
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, content);
        return `Wrote ${content.length} characters to ${f}.`;
      },
    },
    {
      name: 'run_command', description: "Run a shell command in the user's home folder and return its output. Use it for what the other tools can't do (counting, sorting, wc, mdfind, git, moving or copying); to open a file, folder, app or link use the open tool, which needs no yes. Prefer write_file for creating or editing files; never edit with sed -i or tee. A > redirect into a new file is fine; overwriting an existing file, and commands that change things, make the user confirm first, which is slow.",
      parameters: z.object({ command: z.string() }), executionMode: 'sequential', timeoutMs: 190_000, // up to 2 min to answer, then the 60 s run
      execute: async ({ command }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        const v = classifyCommand(command, HOME, { exists: existsSync });
        if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason} Don't try to get around this; tell ${userName} what you wanted to do instead.`);
        if (v.level === ASK && !(await confirm(`Run \`${command.length > 70 ? command.slice(0, 67) + '…' : command}\`?${v.reason ? ' ' + v.reason : ''} Type y to run it.`, ctx))) {
          throw new Error(`${userName} said no, so the command didn't run.`);
        }
        const shell = process.platform === 'win32' ? ['cmd', ['/c', command]] : [process.env.SHELL || '/bin/zsh', ['-lc', command]];
        const r = await run(shell[0], shell[1], { cwd: HOME });
        const out = clip((r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() || '(no output)', 12_000);
        if (r.err && r.err.code !== 0) throw new Error(`Exit ${r.err.code ?? r.err.signal}\n${out}`);
        return out;
      },
    },
    {
      name: 'fetch_url', description: 'Fetch a web page and return its readable text.',
      // No .url(): it becomes format "uri", which OpenAI strict schemas reject (checkUrl validates instead).
      parameters: z.object({ url: z.string().describe('Full http(s) URL') }),
      execute: async ({ url }) => {
        // Redirects are followed by hand so each hop is checked too (a public page can't bounce to localhost).
        let res, at = url;
        for (let hop = 0; ; hop++) {
          allowed(checkUrl(at));
          res = await fetch(at, { headers: { 'user-agent': 'Roamies-Sidekick' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
          const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
          if (!next) break;
          if (hop >= 5) throw new Error('Too many redirects.');
          at = new URL(next, at).href;
        }
        url = at;
        const html = await res.text();
        const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        return clip(`${res.status} ${url}\n${text}`, 15_000);
      },
    },
    {
      name: 'open', description: `Open a website, a file or folder, or ${process.platform === 'win32' ? 'an app by its Start-menu name (e.g. "Spotify", "Settings", "Calculator", "https://skool.com", "~\\Documents")' : 'a Mac app by name (e.g. "Safari", "https://skool.com", "~/Documents")'}. Links open in the default browser; set app to open one in a particular browser or app (e.g. app "Safari" when the user says "in Safari").`,
      parameters: z.object({ target: z.string(), app: z.string().optional() }),
      execute: async ({ target, app }) => {
        const t = String(target).trim();
        const isFile = /^[~/.]/.test(t) && await fs.stat(expand(t)).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false);
        allowed(checkOpen(t, HOME, { executable: isFile }));
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(t), isPath = /^[~/.]/.test(t) || /^[a-z]:\\/i.test(t);
        let r;
        const inApp = app && process.platform === 'darwin' && (isUrl || isPath) ? ['-a', String(app)] : [];
        if (process.platform === 'darwin') r = await run('open', isUrl || isPath ? [...inApp, isPath ? expand(t) : t] : ['-a', t]);
        else if (process.platform === 'win32' && isWinAppName(t)) {
          const { match, apps, failed, error } = await appFinder.find(t);
          if (failed) throw new Error(`Couldn't read the Start-menu app list, so I can't open apps by name right now${error?.detail ?? ''}.`);
          if (!match) throw notFound(t, apps);
          const target = launchTarget(match.app);
          allowed(checkOpen(target, HOME, { startApps: new Set(apps.map(launchTarget)) }));
          r = await winLaunch(target);
          if (r.err) throw new Error(`Couldn't open ${match.app.name}${winSaid(r.stderr)}.`);
          if (lastShot) lastShot.used = true;
          return `Opened ${match.app.name}.`;
        } else if (process.platform === 'win32' && app && (isUrl || isPath)) {
          const { match, apps, failed, error } = await appFinder.find(String(app));
          if (failed) throw new Error(`Couldn't read the Start-menu app list, so I can't open things in ${app} right now${error?.detail ?? ''}.`);
          if (!match) throw notFound(String(app), apps);
          const plan = winInAppPlan(match.app, isPath ? expand(t) : t);
          if (plan.error) throw new Error(plan.error);
          allowed(checkOpen(plan.target, HOME, { startApps: new Set(apps.map(launchTarget)) }));
          r = await winOpen(plan.target, plan.arg);
          if (r.err) throw new Error(`Couldn't open ${t} in ${match.app.name}${winSaid(r.stderr)}.`);
          if (lastShot) lastShot.used = true;
          return `Opened ${t} in ${match.app.name}.`;
        } else if (process.platform === 'win32') r = await winOpen(isPath ? expand(t) : t);
        else r = await run('xdg-open', [isPath ? expand(t) : t]);
        if (r.err) throw new Error(process.platform === 'win32' ? `Couldn't open ${t}${winSaid(r.stderr)}.` : r.stderr.trim() || `Couldn't open ${t}.`);
        if (lastShot) lastShot.used = true;
        return `Opened ${t}${inApp.length ? ` in ${app}` : ''}.`;
      },
    },
    {
      name: 'remember_commitment',
      description: `Save something ${userName} has committed to doing, or anything they ask to be reminded about, so you can remind them at the right moment. Use it whenever they say they will do something or say "remind me". kind: 'reminder' for a plain "remind me to X at/in …" (it clears itself once the nudge is given), 'commitment' (default) for something they say they'll do or finish ("I'll finish the slides by Friday"), which stays open until they say it's done. due: a relative time like "in 90s", "in 5m", "in 1h30m" or "in 2 days" (best for short timers), or a local time YYYY-MM-DDTHH:mm:ss, YYYY-MM-DDTHH:mm, or YYYY-MM-DD if only the day is known; omit if there's no time at all. Resolve words like "Thursday", "at 2" or "tonight" from the timestamp on their message.`,
      parameters: z.object({ text: z.string().min(2).max(200), due: z.string().optional(), kind: z.enum(['reminder', 'commitment']).optional() }),
      execute: async ({ text, due, kind }) => {
        const ms = parseDue(due);
        if (ms === undefined) throw new Error(`Couldn't read the time "${due}". Use YYYY-MM-DDTHH:mm or YYYY-MM-DD.`);
        // A plain reminder with no time has nothing to fire, so it's kept like a commitment.
        const c = await addCommitment(text, ms, ms ? kind : 'commitment');
        onCommitments(c);
        return `Saved as ${c.id}${ms ? `, due ${fmtWhen(ms)}` : ''}. I'll remind them${ms ? ' when it is due' : ''}.`;
      },
    },
    {
      name: 'update_commitment',
      description: 'Mark a saved commitment done or dropped, or change its due time (same format as remember_commitment; use "none" to clear it).',
      parameters: z.object({ id: z.string(), status: z.enum(['open', 'done', 'dropped']).optional(), due: z.string().optional() }),
      execute: async ({ id, status, due }) => {
        const ms = due === undefined ? undefined : due === 'none' ? null : parseDue(due);
        if (ms === undefined && due !== undefined) throw new Error(`Couldn't read the time "${due}".`);
        const c = await updateCommitment(id, { status, dueMs: ms });
        if (!c) throw new Error(`No commitment with id ${id}. Call list_commitments to see the ids.`);
        onCommitments(c);
        return `${c.id} is now ${c.status}${c.due ? `, due ${fmtWhen(c.due)}` : ''}.`;
      },
    },
    {
      name: 'remember_fact',
      description: `Save a lasting fact about ${userName} worth knowing in every future conversation: preferences, their projects, channels and tools, people they mention, how they like to work. Not passing small talk, and not commitments (those go to remember_commitment). One short fact per call.`,
      parameters: z.object({ fact: z.string().min(3).max(240) }),
      execute: async ({ fact }) => { const f = await addFact(fact); return `Remembered (${f.id}).`; },
    },
    {
      name: 'forget_fact', description: 'Delete a saved fact that is wrong or that the user asks you to forget. Ids are in the memory list in your instructions.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => { const f = await forgetFact(id); if (!f) throw new Error(`No fact with id ${id}.`); return `Forgot: ${f.text}`; },
    },
    {
      name: 'show_list', description: "Show the user their list on screen (reminders and commitments, Today and Later). Use when they ask to see their list, to-dos or reminders; then answer in a few words, don't read it all out.",
      parameters: z.object({}),
      execute: async () => { showList(); return 'The list is on screen.'; },
    },
    {
      name: 'list_commitments', description: "List the open commitments you're keeping track of.",
      parameters: z.object({}),
      execute: async () => commitmentsText() || 'Nothing open.',
    },
  ];

  return { tools, hands, pointWaits, nextTurn: () => ++turn };
}
