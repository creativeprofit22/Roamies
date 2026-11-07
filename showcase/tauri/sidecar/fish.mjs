// Spoken replies through Fish Audio's live text-to-speech socket (wss://api.fish.audio/v1/tts/live, MessagePack).
// One socket per reply, opened as soon as the request starts so it's ready by the first sentence (opening
// costs 0.4–1.4 s; text to first audio on an open socket is ~0.4 s). Sentences are sent as they're ready, each
// flushed so it's spoken straight away. Raw 16-bit mono PCM comes back in chunks for the overlay to play.
import { encode, decode } from './msgpack.mjs';

export const FISH_API = 'https://api.fish.audio';
export const FISH_LIVE = 'wss://api.fish.audio/v1/tts/live';
// Drama 3 acts out the voice cues far more than S2.1 Pro (measured on all four voices); S2.1 Pro is the paid
// fallback and the free tier the last one, for an account with no credit.
export const FISH_MODELS = ['drama-3', 's2.1-pro', 's2.1-pro-free'];
export const FREE_MODEL = FISH_MODELS[FISH_MODELS.length - 1];
// The two the user picks between (Settings > Voice in the panel), most expressive first. perM: USD per million
// UTF-8 bytes of text sent, from docs.fish.audio Pricing & Rate Limits (Nov 2026); promo: Drama 3's launch price.
export const FISH_CHOICES = [
  { id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } },
  { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 },
];
export const DEFAULT_VOICE = 'e13fa398a7f445a685316a3de6089ce7';
export const RATE = 44100;

// The voice's settings: balanced latency measured as fast as "low" (~0.4 s) with better quality. Loudness isn't
// normalized: that flattened a whisper and a shout to the same level (1-8 dB apart; 10-28 dB without it, no clipping).
export const startRequest = (voice) => ({
  text: '', reference_id: voice, format: 'pcm', sample_rate: RATE, latency: 'balanced',
  temperature: 0.7, top_p: 0.7, chunk_length: 100, normalize: true, condition_on_previous_chunks: true,
  prosody: { speed: 1, volume: 0, normalize_loudness: false },
});

/** Is the key good, and is there credit for the production model? Never throws. */
export async function fishAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${FISH_API}/wallet/self/api-credit`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    const j = await r.json().catch(() => ({}));
    const credit = Number.parseFloat(j.credit);
    return { ok: true, credit: Number.isFinite(credit) ? credit : null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * One reply's voice. say() as many times as needed, then end(). abort() stops at once, silently.
 * onAudio(Uint8Array) gets PCM (whole 16-bit samples); onEnd() once after the last audio; onError(err) instead
 * of onEnd when it fails (heard = whether any audio had arrived, so a caller can retry on another model).
 */
export class FishVoice {
  constructor({ key, voice = DEFAULT_VOICE, model = FISH_MODELS[0], WebSocketImpl = globalThis.WebSocket, onAudio, onEnd, onError, openTimeout = 6000, audioTimeout = 8000 }) {
    Object.assign(this, { key, voice, model, WebSocketImpl, onAudio, onEnd, onError, openTimeout, audioTimeout });
    this.queue = []; // encoded messages waiting for the socket to open
    this.state = 'new'; // new → opening → open → ending → done
    this.heard = false;
    this.said = 0;
    this.odd = null; // a byte left over from a chunk with an odd length
    this.timer = null;
  }

  open() {
    if (this.state !== 'new') return this;
    this.state = 'opening';
    let ws;
    try { ws = new this.WebSocketImpl(FISH_LIVE, { headers: { Authorization: `Bearer ${this.key}`, model: this.model } }); }
    catch (e) { return this.fail(e), this; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.arm(this.openTimeout, 'Fish Audio took too long to connect');
    ws.onopen = () => {
      if (this.state === 'done') return;
      this.state = this.state === 'ending' ? 'ending' : 'open';
      this.clear();
      ws.send(encode({ event: 'start', request: startRequest(this.voice) }));
      for (const m of this.queue.splice(0)) ws.send(m);
      if (this.said) this.arm(this.audioTimeout, 'Fish Audio stopped sending audio');
    };
    ws.onmessage = (e) => {
      if (this.state === 'done') return;
      let m;
      try { m = decode(new Uint8Array(e.data)); } catch { return; }
      if (m.event === 'audio' && m.audio?.length) {
        this.heard = true;
        // Audio is flowing: after the last sentence, keep watching until it finishes; before that, the gap until
        // the next sentence is the model thinking (or a tool running), which can be long and is fine.
        if (this.state === 'ending') this.arm(this.audioTimeout, 'Fish Audio stopped sending audio'); else this.clear();
        this.onAudio?.(this.whole(m.audio));
      } else if (m.event === 'finish') {
        if (m.reason === 'error') return this.fail(new Error('Fish Audio could not finish speaking'));
        this.finish();
      } else if (m.event === 'error') this.fail(new Error(`Fish Audio: ${m.error ?? 'error'}`));
    };
    ws.onerror = () => this.fail(new Error(this.heard ? 'Fish Audio connection dropped' : 'Could not reach Fish Audio'));
    ws.onclose = () => { if (this.state !== 'done') this.fail(new Error('Fish Audio closed the connection')); };
    return this;
  }

  send(msg) {
    const m = encode(msg);
    if (this.state === 'open' || (this.state === 'ending' && this.ws?.readyState === 1)) this.ws.send(m); else this.queue.push(m);
  }

  say(text) {
    if (this.state === 'done' || this.state === 'ending' || !text) return;
    if (this.state === 'new') this.open();
    this.said++;
    this.send({ event: 'text', text: `${text} ` });
    this.send({ event: 'flush' });
    if (this.state !== 'opening' && !this.timer) this.arm(this.audioTimeout, 'Fish Audio stopped sending audio');
  }

  end() {
    if (this.state === 'done' || this.state === 'ending') return;
    if (!this.said) return this.close(), this.onEnd?.();
    this.send({ event: 'stop' });
    this.state = 'ending';
    if (!this.timer) this.arm(this.audioTimeout, 'Fish Audio stopped sending audio');
  }

  abort() { this.close(); }

  // PCM samples are 2 bytes; a chunk can end mid-sample, so carry the odd byte into the next one.
  whole(bytes) {
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (this.odd != null) { const c = new Uint8Array(b.length + 1); c[0] = this.odd; c.set(b, 1); b = c; this.odd = null; }
    if (b.length % 2) { this.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    return b;
  }

  arm(ms, why) { this.clear(); this.timer = setTimeout(() => this.fail(new Error(why)), ms); }
  clear() { clearTimeout(this.timer); this.timer = null; }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clear();
    this.queue.length = 0;
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  finish() { if (this.state === 'done') return; this.close(); this.onEnd?.(); }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}
