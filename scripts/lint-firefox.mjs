// Cross-browser extension lint. Zero deps, same spirit as the zip writer:
// the portability rules we care about, checked by us, on every build.
//
// Catches the four ways this codebase can silently break Firefox:
//   1. a manifest Firefox can't load (service_worker, sidePanel, missing id)
//   2. a background bundle emitted as an ES module (one classic-script bundle
//      serves both a Chrome service worker and a Firefox event page)
//   3. `chrome.*` touched outside the compat layer in src/
//   4. promise-style use of a callback-only API (`chrome.x.y().then(...)`),
//      which works in Chrome and throws in Firefox
// Run: npm run lint:firefox   (after npm run build)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const problems = [];
const checks = [];

const fail = (msg) => problems.push(msg);
const pass = (msg) => checks.push(msg);

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

// ---- 1. browser manifests -------------------------------------------------
const PAIRS = [
  { label: 'wallet', chrome: 'apps/extension/dist', firefox: 'apps/extension/dist-firefox', id: 'radwallet@radbro.xyz' },
];
for (const pair of PAIRS) {
  for (const d of [pair.chrome, pair.firefox]) {
    if (!existsSync(join(root, d))) fail(`missing build output ${d} — run \`npm run build\` first`);
  }
}
if (problems.length) {
  for (const p of problems) console.error('FAIL:', p);
  process.exit(1);
}

const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const MIN_FIREFOX = '140.0'; // data_collection_permissions landed in 140
// Permissions must not diverge, with ONE allowed exception: `sidePanel` is a
// Chrome-only UI mechanism (Firefox docks via `sidebar_action`, no permission
// needed) and grants access to nothing. Any other delta is a real difference in
// what the two builds can do, and a store listing would have to justify it.
const CHROME_ONLY_PERMISSIONS = ['sidePanel'];

function checkPair(pair) {
  const chromeDist = join(root, pair.chrome);
  const firefoxDist = join(root, pair.firefox);
  const chromeManifest = JSON.parse(readFileSync(join(chromeDist, 'manifest.json'), 'utf8'));
  const ffManifest = JSON.parse(readFileSync(join(firefoxDist, 'manifest.json'), 'utf8'));
  const tag = `[${pair.label}]`;

  if (chromeManifest.background?.service_worker !== 'background.js') {
    fail(`${tag} chrome manifest: background.service_worker must be background.js`);
  } else pass(`${tag} chrome manifest declares a background service worker`);

  if (ffManifest.background?.service_worker) {
    fail(`${tag} firefox manifest: background.service_worker is not supported by Firefox MV3`);
  }
  if (ffManifest.background?.scripts?.[0] !== 'background.js') {
    fail(`${tag} firefox manifest: background.scripts must be ["background.js"] (event page)`);
  } else pass(`${tag} firefox manifest declares a background event page`);

  const gecko = ffManifest.browser_specific_settings?.gecko;
  if (!gecko?.id) fail(`${tag} firefox manifest: browser_specific_settings.gecko.id is required by AMO`);
  else if (gecko.id !== pair.id) fail(`${tag} firefox add-on id must be ${pair.id}, got ${gecko.id}`);
  else if (gecko.strict_min_version !== MIN_FIREFOX) {
    fail(`${tag} firefox manifest: strict_min_version must be ${MIN_FIREFOX} (data_collection_permissions needs it)`);
  } else pass(`${tag} firefox add-on id ${gecko.id} (min ${gecko.strict_min_version})`);

  if (ffManifest.browser_specific_settings?.gecko_android?.strict_min_version !== '142.0') {
    fail(`${tag} firefox manifest: gecko_android.strict_min_version must be 142.0 (data_collection_permissions on Android)`);
  } else pass(`${tag} firefox for android floor declared (142.0)`);

  // the no-telemetry invariant, machine-readable: AMO shows this at install time
  const collects = gecko?.data_collection_permissions?.required;
  if (JSON.stringify(collects) !== JSON.stringify(['none'])) {
    fail(`${tag} firefox manifest: data_collection_permissions.required must be ["none"], got ${JSON.stringify(collects)}`);
  } else pass(`${tag} firefox manifest declares data collection: none`);

  if (chromeManifest.version !== ffManifest.version) {
    fail(`${tag} version drift: chrome ${chromeManifest.version} vs firefox ${ffManifest.version}`);
  } else pass(`${tag} both manifests at v${chromeManifest.version}`);
  if (rootVersion !== chromeManifest.version) {
    fail(`${tag} version drift: package.json ${rootVersion} vs manifest ${chromeManifest.version}`);
  } else pass(`${tag} package.json matches manifest (v${rootVersion})`);

  const chromePerms = chromeManifest.permissions ?? [];
  const ffPerms = ffManifest.permissions ?? [];
  const shared = chromePerms.filter((p) => !CHROME_ONLY_PERMISSIONS.includes(p));
  const extraInChrome = chromePerms.filter((p) => !ffPerms.includes(p));
  if (JSON.stringify(shared) !== JSON.stringify(ffPerms)) {
    fail(`${tag} permissions diverge beyond the allowed delta: ${JSON.stringify(chromePerms)} vs ${JSON.stringify(ffPerms)}`);
  } else if (extraInChrome.some((p) => !CHROME_ONLY_PERMISSIONS.includes(p))) {
    fail(`${tag} chrome-only permission outside the allowlist: ${JSON.stringify(extraInChrome)}`);
  } else {
    pass(`${tag} permissions match on both targets: ${JSON.stringify(ffPerms)}${
      extraInChrome.length ? ` (+${extraInChrome.join(',')} on chrome, UI-only)` : ''}`);
  }

  // ---- docking: each browser gets its own key, pointed at the same page ----
  const chromePanel = chromeManifest.side_panel?.default_path;
  const ffPanel = ffManifest.sidebar_action?.default_panel;
  if (!chromePanel) fail(`${tag} chrome manifest: side_panel.default_path is missing (docking)`);
  if (ffManifest.side_panel) fail(`${tag} firefox manifest: side_panel is a Chrome key, Firefox uses sidebar_action`);
  if (!ffPanel) fail(`${tag} firefox manifest: sidebar_action.default_panel is missing (docking)`);
  if (chromePanel && ffPanel && chromePanel !== ffPanel) {
    fail(`${tag} docked page differs per target: ${chromePanel} vs ${ffPanel}`);
  }
  // the page detects "am I docked?" from this flag, so it has to survive
  if (chromePanel && !/[?&]panel=1(&|$)/.test(chromePanel)) {
    fail(`${tag} docked path must carry ?panel=1 (the UI reads it to hide DOCK): ${chromePanel}`);
  } else if (chromePanel === ffPanel) {
    pass(`${tag} both targets dock to ${chromePanel}`);
  }
  if (ffPerms.includes('sidePanel')) fail(`${tag} firefox manifest: sidePanel is not a Firefox permission`);

  // ---- 2. background bundle must be a classic script ----------------------
  for (const d of [chromeDist, firefoxDist]) {
    const bg = readFileSync(join(d, 'background.js'), 'utf8');
    if (/^\s*(import\s|export\s|import\{|export\{)/m.test(bg)) {
      fail(`${relative(root, d)}/background.js is an ES module — a Firefox event page cannot load it`);
    }
  }
  pass(`${tag} background bundle is a classic script (loads as SW and as event page)`);

  return { chromeManifest, ffManifest };
}

PAIRS.forEach(checkPair);

// ---- 3. no raw chrome.* outside the compat layer --------------------------
const srcDir = join(root, 'apps/wallet/src');
const COMPAT = join(srcDir, 'ext.ts');
/**
 * Comments are prose, not code. Explaining WHY `chrome.storage` cannot hold a
 * CryptoKey is exactly the kind of note this file wants people to write, and
 * it must not read as a violation — so strip comments before scanning, and
 * keep the line numbers by blanking them in place.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p) => p + ' '.repeat(m.length - p.length));
}

for (const file of walk(srcDir, (p) => /\.tsx?$/.test(p))) {
  if (file === COMPAT) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  text.split('\n').forEach((line, i) => {
    if (/\bchrome\./.test(line) || /\bbrowser\./.test(line)) {
      fail(`${relative(root, file)}:${i + 1} touches the raw extension namespace — go through ext.ts`);
    }
  });
}
pass('src/ reaches the extension APIs only through ext.ts');

// ---- 4. no promise-on-callback in the static shell ------------------------
// content.js / inpage.js are hand-written and shipped as-is to both browsers.
for (const name of ['content.js', 'inpage.js']) {
  const text = readFileSync(join(root, 'apps/extension/static', name), 'utf8');
  if (/chrome\.[A-Za-z.]+\([^)]*\)\s*\.then\b/.test(text)) {
    fail(`static/${name} uses promise style on a callback-only API — breaks on Firefox`);
  }
}
pass('static content/inpage scripts use callback style (portable)');

// ---- report ---------------------------------------------------------------
for (const c of checks) console.log('ok  ', c);
if (problems.length) {
  console.error('');
  for (const p of problems) console.error('FAIL:', p);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed — chrome + firefox artifacts look loadable`);
