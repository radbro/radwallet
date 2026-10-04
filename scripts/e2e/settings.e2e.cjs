// Disposable profiles only. Check Settings against the real session backends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const PASSWORD = 'settings fixture password';
const root = path.resolve(__dirname, '../..');

async function createWallet(page) {
  await page.getByText('MAKE A NEW WALLET', { exact: true }).click();
  await page.getByPlaceholder('password', { exact: true }).fill(PASSWORD);
  await page.getByPlaceholder('password again', { exact: true }).fill(PASSWORD);
  await page.getByText('GENERATE SEED', { exact: true }).click();
  await page.waitForSelector('.seedbox');
  await page.locator('label.row input[type=checkbox]').check();
  await page.getByText('ENTER THE WEBRING', { exact: true }).click();
  await page.waitForSelector('.tabbar');
}

async function security(page) {
  const tabHeight = await page.locator('.tabbar').evaluate((el) => el.getBoundingClientRect().height);
  assert(tabHeight >= 44, `navigation collapsed below its tap targets: ${tabHeight}px`);
  await page.locator('.tabbar .tab').filter({ hasText: 'SETTINGS' }).click();
  await page.waitForSelector('.setlist');
  assert.equal(await page.locator('.guarantees').count(), 0, 'settings should open directly on controls');
  await page.locator('.setrowlink').filter({ hasText: 'SECURITY' }).click();
}

async function saveInterval(page, minutes) {
  await page.getByLabel('auto-lock minutes').fill(String(minutes));
  await page.getByRole('button', { name: 'APPLY', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('timer restarted'));
}

function call(page, message) {
  return page.evaluate((msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)), message);
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radwallet-settings-'));
  const extension = path.join(root, 'apps/extension/dist');
  let ctx, browser;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: { width: 372, height: 740 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    // Wallet reads fail locally; this test needs no public RPC or funded account.
    await ctx.route('https://**/*', (route) => route.abort());
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/index.html`);
    await createWallet(page);
    // Legacy zero disabled the timer. Opening the next session must migrate
    // it to a bounded default rather than silently keeping that behavior.
    await page.evaluate(() => new Promise((resolve) => chrome.storage.local.set({ prefs: JSON.stringify({ autoLockMin: 0 }) }, resolve)));
    await call(page, { t: 'sess.lock' });
    await page.reload();
    await page.getByPlaceholder('password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'UNLOCK', exact: true }).click();
    await page.waitForSelector('.tabbar');
    const status = await call(page, { t: 'sess.status' });
    const address = status.accounts[0].address;
    await security(page);
    assert.equal(await page.getByLabel('auto-lock minutes').inputValue(), '15');
    for (const t of ['sess.unlock', 'sess.create']) {
      const invalidSession = await call(page, { t, autoLockMin: 0 });
      assert.match(invalidSession.error, /1.*240/, `${t} accepted an unbounded interval`);
    }
    await saveInterval(page, 1);
    const timer = await page.evaluate(() => new Promise((resolve) => {
      chrome.alarms.get('radlock', (alarm) => resolve({ remaining: alarm.scheduledTime - Date.now() }));
    }));
    assert(timer.remaining > 50_000 && timer.remaining <= 60_000, `live timer was not updated: ${JSON.stringify(timer)}`);
    const invalid = await call(page, { t: 'sess.setAutoLock', minutes: 0 });
    assert.match(invalid.error, /1.*240/);
    const persisted = await page.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('prefs', (v) => resolve(JSON.parse(v.prefs).autoLockMin));
    }));
    assert.equal(persisted, 1);
    console.log('Settings: auto-lock applies to the live extension session and rejects zero');

    const origin = 'http://127.0.0.1:18933';
    await ctx.route(`${origin}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>settings fixture dapp</h1>' }));
    const dapp = await ctx.newPage();
    await dapp.goto(`${origin}/`);
    await dapp.waitForFunction(() => !!window.ethereum);
    await dapp.evaluate(() => {
      window.accountEvents = [];
      window.ethereum.on('accountsChanged', (value) => window.accountEvents.push(value));
    });
    assert.equal((await call(page, { t: 'sess.setConnection', origin, addresses: [address] })).ok, true);
    await dapp.waitForFunction(() => window.accountEvents.some((v) => v.length === 1));
    // Remount Settings so it loads the newly connected site's current state.
    await page.locator('.tabbar .tab').filter({ hasText: 'HOME' }).click();
    await page.locator('.tabbar .tab').filter({ hasText: 'SETTINGS' }).click();
    await page.locator('.setrowlink').filter({ hasText: 'CONNECTED SITES' }).click();
    await page.locator('.rpcrow').filter({ hasText: origin }).getByRole('button', { name: 'disconnect', exact: true }).click();
    await dapp.waitForFunction(() => window.accountEvents.some((v) => v.length === 0));
    assert.deepEqual(await dapp.evaluate(() => window.ethereum.request({ method: 'eth_accounts' })), []);
    console.log('Settings: Disconnect notifies the connected site and revokes account access');
    await ctx.close();
    ctx = null;

    browser = await chromium.launch({ channel: 'chromium' });
    const local = await browser.newPage({ viewport: { width: 372, height: 740 } });
    await local.goto(`file://${path.join(root, 'apps/wallet/dist-demo/index.html')}`);
    await createWallet(local);
    await local.clock.install();
    await security(local);
    await saveInterval(local, 1);
    await local.clock.fastForward(59_000);
    assert.equal(await local.locator('.tabbar').count(), 1, 'local wallet locked before its interval');
    await local.clock.fastForward(2_000);
    await local.waitForSelector('input[autocomplete=current-password]');
    assert.equal(await local.locator('.tabbar').count(), 0);
    console.log('Settings: the live local session locks at the newly saved interval');
  } finally {
    if (ctx) await ctx.close();
    if (browser) await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
