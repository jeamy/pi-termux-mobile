import { API } from './constants.js';
import { renderMenu } from './menu.js';

const token = renderMenu();
const q = (p) => `${p}?token=${encodeURIComponent(token)}`;
const list = document.getElementById('client-list');
const msg = document.getElementById('msg');
const addForm = document.getElementById('add-form');
document.getElementById('add-toggle')?.addEventListener('click', () => {
  addForm.classList.toggle('hidden');
});

const post = (path, body) => fetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-token': token },
  body: JSON.stringify(body),
});

// --- ssh key ----------------------------------------------------------------

async function loadKey() {
  const r = await fetch(`${API.sshkey}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  document.getElementById('sshkey-status').textContent = j.exists
    ? 'key exists (ed25519)'
    : 'no key yet';
  const pub = document.getElementById('sshkey-pub');
  if (j.pubkey) { pub.textContent = j.pubkey; pub.classList.remove('hidden'); }
  document.getElementById('sshkey-gen').classList.toggle('hidden', !!j.exists);
}
document.getElementById('sshkey-gen').addEventListener('click', async () => {
  msg.textContent = 'generating…';
  const r = await post(API.sshkey, {});
  msg.textContent = r.ok ? 'key generated' : 'error generating key';
  loadKey();
});

// --- hosts -------------------------------------------------------------------

async function load() {
  const r = await fetch(`${API.clients}?token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({ clients: [] }));
  list.innerHTML = '';
  if (!j.clients?.length) {
    list.innerHTML = '<div class="key-empty">no hosts yet — add one below</div>';
    return;
  }
  for (const c of j.clients) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = c.name;
    const tgt = document.createElement('span');
    tgt.className = 'key-hint';
    tgt.textContent = c.target;

    const go = document.createElement('button');
    go.textContent = '▸_';
    go.title = 'connect (pi cli)';
    go.addEventListener('click', () => {
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(c.target)}`;
    });

    const copy = document.createElement('button');
    copy.textContent = '⇧key';
    copy.title = 'copy ssh key (ssh-copy-id)';
    copy.addEventListener('click', () => {
      location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(c.target)}&sshop=copyid`;
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'key-del';
    del.addEventListener('click', async () => {
      await post(API.clients, { delete: c.name });
      load();
    });

    const edit = document.createElement('button');
    edit.textContent = '✎';
    edit.title = 'edit name and address';
    edit.addEventListener('click', () => row.replaceWith(editRow(c, row)));

    row.append(name, tgt, go, copy, edit, del);
    list.appendChild(row);
  }
}

/** The row of a host as a form: name and address editable, saved in place. */
function editRow(c, row) {
  const f = document.createElement('form');
  f.className = 'client-edit';
  const field = (label, value, attrs = {}) => {
    const l = document.createElement('label'), i = document.createElement('input');
    l.textContent = label; i.value = value; i.autocomplete = 'off'; i.autocapitalize = 'off'; i.spellcheck = false;
    Object.assign(i, attrs); l.append(i); f.append(l); return i;
  };
  const name = field('name', c.name);
  const target = field('address (user@host[:port])', c.target, { required: true, inputMode: 'url' });
  const bar = document.createElement('div'), save = document.createElement('button'), cancel = document.createElement('button');
  bar.className = 'client-edit-bar';
  save.type = 'submit'; save.textContent = 'save'; save.className = 'btn-primary';
  cancel.type = 'button'; cancel.textContent = 'cancel';
  cancel.addEventListener('click', () => f.replaceWith(row));
  bar.append(save, cancel); f.append(bar);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const r = await post(API.clients, { edit: c.name, name: name.value.trim(), target: target.value.trim() });
    const j = await r.json().catch(() => ({}));
    save.disabled = false;
    if (!j.ok) { msg.textContent = `error: ${j.error || r.status}`; return; }
    msg.textContent = 'saved';
    load();
  });
  setTimeout(() => target.focus(), 0);
  return f;
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-name').value.trim();
  const target = document.getElementById('add-target').value.trim();
  if (!target) return;
  const r = await post(API.clients, { name, target });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { msg.textContent = `error: ${j.error || r.status}`; return; }
  msg.textContent = 'added';
  document.getElementById('add-name').value = '';
  document.getElementById('add-target').value = '';
  load();
  addForm.classList.add('hidden');
  // auto-flow: ensure key exists, then offer interactive ssh-copy-id
  const k = await fetch(`${API.sshkey}?token=${encodeURIComponent(token)}`).then((x) => x.json());
  if (!k.exists) await post(API.sshkey, {});
  location.href = `/terminal.html?token=${encodeURIComponent(token)}&ssh=${encodeURIComponent(target)}&sshop=copyid`;
});

loadKey();
load();
