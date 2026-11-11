import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileSpaces } from '../runtime/spaces-mobile.mjs';
import { spawnSync } from 'node:child_process';

test('the live remote-client script refuses execution before reading credentials or opening sockets', () => {
  const result = spawnSync(process.execPath, [new URL('../runtime/test-remote-client.mjs', import.meta.url).pathname], {
    env: {...process.env, PI_MOBILE_LIVE_TEST:'0', HOME:'/nonexistent-live-test-home'}, encoding:'utf8', timeout:5000,
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/Live test refused/);
  assert.doesNotMatch(result.stderr,/server-id.*ENOENT/);
});

test('mobile pairing persists its identity before the effect and resolves a lost response after reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-pair-')), file = join(dir, 'profile.json'); let created = 0;
  const keys = { createAndroidSigner: async () => { created++; return { alias: 'native-alias', keyId: 'key', publicKey: 'public' }; } };
  const prepare = { peerId: 'phone', controlHostId: 'control', endpoint: 'tcp://100.1.2.3:4711' };
  try {
    const client = new MobileSpaces(file, keys); await client.call('prepare', prepare);
    client.connect = async () => ({ close() {}, remote: { info: async () => ({ spaceId: "control-space-id" }), enroll: async (token, options) => { const request = { generation: 'g', requestId: 'r' }; await options.beforeSend(request); assert.deepEqual(JSON.parse(readFileSync(file)).enrollment, request); assert.ok(!readFileSync(file, 'utf8').includes(token)); throw new Error('lost reply'); } } });
    await assert.rejects(client.call('enroll', { token: 'secret-token', controlSpaceId: 'wrong-control-space' }), /identity mismatch/);
    await assert.rejects(client.call('enroll', { token: 'secret-token', controlSpaceId: 'control-space-id' }), /lost reply/);
    const reopened = new MobileSpaces(file, keys); await assert.rejects(reopened.call('prepare', prepare), /already prepared/); assert.equal(created, 1);
    reopened.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, enrollStatus: async request => { assert.deepEqual(request, { generation: 'g', requestId: 'r' }); return { state: 'done', result: { keyId: 'key', peerId: 'phone' } }; } } });
    assert.equal((await reopened.call('enrollStatus')).profile.state, 'paired'); assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pending rotation is retained across reopen and activates the new alias only after a completed own command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-rotate-')), file = join(dir, 'profile.json');
  try {
    const client = new MobileSpaces(file, { createAndroidSigner: async () => ({ alias: 'replacement', keyId: 'new', publicKey: 'new-public', algorithm: 'ecdsa-p256' }) });
    client.save({ alias: 'old', keyId: 'old-key', peerId: 'phone', controlHostId: 'control', endpoint: 'tcp://100.1.2.3:4711', state: 'paired' });
    client.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, rotationChallenge: async () => ({ nonce: 'nonce' }), rotateKey: async (_c, _k, options) => { await options.beforeSend({ generation: 'g', requestId: 'r' }); throw new Error('lost rotation reply'); } } });
    await assert.rejects(client.call('rotate'), /lost rotation reply/); assert.equal(client.read().alias, 'old');
    const reopened = new MobileSpaces(file, {}); await assert.rejects(reopened.call('rotate'), /pending rotation/);
    let completed = false; reopened.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, rotationStatus: async id => { assert.equal(id, 'rotate:phone:nonce'); return { state: completed ? 'completed' : 'pending' }; } } });
    assert.equal((await reopened.call('rotationStatus')).profile.alias, 'old'); completed = true;
    assert.equal((await reopened.call('rotationStatus')).profile.alias, 'replacement'); assert.equal(reopened.read().rotation, undefined);
    const again = new MobileSpaces(file, {}); again.connect = reopened.connect;
    assert.equal((await again.call('rotationStatus')).result.state, 'completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('data access obtains an app-bound grant from a separately authenticated control connection', async () => {
  const { serveSpace } = await import('../runtime/phi-spaces.mjs');
  const key = { alias: 'native', keyId: 'phone-key', algorithm: 'ecdsa-p256', publicKey: 'public', sign: async () => Buffer.from('fixture-signature') };
  const servers = [], calls = [];
  const start = async hostId => {
    const server = await serveSpace({ handleText: async (text, connection) => {
      const call = JSON.parse(text); calls.push([hostId, call.method]);
      const ok = result => JSON.stringify({ ok: true, result });
      if (call.method === 'challenge') return ok({ gateHostId: hostId, observedPeerId: 'phone', connNonce: 'fixture', protocol: 1, issuedAt: Date.now() });
      if (call.method === 'prove') { connection.state = { keyId: call.args.keyId }; return ok({ keyId: call.args.keyId, principal: 'phone', roles: ['member'] }); }
      if (call.method === 'grant') return ok({ grant: { keyId: connection.state?.keyId ?? null } });
      if (call.frame?.grant?.grant?.keyId !== connection.state?.keyId) return JSON.stringify({ ok: false, error: { code: 'PermissionDenied', message: 'grant belongs to another app key' } });
      if (call.method === 'hello') return ok({ spaceId: 'jobs', limits: { maxFrameBytes: 262144 } });
      if (call.method === 'stats') return ok({ entries: 1 });
      if (call.method === 'readAll') return ok({ items: [{ type: 'AcceptanceObject', fields: {} }], next: null });
      throw new Error('unexpected call: ' + call.method);
    } }, { listen: { host: '127.0.0.1', port: 0 } });
    servers.push(server); return `tcp://127.0.0.1:${server.address().port}`;
  };
  const dir = mkdtempSync(join(tmpdir(), 'mobile-grant-'));
  try {
    const client = new MobileSpaces(join(dir, 'profile.json'), { androidSigner: async () => key });
    client.save({ alias: key.alias, keyId: key.keyId, peerId: 'phone', controlHostId: 'control', endpoint: await start('control'), dataHostId: 'data', dataEndpoint: await start('data'), dataSpace: 'jobs', state: 'paired' });
    const reply = await client.call('objects'); assert.equal(reply.result.objects[0].type, 'AcceptanceObject');
    assert.ok(calls.some(([host, method]) => host === 'control' && method === 'prove'));
  } finally { for (const server of servers) await server.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('paired status after rotation proves the current key and rejects a revoked key instead of replaying old enrollment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-paired-status-'));
  try {
    const client = new MobileSpaces(join(dir, 'profile.json'), {});
    client.save({ alias: 'rotated', keyId: 'new-key', peerId: 'phone', state: 'paired', enrollment: { generation: 'old-generation', requestId: 'old-request' } });
    let authenticated = 0, revoked = false;
    client.connect = async () => ({ close() {}, remote: {
      authenticate: async () => { authenticated++; if (revoked) throw new Error('key revoked'); },
      enrollStatus: async () => { throw new Error('old enrollment belongs to old-key'); },
    } });
    assert.deepEqual((await client.call('enrollStatus')).result, { state: 'paired', keyId: 'new-key', peerId: 'phone' });
    assert.equal(authenticated, 1); revoked = true;
    await assert.rejects(client.call('enrollStatus'), /key revoked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('admin commands keep their command ID across a lost reply and a reopen, and only offered kinds are sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-admin-')), file = join(dir, 'profile.json');
  const written = [], results = new Map(); let lose = true;
  const remote = {
    authenticate: async () => {},
    write: async entry => { written.push(structuredClone(entry.fields)); const id = entry.fields.commandId; if (!results.has(id)) results.set(id, { commandId: id, kind: entry.fields.kind, state: 'completed', result: { runId: 'r', state: 'paused' } }); if (lose) { lose = false; throw new Error('reply lost'); } },
    readAll: async template => results.has(template.fields.commandId) ? [{ type: 'Result', fields: results.get(template.fields.commandId) }] : [],
  };
  const connect = async () => ({ close() {}, remote });
  try {
    const client = new MobileSpaces(file, {}); client.connect = connect;
    client.save({ alias: 'a', keyId: 'k', peerId: 'phone', controlHostId: 'control', endpoint: 'tcp://100.1.2.3:4711', state: 'prepared' });
    await assert.rejects(client.call('admin', { kind: 'pauseRun', args: { runId: 'r' } }), /pair the device/);
    client.save({ ...client.read(), state: 'paired' });
    await assert.rejects(client.call('admin', { kind: 'rotateKey', args: {} }), /not offered on the phone/);
    await assert.rejects(client.call('admin', { kind: 'pauseRun', args: { runId: 'r' } }), /Ausgang wird geprüft/);
    const [op] = Object.values(client.read().operations);
    assert.equal(op.state, 'unknown'); assert.equal(written[0].commandId, op.commandId, 'the ID was stored before the send');
    const reopened = new MobileSpaces(file, {}); reopened.connect = connect;
    const listed = (await reopened.call('operations')).operations;
    assert.equal(listed[0].commandId, op.commandId); assert.equal(listed[0].state, 'completed', 'the durable effect is found by its ID');
    await assert.rejects(reopened.call('admin', { kind: 'pauseRun', args: { runId: 'other' }, commandId: op.commandId }), /changed arguments/);
    const again = await reopened.call('admin', { kind: 'pauseRun', args: { runId: 'r' }, commandId: op.commandId });
    assert.equal(written[1].commandId, op.commandId, 'a resend reuses the same command ID'); assert.equal(again.result.state, 'completed');
    assert.equal(Object.keys(reopened.read().operations).length, 1);
    reopened.connect = async () => { throw new Error('connect ECONNREFUSED'); };
    await assert.rejects(reopened.call('admin', { kind: 'resumeRun', args: { runId: 'r' } }), /nicht gesendet und kann mit derselben ID/);
    const notSent = Object.values(reopened.read().operations).find(o => o.kind === 'resumeRun');
    assert.equal(notSent.state, 'notSent'); assert.equal(written.length, 2, 'nothing was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remote conversations over a Space: key proof at the agent host, a grant from the coordinator on every call', async () => {
  const { serveSpace, openOwnMemoryHost, SpaceService, StaticIdentity, PhiSpaces, createSpace } = await import('../runtime/phi-spaces.mjs');
  const { serveRemoteCalls, remoteOverSpace } = await import('../runtime/remote-calls.mjs');
  const { BACKGROUND_CONTEXT: ctx } = await import('../runtime/node_modules/@earendil-works/chord/dist/context/index.js');
  const key = { alias: 'native', keyId: 'phone-key', algorithm: 'ecdsa-p256', publicKey: 'public', sign: async () => Buffer.from('fixture-signature') };
  // the agent host's store: the named Space `remote`, served by its own loop
  const host = openOwnMemoryHost();
  await host.commit((tx) => createSpace(tx, 'remote', Date.now()), ctx);
  const service = new SpaceService({ host, ctx, identity: new StaticIdentity({ phone: { principal: { peerId: 'phone' }, roles: ['member'] } }) });
  const handled = [];
  const loop = serveRemoteCalls(new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: 'remote' }), async (c) => { handled.push(c.member); return { sessions: [{ id: '7', name: 'über Space' }] }; }, { workers: 1, waitMs: 1_000 });
  const servers = [], refused = [];
  const start = async (hostId, inner) => {
    const server = await serveSpace({ handleText: async (text, connection) => {
      const call = JSON.parse(text);
      const ok = (result) => JSON.stringify({ ok: true, result });
      if (call.method === 'challenge') return ok({ gateHostId: hostId, observedPeerId: 'phone', connNonce: 'fixture', protocol: 1, issuedAt: Date.now() });
      if (call.method === 'prove') { connection.state = { keyId: call.args.keyId }; return ok({ keyId: call.args.keyId, principal: 'phone', roles: ['member'] }); }
      if (call.method === 'grant') return ok({ grant: { keyId: connection.state?.keyId ?? null } });
      if (!connection.state || call.frame?.grant?.grant?.keyId !== connection.state.keyId) { refused.push([hostId, call.method]); return JSON.stringify({ ok: false, error: { code: 'PermissionDenied', message: 'no proof or grant' } }); }
      if (!inner) throw new Error('unexpected call at ' + hostId + ': ' + call.method);
      const { grant, ...frame } = call.frame; // the gate checked it; the space behind sees the phone's principal
      return inner.handleText(JSON.stringify({ ...call, frame }), { peerId: 'phone' });
    } }, { listen: { host: '127.0.0.1', port: 0 } });
    servers.push(server); return `tcp://127.0.0.1:${server.address().port}`;
  };
  const dir = mkdtempSync(join(tmpdir(), 'mobile-remote-'));
  let connection;
  try {
    const allowed = [];
    const client = new MobileSpaces(join(dir, 'profile.json'), { androidSigner: async () => key, keyStoreCall: async (c) => { allowed.push(c.gateHostId); } });
    client.save({ alias: key.alias, keyId: key.keyId, peerId: 'phone', controlHostId: 'control', endpoint: await start('control'), state: 'paired' });
    await assert.rejects(client.openRemote(), /no agent host/);
    await assert.rejects(client.call('remoteHost', { hostId: 'agent', endpoint: 'http://x:1', space: 'remote' }), /tcp:/);
    await client.call('remoteHost', { hostId: 'agent', endpoint: await start('agent', service), space: 'remote' });
    assert.deepEqual(allowed, ['agent'], 'the key is allowed at the agent host');
    connection = await client.openRemote();
    const remote = remoteOverSpace(connection.remote, { timeoutMs: 10_000 });
    assert.deepEqual((await remote.list()).sessions, [{ id: '7', name: 'über Space' }]);
    assert.deepEqual(handled, ['list']);
    assert.deepEqual(refused, [], 'every call carried proof and grant');
  } finally { connection?.close(); await loop.stop(); for (const server of servers) await server.close(); await host.close(ctx); rmSync(dir, { recursive: true, force: true }); }
});
