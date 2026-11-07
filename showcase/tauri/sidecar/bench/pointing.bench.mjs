// Pointing benchmark: npm run bench:pointing -- [dir] [--model <id>] [--modes raw,marks,refine] [--repeat n]
// Each fixture (<dir>/<name>/shot.jpg native capture, ui.json the helper's ui reply, cases.json [{ ask, truth: [x,y,w,h] }]
// in screen units) is replayed through the real take_screenshot and point_at tools with a stand-in helper: it serves the
// fixture, and the real helper's image verb draws the marks and cuts the crops, so the model sees what production sends.
// Scores the pointed rect: centre inside the truth, IoU ≥ 0.5, and time from the request to the point.
// Needs a signed-in model (same sign-in as the app) and spends a few dozen model calls; not run in CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { POINTING, imageLimits, resizedSize, scoreBox } from '../pointing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODES = ['raw', 'marks', 'refine'];
// What each mode switches on (the rest of POINTING stays as shipped).
export const MODE_FLAGS = { raw: { marks: false, refine: false }, marks: { marks: true, refine: false }, refine: { marks: false, refine: true } };

/** The screen helper: ROAMIES_HANDS, else the local hands-win build (release, then debug). */
export function helperPath(env = process.env) {
  if (env.ROAMIES_HANDS) return env.ROAMIES_HANDS;
  const exe = process.platform === 'win32' ? 'roamies-hands.exe' : 'roamies-hands';
  const roots = process.platform === 'win32' ? ['hands-win/target/release', 'hands-win/target/debug'] : ['target/debug', 'target/release'];
  for (const r of roots) {
    const p = path.join(HERE, '..', '..', 'src-tauri', r, exe);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No screen helper found: build it (cargo build --release in src-tauri/hands-win) or set ROAMIES_HANDS.');
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/** Per mode: n, hits (centre inside, IoU ≥ 0.5) as rates, p50/p95 ms, and how the points were found. */
export function summarize(results) {
  const out = {};
  for (const r of results) {
    const s = (out[r.mode] ??= { n: 0, center: 0, iou50: 0, ms: [], paths: {} });
    s.n++;
    const sc = scoreBox(r.rect, r.truth);
    if (sc.centerIn) s.center++;
    if (sc.iou >= 0.5) s.iou50++;
    if (Number.isFinite(r.ms)) s.ms.push(r.ms);
    const how = r.path ?? 'none';
    s.paths[how] = (s.paths[how] ?? 0) + 1;
  }
  for (const s of Object.values(out)) {
    Object.assign(s, { center: +(s.center / s.n).toFixed(3), iou50: +(s.iou50 / s.n).toFixed(3), p50: percentile(s.ms, 50), p95: percentile(s.ms, 95) });
    delete s.ms;
  }
  return out;
}

export function loadFixtures(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const at = path.join(dir, d.name);
    const ui = JSON.parse(fs.readFileSync(path.join(at, 'ui.json'), 'utf8'));
    const cases = JSON.parse(fs.readFileSync(path.join(at, 'cases.json'), 'utf8'));
    return { name: d.name, shot: path.join(at, 'shot.jpg'), ui, cases };
  }).filter((f) => fs.existsSync(f.shot) && f.cases.length);
}

// Stand-in helper verbs (node scripts named after the verb, run from cwd like the tests' fakes).
function writeFakeHelper(dir, fixture, helper, limits) {
  const { shot: info, ...ui } = fixture.ui;
  const win = ui.window, native = info.native, fit = resizedSize(native[0], native[1], limits.maxEdge, limits.maxTokens);
  const monitors = [{ bounds: info.bounds, scale: 1 }];
  const J = JSON.stringify;
  const real = `const { execFileSync } = require('child_process'); const real = (args) => JSON.parse(execFileSync(${J(helper)}, args, { encoding: 'utf8' }).trim().split(/\\r?\\n/).pop());`;
  const files = {
    capture: `${real} const a = process.argv; const fit = a.includes('--fit'); const r = real(['image', ${J(fixture.shot)}, a[2], ...(fit ? ['--size', ${J(fit.join(','))}] : [])]); console.log(JSON.stringify({ ok: true, unit: 'px', window: ${J(win)}, sent: r.sent, monitors: ${J(monitors)} }));`,
    locate: `console.log(${J(J({ ok: true, unit: 'px', window: win }))});`,
    ui: `console.log(${J(J(ui))});`,
    image: `${real} console.log(JSON.stringify(real(['image', ...process.argv.slice(2)])));`,
    'find-text': `console.log(${J(J({ ok: true, matches: [] }))});`,
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
}

export async function signIn(modelId) {
  const core = await import('@kenkaiiii/gg-core');
  const auth = new core.AuthStorage();
  let model = modelId ? core.getModel(modelId) : null;
  if (modelId && !model) throw new Error(`Unknown model ${modelId}.`);
  if (!model) {
    for (const p of ['anthropic', 'openai', 'gemini']) {
      if (await auth.hasProviderAuth(p).catch(() => false)) { model = core.getModel(p === 'anthropic' ? 'claude-haiku-5-5' : '') ?? core.getDefaultModel(p); break; }
    }
  }
  if (!model) throw new Error('Not signed in: sign in to a model in Roamies (or gg) first.');
  const creds = await auth.resolveCredentials(model.provider);
  const { agentUserAgent } = await import('../useragent.mjs');
  const userAgent = await agentUserAgent(model.provider, core.getClaudeCliUserAgent);
  return { model, auth, baseUrl: creds.baseUrl, userAgent };
}

// One ask in one mode: a fresh agent with the real take_screenshot and point_at, stopped at the first point.
async function runCase({ fixture, c, mode, session, helper }) {
  const { Agent } = await import('@kenkaiiii/gg-agent');
  const { createTools, screenPrompt } = await import('../tools.mjs');
  const { agentEvents } = await import('../agentstream.mjs');
  const limits = imageLimits(session.model.id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-bench-'));
  writeFakeHelper(dir, fixture, helper, limits);
  const cwd = process.cwd();
  process.chdir(dir);
  Object.assign(POINTING, MODE_FLAGS[mode]);
  const controller = new AbortController();
  let point = null, how = null, refined = false;
  const t0 = performance.now();
  const noop = () => {};
  const made = createTools({
    allowActions: () => false, ask: async () => '', openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => 'the user',
    platform: 'win32', hands: process.execPath, imageLimits: () => limits,
    onPointing: (e) => { if (e.kind === 'locate') how = e.path; if (e.kind === 'crop') refined = true; },
    ui: (m) => {
      if (m.e?.type !== 'point') return;
      point ??= { rect: m.e.rect, ms: performance.now() - t0 };
      made.pointWaits.get(m.e.id)?.();
      controller.abort();
    },
  });
  const tools = made.tools.filter((t) => t.name === 'take_screenshot' || t.name === 'point_at');
  const sp = screenPrompt({ platform: 'win32', hands: process.execPath });
  const agent = new Agent({
    provider: session.model.provider, model: session.model.id,
    system: `You are Roamies, a desktop sidekick. You can see the screen${sp.abilities}.${sp.live}\n${sp.coords}Answer by pointing: call point_at once, then stop.`,
    tools, maxTurns: 6, signal: controller.signal,
    thinking: session.model.supportsThinking ? 'low' : undefined,
    resolveCredentials: async () => { const k = await session.auth.resolveCredentials(session.model.provider); return { apiKey: k.accessToken, accountId: k.accountId, projectId: k.projectId }; },
    baseUrl: session.baseUrl, userAgent: session.userAgent,
  });
  let error = null;
  try {
    const ask = `${c.ask}\n(Look at window:${fixture.ui.window.id} with take_screenshot first. In this test, point_at text and id find nothing: point with what the screenshot gives you.)`;
    for await (const e of agentEvents(agent.prompt(ask))) { if (e?.type === 'error') error = e.error?.message ?? String(e.error); }
  } catch (e) { if (!point) error = e?.message ?? String(e); } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { fixture: fixture.name, ask: c.ask, mode, truth: c.truth, rect: point?.rect ?? null, ms: point?.ms ?? null, path: how, refined, ...(point ? {} : { error: error ?? 'no point' }) };
}

export function table(summary) {
  const rows = [['mode', 'n', 'centre in', 'IoU ≥ 0.5', 'p50 ms', 'p95 ms', 'paths']];
  for (const [mode, s] of Object.entries(summary)) {
    rows.push([mode, s.n, `${Math.round(s.center * 100)}%`, `${Math.round(s.iou50 * 100)}%`, s.p50 == null ? '–' : Math.round(s.p50), s.p95 == null ? '–' : Math.round(s.p95), Object.entries(s.paths).map(([k, v]) => `${k} ${v}`).join(', ')]);
  }
  return rows.map((r) => `| ${r.join(' | ')} |`).join('\n').replace(/\n/, `\n|${' --- |'.repeat(rows[0].length)}\n`);
}

async function main(argv) {
  const opt = { dir: path.join(HERE, '..', 'test', 'fixtures', 'pointing'), modes: MODES, model: null, repeat: 1, out: 'bench-pointing.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opt.model = argv[++i];
    else if (a === '--modes') opt.modes = argv[++i].split(',').filter((m) => MODES.includes(m));
    else if (a === '--repeat') opt.repeat = Math.max(1, +argv[++i] || 1);
    else if (a === '--out') opt.out = argv[++i];
    else opt.dir = path.resolve(a);
  }
  const helper = helperPath();
  const fixtures = loadFixtures(opt.dir);
  if (!fixtures.length) throw new Error(`No fixtures in ${opt.dir}.`);
  const session = await signIn(opt.model);
  const total = fixtures.reduce((n, f) => n + f.cases.length, 0) * opt.modes.length * opt.repeat;
  console.error(`[bench] ${session.model.id}: ${fixtures.length} fixtures, ${total} runs (${opt.modes.join(', ')})`);
  const results = [];
  for (let r = 0; r < opt.repeat; r++) for (const fixture of fixtures) for (const c of fixture.cases) for (const mode of opt.modes) {
    const res = await runCase({ fixture, c, mode, session, helper });
    const sc = scoreBox(res.rect, res.truth);
    console.error(`[bench] ${mode.padEnd(6)} ${fixture.name}: ${c.ask} → ${res.path ?? '–'} ${sc.centerIn ? 'hit' : 'miss'} iou ${sc.iou.toFixed(2)} ${res.ms == null ? '' : `${Math.round(res.ms)} ms`}${res.error ? ` (${res.error.slice(0, 80)})` : ''}`);
    results.push(res);
  }
  const summary = summarize(results);
  fs.writeFileSync(opt.out, JSON.stringify({ model: session.model.id, date: new Date().toISOString().slice(0, 10), summary, results }, null, 1));
  console.log(table(summary));
  console.error(`[bench] wrote ${opt.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[bench] ${e.message}`); process.exit(1); });
}
