# Humbleman Site Key Manager

<p align="center">
  <img src="mascot.svg" alt="Humbleman Site Key Manager" width="220">
  <br><br>
  <a href="https://buymeacoffee.com/sormondocom">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=sormondocom&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee">
  </a>
</p>

---

A free, open-source browser extension for Chrome, Edge, Brave, Firefox, and other modern browsers that stores your credentials in a locally encrypted vault secured by PGP keys. No accounts, no cloud, no subscription — just cryptography you control.

---

## Philosophy

Most password managers trade security for convenience by routing your credentials through a third-party server. Even with end-to-end encryption, you're trusting a company's infrastructure, their key management, and their continued existence.

After paying for some of the larger competitors to manage household passwords and now needing to have several different identity protection subscriptions - I think you know where this is going.

Humbleman Site Key Manager takes a different approach:

**Your vault never leaves your machine in a readable form.** The credential database is encrypted using OpenPGP before it ever touches storage. The only way to decrypt it is to hold an authorized private key — and those keys never leave the devices they were created on.

**Sharing without trusting a middleman.** If two people — or two of your own devices — need access to the same vault, Humbleman Site Key Manager uses PGP's native multi-recipient encryption. You add the second identity's *public* key as an authorized key. The vault is re-encrypted so that either private key can open it. You can then hand off the encrypted vault file freely: without an authorized private key, it is computationally infeasible to read.

**Free as in freedom.** Humbleman Site Key Manager uses [OpenPGP.js](https://openpgpjs.org/), a well-audited, open-source implementation of the OpenPGP standard (RFC 4880). There is no telemetry, no update server, and no external network requests. The extension can be audited line by line.

**Designed for humans.** Humbleman Site Key Manager does not attempt to auto-fill forms. Instead, it watches for URLs it recognizes, surfaces a subtle in-page notification, and lets you copy credentials to the clipboard when you choose. You stay in control of every paste.

---

## Architecture

### Crypto model

The vault is a single JSON document encrypted as an OpenPGP message. OpenPGP's native multi-recipient encryption means the plaintext is encrypted once with a random session key, and that session key is then encrypted separately to each authorized public key. Any authorized private key can recover the session key and therefore the vault — without any of the keys knowing about each other.

```
Vault JSON  →  OpenPGP encrypt (to all authorized public keys)  →  Ciphertext blob
                                                                         │
                 Key A private  ─────────────────────────────────────── ▼
                 Key B private  ──────────────────────────────────►  decrypt
```

Adding or removing an authorized identity requires the vault to be unlocked (i.e., you must hold a valid private key). The vault is then re-encrypted to the updated key list.

### Extension components

```
site-key/
├── background/
│   └── service-worker.js     All business logic, crypto, and message routing
├── content/
│   └── content-script.js     In-page UI (toast + credential card) via closed shadow DOM
├── popup/
│   ├── popup.html/js/css      Vault manager UI (folder tree, CRUD, search)
├── sidepanel/
│   └── sidepanel.html         Chrome side panel / Firefox sidebar shell
├── wizard/
│   ├── wizard.html/js/css     First-run identity setup wizard
├── options/
│   ├── options.html/js/css    Key management, export/import, session settings
└── shared/
    ├── crypto.js              OpenPGP.js wrappers (the only place crypto runs)
    ├── store.js               IndexedDB access for vault and file handle storage
    └── constants.js           Message type strings shared across all contexts
```

**Service worker** is the single source of truth and the only context where cryptographic operations run. The popup, wizard, and options page send structured messages and receive only what they need to display — they never hold raw crypto keys or perform decryption themselves. This keeps the trust boundary tight.

**Background script** runs as a service worker in Chrome (MV3). Firefox includes both `service_worker` and `scripts` in the manifest so that older Firefox builds that have `service_worker` disabled fall back gracefully. `chrome.storage.session` is used for in-memory session state in both browsers — it persists across background script restarts within the same browser session and is cleared when the browser closes. An auto-lock alarm (`chrome.alarms`) clears the session after a configurable idle period.

**Content script** runs in a [closed shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM) isolated from the host page. Page styles and scripts cannot reach the notification UI. The content script runs in an isolated JavaScript world, so host-page prototype pollution cannot affect it. Passwords are handled in JavaScript closures and are never written into DOM attributes. The content script can only send three message types to the service worker: request a credential by ID, open the side panel, or dismiss a toast.

**URL matching** is exact-hostname-based: a stored URL of `github.com` matches `github.com` and `www.github.com` only. To match subdomains, prefix the stored URL with `*.` (e.g. `*.github.com` matches `gist.github.com`, `app.github.com`, etc.). Matching happens entirely locally on tab navigation events.

**Side panel / Sidebar** — in Chrome and Chromium-based browsers the vault UI opens in the browser's built-in side panel. In Firefox it opens as a sidebar. Both are accessed by clicking the toolbar icon. Lock and unlock actions in either the side panel or the Settings page are reflected immediately in both — they stay in sync automatically.

### Where the vault is stored

The extension stores a single vault record in an IndexedDB database named `sitekey`, inside the extension's private storage. This storage is:

- **Profile-specific** — tied to the browser profile that installed the extension. A different profile, or a different browser, cannot access it.
- **Not directly accessible** — IndexedDB storage is managed by the browser and is not visible in the file system. There is no file you can copy or back up without going through the extension.
- **Encrypted at rest** — the only sensitive field is `encryptedVault`, which is an OpenPGP-encrypted blob. Even if someone could read the raw IndexedDB, they would see only ciphertext.

The full vault record looks like this:

```json
{
  "version": 1,
  "authorizedKeys": [
    {
      "fingerprint": "ABCD1234...",
      "keyId": "ABCD1234",
      "userIds": ["Your Name <youremail@example.com>"],
      "label": "Primary",
      "publicKey": "-----BEGIN PGP PUBLIC KEY BLOCK-----\n..."
    }
  ],
  "encryptedVault": "-----BEGIN PGP MESSAGE-----\n..."
}
```

### Linking an external vault file

Because the default storage is browser-profile-specific, a separate setting lets you link the vault to a file on disk. This is useful for:

- Keeping the vault in a cloud-synced folder (Dropbox, iCloud Drive, OneDrive, etc.) so it stays available if the browser profile is lost
- Explicitly controlling where the encrypted file lives and who has access to it
- Manually transferring the vault between machines by copying the file

**To link a file:**

1. Open Settings (⚙ in the side panel)
2. Find the **Vault Location** section
3. Click **New file…** to write the current vault to a new file at a location you choose, or **Existing file…** to load an existing vault file and use it going forward
4. Future vault changes (adding credentials, authorizing keys, importing sites) are automatically written back to that file

**After a browser restart**, you may be asked to re-authorize file access. Click **Re-authorize** in the Vault Location section to grant access for the new session.

> **Note:** External file linking requires Chrome, Edge, Brave, Arc, or another Chromium-based browser. Firefox does not currently support the File System Access API in extension contexts. On Firefox, the Settings page will show the approximate location of your browser profile folder so you can find the IndexedDB storage manually if needed.

The vault itself is still encrypted — the file on disk is no more readable than the IndexedDB copy. Putting it in a cloud-synced folder is safe; without an authorized private key, the file is an opaque blob.

---

## Setup

### Prerequisites

- Node.js 18 or later
- Chrome 109+, Edge 109+, Brave, Arc, or any Chromium-based browser; **or** Firefox 128+

### Install

```bash
git clone https://github.com/yourname/site-key.git
cd site-key
npm install
npm run setup
```

`npm run setup` does two things:
1. Copies the OpenPGP.js ESM build from `node_modules` into `lib/`
2. Generates the extension's PNG icons and builds browser-specific packages into `dist/chrome/` and `dist/firefox/`

### Load in Chrome / Edge / Brave / Arc

1. Open `chrome://extensions` (or your browser's equivalent)
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select the `dist/chrome/` folder
4. The extension icon appears in your toolbar

### Load in Firefox

Firefox uses a temporary installation flow for unsigned extensions during development:

1. Open `about:debugging`
2. Click **This Firefox** in the left sidebar
3. Click **Load Temporary Add-on…**
4. Navigate to the `dist/firefox/` folder and select `manifest.json`
5. The extension icon appears in your toolbar

> **Note:** Temporary add-ons in Firefox are removed when the browser closes. To persist the installation across restarts you need to either sign the extension through [addons.mozilla.org](https://addons.mozilla.org) or use [Firefox Developer Edition / Nightly](https://www.mozilla.org/en-US/firefox/developer/) with `xpinstall.signatures.required` set to `false` in `about:config`.

Firefox 128 or later is required. Firefox 128 is also the current Extended Support Release (ESR), so both regular and enterprise users are covered.

On first launch, click the toolbar icon and follow the setup wizard.

---

## First-run wizard

The wizard walks you through creating your identity in five steps.

**Step 1 — Choose a path**
- *Create New Identity*: generates a fresh ECC (Curve25519) key pair inside the extension
- *Import Existing Key*: use a PGP private key you already manage — paste the armored text, type it in, or load it directly from a `.asc` file

**Step 2 — Identity details** *(new identity path)*

Fill in a display name, an optional email address, and a passphrase that protects the private key at rest. The passphrase must be at least 8 characters. You will need it every time you unlock the vault.

**Step 2 — Verify key** *(import path)*

Paste or load your existing armored PGP private key and enter its passphrase. The wizard verifies the key is valid and extracts your identity details before proceeding.

**Step 3 — Back up your private key** *(new identity path only)*

Your newly generated private key is displayed here. Download it as a `.asc` file or copy it to a safe location — a password manager, USB drive, or printed paper backup. You must acknowledge you have saved a copy before you can continue. If you lose this key, your credentials cannot be recovered and there is no reset mechanism.

**Step 4 — Authorize additional identities** *(optional)*

Paste, load from file, or type the *public* keys of other identities — a second device, a colleague, a backup identity — that should be able to open this vault. You can also add more later in Settings.

**Step 5 — Done**

Your encrypted vault is created and the extension is ready to use.

---

## Sharing a vault between identities

This is the workflow for two people (or two devices) sharing the same credential database:

```
Person A                              Person B
────────                              ────────
1. Sets up vault normally
2. In Settings → Authorized Keys,
   adds Person B's PUBLIC key
3. Exports vault  ──────────────────► 4. Receives the .vault file
                                      5. In Settings → Import Vault,
                                         provides the file + their PRIVATE key
                                      6. Vault unlocks — both now have access
```

Going forward, either person can export the updated vault and share it with the other. Because the ciphertext is encrypted to both keys simultaneously, the file is safe to transfer over any channel.

To share only specific credentials rather than the entire vault, use **Export Site(s)** in Settings. The recipient imports them via **Import Site(s)**, which adds them to their existing vault without replacing it.

To remove someone's access: go to **Settings → Authorized Keys**, remove their key, and stop sharing new exports with them. Their copy of a previous export remains readable to them, so rotate any credentials that were in it.

---

## Daily use

Once the vault is unlocked (click the toolbar icon to open the side panel, then paste or load your private key and enter your passphrase), Humbleman Site Key Manager runs quietly in the background.

- **Navigating to a recognized site**: a toast notification appears in the bottom-right corner of the page showing how many credentials are stored for that hostname. The toast stays visible until you interact with it.
- **Clicking "View"**: an inline credential card appears on the page with your stored username and password, each with a **Copy** button. Nothing is auto-filled. Copied passwords are automatically cleared from the clipboard after 30 seconds.
- **Clicking "Dismiss"**: hides the toast for that site on the current tab. The duration is configurable in Settings — either until the tab closes, or for a set period of time.
- **Clicking "✕"**: closes the toast without suppressing future notifications.

The side panel / sidebar gives you full access to the vault:
- **Search bar** — filter credentials by name, username, or URL
- **Folder tree** — create folders and nest them arbitrarily
- **Add / Edit / Delete** credentials with name, URLs, username, password, and notes
- **Copy Username / Copy Password** buttons on each credential — copied passwords are cleared from the clipboard after 30 seconds
- **Password generator** available when adding or editing

---

## Settings

Open **Settings** from the side panel toolbar (⚙) or via `chrome://extensions` → Details → Extension options.

| Setting | Description |
|---|---|
| **Authorized Keys** | View, add (paste, load from file, or type), or remove public keys that can open this vault |
| **Auto-lock** | Idle timeout before the vault locks automatically (default: 15 minutes) |
| **Dismiss notification for** | How long "Dismiss" suppresses the credential toast for a site on the current tab (default: until tab closes) |
| **Vault Location** | Link the vault to a file on disk (e.g., in a cloud-synced folder) for portable, independent storage. Click **New file…** to export the current vault to a new file, or **Existing file…** to load a vault from an existing file. Unlink at any time to return to browser storage only. (Chromium-based browsers only.) |
| **Export Vault** | Download the entire encrypted vault as a `.vault` file |
| **Import Vault** | Replace the current vault with an exported `.vault` file (requires your private key to verify) |
| **Export Site(s)** | Export selected credentials as a portable encrypted `.sitekey-share` file. Select individual credentials or check an entire folder to include everything nested inside it. |
| **Import Site(s)** | Import credentials from a `.sitekey-share` file without replacing your vault — choose which items to bring in from a preview |
| **Reset Vault** | Permanently delete all credentials and keys (cannot be undone; requires unlocked vault) |

---

## Security notes

- **Private keys never leave your device.** All cryptographic operations run exclusively in the extension's service worker. No key material is ever sent to a server or logged anywhere.
- **The decrypted vault exists only in memory.** `chrome.storage.session` holds the unlocked vault for the current browser session. It is cleared when the browser closes, when the auto-lock timer fires, or when you lock manually.
- **Content scripts are strictly isolated.** The in-page notification runs in a closed shadow DOM (host-page JavaScript cannot reach it) and in an isolated JavaScript world (host-page prototype pollution cannot affect it). Content scripts may only send three message types to the extension: request a specific credential by ID, open the side panel, or dismiss a toast. All other messages are rejected at the service worker.
- **Credential IDs are validated against the requesting page.** When the in-page card requests a credential from the service worker, the service worker verifies that the credential's stored URLs match the hostname of the requesting tab. A content script on one site cannot request credentials stored for a different site.
- **Passwords are never written into the DOM.** The in-page credential card passes passwords via JavaScript closures, not HTML attributes. The vault tree in the side panel builds all credential elements with `textContent`, never `innerHTML`.
- **Copied passwords are automatically overwritten in the clipboard after 30 seconds** — both from the in-page credential card and from the side panel vault tree.
- **No web page can message this extension.** There is no `externally_connectable` declaration in the manifest, so web pages have no channel to communicate with the extension at all.
- **Content Security Policy locks down extension pages.** Extension pages (side panel, settings, wizard) are served under a strict CSP that blocks inline scripts, `eval()`, and all outbound network requests (`connect-src 'none'`).
- **Generated keys use ECC Curve25519**, which provides ~128-bit security with small key sizes and fast operations. Imported RSA keys are also supported.
- **The exported `.vault` file is safe to store in cloud drives or send over email.** Without an authorized private key it cannot be decrypted.

---

## License

See [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://buymeacoffee.com/sormondocom">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=sormondocom&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee">
  </a>
</p>
