// What gets said out loud in voice mode. The reply streams in as text (emote tags already removed); this
// picks out the spoken part a sentence at a time, so speech can start before the reply is finished:
// - prose is spoken; list lines ("- ", "1. "), quotes ("> ", drafts), headings, tables, code blocks and the
//   "Sources:" line are for the screen only (lists and drafts show on screen, never read out).
// - markdown, links, URLs, emoji, file paths and long code are dropped from what's said.
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g;
const SCREEN_ONLY = /^\s*(?:[-*•+]\s|\d{1,2}[.)]\s|>|#{1,6}\s|\||sources?\s*:)/i;
const LONG = 220; // speak a run-on sentence in pieces rather than wait for its end

// Fish Audio S2 voice cues: [chuckling], [warm], [break]… shape how a line is said (tested on the JARVIS voice:
// they're performed, not read out). Only these are kept for the voice; on screen they're never shown.
// Every cue in Fish Audio's emotion guide (docs.fish.audio/developer-guide/core-features/emotions), plus the
// extra moods its examples use and a few of ours. All verified on the JARVIS voice by voice-samples.
export const VOICE_CUES = {
  // 24 basic and 25 advanced emotions, then the ones Fish's examples use, then ours.
  emotions: [
    'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'satisfied', 'delighted', 'scared', 'worried',
    'upset', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful', 'curious', 'sarcastic',
    'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain', 'doubtful', 'confused', 'disappointed', 'regretful', 'guilty',
    'ashamed', 'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored', 'contemptuous', 'sympathetic',
    'compassionate', 'determined', 'resigned',
    'friendly', 'enthusiastic', 'encouraging', 'mysterious', 'relieved', 'urgent', 'furious', 'terrified', 'interested', 'ecstatic',
    'helpful', 'concerned', 'triumphant', 'brave', 'narrator',
    'warm', 'playful', 'amused', 'thoughtful', 'serious', 'gentle', 'teasing', 'dry',
    'caring', 'kind', 'soothing', 'reassuring', 'cheerful', 'apologetic', 'sincere', 'tender', 'upbeat', 'solemn', 'sheepish',
    'impressed', 'wistful', 'mischievous', 'deadpan', 'cheeky',
  ],
  // How it's said: anywhere in a sentence ([emphasis] right before the word).
  tones: ['in a hurry tone', 'shouting', 'screaming', 'whispering', 'soft tone', 'emphasis'],
  // Human sounds: best followed by the sound in words ("[laughing] Ha ha").
  sounds: ['laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing', 'groaning', 'panting', 'gasping', 'yawning', 'snoring', 'clear throat'],
  // Background and pauses.
  effects: ['audience laughing', 'background laughter', 'crowd laughing', 'break', 'long-break'],
};
export const CUE_INTENSITY = ['slightly', 'very', 'extremely', 'a bit', 'a little', 'quietly', 'deeply'];
const alt = (list) => list.slice().sort((a, b) => b.length - a.length).map((x) => x.replace(/[-]/g, '\\-')).join('|');
const MOOD = alt(VOICE_CUES.emotions);
const DELIVERY = alt([...VOICE_CUES.tones, ...VOICE_CUES.sounds, ...VOICE_CUES.effects]);
const CUE_BODY = `(?:(?:${alt(CUE_INTENSITY)})\\s+)?(?:(?:${MOOD})(?:(?:,\\s*|\\s+and\\s+)(?:${MOOD}))?|${DELIVERY})`;
export const CUE = new RegExp(`\\[(?:${CUE_BODY})\\]`, 'gi');
const IS_CUE = new RegExp(`^\\[(?:${CUE_BODY})\\]$`, 'i');
// S2 also takes free descriptions ("[caring]", "[quietly proud]"). One that isn't on the list counts as a cue
// only where cues go: lowercase, a few words, at the start of a sentence. Mid-sentence brackets (a draft's
// "[landlord name]") stay text.
const LOOSE = /^\[[a-z]+(?:[ ,-]+[a-z]+){0,3}\]$/;
const SENTENCE_START = /(?:^|[.!?…]["'”’)]*)\s*$/;
// The body's emote tags set the tone of what follows when the model gave none.
export const EMOTE_TONE = { hype: '[excited]', upset: '[frustrated]', motivate: '[encouraging]', wave: '[warm]', remind: '[serious]' };

/** Streaming: drops voice cues from text that's shown, even when a cue is split across chunks. */
export class CueFilter {
  constructor() { this.held = ''; this.trim = true; this.space = true; this.before = ''; } // before: the end of what's been shown // space: what's been shown so far ends in a space (or is nothing) // trim: drop the spaces a removed cue leaves behind
  push(text) {
    let s = this.held + text, out = '';
    this.held = '';
    if (this.trim) { s = s.replace(/^[ \t]+/, ''); if (!s) return ''; this.trim = false; }
    for (;;) {
      const i = s.indexOf('[');
      if (i < 0) { out += s; return this.shown(out); }
      out += s.slice(0, i);
      const j = s.indexOf(']', i);
      if (j < 0) {
        // Could still become a cue: wait for more (up to the longest cue's length).
        if (s.length - i <= 40) { this.held = s.slice(i); return this.shown(out); }
        out += s[i]; s = s.slice(i + 1); continue;
      }
      const tag = s.slice(i, j + 1);
      const loose = !IS_CUE.test(tag) && LOOSE.test(tag) && SENTENCE_START.test(this.before + out);
      // A link's "[name](url)" is never a cue: wait to see what follows the "]".
      if (loose && j + 1 === s.length) { this.held = s.slice(i); return this.shown(out); }
      if (IS_CUE.test(tag) || (loose && s[j + 1] !== '(')) {
        s = s.slice(j + 1);
        // "a. [cue] b" → "a. b": the space before the cue stays, the one after goes (now or in the next chunk).
        if (/\s$/.test(out) || (!out && this.space)) { s = s.replace(/^[ \t]+/, ''); if (!s) this.trim = true; }
      }
      else { out += s[i]; s = s.slice(i + 1); }
    }
  }
  shown(out) { if (out) { this.space = /\s$/.test(out); this.before = (this.before + out).slice(-12); } return out; }
  flush() { const h = this.held; this.held = ''; return h; }
}

export function speakable(text) {
  let s = String(text ?? '');
  s = s.replace(/\[([^\]]*)\]\((?:https?:|mailto:)[^)]*\)/g, '$1') // [name](url) → name
    .replace(/<?\b(?:https?:\/\/|www\.)\S+/gi, (u) => u.match(/[.,!?;:)>]*$/)[0].replace(/>/g, '')) // bare URLs (keep the full stop)
    .replace(/`([^`]*)`/g, (_, c) => (c.length > 24 || /[/\\{}();=<>]|^\S+\.[a-z0-9]{1,5}$/i.test(c) ? '' : c)) // code: short words only
    .replace(/(\*\*|__|\*|~~)(?=\S)([^*~]*?\S)\1/g, '$2') // bold, italic, strike
    .replace(/(?:^|\s)(?:~|\/)?(?:[\w.-]+\/){2,}[\w-]*(?:\.\w+)*/g, ' ') // file paths (the sentence's full stop stays)
    .replace(/\[([^\]]{1,40})\]/g, (m, inner, at, all) => (IS_CUE.test(m) || (LOOSE.test(m) && SENTENCE_START.test(all.slice(0, at))) ? m.toLowerCase() : inner)) // voice cues stay; [placeholders] lose their brackets (Fish would act them out)
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(s.replace(CUE, '')) ? s : '';
}

export class SpeechText {
  constructor(emit) {
    this.emit = emit; // (sentence) => void, each one cleaned and non-empty
    this.buf = '';
    this.atLineStart = true;
    this.fence = false;
    this.skip = false; // inside a screen-only line
    this.tone = null; // a cue for the next sentence, from the body's emote, when it has none of its own
  }

  /** The body's emote ([hype] etc.) colours the next sentence. */
  emote(action) { if (EMOTE_TONE[action]) this.tone = EMOTE_TONE[action]; }

  push(text) { this.buf += text; this.drain(false); }

  /** Before a tool call and at the end of a turn: say what's there even without a sentence end. */
  flush() { this.drain(true); }

  out(s) {
    let t = speakable(s);
    if (!t) return;
    if (this.tone) { if (!/^\[/.test(t)) t = `${this.tone} ${t}`; this.tone = null; }
    this.emit(t);
  }

  drain(all) {
    for (;;) {
      if (!this.buf) return;
      if (this.atLineStart) {
        const nl = this.buf.indexOf('\n');
        const head = (nl < 0 ? this.buf : this.buf.slice(0, nl)).trimStart();
        // Not enough of the line yet to know what kind it is ("1" could become "1. ").
        const maybeSources = head && 'sources:'.startsWith(head.toLowerCase().replace(/\s+$/, ''));
        if (nl < 0 && !all && (maybeSources || (head.length < 9 && !/[\p{L}]{3}/u.test(head)))) return;
        this.atLineStart = false;
        if (/^```|^~~~/.test(head)) { this.fence = !this.fence; this.skip = true; }
        else this.skip = this.fence || SCREEN_ONLY.test(head);
      }
      const nl = this.buf.indexOf('\n');
      if (this.skip) {
        if (nl < 0) { if (all) this.buf = ''; return; }
        this.buf = this.buf.slice(nl + 1);
        this.atLineStart = true; this.skip = false;
        continue;
      }
      if (nl === 0) { this.buf = this.buf.slice(1); this.atLineStart = true; continue; } // blank line
      // Prose: a full line, or a sentence that has ended.
      const line = nl < 0 ? this.buf : this.buf.slice(0, nl);
      SENTENCE_END.lastIndex = 0;
      let cut = -1, m;
      while ((m = SENTENCE_END.exec(line))) { if (m.index + m[0].length < line.length || nl >= 0) { cut = m.index + m[0].length; break; } }
      if (cut < 0 && nl >= 0) cut = nl;
      if (cut < 0 && line.length > LONG) { const sp = line.lastIndexOf(', ', LONG); cut = sp > 40 ? sp + 1 : line.lastIndexOf(' ', LONG); }
      if (cut <= 0) {
        if (all) { this.out(this.buf); this.buf = ''; }
        return;
      }
      this.out(line.slice(0, cut));
      this.buf = this.buf.slice(cut);
      if (cut === nl || /^\n/.test(this.buf)) { this.buf = this.buf.replace(/^\n/, ''); this.atLineStart = true; }
      else this.buf = this.buf.replace(/^[ \t]+/, '');
    }
  }
}
