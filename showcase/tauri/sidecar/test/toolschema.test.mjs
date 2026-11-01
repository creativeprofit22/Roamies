// Tool schemas every provider accepts. Run: npm test
import assert from 'node:assert/strict';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { createTools } from '../tools.mjs';

const noop = async () => {};
const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });

// Regression: fetch_url's url had format "uri", which OpenAI strict schemas reject, failing every OpenAI request.
const formats = [];
const walk = (name, node, at) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(name, n, `${at}/${i}`));
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'format') formats.push(`${name}${at}: ${v}`);
    walk(name, v, `${at}/${k}`);
  }
};
for (const t of tools) walk(t.name, resolveToolSchema(t), '');
assert.deepEqual(formats, [], 'no tool uses a string format');
console.log('tool schema ok');
