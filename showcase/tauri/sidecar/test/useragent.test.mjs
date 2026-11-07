// User-agent for Claude sign-ins. Run: npm test
import assert from 'node:assert/strict';
import { agentUserAgent } from '../useragent.mjs';

let calls = 0;
const versions = ['claude-cli/2.1.88 (external, cli)', 'claude-cli/2.1.314 (external, cli)'];
const lookup = async () => versions[Math.min(calls++, versions.length - 1)];

assert.equal(await agentUserAgent('openai', lookup), undefined, 'other providers get no user-agent');
assert.equal(calls, 0, 'other providers never look it up');

// Regression: the version was looked up once at launch, so a failed first lookup stuck until restart.
assert.equal(await agentUserAgent('anthropic', lookup), versions[0], 'first lookup (fallback)');
assert.equal(await agentUserAgent('anthropic', lookup), versions[1], 'looked up again, picks up the newer version');

assert.equal(await agentUserAgent('anthropic', async () => { throw new Error('offline'); }), undefined, 'a failed lookup is not fatal');
console.log('useragent ok');
