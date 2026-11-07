import assert from 'node:assert/strict';
import { createActivity, describe } from '../activity.mjs';

// Plain words, and never a path, command or search text.
assert.deepEqual(describe('read_file', { path: '/Users/ken/Secret Plans/notes.md' }), ['Reading notes.md', 'Read notes.md']);
assert.deepEqual(describe('run_command', { command: 'rm -rf ~/x' }), ['Running a command', 'Ran a command']);
assert.deepEqual(describe('fetch_url', { url: 'https://www.example.com/a?token=1' }), ['Opening example.com', 'Read example.com']);
assert.deepEqual(describe('search_files', { pattern: 'password' }), ['Searching your files', 'Searched your files']);
assert.deepEqual(describe('take_screenshot', { target: 'screen' }), ['Looking at your screen', 'Looked at your screen']);
assert.deepEqual(describe('take_screenshot', { target: 'Safari' }), ['Looking at Safari', 'Looked at Safari']);
assert.deepEqual(describe('open', { target: 'https://github.com/x' }), ['Opening github.com', 'Opened github.com']);
assert.deepEqual(describe('list_files', { dir: 'C:\\Users\\ken\\Desktop\\' }), ['Looking in Desktop', 'Looked in Desktop']);
assert.equal(describe('plan_steps', {}), null);
assert.equal(describe('fetch_url', { url: 'not a url' })[1], 'Read a page');

// The recent list: newest first, capped; failures say so; "doing" is the tool still running.
let t = 0;
const a = createActivity({ max: 3, now: () => ++t });
a.asked('what is on my calendar today and can you move the standup to 10am please, thanks so much buddy');
assert.equal(a.recent[0].kind, 'ask');
assert.ok(a.recent[0].text.length <= 80 && a.recent[0].text.endsWith('…'));
assert.equal(a.start('1', 'web_search', {}), 'Searching the web');
assert.equal(a.doing(), 'Searching the web');
a.end('1', false);
assert.equal(a.doing(), null);
assert.equal(a.recent[0].text, 'Searched the web');
a.start('2', 'read_file', { path: '/a/b.txt' }); a.end('2', true);
assert.equal(a.recent[0].text, "Couldn't finish: read b.txt");
assert.equal(a.recent[0].kind, 'bad');
a.start('3', 'remember_fact', {}); a.end('3', false);
assert.equal(a.recent.length, 3);
assert.deepEqual(a.recent.map((r) => r.text), ['Saved to memory', "Couldn't finish: read b.txt", 'Searched the web']);
assert.equal(a.start('4', 'plan_steps', {}), null);
a.start('5', 'web_search', {}); a.stopped(); assert.equal(a.doing(), null);
console.log('activity tests: passed');
