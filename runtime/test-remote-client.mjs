// test-remote-client.mjs — exercises pi-serverd end-to-end over its conversation socket (calls over a space,
// remote-calls.mjs). Usage: node test-remote-client.mjs [socketPath]
// This creates a real session and submits a real model prompt. Never run as an offline unit test.
import { randomUUID } from 'node:crypto';
import { connectSpace } from './phi-spaces.mjs';
import { remoteOverSpace } from './remote-calls.mjs';

if (process.env.PI_MOBILE_LIVE_TEST !== '1') {
  throw new Error('Live test refused: creates a session and can incur model costs; set PI_MOBILE_LIVE_TEST=1 only with explicit approval');
}

const home = process.env.HOME;
const sock = process.argv[2] || `${home}/.pi-serverd/server.sock`;
const link = connectSpace(`unix:${sock}`, { callTimeoutMs: 60_000 });
console.log('connected, hello:', JSON.stringify(await link.space.info()));
const remote = remoteOverSpace(link.space, { timeoutMs: 35_000, close: () => link.close() });

console.log('list:', JSON.stringify(await remote.list()));
const created = await remote.create({ name: 'test' });
console.log('created:', JSON.stringify(created));
await remote.attach(created.id);
console.log('attached', created.id);

const state = await remote.request('state');
console.log('state: model', JSON.stringify(state.docs?.['pi.agent']?.model), 'busy', state.busy);

const history = await remote.request('history', [{ limit: 50 }]);
let after = history.cursor;
const epoch = history.epoch;

// the same requestId twice must yield one submission (exactly-once)
const requestId = randomUUID();
const p1 = await remote.request('prompt', [{ message: 'say just the word pong', requestId }]);
const p2 = await remote.request('prompt', [{ message: 'say just the word pong', requestId }]);
console.log('prompt:', JSON.stringify(p1), 'retry same id:', p1.submissionId === p2.submissionId ? 'deduplicated' : 'DUPLICATE');

let done = false;
for (let i = 0; i < 20 && !done; i++) {
  const r = await remote.request('events', [{ after, epoch }]);
  after = r.cursor;
  for (const e of r.events ?? []) {
    const txt = e?.entry?.model?.[0]?.content;
    const text = typeof txt === 'string' ? txt : txt?.filter?.((c) => c?.type === 'text')?.[0]?.text;
    console.log(`event #${e.seq}:`, e.type, text ? `| ${text.slice(0, 80)}` : '');
    if (e.type === 'submission' && e.record?.status === 'done') { console.log('SUBMISSION: done'); done = true; }
  }
}
await remote.disconnect();
process.exit(done ? 0 : 1);
