// The app's bridge on the phone, reached over adb (the same HTTP API its pages use): shared by phone.mjs and
// phone-ssh.mjs (docs/remote-demo.md).
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = 'org.pimobile.app', DIR = 'files/home/.pi-mobile';
export const args = process.argv.slice(2);
export const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
export const step = (text) => console.log(`\n▸ ${text}`);

/** `adb` for the device, `asApp` a shell command as the app, `api` the bridge, `close` frees the forwarded port. */
export function bridge(device = arg('--device', process.env.ANDROID_SERIAL)) {
  if (!device) { console.error('--device SERIAL (adb devices) is required'); process.exit(2); }
  const ADB = arg('--adb', process.env.ADB || path.join(here, '../../tools/android-sdk/platform-tools/adb'));
  const adb = (...a) => execFileSync(ADB, ['-s', device, ...a], { encoding: 'utf8' }).trim();
  const asApp = (cmd) => adb('shell', `run-as ${APP} sh -c '${cmd}'`);
  let appPort, token, local;
  const connect = () => {
    appPort = asApp(`cat ${DIR}/port`); token = asApp(`cat ${DIR}/token`);
    local = adb('forward', 'tcp:0', `tcp:${appPort}`);
    console.log(`bridge on the phone at 127.0.0.1:${appPort}, here at 127.0.0.1:${local}`);
  };
  // the bridge answers only requests addressed to its own 127.0.0.1:<port> (a guard against DNS rebinding): the Host
  // header names the phone's port, not the forwarded one, so node:http instead of fetch (which cannot set Host)
  const api = (method, p, body) => new Promise((resolve, reject) => {
    if (!local) connect();
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: Number(local), path: p, method,
      headers: { host: `127.0.0.1:${appPort}`, 'x-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => {
        let reply = {};
        try { reply = JSON.parse(text); } catch {}
        if (res.statusCode >= 400 || reply.error) reject(Object.assign(new Error(`${p}: ${reply.error || res.statusCode}`), { reply })); else resolve(reply);
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  return { adb, asApp, api, connect, close() { if (local) try { adb('forward', '--remove', `tcp:${local}`); } catch {} } };
}
