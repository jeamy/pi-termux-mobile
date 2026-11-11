// Offline end-to-end tests: real daemon + protocol + private socket tunnel,
// with a local SSH stand-in. No SSH host, credentials or model API calls needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { attachRemote } from './remote-client.mjs';
import { createRemoteState } from './remote-state.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
function fixture(mode = 'proxy') {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-remote-test-'));
  mkdirSync(path.join(dir, 'bin'));
  const ssh = `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('-N')) {
  if (${JSON.stringify(mode)} === 'metadata-hang') setInterval(() => {}, 1000);
  else if (args.at(-1) === 'echo $HOME') console.log(${JSON.stringify(dir)});
  else console.log(fs.readFileSync(${JSON.stringify(dir + '/.pi-serverd/server-id')}, 'utf8').trim());
} else {
  const [local, remote] = args[args.indexOf('-L') + 1].split(':');
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
    if (${JSON.stringify(mode)} === 'handshake-hang') return;
    const upstream = net.connect(remote);
    peers.add(upstream);
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => { peers.delete(upstream); socket.destroy(); });
    socket.on('close', () => upstream.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  server.listen(local);
  process.on('SIGTERM', () => { for (const peer of peers) peer.destroy(); server.close(() => process.exit()); });
}
`;
  writeFileSync(path.join(dir, 'bin/ssh'), ssh, { mode: 0o700 });
  writeFileSync(path.join(dir, 'bin/ssh-keygen'), '#!/bin/sh\necho "256 SHA256:test-host test (ED25519)"\n', { mode: 0o700 });
  return { dir, prefix: dir, socketDir: path.join(dir, 'tunnels'), ssh: 'test@host',
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function daemon(home, t) {
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'pi-serverd.mjs')], {
    env: { ...process.env, HOME: home, PI_TEST_FAUX: '1', PI_WORKDIR: home,
      PI_SERVERD_SOCK: `${home}/.pi-serverd/server.sock`, PI_SERVERD_ID: '', PI_PROVIDER: '', PI_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  });
  const deadline = Date.now() + 10_000;
  while (!output.includes('pi-serverd on ')) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `daemon startup timeout: ${output}`);
    await sleep(25);
  }
  return {
    serverId: readFileSync(`${home}/.pi-serverd/server-id`, 'utf8').trim(),
    remoteSock: `${home}/.pi-serverd/server.sock`,
  };
}

test('metadata commands and silent protocol handshakes have deadlines', async () => {
  for (const mode of ['metadata-hang', 'handshake-hang']) {
    const f = fixture(mode);
    try {
      const options = mode === 'handshake-hang'
        ? { serverId: randomUUID(), remoteSock: '/unused.sock' } : {};
      await assert.rejects(attachRemote({ ...f, ...options, timeoutMs: 500 }), /timeout/);
      await sleep(100);
      assert.deepEqual(readdirSync(f.socketDir), [], 'failed attach left a socket behind');
    } finally { f.cleanup(); }
  }
});

test('rename routes to sessions; deleted sessions reject every existing attachment', async (t) => {
  const f = fixture();
  // Register cleanup before daemon cleanup: after hooks execute in registration order.
  const opts = await daemon(f.dir, t);
  let first, second;
  t.after(async () => {
    await first?.disconnect();
    await second?.disconnect();
    f.cleanup();
  });
  first = await attachRemote({ ...f, ...opts });
  second = await attachRemote({ ...f, ...opts });
  const { id } = await first.create({ name: 'test' });
  await first.attach(id);
  await second.attach(id);
  assert.deepEqual(await first.rename(id, 'renamed'), { ok: true });
  assert.equal((await first.list()).sessions[0].name, 'renamed');
  const requestId = randomUUID();
  const a = await first.request('prompt', [{ message: 'hello', requestId }]);
  const b = await first.request('prompt', [{ message: 'hello', requestId }]);
  assert.equal(a.submissionId, b.submissionId, 'prompt retries must stay deduplicated');
  // A racing prompt either finishes before deletion's abort, or is rejected.
  const racing = second.request('prompt', [{ message: 'racing', requestId: randomUUID() }]).catch(() => {});
  await first.delete(id);
  await racing;
  assert.deepEqual((await first.list()).sessions, []);
  for (const remote of [first, second]) {
    for (const [member, args] of [
      ['prompt', [{ message: 'after deletion', requestId: randomUUID() }]],
      ['compact', [{}]], ['state', []], ['history', []],
    ]) await assert.rejects(remote.request(member, args));
    await assert.rejects(remote.attach(id));
  }
});

test('hung RPC times out and disconnect during reconnect cancels the tunnel', async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  let remote;
  t.after(async () => { await remote?.disconnect(); f.cleanup(); });
  remote = await attachRemote({ ...f, ...opts, requestTimeoutMs: 150 });
  const { id } = await remote.create();
  await remote.attach(id);
  const history = await remote.request('history');
  // Long poll normally waits 25 seconds, deliberately longer than this deadline.
  await assert.rejects(remote.request('events', [{ after: history.cursor, epoch: history.epoch }]), /timeout/);
  // Replace SSH with a silent handshake for the reconnect attempt.
  const silent = fixture('handshake-hang');
  writeFileSync(path.join(f.prefix, 'bin/ssh'), readFileSync(path.join(silent.prefix, 'bin/ssh')));
  silent.cleanup();
  const pending = remote.reconnect();
  const rejected = assert.rejects(pending, /disconnected|abort/i);
  await sleep(150);
  await remote.disconnect();
  await rejected;
  assert.equal(remote.connected, false);
  await sleep(100);
  assert.deepEqual(readdirSync(f.socketDir), []);
  await assert.rejects(remote.reconnect(), /disconnected/);
});

test('an idle events long poll answers after the host waited its 25 s, not with a timeout', { timeout: 90_000 }, async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  let remote;
  t.after(async () => { await remote?.disconnect(); f.cleanup(); });
  remote = await attachRemote({ ...f, ...opts });
  const { id } = await remote.create();
  await remote.attach(id);
  const history = await remote.request('history');
  const started = Date.now();
  const page = await remote.request('events', [{ after: history.cursor, epoch: history.epoch }]);
  assert.ok(Date.now() - started >= 20_000, 'the host held the poll');
  assert.deepEqual(page.events, []);
  assert.equal(remote.connected, true);
});

test('a daemon that goes away is reported as lost; the host\'s own errors are not', async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  let remote;
  t.after(async () => { await remote?.disconnect(); f.cleanup(); });
  remote = await attachRemote({ ...f, ...opts, requestTimeoutMs: 5_000 });
  const lost = [];
  remote.onLost((why) => lost.push(why));
  await assert.rejects(remote.attach('999'), /unknown session/);
  assert.deepEqual(lost, [], 'an error of the host leaves the connection');
  assert.equal(remote.connected, true);
  // the daemon goes: the tunnel stays, the socket behind it is gone
  const pid = JSON.parse(readFileSync(`${f.dir}/.pi-serverd/serverd.lock`, 'utf8')).pid;
  process.kill(pid, 'SIGKILL');
  await assert.rejects(remote.list());
  assert.equal(lost.length, 1, 'the link is reported lost once');
  assert.equal(remote.connected, false);
});

test('the conversation socket reaches only the calls, never the daemon\'s Spaces; space RPC is a socket of its own', async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  const { connectSpace } = await import('./phi-spaces.mjs');
  const link = connectSpace(`unix:${opts.remoteSock}`, { callTimeoutMs: 5_000 });
  t.after(() => { link.close(); f.cleanup(); });
  const spaces = (await link.space.spaces()).map((s) => s.alias);
  assert.deepEqual(spaces, ['default'], 'a store of its own, with nothing of the daemon\'s');
  assert.equal(existsSync(`${f.dir}/.pi-serverd/space.sock`), false, 'no space RPC socket without a configured peer');
});

test('after the daemon restarts, the bridge reconnects on its own and re-attaches the session', { timeout: 120_000 }, async (t) => {
  const f = fixture();
  const opts = await daemon(f.dir, t);
  const state = createRemoteState({ stateDir: f.dir, assertTrusted: async () => {}, ensure: async () => ({ started: false }),
    attach: ({ signal }) => attachRemote({ ...f, ...opts, signal, requestTimeoutMs: 5_000 }), wait: (ms, v, o) => sleep(Math.min(ms, 200), v, o) });
  t.after(async () => { await state.disconnect(); f.cleanup(); });
  const remote = await state.connect('test@host');
  const { id } = await remote.create({ name: 'survives' });
  await remote.attach(id);
  state.sessionId = id; // as server.mjs does on attach
  process.kill(JSON.parse(readFileSync(`${f.dir}/.pi-serverd/serverd.lock`, 'utf8')).pid, 'SIGKILL');
  await assert.rejects(remote.request('state'));
  assert.equal(state.status, 'reconnecting');
  await daemon(f.dir, t); // the same home: the sessions are in its harness, the calls store is new
  for (let i = 0; i < 300 && state.status !== 'connected'; i++) await sleep(100);
  assert.equal(state.status, 'connected', state.lastError);
  assert.equal(typeof (await state.require().request('state')).busy, 'boolean', 'the session is attached again');
  assert.ok((await state.require().list()).sessions.some((s) => String(s.id) === id));
});
