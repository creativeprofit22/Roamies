// Markdown in the Sidekick's replies (showcase/roamies/markdown.js, shared with the overlay). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../../../roamies/markdown.js', import.meta.url), 'utf8'), ctx);
const md = ctx.Roamie.md;
const plain = (o) => JSON.parse(JSON.stringify(o));

// inline
assert.deepEqual(plain(md.inline('a **b** c')), [{ t: 'text', s: 'a ' }, { t: 'b', c: [{ t: 'text', s: 'b' }] }, { t: 'text', s: ' c' }]);
assert.deepEqual(plain(md.inline('use `npm i`')), [{ t: 'text', s: 'use ' }, { t: 'code', s: 'npm i' }]);
assert.deepEqual(plain(md.inline('[Docs](https://x.dev/a)')), [{ t: 'a', href: 'https://x.dev/a', c: [{ t: 'text', s: 'Docs' }] }]);
assert.deepEqual(plain(md.inline('[bad](javascript:alert(1))')), [{ t: 'text', s: 'bad' }, { t: 'text', s: ')' }], 'only http(s) and mailto links become links');
assert.deepEqual(plain(md.inline('2 * 3 * 4')), [{ t: 'text', s: '2 * 3 * 4' }], 'spaced stars are maths, not italics');
assert.deepEqual(plain(md.inline('snake_case_name')), [{ t: 'text', s: 'snake_case_name' }], 'underscores inside words stay');
assert.deepEqual(plain(md.inline('*it* and ~~gone~~')), [{ t: 'i', c: [{ t: 'text', s: 'it' }] }, { t: 'text', s: ' and ' }, { t: 's', c: [{ t: 'text', s: 'gone' }] }]);
assert.deepEqual(plain(md.inline('**open')), [{ t: 'text', s: '**open' }], 'an unclosed marker waits as text');
assert.deepEqual(plain(md.inline('\\*not italic\\*')), [{ t: 'text', s: '*not italic*' }], 'escapes');

// blocks
const b = plain(md.blocks('The answer is **42**.\n\n## Why\n- one\n- two\n  - two a\n1. first\n2. second\n\n> quoted\n\n```js\nconst x = 1;\n```\n---\n| A | B |\n|---|---|\n| 1 | 2 |\nSources: example.com'));
assert.deepEqual(b.map((x) => x.t), ['p', 'h', 'ul', 'ol', 'quote', 'code', 'hr', 'table', 'src']);
assert.equal(b[0].lead, true, 'the first paragraph is the lead');
assert.equal(b[1].level, 2);
assert.equal(b[2].items.length, 2);
assert.equal(b[2].items[1].sub.items.length, 1, 'nested bullet');
assert.equal(b[3].start, 1);
assert.equal(b[5].lang, 'js');
assert.equal(b[5].s, 'const x = 1;');
assert.equal(b[7].head.length, 2);
assert.equal(b[7].rows[0][1][0].s, '2');
assert.deepEqual(plain(md.blocks('```\nstill streaming')).map((x) => x.t), ['code'], 'an unclosed fence is code to the end');
assert.equal(plain(md.blocks('First.\nSecond line.'))[0].c[0].s, 'First. Second line.', 'soft line breaks join');

// flat (speech bubbles)
const f = md.flat('# Title\n- **bold** and `code`\n[link](https://a.b) ok');
assert.equal(f.s, 'Title\n• bold and code\nlink ok');
assert.equal(f.sty[0], md.BOLD, 'heading is bold');
assert.equal(f.sty[f.s.indexOf('bold')], md.BOLD);
assert.equal(f.sty[f.s.indexOf('code')], md.CODE);
assert.equal(f.sty[f.s.indexOf('link')], md.LINK);
assert.equal(f.sty.length, f.s.length, 'one style per character');
assert.equal(md.flat('so **impor').s, 'so impor', 'streaming: an open ** hides its marker');
assert.equal(md.flat('so **impor').sty[4], md.BOLD);
assert.equal(md.flat('see [the do').s, 'see [the do', 'a bracket alone stays');
assert.equal(md.flat('see [the docs](https://ex').s, 'see the docs', 'a link mid-stream shows its text');
assert.equal(md.flat('a\n```\nx = 1\n```\nb').s, 'a\nx = 1\nb', 'fences go, their lines stay');
console.log('markdown tests: passed');
