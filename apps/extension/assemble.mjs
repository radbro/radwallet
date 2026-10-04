// Assemble the unpacked extension(s): wallet UI build + static extension files.
//
//   node assemble.mjs            -> dist/          (Chrome/Chromium MV3)
//   node assemble.mjs --firefox  -> dist-firefox/  (Firefox MV3)
//   node assemble.mjs --all      -> both browsers
//
// Derive the Firefox manifest from static/manifest.json. Both browsers use
// the same version, permissions, content scripts and wallet bundles.
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// version drift guard: the manifest is what ships, so everything follows it
const manifest = JSON.parse(readFileSync(join(here, 'static/manifest.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
if (manifest.version !== rootPkg.version) {
  console.error(
    `version drift: manifest.json is ${manifest.version} but package.json is ${rootPkg.version}. ` +
    'Bump both (see STORE.md).',
  );
  process.exit(1);
}

/** Firefox MV3: event page instead of a service worker, plus an add-on id. */
function firefoxManifest(chromeManifest) {
  const m = structuredClone(chromeManifest);
  // Firefox MV3 has no background service workers — it runs a non-persistent
  // event page. Same bundle, different key (the bundle is a classic script).
  m.background = { scripts: ['background.js'] };

  // Docking the wallet: same page, same query flag, different mechanism.
  // Chrome's `side_panel` + `sidePanel` permission become Firefox's
  // `sidebar_action`, which needs no permission and brings its own toolbar
  // button. This is the ONLY permission the two targets are allowed to differ
  // on, and it grants no access to anything — see scripts/lint-firefox.mjs.
  const panelPath = m.side_panel.default_path;
  delete m.side_panel;
  m.permissions = m.permissions.filter((p) => p !== 'sidePanel');
  m.sidebar_action = {
    default_panel: panelPath,
    default_title: m.short_name,
    default_icon: { 192: 'icons/icon-192.png' },
  };
  // AMO needs a stable id. The floor is 140 desktop / 142 Android: that is
  // where `data_collection_permissions` landed, and a wallet has no business
  // running on a browser older than the current ESR anyway.
  //
  // `data_collection_permissions: none` is the no-telemetry invariant in
  // machine-readable form — AMO shows it to users at install time. If this
  // ever needs to stop saying "none", the privacy copy in the UI has become a
  // lie and the feature causing it is what should go.
  m.browser_specific_settings = {
    gecko: {
      id: 'radwallet@radbro.xyz',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return m;
}

function assemble({ out, manifest: mf, label, uiDist, bgDist }) {
  if (!existsSync(uiDist)) {
    console.error(`build the wallet UI first (missing ${uiDist})`);
    process.exit(1);
  }
  if (!existsSync(join(bgDist, 'background.js'))) {
    console.error(`build the background worker first (missing ${join(bgDist, 'background.js')})`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(uiDist, out, { recursive: true });
  cpSync(join(here, 'static'), out, { recursive: true });
  cpSync(join(bgDist, 'background.js'), join(out, 'background.js'));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(mf, null, 2) + '\n');
  console.log(`${label} extension assembled at`, out);
}

const argv = process.argv.slice(2);
if (argv.some((arg) => !['--chrome', '--firefox', '--all'].includes(arg))) {
  console.error('Use --chrome, --firefox, or --all.');
  process.exit(1);
}
const all = argv.includes('--all');
const wantFirefox = argv.includes('--firefox') || all;
const wantChrome = argv.includes('--chrome') || all || !wantFirefox;
const bundles = { uiDist: join(here, '../wallet/dist'), bgDist: join(here, '../wallet/dist-bg') };

if (wantChrome) {
  assemble({ out: join(here, 'dist'), manifest, label: 'chrome', ...bundles });
}
if (wantFirefox) {
  assemble({
    out: join(here, 'dist-firefox'),
    manifest: firefoxManifest(manifest),
    label: 'firefox',
    ...bundles,
  });
}
