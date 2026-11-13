// Runs, workers and operations through admin commands (docs/betrieb-und-mobile-steuerung.en.md §7.2 in phi-spaces;
// what each field means: docs/steuerung.en.md here). Every action keeps its command ID; polling runs only while the page
// is visible; data is rendered as text only. Confirmations are shown on the page, never as browser dialogs.
import { lang, locale, t } from './i18n.js';
import { renderMenu } from './menu.js';
const token = renderMenu(), message = document.getElementById('ctl-message');
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FINAL = ['completed', 'failed', 'duplicate'];
const when = (t) => new Date(t).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });

/** The states of a run, in the words the page shows: label, colour, what it means. */
const RUN = {
  preparing: [t('Being prepared'), 'warn', t('The tasks are being created on the members; then the run starts by itself.')],
  running: [t('Running'), 'ok', t('Workers fetch tasks and compute.')],
  pausing: [t('Pausing'), 'warn', t('The pause was sent to all members; confirmations are still missing.')],
  pauseIncomplete: [t('Pause incomplete'), 'err', t('Not every member confirmed the pause. “Query state” asks again.')],
  paused: [t('Paused'), 'dim', t('No new tasks are handed out; running tasks were computed to the end.')],
  resuming: [t('Resuming'), 'warn', t('The resume was sent to all members; confirmations are still missing.')],
  stopping: [t('Stopping'), 'warn', t('The stop was sent to all members.')],
  stopped: [t('Stopped'), 'dim', t('Ended for good; the run cannot be started again. The result stays available.')],
  reconciling: [t('Reconciling'), 'warn', t('After a restore the states of the members are compared.')],
  needsReview: [t('Decision needed'), 'err', t('After a restore the states of the members do not agree. Decide below how to go on.')],
};
/** The states of an admin command. */
const OP = {
  accepted: [t('Accepted'), 'warn'], applying: [t('Being applied'), 'warn'], completed: [t('Done'), 'ok'],
  failed: [t('Failed'), 'err'], duplicate: [t('Already done'), 'dim'], needsReview: [t('Needs clarification'), 'err'],
};
const KIND = {
  startRun: t('Start run'), pauseRun: t('Pause run'), resumeRun: t('Resume run'), stopRun: t('Stop run'), runStatus: t('Query run state'),
  scheduleRun: t('Schedule run'), exportRun: t('Fetch result'), resolveRunRecovery: t('Decide recovery'), listRuns: t('Read runs'),
  setWorkers: t('Set workers'), listWorkers: t('Read workers'), createSpace: t('Create space'), archiveSpace: t('Archive space'),
  reactivateSpace: t('Reactivate space'), deleteSpace: t('Delete space'), planDeployment: t('Plan deployment'),
  exportDeployment: t('Export deployment'), listAlerts: t('Read alerts'), auditLog: t('Read audit'),
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
function ask(box, text, yes = t('Yes, run it')) {
  return new Promise((resolve) => {
    const ok = el('button', yes, 'ctl-danger'), no = el('button', t('Cancel')), row = el('div', undefined, 'ctl-row');
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
  // the bridge may still be busy with a call of an earlier page (e.g. before a reload): wait for it instead of failing
  for (let i = 0; ; i++) {
    try { return await requestOnce(method, body); }
    catch (e) { if (i >= 30 || !/another space operation is in progress/.test(e.message)) throw e; await sleep(1000); }
  }
}
async function requestOnce(method, body) {
  const response = await fetch('/api/spaces/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': token }, body: JSON.stringify(body) });
  const reply = await response.json(); if (!response.ok || reply.error) throw new Error(reply.error || 'HTTP ' + response.status); return reply;
}
/** The server's words, a little plainer. */
const plain = (m) => String(m)
  .replace(/.*not paired.*|.*no profile.*/i, () => t('The device is not paired yet. Pair it under “Spaces” first.'))
  .replace(/.*another space operation is in progress.*/, () => t('Another request of this device is still running. Try again in a moment.'))
  .replace(/.*ECONNREFUSED.*/, () => t('No connection to the coordinator: is it running, and is the device on the same network?'))
  .replace(/.*(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH).*/, () => t('Coordinator not reachable: is the device on the same network?'));

/** Sends one admin command (or resends a known one) and waits for its result while the page is visible. */
async function command(kind, args = {}, commandId, { quiet = false } = {}) {
  const buttons = [...document.querySelectorAll('main button')];
  // the pressed button shows that the command runs; the bar only when no button does
  const pressed = document.activeElement?.tagName === 'BUTTON' && document.activeElement.closest('main') ? document.activeElement : null, label = pressed?.textContent;
  if (pressed) { pressed.textContent = t('Running …'); pressed.classList.add('sp-busy-btn'); }
  buttons.forEach(b => b.disabled = true);
  const busy = (text) => { if (!quiet) say(pressed ? '' : text, pressed ? '' : 'busy'); };
  busy(t('{kind}: sending …', { kind: KIND[kind] ?? kind }));
  try {
    const sent = await api('admin', { kind, args, ...(commandId ? { commandId } : {}) });
    let result = sent.result; const id = sent.operation.commandId;
    busy(t('{kind}: accepted, waiting for the result … (command {id})', { kind: KIND[kind] ?? kind, id }));
    for (let i = 0; !result && i < 30; i++) {
      if (document.visibilityState !== 'visible') { say(t('Command {id} goes on running on the coordinator; its result then appears under Overview → Operations.', { id })); return null; }
      await sleep(1000); result = (await api('result', { commandId: id })).result;
    }
    if (!result) { say(t('Outcome still open (command {id}). Please do not start it again but ask again under Overview → Operations.', { id }), 'err'); return null; }
    const failed = result.state !== 'completed' || result.result?.phase === 'failed';
    if (failed) say(t('Refused: {e}', { e: result.error ?? result.result?.error ?? result.state }), 'err');
    else if (quiet) say(''); else say(t('{kind}: done.', { kind: KIND[kind] ?? kind }), 'ok');
    return failed ? null : result.result;
  } catch (error) { say(plain(error.message), 'err'); return null; }
  finally { buttons.forEach(b => b.disabled = false); if (pressed) { pressed.textContent = label; pressed.classList.remove('sp-busy-btn'); } }
}

// ── Übersicht ────────────────────────────────────────────────────────────────
function renderOperations(list) {
  const root = $('operations'); root.replaceChildren();
  if (!list.length) root.append(el('p', t('This device has not sent any commands yet.'), 'key-empty'));
  for (const op of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', KIND[op.kind] ?? op.kind), badge(OP[op.state] ?? [op.state, 'dim']));
    card.append(head, facts([[t('Time'), when(op.at)], [t('Command'), op.commandId], [t('Error'), op.result?.error ?? op.result?.result?.error]]));
    if (!FINAL.includes(op.state)) {
      const again = el('button', t('Ask for the outcome again'), 'sp-wide');
      again.addEventListener('click', () => command(op.kind, op.args, op.commandId).then(load.operations));
      card.append(again, el('p', t('Asks with the same command ID; the command is not run twice by this.'), 'sp-hint'));
    }
    root.append(card);
  }
}
function renderAlerts(list) {
  const root = $('alerts'); root.replaceChildren();
  if (!list.length) root.append(el('p', t('No alerts. That does not prove that everything runs: a host without a sign of life appears only once its heartbeat has expired.'), 'key-empty'));
  for (const a of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', a.subject), badge(a.severity === 'critical' ? [t('Critical'), 'err'] : [t('Notice'), 'warn']));
    card.append(head, el('p', a.message, 'ctl-text'), facts([[t('Source'), a.source]]));
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
    [t('Members'), run.members.join(', ')],
    [t('Revision'), run.revision],
    [t('Pending'), run.pending ? t('{kind} (revision {rev}), confirmed {n} of {total}', { kind: run.pending.kind, rev: run.pending.revision, n: run.pending.applied.length, total: run.members.length }) + (run.pending.missing.length ? t('; missing: {list}', { list: run.pending.missing.join(', ') }) : '') : ''],
    [t('Recovery'), run.recovery ? `${run.recovery.id}: ${run.recovery.stage}${run.recovery.abandoned ? t('; parked: {kind} r{rev}', { kind: run.recovery.abandoned.kind, rev: run.recovery.abandoned.revision }) : ''}` : ''],
  ]));
  const row = el('div', undefined, 'ctl-row'), box = el('div', undefined, 'ctl-confirm'), out = el('div');
  box.hidden = true;
  const button = (label, fn, cls) => { const b = el('button', label, cls); b.type = 'button'; b.addEventListener('click', fn); row.append(b); return b; };

  if (run.state === 'running') button(t('Pause'), async () => { await command('pauseRun', { runId: run.runId }); load.runs(); });
  if (run.state === 'paused') button(t('Resume'), async () => { await command('resumeRun', { runId: run.runId }); load.runs(); }, 'btn-primary');
  if (['pauseIncomplete', 'pausing', 'resuming'].includes(run.state)) button(t('Query state'), async () => { await command('runStatus', { runId: run.runId }); load.runs(); });
  button(t('Result'), async () => {
    const r = await command('exportRun', { runId: run.runId }); if (!r) return;
    out.replaceChildren(el('div', r.complete ? t('Complete result') : t('Partial result: the run is not finished yet'), 'ctl-sub'), facts([
      [t('Parts'), t('{found} of {expected}', { found: r.found, expected: r.expected })],
      [t('Missing'), r.missing.length ? r.missing.slice(0, 3).join(', ') + (r.missing.length > 3 ? ' …' : '') : ''],
      [t('Summary'), JSON.stringify(r.summary)],
      [t('Manifest'), r.manifestHash.slice(0, 16) + '…'],
      [t('Result hash'), r.resultHash.slice(0, 16) + '…'],
    ]));
  });
  if (run.state === 'running' || run.state === 'paused') {
    const kind = run.state === 'running' ? 'pause' : 'resume';
    button(kind === 'pause' ? t('Schedule pause') : t('Schedule resume'), () => {
      const f = el('form', undefined, 'sp-form ctl-plan'), input = el('input'), go = el('button', t('Schedule'), 'btn-primary sp-wide');
      input.type = 'datetime-local'; input.required = true; go.type = 'submit';
      const l = el('label', kind === 'pause' ? t('Pause at') : t('Resume at')); l.append(input);
      f.append(l, el('p', t('Local time of this device. The coordinator carries out the step at that time, even if the device is off then.'), 'sp-hint'), go);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); const at = new Date(input.value).getTime();
        if (!Number.isFinite(at) || at <= Date.now()) { say(t('Please pick a time in the future.'), 'err'); return; }
        const r = await command('scheduleRun', { runId: run.runId, kind, at });
        if (r) { say(t('Scheduled: {list}', { list: r.schedules.map(s => t(s.kind === 'pause' ? 'Pause on {at}' : 'Resume on {at}', { at: when(s.at) })).join(', ') }), 'ok'); out.replaceChildren(); }
      });
      out.replaceChildren(f);
    });
  }
  if (['running', 'paused', 'preparing'].includes(run.state)) button(t('Stop'), async () => {
    // plan preview first: the coordinator says whether the stop is accepted now and with which revision
    const preview = await command('stopRun', { runId: run.runId, dryRun: true }, undefined, { quiet: true });
    if (!preview) return;
    if (!preview.allowed) { say(t('Stopping is not possible right now: {reason}', { reason: preview.reason }), 'err'); return; }
    if (!await ask(box, t('Stop run “{run}” (revision {rev}) for good? It cannot be started again afterwards; the result so far stays available.', { run: run.runId, rev: preview.revision }), t('Stop for good'))) return;
    await command('stopRun', { runId: run.runId }); load.runs();
  }, 'ctl-danger');
  card.append(row, box, out);

  if (run.state === 'needsReview' && run.recovery?.viewHash) {
    const views = Object.entries(run.recovery.views ?? {}).map(([m, v]) => [m, `${v.gate?.state ?? t('no state')}${v.fence ? t(', open: {kind}', { kind: v.fence.kind }) : ''}${v.stopped ? t(', stopped') : ''}`]);
    card.append(el('div', t('States of the members'), 'ctl-sub'), facts(views), el('p', t('The decision is bound to exactly this checked state ({hash}…). If it changes first, the coordinator refuses.', { hash: run.recovery.viewHash.slice(0, 12) }), 'sp-hint'));
    const decide = el('div', undefined, 'ctl-row');
    for (const [label, decision, cls] of [[t('Set as paused'), 'pause'], [t('Resume'), 'resume'], [t('Stop for good'), 'stop', 'ctl-danger']]) {
      const b = el('button', label, cls); b.type = 'button';
      b.addEventListener('click', async () => {
        if (!await ask(box, t('Decide “{label}” for {run}?', { label, run: run.runId }))) return;
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
  $('sieve-calc').textContent = span > 0 && size > 0 ? `${t('{n} numbers in {tasks} tasks', { n: span.toLocaleString(locale), tasks: Math.ceil(span / size).toLocaleString(locale) })}${members ? t(', spread over {n} members', { n: members }) : ''}.` : t('“To” must be greater than “From”.');
}
sieve.addEventListener('input', sieveCalc);
$('sieve-box').addEventListener('toggle', () => {
  if (!sieve.runId.value) { const d = new Date(), p = (n) => String(n).padStart(2, '0'); sieve.runId.value = `${lang === 'de' ? 'sieb' : 'sieve'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  sieveCalc();
});
sieve.addEventListener('submit', async event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(sieve));
  if (Number(f.end) <= Number(f.start)) { say(t('“To” must be greater than “From”.'), 'err'); return; }
  const config = { runId: f.runId, start: Number(f.start), end: Number(f.end), blockSize: Number(f.blockSize) };
  const members = String(f.members).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (await command('startRun', { runId: f.runId, kind: 'sieve', config, members })) { $('sieve-box').open = false; sieve.runId.value = ''; load.runs(); }
});

// ── Worker ───────────────────────────────────────────────────────────────────
const workersForm = $('setworkers');
function renderWorkers(data) {
  const root = $('workers'); root.replaceChildren();
  if (!data.assignments.length) root.append(el('p', t('No assignments yet. Create one below.'), 'key-empty'));
  for (const a of data.assignments) {
    const applied = data.applied?.[a.hostId], state = applied?.workers?.assignments?.[a.assignmentId];
    const behind = applied && applied.workers.generation < a.generation;
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', a.assignmentId), badge(!applied ? [t('No report'), 'err'] : behind ? [t('Being taken over'), 'warn'] : (state?.active ?? 0) === a.count ? [t('As wanted'), 'ok'] : [t('Differs'), 'warn']));
    card.append(head, facts([
      [t('Wanted'), `${a.count} × ${a.kind}`],
      [t('Running'), applied ? t('{n} active, {stopping} stopping, {tasks} tasks done', { n: state?.active ?? 0, stopping: state?.stopping ?? 0, tasks: state?.tasks ?? 0 }) : ''],
      [t('Refused'), state?.rejected],
      ['Host', a.hostId], ['Space', a.targetSpace], [t('Run'), a.runId],
      [t('Report'), applied ? when(applied.at) : t('none: “offline” does not mean the workers have ended')],
    ]));
    const edit = el('button', t('Change count'), 'sp-wide'); edit.type = 'button';
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
  if (Number(f.count) === 0 && !await ask($('workers-confirm'), t('End all workers of “{name}”? Each stops after its current task.', { name: f.assignmentId }), t('End workers'))) return;
  if (await command('setWorkers', { assignmentId: f.assignmentId, hostId: f.hostId, kind: f.kind, targetSpace: f.targetSpace, count: Number(f.count), ...(f.runId ? { runId: f.runId } : {}) })) load.workers();
});

// ── Spaces ───────────────────────────────────────────────────────────────────
$('space-create').addEventListener('submit', async event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(event.target));
  const r = await command('createSpace', { hostId: f.hostId, alias: f.alias });
  if (r) say(t('{state}: {alias} has the space ID {id}', { state: r.existed ? t('Existed already') : t('Created'), alias: r.alias, id: r.spaceId }), 'ok');
});
$('space-change').addEventListener('submit', async event => {
  event.preventDefault(); const kind = event.submitter?.value, f = Object.fromEntries(new FormData(event.target));
  if (kind === 'deleteSpace' && !await ask($('space-confirm'), t('Delete space {id}? This works only for an archived, empty space without a run; the ID stays reserved. Cannot be undone.', { id: f.spaceId }), t('Delete'))) return;
  const r = await command(kind, { hostId: f.hostId, spaceId: f.spaceId });
  if (r) say(`${r.alias}: ${{ active: t('active'), archived: t('archived'), deleted: t('deleted') }[r.state] ?? r.state}`, 'ok');
});

// ── Mehr ─────────────────────────────────────────────────────────────────────
$('deployment').addEventListener('submit', async event => {
  event.preventDefault(); const kind = event.submitter?.value, root = $('deployment-result'); root.replaceChildren();
  let config; try { config = JSON.parse(new FormData(event.target).get('config')); } catch { say(t('The config is not valid JSON.'), 'err'); return; }
  const r = await command(kind, kind === 'planDeployment' ? { config } : { deployment: config.deployment }); if (!r) return;
  const card = el('div', undefined, 'card ctl-card');
  if (kind === 'planDeployment') {
    const head = el('div', undefined, 'ctl-head'); head.append(el('b', t('Plan')), badge(r.ready ? [t('Ready'), 'ok'] : [t('Blocked'), 'err']));
    card.append(head, facts(r.steps.map(s => [s.status, `${s.key}: ${s.detail}`])));
  } else card.append(el('pre', JSON.stringify(r, null, 2), 'sp-raw'));
  root.append(card);
});
function renderAudit(list) {
  const root = $('audit'); root.replaceChildren();
  if (!list.length) root.append(el('p', t('No admin commands yet.'), 'key-empty'));
  for (const r of list) {
    const card = el('div', undefined, 'card ctl-card'), head = el('div', undefined, 'ctl-head');
    head.append(el('b', KIND[r.kind] ?? r.kind), badge(OP[r.state] ?? [r.state, 'dim']));
    card.append(head, facts([[t('Time'), when(r.at)], [t('By'), r.requestedBy], [t('Command'), r.commandId], [t('Error'), r.error]]));
    root.append(card);
  }
}

// ── Laden und Reiter ─────────────────────────────────────────────────────────
const load = {
  async alerts() { const list = await command('listAlerts', {}, undefined, { quiet: true }); if (list) renderAlerts(list); },
  async audit() { const list = await command('auditLog', { limit: 50 }, undefined, { quiet: true }); if (list) renderAudit(list); },
  async operations() { try { renderOperations((await api('operations')).operations); } catch (e) { say(plain(e.message), 'err'); } },
  async runs() { const runs = await command('listRuns', { limit: 50 }, undefined, { quiet: true }); if (runs) $('runs').replaceChildren(...(runs.length ? runs.map(runCard) : [el('p', t('No runs yet. Start one below.'), 'key-empty')])); },
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
