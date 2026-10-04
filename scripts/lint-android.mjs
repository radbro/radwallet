// Android shell lint. Zero deps, source-only, so it runs on CI with no SDK.
//
// The APK is where the wallet's promises are easiest to break by accident,
// because the defaults are against us: backup on, WebView metrics following a
// Chrome setting, Safe Browsing reporting every URL it loads. None of that is
// visible in the TypeScript the no-telemetry receipt greps, so it gets its own
// check.
//
// Run: npm run lint:android
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const android = join(root, 'apps/mobile/android');
const problems = [];
const checks = [];
const fail = (msg) => problems.push(msg);
const pass = (msg) => checks.push(msg);

if (!existsSync(android)) {
  console.log('no apps/mobile/android — nothing to check');
  process.exit(0);
}

const manifest = readFileSync(join(android, 'app/src/main/AndroidManifest.xml'), 'utf8');

// ---- the vault must not leave the device ----------------------------------
// allowBackup defaults to TRUE, which uploads app-private storage — the sealed
// vault included — to the user's Google Drive. vault.ts says the vault never
// leaves the device.
if (/android:allowBackup="true"/.test(manifest) || !/android:allowBackup="false"/.test(manifest)) {
  fail('allowBackup must be explicitly false — the sealed vault would go to Google Drive');
} else pass('backup is off (the vault stays on the device)');

// backup and device-to-device transfer are separate channels on API 31+
if (!/android:dataExtractionRules="@xml\/data_extraction_rules"/.test(manifest)) {
  fail('no dataExtractionRules — device-to-device transfer is a second way out');
} else {
  const rules = readFileSync(join(android, 'app/src/main/res/xml/data_extraction_rules.xml'), 'utf8');
  const excludes = (rules.match(/<exclude/g) || []).length;
  if (!/<cloud-backup>/.test(rules) || !/<device-transfer>/.test(rules) || excludes < 8) {
    fail('data_extraction_rules must exclude every domain from BOTH cloud-backup and device-transfer');
  } else pass(`nothing is extractable (${excludes} exclusions across both channels)`);
}

// ---- invariant 1 does not stop at the WebView -----------------------------
const meta = (name, value) =>
  new RegExp(`android:name="${name.replace(/\./g, '\\.')}"\\s*\\n?\\s*android:value="${value}"`).test(manifest);

if (!meta('android.webkit.WebView.MetricsOptOut', 'true')) {
  fail('WebView.MetricsOptOut must be true — the runtime reports usage to Google otherwise');
} else pass('WebView usage metrics opted out');

if (!meta('android.webkit.WebView.EnableSafeBrowsing', 'false')) {
  fail('WebView.EnableSafeBrowsing must be false — it sends every loaded URL to Google');
} else pass('WebView Safe Browsing off (no URLs sent to Google)');

// ---- permissions ----------------------------------------------------------
// INTERNET is the whole ask. The androidx one is a signature permission scoped
// to our own package — a self-addressed envelope, not a capability — and it is
// added by the library at merge time, so it is named here rather than hunted.
const ALLOWED = new Set([
  'android.permission.INTERNET',
  'xyz.radbro.radwallet.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
]);
const asked = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
const extra = asked.filter((p) => !ALLOWED.has(p));
if (extra.length) fail(`unexpected permissions: ${extra.join(', ')}`);
else pass(`permissions: ${asked.join(', ') || '(none)'}`);

// ---- TLS everywhere, plaintext only to your own node ----------------------
const nsc = join(android, 'app/src/main/res/xml/network_security_config.xml');
if (!/android:networkSecurityConfig=/.test(manifest) || !existsSync(nsc)) {
  fail('no network security config — cleartext to any host would be allowed');
} else {
  const cfg = readFileSync(nsc, 'utf8');
  const baseOpen = /<base-config[^>]*cleartextTrafficPermitted="true"/.test(cfg);
  const domains = [...cfg.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1].trim());
  const remote = domains.filter((d) => d !== 'localhost' && d !== '127.0.0.1');
  if (baseOpen) fail('base-config allows cleartext — it must be false');
  else if (remote.length) fail(`cleartext allowed to non-loopback hosts: ${remote.join(', ')}`);
  else pass(`cleartext only to loopback (${domains.join(', ')}) — same rule as normalizeEndpoint`);
}

// ---- one version, from the root package.json ------------------------------
const gradle = readFileSync(join(android, 'app/build.gradle'), 'utf8');
if (/versionName\s+"/.test(gradle) || /versionCode\s+\d+/.test(gradle)) {
  fail('build.gradle hard-codes a version — it must derive from the root package.json');
} else if (!/rootPkg\.version/.test(gradle)) {
  fail('build.gradle does not read the root package.json version');
} else pass('version derives from package.json (no drift possible)');

// a committed absolute JDK path is one machine's build, not the repo's
const props = readFileSync(join(android, 'gradle.properties'), 'utf8');
if (/org\.gradle\.java\.home/.test(props)) {
  fail('gradle.properties pins org.gradle.java.home — that path is one machine\'s');
} else pass('no machine-specific JDK path committed');

// ---- nothing that phones home ---------------------------------------------
// The no-telemetry receipt greps TypeScript. A Gradle dependency reaches the
// network without a single fetch( appearing anywhere in src/.
const BANNED = ['firebase', 'crashlytics', 'com.google.android.gms', 'analytics', 'google-services', 'appcenter'];
const gradleFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'build' || name === '.gradle' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(gradle|properties)$/.test(name)) gradleFiles.push(p);
  }
})(android);
const hits = [];
for (const f of gradleFiles) {
  // strip comments first: a line explaining why we removed Google Services is
  // not Google Services, and a check that cannot tell the difference gets
  // silenced rather than fixed
  const body = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join('\n')
    .toLowerCase();
  for (const b of BANNED) if (body.includes(b)) hits.push(`${f.replace(root + '/', '')}: ${b}`);
}
if (hits.length) fail(`telemetry-capable dependency:\n    ${hits.join('\n    ')}`);
else pass(`no analytics or crash-reporting dependency (${gradleFiles.length} gradle files scanned)`);

// ---- debugging is a debug-build affordance --------------------------------
const javaDir = join(android, 'app/src/main/java');
const javaFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.java') || name.endsWith('.kt')) javaFiles.push(p);
  }
})(javaDir);
const debugOn = javaFiles.filter((f) => /setWebContentsDebuggingEnabled\(\s*true\s*\)/.test(readFileSync(f, 'utf8')));
if (debugOn.length) fail(`WebView debugging forced on in ${debugOn.join(', ')} — it must stay debug-build only`);
else pass('WebView debugging not forced on in source');

// ---- report ---------------------------------------------------------------
for (const c of checks) console.log('ok  ', c);
if (problems.length) {
  console.error('');
  for (const p of problems) console.error('FAIL:', p);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed — the android shell keeps the wallet's promises`);
