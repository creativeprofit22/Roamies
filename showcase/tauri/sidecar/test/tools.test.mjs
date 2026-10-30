// Tool schemas must be accepted by every provider (OpenAI strict mode rejects JSON Schema "format"). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-tools-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { createTools } = await import('../tools.mjs');

const noop = () => {};
const { tools } = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: () => '' });
assert.ok(tools.length > 5, 'tools built');
const formats = (node, at = '') => {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'format' && typeof v === 'string' ? [`${at} format "${v}"`] : formats(v, `${at}/${k}`)));
};
for (const t of tools) {
  const schema = t.rawInputSchema ?? z.toJSONSchema(t.parameters);
  assert.deepEqual(formats(schema), [], `${t.name} schema uses a format keyword`);
}
assert.ok(tools.some((t) => t.name === 'fetch_url'), 'fetch_url is checked');
console.log('tool schema tests: passed');
