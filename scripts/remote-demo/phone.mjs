#!/usr/bin/env node
// Remote-conversation demo, the phone's part (docs/remote-demo.md). Drives the app's own bridge on the phone
// (the same HTTP API its pages use) over `adb forward`: pairs the phone with the LAN coordinator, stores the agent
// host, connects the Remote page's state over the Space and runs one prompt. The phone's Android Keystore key, its
// runtime and its network path to the coordinator are the real ones; no page is touched.
//
//   node phone.mjs --device <adb-serial> --endpoint tcp://192.168.8.28:17460 --control b9-coord \
//                  --peer phone-b9 --token-file <dir>/bootstrap-token.txt [--message "hallo"]
//   --fresh: the coordinator's store is new, pair again even if the phone is set up for it
//   node phone.mjs --device … --restore      puts the phone's previous Spaces profile back
//
// Before pairing, the phone's current profile (space-profile.json) is moved to space-profile.before-remote-demo.json.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DIR, arg, args, bridge, step } from './bridge.mjs';

const BACKUP = 'space-profile.before-remote-demo.json';
const { asApp, api, connect, close } = bridge();

if (args.includes('--restore')) {
  step('put the previous Spaces profile back');
  console.log(asApp(`cd ${DIR} && if [ -f ${BACKUP} ]; then mv -f ${BACKUP} space-profile.json && echo restored; else echo "no ${BACKUP}"; fi`));
  process.exit(0);
}

const ENDPOINT = arg('--endpoint'), CONTROL = arg('--control'), PEER = arg('--peer'), TOKEN_FILE = arg('--token-file');
const MESSAGE = arg('--message', 'hallo vom Handy über den Space');
if (!ENDPOINT || !CONTROL || !PEER || !TOKEN_FILE) { console.error('--endpoint, --control, --peer and --token-file are required'); process.exit(2); }

step('reach the app bridge on the phone');
connect();

try {
  step('Spaces profile');
  let profile = (await api('POST', '/api/spaces/status', {})).profile;
  if (profile && !(profile.controlHostId === CONTROL && profile.endpoint === ENDPOINT && profile.peerId === PEER)) {
    console.log(`the phone is set up for ${profile.controlHostId} at ${profile.endpoint}: moved aside as ${BACKUP}`);
    console.log(asApp(`cd ${DIR} && if [ -f ${BACKUP} ]; then echo "${BACKUP} exists already, not overwritten" && exit 1; fi; mv space-profile.json ${BACKUP} && echo moved`));
    profile = null;
  } else if (profile && args.includes('--fresh')) {
    // a new coordinator (a fresh store) knows nothing of the key the last demo paired: the demo's own profile goes
    // to space-profile.remote-demo-old.json (replaced each time), the phone pairs anew
    console.log('the coordinator is new: the last demo\'s profile is set aside as space-profile.remote-demo-old.json');
    asApp(`cd ${DIR} && mv -f space-profile.json space-profile.remote-demo-old.json`);
    profile = null;
  }
  if (!profile) {
    step(`prepare: a new key in the Android Keystore for ${PEER} at ${CONTROL}`);
    profile = (await api('POST', '/api/spaces/prepare', { peerId: PEER, controlHostId: CONTROL, endpoint: ENDPOINT })).profile;
  }
  if (profile.state !== 'paired') {
    step('pair with the coordinator\'s bootstrap code');
    profile = (await api('POST', '/api/spaces/enroll', { token: readFileSync(TOKEN_FILE, 'utf8').trim() })).profile;
  }
  console.log(`paired: ${profile.peerId}, key ${String(profile.keyId).slice(0, 16)}…`);
  step('key proof at the coordinator');
  console.log(JSON.stringify((await api('POST', '/api/spaces/authenticate', {})).result));

  step('the agent host for remote conversations: the coordinator\'s Space `remote`');
  await api('POST', '/api/spaces/remoteHost', { hostId: CONTROL, endpoint: ENDPOINT, space: 'remote' });

  step('Remote: connect over the Space (key proof at the agent host, a grant per call; no SSH)');
  const connected = await api('POST', '/api/remote/connect-space', {});
  console.log(`connected to ${connected.serverId}; sessions: ${JSON.stringify(connected.sessions.sessions)}`);
  const { id } = await api('POST', '/api/remote/create', { name: 'demo über Space' });
  await api('POST', '/api/remote/attach', { id });
  console.log(`session ${id} created and chosen`);

  step(`prompt: „${MESSAGE}“`);
  const requestId = randomUUID();
  const sent = await api('POST', '/api/remote/prompt', { message: MESSAGE, requestId });
  console.log(`submitted ${sent.submissionId}`);
  let text = '';
  for (let i = 0; i < 60 && !/echo:|assistant/.test(text); i++) {
    const history = await api('GET', '/api/remote/history');
    text = JSON.stringify(history.entries);
    if (!text.includes('echo:')) await new Promise((r) => setTimeout(r, 500));
  }
  const echo = text.match(/echo: [^"\\]*/);
  if (!echo) throw new Error('no answer in the history after 30 s');
  console.log(`answer of the agent host: „${echo[0]}“`);

  step('disconnect');
  await api('POST', '/api/remote/disconnect', {});
  console.log('\n✓ demo passed: paired over WLAN, remote conversation over the Space, one prompt answered');
} finally {
  close();
}
