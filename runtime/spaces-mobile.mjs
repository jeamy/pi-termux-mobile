// Keystore-backed pairing and own-key rotation. Plain enrollment tokens are never persisted.
import { readFileSync, mkdirSync, renameSync, writeFileSync, chmodSync, lstatSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteSpace, socketTransport } from './phi-spaces.mjs';
import { androidSigner, createAndroidSigner, keyStoreCall } from './space-keystore.mjs';
// Admin commands the phone may send into the control Space. The coordinator's supervisor checks the admin key;
// this list only keeps the phone from sending kinds it has no view for.
export const ADMIN_KINDS = new Set(['listRuns', 'runStatus', 'startRun', 'pauseRun', 'resumeRun', 'stopRun', 'reconcileRun', 'resolveRunRecovery', 'listWorkers', 'setWorkers', 'createSpace', 'archiveSpace', 'reactivateSpace', 'deleteSpace', 'planDeployment', 'exportDeployment', 'startWorkers', 'listAlerts', 'auditLog', 'exportRun', 'scheduleRun']);
const FINAL = new Set(['completed', 'failed', 'duplicate']);
const readResult = async (remote, commandId) => (await remote.readAll({ type: 'Result', fields: { commandId } }))[0]?.fields ?? null;
export class MobileSpaces {
  constructor(file, keys = { androidSigner, createAndroidSigner, keyStoreCall }) { this.file = file; this.keys = keys; this.busy = false; }
  read() { try { const stat = lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('space profile must be private'); return JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  save(profile) { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const next = this.file + '.' + process.pid + '.' + Date.now() + '.next'; let fd; try { fd = openSync(next, 'wx', 0o600); writeFileSync(fd, JSON.stringify(profile) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(next, this.file); fd = openSync(dirname(this.file), 'r'); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(next); } catch {} } }
  async serial(fn) { if (this.busy) throw new Error('another space operation is in progress'); this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  async connect(profile, alias = profile.alias, data = false) {
    const signer = await this.keys.androidSigner(alias), endpoint = data ? profile.dataEndpoint : profile.endpoint, host = data ? profile.dataHostId : profile.controlHostId;
    if (!endpoint || !host) throw new Error('endpoint and trusted host identity are required');
    const url = new URL(endpoint); if (url.protocol !== 'tcp:' || !url.hostname || !url.port || url.username || url.password || url.search || url.hash) throw new Error('use tcp://OVERLAY-IP:PORT');
    const socket = socketTransport({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    let remote, control = null;
    try {
      if (data) { control = await this.connect(profile, alias); await control.remote.authenticate(); }
    } catch (error) { socket.close(); control?.close(); throw error; }
    remote = new RemoteSpace(socket, { space: data ? profile.dataSpace : 'control', signer, expectedGateHostId: host, ownPeerId: profile.peerId, grantProvider: () => (control?.remote || remote).requestGrant() });
    return { remote, close: () => { socket.close(); control?.close(); } };
  }
  /**
   * An authenticated client of the remote-conversation Space (profile.remote*): key proof at that host's gate, each
   * call with a grant of the coordinator. Long-lived and outside `serial`, so the Remote page's polls never hold up
   * the Spaces page. Returns { remote, close }.
   */
  async openRemote() {
    const profile = this.read();
    if (!profile || profile.state !== 'paired') throw new Error('pair the device under Spaces first');
    if (!profile.remoteHostId || !profile.remoteEndpoint || !profile.remoteSpace) throw new Error('no agent host for remote conversations is set (Spaces → Remote-Sitzungen)');
    const connection = await this.connect({ ...profile, dataHostId: profile.remoteHostId, dataEndpoint: profile.remoteEndpoint, dataSpace: profile.remoteSpace }, profile.alias, true);
    try { await connection.remote.authenticate(); } catch (error) { connection.close(); throw error; }
    return connection;
  }
  async call(method, body = {}) {
    return this.serial(async () => {
      let profile = this.read();
      if (method === 'status') return { profile, keystore: !!process.env.PHI_SPACES_KEY_SOCKET };
      if (method === 'prepare') {
        if (profile) throw new Error('an identity is already prepared; resolve its pending operation first');
        if (![body.peerId, body.controlHostId].every(v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v))) throw new Error('peer and control host identity are required');
        const url = new URL(body.endpoint); if (url.protocol !== 'tcp:' || !url.port || url.username || url.password || url.search || url.hash) throw new Error('invalid control endpoint');
        const key = await this.keys.createAndroidSigner(body.peerId, body.controlHostId);
        profile = { peerId: body.peerId, controlHostId: body.controlHostId, endpoint: body.endpoint, controlSpaceId: body.controlSpaceId || null, alias: key.alias, keyId: key.keyId, publicKey: key.publicKey, state: 'prepared' };
        this.save(profile); return { profile };
      }
      if (!profile) throw new Error('prepare the device identity first');
      if (method === 'dataHost') { if (!body.hostId || !body.endpoint || !body.space) throw new Error('host, endpoint and space are required'); const url = new URL(body.endpoint); if (url.protocol !== 'tcp:' || !url.port || url.username || url.password) throw new Error('invalid data endpoint'); await this.keys.keyStoreCall({ method: 'allowHost', alias: profile.alias, gateHostId: body.hostId }); Object.assign(profile, { dataHostId: body.hostId, dataEndpoint: body.endpoint, dataSpace: body.space }); this.save(profile); return { profile }; }
      if (method === 'remoteHost') {
        // the agent host whose conversations the Remote page reaches over a Space (remote-calls.mjs)
        if (![body.hostId, body.space].every(v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v))) throw new Error('host and space are required');
        const url = new URL(body.endpoint); if (url.protocol !== 'tcp:' || !url.port || url.username || url.password || url.search || url.hash) throw new Error('use tcp://OVERLAY-IP:PORT');
        await this.keys.keyStoreCall({ method: 'allowHost', alias: profile.alias, gateHostId: body.hostId });
        Object.assign(profile, { remoteHostId: body.hostId, remoteEndpoint: body.endpoint, remoteSpace: body.space }); this.save(profile); return { profile };
      }
      if (method === 'rotate' && profile.rotation?.request) throw new Error('resolve the pending rotation before starting another');
      if (method === 'enroll' && (profile.state === 'paired' || profile.rotation)) throw new Error('device is already paired');
      if (['admin', 'result', 'operations'].includes(method) && profile.state !== 'paired') throw new Error('pair the device as admin first');
      let operation;
      if (method === 'admin') {
        // The command ID is stored before anything is sent: a double tap, a timeout or a reconnect reuses it,
        // and the supervisor answers a repeated ID with the first result instead of a second effect.
        if (!ADMIN_KINDS.has(body.kind)) throw new Error('this command kind is not offered on the phone');
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
        if (JSON.stringify(args).length > 16384) throw new Error('command arguments are too large');
        profile.operations ??= {};
        if (body.commandId) {
          operation = profile.operations[body.commandId];
          if (!operation || operation.kind !== body.kind || JSON.stringify(operation.args) !== JSON.stringify(args)) throw new Error('unknown operation or changed arguments');
        } else {
          const commandId = `m-${body.kind}-${randomBytes(8).toString('hex')}`;
          operation = profile.operations[commandId] = { commandId, kind: body.kind, args, at: Date.now(), state: 'sending' };
          const ids = Object.keys(profile.operations);
          for (const id of ids.filter(id => FINAL.has(profile.operations[id].state)).slice(0, Math.max(0, ids.length - 30))) delete profile.operations[id];
          this.save(profile);
        }
      }
      let connection;
      try { connection = await this.connect(profile, profile.alias, method === 'objects'); }
      catch (error) { if (operation) { operation.state = 'notSent'; this.save(profile); throw new Error(`Koordinator nicht erreichbar; Auftrag ${operation.commandId} wurde nicht gesendet und kann mit derselben ID erneut gesendet werden (${error.message})`); } throw error; }
      try {
        const remote = connection.remote;
        if (method === 'enroll') {
          if (typeof body.token !== 'string' || !body.token) throw new Error('enrollment token is required');
          if (body.controlSpaceId && profile.controlSpaceId && body.controlSpaceId !== profile.controlSpaceId) throw new Error('QR control space identity mismatch');
          if (!profile.enrollment) { const info = await remote.info(); if (body.controlSpaceId && body.controlSpaceId !== info.spaceId || profile.controlSpaceId && profile.controlSpaceId !== info.spaceId) throw new Error('control space identity mismatch'); profile.controlSpaceId = info.spaceId; this.save(profile); }
          if (profile.enrollment) { try { await remote.authenticate(); } catch { /* pending unpaired enrollment */ } }
          const result = await remote.enroll(body.token, { request: profile.enrollment, beforeSend: async request => { profile.enrollment = request; profile.state = 'enrollment-pending'; this.save(profile); } });
          if (result.keyId !== profile.keyId || result.peerId !== profile.peerId) throw new Error('enrollment result identity mismatch'); profile.state = 'paired'; this.save(profile); return { result, profile };
        }
        if (method === 'enrollStatus') {
          // A paired profile describes the active key; the original enrollment claim
          // keeps the old key identity after rotation and must not decide current status.
          if (profile.state === 'paired') { await remote.authenticate(); return { result: { state: 'paired', keyId: profile.keyId, peerId: profile.peerId }, profile }; }
          if (!profile.enrollment) throw new Error('no enrollment request exists');
          try { await remote.authenticate(); } catch { /* unpaired status remains available at the gate */ }
          const result = await remote.enrollStatus(profile.enrollment);
          if (result.state === 'done') { if (result.result?.keyId !== profile.keyId || result.result?.peerId !== profile.peerId) throw new Error('enrollment status identity mismatch'); profile.state = 'paired'; this.save(profile); }
          return { result, profile };
        }
        if (method === 'rotationStatus') {
          if (!profile.rotation) {
            if (!profile.lastRotation) throw new Error('no rotation request exists');
            await remote.authenticate();
            return { result: await remote.rotationStatus(profile.lastRotation.commandId), profile };
          }
          if (!profile.rotation.challenge) return { result: { state: 'prepared', message: 'No rotation effect was sent; resume with rotate.' }, profile };
          const rotation = profile.rotation, commandId = `rotate:${profile.peerId}:${rotation.challenge.nonce}`;
          let result;
          const replacement = await this.connect(profile, rotation.alias);
          try { await replacement.remote.authenticate(); result = await replacement.remote.rotationStatus(commandId); }
          catch { await remote.authenticate(); result = await remote.rotationStatus(commandId); }
          finally { replacement.close(); }
          if (result?.state === 'completed') { Object.assign(profile, { alias: rotation.alias, keyId: rotation.keyId, publicKey: rotation.publicKey }); profile.lastRotation = { commandId, keyId: rotation.keyId }; delete profile.rotation; this.save(profile); }
          return { result, profile };
        }
        try { await remote.authenticate(); }
        catch (error) { if (operation) { operation.state = 'notSent'; this.save(profile); throw new Error(`Koordinator nicht erreichbar; Auftrag ${operation.commandId} wurde nicht gesendet und kann mit derselben ID erneut gesendet werden (${error.message})`); } throw error; }
        if (method === 'authenticate') return { result: { authenticated: true, keyId: profile.keyId, peerId: profile.peerId }, profile };
        if (method === 'admin') {
          try { await remote.write({ type: 'Command', fields: { commandId: operation.commandId, kind: operation.kind, args: operation.args } }, null, 3_600_000); }
          catch (error) { operation.state = 'unknown'; this.save(profile); throw new Error(`Ausgang wird geprüft (${operation.commandId}): ${error.message}`); }
          if (!FINAL.has(operation.state)) operation.state = 'sent';
          const result = await readResult(remote, operation.commandId);
          if (result) Object.assign(operation, { state: result.state, done: Date.now() });
          this.save(profile);
          return { operation, result, profile };
        }
        if (method === 'result' || method === 'operations') {
          const ids = method === 'result' ? [String(body.commandId ?? '')] : Object.keys(profile.operations ?? {});
          const out = [];
          for (const id of ids) {
            const op = profile.operations?.[id];
            const result = await readResult(remote, id);
            if (op && result && !FINAL.has(op.state)) Object.assign(op, { state: result.state, done: Date.now() });
            out.push({ ...(op ?? { commandId: id }), result });
          }
          this.save(profile);
          return method === 'result' ? { result: out[0].result, operation: out[0] } : { operations: out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) };
        }
        if (method === 'objects') return { result: { info: await remote.info(), stats: await remote.stats(), objects: await remote.readAll(null, { limit: 100 }) }, profile };
        if (method === 'rotate') {
          const replacement = profile.rotation ? await this.keys.androidSigner(profile.rotation.alias) : await this.keys.createAndroidSigner(profile.peerId, profile.controlHostId);
          if (profile.dataHostId) await this.keys.keyStoreCall({ method: 'allowHost', alias: replacement.alias, gateHostId: profile.dataHostId });
          profile.rotation = { alias: replacement.alias, keyId: replacement.keyId, publicKey: replacement.publicKey }; this.save(profile);
          const challenge = await remote.rotationChallenge(replacement.algorithm, replacement.publicKey); profile.rotation.challenge = challenge; this.save(profile);
          const result = await remote.rotateKey(challenge, replacement, { beforeSend: async request => { profile.rotation.request = request; this.save(profile); } });
          return { result, profile };
        }
        throw new Error('unsupported mobile space operation');
      } finally { connection.close(); }
    });
  }
}
