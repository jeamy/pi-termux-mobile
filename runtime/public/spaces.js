import { renderMenu } from './menu.js';
const token = renderMenu();
const $ = (id) => document.getElementById(id);
const message = $('space-message'), raw = $('space-result');

/** The states of a profile, in the words the page shows. */
const STATES = {
  none: { title: 'Nicht gekoppelt', sub: 'Lege zuerst den Geräteschlüssel an.', dot: 'dot-dim' },
  prepared: { title: 'Schlüssel bereit', sub: 'Jetzt mit dem Code des Koordinators koppeln.', dot: 'dot-warn' },
  'enrollment-pending': { title: 'Kopplung läuft', sub: 'Der Koordinator hat noch nicht geantwortet. „Stand der Kopplung prüfen“ fragt erneut.', dot: 'dot-warn' },
  paired: { title: 'Gekoppelt', sub: 'Das Gerät kann den Space öffnen.', dot: 'dot-ok' },
};
const stepOf = (p) => !p ? 'prepare' : p.state === 'paired' ? 'paired' : 'pair';

function say(text, kind = '') {
  message.hidden = !text; message.textContent = text || ''; message.className = 'sp-msg' + (kind ? ' sp-' + kind : '');
}

function showProfile(profile) {
  const s = STATES[profile ? profile.state : 'none'] ?? { title: String(profile.state), sub: '', dot: 'dot-warn' };
  $('st-title').textContent = s.title;
  $('st-sub').textContent = profile?.rotation ? 'Eine Schlüsselerneuerung ist offen (unter „Erweitert“).' : s.sub;
  $('st-dot').className = 'dot ' + s.dot;
  const facts = profile ? [['Gerät', profile.peerId], ['Koordinator', profile.endpoint], ['Space', profile.dataSpace ? `${profile.dataSpace} auf ${profile.dataEndpoint}` : 'noch keiner']] : [];
  $('st-facts').replaceChildren(...facts.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v ?? ''; return [dt, dd]; }));
  const step = stepOf(profile);
  for (const el of document.querySelectorAll('[data-step]')) {
    const want = el.dataset.step;
    el.hidden = want === 'data' ? step !== 'paired' : want !== step;
  }
  if (profile) { const f = $('data'); f.hostId.value ||= profile.dataHostId ?? ''; f.endpoint.value ||= profile.dataEndpoint ?? ''; f.space.value ||= profile.dataSpace ?? ''; }
}

function showSpace(result) {
  if (!result?.info) return;
  const { info, stats, objects } = result;
  $('sp-space').hidden = false;
  $('sp-space-title').textContent = info.alias || info.spaceId || 'Space';
  $('sp-space-sub').textContent = [stats?.entries != null ? `${stats.entries} Einträge` : '', objects?.length >= 100 ? 'die ersten 100 gezeigt' : ''].filter(Boolean).join(' · ');
  $('sp-objects').replaceChildren(...(objects ?? []).map((o) => {
    const li = document.createElement('li'), t = document.createElement('b'), f = document.createElement('span');
    t.textContent = o.type; f.textContent = Object.entries(o.fields ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
    li.append(t, f); return li;
  }));
}

/** The server's words, a little plainer. */
const plain = (m) => String(m)
  .replace(/^use tcp:\/\/OVERLAY-IP:PORT$/, 'Endpunkt als tcp://ADRESSE:PORT angeben, im WLAN z. B. tcp://192.168.8.28:4100.')
  .replace(/.*ECONNREFUSED.*/, 'Keine Verbindung: Läuft der Koordinator, und ist das Gerät im selben WLAN?')
  .replace(/.*(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH).*/, 'Adresse nicht erreichbar: Ist das Gerät im selben WLAN?');

async function call(action, body = {}) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach((b) => (b.disabled = true));
  if (action !== 'status') say('Läuft …');
  try {
    const response = await fetch('/api/spaces/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': token }, body: JSON.stringify(body) });
    const reply = await response.json();
    if (!response.ok || reply.error) throw new Error(reply.error || 'HTTP ' + response.status);
    raw.textContent = JSON.stringify(reply, null, 2); $('sp-raw-box').hidden = false;
    if ('profile' in reply) showProfile(reply.profile);
    if (action === 'objects') showSpace(reply.result);
    if (action === 'status') say(''); else say('Erledigt.', 'ok');
    return reply;
  } catch (error) { say(plain(error.message), 'err'); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => call(button.dataset.action));
for (const [id, action] of [['prepare', 'prepare'], ['data', 'dataHost']]) $(id).addEventListener('submit', (event) => { event.preventDefault(); call(action, Object.fromEntries([...new FormData(event.target)].map(([k, v]) => [k, String(v).trim()]))); });
$('pair').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('enroll-token'); let value = input.value.trim(), controlSpaceId; input.value = '';
  if (!value) { say('Bitte den Kopplungscode einfügen.', 'err'); return; }
  try {
    if (value.startsWith('{')) {
      const qr = JSON.parse(value), status = await call('status'); if (!status) return;
      if (qr.v !== 1 || qr.endpoint !== status.profile?.endpoint || (status.profile?.controlSpaceId && qr.space !== status.profile.controlSpaceId)) throw new Error('Der QR-Inhalt gehört zu einem anderen Koordinator als dem vorbereiteten.');
      value = qr.token; controlSpaceId = qr.space;
    }
    await call('enroll', { token: value, controlSpaceId });
  } catch (error) { say(plain(error.message), 'err'); }
  finally { value = ''; }
});
call('status');
