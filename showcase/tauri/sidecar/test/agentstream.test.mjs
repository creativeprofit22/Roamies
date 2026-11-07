// Failed agent requests must not crash the sidecar. Run: npm test
import assert from 'node:assert/strict';
import { AgentStream } from '@kenkaiiii/gg-agent';
import { agentEvents } from '../agentstream.mjs';

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

async function* failing() { yield { type: 'text_delta', text: 'Hi' }; throw new Error('Insufficient Balance'); }

// Regression: a provider error (no credits, bad sign-in) left an unhandled rejection that killed the sidecar.
const seen = [];
await assert.rejects(async () => {
  for await (const e of agentEvents(new AgentStream(failing(), () => {}))) seen.push(e.type);
}, /Insufficient Balance/, 'the error still reaches the caller');
assert.deepEqual(seen, ['text_delta'], 'events before the error still arrive');
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(unhandled, [], 'no unhandled rejection');

async function* ok() { yield { type: 'text_delta', text: 'OK' }; return 'done'; }
const types = [];
for await (const e of agentEvents(new AgentStream(ok(), () => {}))) types.push(e.type);
assert.deepEqual(types, ['text_delta'], 'a normal run is unchanged');
console.log('agent stream ok');
