import { t } from './i18n.js';
import { renderMenu } from './menu.js';
const token = renderMenu();
const $ = (id) => document.getElementById(id);
const message = $('space-message'), raw = $('space-result');

/** The states of a profile, in the words the page shows. */
const STATES = {
  none: { title: t('Not paired'), sub: t('Create the device key first.'), dot: 'dot-dim' },
  prepared: { title: t('Key ready'), sub: t('Now pair with the coordinator\'s code.'), dot: 'dot-warn' },
  'enrollment-pending': { title: t('Pairing in progress'), sub: t('The coordinator has not answered yet. “Check pairing status” asks again.'), dot: 'dot-warn' },
  paired: { title: t('Paired'), sub: t('The device can open the space.'), dot: 'dot-ok' },
};
const stepOf = (p) => !p ? 'prepare' : p.state === 'paired' ? 'paired' : 'pair';

let fade;
function say(text, kind = '') {
  clearTimeout(fade);
  message.hidden = !text; message.textContent = text || ''; message.className = 'sp-msg' + (kind ? ' sp-' + kind : '');
  // a success leaves the top after a while (it also stays next to its button); errors stay until the next action
  if (kind === 'ok') fade = setTimeout(() => { message.hidden = true; }, 8000);
}

function showProfile(profile) {
  const s = STATES[profile ? profile.state : 'none'] ?? { title: String(profile.state), sub: '', dot: 'dot-warn' };
  $('st-title').textContent = s.title;
  $('st-sub').textContent = profile?.rotation ? t('A key renewal is open (under “Advanced”).') : s.sub;
  $('st-dot').className = 'dot ' + s.dot;
  const facts = profile ? [[t('Device'), profile.peerId], [t('Coordinator'), profile.endpoint], ['Space', profile.dataSpace ? t('{space} on {endpoint}', { space: profile.dataSpace, endpoint: profile.dataEndpoint }) : t('none yet')]] : [];
  $('st-facts').replaceChildren(...facts.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v ?? ''; return [dt, dd]; }));
  const step = stepOf(profile);
  for (const el of document.querySelectorAll('[data-step]')) {
    const want = el.dataset.step;
    el.hidden = want === 'data' ? step !== 'paired' : want !== step;
  }
  if (profile) { const r = $('remote'); r.hostId.value ||= profile.remoteHostId ?? ''; r.endpoint.value ||= profile.remoteEndpoint ?? ''; if (profile.remoteSpace) r.space.value = profile.remoteSpace; }
  if (profile) { const f = $('data'); f.hostId.value ||= profile.dataHostId ?? ''; f.endpoint.value ||= profile.dataEndpoint ?? ''; f.space.value ||= profile.dataSpace ?? ''; }
}

function showSpace(result) {
  if (!result?.info) return;
  const { info, stats, objects } = result;
  $('sp-space').hidden = false;
  $('sp-space-title').textContent = info.alias || info.spaceId || 'Space';
  $('sp-space-sub').textContent = [stats?.entries != null ? t('{n} entries', { n: stats.entries }) : '', objects?.length >= 100 ? t('the first 100 shown') : ''].filter(Boolean).join(' · ');
  $('sp-objects').replaceChildren(...(objects ?? []).map((o) => {
    const li = document.createElement('li'), t = document.createElement('b'), f = document.createElement('span');
    t.textContent = o.type; f.textContent = Object.entries(o.fields ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
    li.append(t, f); return li;
  }));
}

/** The server's words, a little plainer. */
const plain = (m) => String(m)
  .replace(/^use tcp:\/\/OVERLAY-IP:PORT$/, () => t('Give the endpoint as tcp://ADDRESS:PORT, on Wi-Fi e.g. tcp://192.168.8.28:4100.'))
  .replace(/.*ECONNREFUSED.*/, () => t('No connection: is the coordinator running, and is the device on the same Wi-Fi?'))
  .replace(/.*(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH).*/, () => t('Address not reachable: is the device on the same Wi-Fi?'));

/** What a reply means, in words, for the actions whose result is otherwise only in the raw view. */
function describe(action, reply) {
  const r = reply.result ?? {}, p = reply.profile ?? {};
  switch (action) {
    case 'authenticate': return [t('Key proof valid: the coordinator recognised the device “{peer}” by its key ({key}…).', { peer: r.peerId ?? p.peerId, key: String(r.keyId ?? p.keyId ?? '').slice(0, 16) }), 'ok'];
    case 'rotate': return r.state === 'completed' ? [t('Key renewed: the coordinator took over the new key. Tap “Evaluate renewal” to finish.'), 'ok'] : [t('Renewal sent (state: {state}). “Evaluate renewal” asks whether it was taken over.', { state: r.state ?? t('unknown') }), ''];
    case 'rotationStatus': return r.state === 'completed' ? [t('Renewal finished: the device works with the new key ({key}…).', { key: String(p.keyId ?? '').slice(0, 16) }), 'ok'] : r.state === 'prepared' ? [t('The renewal was not sent yet. “Renew key” continues it.'), ''] : [t('Renewal still open (state: {state}). Evaluate again later.', { state: r.state ?? t('unknown') }), ''];
    case 'remoteHost': return [t('Saved: “Remote” now offers “{space} @ {endpoint} (over Space)”.', { space: p.remoteSpace, endpoint: p.remoteEndpoint }), 'ok'];
    case 'enrollStatus': return r.state === 'paired' || r.state === 'done' ? [t('Paired: the coordinator has taken the device in.'), 'ok'] : [t('Pairing still open (state: {state}). Check again later.', { state: r.state ?? t('unknown') }), ''];
    default: return null;
  }
}
const RESULT_BOX = { remoteHost: 'remote-result', authenticate: 'adv-result', rotate: 'adv-result', rotationStatus: 'adv-result', enrollStatus: 'pair-result' };
function showResult(action, text, kind) {
  const box = RESULT_BOX[action] && $(RESULT_BOX[action]); if (!box) return;
  box.hidden = !text; box.textContent = text || ''; box.className = 'sp-result' + (kind ? ' sp-' + kind : '');
}

async function call(action, body = {}, button) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach((b) => (b.disabled = true));
  const label = button?.textContent; if (button) { button.textContent = t('Running …'); button.classList.add('sp-busy-btn'); }
  showResult(action, '');
  // the pressed button shows that it runs; the bar only when no button does
  if (action !== 'status') say(button ? '' : t('Running …'), button ? '' : 'busy');
  try {
    const response = await fetch('/api/spaces/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': token }, body: JSON.stringify(body) });
    const reply = await response.json();
    if (!response.ok || reply.error) throw new Error(reply.error || 'HTTP ' + response.status);
    raw.textContent = JSON.stringify(reply, null, 2); $('sp-raw-box').hidden = false;
    if ('profile' in reply) showProfile(reply.profile);
    if (action === 'objects') showSpace(reply.result);
    const told = describe(action, reply);
    if (action === 'status') say(''); else say(told ? told[0] : t('Done.'), told ? told[1] : 'ok');
    if (told) showResult(action, ...told);
    return reply;
  } catch (error) { say(plain(error.message), 'err'); showResult(action, plain(error.message), 'err'); }
  finally { buttons.forEach((b) => (b.disabled = false)); if (button) { button.textContent = label; button.classList.remove('sp-busy-btn'); } }
}

for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => call(button.dataset.action, {}, button));
for (const [id, action] of [['prepare', 'prepare'], ['data', 'dataHost'], ['remote', 'remoteHost']]) $(id).addEventListener('submit', (event) => { event.preventDefault(); call(action, Object.fromEntries([...new FormData(event.target)].map(([k, v]) => [k, String(v).trim()])), event.submitter); });
$('pair').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('enroll-token'); let value = input.value.trim(), controlSpaceId; input.value = '';
  if (!value) { say(t('Please paste the pairing code.'), 'err'); return; }
  try {
    if (value.startsWith('{')) {
      const qr = JSON.parse(value), status = await call('status'); if (!status) return;
      if (qr.v !== 1 || qr.endpoint !== status.profile?.endpoint || (status.profile?.controlSpaceId && qr.space !== status.profile.controlSpaceId)) throw new Error(t('The QR content belongs to another coordinator than the prepared one.'));
      value = qr.token; controlSpaceId = qr.space;
    }
    await call('enroll', { token: value, controlSpaceId }, event.submitter);
  } catch (error) { say(plain(error.message), 'err'); }
  finally { value = ''; }
});
call('status');
