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

// act_in_app that only types a web address into a browser's bar becomes a direct open.
{
  const { typedAddress } = await import('../tools.mjs');
  const go = (t) => [{ do: 'type', text: t }, { do: 'key', key: 'return' }];
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('example.com'), { do: 'wait', seconds: 2 }]), 'example.com');
  assert.equal(typedAddress('Safari', [{ do: 'click_text', text: 'smart search field' }, ...go('example.com')]), 'example.com');
  assert.equal(typedAddress('Google Chrome', [{ do: 'key', key: 'cmd+t' }, ...go('https://bbc.co.uk/news')]), 'https://bbc.co.uk/news');
  assert.equal(typedAddress('browser', [{ do: 'click_text', text: 'New Tab' }, ...go('example.com')]), 'example.com');
  // Not just opening a link: leave it alone.
  assert.equal(typedAddress('TextEdit', [{ do: 'key', key: 'cmd+l' }, ...go('example.com')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('cheap flights to rome')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'click_text', text: 'Search' }, ...go('example.com')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('example.com'), { do: 'click_text', text: 'More information' }]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, { do: 'type', text: 'example.com' }]), null);
  assert.equal(typedAddress('Safari', [{ do: 'fill', field: 'Email', text: 'a@b.com' }, ...go('example.com')]), null);
  console.log('typed address ok');
}
