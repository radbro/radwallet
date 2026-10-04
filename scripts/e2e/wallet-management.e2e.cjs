/** Focused offline wallet creation, backup and secret-clipboard regressions. */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const PASSWORD = 'wallet management fixture password';
const FIRST_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SECOND_SEED = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const PRIVATE_KEY = `0x${randomBytes(32).toString('hex')}`;
const url = process.env.WALLET_MANAGEMENT_URL
  || pathToFileURL(resolve(__dirname, '../../apps/wallet/dist-demo/index.html')).href;
const screenshotDir = process.env.WALLET_MANAGEMENT_SHOTS;

(async () => {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 372, height: 600 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.route(/^https?:\/\//, (route) => {
      const target = new URL(route.request().url());
      if (['127.0.0.1', 'localhost'].includes(target.hostname)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGE ERROR:', error.message); });
    const drawer = page.locator('.drawerbox');
    const dismissToast = async () => {
      const close = page.locator('.toast .x');
      if (await close.count()) await close.click();
    };
    const open = async () => {
      await dismissToast();
      await page.locator('.acctbar button.who').click();
      await drawer.waitFor();
    };
    const button = (name) => drawer.getByRole('button', { name, exact: true });
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    const expectRowCount = async (scope, count) => {
      await page.waitForFunction(
        ({ expected }) => document.querySelectorAll('.drawerbox .walletrow').length === expected,
        { expected: count },
      );
      assert.equal(await scope.locator('.walletrow').count(), count);
    };
    const snapshot = async (name, maskSecret = false) => {
      if (!screenshotDir) return;
      if (!maskSecret) assert.equal(await page.locator('.secretbox').count(), 0, 'screenshots must not contain a revealed secret');
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: resolve(screenshotDir, `${name}.png`),
        ...(maskSecret ? { mask: [page.locator('.secretbox')], maskColor: '#000000' } : {}),
      });
    };
    const importWallet = async (kind, value, nickname) => {
      await button('+ ADD WALLET').click();
      await button(kind).click();
      await drawer.locator('textarea').fill(value);
      await drawer.locator('input[placeholder="nickname (optional)"]').fill(nickname);
      await button('IMPORT').click();
      await drawer.waitFor({ state: 'detached' });
    };
    const reveal = async (group) => {
      await group.getByRole('button', { name: /BACK UP (SEED PHRASE|PRIVATE KEY)/ }).click();
      await group.locator('input[name=password]').fill(PASSWORD);
      await group.getByRole('button', { name: 'SHOW IT', exact: true }).click();
      await group.locator('.secretbox.hidden').waitFor();
    };
    const copySecret = async (group) => {
      await group.getByRole('button', { name: 'COPY?', exact: true }).click();
      await dismissToast();
      await group.getByRole('button', { name: 'YES, COPY', exact: true }).click();
      await group.getByRole('button', { name: 'CLEAR CLIPBOARD', exact: true }).waitFor();
    };

    await page.goto(url);
    await page.getByRole('button', { name: 'I ALREADY HAVE ONE', exact: true }).click();
    await page.locator('textarea').fill(FIRST_SEED);
    await page.locator('input[name=password]').fill(PASSWORD);
    await page.getByRole('button', { name: 'IMPORT', exact: true }).click();
    await page.locator('.acctbar').waitFor();
    await open();
    await button('+ ADD WALLET').click();
    await snapshot('01-add-wallet-menu');
    await button('CREATE ANOTHER ADDRESS').click();
    assert.equal(await drawer.getByLabel('seed phrase for new address').locator('option').count(), 1);
    assert.match(await drawer.textContent(), /same seed phrase/);
    // Two events in one task must still perform only one vault mutation.
    await button('CREATE ADDRESS').evaluate((node) => { node.click(); node.click(); });
    await drawer.waitFor({ state: 'detached' });
    await open();
    assert.equal(await drawer.locator('.walletrow').count(), 2);
    await importWallet('IMPORT A SEED PHRASE', SECOND_SEED, 'second seed');
    await open();
    await button('+ ADD WALLET').click();
    await button('CREATE ANOTHER ADDRESS').click();
    const seedSelect = drawer.getByLabel('seed phrase for new address');
    const choices = await seedSelect.locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent })));
    assert.equal(choices.length, 2);
    assert.equal(await seedSelect.inputValue(), choices[1].value, 'creation should default to the selected wallet seed');
    const seedStyle = await seedSelect.evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
      height: node.getBoundingClientRect().height,
    }));
    assert.equal(seedStyle.background, 'rgb(0, 0, 0)', 'seed selection must preserve the black wallet skin');
    assert.equal(seedStyle.color, 'rgb(255, 224, 0)', 'seed selection must preserve the yellow wallet text');
    assert.ok(seedStyle.height >= 44, 'seed selection must keep a 44px tap target');
    await seedSelect.selectOption(choices[0].value);
    await snapshot('02-create-address');
    await button('CREATE ADDRESS').click();
    await drawer.waitFor({ state: 'detached' });
    await open();
    const groups = drawer.locator('.walletgroup');
    assert.equal(await groups.nth(0).locator('.walletrow').count(), 3);
    assert.equal(await groups.nth(1).locator('.walletrow').count(), 1);
    const addresses = await drawer.locator('.walletrow .addr').evaluateAll((nodes) => nodes.map((node) => node.firstChild.textContent.trim()));
    assert.equal(new Set(addresses).size, 4, 'created addresses must be distinct');
    await groups.nth(0).locator('.ghead .more').click();
    const addFromFirstSeed = groups.nth(0).getByRole('button', { name: '+ new wallet', exact: true });
    for (let count = 4; count <= 14; count++) {
      await addFromFirstSeed.click();
      await expectRowCount(drawer, count + 1);
    }
    assert.equal(await drawer.locator('.walletrow.sel .nick').textContent(), 'wallet 14');
    await drawer.locator('.drawerhead .x').click();
    await drawer.waitFor({ state: 'detached' });
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    await open();
    await page.waitForFunction(() => {
      const body = document.querySelector('.drawerbox .drawerbody');
      const selected = body?.querySelector('.walletrow.sel');
      if (!body || !selected) return false;
      const bodyBox = body.getBoundingClientRect();
      const rowBox = selected.getBoundingClientRect();
      return rowBox.top >= bodyBox.top && rowBox.bottom <= bodyBox.bottom;
    });
    const selectedVisibility = await drawer.locator('.drawerbody').evaluate((node) => {
      const selected = node.querySelector('.walletrow.sel');
      if (!selected) return { found: false, bodyScroll: 0, overflows: false, visible: false, windowScroll: window.scrollY };
      const bodyBox = node.getBoundingClientRect();
      const rowBox = selected.getBoundingClientRect();
      return {
        found: true,
        bodyScroll: node.scrollTop,
        overflows: node.scrollHeight > node.clientHeight,
        bodyTop: bodyBox.top,
        bodyBottom: bodyBox.bottom,
        rowTop: rowBox.top,
        rowBottom: rowBox.bottom,
        visible: rowBox.top >= bodyBox.top && rowBox.bottom <= bodyBox.bottom,
        windowScroll: window.scrollY,
      };
    });
    assert.equal(selectedVisibility.found, true, 'selected wallet row should exist');
    assert.equal(selectedVisibility.overflows, true, 'fixture must overflow the drawer body');
    assert.ok(selectedVisibility.bodyScroll > 0, 'drawer body should scroll to the selected wallet');
    assert.equal(selectedVisibility.visible, true, `selected wallet should be visible after opening the drawer: ${JSON.stringify(selectedVisibility)}`);
    assert.equal(selectedVisibility.windowScroll, pageScrollBefore, 'opening the drawer must not scroll the page');
    assert.equal(await drawer.locator('.walletrow.sel .nick').textContent(), 'wallet 14', 'auto-scroll must not change selection');
    await drawer.locator('input.search').fill('wallet 14');
    assert.equal(await drawer.locator('.walletrow').count(), 1, 'search should still filter after selected-row auto-scroll');
    assert.equal(await drawer.locator('.walletrow.sel .nick').textContent(), 'wallet 14');
    await drawer.locator('input.search').fill('');
    await expectRowCount(drawer, 15);
    await drawer.locator('.drawerbody').evaluate((node) => { node.scrollTop = 0; });
    const firstWallet = drawer.locator('.walletrow').first();
    await firstWallet.locator('.more').click();
    await firstWallet.getByRole('button', { name: 'labels', exact: true }).click();
    await firstWallet.locator('.walletedit input').fill('hot');
    await firstWallet.getByRole('button', { name: 'save', exact: true }).click();
    await drawer.locator('.filterrow .chip', { hasText: 'hot' }).click();
    assert.equal(await drawer.locator('.walletrow').count(), 1, 'label filter fixture should hide the selected wallet');
    assert.equal(await drawer.locator('.walletrow.sel').count(), 0, 'selected wallet should be absent while the stale filter is active');
    await drawer.locator('.drawerhead .x').click();
    await drawer.waitFor({ state: 'detached' });
    await open();
    await page.waitForFunction(() => {
      const body = document.querySelector('.drawerbox .drawerbody');
      const selected = body?.querySelector('.walletrow.sel');
      if (!body || !selected) return false;
      const bodyBox = body.getBoundingClientRect();
      const rowBox = selected.getBoundingClientRect();
      return rowBox.top >= bodyBox.top && rowBox.bottom <= bodyBox.bottom;
    });
    assert.equal(await drawer.locator('.filterrow .chip.on').textContent(), 'all', 'opening should clear only a stale label filter');
    assert.equal(await drawer.locator('.walletrow.sel .nick').textContent(), 'wallet 14', 'stale-filter cleanup must preserve selected wallet');
    await importWallet('IMPORT A PRIVATE KEY', PRIVATE_KEY, 'standalone key');
    await open();
    await button('BACK UP SEED PHRASES & KEYS').click();
    assert.equal(await drawer.locator('.backup-group').count(), 2);
    assert.equal(await drawer.locator('.backup-key').count(), 1);
    await snapshot('03-wallet-backups');

    const first = drawer.locator('.backup-group').first();
    await first.getByRole('button', { name: 'BACK UP SEED PHRASE', exact: true }).click();
    await first.locator('input[name=password]').fill('wrong fixture password');
    await first.getByRole('button', { name: 'SHOW IT', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('password'));
    assert.equal(await first.locator('.secretbox').count(), 0);
    await first.locator('input[name=password]').fill(PASSWORD);
    await first.getByRole('button', { name: 'SHOW IT', exact: true }).click();
    await first.locator('.secretbox.hidden').waitFor();
    assert.equal(await first.locator('.secretbox').textContent(), FIRST_SEED);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await first.getByRole('button', { name: 'COPY?', exact: true }).click();
    assert.equal(await clipboard(), '', 'first copy click is consent only');
    await dismissToast();
    await first.getByRole('button', { name: 'YES, COPY', exact: true }).click();
    await first.getByRole('button', { name: 'CLEAR CLIPBOARD', exact: true }).waitFor();
    assert.equal(await clipboard(), FIRST_SEED);
    const clearVisible = await first.getByRole('button', { name: 'CLEAR CLIPBOARD', exact: true }).evaluate((node) => {
      const action = node.getBoundingClientRect();
      const body = node.closest('.drawerbody').getBoundingClientRect();
      return action.top >= body.top && action.bottom <= body.bottom;
    });
    assert.ok(clearVisible, 'clipboard clearing must be visible immediately after copying at popup size');
    await snapshot('04-clipboard-copied', true);
    await first.getByRole('button', { name: 'CLEAR CLIPBOARD', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.clipboard-status')?.textContent === 'Clipboard cleared.');
    assert.equal(await clipboard(), '');
    await snapshot('05-clipboard-cleared', true);

    // Switching backup targets must not cache an already unlocked secret.
    await drawer.locator('.backup-group').nth(1).getByRole('button', { name: 'BACK UP SEED PHRASE', exact: true }).click();
    await first.getByRole('button', { name: 'BACK UP SEED PHRASE', exact: true }).click();
    assert.equal(await first.locator('.secretbox').count(), 0);
    assert.equal(await first.locator('input[name=password]').inputValue(), '');
    await first.getByRole('button', { name: 'CANCEL', exact: true }).click();

    const imported = drawer.locator('.backup-key');
    await reveal(imported);
    assert.equal(await imported.locator('.secretbox').textContent(), PRIVATE_KEY);
    await copySecret(imported);
    await page.evaluate(() => {
      window.originalClipboardRead = navigator.clipboard.readText;
      navigator.clipboard.readText = async () => { throw new Error('fixture read denied'); };
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForFunction(() => document.querySelector('.clipboard-status')?.textContent?.includes('blocked'));
    await imported.getByRole('button', { name: 'CLEAR CLIPBOARD', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.clipboard-status')?.textContent === 'Clipboard cleared.');
    await page.evaluate(() => { navigator.clipboard.readText = window.originalClipboardRead; delete window.originalClipboardRead; });
    assert.equal(await clipboard(), '');
    await copySecret(imported);
    await page.evaluate(() => navigator.clipboard.writeText('newer copy to preserve'));
    await imported.getByRole('button', { name: 'DONE', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await clipboard(), 'newer copy to preserve');
    await reveal(imported);
    await copySecret(imported);
    await drawer.locator('.drawerhead .x').click();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === '');
    assert.equal(await page.locator('.secretbox').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: seed selection, single mutation per create, independent key backup, fresh password per reveal, explicit/denied-read clearing, replacement preservation, and drawer-close cleanup.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
