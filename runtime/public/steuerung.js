// Runs, workers and operations through admin commands (docs/betrieb-und-mobile-steuerung.en.md §7.2 in phi-spaces;
// what each field means: docs/steuerung.md here). Every action keeps its command ID; polling runs only while the page
// is visible; data is rendered as text only. Confirmations are shown on the page, never as browser dialogs.
import { renderMenu } from './menu.js';
const token = renderMenu(), message = document.getElementById('ctl-message');
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FINAL = ['completed', 'failed', 'duplicate'];
const when = (t) => new Date(t).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });

/** The states of a run, in the words the page shows: label, colour, what it means. */
const RUN = {
  preparing: ['Wird vorbereitet', 'warn', 'Die Tasks werden auf den Members angelegt; danach startet der Lauf von selbst.'],
  running: ['Läuft', 'ok', 'Worker holen Tasks und rechnen.'],
  pausing: ['Pausiert gerade', 'warn', 'Die Pause ist an alle Members geschickt; es fehlen noch Bestätigungen.'],
  pauseIncomplete: ['Pause unvollständig', 'err', 'Nicht jeder Member hat die Pause bestätigt. „Stand abfragen“ fragt erneut nach.'],
  paused: ['Pausiert', 'dim', 'Keine neuen Tasks werden vergeben; laufende Tasks wurden zu Ende gerechnet.'],
  resuming: ['Wird fortgesetzt', 'warn', 'Das Fortsetzen ist an alle Members geschickt; es fehlen noch Bestätigungen.'],
  stopping: ['Wird gestoppt', 'warn', 'Das Stoppen ist an alle Members geschickt.'],
  stopped: ['Gestoppt', 'dim', 'Endgültig beendet; der Lauf kann nicht wieder gestartet werden. Das Ergebnis bleibt abrufbar.'],
  reconciling: ['Abgleich', 'warn', 'Nach einer Wiederherstellung werden die Stände der Members verglichen.'],
  needsReview: ['Entscheidung nötig', 'err', 'Nach einer Wiederherstellung passen die Stände der Members nicht zusammen. Unten festlegen, wie es weitergeht.'],
};
/** The states of an admin command. */
const OP = {
  accepted: ['Angenommen', 'warn'], applying: ['Wird ausgeführt', 'warn'], completed: ['Erledigt', 'ok'],
  failed: ['Fehlgeschlagen', 'err'], duplicate: ['Bereits erledigt', 'dim'], needsReview: ['Klärung nötig', 'err'],
};
const KIND = {
  startRun: 'Lauf starten', pauseRun: 'Lauf pausieren', resumeRun: 'Lauf fortsetzen', stopRun: 'Lauf stoppen', runStatus: 'Laufstand abfragen',
  scheduleRun: 'Lauf planen', exportRun: 'Ergebnis abrufen', resolveRunRecovery: 'Recovery entscheiden', listRuns: 'Läufe lesen',
  setWorkers: 'Worker setzen', listWorkers: 'Worker lesen', createSpace: 'Space anlegen', archiveSpace: 'Space archivieren',
  reactivateSpace: 'Space reaktivieren', deleteSpace: 'Space löschen', planDeployment: 'Deployment planen',
  exportDeployment: 'Deployment exportieren', listAlerts: 'Hinweise lesen', auditLog: 'Audit lesen',
};
const badge = ([label, tone]) => el('span', label, 'ctl-badge ctl-' + tone);

function say(text, kind = '') { message.hidden = !text; message.textContent = text || ''; message.className = 'sp-msg' + (kind ? ' sp-' + kind : ''); }

/** Facts as a definition list; empty values are left out. */
function facts(pairs) {
  const dl = el('dl', undefined, 'sp-facts');
  for (const [k, v] of pairs) if (v !== undefined && v !== null && v !== '') dl.append(el('dt', k), el('dd', String(v)));
  return dl;
}

/** Asks on the page: the box shows the question with two buttons and resolves with the answer. */
function ask(box, text, yes = 'Ja, ausführen') {
  return new Promise((resolve) => {
    const ok = el('button', yes, 'ctl-danger'), no = el('button', 'Abbrechen'), row = el('div', undefined, 'ctl-row');
    ok.type = no.type = 'button';
    const done = (v) => { box.hidden = true; box.replaceChildren(); resolve(v); };
    ok.addEventListener('click', () => done(true)); no.addEventListener('click', () => done(false));
    row.append(ok, no); box.replaceChildren(el('p', text), row); box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

// The bridge serves one space operation at a time; page calls queue up instead of failing with "in progress".
let queue = Promise.resolve();
function api(method, body = {}) { const next = queue.then(() => request(method, body)); queue = next.catch(() => {}); return next; }
async function request(method, body) {
  const response = await fetch('/api/spaces/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': token }, body: JSON.stringify(body) });
  const reply = await response.json(); if (!response.ok || reply.error) throw new Error(reply.error || 'HTTP ' + response.status); return reply;
}
/** The server's words, a little plainer. */
const plain = (m) => String(m)
  .replace(/.*not paired.*|.*no profile.*/i, 'Das Gerät ist noch nicht gekoppelt. Zuerst unter „Spaces“ koppeln.')
  .replace(/.*ECONNREFUSED.*/, 'Keine Verbindung zum Koordinator: Läuft er, und ist das Gerät im selben Netz?')
  .replace(/.*(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH).*/, 'Koordinator nicht erreichbar: Ist das Gerät im selben Netz?');

/** Sends one admin command (or resends a known one) and waits for its result while the page is visible. */
async function command(kind, args = {}, commandId, { quiet = false } = {}) {
  const buttons = [...document.querySelectorAll('main button')];
  // the pressed button shows that the command runs; the bar only when no button does
  const pressed = document.activeElement?.tagName === 'BUTTON' && document.activeElement.closest('main') ? document.activeElement : null, label = pressed?.textContent;
  if (pressed) { pressed.textContent = 'Läuft …'; pressed.classList.add('sp-busy-btn'); }
  buttons.forEach(b => b.disabled = true);
  const busy = (text) => { if (!quiet) say(pressed ? '' : text, pressed ? '' : 'busy'); };
  busy(`${KIND[kind] ?? kind}: wird gesendet …`);
  try {
    const sent = await api('admin', { kind, args, ...(commandId ? { commandId } : {}) });
    let result = sent.result; const id = sent.operation.commandId;
    busy(`${KIND[kind] ?? kind}: angenommen, warte auf das Ergebnis … (Auftrag ${id})`);
    for (let i = 0; !result && i < 30; i++) {
      if (document.visibilityState !== 'visible') { say(`Auftrag ${id} läuft auf dem Koordinator weiter; das Ergebnis steht dann unter Übersicht → Vorgänge.`); return null; }
      await sleep(1000); result = (await api('result', { commandId: id })).result;
    }
    if (!result) { say(`Ausgang noch offen (Auftrag ${id}). Bitte nicht neu starten, sondern unter Übersicht → Vorgänge erneut abfragen.`, 'err'); return null; }
    const failed = result.state !== 'completed' || result.result?.phase === 'failed';
    if (failed) say(`Abgelehnt: ${result.error ?? result.result?.error ?? result.state}`, 'err');
    else if (quiet) say(''); else say(`${KIND[kind] ?? kind}: erledigt.`, 'ok');
    return failed ? null : result.result;
  } catch (error) { say(plain(error.message), 'err'); return null; }
  finally { buttons.forEach(b => b.disabled = false); if (pressed) { pressed.textContent = label; pressed.classList.remove('sp-busy-btn'); } }
}

// ── Übersicht ────────────────────────────────────────────────────────────────
function renderOperations(list) {
  const root = $('operations'); root.replaceChildren();
  if (!list.length) root.append(el('p', 'Dieses Gerät hat noch keine Aufträge gesendet.', 'key-empty'));
  for (const op of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', KIND[op.kind] ?? op.kind), badge(OP[op.state] ?? [op.state, 'dim']));
    card.append(head, facts([['Zeit', when(op.at)], ['Auftrag', op.commandId], ['Fehler', op.result?.error ?? op.result?.result?.error]]));
    if (!FINAL.includes(op.state)) {
      const again = el('button', 'Ausgang erneut abfragen', 'sp-wide');
      again.addEventListener('click', () => command(op.kind, op.args, op.commandId).then(load.operations));
      card.append(again, el('p', 'Fragt mit derselben Auftrags-ID nach; der Auftrag wird dadurch nicht doppelt ausgeführt.', 'sp-hint'));
    }
    root.append(card);
  }
}
function renderAlerts(list) {
  const root = $('alerts'); root.replaceChildren();
  if (!list.length) root.append(el('p', 'Keine Hinweise. Das beweist nicht, dass alles läuft: Ein Host ohne Lebenszeichen erscheint erst, wenn sein Heartbeat abgelaufen ist.', 'key-empty'));
  for (const a of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', a.subject), badge(a.severity === 'critical' ? ['Kritisch', 'err'] : ['Hinweis', 'warn']));
    card.append(head, el('p', a.message, 'ctl-text'), facts([['Quelle', a.source]]));
    root.append(card);
  }
}

// ── Läufe ────────────────────────────────────────────────────────────────────
function runCard(run) {
  const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
  const st = RUN[run.state] ?? [run.state, 'dim', ''];
  head.append(el('b', run.runId), badge(st));
  card.append(head, el('p', st[2], 'sp-hint'));
  card.append(facts([
    ['Members', run.members.join(', ')],
    ['Revision', run.revision],
    ['Offen', run.pending ? `${run.pending.kind} (Revision ${run.pending.revision}), bestätigt ${run.pending.applied.length} von ${run.members.length}${run.pending.missing.length ? '; fehlt: ' + run.pending.missing.join(', ') : ''}` : ''],
    ['Recovery', run.recovery ? `${run.recovery.id}: ${run.recovery.stage}${run.recovery.abandoned ? `; geparkt: ${run.recovery.abandoned.kind} r${run.recovery.abandoned.revision}` : ''}` : ''],
  ]));
  const row = el('div', undefined, 'ctl-row'), box = el('div', undefined, 'ctl-confirm'), out = el('div');
  box.hidden = true;
  const button = (label, fn, cls) => { const b = el('button', label, cls); b.type = 'button'; b.addEventListener('click', fn); row.append(b); return b; };

  if (run.state === 'running') button('Pausieren', async () => { await command('pauseRun', { runId: run.runId }); load.runs(); });
  if (run.state === 'paused') button('Fortsetzen', async () => { await command('resumeRun', { runId: run.runId }); load.runs(); }, 'btn-primary');
  if (['pauseIncomplete', 'pausing', 'resuming'].includes(run.state)) button('Stand abfragen', async () => { await command('runStatus', { runId: run.runId }); load.runs(); });
  button('Ergebnis', async () => {
    const r = await command('exportRun', { runId: run.runId }); if (!r) return;
    out.replaceChildren(el('div', r.complete ? 'Vollständiges Ergebnis' : 'Teilergebnis: der Lauf ist noch nicht fertig', 'ctl-sub'), facts([
      ['Teile', `${r.found} von ${r.expected}`],
      ['Fehlend', r.missing.length ? r.missing.slice(0, 3).join(', ') + (r.missing.length > 3 ? ' …' : '') : ''],
      ['Zusammenfassung', JSON.stringify(r.summary)],
      ['Manifest', r.manifestHash.slice(0, 16) + '…'],
      ['Ergebnis-Hash', r.resultHash.slice(0, 16) + '…'],
    ]));
  });
  if (run.state === 'running' || run.state === 'paused') {
    const kind = run.state === 'running' ? 'pause' : 'resume';
    button(kind === 'pause' ? 'Pause planen' : 'Fortsetzen planen', () => {
      const f = el('form', undefined, 'sp-form ctl-plan'), input = el('input'), go = el('button', 'Planen', 'btn-primary sp-wide');
      input.type = 'datetime-local'; input.required = true; go.type = 'submit';
      const l = el('label', kind === 'pause' ? 'Pausieren um' : 'Fortsetzen um'); l.append(input);
      f.append(l, el('p', 'Lokale Zeit dieses Geräts. Der Koordinator führt den Schritt zu diesem Zeitpunkt aus, auch wenn das Gerät dann aus ist.', 'sp-hint'), go);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); const at = new Date(input.value).getTime();
        if (!Number.isFinite(at) || at <= Date.now()) { say('Bitte einen Zeitpunkt in der Zukunft wählen.', 'err'); return; }
        const r = await command('scheduleRun', { runId: run.runId, kind, at });
        if (r) { say(`Geplant: ${r.schedules.map(s => `${s.kind === 'pause' ? 'Pause' : 'Fortsetzen'} am ${when(s.at)}`).join(', ')}`, 'ok'); out.replaceChildren(); }
      });
      out.replaceChildren(f);
    });
  }
  if (['running', 'paused', 'preparing'].includes(run.state)) button('Stoppen', async () => {
    // plan preview first: the coordinator says whether the stop is accepted now and with which revision
    const preview = await command('stopRun', { runId: run.runId, dryRun: true }, undefined, { quiet: true });
    if (!preview) return;
    if (!preview.allowed) { say(`Stoppen ist gerade nicht möglich: ${preview.reason}`, 'err'); return; }
    if (!await ask(box, `Lauf „${run.runId}“ (Revision ${preview.revision}) endgültig stoppen? Er kann danach nicht wieder gestartet werden; das bisherige Ergebnis bleibt abrufbar.`, 'Endgültig stoppen')) return;
    await command('stopRun', { runId: run.runId }); load.runs();
  }, 'ctl-danger');
  card.append(row, box, out);

  if (run.state === 'needsReview' && run.recovery?.viewHash) {
    const views = Object.entries(run.recovery.views ?? {}).map(([m, v]) => [m, `${v.gate?.state ?? 'kein Stand'}${v.fence ? ', offen: ' + v.fence.kind : ''}${v.stopped ? ', gestoppt' : ''}`]);
    card.append(el('div', 'Stände der Members', 'ctl-sub'), facts(views), el('p', `Die Entscheidung wird an genau diesen geprüften Stand gebunden (${run.recovery.viewHash.slice(0, 12)}…). Ändert er sich vorher, lehnt der Koordinator ab.`, 'sp-hint'));
    const decide = el('div', undefined, 'ctl-row');
    for (const [label, decision, cls] of [['Als pausiert festlegen', 'pause'], ['Fortsetzen', 'resume'], ['Endgültig stoppen', 'stop', 'ctl-danger']]) {
      const b = el('button', label, cls); b.type = 'button';
      b.addEventListener('click', async () => {
        if (!await ask(box, `„${label}“ für ${run.runId} festlegen?`)) return;
        await command('resolveRunRecovery', { runId: run.runId, expectedViewHash: run.recovery.viewHash, decision }); load.runs();
      });
      decide.append(b);
    }
    card.append(decide);
  }
  return card;
}

const sieve = $('sieve');
function sieveCalc() {
  const f = Object.fromEntries(new FormData(sieve)), span = Number(f.end) - Number(f.start), size = Number(f.blockSize);
  const members = String(f.members).split(/[,\n]/).map(s => s.trim()).filter(Boolean).length;
  $('sieve-calc').textContent = span > 0 && size > 0 ? `${span.toLocaleString('de-AT')} Zahlen in ${Math.ceil(span / size).toLocaleString('de-AT')} Tasks${members ? `, verteilt auf ${members} Member` : ''}.` : '„Bis“ muss größer als „Von“ sein.';
}
sieve.addEventListener('input', sieveCalc);
$('sieve-box').addEventListener('toggle', () => {
  if (!sieve.runId.value) { const d = new Date(), p = (n) => String(n).padStart(2, '0'); sieve.runId.value = `sieb-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  sieveCalc();
});
sieve.addEventListener('submit', async event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(sieve));
  if (Number(f.end) <= Number(f.start)) { say('„Bis“ muss größer als „Von“ sein.', 'err'); return; }
  const config = { runId: f.runId, start: Number(f.start), end: Number(f.end), blockSize: Number(f.blockSize) };
  const members = String(f.members).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (await command('startRun', { runId: f.runId, kind: 'sieve', config, members })) { $('sieve-box').open = false; sieve.runId.value = ''; load.runs(); }
});

// ── Worker ───────────────────────────────────────────────────────────────────
const workersForm = $('setworkers');
function renderWorkers(data) {
  const root = $('workers'); root.replaceChildren();
  if (!data.assignments.length) root.append(el('p', 'Noch keine Zuweisungen. Unten eine anlegen.', 'key-empty'));
  for (const a of data.assignments) {
    const applied = data.applied?.[a.hostId], state = applied?.workers?.assignments?.[a.assignmentId];
    const behind = applied && applied.workers.generation < a.generation;
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', a.assignmentId), badge(!applied ? ['Kein Bericht', 'err'] : behind ? ['Wird übernommen', 'warn'] : (state?.active ?? 0) === a.count ? ['Wie gewünscht', 'ok'] : ['Weicht ab', 'warn']));
    card.append(head, facts([
      ['Gewünscht', `${a.count} × ${a.kind}`],
      ['Läuft', applied ? `${state?.active ?? 0} aktiv, ${state?.stopping ?? 0} beendend, ${state?.tasks ?? 0} Tasks erledigt` : ''],
      ['Abgelehnt', state?.rejected],
      ['Host', a.hostId], ['Space', a.targetSpace], ['Lauf', a.runId],
      ['Bericht', applied ? when(applied.at) : 'keiner: „offline“ heißt nicht, dass die Worker beendet sind'],
    ]));
    const edit = el('button', 'Anzahl ändern', 'sp-wide'); edit.type = 'button';
    edit.addEventListener('click', () => {
      for (const k of ['assignmentId', 'hostId', 'kind', 'targetSpace', 'count']) workersForm[k].value = a[k];
      workersForm.runId.value = a.runId ?? '';
      $('workers-box').open = true; workersForm.count.focus(); workersForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    card.append(edit); root.append(card);
  }
}
workersForm.addEventListener('submit', async event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(workersForm));
  if (Number(f.count) === 0 && !await ask($('workers-confirm'), `Alle Worker von „${f.assignmentId}“ beenden? Jeder hört nach seinem laufenden Task auf.`, 'Worker beenden')) return;
  if (await command('setWorkers', { assignmentId: f.assignmentId, hostId: f.hostId, kind: f.kind, targetSpace: f.targetSpace, count: Number(f.count), ...(f.runId ? { runId: f.runId } : {}) })) load.workers();
});

// ── Spaces ───────────────────────────────────────────────────────────────────
$('space-create').addEventListener('submit', async event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(event.target));
  const r = await command('createSpace', { hostId: f.hostId, alias: f.alias });
  if (r) say(`${r.existed ? 'Gab es schon' : 'Angelegt'}: ${r.alias} hat die Space-ID ${r.spaceId}`, 'ok');
});
$('space-change').addEventListener('submit', async event => {
  event.preventDefault(); const kind = event.submitter?.value, f = Object.fromEntries(new FormData(event.target));
  if (kind === 'deleteSpace' && !await ask($('space-confirm'), `Space ${f.spaceId} löschen? Das geht nur bei einem archivierten, leeren Space ohne Lauf; die ID bleibt reserviert. Nicht rückgängig zu machen.`, 'Löschen')) return;
  const r = await command(kind, { hostId: f.hostId, spaceId: f.spaceId });
  if (r) say(`${r.alias}: ${{ active: 'aktiv', archived: 'archiviert', deleted: 'gelöscht' }[r.state] ?? r.state}`, 'ok');
});

// ── Mehr ─────────────────────────────────────────────────────────────────────
$('deployment').addEventListener('submit', async event => {
  event.preventDefault(); const kind = event.submitter?.value, root = $('deployment-result'); root.replaceChildren();
  let config; try { config = JSON.parse(new FormData(event.target).get('config')); } catch { say('Die Config ist kein gültiges JSON.', 'err'); return; }
  const r = await command(kind, kind === 'planDeployment' ? { config } : { deployment: config.deployment }); if (!r) return;
  const card = el('div', undefined, 'card ctl-card');
  if (kind === 'planDeployment') {
    const head = el('div', undefined, 'ctl-head'); head.append(el('b', 'Plan'), badge(r.ready ? ['Bereit', 'ok'] : ['Blockiert', 'err']));
    card.append(head, facts(r.steps.map(s => [s.status, `${s.key}: ${s.detail}`])));
  } else card.append(el('pre', JSON.stringify(r, null, 2), 'sp-raw'));
  root.append(card);
});
function renderAudit(list) {
  const root = $('audit'); root.replaceChildren();
  if (!list.length) root.append(el('p', 'Noch keine Admin-Aufträge.', 'key-empty'));
  for (const r of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', KIND[r.kind] ?? r.kind), badge(OP[r.state] ?? [r.state, 'dim']));
    card.append(head, facts([['Zeit', when(r.at)], ['Von', r.requestedBy], ['Auftrag', r.commandId], ['Fehler', r.error]]));
    root.append(card);
  }
}

// ── Laden und Reiter ─────────────────────────────────────────────────────────
const load = {
  async alerts() { const list = await command('listAlerts', {}, undefined, { quiet: true }); if (list) renderAlerts(list); },
  async audit() { const list = await command('auditLog', { limit: 50 }, undefined, { quiet: true }); if (list) renderAudit(list); },
  async operations() { try { renderOperations((await api('operations')).operations); } catch (e) { say(plain(e.message), 'err'); } },
  async runs() { const runs = await command('listRuns', { limit: 50 }, undefined, { quiet: true }); if (runs) $('runs').replaceChildren(...(runs.length ? runs.map(runCard) : [el('p', 'Noch keine Läufe. Unten einen starten.', 'key-empty')])); },
  async workers() { const data = await command('listWorkers', {}, undefined, { quiet: true }); if (data) renderWorkers(data); },
};
for (const b of document.querySelectorAll('[data-load]')) b.addEventListener('click', () => load[b.dataset.load]());

/** What a tab reads when it is opened the first time. */
const FIRST = { overview: ['operations', 'alerts'], runs: ['runs'], workers: ['workers'], spaces: [], more: [] };
const opened = new Set();
function show(tab) {
  if (!FIRST[tab]) tab = 'overview';
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  if (!opened.has(tab)) { opened.add(tab); (async () => { for (const k of FIRST[tab]) await load[k](); })(); }
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => { say(''); show(b.dataset.tab); });
show(location.hash.slice(1));
