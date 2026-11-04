// Frozen copy of fitContext as it was before screenshot batching (store.mjs at 5cfff8f):
// the baseline the context benchmark measures the current policy against. Never edit to match store.mjs.
const SHOT = "[A screenshot was here and you did see it when you answered; the image was removed afterwards to save space, so its absence doesn't mean you didn't see it. The screen has likely changed since: look again before describing or pointing at what's on it now.]";
const stripImages = (content) =>
  Array.isArray(content) ? content.map((p) => (p?.type === 'image' ? { type: 'text', text: SHOT } : p)) : content;
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
export function baselineFitContext(messages, { budgetTokens, force = false }) {
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

