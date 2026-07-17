import { MSG } from '../shared/constants.js';
import { saveVaultRecord, getLinkedFileHandle, saveLinkedFileHandle, clearLinkedFileHandle } from '../shared/store.js';

const send = msg => chrome.runtime.sendMessage(msg);
const $    = id  => document.getElementById(id);
const show = id  => $(id).classList.remove('hidden');
const hide = id  => $(id).classList.add('hidden');

let state = { initialized: false, unlocked: false, activeKeyFingerprint: null };
let vault = null;
let incomingCredentials = null;
let incomingFolders = null;

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Reset to a known clean state — prevents stale panels from a previous
  // lock/unlock cycle remaining visible after re-init.
  hide('unlock-panel');
  hide('keys-panel');
  hide('backup-panel');
  hide('session-panel');
  hide('vault-location-panel');
  hide('danger-zone');

  // Clear unlock form so private key and passphrase are never left in the DOM
  // across a lock/unlock cycle.
  $('u-key').value         = '';
  $('u-pass').value        = '';
  $('file-unlock-key').value = '';
  hide('u-err');

  // initVaultLocation runs regardless of lock state so it can pull the latest
  // vault from a linked file before we check whether the session is unlocked.
  await initVaultLocation();

  state = await send({ type: MSG.GET_STATE });

  const badge = $('lock-status');
  badge.classList.remove('hidden');

  if (!state.initialized) {
    badge.className = 'lock-badge locked';
    badge.textContent = 'Not initialized';
    show('unlock-panel');
    return;
  }

  if (!state.unlocked) {
    badge.className = 'lock-badge locked';
    badge.textContent = 'Locked';
    show('unlock-panel');
    // No other panels — nothing is accessible until the vault is unlocked.
    return;
  }

  badge.className = 'lock-badge unlocked';
  badge.textContent = 'Unlocked';
  show('keys-panel');
  show('backup-panel');
  show('session-panel');
  show('vault-location-panel');
  show('danger-zone');
  loadSettings();
  loadKeys();
  const vaultRes = await send({ type: MSG.GET_VAULT });
  if (vaultRes.success) { vault = vaultRes.vault; renderCredentialChecklist(); }
}

// ─── Unlock ───────────────────────────────────────────────────────────────────

$('form-unlock').onsubmit = async e => {
  e.preventDefault();
  hide('u-err');
  const res = await send({
    type:       MSG.UNLOCK,
    privateKey: $('u-key').value.trim(),
    passphrase: $('u-pass').value,
  });
  if (res.success) {
    state = await send({ type: MSG.GET_STATE });
    await init();
  } else {
    showErr('u-err', res.error || 'Incorrect key or passphrase.');
  }
};

// ─── Keys ────────────────────────────────────────────────────────────────────

async function loadKeys() {
  const res = await send({ type: MSG.GET_KEYS });
  if (!res.success) return;
  renderKeys(res.keys);
}

function renderKeys(keys) {
  const list = $('key-list');
  list.innerHTML = '';
  keys.forEach(k => {
    const item = document.createElement('div');
    item.className = 'key-item' + (k.fingerprint === state.activeKeyFingerprint ? ' ki-current' : '');

    // ── Top row ──
    const top = document.createElement('div');
    top.className = 'ki-top';

    const icon = document.createElement('div');
    icon.className = 'ki-icon';
    icon.textContent = '🗝️';

    const body = document.createElement('div');
    body.className = 'ki-body';
    const lbl = document.createElement('div');
    lbl.className = 'ki-label';
    lbl.textContent = k.label || k.userIds?.[0] || 'Unnamed Key';
    const uid = document.createElement('div');
    uid.className = 'ki-uid';
    uid.textContent = k.userIds?.[0] || '';
    const fp = document.createElement('div');
    fp.className = 'ki-fp';
    fp.textContent = k.fingerprint;
    body.append(lbl, uid, fp);

    const actions = document.createElement('div');
    actions.className = 'ki-actions';

    const shareBtn = document.createElement('button');
    shareBtn.className = 'ki-share';
    shareBtn.textContent = 'Share';
    shareBtn.title = 'Show / share public key';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ki-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove key';
    removeBtn.onclick = () => removeKey(k.fingerprint, keys.length);

    if (k.fingerprint === state.activeKeyFingerprint) {
      removeBtn.disabled = true;
      removeBtn.title = 'Cannot remove the currently active key while unlocked';
    }

    actions.append(shareBtn, removeBtn);
    top.append(icon, body, actions);

    // ── Public key panel (hidden by default) ──
    const panel = document.createElement('div');
    panel.className = 'ki-pubkey-panel hidden';

    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.rows = 5;
    ta.value = k.publicKey || '';

    const panelActions = document.createElement('div');
    panelActions.className = 'ki-pubkey-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-secondary';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(ta.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    };

    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-secondary';
    dlBtn.textContent = 'Download .asc';
    dlBtn.onclick = async () => {
      await saveFileDialog(
        ta.value,
        `humbleman-${k.fingerprint.slice(-8).toLowerCase()}-public.asc`,
        'PGP Public Key',
        'text/plain',
        ['.asc'],
      );
    };

    panelActions.append(copyBtn, dlBtn);
    panel.append(ta, panelActions);

    shareBtn.onclick = () => panel.classList.toggle('hidden');

    item.append(top, panel);
    list.appendChild(item);
  });
}

async function removeKey(fingerprint, totalKeys) {
  if (totalKeys <= 1) { alert('Cannot remove the last authorized key.'); return; }
  if (!confirm('Remove this key? The vault will no longer be decryptable with it.')) return;
  const res = await send({ type: MSG.REMOVE_KEY, fingerprint });
  if (res.success) { loadKeys(); syncToLinkedFile(); }
  else { alert('Failed: ' + res.error); }
}

$('btn-load-pubkey').onclick = () => $('file-pubkey-input').click();
$('file-pubkey-input').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { $('ak-key').value = ev.target.result.trim(); e.target.value = ''; };
  reader.readAsText(file);
};

function makeKeyLoader(btnId, inputId, textareaId) {
  $(btnId).onclick = () => $(inputId).click();
  $(inputId).onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { $(textareaId).value = ev.target.result.trim(); e.target.value = ''; };
    reader.readAsText(file);
  };
}

makeKeyLoader('btn-load-unlock-key', 'file-unlock-key', 'u-key');
makeKeyLoader('btn-load-imp-key',    'file-imp-key',    'imp-key');
makeKeyLoader('btn-load-merge-key',  'file-merge-key',  'merge-key');

$('form-add-key').onsubmit = async e => {
  e.preventDefault();
  hide('ak-err');
  const res = await send({
    type:            MSG.ADD_KEY,
    armoredPublicKey: $('ak-key').value.trim(),
    label:           $('ak-label').value.trim(),
  });
  if (res.success) {
    $('ak-key').value = '';
    $('ak-label').value = '';
    loadKeys();
    syncToLinkedFile();
  } else {
    showErr('ak-err', res.error);
  }
};

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const res = await send({ type: MSG.GET_SETTINGS });
  if (!res.success) return;
  $('auto-lock-select').value = String(res.settings.autoLockMinutes ?? 15);
  $('dismiss-select').value   = String(res.settings.dismissMinutes  ?? 0);
}

async function saveAllSettings() {
  await send({
    type: MSG.SAVE_SETTINGS,
    settings: {
      autoLockMinutes: Number($('auto-lock-select').value),
      dismissMinutes:  Number($('dismiss-select').value),
    },
  });
}

$('auto-lock-select').onchange = saveAllSettings;
$('dismiss-select').onchange   = saveAllSettings;

// ─── Export ───────────────────────────────────────────────────────────────────

$('btn-export').onclick = async () => {
  const res = await send({ type: MSG.EXPORT_VAULT });
  if (!res.success) { alert('Export failed: ' + res.error); return; }
  await saveFileDialog(res.data, `humbleman-vault-${Date.now()}.sitekey-vault`);
};

// ─── Import ───────────────────────────────────────────────────────────────────

$('btn-import-show').onclick = () => {
  const sec = $('import-section');
  sec.classList.toggle('hidden');
};

$('form-import').onsubmit = async e => {
  e.preventDefault();
  hide('imp-err');
  const file = $('import-file').files[0];
  if (!file) { showErr('imp-err', 'Select a vault file.'); return; }

  const data = await file.text();
  const res  = await send({
    type:       MSG.IMPORT_VAULT,
    data,
    privateKey: $('imp-key').value.trim(),
    passphrase: $('imp-pass').value,
  });
  if (res.success) {
    alert('Vault imported and unlocked successfully.');
    await syncToLinkedFile();
    await init();
    hide('import-section');
  } else {
    showErr('imp-err', res.error || 'Import failed.');
  }
};

// ─── Reset ────────────────────────────────────────────────────────────────────

$('btn-reset').onclick = async () => {
  const confirmed = confirm(
    'Are you sure? This will permanently delete your vault and all credentials.\n\nType "RESET" to confirm.'
  );
  if (!confirmed) return;
  const typed = prompt('Type RESET to confirm:');
  if (typed !== 'RESET') return;
  await send({ type: MSG.RESET_VAULT });
  await clearLinkedFileHandle();
  alert('Vault reset. Set up a new identity to continue.');
  chrome.tabs.create({ url: chrome.runtime.getURL('wizard/wizard.html') });
};

// ─── Export Site(s) ──────────────────────────────────────────────────────────

$('btn-export-select-show').onclick = () => $('export-select-section').classList.toggle('hidden');

function renderCredentialChecklist() {
  const list = $('cred-check-list');
  list.innerHTML = '';
  if (!vault) return;

  const credCheckboxes   = new Map(); // credId → <input>
  const folderCheckboxes = new Map(); // folderId → <input>
  const folderById       = new Map(vault.folders.map(f => [f.id, f]));

  // All folder IDs in the subtree rooted at folderId (inclusive). Iterates the
  // growing Set directly so new entries discovered during traversal are visited.
  function subtreeIds(folderId) {
    const ids = new Set([folderId]);
    for (const id of ids) {
      for (const f of vault.folders) {
        if (f.parentId === id) ids.add(f.id);
      }
    }
    return ids;
  }

  // Recompute a folder checkbox's checked/indeterminate state from its credential tree.
  function syncFolderCheckbox(folderId) {
    const cb = folderCheckboxes.get(folderId);
    if (!cb) return;
    const ids   = subtreeIds(folderId);
    const creds = vault.credentials.filter(c => ids.has(c.folderId ?? null));
    const n     = creds.filter(c => credCheckboxes.get(c.id)?.checked).length;
    cb.indeterminate = n > 0 && n < creds.length;
    cb.checked       = creds.length > 0 && n === creds.length;
  }

  // Walk up the folder ancestry syncing each folder's checkbox.
  function syncAncestors(folderId) {
    let id = folderId;
    while (id != null) { syncFolderCheckbox(id); id = folderById.get(id)?.parentId ?? null; }
  }

  function appendFolder(folder, depth) {
    const row = document.createElement('label');
    row.className = 'cred-check-item cred-check-folder';
    row.style.paddingLeft = `${12 + depth * 16}px`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.folderId = folder.id;
    folderCheckboxes.set(folder.id, cb);

    cb.onclick = () => {
      const checked = cb.checked;
      cb.indeterminate = false;
      const ids = subtreeIds(folder.id);
      for (const c of vault.credentials) {
        if (!ids.has(c.folderId ?? null)) continue;
        const ccb = credCheckboxes.get(c.id);
        if (ccb) ccb.checked = checked;
      }
      for (const id of ids) {
        if (id === folder.id) continue;
        const fcb = folderCheckboxes.get(id);
        if (fcb) { fcb.indeterminate = false; fcb.checked = checked; }
      }
      updateSelCount();
    };

    const icon = document.createElement('span');
    icon.className = 'cred-check-folder-icon';
    icon.textContent = '📁';

    const name = document.createElement('span');
    name.className = 'cred-check-name';
    name.textContent = folder.name;

    row.append(cb, icon, name);
    list.appendChild(row);
  }

  function appendCred(cred, depth) {
    const row = document.createElement('label');
    row.className = 'cred-check-item';
    row.style.paddingLeft = `${12 + depth * 16}px`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = cred.id;
    cb.dataset.credId = cred.id;
    credCheckboxes.set(cred.id, cb);

    cb.onchange = () => { syncAncestors(cred.folderId ?? null); updateSelCount(); };

    const name = document.createElement('span');
    name.className = 'cred-check-name';
    name.textContent = cred.name;
    const sub = document.createElement('span');
    sub.className = 'cred-check-sub';
    sub.textContent = cred.urls[0] || cred.username || '';

    row.append(cb, name, sub);
    list.appendChild(row);
  }

  function renderGroup(parentId, depth) {
    for (const folder of vault.folders.filter(f => (f.parentId ?? null) === parentId)) {
      const ids = subtreeIds(folder.id);
      if (!vault.credentials.some(c => ids.has(c.folderId ?? null))) continue;
      appendFolder(folder, depth);
      for (const c of vault.credentials.filter(c => c.folderId === folder.id)) {
        appendCred(c, depth + 1);
      }
      renderGroup(folder.id, depth + 1);
    }
    if (parentId === null) {
      const unfiled = vault.credentials.filter(c => !c.folderId);
      if (unfiled.length) {
        const hdr = document.createElement('div');
        hdr.className = 'cred-check-group-header';
        hdr.textContent = 'Uncategorized';
        list.appendChild(hdr);
        for (const c of unfiled) appendCred(c, 0);
      }
    }
  }

  renderGroup(null, 0);

  if (!vault.credentials.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px;color:var(--muted);font-size:13px';
    empty.textContent = 'No credentials yet.';
    list.appendChild(empty);
  }

  updateSelCount();
}

function updateSelCount() {
  const cbs = $('cred-check-list').querySelectorAll('input[data-cred-id]');
  const n = Array.from(cbs).filter(cb => cb.checked).length;
  $('sel-count').textContent = `${n} selected`;
  $('btn-export-selected').disabled = n === 0;
}

$('btn-sel-all').onclick = () => {
  $('cred-check-list').querySelectorAll('input[data-cred-id]').forEach(cb => cb.checked = true);
  $('cred-check-list').querySelectorAll('input[data-folder-id]').forEach(cb => {
    cb.checked = true; cb.indeterminate = false;
  });
  updateSelCount();
};
$('btn-sel-none').onclick = () => {
  $('cred-check-list').querySelectorAll('input[data-cred-id]').forEach(cb => cb.checked = false);
  $('cred-check-list').querySelectorAll('input[data-folder-id]').forEach(cb => {
    cb.checked = false; cb.indeterminate = false;
  });
  updateSelCount();
};

$('btn-export-selected').onclick = async () => {
  const ids = Array.from(
    $('cred-check-list').querySelectorAll('input[data-cred-id]:checked')
  ).map(cb => cb.value);
  hide('export-sel-err');
  const res = await send({ type: MSG.EXPORT_CREDENTIALS, credentialIds: ids });
  if (!res.success) { showErr('export-sel-err', res.error); return; }
  await saveFileDialog(res.data, `humbleman-site-export-${Date.now()}.sitekey-share`);
};

// ─── Import Site(s) ──────────────────────────────────────────────────────────

$('btn-merge-show').onclick = () => $('merge-section').classList.toggle('hidden');

$('form-merge-decrypt').onsubmit = async e => {
  e.preventDefault();
  hide('merge-err');
  const file = $('merge-file').files[0];
  if (!file) { showErr('merge-err', 'Select a site export file.'); return; }
  const data = await file.text();
  const res = await send({
    type:       MSG.IMPORT_CREDENTIALS,
    data,
    privateKey: $('merge-key').value.trim(),
    passphrase: $('merge-pass').value,
  });
  if (!res.success) { showErr('merge-err', res.error || 'Decryption failed.'); return; }
  incomingCredentials = res.credentials;
  incomingFolders     = res.folders;
  renderMergePreview();
  hide('merge-section');
  show('merge-preview');
};

function renderMergePreview() {
  const list = $('merge-preview-list');
  list.innerHTML = '';
  for (const c of incomingCredentials) {
    const existing = vault?.credentials.find(x => x.id === c.id);
    const row = document.createElement('div');
    row.className = 'merge-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.id = `merge-cb-${c.id}`;
    cb.checked = true;
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    label.className = 'merge-item-body';
    const name = document.createElement('div');
    name.className = 'merge-item-name';
    name.textContent = c.name;
    const detail = document.createElement('div');
    detail.className = 'merge-item-detail';
    detail.textContent = c.urls?.[0] || c.username || '';
    const badge = document.createElement('span');
    if (existing) {
      badge.className = 'merge-badge merge-badge-conflict';
      badge.textContent = 'Already exists — will overwrite if checked';
    } else {
      badge.className = 'merge-badge merge-badge-new';
      badge.textContent = 'New';
    }
    label.append(name, detail, badge);
    row.append(cb, label);
    list.appendChild(row);
  }
}

$('btn-confirm-merge').onclick = async () => {
  if (!vault) return;
  hide('merge-confirm-err');
  const selectedIds = new Set(
    Array.from($('merge-preview-list').querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value)
  );
  const toMerge = incomingCredentials.filter(c => selectedIds.has(c.id));
  if (!toMerge.length) { showErr('merge-confirm-err', 'No credentials selected.'); return; }

  const mergedFolders = [...vault.folders];
  for (const f of incomingFolders) {
    if (!mergedFolders.find(x => x.id === f.id)) mergedFolders.push(f);
  }
  let mergedCreds = [...vault.credentials];
  for (const c of toMerge) {
    const idx = mergedCreds.findIndex(x => x.id === c.id);
    if (idx >= 0) mergedCreds[idx] = c; else mergedCreds.push(c);
  }

  const mergedVault = { ...vault, folders: mergedFolders, credentials: mergedCreds };
  const res = await send({ type: MSG.SAVE_VAULT, vault: mergedVault });
  if (!res.success) { showErr('merge-confirm-err', 'Save failed: ' + res.error); return; }

  vault = mergedVault;
  renderCredentialChecklist();
  syncToLinkedFile();
  incomingCredentials = null;
  incomingFolders = null;
  hide('merge-preview');
  $('merge-file').value = '';
  $('merge-key').value  = '';
  $('merge-pass').value = '';
  alert(`Imported ${toMerge.length} credential${toMerge.length !== 1 ? 's' : ''} into your vault.`);
};

$('btn-cancel-merge').onclick = () => {
  incomingCredentials = null;
  incomingFolders = null;
  hide('merge-preview');
  show('merge-section');
};

// ─── Vault location ──────────────────────────────────────────────────────────

// Chrome's File System Access API rejects extensions containing hyphens, so the
// save picker uses the simple '.vault' extension.  The open picker omits a types
// filter so users can also select existing '.sitekey-vault' export files.
const FILE_SAVE_OPTS = {
  suggestedName: 'sitekey.vault',
  types: [{ description: 'Site Key Vault', accept: { 'application/octet-stream': ['.vault'] } }],
};

function setVlStatus(text) {
  $('vl-status').textContent = text;
}

function showLinkedState(handle) {
  $('vl-filename').textContent = handle.name;
  show('vl-linked');
  hide('vl-unlinked');
}

function showUnlinkedState() {
  hide('vl-linked');
  hide('vl-reauth');
  show('vl-unlinked');
}

async function syncToLinkedFile() {
  const handle = await getLinkedFileHandle();
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { setVlStatus('Needs re-authorization'); return false; }
    const res = await send({ type: MSG.EXPORT_VAULT });
    if (!res.success) return false;
    const writable = await handle.createWritable();
    await writable.write(res.data);
    await writable.close();
    setVlStatus('Synced');
    return true;
  } catch {
    setVlStatus('Sync error');
    return false;
  }
}

function firefoxProfilePath() {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('win'))  return 'C:\\Users\\<You>\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\';
  if (p.includes('mac'))  return '~/Library/Application Support/Firefox/Profiles/';
  return '~/.mozilla/firefox/';
}

async function initVaultLocation() {
  if (typeof window.showSaveFilePicker !== 'function') {
    const profilePath = firefoxProfilePath();
    const vlu = $('vl-unsupported');
    vlu.textContent = '';
    const s1 = document.createElement('strong');
    s1.textContent = 'External file sync is not available in Firefox.';
    const pathNote = document.createElement('p');
    pathNote.textContent =
      "Your vault is stored in Firefox's private IndexedDB inside your browser profile. " +
      'On this system the profile folder is typically at:';
    const codeEl = document.createElement('code');
    codeEl.style.wordBreak = 'break-all';
    codeEl.textContent = profilePath;
    const exportNote = document.createElement('p');
    exportNote.textContent = 'The IndexedDB files are binary and cannot be opened directly. Use ';
    const s2 = document.createElement('strong');
    s2.textContent = 'Export Vault';
    exportNote.append(s2, ' below to create a portable encrypted backup file.');
    vlu.append(s1, pathNote, codeEl, exportNote);
    show('vl-unsupported');
    $('vl-controls').style.display = 'none';
    return;
  }

  const handle = await getLinkedFileHandle();
  if (!handle) { showUnlinkedState(); return; }

  showLinkedState(handle);
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    // Only pull from file when locked — if the vault is already in session the
    // in-memory copy is authoritative and any file sync failures would cause
    // a stale file to overwrite live changes.
    const { unlocked } = await send({ type: MSG.GET_STATE });
    if (!unlocked) {
      try {
        const file = await handle.getFile();
        const record = JSON.parse(await file.text());
        if (record?.encryptedVault) await saveVaultRecord(record);
        setVlStatus('Ready — unlock to continue');
      } catch {
        setVlStatus('Could not read file');
      }
    } else {
      setVlStatus('Synced');
    }
  } else {
    setVlStatus('Access needed');
    show('vl-reauth');
  }
}

$('btn-vl-new').onclick = async () => {
  try {
    const handle = await window.showSaveFilePicker(FILE_SAVE_OPTS);
    const res = await send({ type: MSG.EXPORT_VAULT });
    if (!res.success) { alert('No vault to export. Complete the setup wizard first.'); return; }
    const writable = await handle.createWritable();
    await writable.write(res.data);
    await writable.close();
    await saveLinkedFileHandle(handle);
    showLinkedState(handle);
    setVlStatus('Synced');
  } catch (err) {
    if (err.name !== 'AbortError') alert('Could not create file: ' + err.message);
  }
};

$('btn-vl-existing').onclick = async () => {
  try {
    // No types filter — allows selecting both '.vault' and legacy '.sitekey-vault' files
    const [handle] = await window.showOpenFilePicker({ multiple: false });
    const file   = await handle.getFile();
    const record = JSON.parse(await file.text());
    if (!record?.encryptedVault) { alert('This does not appear to be a vault file.'); return; }
    if (!confirm('Replace your current vault with the contents of this file? You will need to unlock with your private key again.')) return;
    await saveVaultRecord(record);
    await send({ type: MSG.LOCK });
    await saveLinkedFileHandle(handle);
    showLinkedState(handle);
    setVlStatus('Loaded from file');
    await init();
  } catch (err) {
    if (err.name !== 'AbortError') alert('Could not read file: ' + err.message);
  }
};

$('btn-vl-unlink').onclick = async () => {
  if (!confirm('Unlink the external file? The vault remains in browser storage.')) return;
  await clearLinkedFileHandle();
  showUnlinkedState();
};

$('btn-vl-reauth').onclick = async () => {
  const handle = await getLinkedFileHandle();
  if (!handle) return;
  try {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      hide('vl-reauth');
      await syncToLinkedFile();
    }
  } catch { /* denied */ }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function saveFileDialog(text, suggestedName) {
  const blob = new Blob([text], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  // chrome.downloads.download with saveAs:true shows the system Save As dialog
  // from any extension page without requiring an active user gesture.
  chrome.downloads.download({ url, filename: suggestedName, saveAs: true })
    .catch(() => {})
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}

function showErr(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ─── Cross-context sync ───────────────────────────────────────────────────────

// Keep settings in sync when lock state changes from another context (side panel,
// auto-lock timer). VAULT_READY fires on unlock; VAULT_LOCKED fires on lock.
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === MSG.VAULT_READY) {
    // Only re-init if currently showing the locked screen
    if (!$('unlock-panel').classList.contains('hidden')) init();
  } else if (msg.type === MSG.VAULT_LOCKED) {
    // Only re-init if currently showing the unlocked content
    if ($('unlock-panel').classList.contains('hidden')) init();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
