import { MSG } from '../shared/constants.js';

const send = msg => chrome.runtime.sendMessage(msg);
const $    = id  => document.getElementById(id);
const show = id  => $(id).classList.remove('hidden');
const hide = id  => $(id).classList.add('hidden');

// ─── State ────────────────────────────────────────────────────────────────────

let primaryPublicKey  = null;   // armored public key of the primary identity
let primaryPrivateKey = null;   // armored private key (only for generated keys)
let extraKeys         = [];     // [{ publicKey, label, info }] — additional authorized keys
let isImportFlow      = false;  // tracks whether user chose generate vs import

// ─── Navigation ───────────────────────────────────────────────────────────────

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  show(id);
}

document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => showStep(btn.dataset.target));
});

// ─── Step 1: Choice ───────────────────────────────────────────────────────────

$('btn-create').onclick = () => { isImportFlow = false; showStep('step-2a'); };
$('btn-import').onclick = () => { isImportFlow = true;  showStep('step-2b'); };

// ─── Guard: vault already initialized ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const state = await send({ type: MSG.GET_STATE }).catch(() => null);
  if (state?.initialized) showStep('step-exists');
});

$('btn-go-settings').onclick = () => chrome.runtime.openOptionsPage();

// ─── Step 2a: Generate key ────────────────────────────────────────────────────

$('form-create').onsubmit = async e => {
  e.preventDefault();
  const name   = $('key-name').value.trim();
  const email  = $('key-email').value.trim();
  const pass   = $('key-pass').value;
  const pass2  = $('key-pass2').value;

  hide('create-err');

  if (pass !== pass2) {
    showErr('create-err', 'Passphrases do not match.');
    return;
  }
  if (pass.length < 8) {
    showErr('create-err', 'Passphrase must be at least 8 characters.');
    return;
  }

  const btn = $('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  const res = await send({ type: MSG.GENERATE_KEY, name, email: email || null, passphrase: pass });

  btn.disabled = false;
  btn.textContent = 'Generate Key Pair';

  if (!res.success) { showErr('create-err', res.error); return; }

  primaryPublicKey  = res.publicKey;
  primaryPrivateKey = res.privateKey;

  renderKeySummary(res, name);
  $('privkey-display').value = res.privateKey;
  $('pubkey-display').value  = res.publicKey;
  show('privkey-backup');
  show('pubkey-share');
  // Reset acknowledgment so re-generating always requires a fresh confirmation.
  $('ack-saved').checked = false;
  $('btn-to-step4').disabled = true;
  show('backup-ack');
  showStep('step-3');
};

// ─── Step 2b: Import key ──────────────────────────────────────────────────────

$('btn-load-import-key').onclick = () => $('file-import-key').click();
$('file-import-key').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { $('import-key').value = ev.target.result.trim(); e.target.value = ''; };
  reader.readAsText(file);
};

$('form-import').onsubmit = async e => {
  e.preventDefault();
  const armoredKey = $('import-key').value.trim();
  const passphrase = $('import-pass').value;

  hide('import-err');

  if (!armoredKey.includes('BEGIN PGP PRIVATE KEY')) {
    showErr('import-err', 'That does not look like a PGP private key block.');
    return;
  }

  const btn = $('btn-import-submit');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  // Get public key info from the private key
  const res = await send({ type: MSG.GET_KEY_INFO, armoredKey });

  btn.disabled = false;
  btn.textContent = 'Verify & Import';

  if (!res.success) { showErr('import-err', res.error || 'Invalid key.'); return; }

  primaryPrivateKey = armoredKey;
  primaryPublicKey  = res.armoredPublicKey;

  renderKeySummary(res, res.userIds?.[0] ?? 'Imported Key');
  $('pubkey-display').value = res.armoredPublicKey;
  hide('privkey-backup');
  hide('backup-ack');
  $('btn-to-step4').disabled = false;
  show('pubkey-share');
  showStep('step-3');
};

// ─── Step 3: Key summary ──────────────────────────────────────────────────────

function renderKeySummary(info, label) {
  const container = $('key-summary');
  container.innerHTML = '';
  const rows = [
    ['Name',        label],
    ['User ID',     info.userIds?.[0] ?? '—'],
    ['Key ID',      info.keyId],
    ['Fingerprint', info.fingerprint],
    ['Created',     new Date(info.creationTime).toLocaleDateString()],
  ];
  rows.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    const lbl = document.createElement('span');
    lbl.className = 'key-label';
    lbl.textContent = k;
    const val = document.createElement('span');
    val.className = 'key-value' + (k === 'Fingerprint' ? ' fp' : '');
    val.textContent = v;
    row.append(lbl, val);
    container.appendChild(row);
  });
}

$('btn-copy-privkey').onclick = async () => {
  await navigator.clipboard.writeText($('privkey-display').value);
  flashCopied($('btn-copy-privkey'));
};

$('btn-download-privkey').onclick = async () => {
  await saveAsc($('privkey-display').value, 'humbleman-private-key.asc');
};

$('btn-copy-pubkey').onclick = async () => {
  await navigator.clipboard.writeText($('pubkey-display').value);
  flashCopied($('btn-copy-pubkey'));
};

$('btn-download-pubkey').onclick = async () => {
  await saveAsc($('pubkey-display').value, 'humbleman-public-key.asc');
};

$('ack-saved').onchange = () => { $('btn-to-step4').disabled = !$('ack-saved').checked; };
$('btn-to-step4').onclick = () => showStep('step-4');

// ─── Step 4: Extra keys ───────────────────────────────────────────────────────

$('btn-load-extra-pubkey').onclick = () => $('file-extra-pubkey').click();
$('file-extra-pubkey').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { $('extra-pubkey').value = ev.target.result.trim(); e.target.value = ''; };
  reader.readAsText(file);
};

$('form-addkey').onsubmit = async e => {
  e.preventDefault();
  const armoredKey = $('extra-pubkey').value.trim();
  const label      = $('extra-label').value.trim();
  hide('addkey-err');

  if (!armoredKey.includes('BEGIN PGP PUBLIC KEY')) {
    showErr('addkey-err', 'Paste a PGP PUBLIC key block here (not a private key).');
    return;
  }

  const res = await send({ type: MSG.GET_KEY_INFO, armoredKey });
  if (!res.success) { showErr('addkey-err', res.error || 'Invalid public key.'); return; }

  const entry = { publicKey: armoredKey, label: label || res.userIds?.[0] || 'Extra Key', info: res };
  extraKeys.push(entry);
  renderExtraKeys();
  $('extra-pubkey').value = '';
  $('extra-label').value  = '';
};

function renderExtraKeys() {
  const list = $('extra-key-list');
  list.innerHTML = '';
  extraKeys.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'key-list-item';

    const info = document.createElement('div');
    info.className = 'kl-info';
    const lblEl = document.createElement('div');
    lblEl.className = 'kl-label';
    lblEl.textContent = entry.label;
    const fpEl = document.createElement('div');
    fpEl.className = 'kl-fp';
    fpEl.textContent = entry.info.fingerprint;
    info.append(lblEl, fpEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'kl-remove';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => { extraKeys.splice(i, 1); renderExtraKeys(); };

    item.append(info, removeBtn);
    list.appendChild(item);
  });
}

$('btn-finish').onclick = async () => {
  $('btn-finish').disabled = true;
  $('btn-finish').textContent = 'Creating Vault…';

  const res = await send({
    type:            MSG.INIT_VAULT,
    privateKey:      primaryPrivateKey,
    passphrase:      isImportFlow ? $('import-pass').value : $('key-pass').value,
    extraPublicKeys: extraKeys.map(k => k.publicKey),
    label:           $('key-name').value?.trim() || null,
  });

  $('btn-finish').disabled = false;
  $('btn-finish').textContent = 'Finish Setup →';

  if (!res.success) {
    alert('Setup failed: ' + (res.error || 'Unknown error'));
    return;
  }

  showStep('step-5');
};

// ─── Step 5: Done ─────────────────────────────────────────────────────────────

$('btn-done').onclick = () => window.close();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showErr(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function flashCopied(btn) {
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

async function saveAsc(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true })
    .catch(() => {})
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}

// BMAC link
document.getElementById('bmac-link')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://buymeacoffee.com/sormondocom' });
});
