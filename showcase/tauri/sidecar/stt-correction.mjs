// Correction signal: a voice request re-asked (or a dictation re-dictated) within the window, with a
// close enough text, means the first transcript was probably wrong. Only the edit distance is logged.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

export function levenshtein(a, b) {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

const KIND = { request: 'reask', dictation: 'redictate' };

export function createCorrections({ now = Date.now, windowMs = 30_000, maxRatio = 0.4 } = {}) {
  const last = new Map(); // kind -> the last voice take of that kind
  return {
    /** A voice transcript was used as a request or a dictation. */
    noteVoice({ rid, text, engine, kind }) {
      const t = norm(text);
      if (t && KIND[kind]) last.set(kind, { rid, text: t, engine, at: now() });
    },
    /** A new request or dictation (any source). Returns stt_correction attrs, or null. */
    check({ text, kind }) {
      const prior = last.get(kind);
      if (!prior) return null;
      if (now() - prior.at > windowMs) { last.delete(kind); return null; }
      const t = norm(text);
      if (!t) return null;
      const chars = Math.max(t.length, prior.text.length);
      const edit_distance = levenshtein(prior.text, t);
      if (edit_distance > maxRatio * chars) return null;
      last.delete(kind); // one correction per take
      return { kind: KIND[kind], edit_distance, chars, of: prior.rid, engine: prior.engine };
    },
  };
}

/** Logs the event; the corrected text goes in only when "include text" is on. */
export function recordCorrection(tel, requestId, attrs, text) {
  if (!attrs) return;
  tel.record('stt_correction', { requestId, attrs: { ...attrs, ...(tel.includeText ? { text } : {}) } });
}
