// Remote conversations over a Space instead of pi-server/pi-client (phi-spaces docs/m1-mobile.en.md, "Remote
// conversations over a Space"). The phone writes a RemoteCall; the agent host takes it, carries it out and answers
// with RemoteAnswer entries; the phone takes its answer. Only write, take (with a wait), transactions and leases of
// the space are used, so every phi-spaces server (TypeScript or Rust) serves it.
//
// Exactly-once: the take of a call and the last part of its answer are one transaction. A host that dies in between
// leaves the transaction to expire, and the call comes back. A prompt carries its requestId, so the harness runs the
// turn once however often the call is carried out.
//
// Size: an entry holds at most 64 KiB, a commit 192 KiB. An answer is split into parts of PART_CHARS characters.
// All parts but the last are written before the transaction, each under the attempt's id; the last part is written
// in the transaction and names how many parts the attempt has. Parts of an attempt that never committed expire with
// their lease and are never read, because the client reads only the attempt of the last part.
import { randomUUID } from 'node:crypto';

export const CALL = 'RemoteCall';
export const ANSWER = 'RemoteAnswer';
/** The members a call may name, as pi-serverd answered them over pi-server. */
export const MEMBERS = {
  sessions: ['list', 'models', 'create', 'delete', 'rename', 'attach'],
  chat: ['prompt', 'abort', 'compact', 'state', 'configure', 'history', 'events'],
};
const PART_CHARS = 10_000; // ≤ 3 bytes a UTF-16 unit, doubled at most by escaping: within an entry's 64 KiB
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Checks a call's fields before anything is carried out. */
export function checkCall(f) {
  if (typeof f.callId !== 'string' || !ID.test(f.callId)) throw new Error('callId must be 1 to 128 characters of A-Z a-z 0-9 _ . : -');
  const service = f.session === undefined || f.session === null ? 'sessions' : 'chat';
  if (!MEMBERS[service].includes(f.member)) throw new Error(`unknown ${service} member: ${f.member}`);
  if (service === 'chat' && (typeof f.session !== 'string' || !ID.test(f.session))) throw new Error('session must be an id');
  if (!Array.isArray(f.args)) throw new Error('args must be a list');
  return { service, callId: f.callId, session: f.session ?? null, member: f.member, args: f.args };
}

/**
 * The agent host's side: `workers` loops, each taking one RemoteCall at a time and answering it.
 * `handle({service, session, member, args})` returns the result or throws; its message goes back as the error.
 * Returns `stop()`, which ends the loops after their current call.
 */
export function serveRemoteCalls(space, handle, { workers = 8, waitMs = 20_000, txnLeaseMs = 90_000, answerLeaseMs = 300_000, onError = () => {} } = {}) {
  const halt = new AbortController();
  const loop = async () => {
    while (!halt.signal.aborted) {
      let txn = null;
      try {
        txn = (await space.createTransaction(txnLeaseMs)).id;
        const taken = await space.take({ type: CALL }, waitMs, { txn });
        if (!taken) { await space.abort(txn); txn = null; continue; }
        let call, answer;
        try {
          call = checkCall(taken.fields);
          answer = { ok: true, result: await handle(call) };
        } catch (error) { answer = { ok: false, error: String(error?.message ?? error) }; }
        const callId = typeof taken.fields.callId === 'string' ? taken.fields.callId : 'invalid';
        let text = JSON.stringify(answer ?? { ok: false, error: 'no answer' }) ?? 'null';
        const attempt = randomUUID(), parts = Math.max(1, Math.ceil(text.length / PART_CHARS));
        for (let part = 0; part < parts - 1; part++) {
          await space.write({ type: ANSWER, fields: { callId, attempt, part, text: text.slice(part * PART_CHARS, (part + 1) * PART_CHARS) } }, null, answerLeaseMs);
        }
        await space.write({ type: ANSWER, fields: { callId, attempt, part: parts - 1, parts, last: true, text: text.slice((parts - 1) * PART_CHARS) } }, txn, answerLeaseMs);
        await space.commit(txn); txn = null;
      } catch (error) {
        onError(error);
        if (txn) await space.abort(txn).catch(() => {}); // the call comes back for another attempt
        await sleep(500, halt.signal);
      }
    }
  };
  const running = Array.from({ length: workers }, loop);
  // stop() does not wait out a take that is still waiting: the loops end at their next turn, and a call taken then
  // comes back when its transaction runs out
  return { async stop() { halt.abort(); await Promise.race([Promise.allSettled(running), sleep(1_000)]); } };
}

/** The host carried the call out and answered with an error (not a transport failure): `remote` is true. */
export class RemoteError extends Error { constructor(message) { super(message); this.name = 'RemoteError'; this.remote = true; } }
/** No answer came within the time: the call may still run on the host. */
export class RemoteTimeout extends Error { constructor(message) { super(message); this.name = 'RemoteTimeout'; this.remote = true; } }

/** Answer the phone's call: writes it and takes its answer. Throws the host's error as RemoteError; anything else
 *  that throws is the space or its transport. */
export async function callRemote(space, { session = null, member, args = [] }, { timeoutMs = 30_000, leaseMs = 300_000 } = {}) {
  const callId = 'c-' + randomUUID();
  await space.write({ type: CALL, fields: { callId, session, member, args } }, null, leaseMs);
  const last = await space.take({ type: ANSWER, fields: { callId, last: true } }, timeoutMs);
  if (!last) throw new RemoteTimeout(`timeout: no answer to ${member} within ${timeoutMs} ms (call ${callId} may still run)`);
  const { attempt, parts } = last.fields;
  let text = '';
  for (let part = 0; part < parts - 1; part++) {
    const piece = await space.take({ type: ANSWER, fields: { callId, attempt, part } }, 5_000);
    if (!piece) throw new Error(`part ${part} of the answer to ${member} is missing`);
    text += piece.fields.text;
  }
  const answer = JSON.parse(text + last.fields.text);
  if (!answer.ok) throw new RemoteError(answer.error);
  return answer.result;
}

/**
 * The phone's `remote` object over a Space, with the interface of remote-client.mjs's attachRemote: the sessions
 * calls, `attach(id)` choosing the session the chat calls go to, and `request(member, args)` for those.
 */
export function remoteOverSpace(space, { timeoutMs = 30_000, close = () => {} } = {}) {
  let session = null, closed = false;
  const lost = new Set();
  const call = (member, args = [], s = null) => {
    if (closed) throw new Error('disconnected');
    // a long poll of events waits 25 s on the host: give it room
    return callRemote(space, { session: s, member, args }, { timeoutMs: member === 'events' ? timeoutMs + 25_000 : timeoutMs });
  };
  return {
    get connected() { return !closed; },
    onLost(handler) { lost.add(handler); return () => lost.delete(handler); },
    list: () => call('list'),
    models: () => call('models'),
    create: (opts = {}) => call('create', [opts]),
    delete: (id) => call('delete', [String(id)]),
    rename: (id, name) => call('rename', [String(id), name]),
    async attach(id) { const r = await call('attach', [String(id)]); session = String(id); return r; },
    async request(member, args = []) {
      if (!session) throw new Error('not attached');
      return call(member, args, session);
    },
    async reconnect() { if (closed) throw new Error('disconnected'); },
    async disconnect() { closed = true; lost.clear(); await close(); },
  };
}
