/**
 * The wallet running as a real Android app, driven for real.
 *
 * Not a screenshot-and-squint. Android's WebView speaks CDP over adb, so
 * Playwright attaches to the app running on a device or emulator and drives it
 * with the same selectors the PWA suite uses:
 *
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * Debug builds only — release builds do not expose that socket, which is the
 * point of it being debug-only.
 *
 * Needs: an emulator or device on `adb devices`, and a built debug APK
 * (`npm run build:android`).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Cdp } = require('./cdp.cjs');

const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || '/opt/homebrew/share/android-commandlinetools';
const ADB = process.env.ADB_PATH || path.join(SDK, 'platform-tools', 'adb');
const APP = 'xyz.radbro.radwallet';
const APK = path.resolve(__dirname, '../../apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
const PORT = 9222;
const PASSWORD = 'correct horse battery staple';
const SHORT_PASSWORD = 'hunter2hunter2';

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim();
/** adb commands that legitimately fail: `pidof` exits non-zero when the app is
 *  simply not running yet, which is the normal state while we wait for it */
const adbSoft = (...args) => { try { return adb(...args); } catch { return ''; } };
/**
 * The app's SharedPreferences, read off the device.
 *
 * SharedPreferences commits with apply(), which writes the XML asynchronously —
 * so reading the file straight after a change shows the state BEFORE it. That
 * stale read once made a broken migration test report success, which is a worse
 * outcome than a failing one. Poll until the file agrees with `want`, and give
 * up honestly rather than accepting whatever is there.
 */
const prefsXml = () => adbSoft('shell', 'run-as', APP, 'cat', 'shared_prefs/CapacitorStorage.xml');
async function prefsSettle(want, ms = 8000) {
  const deadline = Date.now() + ms;
  let xml = prefsXml();
  while (Date.now() < deadline && !want(xml)) {
    await sleep(400);
    xml = prefsXml();
  }
  return xml;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** a screenshot of the whole screen, as PNG bytes */
const screencap = () => execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });

function requireDevice() {
  const lines = adb('devices').split('\n').slice(1).filter((l) => l.trim());
  const ready = lines.filter((l) => l.endsWith('\tdevice'));
  if (!ready.length) {
    console.log('NO DEVICE. Start the emulator or plug in a phone:');
    console.log(`  ${path.join(SDK, 'emulator', 'emulator')} -avd radwallet-test -no-window &`);
    process.exit(1);
  }
  return ready[0].split('\t')[0];
}

/** launch the app and hand back a Playwright page attached to its WebView */
async function attach() {
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`);
  let pid = '';
  for (let i = 0; i < 30 && !pid; i++) {
    pid = adbSoft('shell', 'pidof', APP).trim();
    if (!pid) await sleep(500);
  }
  if (!pid) throw new Error('app did not start');
  // the devtools socket appears a beat after the process does
  let socket = '';
  for (let i = 0; i < 40 && !socket; i++) {
    const unix = adbSoft('shell', 'cat', '/proc/net/unix');
    const hit = unix.match(new RegExp(`webview_devtools_remote_${pid}`));
    if (hit) socket = hit[0]; else await sleep(500);
  }
  if (!socket) throw new Error('no webview devtools socket — is this a debug build?');
  adbSoft('forward', '--remove', `tcp:${PORT}`);
  adb('forward', `tcp:${PORT}`, `localabstract:${socket}`);

  const page = await Cdp.attach(PORT);
  await page.waitFor('.titlebar');
  // The titlebar renders before boot() has finished reading storage, and boot
  // SETS the screen when it lands — so a click in that window is on a component
  // about to be unmounted, and reads as a control that did nothing. Wait for the
  // screen boot chose.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const body = await page.text();
    if (body.includes('MAKE A NEW WALLET') || body.includes('Locked') || body.includes('RECEIVE')) break;
    await sleep(250);
  }
  await sleep(600);
  return page;
}

(async () => {
  const device = requireDevice();
  console.log('DEVICE:', device, '| android', adb('shell', 'getprop', 'ro.build.version.release'));
  adb('install', '-r', APK);
  // a wallet left over from a previous run is not a fresh install
  adb('shell', 'pm', 'clear', APP);

  let page = await attach();

  // ---- the shell keeps the web app's assumptions intact --------------------
  const env = await page.eval(`return {
    origin: location.origin,
    secure: isSecureContext,
    subtle: typeof crypto?.subtle?.deriveKey,
    sw: !!navigator.serviceWorker?.controller,
    idb: typeof indexedDB,
  };`);
  console.log('ORIGIN:', env.origin, '| SECURE CONTEXT:', env.secure, '| crypto.subtle.deriveKey:', env.subtle);
  if (!env.secure || env.subtle !== 'function') throw new Error('no WebCrypto — nothing else matters');
  // the android vite mode drops the service worker on purpose: these files are
  // already local, and a SW in front of them is one more way to serve a stale app
  console.log('NO SERVICE WORKER IN THE APP:', env.sw === false);
  if (env.sw) throw new Error('a service worker registered inside the WebView');

  // ---- what a password actually costs on this hardware ---------------------
  // 600k PBKDF2 rounds is tuned for a laptop. This number is a FLOOR, not the
  // answer: an arm64 emulator on an arm64 Mac runs CPU work near native, so a
  // cheap phone will be slower — by how much is the question a real device
  // answers.
  const kdfMs = await page.eval(`
    const t = performance.now();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery staple'), 'PBKDF2', false, ['deriveKey']);
    await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600000 },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    return Math.round(performance.now() - t);
  `);
  console.log('PBKDF2 600k ON THIS TARGET:', kdfMs, 'ms (floor — a real phone is slower)');

  // ---- make a wallet -------------------------------------------------------
  await page.clickText('MAKE A NEW WALLET');
  await page.waitFor('input[placeholder="password"]');
  const pwForm = await page.eval(`return {
    forms: document.forms.length,
    fields: [...document.querySelectorAll('input[type=password]')]
      .map((i) => ({ name: i.name, inForm: !!i.form, autocomplete: i.autocomplete })),
  };`);
  console.log('PASSWORD FIELDS ARE A FORM:', JSON.stringify(pwForm));
  await page.fill('input[placeholder="password"]', SHORT_PASSWORD);
  await page.fill('input[placeholder="password again"]', SHORT_PASSWORD);
  await sleep(100);
  const shortPw = await page.eval(`return {
    disabled: document.querySelector('button[type=submit]')?.disabled,
    guidance: document.body.innerText.includes('16+ characters'),
    seed: !!document.querySelector('.seedbox'),
  };`);
  console.log('SHORT VAULT PASSWORD REFUSED:', JSON.stringify(shortPw));
  if (!shortPw.disabled || !shortPw.guidance || shortPw.seed) {
    throw new Error('new wallet accepted or under-explained a short password');
  }
  await page.fill('input[placeholder="password"]', PASSWORD);
  await page.fill('input[placeholder="password again"]', PASSWORD);
  await page.clickText('GENERATE SEED');
  await page.waitFor('.seedbox', 90000);
  const seed = (await page.text('.seedbox')).replace(/\d+/g, ' ').trim().split(/\s+/);
  console.log('SEED WORDS:', seed.length);
  // FLAG_SECURE makes the compositor hand back black, so a screenshot of the
  // seed screen should be a solid frame — which PNG compresses to almost
  // nothing next to a rendered one. Sizes, because a byte-for-byte black test
  // would need a PNG decoder and this separation is three orders of magnitude.
  // Shoot the SAME screen twice, once with FLAG_SECURE and once without.
  // Comparing the seed screen against some other screen would prove nothing —
  // screens differ in how much they render — but with the content held fixed,
  // the only variable left is the flag. A secure window comes back solid black
  // from the compositor, and solid black is what PNG compresses to nothing.
  // (Not zero: the status and navigation bars are separate windows that
  // FLAG_SECURE does not cover, which is why an absolute size test misreads a
  // working flag as a broken one.)
  const secureShot = screencap().length;
  await page.eval('await window.Capacitor.Plugins.ScreenGuard.setSecure({ secure: false }); return 1;');
  await sleep(800);
  const exposedShot = screencap().length;
  await page.eval('await window.Capacitor.Plugins.ScreenGuard.setSecure({ secure: true }); return 1;');
  await page.click('label.row input[type=checkbox]');
  await page.clickText('ENTER THE WEBRING');
  await page.waitFor('.balance .big', 60000);
  const addr = (await page.text('.acctbar')).slice(0, 24);
  console.log('WALLET CREATED:', addr.split('\n')[0]);

  const blanked = secureShot * 3 < exposedShot;
  console.log('SEED SCREEN CANNOT BE SCREENSHOTTED:', blanked,
    `| same screen: ${(secureShot / 1024).toFixed(1)}KB guarded vs ${(exposedShot / 1024).toFixed(1)}KB exposed`);
  if (!blanked) throw new Error('FLAG_SECURE did not blank the seed screen');

  // and it is released once the seed is gone. A wallet that permanently
  // refuses screenshots also refuses one of a receive address, which is an
  // ordinary thing to want to send someone.
  // the flag is cleared by the effect cleanup when the seed screen unmounts,
  // and that is a round trip to the native bridge — give it one
  await sleep(1500);
  const homeShot = screencap().length;
  console.log('AND THE REST OF THE WALLET STILL CAN BE:', homeShot > secureShot * 3,
    `| home ${(homeShot / 1024).toFixed(1)}KB`);
  if (homeShot <= secureShot * 3) throw new Error('FLAG_SECURE was left on after the seed screen');

  // where did the vault land, and did anything reach for localStorage
  // SharedPreferences, not the WebView's own storage: IndexedDB inside an app
  // is still web storage — evictable, and wiped by anything that clears WebView
  // data. `run-as` reads app-private files on a debug build.
  const xml = await prefsSettle((x) => x.includes('name="vault"'));
  console.log('VAULT IS IN SHARED PREFERENCES:', xml.includes('name="vault"'),
    '| keys:', (xml.match(/name="([^"]+)"/g) || []).length);
  if (!xml.includes('name="vault"')) throw new Error('no vault in SharedPreferences');

  const stored = await page.eval(`
    const idb = await new Promise((res) => {
      const r = indexedDB.open('radwallet', 1);
      r.onsuccess = () => {
        const st = r.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
        st.onsuccess = () => res(st.result);
      };
      r.onerror = () => res(['<open failed>']);
    });
    return { ls: Object.keys(localStorage), idb };
  `);
  console.log('AND NOT IN WEB STORAGE:', !stored.idb.includes('vault'),
    '| indexeddb:', JSON.stringify(stored.idb), '| localStorage:', JSON.stringify(stored.ls));
  if (stored.idb.includes('vault')) throw new Error('the vault is still in the WebView');

  // ---- backgrounding is the common case, not force-stop --------------------
  // No background worker holds these keys, and Android kills backgrounded apps
  // whenever it likes — so the wallet drops them itself on the way out rather
  // than depending on whether the OS got round to it.
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(2000);
  page.close();
  page = await attach();
  await page.waitForText('Locked', 20000).catch(() => {});
  const backgrounded = (await page.text()).includes('Locked');
  console.log('BACKGROUNDING LOCKS THE WALLET:', backgrounded);
  if (!backgrounded) throw new Error('the wallet stayed unlocked through a trip to the home screen');

  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitFor('.balance .big', 90000);

  // ---- the app is killed constantly; the vault must not be ------------------
  page.close();
  adb('shell', 'am', 'force-stop', APP);
  await sleep(1500);
  page = await attach();
  // boot() reads the vault out of storage asynchronously, so the first paint is
  // still the welcome screen — wait for the app to settle before judging it
  await page.waitForText('Locked', 30000).catch(() => {});
  const afterKill = await page.text();
  const locked = afterKill.includes('Locked') || afterKill.includes('locked');
  console.log('VAULT SURVIVES A FORCE-STOP:', locked);
  if (!locked) throw new Error(`after a force-stop the wallet showed: ${afterKill.slice(0, 120)}`);

  await page.fill('input[name=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitFor('.balance .big', 90000);
  console.log('UNLOCKS AFTER RESTART:', (await page.text('.acctbar')).slice(0, 24) === addr);

  // ---- biometrics say what they can and cannot do -------------------------
  // The round trip through the Keystore needs a finger actually enrolled on the
  // device, which a headless emulator will not give up — so what is checked
  // here is the part that ships broken most often: a phone that cannot do it
  // has to SAY WHY rather than present a dead toggle (invariant 6). The seal
  // and open path is verified by hand on a device with a fingerprint.
  const bio = await page.eval('return await window.Capacitor.Plugins.Biometric.available();');
  console.log('BIOMETRICS:', bio.available ? 'available' : `unavailable — "${bio.reason}"`);
  if (!bio.available && !bio.reason) throw new Error('biometrics refused without saying why');

  await page.clickText('SETTINGS', '.tabbar .tab');
  await page.waitFor('.setlist', 20000);
  // SETTINGS is an index of rows now; unlocking lives under SECURITY
  await page.clickText('SECURITY', '.setrowlink');
  await page.waitFor('.sectback', 20000);
  const bioRow = await page.eval(`
    const row = [...document.querySelectorAll('label.row')].find((r) => /biometrics/i.test(r.innerText));
    if (!row) return null;
    const box = row.querySelector('input[type=checkbox]');
    return { text: row.innerText.replace(/\\s+/g, ' ').trim(), disabled: !!box?.disabled, checked: !!box?.checked };
  `);
  if (!bioRow) throw new Error('no biometrics row in SETTINGS -> SECURITY');
  const explains = !bioRow.disabled || bioRow.text.includes(bio.reason);
  console.log('AND THE SETTING SAYS SO:', explains, '| disabled:', bioRow.disabled);
  console.log('   row:', JSON.stringify(bioRow.text.slice(0, 96)));
  if (!explains) throw new Error('the biometrics toggle is dead without explaining why');
  await page.clickText('HOME', '.tabbar .tab');
  await page.waitFor('.balance .big', 20000);

  // ---- an install from before the vault moved ------------------------------
  // Put the vault back in the WebView's IndexedDB, wipe the native copy, and
  // restart: the app has to carry it across on its own. An upgrade that cannot
  // find the old vault is indistinguishable, to the person holding the phone,
  // from an upgrade that deleted it.
  const vault = await page.eval(`return (await window.Capacitor.Plugins.Preferences.get({ key: 'vault' })).value;`);
  await page.eval(`
    await new Promise((res, rej) => {
      const r = indexedDB.open('radwallet', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => {
        const tx = r.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(${JSON.stringify(vault)}, 'vault');
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      };
      r.onerror = () => rej(r.error);
    });
    await window.Capacitor.Plugins.Preferences.remove({ key: 'vault' });
    await window.Capacitor.Plugins.Preferences.remove({ key: '__migrated_to_preferences' });
    return 1;
  `);
  // a test that cannot fail for the right reason is worse than no test: prove
  // the "older install" state really exists before restarting into it
  const preState = await prefsSettle((x) => !x.includes('name="vault"'));
  if (preState.includes('name="vault"')) {
    throw new Error('setup failed: the native vault is still there, so the move would be a no-op');
  }
  page.close();
  adb('shell', 'am', 'force-stop', APP);
  await sleep(1500);
  page = await attach();
  await page.waitForText('Locked', 30000).catch(() => {});
  const carried = (await page.text()).includes('Locked');
  const nowPrefs = await prefsSettle((x) => x.includes('name="vault"'));
  const leftBehind = await page.eval(`
    const keys = await new Promise((res) => {
      const r = indexedDB.open('radwallet', 1);
      r.onsuccess = () => {
        const st = r.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
        st.onsuccess = () => res(st.result);
      };
      r.onerror = () => res(['<open failed>']);
    });
    return keys;
  `);
  console.log('AN OLDER INSTALL IS CARRIED ACROSS:', carried,
    '| now in prefs:', nowPrefs.includes('name="vault"'),
    '| left in the webview:', JSON.stringify(leftBehind));
  if (!carried || !nowPrefs.includes('name="vault"')) throw new Error('the vault did not survive the move');
  if (leftBehind.includes('vault')) throw new Error('the old copy was left in the WebView');

  page.close();
  console.log('\nandroid e2e: ok');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
