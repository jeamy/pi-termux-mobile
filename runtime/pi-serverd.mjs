// pi-serverd.mjs — durable pi sessions, answered as calls over a space (remote-calls.mjs; phi-spaces
// docs/m1-mobile.en.md "Remote conversations over a Space").
// Remote attach flow: `ssh -L <local.sock>:<socket>` from the client machine, then a phi-spaces client on the
// forwarded socket (remote-client.mjs attachRemote); same machine: connect the socket directly.
//
// Env: HOME (storage root), PI_SERVERD_SOCK (the conversation socket, default $HOME/.pi-serverd/server.sock),
// PI_SERVERD_ID (stable serverId, default: persisted random uuid), PI_WORKDIR (agent cwd), PI_PROVIDER/PI_MODEL.
// PI_SERVERD_STATE_DIR and PI_SERVERD_AUTH_FILE isolate test/alternate runtimes.
// Space RPC on the daemon's own store is opt-in and on a socket of its own (PI_SERVERD_SPACE_SOCK, default
// $HOME/.pi-serverd/space.sock): PI_SERVERD_SPACE_PRINCIPAL is a configured peer id, PI_SERVERD_SPACE_ROLES a
// comma-separated explicit role list; or the federation (PI_SERVERD_FEDERATION_CONFIG). Never trust client JSON for
// identity.
import { existsSync, chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SpaceService, StaticIdentity, startConfiguredFederation, PhiSpaces, connectSpace, createSpace, openOwnMemoryHost, serveSpace, startService } from './phi-spaces.mjs';
import { serveRemoteCalls } from './remote-calls.mjs';
import {
  acquireOwnerLock, agentContext, createCredentialStore, createEventHub, createModelCatalog,
  ensureModel, isBusy, openHarness, pickModel, readJson, requestIdOf, sessionStore, Subagent,
  whenBusyOf, writeFileAtomic, agentSpace, createSpaces, localSpaces, openSqliteHost, startSpaceService, withEventSink,
} from './common.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || ROOT;
const STATE_DIR = process.env.PI_SERVERD_STATE_DIR || `${HOME}/.pi-serverd`;
const spacePeer = process.env.PI_SERVERD_SPACE_PRINCIPAL;
const spaceRoles = (process.env.PI_SERVERD_SPACE_ROLES || "").split(",").map(x => x.trim()).filter(Boolean);
if (Boolean(spacePeer) !== Boolean(spaceRoles.length)) throw new Error("space RPC requires both PI_SERVERD_SPACE_PRINCIPAL and PI_SERVERD_SPACE_ROLES");
const SOCK_PATH = process.env.PI_SERVERD_SOCK || `${STATE_DIR}/server.sock`;
const SPACE_SOCK = process.env.PI_SERVERD_SPACE_SOCK || `${STATE_DIR}/space.sock`;
const WORKDIR = process.env.PI_WORKDIR || HOME;
const LEGACY_MANIFEST = `${STATE_DIR}/sessions.json`;
const DB = `${STATE_DIR}/harness.sqlite`;
// The space's own store: not the sessions' harness, so the space outlives a harness restart and the other way round.
// A space kept in harness.sqlite by an older version is not carried over (phi-spaces decision D6).
const SPACE_DB = `${STATE_DIR}/space.sqlite`;

// private state dir: whoever reaches the sockets is trusted as their peer (SSH authenticates it)
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try { chmodSync(STATE_DIR, 0o700); } catch {}
mkdirSync(path.dirname(SOCK_PATH), { recursive: true, mode: 0o700 });
mkdirSync(WORKDIR, { recursive: true });

if (existsSync(`${STATE_DIR}/restart.lock`)) throw new Error("normal boot is blocked by the persistent recovery restart lock");
const releaseLock = await acquireOwnerLock(`${STATE_DIR}/serverd.lock`, 'pi-serverd.mjs');

const ID_FILE = `${STATE_DIR}/server-id`;
let serverId = process.env.PI_SERVERD_ID;
if (!serverId) {
  try { serverId = readFileSync(ID_FILE, 'utf8').trim(); } catch {}
  if (!serverId) { serverId = randomUUID(); writeFileAtomic(ID_FILE, serverId, 0o644); }
}

// --- harness ----------------------------------------------------------------
class SessionNotFoundError extends Error {}

const ctx = BACKGROUND_CONTEXT;
const credentials = createCredentialStore(process.env.PI_SERVERD_AUTH_FILE || `${HOME}/.pi/agent/auth.json`);
const models = await createModelCatalog(credentials);
const env = new NodeExecutionEnv({ cwd: WORKDIR, env: process.env });
const space = await openSqliteHost(SPACE_DB);
// The conversations' space tools: this daemon's own space, or with PI_SERVERD_AGENT_SPACE (`unix:/path` or
// `tcp:host:port`, PI_SERVERD_AGENT_SPACE_NAME a named Space there) another space server's (agentSpace in common.mjs).
const agentSpec = process.env.PI_SERVERD_AGENT_SPACE;
const agentSpaceName = process.env.PI_SERVERD_AGENT_SPACE_NAME || undefined;
const agent = agentSpec ? agentSpace({ spec: agentSpec, name: agentSpaceName, watchFile: `${STATE_DIR}/agent-space.json`,
  peerId: process.env.PI_SERVERD_AGENT_PEER, label: 'pi-serverd: agent space' }) : null;
const Spaces = createSpaces(agent ? agent.spaces : localSpaces(space));
const harness = await openHarness({
  dbPath: DB,
  models,
  env: ({ cwd }) => (cwd && cwd !== WORKDIR ? new NodeExecutionEnv({ cwd, env: process.env }) : env),
  extensions: [Subagent, Spaces],
}, ctx);
const sessions = sessionStore(harness, ctx);
// before the harness resumes: a resumed tool call may already use the agent space
agent?.attach(harness);

// one-time import of the old JSON manifest
{
  const legacy = readJson(LEGACY_MANIFEST, null)?.sessions;
  if (legacy && Object.keys(legacy).length && !(await sessions.list()).length) {
    const n = await sessions.migrate(legacy);
    writeFileAtomic(`${LEGACY_MANIFEST}.migrated`, JSON.stringify({ sessions: legacy }, null, 2));
    try { unlinkSync(LEGACY_MANIFEST); } catch {}
    console.log(`migrated ${n} sessions from ${LEGACY_MANIFEST}`);
  }
}
const federation = process.env.PI_SERVERD_FEDERATION_CONFIG
  ? await startConfiguredFederation(withEventSink(space, harness), ctx, process.env.PI_SERVERD_FEDERATION_CONFIG) : null;
if (existsSync(`${STATE_DIR}/restart.lock`)) throw new Error("restart lock was installed during boot");
harness.resume();
if (agent) console.log(`pi-serverd: conversations use the space at ${agentSpec}${agentSpaceName ? ` (${agentSpaceName})` : ''}, ${agent.resume()} watched`);
// reaper + delivery of the space's events into the sessions
const stopSpaces = federation ? () => federation.close() : await startSpaceService(withEventSink(space, harness), ctx);

const events = createEventHub(harness, ctx);

async function conversationOf(sessionId) {
  if (!(await sessions.get(sessionId))) throw new SessionNotFoundError(`unknown session: ${sessionId}`);
  const conv = await harness.conversation(Number(sessionId), ctx);
  if (!conv) throw new SessionNotFoundError(`session unavailable: ${sessionId}`);
  return conv;
}

// Serialize session mutations with deletion. Revalidating only at attach time
// leaves cached handles usable after removal; checking without serialization
// also lets a concurrent prompt slip between deletion's abort and removal.
const sessionMutations = new Map();
async function withSessionMutation(id, invoke) {
  const previous = sessionMutations.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(invoke);
  sessionMutations.set(id, pending);
  try { return await pending; }
  finally { if (sessionMutations.get(id) === pending) sessionMutations.delete(id); }
}

// --- the members of the calls (remote-calls.mjs MEMBERS) -----------------------------------

/** One chat member of a session (`args` as the caller sent them). */
async function chatMember(sessionId, member, args, c) {
  const arg = args[0] ?? {};
  const call = { member };
  const invoke = async () => {
    // Existing attachments must lose access as soon as their registry
    // entry is deleted. Never use the conversation cached by attach.
    const conv = await conversationOf(sessionId);
    switch (call.member) {
      case 'prompt': {
        const text = String(arg.message ?? (typeof arg === 'string' ? arg : ''));
        if (!(await ensureModel(conv, models, c))) {
          throw new Error('no model: add a credential on the server');
        }
        const sub = await conv.submit({
          type: 'input',
          content: text,
          requestId: requestIdOf(arg.requestId), // exactly-once across retries
          whenBusy: whenBusyOf(arg.whenBusy),
        }, c);
        return { submissionId: sub.id };
      }
      case 'abort':
        await conv.abort(c);
        return { ok: true };
      case 'compact': {
        const taskId = await conv.compact(typeof arg.instructions === 'string' ? arg.instructions : undefined, c);
        return { ok: true, taskId };
      }
      case 'state': {
        const view = await conv.watch(c);
        try { return { ...view.value, busy: isBusy(view) }; } finally { await view.stop(); }
      }
      case 'configure': {
        if (arg.model?.provider && arg.model?.modelId) {
          await conv.configure({ model: { provider: String(arg.model.provider), modelId: String(arg.model.modelId) } }, c);
        }
        return { ok: true };
      }
      case 'history': {
        // entries() is newest-first; the UI needs chronological messages.
        const limit = Math.min(Math.max(Number(arg.limit) || 200, 1), 500);
        // position before the page: nothing is lost; repeats are deduped by entry id in the UI
        const position = await events.position(sessionId);
        const page = await conv.entries({}, limit, undefined, c);
        return { entries: [...page.items].reverse(), ...position };
      }
      case 'events': {
        // long-poll; `after` is the last sequence number this client has seen
        const after = Number(arg.after ?? -1);
        const epoch = typeof arg.epoch === 'string' ? arg.epoch : undefined;
        return events.poll(sessionId, after, { epoch, waitMs: 25_000, signal: c?.abortSignal });
      }
      default:
        throw new Error(`unknown member: ${call.member}`);
    }
  };
  return ['prompt', 'abort', 'compact', 'configure'].includes(member)
    ? withSessionMutation(sessionId, invoke) : invoke();
}

/** One sessions member. The phone keeps the session it attached and names it in its chat calls. */
async function sessionsMember(member, args, c) {
  const call = { member, args };
  switch (call.member) {
    case 'list':
      return { sessions: (await sessions.list()).map((s) => ({ cwd: WORKDIR, ...s })) };
    case 'models': {
      const available = await models.getAvailable();
      return { models: available.map((m) => ({ provider: m.provider, modelId: m.id })) };
    }
    case 'create': {
      const opts = call.args[0] ?? {};
      const conv = await sessions.create(
        { name: typeof opts.name === 'string' ? opts.name.slice(0, 100) : undefined, cwd: WORKDIR },
        { agent: { model: await pickModel(models) } },
      );
      return { id: String(conv.id) };
    }
    case 'delete': {
      const id = String(call.args[0]);
      return withSessionMutation(id, async () => {
        const conv = await conversationOf(id);
        // No prompt/compact can start between abort and removal.
        await conv.abort(c);
        // Transcript stays in SQLite; every attached handler now rejects.
        await sessions.remove(id);
        return { ok: true };
      });
    }
    case 'attach': {
      const id = String(call.args[0]);
      // Sessions created before a credential existed have no model: give them the current default. Never overrides
      // an explicit choice.
      await ensureModel(await conversationOf(id), models, c);
      return { ok: true };
    }
    case 'rename': {
      const id = String(call.args[0]);
      const name = typeof call.args[1] === 'string' ? call.args[1].slice(0, 100) : undefined;
      if (!(await sessions.get(id))) throw new Error(`unknown session: ${id}`);
      await sessions.update(id, { name: name || undefined });
      return { ok: true };
    }
    default:
      throw new Error(`unknown member: ${call.member}`);
  }
}

// --- the sockets -------------------------------------------------------------------------

const handleCall = ({ service, session, member, args }) => service === 'sessions'
  ? sessionsMember(member, args, agentContext(ctx)) : chatMember(session, member, args, agentContext(ctx));
const onCallError = (e) => console.error('remote calls:', e?.message || e);
// A long poll of `events` holds a worker for its 25 s: 16 serve that many polling clients at once, one more call waits
const CALL_WORKERS = 16;

// The conversation socket (SOCK_PATH, what the phone forwards over SSH) serves a store of its own, in memory, that
// holds nothing but the calls and their answers. Its peer is whoever reached it through SSH: it can write calls and
// take answers there, never reach the daemon's Spaces. Its reaper returns a call whose transaction ran out.
const callsStore = openOwnMemoryHost();
const stopCallsReaper = await startService(callsStore, ctx);
const callsServer = await serveSpace(new SpaceService({ host: callsStore, ctx, hostId: serverId, authorityId: serverId,
  identity: new StaticIdentity({ ssh: { principal: { peerId: 'ssh' }, roles: ['member'] } }) }),
  { listen: { path: SOCK_PATH }, connection: () => ({ peerId: 'ssh' }) });
const calls = [serveRemoteCalls(new PhiSpaces(callsStore, ctx, Date.now), handleCall, { workers: CALL_WORKERS, onError: onCallError })];

// Space RPC on the daemon's own store, on a socket of its own: the federation's service, or one configured peer
// with its explicit roles. SSH access alone grants no space role; without either there is no such socket.
let spaceServer = null;
if (federation) {
  spaceServer = await serveSpace({ handleText: async (text, conn) => JSON.stringify(await federation.service.handle(JSON.parse(text), conn)) },
    { listen: { path: SPACE_SOCK }, connection: () => ({}) });
} else if (spacePeer) {
  const spaceService = new SpaceService({ host: space, ctx, hostId: serverId, authorityId: serverId,
    identity: new StaticIdentity({ [spacePeer]: { principal: { peerId: spacePeer }, roles: spaceRoles } }) });
  spaceServer = await serveSpace(spaceService, { listen: { path: SPACE_SOCK }, connection: () => ({ peerId: spacePeer }) });
}
console.log(`pi-serverd on ${SOCK_PATH} (serverId ${serverId})${spaceServer ? `, space on ${SPACE_SOCK}` : ''}`);

// Conversations over a further Space, PI_SERVERD_REMOTE_SPACE: `local[:alias]` serves the named Space `alias`
// (default `remote`) of this daemon's own store, which the phone reaches through the federation gate with a grant;
// `unix:/path` or `tcp:host:port` serves another space server's default Space (PI_SERVERD_REMOTE_SPACE_NAME names a
// named one). Unset: only the conversation socket.
let remoteLink = null;
const remoteSpec = process.env.PI_SERVERD_REMOTE_SPACE;
if (remoteSpec) {
  let remoteSpace;
  if (remoteSpec === 'local' || remoteSpec.startsWith('local:')) {
    const alias = remoteSpec.slice('local:'.length) || 'remote';
    await space.commit((tx) => createSpace(tx, alias, Date.now()), ctx);
    remoteSpace = new PhiSpaces(space, ctx, Date.now, undefined, undefined, { space: alias });
  } else {
    remoteLink = connectSpace(remoteSpec, process.env.PI_SERVERD_REMOTE_SPACE_NAME ? { space: process.env.PI_SERVERD_REMOTE_SPACE_NAME } : {});
    remoteSpace = remoteLink.space;
  }
  calls.push(serveRemoteCalls(remoteSpace, handleCall, { workers: CALL_WORKERS, onError: onCallError }));
  console.log(`pi-serverd: remote calls over ${remoteSpec}`);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`pi-serverd: ${signal}, closing`);
  try { await callsServer.close(); await spaceServer?.close(); } catch {}
  try { await Promise.all(calls.map((c) => c.stop())); remoteLink?.close(); } catch {}
  try { await agent?.stop(); } catch {}
  try { await stopCallsReaper(); await callsStore.close(ctx); } catch {}
  try { await events.close(); } catch {}
  try { await stopSpaces(); } catch {}
  try { await harness.close(ctx); } catch (e) { console.error('harness.close:', e?.message || e); }
  try { await space.close(ctx); } catch (e) { console.error('space.close:', e?.message || e); }
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
