#!/usr/bin/env node
// The SSH path of the Remote page on a real phone and a real host (docs/remote-demo.md): drives the app's bridge over
// adb like the page does. Connects to a saved client over SSH, which sets up or updates pi-serverd on the host when
// needed, then lists, creates, attaches, reads state, history and an idle events long poll, renames and deletes a
// session of its own. No model is called unless --prompt is given (the host's own credentials, it may cost tokens).
//
//   node phone-ssh.mjs --device 192.168.8.35:41205 --target lux@192.168.8.28 [--allow-update] [--prompt "text"]
//
// --allow-update: a daemon that is running and outdated is replaced (running work on that host is interrupted);
// without it the script stops and says so. auth.json is never copied to the host.
import { randomUUID } from 'node:crypto';
import { arg, args, bridge, step } from './bridge.mjs';

const TARGET = arg('--target'), PROMPT = arg('--prompt');
if (!TARGET) { console.error('--target user@host[:port] (a client saved on the phone) is required'); process.exit(2); }
const { api, connect, close } = bridge();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the status names the last connect's error in `error`: that is part of the status, not a failed request
const status = () => api('GET', '/api/remote/status').catch((e) => e.reply ?? null);

try {
  step('reach the app bridge on the phone');
  connect();
  const clients = await api('GET', '/api/clients').catch(() => null);
  if (clients && !JSON.stringify(clients).includes(TARGET)) console.log(`note: ${TARGET} is not among the saved clients`);

  step(`connect over SSH to ${TARGET} (sets up or updates pi-serverd there when needed)`);
  const started = Date.now();
  // the log of the last connect stays until this one starts its own: show lines only once it changed
  const before = JSON.stringify((await status())?.log ?? []);
  let done = false, shown = 0, fresh = false;
  const watching = (async () => {
    while (!done) {
      const s = await status();
      if (!fresh && s?.log && JSON.stringify(s.log) !== before) fresh = true;
      if (fresh) { for (const line of s.log.slice(shown)) console.log(`  host: ${line}`); shown = s.log.length; }
      await sleep(1000);
    }
  })();
  let connected;
  try { connected = await api('POST', '/api/remote/connect', { target: TARGET, copyAuth: false, ...(args.includes('--allow-update') ? { allowUpdate: true } : {}) }); }
  finally {
    done = true; await watching;
    // a log the same as the last one never looked changed: show it now
    if (!fresh) for (const line of (await status())?.log ?? []) console.log(`  host: ${line}`);
  }
  if (connected.needsUpdate) { console.log(`pi-serverd on ${TARGET} is outdated (${connected.installed} → ${connected.available}): run again with --allow-update`); process.exit(3); }
  if (!connected.ok) throw new Error(`connect: ${JSON.stringify(connected)}`);
  console.log(`connected in ${Math.round((Date.now() - started) / 1000)} s to server ${connected.serverId}, host key ${connected.hostKey}; ${connected.sessions.sessions.length} sessions there`);

  step('models of the host');
  const models = (await api('GET', '/api/remote/models')).models;
  console.log(models.length ? models.slice(0, 5).map((m) => `${m.provider}/${m.modelId}`).join(', ') + (models.length > 5 ? ', …' : '') : 'none (no credential on the host)');

  step('a session of its own: create, attach, state, history');
  const name = `ssh-test ${new Date().toISOString().slice(0, 16)}`;
  const { id } = await api('POST', '/api/remote/create', { name });
  await api('POST', '/api/remote/attach', { id });
  const state = await api('GET', '/api/remote/state');
  const history = await api('GET', '/api/remote/history');
  console.log(`session ${id} „${name}“: busy ${state.busy}, ${history.entries.length} entries, cursor ${history.cursor}`);

  if (PROMPT) {
    step(`prompt: „${PROMPT}“ (the host's model)`);
    const sent = await api('POST', '/api/remote/prompt', { message: PROMPT, requestId: randomUUID() });
    console.log(`submitted ${sent.submissionId}`);
    for (let i = 0; i < 120; i++) {
      const s = await api('GET', '/api/remote/state');
      if (!s.busy && i > 1) break;
      await sleep(1000);
    }
    const last = (await api('GET', '/api/remote/history')).entries.at(-1);
    console.log(`last entry: ${JSON.stringify(last).slice(0, 300)}`);
  } else {
    step('events: an idle long poll (the host holds it 25 s)');
    const t0 = Date.now();
    const page = await api('GET', `/api/remote/events?after=${history.cursor}&epoch=${encodeURIComponent(history.epoch)}`);
    console.log(`answered after ${Math.round((Date.now() - t0) / 1000)} s with ${page.events.length} events`);
  }

  step('rename, delete');
  await api('POST', '/api/remote/rename', { id, name: `${name} (renamed)` });
  const listed = (await api('GET', '/api/remote/sessions')).sessions.find((s) => String(s.id) === String(id));
  console.log(`renamed: „${listed?.name}“`);
  await api('POST', '/api/remote/delete', { id });
  console.log(`deleted; still listed: ${(await api('GET', '/api/remote/sessions')).sessions.some((s) => String(s.id) === String(id))}`);

  step('disconnect');
  await api('POST', '/api/remote/disconnect', {});
  console.log(`\n✓ SSH path passed against ${TARGET}`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  close();
}
