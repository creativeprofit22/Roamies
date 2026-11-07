// The context benchmark's cache model and pairing, on built-in requests (no saved conversations, no network). Run: npm test
import assert from 'node:assert/strict';
import { createCache, offline, syntheticRequests, verdict } from '../bench/context.bench.mjs';

// Cache model: a growing conversation reads what the last call stored; changing an early message re-sends the rest.
{
  const opts = { budget: 1e6, systemTokens: 1000, liveChars: 0, imageTokens: 100, charsPerToken: 1 };
  const c = createCache(opts);
  const u = (t) => ({ role: 'user', content: t }), a = (t) => ({ role: 'assistant', content: t });
  const h = [u('x'.repeat(500)), a('y'.repeat(500)), u('z'.repeat(500))];
  const first = c.call(h);
  assert.equal(first.read, 0);
  const second = c.call([...h, a('ok'), u('w'.repeat(500))]);
  assert.equal(second.read, 2500, 'system and the first request come from the cache');
  assert.equal(second.broke, false);
  const changed = c.call([u('X'.repeat(500)), ...h.slice(1), a('ok'), u('w'.repeat(500))]);
  assert.equal(changed.broke, true, 'an edit at the start is a break');
}

// Paired run: same days through both policies; the new one never costs more on screenshot-heavy days.
{
  const r = await offline({ runs: 12, seed: 3, budget: 30000, requests: syntheticRequests() });
  const all = r.compare.all;
  assert.equal(all.days, 12);
  assert.ok(all.total_cost_saving.mean > 0.15, `saves on the built-in screenshot-heavy days (${all.total_cost_saving.mean})`);
  assert.ok(all.breaks_per_call[1] < all.breaks_per_call[0]);
  assert.ok(all.trims[1] < all.trims[0], 'trims less often');
  assert.equal(verdict({ all: { total_cost_saving: { lo: 0.2, hi: 0.4 } } }, 0.15), 'on_target');
  assert.equal(verdict({ all: { total_cost_saving: { lo: 0.01, hi: 0.1 } } }, 0.15), 'missed');
  assert.equal(verdict({ all: { total_cost_saving: { lo: 0.1, hi: 0.3 } } }, 0.15), 'unclear');
}
// Number-heavy day (text tokenises at 1.8 letters per token): the current policy, calibrating its rate like the
// sidecar, trims more than it would at the fixed 3.6 default.
{
  const num = { runs: 6, seed: 5, budget: 30000, requests: syntheticRequests(), charsPerToken: 1.8 };
  const on = await offline(num), off = await offline({ ...num, calibrate: false });
  const trimmed = (r) => r.compare.all.trimmed_tokens[1];
  assert.ok(trimmed(on) > trimmed(off), `calibrated trims more (${trimmed(on)} vs ${trimmed(off)})`);
  assert.ok(on.compare.all.sent_per_call[1] < off.compare.all.sent_per_call[1], 'and sends less per call');
  assert.deepEqual(on.compare.all.trims[0], off.compare.all.trims[0], 'the baseline is unchanged');
}
console.log('context bench tests passed');
