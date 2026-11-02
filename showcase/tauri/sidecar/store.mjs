// Sidekick storage: conversation sessions and the commitments memory, under ~/.gg/sidekick/.
// Writes are atomic (temp file, fsync, rename) and serialised per file, files are private (0600),
// and a file that fails to parse is kept aside as *.corrupt-<time> instead of being overwritten.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DIR = process.env.ROAMIES_DATA_DIR ? path.join(process.env.ROAMIES_DATA_DIR, 'sidekick') : path.join(os.homedir(), '.gg', 'sidekick');
const SESSIONS = path.join(DIR, 'sessions');
const MEMORY = path.join(DIR, 'memory.json');
const SESSION_FILE = /^\d{8}-\d{6}-[a-z0-9]{6}\.json$/;
const KEEP_SESSIONS = 60;
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

const chains = new Map();
/** Atomic JSON write. `backup` keeps the previous version as <file>.bak. */
export function writeJson(file, data, { backup = false } = {}) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (backup && existsSync(file)) await fs.copyFile(file, `${file}.bak`).catch(() => {});
    await fs.rename(tmp, file);
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run);
  chains.set(file, next.catch(() => {}));
  return next.catch((e) => console.error(`[store] write ${path.basename(file)} failed`, e));
}

/** Resolves once every write queued so far has landed (or failed), so quitting never cuts one off. */
export const flushWrites = () => Promise.all([...chains.values()]);

/** Reads JSON; missing → null. Unparseable → moved aside, then the .bak is tried. */
export function readJson(file, { backup = false } = {}) {
  const tryRead = (f) => JSON.parse(readFileSync(f, 'utf8'));
  try {
    return tryRead(file);
  } catch (e) {
    if (e.code === 'ENOENT') return backup && existsSync(`${file}.bak`) ? safeBak(file) : null;
    const aside = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, aside); } catch {}
    console.error(`[store] ${path.basename(file)} was unreadable; kept it as ${path.basename(aside)}`);
    return backup ? safeBak(file) : null;
  }
  function safeBak(f) {
    try { return tryRead(`${f}.bak`); } catch { return null; }
  }
}

// ---------- sessions ----------

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newSession(provider, model) {
  const now = new Date();
  return { version: 1, id: `${stamp(now)}-${randomBytes(3).toString('hex')}`, startedAt: now.getTime(), lastActiveAt: now.getTime(), provider, model, messages: [] };
}

/** A session goes stale after a 2-hour gap or once the day changes. */
export function isStale(s, now = Date.now()) {
  if (!s) return true;
  return now - s.lastActiveAt > SESSION_GAP_MS || new Date(s.lastActiveAt).toDateString() !== new Date(now).toDateString();
}

export async function loadLatestSession() {
  let names = [];
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names.slice(0, 5)) {
    const s = readJson(path.join(SESSIONS, n));
    if (s?.version === 1 && Array.isArray(s.messages)) return s;
  }
  return null;
}

export const saveSession = (s) => (s?.messages.length ? writeJson(path.join(SESSIONS, `${s.id}.json`), s) : Promise.resolve());

/** Keeps the newest sessions. Only touches files this module names, in this folder. */
export async function pruneSessions() {
  let names;
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort(); } catch { return; }
  const drop = names.slice(0, Math.max(0, names.length - KEEP_SESSIONS));
  if (!drop.length) return;
  console.error(`[store] pruning ${drop.length} old session(s), keeping ${KEEP_SESSIONS}`);
  for (const n of drop) await fs.unlink(path.join(SESSIONS, n)).catch(() => {});
}

// Screenshots stay in memory for the current turn only: never written to disk. The marker says the
// image was really seen, so a resumed session doesn't decide it never got one.
const SHOT = "[A screenshot was here and you did see it when you answered; the image was removed afterwards to save space, so its absence doesn't mean you didn't see it. The screen has likely changed since: look again before describing or pointing at what's on it now.]";
const stripImages = (content) =>
  Array.isArray(content) ? content.map((p) => (p?.type === 'image' ? { type: 'text', text: SHOT } : p)) : content;
export function forDisk(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
      if (m.role === 'user') return { ...m, content: stripImages(m.content) };
      return m;
    });
}

/** History carried to another provider: drop reasoning blocks (signed for the old one). */
export function forProvider(messages, from, to) {
  if (!from || from === to) return messages;
  return messages.map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => p.type !== 'thinking') } : m));
}

// ---------- context budget ----------

const textLen = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === 'image' ? 6000 : (p?.text ?? p?.content ?? '').length + JSON.stringify(p?.args ?? '').length), 0) : 0);
const approxChars = (m) => (m.role === 'tool' ? m.content.reduce((n, r) => n + textLen(r.content), 0) : textLen(m.content));

// Window reads from earlier requests are out of date and large; they shrink to their first line.
const READ_TOOLS = new Set(['read_window']);
const OLD_READ = "[The full list of this window's controls was shown for an earlier request and has been trimmed since to save space; your answer then was based on all of it. The screen has likely changed: read it again if you need it now.]";
const textOfResult = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');

/**
 * Before each model call. Everything from before the newest request is rewritten the same way every
 * time (screenshots and window reads collapse to a line), so it changes at most once and the prompt
 * cache keeps hitting; the current request keeps its newest two images. If the history is over budget,
 * the oldest exchanges are dropped (cutting at a user message so tool calls stay paired).
 */
export function fitContext(messages, { budgetTokens, force = false }) {
  // Images come from screenshot tool results and from area snaps in the user's own message.
  const hasImage = (m) => m.role === 'tool'
    ? m.content.some((r) => Array.isArray(r.content) && r.content.some((p) => p?.type === 'image'))
    : m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image');
  const isRequest = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text'));
  let current = -1;
  messages.forEach((m, i) => { if (isRequest(m)) current = i; });
  const keepImg = new Set(messages.map((m, i) => (i >= current && hasImage(m) ? i : -1)).filter((i) => i >= 0).slice(-2));
  const names = new Map();
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) if (p?.type === 'tool_call') names.set(p.id, p.name);
  let out = messages.map((m, i) => {
    const old = i < current;
    if (m.role === 'tool' && old && m.content.some((r) => READ_TOOLS.has(names.get(r.toolCallId)))) {
      m = { ...m, content: m.content.map((r) => (READ_TOOLS.has(names.get(r.toolCallId)) ? { ...r, content: `${textOfResult(r.content).split('\n')[0]}\n${OLD_READ}` } : r)) };
    }
    if (keepImg.has(i) || !hasImage(m)) return m;
    if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
    return { ...m, content: stripImages(m.content) };
  });
  const budget = (force ? 0.6 : 1) * budgetTokens * 3.6;
  let total = out.reduce((n, m) => n + approxChars(m), 0);
  if (total <= budget) return out;
  const sys = out.filter((m) => m.role === 'system');
  let rest = out.filter((m) => m.role !== 'system');
  while (total > budget && rest.length > 2) {
    let cut = rest.findIndex((m, i) => i > 0 && m.role === 'user');
    if (cut < 0) break;
    total -= rest.slice(0, cut).reduce((n, m) => n + approxChars(m), 0);
    rest = rest.slice(cut);
  }
  const first = rest[0];
  const note = '[Older parts of this conversation were trimmed to save space.]\n';
  if (first?.role === 'user' && typeof first.content === 'string' && !first.content.startsWith(note)) rest[0] = { ...first, content: note + first.content };
  return [...sys, ...rest];
}

// ---------- commitments ----------

/** Short id with a prefix, guaranteed not to clash with any commitment or fact already stored. */
function newId(prefix) {
  const taken = new Set([...loadMemory().commitments, ...loadMemory().facts].map((x) => x.id));
  for (;;) { const id = `${prefix}${randomBytes(3).toString('hex')}`; if (!taken.has(id)) return id; }
}

let memory = null;
const loadMemory = () => {
  if (memory) return memory;
  const m = readJson(MEMORY, { backup: true });
  memory = m?.version === 1 && Array.isArray(m.commitments) ? m : { version: 1, commitments: [] };
  if (!Array.isArray(memory.facts)) memory.facts = []; // added later: older files have no facts yet
  return memory;
};
const saveMemory = () => writeJson(MEMORY, memory, { backup: true });

/**
 * Due time → ms, or null for none, or undefined if unreadable. Accepts local times
 * 'YYYY-MM-DD' (10am), 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss', or a relative 'in 90s', 'in 5m',
 * 'in 1h30m', 'in 2 days' measured from `now`.
 */
const UNIT = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5 };
export function parseDue(due, now = Date.now()) {
  if (due == null || due === '') return null;
  const s = String(due).trim().toLowerCase();
  const rel = /^(?:in\s+)?((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)$/.exec(s);
  if (rel && /^in\s/.test(s)) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
      if (!UNIT[u]) return undefined;
      ms += parseFloat(n) * UNIT[u];
    }
    return ms > 0 ? now + ms : undefined;
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T10:00`) : new Date(String(due).trim());
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

/** When the next reminder is due (ms), so the timer can sleep until exactly then. */
export function nextDue() {
  const t = openCommitments().filter((c) => c.due && !c.remindedAt).map((c) => c.due);
  return t.length ? Math.min(...t) : null;
}

export const openCommitments = () => loadMemory().commitments.filter((c) => c.status === 'open');

/** Local midnight at the start of the day `ms` falls in. */
export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** What the on-screen list shows: open items, plus ones finished today (struck through). Today = due today or
 *  overdue, and things finished today; Later = due after today, or no time. Soonest first, undated last. */
export function listItems(now = Date.now()) {
  const today = startOfDay(now), tomorrow = startOfDay(today + 36 * 36e5);
  const shown = loadMemory().commitments.filter((c) => c.status === 'open' || (c.status === 'done' && (c.doneAt ?? 0) >= today));
  const item = (c) => ({ id: c.id, text: c.text, due: c.due, done: c.status === 'done', overdue: c.status === 'open' && !!c.due && c.due < now, kind: c.kind ?? 'commitment' });
  const order = (a, b) => ((a.status === 'done') - (b.status === 'done')) || ((a.due ?? Infinity) - (b.due ?? Infinity)) || a.createdAt - b.createdAt;
  const isToday = (c) => (c.status === 'done' ? (c.due == null || c.due < tomorrow) : c.due != null && c.due < tomorrow);
  return {
    today: shown.filter(isToday).sort(order).map(item),
    later: shown.filter((c) => !isToday(c)).sort(order).map(item),
  };
}

/** Deletes finished (done or dropped) entries from before today. Open ones are never touched. Returns how many went. */
export async function clearFinished(now = Date.now()) {
  const today = startOfDay(now), m = loadMemory(), before = m.commitments.length;
  m.commitments = m.commitments.filter((c) => c.status === 'open' || (c.doneAt ?? c.createdAt) >= today);
  if (m.commitments.length === before) return 0;
  await saveMemory();
  return before - m.commitments.length;
}

/** kind 'reminder': a plain "remind me", done once it has fired. 'commitment' (and older entries without a kind):
 *  something the user said they'd do, open until they finish or drop it. */
export async function addCommitment(text, dueMs, kind = 'commitment') {
  const c = { id: newId('c'), text: String(text).trim().slice(0, 200), due: dueMs ?? null, createdAt: Date.now(), status: 'open', remindedAt: null, kind: kind === 'reminder' ? 'reminder' : 'commitment' };
  loadMemory().commitments.push(c);
  // Cap the file: the oldest finished entries go first; open ones are never dropped.
  const done = memory.commitments.filter((x) => x.status !== 'open');
  if (memory.commitments.length > 200) {
    const drop = new Set(done.sort((a, b) => (a.doneAt ?? a.createdAt) - (b.doneAt ?? b.createdAt)).slice(0, memory.commitments.length - 200).map((x) => x.id));
    memory.commitments = memory.commitments.filter((x) => !drop.has(x.id));
  }
  await saveMemory();
  return c;
}

export async function updateCommitment(id, { status, dueMs }) {
  const c = loadMemory().commitments.find((x) => x.id === id);
  if (!c) return null;
  if (status) { c.status = status; if (status !== 'open') c.doneAt = Date.now(); }
  if (dueMs !== undefined) { c.due = dueMs; c.remindedAt = null; }
  await saveMemory();
  return c;
}

// ---------- facts (long-term memory about the user) ----------

const FACT_CAP = 150;
export const listFacts = () => loadMemory().facts.slice();

/** Saves a fact; a near-duplicate of an existing one replaces it instead of piling up. */
export async function addFact(text) {
  const t = String(text).trim().replace(/\s+/g, ' ').slice(0, 240);
  const key = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const facts = loadMemory().facts;
  const same = facts.find((f) => f.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key);
  if (same) { same.updatedAt = Date.now(); await saveMemory(); return same; }
  const f = { id: newId('f'), text: t, createdAt: Date.now() };
  facts.push(f);
  if (facts.length > FACT_CAP) facts.splice(0, facts.length - FACT_CAP); // oldest go first
  await saveMemory();
  return f;
}

// Picks which facts go into the prompt: the newest few always, then the ones that share words with
// what's being talked about, then the most recently used. Keeps the prompt small as memory grows.
const STOP = new Set('the a an and or but to of in on at for with is are was were be it this that my me i you your his her its our their what how when where why can do does just like about from have has had will would should could not no yes so if then than'.split(' '));
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function pickFacts(context = '', limit = 40) {
  const facts = loadMemory().facts;
  if (facts.length <= limit) return facts.slice();
  const ctx = words(context), byNew = facts.slice().sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const chosen = new Set(byNew.slice(0, 8).map((f) => f.id));
  const scored = facts.filter((f) => !chosen.has(f.id)).map((f) => {
    let hit = 0; for (const w of words(f.text)) if (ctx.has(w)) hit++;
    return { f, score: hit * 10 + ((f.usedAt ?? f.updatedAt ?? f.createdAt) / 1e12) };
  }).sort((a, b) => b.score - a.score);
  for (const { f } of scored) { if (chosen.size >= limit) break; chosen.add(f.id); }
  return facts.filter((f) => chosen.has(f.id));
}

/** Marks facts as used (they were in the prompt for a turn), so useful ones stay near the top. */
export function touchFacts(ids) {
  const now = Date.now(), set = new Set(ids);
  for (const f of loadMemory().facts) if (set.has(f.id)) f.usedAt = now;
}

export async function clearFacts() {
  const n = loadMemory().facts.length;
  memory.facts = [];
  await saveMemory();
  return n;
}

export async function forgetFact(id) {
  const facts = loadMemory().facts, i = facts.findIndex((f) => f.id === id);
  if (i < 0) return null;
  const [f] = facts.splice(i, 1);
  await saveMemory();
  return f;
}

/** Open commitments whose time has come and that haven't been reminded yet. Marks them reminded; plain
 *  reminders are done once they've fired, so they never hang around as overdue. */
export async function takeDueReminders(now = Date.now()) {
  const due = openCommitments().filter((c) => c.due && c.due <= now && !c.remindedAt);
  if (!due.length) return [];
  for (const c of due) {
    c.remindedAt = now;
    if (c.kind === 'reminder') { c.status = 'done'; c.doneAt = now; }
  }
  await saveMemory();
  return due;
}
