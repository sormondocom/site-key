import { MSG, DEFAULTS } from '../shared/constants.js';
import { generateKeyPair, encryptVault, decryptVault, getKeyInfo, extractPublicKey } from '../shared/crypto.js';
import { getVaultRecord, saveVaultRecord, clearVaultStore, isInitialized } from '../shared/store.js';

// ─── Side panel helpers ───────────────────────────────────────────────────────

async function openSidePanel(tabId) {
  if (chrome.sidePanel) {
    await chrome.sidePanel.open({ tabId });
  } else {
    // Firefox-specific sidebarAction may only exist under browser.*, not chrome.*
    const sidebar = chrome.sidebarAction ?? globalThis.browser?.sidebarAction;
    if (sidebar) await sidebar.open();
  }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const session = {
  get: ()       => chrome.storage.session.get(['unlocked','vault','activeKeyFingerprint']),
  set: data     => chrome.storage.session.set(data),
  clear: ()     => chrome.storage.session.clear(),
};

function broadcastVaultReady() {
  chrome.runtime.sendMessage({ type: MSG.VAULT_READY }).catch(() => {});
}

function broadcastVaultLocked() {
  chrome.runtime.sendMessage({ type: MSG.VAULT_LOCKED }).catch(() => {});
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return { autoLockMinutes: DEFAULTS.AUTO_LOCK_MINUTES, dismissMinutes: DEFAULTS.DISMISS_MINUTES, ...data.settings };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// ─── Auto-lock ────────────────────────────────────────────────────────────────

async function resetAutoLock() {
  const { autoLockMinutes } = await getSettings();
  await chrome.alarms.clear('autolock');
  if (autoLockMinutes > 0) {
    chrome.alarms.create('autolock', { delayInMinutes: autoLockMinutes });
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autolock') { session.clear(); broadcastVaultLocked(); }
});

// ─── Side panel on icon click ─────────────────────────────────────────────────

// setPanelBehavior enables the browser's built-in toggle when clicked.
// action.onClicked is the reliable fallback for when the SW has just restarted
// and setPanelBehavior hasn't been re-applied yet — it only fires when there
// is no default_popup defined.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  await openSidePanel(tab.id);
});

// ─── First install ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  // Do NOT auto-open the wizard here — the side panel's "Set Up Vault" button
  // is the single entry point so the user never sees both simultaneously.
});

// ─── URL matching ─────────────────────────────────────────────────────────────

function normalizeHost(raw) {
  try {
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function matchesUrl(credUrl, tabHostname) {
  const tabHost = tabHostname.replace(/^www\./, '');

  // Explicit wildcard prefix: *.example.com matches any subdomain
  if (credUrl.trim().startsWith('*.')) {
    const wildBase = credUrl.trim().slice(2).replace(/^www\./, '');
    return tabHost === wildBase || tabHost.endsWith('.' + wildBase);
  }

  const credHost = normalizeHost(credUrl);
  if (!credHost) return false;
  // Exact match only — www. is stripped from both sides
  return tabHost === credHost;
}

function findMatches(vault, hostname) {
  return vault.credentials.filter(c => c.urls.some(u => matchesUrl(u, hostname)));
}

// ─── Dismissal helpers ────────────────────────────────────────────────────────
// Stored in chrome.storage.session so dismissals survive SW restarts within the
// same browser session. Keyed by "tabId:hostname"; value is -1 (until tab
// closes) or a future timestamp (timed dismissal).

async function isDismissed(tabId, hostname) {
  try {
    const { siteKeyDismissals = {} } = await chrome.storage.session.get('siteKeyDismissals');
    const key = `${tabId}:${hostname}`;
    if (!(key in siteKeyDismissals)) return false;
    const expiry = siteKeyDismissals[key];
    if (expiry === -1 || Date.now() < expiry) return true;
    // Expired — clean up
    delete siteKeyDismissals[key];
    await chrome.storage.session.set({ siteKeyDismissals });
    return false;
  } catch { return false; }
}

async function saveDismissal(tabId, hostname, expiry) {
  try {
    const { siteKeyDismissals = {} } = await chrome.storage.session.get('siteKeyDismissals');
    siteKeyDismissals[`${tabId}:${hostname}`] = expiry;
    await chrome.storage.session.set({ siteKeyDismissals });
  } catch {}
}

async function clearTabDismissals(tabId) {
  try {
    const { siteKeyDismissals = {} } = await chrome.storage.session.get('siteKeyDismissals');
    let changed = false;
    for (const key of Object.keys(siteKeyDismissals)) {
      if (key.startsWith(`${tabId}:`)) { delete siteKeyDismissals[key]; changed = true; }
    }
    if (changed) await chrome.storage.session.set({ siteKeyDismissals });
  } catch {}
}

// ─── Tab listener ─────────────────────────────────────────────────────────────

// Tracks tab+hostname pairs that have already received a notification this page
// load. Cleared when a new navigation starts so reloads and new pages re-notify.
const notifiedTabHostnames = new Set();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // New navigation starting — reset notification state for this tab
  if (changeInfo.status === 'loading') {
    for (const key of notifiedTabHostnames) {
      if (key.startsWith(`${tabId}:`)) notifiedTabHostnames.delete(key);
    }
    return;
  }

  if (changeInfo.status !== 'complete' || !tab.url) return;
  let hostname;
  try { hostname = new URL(tab.url).hostname; } catch { return; }
  if (!hostname || tab.url.startsWith('chrome')) return;

  // Reserve the key synchronously before any await — if two concurrent 'complete'
  // events fire (SPA soft-nav, iframe load, etc.) both would otherwise pass the
  // has() check before either adds the key, causing duplicate SHOW_TOAST messages
  // that make the toast flash off and on.
  const key = `${tabId}:${hostname}`;
  if (notifiedTabHostnames.has(key)) return;
  notifiedTabHostnames.add(key);

  if (await isDismissed(tabId, hostname)) {
    notifiedTabHostnames.delete(key);
    return;
  }

  const { unlocked, vault } = await session.get();
  if (!unlocked || !vault) return;

  const matches = findMatches(vault, hostname);
  if (!matches.length) return;

  // Retry up to 3 times — the content script may not have registered its
  // listener yet if the page and the side panel are loading concurrently.
  const toastMsg = {
    type: MSG.SHOW_TOAST,
    credentials: matches.map(c => ({ id: c.id, name: c.name })),
    hostname,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 250));
    try { await chrome.tabs.sendMessage(tabId, toastMsg); break; }
    catch { /* content script not yet registered — retry */ }
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of notifiedTabHostnames) {
    if (key.startsWith(`${tabId}:`)) notifiedTabHostnames.delete(key);
  }
  clearTabDismissals(tabId);
});

// ─── Message router ───────────────────────────────────────────────────────────

// Content scripts run inside third-party web pages. Extension pages (popup,
// wizard, options) may also have sender.tab set when opened as a tab, but
// their URL always starts with the extension's own origin.
// Only GET_CREDENTIAL is permitted from a true content script.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const ownOrigin    = chrome.runtime.getURL('');
  const isContentScript = !!sender.tab && !sender.url?.startsWith(ownOrigin);
  const allowedFromCS = new Set([MSG.GET_CREDENTIAL, MSG.OPEN_POPUP, MSG.DISMISS_TOAST]);
  if (isContentScript && !allowedFromCS.has(msg.type)) {
    respond({ success: false, error: 'Not permitted from a content script.' });
    return true;
  }
  let enriched = msg;
  if (msg.type === MSG.DISMISS_TOAST && sender.tab) {
    enriched = { ...msg, tabId: sender.tab.id };
  } else if (msg.type === MSG.GET_CREDENTIAL && isContentScript && sender.tab?.url) {
    try {
      const senderHostname = new URL(sender.tab.url).hostname.replace(/^www\./, '');
      enriched = { ...msg, _senderHostname: senderHostname };
    } catch { /* malformed URL — leave unenriched; handler will reject */ }
  }

  handle(enriched).then(respond).catch(err => respond({ success: false, error: err.message }));

  return true;
});

async function handle(msg) {
  const { unlocked, vault, activeKeyFingerprint } = await session.get();

  switch (msg.type) {

    case MSG.GET_STATE: {
      return { initialized: await isInitialized(), unlocked: !!unlocked, activeKeyFingerprint };
    }

    case MSG.GET_SETTINGS: {
      return { success: true, settings: await getSettings() };
    }

    case MSG.SAVE_SETTINGS: {
      if (!unlocked) return { success: false, error: 'Unlock the vault first.' };
      await saveSettings(msg.settings);
      await resetAutoLock();
      return { success: true };
    }

    case MSG.GENERATE_KEY: {
      const { privateKey, publicKey } = await generateKeyPair(msg.name, msg.email, msg.passphrase);
      const info = await getKeyInfo(publicKey);
      return { success: true, privateKey, publicKey, ...info };
    }

    case MSG.GET_KEY_INFO: {
      const info = await getKeyInfo(msg.armoredKey);
      return { success: true, ...info };
    }

    case MSG.INIT_VAULT: {
      if (await isInitialized()) {
        return { success: false, error: 'A vault already exists. Reset it in Settings before creating a new one.' };
      }
      const { privateKey: pkArmored, passphrase, extraPublicKeys = [], label } = msg;
      // Derive primary public key from the provided private key (no passphrase needed for this)
      const primaryPubArmored = await extractPublicKey(pkArmored);
      const primaryInfo       = await getKeyInfo(primaryPubArmored);
      const allPublicKeys     = [primaryPubArmored, ...extraPublicKeys];
      const emptyVault        = { version: 1, folders: [], credentials: [] };
      const encryptedVault    = await encryptVault(emptyVault, allPublicKeys);
      const authorizedKeys    = [
        { ...primaryInfo, publicKey: primaryPubArmored, label: label || primaryInfo.userIds[0] || 'Primary Key' },
        ...await Promise.all(extraPublicKeys.map(async (pk) => {
          const info = await getKeyInfo(pk);
          return { ...info, publicKey: pk, label: info.userIds[0] || 'Extra Key' };
        })),
      ];
      await saveVaultRecord({ version: 1, authorizedKeys, encryptedVault });
      await session.set({ unlocked: true, vault: emptyVault, activeKeyFingerprint: primaryInfo.fingerprint });
      await resetAutoLock();
      return { success: true };
    }

    case MSG.UNLOCK: {
      const record = await getVaultRecord();
      if (!record) return { success: false, error: 'Vault not initialized.' };
      const decrypted = await decryptVault(record.encryptedVault, msg.privateKey, msg.passphrase);
      const info = await getKeyInfo(msg.privateKey);
      await session.set({ unlocked: true, vault: decrypted, activeKeyFingerprint: info.fingerprint });
      await resetAutoLock();
      broadcastVaultReady();
      return { success: true };
    }

    case MSG.LOCK: {
      await session.clear();
      await chrome.alarms.clear('autolock');
      broadcastVaultLocked();
      return { success: true };
    }

    case MSG.GET_VAULT: {
      if (!unlocked) return { success: false, error: 'Locked' };
      await resetAutoLock();
      return { success: true, vault };
    }

    case MSG.SAVE_VAULT: {
      if (!unlocked) return { success: false, error: 'Locked' };
      const record = await getVaultRecord();
      const publicKeys = record.authorizedKeys.map(k => k.publicKey);
      const encryptedVault = await encryptVault(msg.vault, publicKeys);
      await saveVaultRecord({ ...record, encryptedVault });
      await session.set({ unlocked: true, vault: msg.vault, activeKeyFingerprint });
      await resetAutoLock();
      broadcastVaultReady();
      return { success: true };
    }

    case MSG.GET_KEYS: {
      if (!unlocked) return { success: false, error: 'Locked' };
      const record = await getVaultRecord();
      if (!record) return { success: true, keys: [] };
      return { success: true, keys: record.authorizedKeys };
    }

    case MSG.ADD_KEY: {
      if (!unlocked) return { success: false, error: 'Unlock the vault first.' };
      const record = await getVaultRecord();
      const info = await getKeyInfo(msg.armoredPublicKey);
      if (record.authorizedKeys.some(k => k.fingerprint === info.fingerprint)) {
        return { success: false, error: 'This key is already authorized.' };
      }
      const newEntry = { ...info, publicKey: msg.armoredPublicKey, label: msg.label || info.userIds[0] || 'New Key' };
      const updatedKeys = [...record.authorizedKeys, newEntry];
      const encryptedVault = await encryptVault(vault, updatedKeys.map(k => k.publicKey));
      await saveVaultRecord({ ...record, authorizedKeys: updatedKeys, encryptedVault });
      await resetAutoLock();
      return { success: true };
    }

    case MSG.REMOVE_KEY: {
      if (!unlocked) return { success: false, error: 'Unlock the vault first.' };
      const record = await getVaultRecord();
      if (record.authorizedKeys.length <= 1) {
        return { success: false, error: 'Cannot remove the last authorized key.' };
      }
      const updatedKeys = record.authorizedKeys.filter(k => k.fingerprint !== msg.fingerprint);
      const encryptedVault = await encryptVault(vault, updatedKeys.map(k => k.publicKey));
      await saveVaultRecord({ ...record, authorizedKeys: updatedKeys, encryptedVault });
      await resetAutoLock();
      return { success: true };
    }

    case MSG.OPEN_POPUP: {
      try {
        await chrome.action.openPopup();
        return { success: true };
      } catch {
        return { success: false };
      }
    }

    case MSG.DISMISS_TOAST: {
      const settings = await getSettings();
      const mins = settings.dismissMinutes ?? 0;
      const expiry = mins > 0 ? Date.now() + mins * 60 * 1000 : -1;
      await saveDismissal(msg.tabId, msg.hostname, expiry);
      return { success: true };
    }

    case MSG.GET_CREDENTIAL: {
      if (!unlocked) return { success: false, error: 'Locked' };
      const cred = vault.credentials.find(c => c.id === msg.id);
      if (!cred) return { success: false, error: 'Credential not found.' };
      if (msg._senderHostname !== undefined) {
        if (!cred.urls.some(u => matchesUrl(u, msg._senderHostname))) {
          return { success: false, error: 'Not permitted.' };
        }
      }
      await resetAutoLock();
      return { success: true, credential: cred };
    }

    case MSG.EXPORT_VAULT: {
      const record = await getVaultRecord();
      if (!record) return { success: false, error: 'No vault to export.' };
      return { success: true, data: JSON.stringify(record, null, 2) };
    }

    case MSG.IMPORT_VAULT: {
      let importedRecord;
      try { importedRecord = JSON.parse(msg.data); }
      catch { return { success: false, error: 'Invalid export file.' }; }
      if (importedRecord.type === 'sitekey-share') {
        return { success: false, error: 'This is a site export file. Use "Import Site(s)" to import it.' };
      }
      const decrypted = await decryptVault(importedRecord.encryptedVault, msg.privateKey, msg.passphrase);
      const info = await getKeyInfo(msg.privateKey);
      await saveVaultRecord(importedRecord);
      await session.set({ unlocked: true, vault: decrypted, activeKeyFingerprint: info.fingerprint });
      await resetAutoLock();
      broadcastVaultReady();
      return { success: true };
    }

    case MSG.EXPORT_CREDENTIALS: {
      if (!unlocked) return { success: false, error: 'Unlock the vault first.' };
      const record = await getVaultRecord();
      const creds = vault.credentials.filter(c => msg.credentialIds.includes(c.id));
      if (!creds.length) return { success: false, error: 'No credentials selected.' };
      const folderSet = new Set();
      for (const c of creds) {
        let fId = c.folderId;
        while (fId) {
          folderSet.add(fId);
          const f = vault.folders.find(f => f.id === fId);
          fId = f?.parentId ?? null;
        }
      }
      const folders = vault.folders.filter(f => folderSet.has(f.id));
      const publicKeys = record.authorizedKeys.map(k => k.publicKey);
      const encryptedData = await encryptVault({ credentials: creds, folders }, publicKeys);
      return { success: true, data: JSON.stringify({ version: 1, type: 'sitekey-share', encryptedData }, null, 2) };
    }

    case MSG.IMPORT_CREDENTIALS: {
      let shareFile;
      try { shareFile = JSON.parse(msg.data); } catch { return { success: false, error: 'Invalid file.' }; }
      if (shareFile.type !== 'sitekey-share') {
        return { success: false, error: 'Not a site export file. Use "Import Vault" for full vault exports.' };
      }
      const shareData = await decryptVault(shareFile.encryptedData, msg.privateKey, msg.passphrase);
      return { success: true, credentials: shareData.credentials ?? [], folders: shareData.folders ?? [] };
    }

    case MSG.RESET_VAULT: {
      if (!unlocked) return { success: false, error: 'Unlock the vault first.' };
      await clearVaultStore();
      await session.clear();
      await chrome.alarms.clear('autolock');
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown message type: ${msg.type}` };
  }
}
