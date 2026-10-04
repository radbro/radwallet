/** Address book regressions for the real Chrome extension. No funded sends. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { getAddress } = require('viem');
const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();

const PASSWORD = 'address book fixture password';
const DAPP_PORT = 18931;
const SHOT_DIR = path.resolve(__dirname, '../../design/app-shots');

const CONTACT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONTACT_A_BAD_CHECKSUM = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTACT_A_CHECKSUM = getAddress(CONTACT_A);
const CONTACT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUICK_OLD = '0xcccccccccccccccccccccccccccccccccccccccc';
const QUICK_NEW = '0xdddddddddddddddddddddddddddddddddddddddd';
const PICKER_TARGET = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const HISTORY_TARGET = '0xffffffffffffffffffffffffffffffffffffffff';
const APPROVAL_TARGET = '0x1234567890abcdef1234567890abcdef12345678';
const LONG_LABEL_TARGET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MIRROR_TARGET = '0x1010101010101010101010101010101010101010';
const CONCURRENT_ONE = '0x2020202020202020202020202020202020202020';
const CONCURRENT_TWO = '0x3030303030303030303030303030303030303030';
const LONG_LABEL = 'shared multisig label that is deliberately long enough to prove popup wrapping';

function assertLayoutFits(layout, label) {
  assert.ok(layout.html <= layout.viewport + 1, `${label}: document overflows horizontally ${JSON.stringify(layout)}`);
  assert.ok(layout.body <= layout.viewport + 1, `${label}: body overflows horizontally ${JSON.stringify(layout)}`);
  assert.equal(layout.overflowing.length, 0, `${label}: overflowing elements ${JSON.stringify(layout.overflowing)}`);
}

async function createWallet(page) {
  await page.click('text=MAKE A NEW WALLET');
  await page.fill('input[placeholder="password"]', PASSWORD);
  await page.fill('input[placeholder="password again"]', PASSWORD);
  await page.click('text=GENERATE SEED');
  await page.waitForSelector('.seedbox', { timeout: 30000 });
  await page.click('label.row input[type=checkbox]');
  await page.click('text=ENTER THE WEBRING');
  await page.waitForSelector('.acctbar', { timeout: 30000 });
}

async function openAddressBook(page) {
  if (await page.locator('h1.simhead:text-is("ADDRESS BOOK")').count()) return;
  await page.locator('.tabbar .tab', { hasText: 'SETTINGS' }).click();
  await page.locator('.setrowlink', { hasText: 'ADDRESS BOOK' }).click();
  await page.locator('h1.simhead:text-is("ADDRESS BOOK")').waitFor();
}

async function addAddress(page, address, label) {
  await page.getByRole('button', { name: '+ ADD ADDRESS', exact: true }).click();
  const form = page.locator('.contact-form').last();
  await form.getByLabel('contact address').fill(address);
  await form.getByLabel('address label').fill(label);
  await form.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).click();
  await page.locator('.address-label', { hasText: label }).waitFor();
}

async function beginAddress(page, address, label) {
  await page.getByRole('button', { name: '+ ADD ADDRESS', exact: true }).click();
  const form = page.locator('.contact-form').last();
  await form.getByLabel('contact address').fill(address);
  await form.getByLabel('address label').fill(label);
  return form;
}

async function storedContacts(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.get('addressBook', (r) => {
      try { resolve(JSON.parse(r.addressBook || '[]')); }
      catch { resolve([]); }
    });
  }));
}

async function saveShot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const dismiss = page.locator('.toast .x');
  if (await dismiss.count()) await dismiss.click();
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const interesting = [...document.querySelectorAll('.labeled-address,.contact-row,.send-recipient,.drawerbox,.content')];
    return {
      viewport,
      html: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      overflowing: interesting.flatMap((el) => {
        const r = el.getBoundingClientRect();
        return r.right > viewport + 1
          ? [{ cls: el.className, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), right: r.right }]
          : [];
      }),
    };
  });
}

async function openSend(page) {
  await page.locator('.tabbar .tab', { hasText: 'HOME' }).click();
  await page.locator('.actions .tile', { hasText: 'SEND' }).click();
  await page.locator('.drawerbox[aria-label="send"]').waitFor();
}

async function closeDrawer(page) {
  const x = page.locator('.drawerhead .x');
  if (await x.count()) {
    await x.click();
    await page.locator('.drawerbox').waitFor({ state: 'detached' }).catch(() => {});
  }
}

async function firstOwnedAddress(page) {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll('.testhead')];
    const owned = heads.find((h) => h.textContent.trim() === 'YOUR WALLETS');
    const value = owned?.parentElement?.querySelector('.address-value')?.textContent?.trim();
    const label = owned?.parentElement?.querySelector('.address-label')?.textContent?.trim();
    return { value, label };
  });
}

(async () => {
  const dapp = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>address book fixture dapp</h1><script>window.addEventListener("eip6963:announceProvider",()=>{}); window.dispatchEvent(new Event("eip6963:requestProvider"));</script>');
  });
  await new Promise((resolve) => dapp.listen(DAPP_PORT, '127.0.0.1', resolve));

  const ext = path.resolve(__dirname, '../../apps/extension/dist');
  const profile = path.join(os.tmpdir(), 'radwallet-e2e-addressbook');
  fs.rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
    ignoreHTTPSErrors: true,
    viewport: { width: 372, height: 600 },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    page.on('pageerror', (error) => { throw error; });
    await page.goto(`chrome-extension://${extId}/index.html`);
    await createWallet(page);

    await openAddressBook(page);
    const owned = await firstOwnedAddress(page);
    assert.match(owned.value || '', /^0x[0-9a-fA-F]{40}$/, 'address book should include the first owned wallet');
    assert.match(owned.label || '', /wallet 1.*your wallet/i, 'owned wallet should use its wallet name as the label');
    console.log('1. OWNED WALLET INDEXED:', owned.label, owned.value);

    await addAddress(page, CONTACT_A, 'treasury desk');
    await page.reload();
    await openAddressBook(page);
    await page.locator('.address-label', { hasText: 'treasury desk' }).waitFor();
    const badChecksum = await beginAddress(page, CONTACT_A_BAD_CHECKSUM, 'bad checksum');
    assert.equal(await badChecksum.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).isEnabled(), false);
    await badChecksum.getByRole('button', { name: 'CANCEL', exact: true }).click();
    await addAddress(page, CONTACT_A_CHECKSUM, 'treasury desk renamed');
    let contacts = await storedContacts(page);
    assert.equal(contacts.filter((c) => c.address.toLowerCase() === CONTACT_A).length, 1);
    assert.equal(contacts.find((c) => c.address.toLowerCase() === CONTACT_A)?.label, 'treasury desk renamed');
    console.log('2. SAVED CONTACT PERSISTS AND DEDUPES CASE-INSENSITIVELY');

    await addAddress(page, CONTACT_B, 'ops multisig');
    const rowB = page.locator('.contact-row', { hasText: 'ops multisig' });
    await rowB.getByRole('button', { name: /actions for ops multisig/ }).click();
    await rowB.getByRole('button', { name: 'edit label', exact: true }).click();
    await rowB.getByLabel('address label').fill('ops multisig edited');
    await rowB.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).click();
    await page.locator('.address-label', { hasText: 'ops multisig edited' }).waitFor();
    const rowB2 = page.locator('.contact-row', { hasText: 'ops multisig edited' });
    await rowB2.getByRole('button', { name: /actions for ops multisig edited/ }).click();
    await rowB2.getByRole('button', { name: 'remove', exact: true }).click();
    await rowB2.getByRole('button', { name: 'REMOVE IT', exact: true }).click();
    await page.waitForFunction((addr) => {
      const rows = [...document.querySelectorAll('.contact-row .address-value')];
      return rows.every((row) => row.textContent.trim().toLowerCase() !== addr);
    }, CONTACT_B);
    contacts = await storedContacts(page);
    assert.equal(contacts.some((c) => c.address.toLowerCase() === CONTACT_B), false);
    console.log('3. CONTACT LABEL EDITS AND DELETE CONFIRMATION UPDATE STORAGE');

    await page.locator('.tabbar .tab', { hasText: 'HOME' }).click();
    await page.locator('.acctbar button.who').click();
    const drawer = page.locator('.drawerbox[aria-label="wallets"]');
    await drawer.waitFor();
    await drawer.locator('.ghead .more').first().click();
    await drawer.getByRole('button', { name: '+ new wallet', exact: true }).click();
    await drawer.locator('.walletrow.sel .nick', { hasText: 'wallet 2' }).waitFor();
    await closeDrawer(page);
    await openAddressBook(page);
    const wallet2 = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.address-label')];
      const hit = labels.find((l) => /wallet 2/.test(l.textContent || ''));
      return {
        label: hit?.textContent?.trim(),
        address: hit?.parentElement?.querySelector('.address-value')?.textContent?.trim(),
      };
    });
    assert.match(wallet2.address || '', /^0x[0-9a-fA-F]{40}$/);
    await page.locator('.tabbar .tab', { hasText: 'HOME' }).click();
    await page.locator('.acctbar button.who').click();
    await drawer.waitFor();
    const selected = drawer.locator('.walletrow.sel');
    await selected.locator('.more').click();
    await selected.getByRole('button', { name: 'rename', exact: true }).click();
    await selected.locator('.walletedit input').fill('payroll cold');
    await selected.getByRole('button', { name: 'save', exact: true }).click();
    await closeDrawer(page);
    await openAddressBook(page);
    const renamed = await page.locator('.contact-row', { hasText: wallet2.address }).locator('.address-label').textContent();
    assert.match(renamed || '', /payroll cold.*your wallet/i);
    console.log('4. NEW AND RENAMED OWNED WALLETS REFLECT IN ADDRESS BOOK');

    await addAddress(page, PICKER_TARGET, 'picker exact');
    await addAddress(page, HISTORY_TARGET, 'history vendor');
    await addAddress(page, APPROVAL_TARGET, 'approval vendor');
    await addAddress(page, LONG_LABEL_TARGET, LONG_LABEL);
    await saveShot(page, 'addressbook-settings.png');

    const mirror = await ctx.newPage();
    await mirror.goto(`chrome-extension://${extId}/index.html`);
    await mirror.waitForSelector('.acctbar', { timeout: 30000 });
    await openAddressBook(mirror);
    await addAddress(mirror, MIRROR_TARGET, 'mirror page');
    await page.locator('.address-label', { hasText: 'mirror page' }).waitFor({ timeout: 10000 });
    assert.equal((await storedContacts(page)).some((c) => c.address.toLowerCase() === MIRROR_TARGET), true);
    console.log('4a. SECOND EXTENSION PAGE SAVE REFRESHES THE VISIBLE ADDRESS BOOK');

    const formOne = await beginAddress(page, CONCURRENT_ONE, 'concurrent one');
    const formTwo = await beginAddress(mirror, CONCURRENT_TWO, 'concurrent two');
    await Promise.all([
      formOne.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).click(),
      formTwo.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).click(),
    ]);
    await page.locator('.address-label', { hasText: 'concurrent one' }).waitFor();
    await page.locator('.address-label', { hasText: 'concurrent two' }).waitFor();
    contacts = await storedContacts(page);
    assert.equal(contacts.some((c) => c.address.toLowerCase() === CONCURRENT_ONE), true);
    assert.equal(contacts.some((c) => c.address.toLowerCase() === CONCURRENT_TWO), true);
    await mirror.close();
    console.log('4b. CONCURRENT CONTACT WRITES PRESERVE BOTH SEPARATE ADDRESSES');

    await openSend(page);
    await page.getByRole('button', { name: /ADDRESS BOOK/ }).click();
    await page.getByLabel('search address book').fill('picker exact');
    await page.locator('.contact-pick', { hasText: 'picker exact' }).click();
    assert.equal((await page.getByLabel('recipient address').inputValue()).toLowerCase(), PICKER_TARGET);
    await page.getByLabel('recipient address').fill('not-an-address');
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: '+ SAVE ADDRESS', exact: true }).count(), 0);
    await page.getByLabel('recipient address').fill(QUICK_OLD);
    await page.getByRole('button', { name: '+ SAVE ADDRESS', exact: true }).click();
    await page.locator('.contact-form .address-value', { hasText: QUICK_OLD }).waitFor();
    await page.getByLabel('recipient address').fill(QUICK_NEW);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.contact-form .address-value', { hasText: QUICK_OLD }).count(), 0);
    await page.getByRole('button', { name: '+ SAVE ADDRESS', exact: true }).click();
    await page.getByLabel('address label').fill('quick saved');
    await page.getByRole('button', { name: 'SAVE ADDRESS', exact: true }).click();
    await page.locator('.address-label', { hasText: 'quick saved' }).waitFor();
    contacts = await storedContacts(page);
    assert.equal(contacts.some((c) => c.address.toLowerCase() === QUICK_OLD), false);
    assert.equal(contacts.some((c) => c.address.toLowerCase() === QUICK_NEW), true);
    await saveShot(page, 'addressbook-send.png');
    console.log('5. SEND PICKER, INVALID QUICK-ADD GUARD, AND RETARGETED QUICK-ADD PASS');

    await page.getByLabel('recipient address').fill(LONG_LABEL_TARGET);
    await page.locator('.send-recipient .address-label', { hasText: LONG_LABEL }).waitFor();
    const sendLayout = await layoutSnapshot(page);
    assertLayoutFits(sendLayout, 'send long label');
    await saveShot(page, 'addressbook-long-label.png');
    await closeDrawer(page);

    await page.evaluate((to) => new Promise((resolve) => {
      chrome.storage.local.set({
        history: JSON.stringify([{
          hash: '0x' + '12'.repeat(32),
          chainId: 1,
          kind: 'send',
          to,
          ts: Date.now(),
          status: 'demo',
        }]),
      }, resolve);
    }), HISTORY_TARGET);
    await page.locator('.tabbar .tab', { hasText: 'ACTIVITY' }).click();
    await page.locator('.panel .address-label', { hasText: 'history vendor' }).waitFor();
    assert.equal((await page.locator('.panel .address-value', { hasText: HISTORY_TARGET }).count()) > 0, true);
    console.log('6. ACTIVITY HISTORY LABELS SAVED DESTINATIONS');

    const site = await ctx.newPage();
    await site.goto(`http://127.0.0.1:${DAPP_PORT}/`);
    let approvalP = ctx.waitForEvent('page', { timeout: 20000 });
    const accountsP = site.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' }));
    let approval = await approvalP;
    await approval.waitForSelector('text=SITE WANTS TO SEE YOU');
    await approval.getByRole('button', { name: 'CONNECT', exact: true }).click();
    const [from] = await accountsP;
    approvalP = ctx.waitForEvent('page', { timeout: 20000 });
    const txP = site.evaluate(({ from, to }) =>
      window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, value: '0x0' }] })
        .then(() => 'SENT')
        .catch((e) => `ERR:${e.code}:${e.message}`), { from, to: APPROVAL_TARGET });
    approval = await approvalP;
    await approval.waitForSelector('text=TRANSACTION INTENSIFIES');
    await approval.locator('.address-label', { hasText: 'approval vendor' }).waitFor();
    assert.equal((await approval.locator('.address-value', { hasText: APPROVAL_TARGET }).count()) > 0, true);
    await approval.close();
    assert.match(await txP, /^ERR:4001:/);
    await site.close();
    console.log('7. APPROVAL DESTINATION SHOWS THE ADDRESS BOOK LABEL WITHOUT SIGNING');

    const finalLayout = await layoutSnapshot(page);
    assertLayoutFits(finalLayout, 'address book final page');
    console.log('addressbook: all checks passed');
  } finally {
    await ctx.close().catch(() => {});
    dapp.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
