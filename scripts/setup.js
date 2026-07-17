/**
 * Builds the extension for both Chrome and Firefox simultaneously.
 * Copies OpenPGP.js into lib/, generates icons from mascot.svg,
 * then assembles dist/chrome/ and dist/firefox/ with the correct manifest each.
 *
 * Run once after `npm install`:  node scripts/setup.js
 * Re-run any time source files change to refresh the dist folders.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const COPY_DIRS  = ['background', 'content', 'icons', 'lib', 'options', 'popup', 'shared', 'sidepanel', 'wizard'];
const COPY_FILES = ['mascot.svg'];

// ─── Copy OpenPGP.js ──────────────────────────────────────────────────────────

const openpgpSrc  = path.join(ROOT, 'node_modules', 'openpgp', 'dist', 'openpgp.min.mjs');
const openpgpDest = path.join(ROOT, 'lib', 'openpgp.min.mjs');

if (!fs.existsSync(openpgpSrc)) {
  console.error('ERROR: node_modules/openpgp not found. Run `npm install` first.');
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'lib'), { recursive: true });
fs.copyFileSync(openpgpSrc, openpgpDest);
console.log('✓ openpgp.min.mjs  →  lib/');

// ─── Generate icons from mascot.svg ──────────────────────────────────────────

const ICON_SIZES = [16, 32, 48, 128];
const ICON_DIR   = path.join(ROOT, 'icons');
const MASCOT     = path.join(ROOT, 'mascot.svg');

fs.mkdirSync(ICON_DIR, { recursive: true });

async function generateIcons(sharp) {
  const svg = fs.readFileSync(MASCOT);
  for (const size of ICON_SIZES) {
    const file = path.join(ICON_DIR, `icon${size}.png`);
    await sharp(svg)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
    console.log(`✓ icons/icon${size}.png`);
  }
}

// ─── Build dist/<browser>/ ────────────────────────────────────────────────────

function buildDist(browser) {
  const outDir = path.join(DIST, browser);
  fs.mkdirSync(outDir, { recursive: true });

  for (const dir of COPY_DIRS) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(outDir, dir), { recursive: true });
    }
  }

  for (const file of COPY_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, file));
    }
  }

  const manifestSrc = path.join(__dirname, 'manifests', `${browser}.json`);
  fs.copyFileSync(manifestSrc, path.join(outDir, 'manifest.json'));
  console.log(`✓ dist/${browser}/manifest.json`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('ERROR: sharp not found. Run `npm install` first.');
    process.exit(1);
  }

  if (!fs.existsSync(MASCOT)) {
    console.error('ERROR: mascot.svg not found in project root.');
    process.exit(1);
  }

  await generateIcons(sharp);

  buildDist('chrome');
  buildDist('firefox');

  console.log(`
Build complete! Load each browser from its dist folder:

── Chrome / Edge / Brave / Arc ──────────────────────────────
1. Open chrome://extensions  (or your browser's equivalent)
2. Enable Developer mode (toggle, top-right)
3. Click "Load unpacked" → select  dist/chrome/

── Firefox ──────────────────────────────────────────────────
1. Open about:debugging
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on…"
4. Navigate to  dist/firefox/  and select manifest.json

Both folders are independent — you can have Chrome and Firefox
running the extension at the same time for side-by-side testing.

Note: Firefox temporary add-ons are removed when the browser
closes. For persistence, sign via addons.mozilla.org or use
Firefox Developer Edition with xpinstall.signatures.required
set to false in about:config.
`);
}

main().catch(err => { console.error(err); process.exit(1); });
