/* SiteKey content script — shadow DOM keeps page styles out */

(function () {
  'use strict';

  const SHADOW_CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :host { all: initial; display: block; pointer-events: none; }

    .sk-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      background: #1e293b;
      border: 1px solid #0ea5e9;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      padding: 10px 14px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      color: #f1f5f9;
      max-width: 340px;
      pointer-events: auto;
      animation: sk-in 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards;
    }
    .sk-toast.sk-out { animation: sk-out 0.3s ease forwards; }
    @keyframes sk-in {
      from { opacity: 0; transform: translateX(30px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes sk-out {
      from { opacity: 1; transform: translateX(0); }
      to   { opacity: 0; transform: translateX(20px); }
    }
    .sk-toast-icon { width: 30px; height: 30px; flex-shrink: 0; object-fit: contain; }
    .sk-toast-body { flex: 1; min-width: 0; }
    .sk-toast-title { display: block; font-weight: 600; color: #0ea5e9; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .sk-toast-msg   { display: block; color: #cbd5e1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-toast-btn   { background: #0ea5e9; color: #fff; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .sk-toast-btn:hover { background: #38bdf8; }
    .sk-toast-btn--secondary { background: transparent; border: 1px solid #475569; color: #94a3b8; }
    .sk-toast-btn--secondary:hover { background: #1e293b; color: #f1f5f9; border-color: #64748b; }
    .sk-toast-close { background: none; border: none; color: #64748b; cursor: pointer; font-size: 16px; padding: 2px 4px; line-height: 1; }
    .sk-toast-close:hover { color: #f1f5f9; }

    .sk-card {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      pointer-events: auto;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.7);
      width: 320px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      color: #f1f5f9;
      animation: sk-in 0.2s ease;
      overflow: hidden;
    }
    .sk-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
    }
    .sk-card-title { font-weight: 700; font-size: 13px; color: #0ea5e9; }
    .sk-card-close { background: none; border: none; color: #64748b; cursor: pointer; font-size: 16px; }
    .sk-card-close:hover { color: #f1f5f9; }
    .sk-card-body { padding: 8px 0; max-height: 320px; overflow-y: auto; }
    .sk-loading { padding: 20px; text-align: center; color: #64748b; }

    .sk-cred-item { padding: 10px 14px; border-bottom: 1px solid #1e293b; }
    .sk-cred-item:last-child { border-bottom: none; }
    .sk-cred-name { font-weight: 600; color: #e2e8f0; margin-bottom: 8px; font-size: 13px; }
    .sk-cred-row  { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
    .sk-cred-row:last-child { margin-bottom: 0; }
    .sk-cred-label { color: #64748b; font-size: 11px; width: 58px; flex-shrink: 0; }
    .sk-cred-value { flex: 1; color: #94a3b8; font-size: 12px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-cred-value.sk-pw { letter-spacing: 2px; }
    .sk-copy-btn   { background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: 5px; padding: 3px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .sk-copy-btn:hover { background: #334155; color: #f1f5f9; }
    .sk-copy-btn.sk-copied { background: #166534; border-color: #16a34a; color: #86efac; }
  `;

  // ─── Lazy shadow host ────────────────────────────────────────────────────────
  // The host element is only injected when a credential match exists on the
  // current page, and is removed when all UI is dismissed. This prevents pages
  // from detecting the extension's presence via getElementById or MutationObserver
  // on every page load.

  let host   = null;
  let shadow = null;
  let toast  = null;
  let card   = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    const styleEl = document.createElement('style');
    styleEl.textContent = SHADOW_CSS;
    shadow.appendChild(styleEl);
  }

  function maybeRemoveHost() {
    if (!toast && !card && host) {
      host.remove();
      host   = null;
      shadow = null;
    }
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────

  function showToast(credentials, hostname) {
    if (toast) return; // already visible — ignore duplicate SHOW_TOAST
    removeToast();     // must precede ensureHost: maybeRemoveHost() can null shadow
    ensureHost();

    const count = credentials.length;
    const label = count === 1 ? '1 credential' : `${count} credentials`;

    toast = document.createElement('div');
    toast.className = 'sk-toast';

    const icon = document.createElement('img');
    icon.className = 'sk-toast-icon';
    icon.src = chrome.runtime.getURL('mascot.svg');
    icon.alt = '';

    const body  = document.createElement('div');
    body.className = 'sk-toast-body';
    body.append(
      el('span', 'sk-toast-title', 'Humbleman Site Key Manager'),
      el('span', 'sk-toast-msg',   `${label} for ${hostname}`)
    );

    const viewBtn    = el('button', 'sk-toast-btn', 'View');
    const dismissBtn = el('button', 'sk-toast-btn sk-toast-btn--secondary', 'Dismiss');
    const closeBtn   = el('button', 'sk-toast-close', '✕');

    viewBtn.onclick = () => { showCard(credentials); };
    dismissBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'DISMISS_TOAST', hostname }).catch(() => {});
      removeToast();
    };
    closeBtn.onclick = removeToast;

    toast.append(icon, body, viewBtn, dismissBtn, closeBtn);
    shadow.appendChild(toast);
  }

  function removeToast() {
    if (!toast) return;
    toast.remove();
    toast = null;
    maybeRemoveHost();
  }

  // ─── Card ────────────────────────────────────────────────────────────────────

  async function showCard(credentials) {
    removeToast();   // may call maybeRemoveHost — must come before ensureHost
    removeCard();
    ensureHost();    // recreate host/shadow if maybeRemoveHost tore it down

    card = document.createElement('div');
    card.className = 'sk-card';

    const header = document.createElement('div');
    header.className = 'sk-card-header';
    const closeBtn = el('button', 'sk-card-close', '✕');
    closeBtn.onclick = removeCard;
    header.append(el('span', 'sk-card-title', '🔑 Humbleman Site Key Manager'), closeBtn);

    const body = document.createElement('div');
    body.className = 'sk-card-body';
    body.appendChild(el('div', 'sk-loading', 'Loading…'));

    card.append(header, body);
    shadow.appendChild(card);

    const results = await Promise.all(
      credentials.map(c => chrome.runtime.sendMessage({ type: 'GET_CREDENTIAL', id: c.id }))
    );

    body.innerHTML = '';
    results.forEach(resp => {
      if (!resp?.success) return;
      body.appendChild(buildCredItem(resp.credential));
    });
  }

  function buildCredItem(c) {
    const item = document.createElement('div');
    item.className = 'sk-cred-item';
    item.appendChild(el('div', 'sk-cred-name', c.name));
    item.appendChild(buildCopyRow('Username', c.username, false));
    item.appendChild(buildCopyRow('Password', c.password, true));
    return item;
  }

  function buildCopyRow(label, value, isPassword) {
    const row = document.createElement('div');
    row.className = 'sk-cred-row';
    row.appendChild(el('span', 'sk-cred-label', label));

    const valueEl = document.createElement('span');
    valueEl.className = 'sk-cred-value' + (isPassword ? ' sk-pw' : '');
    valueEl.textContent = isPassword ? '••••••••' : value;
    row.appendChild(valueEl);

    const btn = el('button', 'sk-copy-btn', 'Copy');
    btn.onclick = () => copyText(value, btn);
    row.appendChild(btn);

    return row;
  }

  function removeCard() {
    if (!card) return;
    card.remove();
    card = null;
    maybeRemoveHost();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for contexts where the Clipboard API is unavailable
      const ta = Object.assign(document.createElement('textarea'), {
        value: text,
        style: 'position:fixed;opacity:0',
      });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }

    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('sk-copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('sk-copied'); }, 1500);

    // Overwrite clipboard after 30 seconds. Passwords should not linger
    // indefinitely in the OS clipboard where other apps can read them.
    setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000);
  }

  // ─── Message listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'SHOW_TOAST') {
      showToast(msg.credentials, msg.hostname);
      respond({});
    }
  });
}());
