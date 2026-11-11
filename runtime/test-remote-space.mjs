// Remote conversations over a Space (remote-calls.mjs; phi-spaces docs/m1-mobile.en.md). Offline: a space server
// (in this process, or the program PHI_SPACES_SERVER_CMD names, e.g. the Rust phi-space-server), pi-serverd with the
// scripted model (PI_TEST_FAUX), no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { SpaceService, StaticIdentity, connectSpace, openOwnMemoryHost, serveSpace, startService } from './phi-spaces.mjs';
import { CALL, callRemote, remoteOverSpace, serveRemoteCalls } from './remote-calls.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const OTHER = process.env.PHI_SPACES_SERVER_CMD?.trim().split(/\s+/);

/** A space server on a unix socket in `dir`; closed after the test. */
async function spaceServer(t, dir) {
  const sock = path.join(dir, 'space.sock');
  if (OTHER) {
    const child = spawn(OTHER[0], [...OTHER.slice(1), '--store', 'memory', '--listen', `unix:${sock}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    t.later(async () => { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; } });
    for (const deadline = Date.now() + 10_000; !out.includes('ready on');) { assert.ok(Date.now() < deadline, `space server did not start: ${out}`); await sleep(25); }
  } else {
    const host = openOwnMemoryHost();
    const stop = await startService(host, ctx);
    const server = await serveSpace(new SpaceService({ host, ctx, identity: new StaticIdentity({ local: { principal: { peerId: 'local' }, roles: ['member'] } }) }), { listen: { path: sock }, connection: () => ({ peerId: 'local' }) });
    t.later(async () => { await server.close(); await stop(); await host.close(ctx); });
  }
  return `unix:${sock}`;
}

function client(t, spec) {
  const link = connectSpace(spec, { callTimeoutMs: 60_000 });
  t.later(() => link.close());
  return link.space;
}

async function daemon(t, home, spec) {
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'pi-serverd.mjs')], {
    env: { ...process.env, HOME: home, PI_TEST_FAUX: '1', PI_WORKDIR: home, PI_SERVERD_SOCK: `${home}/.pi-serverd/server.sock`,
      PI_SERVERD_ID: '', PI_PROVIDER: '', PI_MODEL: '', PI_SERVERD_REMOTE_SPACE: spec },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  t.later(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  });
  for (const deadline = Date.now() + 15_000; !output.includes('remote calls over');) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `daemon startup timeout: ${output}`);
    await sleep(25);
  }
  return () => output;
}

/** A test's own directory; everything registered with `later` is undone in reverse order (clients before the server). */
function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-remote-space-')), stack = [];
  t.later = (fn) => stack.push(fn);
  t.after(async () => { for (const fn of stack.reverse()) await fn(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('a call is answered once, and a call whose host died before answering comes back to another host', async (t) => {
  const dir = tmp(t), spec = await spaceServer(t, dir);
  const phone = client(t, spec);
  // the first host takes the call and dies before it answers: its connection is gone, its transaction runs out
  const first = connectSpace(spec, { callTimeoutMs: 60_000 });
  let seen = 0, release;
  const hanging = new Promise((resolve) => { release = resolve; });
  const dead = serveRemoteCalls(first.space, async () => { seen++; first.close(); await hanging; return 'never'; }, { workers: 1, txnLeaseMs: 2_000, waitMs: 2_000, onError: () => {} });
  const answer = callRemote(phone, { member: 'list' }, { timeoutMs: 30_000 });
  for (let i = 0; i < 200 && !seen; i++) await sleep(25);
  assert.equal(seen, 1, 'the first host took the call');
  const second = client(t, spec);
  let carried = 0;
  const alive = serveRemoteCalls(second, async ({ member }) => { carried++; return { member, by: 'second' }; }, { workers: 1, waitMs: 2_000 });
  t.later(async () => { release(); await dead.stop(); await alive.stop(); });
  assert.deepEqual(await answer, { member: 'list', by: 'second' });
  assert.equal(carried, 1, 'the call came back once');
  assert.equal(await phone.count({ type: CALL }), 0, 'no call is left over');
});

test('a large answer arrives whole, in parts; an unknown member is an error', async (t) => {
  const dir = tmp(t), spec = await spaceServer(t, dir);
  const phone = client(t, spec), host = client(t, spec);
  const big = 'ä€x'.repeat(100_000); // 300 000 characters, multi-byte: many parts, several entries
  const serving = serveRemoteCalls(host, async ({ member }) => ({ member, big }), { workers: 2, waitMs: 2_000 });
  t.later(() => serving.stop());
  const r = await callRemote(phone, { member: 'models' });
  assert.equal(r.big, big);
  await assert.rejects(callRemote(phone, { member: 'rm -rf' }), /unknown sessions member/);
  await assert.rejects(callRemote(phone, { session: '1', member: 'shell' }), /unknown chat member/);
});

test('pi-serverd answers the sessions and chat calls over a Space', { timeout: 120_000 }, async (t) => {
  const dir = tmp(t), spec = await spaceServer(t, dir);
  const log = await daemon(t, dir, spec);
  const remote = remoteOverSpace(client(t, spec), { timeoutMs: 30_000 });
  t.later(() => remote.disconnect());
  assert.deepEqual((await remote.list()).sessions, []);
  assert.ok((await remote.models()).models.length > 0, 'the scripted model is offered');
  const { id } = await remote.create({ name: 'eins' });
  const other = (await remote.create({ name: 'zwei' })).id;
  await assert.rejects(remote.request('state'), /not attached/);
  await remote.attach(id);
  // a prompt sent twice with one requestId is one turn
  const requestId = randomUUID();
  const a = await remote.request('prompt', [{ message: 'hallo', requestId }]);
  const b = await remote.request('prompt', [{ message: 'hallo', requestId }]);
  assert.equal(a.submissionId, b.submissionId, log());
  const first = await remote.request('events', [{ after: -1 }]);
  assert.ok(typeof first.epoch === 'string', 'events answer with their epoch');
  let text = '';
  for (let i = 0; i < 100 && !text.includes('echo: hallo'); i++) {
    text = JSON.stringify((await remote.request('history', [{ limit: 50 }])).entries);
    if (!text.includes('echo: hallo')) await sleep(100);
  }
  assert.match(text, /echo: hallo/, 'the turn ran and its answer is in the history');
  assert.equal(text.match(/echo: hallo/g).length, 1, 'once');
  assert.equal(typeof (await remote.request('state')).busy, 'boolean');
  // the other session saw nothing of it
  await remote.attach(other);
  assert.doesNotMatch(JSON.stringify((await remote.request('history', [{ limit: 50 }])).entries), /hallo/);
  // rename, delete
  assert.deepEqual(await remote.rename(id, 'umbenannt'), { ok: true });
  assert.ok((await remote.list()).sessions.some((s) => String(s.id) === id && s.name === 'umbenannt'));
  assert.deepEqual(await remote.delete(id), { ok: true });
  assert.deepEqual((await remote.list()).sessions.map((s) => String(s.id)), [other]);
  await remote.attach(other);
  await assert.rejects(remote.attach(id), /unknown session/);
});
