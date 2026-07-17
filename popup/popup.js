import { MSG } from '../shared/constants.js';
import { getLinkedFileHandle } from '../shared/store.js';

const send = (msg) => chrome.runtime.sendMessage(msg);
const $  = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

let vault = null;
const collapsedFolders = new Set();

// ─── Setup poller ─────────────────────────────────────────────────────────────
// While the setup screen is visible, poll every second so the panel transitions
// to the vault view automatically when the wizard completes — works in both
// Chrome and Firefox without relying on cross-context storage or message events.

let _setupPoll = null;

function startSetupPoll() {
  if (_setupPoll) return;
  _setupPoll = setInterval(async () => {
    const { initialized } = await send({ type: MSG.GET_STATE });
    if (initialized) { stopSetupPoll(); init(); }
  }, 1000);
}

function stopSetupPoll() {
  clearInterval(_setupPoll);
  _setupPoll = null;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  stopSetupPoll();
  hide('v-setup');
  hide('v-locked');
  hide('v-vault');
  show('v-loading');

  const { initialized, unlocked } = await send({ type: MSG.GET_STATE });

  hide('v-loading');
  if (!initialized) { show('v-setup'); startSetupPoll(); return; }
  if (!unlocked) {
    $('unlock-key').value    = '';
    $('unlock-pass').value   = '';
    $('file-key-input').value = '';
    show('v-locked');
    return;
  }

  const res = await send({ type: MSG.GET_VAULT });
  if (!res.success) { show('v-locked'); return; }

  vault = res.vault;
  renderVault();
  show('v-vault');
  applyPendingFilter();
}

// ─── Pending site filter (from toast "View" click) ────────────────────────────

async function applyPendingFilter() {
  if ($('v-vault').classList.contains('hidden')) return;
  try {
    const data = await chrome.storage.session.get('siteKeyFilter');
    if (!data.siteKeyFilter) return;
    await chrome.storage.session.remove('siteKeyFilter');
    $('search').value = data.siteKeyFilter;
    renderVaultTree();
  } catch { /* session API unavailable */ }
}

function onVaultSessionChange(newVault) {
  if (!newVault) return;
  vault = newVault;
  if (!$('v-vault').classList.contains('hidden')) {
    // Vault view already showing — re-render in place, no loading flash
    renderVault();
  } else {
    // Locked / setup screen — an import just unlocked the vault, transition immediately
    hide('v-loading');
    hide('v-locked');
    hide('v-setup');
    renderVault();
    show('v-vault');
    applyPendingFilter();
  }
}

// Chrome: react to vault or filter changes written to session storage by the SW
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.siteKeyFilter?.newValue) applyPendingFilter();
  if ('vault' in changes) onVaultSessionChange(changes.vault?.newValue ?? null);
});

// SW broadcasts VAULT_READY / VAULT_LOCKED so all open extension pages stay in
// sync when lock state changes from another context (settings page, auto-lock).
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === MSG.VAULT_READY) {
    send({ type: MSG.GET_VAULT }).then(res => {
      if (res?.success) { onVaultSessionChange(res.vault); syncToLinkedFile(); }
    }).catch(() => {});
  } else if (msg.type === MSG.VAULT_LOCKED) {
    init();
  }
});

async function syncToLinkedFile() {
  if (typeof window.showSaveFilePicker !== 'function') return;
  const handle = await getLinkedFileHandle();
  if (!handle) return;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return; // silent — no user gesture to re-auth here
    const res = await send({ type: MSG.EXPORT_VAULT });
    if (!res.success) return;
    const writable = await handle.createWritable();
    await writable.write(res.data);
    await writable.close();
  } catch { /* silent */ }
}

// Last-resort fallback: re-sync on focus in case the message was missed.
window.addEventListener('focus', async () => {
  applyPendingFilter();
  const res = await send({ type: MSG.GET_VAULT }).catch(() => null);
  if (res?.success) onVaultSessionChange(res.vault);
});

// ─── Vault rendering ─────────────────────────────────────────────────────────

function renderVault() {
  renderVaultTree();
}

function renderVaultTree() {
  const tree  = $('vault-tree');
  const query = $('search').value.trim().toLowerCase();
  tree.innerHTML = '';

  // ── Flat search results — ignore folder grouping ──
  if (query) {
    const matches = vault.credentials.filter(c =>
      c.name.toLowerCase().includes(query) ||
      c.username.toLowerCase().includes(query) ||
      c.urls.some(u => u.toLowerCase().includes(query))
    );
    if (!matches.length) { tree.appendChild(emptyMsg('No matches.')); return; }
    matches.forEach(c => tree.appendChild(credEl(c)));
    return;
  }

  // ── No folders yet — flat list ──
  if (!vault.folders.length) {
    if (!vault.credentials.length) {
      tree.appendChild(emptyMsg('No credentials yet. Click ＋ to add one.'));
      return;
    }
    vault.credentials.forEach(c => tree.appendChild(credEl(c)));
    return;
  }

  // ── Group credentials by folderId ──
  const byFolder = {};
  vault.credentials.forEach(c => {
    const key = c.folderId || '';
    (byFolder[key] = byFolder[key] || []).push(c);
  });

  // ── Recursively render folder sections ──
  function renderGroup(parentId, depth) {
    vault.folders
      .filter(f => (f.parentId || null) === parentId)
      .forEach(f => {
        const creds     = byFolder[f.id] || [];
        const collapsed = collapsedFolders.has(f.id);

        const hd = document.createElement('div');
        hd.className = 'folder-section-hd';
        hd.style.paddingLeft = `${10 + depth * 16}px`;

        const arrow = document.createElement('span');
        arrow.className = 'folder-arrow';
        arrow.textContent = collapsed ? '▸' : '▾';

        const lbl = document.createElement('span');
        lbl.className = 'folder-section-label';
        lbl.textContent = '📁 ' + f.name;

        const badge = document.createElement('span');
        badge.className = 'folder-badge';
        if (creds.length) badge.textContent = creds.length;

        const acts = document.createElement('div');
        acts.className = 'folder-section-acts';
        const renBtn = iconBtn('✏️', 'Rename');
        renBtn.onclick = e => { e.stopPropagation(); renameFolder(f.id, f.name); };
        const delBtn = iconBtn('🗑', 'Delete folder');
        delBtn.onclick = e => { e.stopPropagation(); deleteFolder(f.id); };
        acts.append(renBtn, delBtn);

        hd.append(arrow, lbl, badge, acts);
        hd.onclick = () => {
          collapsedFolders.has(f.id) ? collapsedFolders.delete(f.id) : collapsedFolders.add(f.id);
          renderVaultTree();
        };
        tree.appendChild(hd);

        if (!collapsed) {
          creds.forEach(c => tree.appendChild(credEl(c)));
          renderGroup(f.id, depth + 1);
        }
      });
  }

  renderGroup(null, 0);

  // ── Unfiled credentials ──
  const unfiled = byFolder[''] || [];
  if (unfiled.length) {
    const hd = document.createElement('div');
    hd.className = 'folder-section-hd folder-section-hd--unfiled';
    const lbl = document.createElement('span');
    lbl.className = 'folder-section-label';
    lbl.textContent = '🗂 Unfiled';
    const badge = document.createElement('span');
    badge.className = 'folder-badge';
    badge.textContent = unfiled.length;
    hd.append(lbl, badge);
    tree.appendChild(hd);
    unfiled.forEach(c => tree.appendChild(credEl(c)));
  }

  if (!vault.credentials.length) {
    tree.appendChild(emptyMsg('No credentials yet. Click ＋ to add one.'));
  }
}

function emptyMsg(text) {
  const el = document.createElement('div');
  el.className = 'cred-empty';
  el.textContent = text;
  return el;
}

function renameFolder(id, currentName) {
  const name = prompt('Rename folder:', currentName);
  if (name?.trim()) {
    vault.folders = vault.folders.map(f => f.id === id ? { ...f, name: name.trim() } : f);
    saveVault().then(() => renderVaultTree());
  }
}

async function deleteFolder(id) {
  const hasCreds = vault.credentials.some(c => c.folderId === id);
  const msg = hasCreds
    ? 'Credentials in this folder will become unfiled. Delete folder?'
    : 'Delete this folder?';
  if (!confirm(msg)) return;
  vault.folders     = vault.folders.filter(f => f.id !== id);
  vault.credentials = vault.credentials.map(c =>
    c.folderId === id ? { ...c, folderId: null } : c
  );
  await saveVault();
  renderVaultTree();
}

function credEl(cred) {
  const div = document.createElement('div');
  div.className = 'cred-item';
  div.onclick = () => openCredModal(cred);

  // ── Main row ──
  const main = document.createElement('div');
  main.className = 'cred-main';

  const icon = document.createElement('div');
  icon.className = 'cred-icon';
  icon.textContent = '🔑';

  const body = document.createElement('div');
  body.className = 'cred-body';
  const name = document.createElement('div');
  name.className = 'cred-name';
  name.textContent = cred.name;
  const sub = document.createElement('div');
  sub.className = 'cred-sub';
  sub.textContent = cred.username || cred.urls[0] || '';
  body.append(name, sub);

  const actions = document.createElement('div');
  actions.className = 'cred-actions';
  const editBtn = iconBtn('✏️', 'Edit');
  const delBtn  = iconBtn('🗑', 'Delete');
  editBtn.onclick = e => { e.stopPropagation(); openCredModal(cred); };
  delBtn.onclick  = e => { e.stopPropagation(); deleteCred(cred.id); };
  actions.append(editBtn, delBtn);

  main.append(icon, body, actions);

  // ── Copy row ──
  const copyRow = document.createElement('div');
  copyRow.className = 'cred-copy-row';

  const copyUserBtn = document.createElement('button');
  copyUserBtn.className = 'cred-copy-btn';
  copyUserBtn.textContent = 'Copy Username';
  copyUserBtn.onclick = e => { e.stopPropagation(); flashCopy(copyUserBtn, cred.username); };

  const copyPassBtn = document.createElement('button');
  copyPassBtn.className = 'cred-copy-btn';
  copyPassBtn.textContent = 'Copy Password';
  copyPassBtn.onclick = e => { e.stopPropagation(); flashCopy(copyPassBtn, cred.password, true); };

  copyRow.append(copyUserBtn, copyPassBtn);
  div.append(main, copyRow);
  return div;
}

function iconBtn(text, title) {
  const b = document.createElement('button');
  b.className = 'icon-btn-sm';
  b.textContent = text;
  b.title = title;
  return b;
}

// ─── Credential modal ─────────────────────────────────────────────────────────

let editingCredId = null;

async function openCredModal(cred = null) {
  editingCredId = cred?.id ?? null;
  $('modal-cred-title').textContent = cred ? 'Edit Credential' : 'Add Credential';

  $('c-name').value  = cred?.name  ?? '';
  $('c-urls').value  = cred?.urls?.join('\n') ?? '';
  $('c-user').value  = cred?.username ?? '';
  $('c-pass').value  = cred?.password ?? '';
  $('c-notes').value = cred?.notes ?? '';

  if (!cred) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const parsed = new URL(tab.url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          $('c-urls').value = parsed.hostname;
          if (tab.title) $('c-name').value = tab.title;
        }
      }
    } catch { /* leave fields empty if tab query fails */ }
  }

  populateFolderSelect('c-folder', cred?.folderId ?? null);
  show('modal-cred');
  $('c-name').focus();
}

function closeCredModal() { hide('modal-cred'); }

async function saveCredModal(e) {
  e.preventDefault();
  const urls = $('c-urls').value.trim().split('\n').map(u => u.trim()).filter(Boolean);
  const updated = {
    id:        editingCredId ?? crypto.randomUUID(),
    folderId:  $('c-folder').value || null,
    name:      $('c-name').value.trim(),
    urls,
    username:  $('c-user').value,
    password:  $('c-pass').value,
    notes:     $('c-notes').value,
    updatedAt: Date.now(),
    createdAt: editingCredId
      ? (vault.credentials.find(c => c.id === editingCredId)?.createdAt ?? Date.now())
      : Date.now(),
  };

  if (editingCredId) {
    vault.credentials = vault.credentials.map(c => c.id === editingCredId ? updated : c);
  } else {
    vault.credentials.push(updated);
  }

  await saveVault();
  closeCredModal();
  renderVaultTree();
}

async function deleteCred(id) {
  if (!confirm('Delete this credential?')) return;
  vault.credentials = vault.credentials.filter(c => c.id !== id);
  await saveVault();
  renderVaultTree();
}

// ─── Folder modal ─────────────────────────────────────────────────────────────

let editingFolderId = null;

function openFolderModal(parentId = null) {
  editingFolderId = null;
  $('modal-folder-title').textContent = 'New Folder';
  $('f-name').value = '';
  populateFolderSelect('f-parent', parentId, true);
  show('modal-folder');
  $('f-name').focus();
}

function closeFolderModal() { hide('modal-folder'); }

async function saveFolderModal(e) {
  e.preventDefault();
  const name     = $('f-name').value.trim();
  const parentId = $('f-parent').value || null;
  if (!name) return;

  vault.folders.push({ id: crypto.randomUUID(), name, parentId });
  await saveVault();
  closeFolderModal();
  renderVaultTree();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function populateFolderSelect(selectId, currentValue, includeNone = false) {
  const sel = $(selectId);
  sel.innerHTML = '';

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = includeNone ? '(root)' : '— None (root) —';
  sel.appendChild(noneOpt);

  const addOpts = (folders, parentId, depth) => {
    folders.filter(f => f.parentId === parentId).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = '  '.repeat(depth) + f.name;
      if (f.id === currentValue) opt.selected = true;
      sel.appendChild(opt);
      addOpts(folders, f.id, depth + 1);
    });
  };
  addOpts(vault.folders, null, 0);
}

async function saveVault() {
  const res = await send({ type: MSG.SAVE_VAULT, vault });
  if (!res.success) alert('Save failed: ' + res.error);
}

async function flashCopy(btn, text, sensitive = false) {
  try { await navigator.clipboard.writeText(text || ''); } catch {}
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  if (sensitive) setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000);
}

function generatePassword() {
  const chars      = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  const maxUnbiased = 256 - (256 % chars.length);
  const result = [];
  while (result.length < 20) {
    const buf = new Uint8Array(20);
    crypto.getRandomValues(buf);
    for (const v of buf) {
      if (v < maxUnbiased) result.push(chars[v % chars.length]);
      if (result.length === 20) break;
    }
  }
  return result.join('');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  // Setup view
  $('btn-open-wizard').onclick = () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('wizard/wizard.html') });

  // Unlock form
  $('form-unlock').onsubmit = async e => {
    e.preventDefault();
    const btn = $('btn-unlock');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    hide('unlock-err');
    const res = await send({
      type:       MSG.UNLOCK,
      privateKey: $('unlock-key').value.trim(),
      passphrase: $('unlock-pass').value,
    });
    if (res.success) {
      const vaultRes = await send({ type: MSG.GET_VAULT });
      vault = vaultRes.vault;
      hide('v-locked');
      renderVault();
      show('v-vault');
    } else {
      const err = $('unlock-err');
      err.textContent = res.error || 'Incorrect key or passphrase.';
      show('unlock-err');
    }
    btn.disabled = false;
    btn.textContent = 'Unlock';
  };

  // Load private key from file
  $('btn-load-key').onclick = () => $('file-key-input').click();
  $('file-key-input').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      $('unlock-key').value = ev.target.result.trim();
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  // Vault toolbar
  $('btn-lock').onclick = async () => {
    await send({ type: MSG.LOCK });
    vault = null;
    hide('v-vault');
    $('unlock-key').value = '';
    $('unlock-pass').value = '';
    show('v-locked');
  };

  $('btn-open-options').onclick = () => chrome.runtime.openOptionsPage();

  $('btn-add-cred').onclick   = () => openCredModal();
  $('btn-add-folder').onclick = () => openFolderModal();

  $('search').oninput = () => renderVaultTree();

  // Credential modal
  document.querySelectorAll('.modal-close-cred').forEach(el => el.onclick = closeCredModal);
  $('modal-cred-backdrop').onclick = closeCredModal;
  $('form-cred').onsubmit = saveCredModal;
  $('btn-reveal').onclick = () => {
    const p = $('c-pass');
    p.type = p.type === 'password' ? 'text' : 'password';
  };
  $('btn-gen').onclick = () => { $('c-pass').value = generatePassword(); $('c-pass').type = 'text'; };

  // Folder modal
  document.querySelectorAll('.modal-close-folder').forEach(el => el.onclick = closeFolderModal);
  $('modal-folder-backdrop').onclick = closeFolderModal;
  $('form-folder').onsubmit = saveFolderModal;
});

// BMAC link (sidepanel only — hidden in popup via CSS)
document.getElementById('bmac-link')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://buymeacoffee.com/sormondocom' });
});
