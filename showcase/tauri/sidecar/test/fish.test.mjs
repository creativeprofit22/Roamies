import assert from 'node:assert/strict';
import { encode, decode } from '../msgpack.mjs';
import { FishVoice, fishAccount, startRequest, FISH_LIVE } from '../fish.mjs';

// MessagePack round trips, including the shapes Fish sends and expects.
for (const v of [null, true, false, 0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, -1, -32, -33, -129, -40000, 0.5, -2.25, '', 'hi', 'é✓', 'x'.repeat(40), 'y'.repeat(300), 'z'.repeat(70000),
  [], [1, [2, [3]]], Array.from({ length: 20 }, (_, i) => i), {}, { a: 1, b: { c: [true, null] } }, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])),
  { event: 'start', request: startRequest('voice-id') }]) assert.deepEqual(decode(encode(v)), v, JSON.stringify(v)?.slice(0, 60));
const bin = new Uint8Array([1, 2, 3, 250]);
assert.deepEqual(decode(encode({ event: 'audio', audio: bin })), { event: 'audio', audio: bin });
assert.deepEqual(decode(encode(new Uint8Array(70000))).length, 70000);
assert.throws(() => decode(new Uint8Array([0xa5, 0x61])), /truncated/);
assert.equal(startRequest('v').format, 'pcm');
assert.equal(startRequest('v').latency, 'balanced');
assert.equal(startRequest('v').prosody.normalize_loudness, false, 'normalizing flattens a whisper and a shout to one level');

// A fake socket that records what was sent and lets the test play the server.
class FakeWS {
  static last;
  constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; FakeWS.last = this; }
  send(b) { this.sent.push(decode(b)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  server(m) { this.onmessage?.({ data: encode(m).buffer }); }
}
const run = (opts = {}) => {
  const got = { audio: [], ended: 0, errors: [] };
  const v = new FishVoice({ key: 'sk-test', voice: 'vid', WebSocketImpl: FakeWS, onAudio: (a) => got.audio.push(a), onEnd: () => got.ended++, onError: (e) => got.errors.push(e), ...opts });
  return { v, got };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ // Opened early; text said before it opens is queued, then sent after "start", each sentence flushed.
  const { v, got } = run();
  v.open();
  const ws = FakeWS.last;
  assert.equal(ws.url, FISH_LIVE);
  assert.deepEqual(ws.opts.headers, { Authorization: 'Bearer sk-test', model: 'drama-3' });
  v.say('Sure, one sec.');
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.deepEqual(ws.sent.map((m) => m.event), ['start', 'text', 'flush']);
  assert.equal(ws.sent[0].request.reference_id, 'vid');
  assert.equal(ws.sent[1].text, 'Sure, one sec. ');
  v.say('It is 36.');
  v.end();
  assert.deepEqual(ws.sent.map((m) => m.event), ['start', 'text', 'flush', 'text', 'flush', 'stop']);
  ws.server({ event: 'audio', audio: new Uint8Array([1, 2, 3]) }); // odd length: the last byte waits
  ws.server({ event: 'audio', audio: new Uint8Array([4, 5, 6]) });
  assert.deepEqual(got.audio.map((a) => [...a]), [[1, 2], [3, 4, 5, 6]]);
  ws.server({ event: 'finish', reason: 'stop' });
  assert.equal(got.ended, 1); assert.equal(got.errors.length, 0); assert.ok(ws.closed);
  ws.server({ event: 'audio', audio: new Uint8Array([9, 9]) }); // late audio after finish is ignored
  assert.equal(got.audio.length, 2);
}
{ // Nothing said: end() just closes and reports done, no "stop" sent.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.end();
  assert.equal(got.ended, 1); assert.deepEqual(FakeWS.last.sent.map((m) => m.event), ['start']);
}
{ // Abort is silent and final.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('Hello.'); v.abort(); v.say('More.');
  FakeWS.last.server({ event: 'audio', audio: new Uint8Array([1, 2]) });
  assert.deepEqual([got.audio.length, got.ended, got.errors.length], [0, 0, 0]);
}
{ // Server error (bad voice) → onError, flagged as nothing heard, socket closed.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('Hi.');
  FakeWS.last.server({ event: 'error', error: 'Reference not found' });
  assert.equal(got.errors.length, 1); assert.match(got.errors[0].message, /Reference not found/); assert.equal(got.errors[0].heard, false);
}
{ // Connection refused (bad key or no credit) → one error, never an end.
  const { v, got } = run();
  v.open(); v.say('Hi.'); FakeWS.last.onerror?.({}); FakeWS.last.onclose?.({});
  assert.equal(got.errors.length, 1); assert.equal(got.ended, 0);
}
{ // finish with reason "error" is a failure.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('Hi.'); FakeWS.last.server({ event: 'finish', reason: 'error' });
  assert.equal(got.errors.length, 1);
}
{ // Timeouts: never opens; opens but no audio after text. No timeout while just waiting for the next sentence.
  const a = run({ openTimeout: 30 }); a.v.open(); await sleep(60);
  assert.match(a.got.errors[0]?.message ?? '', /too long to connect/);
  const b = run({ audioTimeout: 30 }); b.v.open(); FakeWS.last.open(); b.v.say('Hi.'); await sleep(60);
  assert.match(b.got.errors[0]?.message ?? '', /stopped sending audio/);
  const c = run({ audioTimeout: 30 }); c.v.open(); const ws = FakeWS.last; ws.open(); c.v.say('Hi.');
  ws.server({ event: 'audio', audio: new Uint8Array([1, 2]) });
  await sleep(60); // the model is still thinking: fine
  assert.equal(c.got.errors.length, 0);
  c.v.end(); await sleep(60); // but after the last sentence, audio must finish
  assert.match(c.got.errors[0]?.message ?? '', /stopped sending audio/); assert.equal(c.got.errors[0].heard, true);
}
{ // A socket that throws on construction fails cleanly.
  const { v, got } = run({ WebSocketImpl: class { constructor() { throw new Error('nope'); } } });
  v.open(); assert.equal(got.errors.length, 1);
}

// Account check: key problems and network problems are told apart; never throws.
const fake = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });
assert.deepEqual(await fishAccount('k', { fetchImpl: fake(200, { credit: '4.55' }) }), { ok: true, credit: 4.55 });
assert.deepEqual(await fishAccount('k', { fetchImpl: fake(200, {}) }), { ok: true, credit: null });
assert.deepEqual(await fishAccount('k', { fetchImpl: fake(401, {}) }), { ok: false, reason: 'key' });
assert.deepEqual(await fishAccount('k', { fetchImpl: fake(500, {}) }), { ok: false, reason: 'network' });
assert.deepEqual(await fishAccount('k', { fetchImpl: async () => { throw new Error('offline'); } }), { ok: false, reason: 'network' });
console.log('fish voice tests: passed');
{ // The choices the panel offers: real paid models, priciest first (falling back only goes cheaper), prices set.
  const { FISH_CHOICES, FISH_MODELS, FREE_MODEL } = await import('../fish.mjs');
  assert.deepEqual(FISH_CHOICES.map((c) => c.id), ['drama-3', 's2.1-pro']);
  for (const c of FISH_CHOICES) { assert.ok(FISH_MODELS.includes(c.id) && c.id !== FREE_MODEL, c.id); assert.ok(c.perM > 0 && c.name, c.id); }
  assert.ok(FISH_MODELS.indexOf('drama-3') < FISH_MODELS.indexOf('s2.1-pro'), 'priciest first');
  assert.ok(!Number.isNaN(Date.parse(FISH_CHOICES[0].promo.until)));
}
