// Correction signal: window, threshold, prior take must be voice, text gate, telemetry off. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCorrections, levenshtein, recordCorrection } from '../stt-correction.mjs';
import { createTelemetry, newRequestId } from '../telemetry.mjs';

assert.equal(levenshtein('kitten', 'sitting'), 3);
assert.equal(levenshtein('', 'abc'), 3);
assert.equal(levenshtein('same', 'same'), 0);

let t = 0;
const now = () => t;
const v = (c, text, kind = 'request', rid = 'r1') => c.noteVoice({ rid, text, engine: 'moonshine', kind });

// re-ask within the window with a close text
{
  const c = createCorrections({ now }); t = 0;
  v(c, 'Open the wether app.');
  t = 10_000;
  assert.deepEqual(c.check({ text: 'open the weather app', kind: 'request' }), { kind: 'reask', edit_distance: 1, chars: 20, of: 'r1', engine: 'moonshine' });
  assert.equal(c.check({ text: 'open the weather app', kind: 'request' }), null, 'one correction per take');
}
// outside the window
{
  const c = createCorrections({ now }); t = 0;
  v(c, 'open the weather app');
  t = 30_001;
  assert.equal(c.check({ text: 'open the weather app', kind: 'request' }), null);
}
// too different: a new request, not a correction (threshold 40 % of the longer text)
{
  const c = createCorrections({ now }); t = 0;
  v(c, 'open the weather app');
  assert.equal(c.check({ text: 'what time is it in tokyo', kind: 'request' }), null);
  assert.ok(c.check({ text: 'open the weather', kind: 'request' }), 'a shorter retry still counts');
}
// the prior take must be voice: typed requests alone never count; kinds don't cross
{
  const c = createCorrections({ now }); t = 0;
  assert.equal(c.check({ text: 'open the weather app', kind: 'request' }), null);
  v(c, 'dear sam thanks', 'dictation', 'd1');
  assert.equal(c.check({ text: 'dear sam thanks', kind: 'request' }), null, 'a dictation is not re-asked by a request');
  assert.deepEqual(c.check({ text: 'Dear Sam, thanks!', kind: 'dictation' }), { kind: 'redictate', edit_distance: 0, chars: 15, of: 'd1', engine: 'moonshine' });
}

// recording: distance only unless include text; telemetry off writes nothing
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-correction-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const R1 = newRequestId(), R2 = newRequestId();
const attrs = { kind: 'reask', edit_distance: 1, chars: 20, of: R1, engine: 'moonshine' };
const events = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))) : [];
for (const [includeText, enabled] of [[false, true], [true, true], [true, false]]) {
  const dir = path.join(TMP, `${includeText}-${enabled}`);
  const tel = createTelemetry({ dir, includeText, enabled, timer: false });
  recordCorrection(tel, R2, attrs, 'open the weather app');
  recordCorrection(tel, newRequestId(), null, 'not a correction');
  await tel.flush();
  const got = events(dir);
  if (!enabled) { assert.equal(got.length, 0, 'telemetry off writes nothing'); continue; }
  assert.equal(got.length, 1);
  assert.equal(got[0].step, 'stt_correction');
  assert.equal(got[0].request_id, R2);
  assert.equal(got[0].attrs.of, R1, 'the corrected take is linked');
  assert.equal(got[0].attrs.edit_distance, 1);
  assert.equal('text' in got[0].attrs, includeText, `text only with include text (${includeText})`);
}
console.log('stt-correction ok');
