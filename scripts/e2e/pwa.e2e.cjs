const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const portfolio = require('./portfolio-helpers.cjs');
const PASSWORD = 'correct horse battery staple';
const SHORT_PASSWORD = 'hunter2hunter2';
/**
 * Choose a token on one side of the pair. The sides used to be <select>s; at
 * four hundred options they became a searchable sheet, so driving them means
 * open, search, click the row whose symbol matches exactly.
 */
async function pickToken(pg, side, symbol) {
  await pg.locator('.pairside').nth(side).click();
  await pg.waitForSelector('.drawerbox');
  await pg.fill('.drawerfilters input.search', symbol);
  await pg.waitForTimeout(250);
  await pg.locator('.pickrow')
    .filter({ has: pg.locator(`.tokname:text-is("${symbol}")`) })
    .first()
    .locator('.tokpick')
    .click();
  await pg.waitForSelector('.drawerbox', { state: 'detached' });
}

/**
 * One row of the asset list, by the token's exact name.
 *
 * The list is flat and value-sorted now, so an index is not a stable way to
 * name a row — the order is whatever the prices say that day.
 */
function assetRow(pg, name) {
  return pg.locator('.tokrow')
    .filter({ has: pg.locator(`.tokname:text-is("${name}")`) })
    .first();
}

/** which token a side is showing right now */
async function sideSymbol(pg, side) {
  return (await pg.locator('.pairside').nth(side).locator('.psym').textContent()).trim();
}

/** read the whole kv store the PWA persists into */
async function idbDump(pg) {
  return pg.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('radwallet', 1);
    r.onerror = () => rej(r.error || new Error('open failed'));
    r.onsuccess = () => {
      const st = r.result.transaction('kv', 'readonly').objectStore('kv');
      const k = st.getAllKeys(), v = st.getAll();
      k.onsuccess = () => { v.onsuccess = () => res(Object.fromEntries(k.result.map((x, i) => [x, v.result[i]]))); };
      k.onerror = () => rej(k.error);
    };
  }));
}

/** overwrite one key with something that will not parse */
async function idbCorrupt(pg, key) {
  return pg.evaluate((k) => new Promise((res, rej) => {
    const r = indexedDB.open('radwallet', 1);
    r.onerror = () => rej(r.error || new Error('open failed'));
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put('{ this is not a vault', k);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    };
  }), key);
}

async function horizontalLayout(pg) {
  return pg.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
}

function assertNoHorizontalScroll(layout, label) {
  if (layout.html > layout.viewport + 1 || layout.body > layout.viewport + 1) {
    throw new Error(`${label} scrolls horizontally: ${JSON.stringify(layout)}`);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chromium', executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 }, deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE ERR:', m.text().slice(0,200)); });
  const out = require('path').resolve(__dirname, '../../design/app-shots') + '';
  require('fs').mkdirSync(out, { recursive: true });
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
  /**
   * Visual proof must never become a second copy of a wallet secret. The demo
   * creates a real BIP-39 phrase, so replace only the rendered words immediately
   * before a screenshot. Preact still owns the real state and restores it on the
   * next render; the test can continue through the actual backup acknowledgement.
   */
  const redactSeedForScreenshot = () => page.evaluate(() => {
    const box = document.querySelector('.seedbox');
    if (!box) return 0;
    const words = [...box.querySelectorAll('span')];
    for (const [index, word] of words.entries()) {
      const number = document.createElement('b');
      number.textContent = String(index + 1);
      word.replaceChildren(number, document.createTextNode(' •••• '));
      word.setAttribute('aria-label', `seed word ${index + 1} hidden for screenshot`);
    }
    box.setAttribute('data-screenshot-redacted', 'true');
    return words.length;
  });

  await page.goto('file://' + require('path').resolve(__dirname, '../../apps/wallet/dist-demo/index.html') + '');
  await page.waitForTimeout(600);
  await shot('01-welcome');

  // create wallet
  await page.click('text=MAKE A NEW WALLET');
  // a password manager can only see a real form. These fields used to be loose
  // inputs on a screen that never submits and never navigates, which is why
  // Firefox never offered to save the wallet password (verified in real
  // Firefox: the save-login prompt fires for a moz-extension:// page with a
  // form and never fires without one).
  console.log('PASSWORD FIELDS ARE A FORM:', JSON.stringify(await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type=password]')];
    return {
      forms: document.forms.length,
      fields: inputs.map((i) => ({ name: i.name, inForm: !!i.form, autocomplete: i.autocomplete })),
    };
  })));
  await page.fill('input[placeholder="password"]', SHORT_PASSWORD);
  await page.fill('input[placeholder="password again"]', SHORT_PASSWORD);
  await page.waitForTimeout(100);
  const shortPw = await page.evaluate(() => ({
    disabled: document.querySelector('button[type=submit]')?.disabled,
    guidance: document.body.innerText.includes('16+ characters'),
    seed: !!document.querySelector('.seedbox'),
  }));
  console.log('SHORT VAULT PASSWORD REFUSED:', JSON.stringify(shortPw));
  if (!shortPw.disabled || !shortPw.guidance || shortPw.seed) {
    throw new Error('new wallet accepted or under-explained a short password');
  }
  await page.fill('input[placeholder="password"]', PASSWORD);
  await page.fill('input[placeholder="password again"]', PASSWORD);
  await page.click('text=GENERATE SEED');
  try {
    await page.waitForSelector('.seedbox', { timeout: 30000 });
  } catch (e) {
    await redactSeedForScreenshot();
    await shot('fail-seed');
    console.log('BODY:', (await page.textContent('body')).slice(0,400));
    throw e;
  }
  const seed = await page.textContent('.seedbox');
  const seedWords = seed.replace(/\d+/g, ' ').trim().split(/\s+/);
  console.log('SEED WORDS:', seedWords.length);
  const redactedWords = await redactSeedForScreenshot();
  const screenshotText = (await page.textContent('.seedbox')) || '';
  if (redactedWords !== 12 || seedWords.some((word) => screenshotText.includes(word))) {
    throw new Error('seed screenshot was not fully redacted');
  }
  const redactedSeedLayout = await horizontalLayout(page);
  assertNoHorizontalScroll(redactedSeedLayout, 'redacted seed screen');
  await shot('02-seed');
  await page.click('label.row input[type=checkbox]');
  await page.click('text=ENTER THE WEBRING');
  await page.waitForSelector('.balance .big');
  await page.waitForTimeout(400);
  console.log('BALANCE:', await page.textContent('.balance .big'));
  await page.setViewportSize({ width: 372, height: 600 });
  await portfolio.assertWalletHeaderVisible(page, 'PWA wallet at popup size');
  await shot('header-wallet-pwa-popup');
  await portfolio.openPortfolio(page);
  await portfolio.assertWalletHeaderVisible(page, 'PWA portfolio at popup size');
  await page.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await portfolio.assertWalletHeaderVisible(page, 'PWA wallet after returning from portfolio');
  await page.setViewportSize({ width: 520, height: 900 });
  await portfolio.assertWalletHeaderVisible(page, 'PWA wallet at docked size');
  await shot('header-wallet-pwa-docked');
  await page.setViewportSize({ width: 390, height: 780 });

  // Chrome's wallet popup is commonly 372px wide. Invisible tooltip boxes
  // and min-content-sized selects can widen the scroll canvas even when every
  // visible element appears to fit, so measure both scroll roots directly.
  await page.setViewportSize({ width: 372, height: 780 });
  await page.waitForTimeout(150);
  const narrowHome = await horizontalLayout(page);
  assertNoHorizontalScroll(narrowHome, '372px home');
  console.log('NARROW HOME HAS NO HORIZONTAL SCROLL:', JSON.stringify(narrowHome));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(150);

  // the address is the copy button: it must copy the WHOLE address, not the
  // truncation it displays
  const addrBtn = await page.textContent('.balance .addrcopy');
  await page.click('.balance .addrcopy');
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  console.log('ADDRESS COPIES ON CLICK:', clip.length === 42 && clip.startsWith('0x'),
    '| shows', addrBtn.trim(), '| copied', clip.slice(0, 6) + '…' + clip.slice(-4));

  // an asset row opens its own sheet: price, and the two things you can do
  await assetRow(page, 'Radcoin').locator('.tokpick').click();
  await page.waitForSelector('.assethead');
  await page.waitForTimeout(500);
  console.log('ASSET SHEET:', JSON.stringify(await page.evaluate(() => ({
    title: document.querySelector('.drawerhead .simhead')?.textContent,
    price: document.querySelector('.pricebox .pval')?.textContent,
    actions: [...document.querySelectorAll('.drawerfoot .btn')].map((x) => x.textContent),
    chartExplained: (document.querySelector('.chartnote')?.textContent ?? '').includes('past blocks'),
  }))));
  // the asset sheet links out too: the chain name to YOUR address there, the
  // contract to the contract. Native ETH has no contract and must not pretend.
  // THE CHART EMBEDS NOBODY UNTIL ASKED. An iframe runs a third party's code
  // inside the wallet, so merely opening an asset must not create one — the
  // offer is a button, and the button names the host it would contact.
  console.log('ASSET SHEET EMBEDS NOBODY ON OPEN:',
    await page.locator('.drawerbox iframe').count() === 0);
  const loadChart = page.locator('button:has-text("LOAD THE CHART")');
  console.log('   chart is offered, and names the host:',
    ((await loadChart.textContent().catch(() => '')) || '').trim());
  // ONE link here, and it is about the asset. Your own address on the explorer
  // belongs on HOME next to each chain, not repeated inside every token sheet.
  console.log('ASSET SHEET LINKS:', JSON.stringify(
    await page.locator('.assethead a.exlink').evaluateAll((as) => as.map((a) => {
      const u = new URL(a.href);
      return `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{40}/, '<addr>')}`;
    }))));
  console.log('   no wallet-address link in an asset sheet:',
    (await page.locator('.assethead a.exlink').evaluateAll(
      (as) => as.every((a) => !new URL(a.href).pathname.startsWith('/address/')))));
  await page.click('.drawerfoot .btn.ghost');   // SEND, carrying the asset
  await page.waitForTimeout(400);
  console.log('ASSET -> SEND CARRIES IT:',
    (await page.textContent('body')).includes('$RAD'));
  // SEND is a sheet now, so it closes the way every other sheet does. It used
  // to be a screen carrying its own "\u2190 back" while SWAP — the next tile
  // along — had none: same shape, two ways out.
  await page.click('.drawerhead .x');
  await page.waitForTimeout(250);
  // native ETH: no contract to link, and it says so instead of guessing
  await assetRow(page, 'Ether').locator('.tokpick').click();
  await page.waitForSelector('.assethead');
  await page.waitForTimeout(300);
  console.log('NATIVE HAS NO CONTRACT LINK:',
    (await page.textContent('.assethead')).includes('native, no contract'),
    '| and offers no link to guess at:', await page.locator('.assethead a.exlink').count() === 0);
  await page.click('.drawerhead .x');
  await page.waitForTimeout(200);

  // COLLECTIBLES ARE NOT ON HOME. They used to be listed among the token rows,
  // which is a row you cannot compare with the row above it in a list sorted by
  // value. HOME carries one line pointing at the tab that holds them.
  console.log('NO NFT ROWS ON HOME:', await page.locator('.content > .nftrow').count() === 0,
    '| one line points at them:', (await page.textContent('.nftlink')).trim());
  await page.click('.nftlink');
  await page.waitForSelector('.nftrow');

  // an NFT links to its collection, and each id to that exact token — the two
  // explorer families disagree on the path, so this is per chain
  await page.click('.nftrow >> nth=0');
  await page.waitForSelector('.nftmeta');
  await page.waitForTimeout(300);
  console.log('NFT SHEET LINKS:', JSON.stringify(
    await page.locator('.drawerbox a.exlink').evaluateAll((as) => as.slice(0, 3).map((a) => {
      const u = new URL(a.href);
      return `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{40}/, '<addr>')}`;
    }))));
  await page.click('.drawerhead .x');
  await page.waitForTimeout(200);
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForSelector('.tokrow');

  console.log('BLOCK:', await page.textContent('.lcd'));
  // the chain lives on the row's icon as a badge now, not in a heading above a
  // block of rows — which is how every multi-chain wallet answers "which chain
  // is this one on" without spending a line of width on it
  console.log('CHAIN BADGES ON ROWS:', await page.locator('.tokrow .chainbadge .chainicon').count(),
    'of', await page.locator('.tokrow').count(), 'rows');
  // ONE explorer link, and it is about YOUR ADDRESS, so it sits beside the
  // address. It used to be repeated on every chain heading. It follows the
  // network filter: the tx links and the address links must be the same
  // explorer, or you land on the wrong network and it looks like an empty wallet.
  const who = (await page.textContent('.balance .addrcopy')).trim();
  const exHref = async () => {
    const u = new URL(await page.getAttribute('.balance .addrex', 'href'));
    return `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{40}/, '<addr>')}`;
  };
  const onEthEx = await exHref();
  await page.selectOption('.listbar .netsel', '8453');
  await page.waitForTimeout(300);
  const onBaseEx = await exHref();
  console.log('ADDRESS LINK FOLLOWS THE FILTER:', onEthEx, '->', onBaseEx,
    '| different explorer:', onEthEx !== onBaseEx);
  console.log('   opens in a new tab, carries the whole address:',
    await page.locator('.balance .addrex').evaluate(
      (a, short) => a.target === '_blank' && /\/0x[0-9a-fA-F]{40}$/.test(a.href)
        && a.href.toLowerCase().includes(short.slice(0, 6).toLowerCase()), who));

  // ---- the network is a FILTER, not a claim about the whole list -----------
  // It used to sit in the account bar and name ONE chain while the list under
  // it showed three, which is a bad thing for a header to say a scroll above a
  // SIGN button.
  const rowNames = () => page.locator('.tokrow .tokname').allTextContents();
  const baseOnly = await rowNames();
  // filtered to one network, the chain word on every row would be the same
  // word N times — the badge on the icon still carries it
  const wordWhenFiltered = await page.locator('.tokrow .tokchain').count();
  await page.selectOption('.listbar .netsel', 'all');
  await page.waitForTimeout(300);
  const allNames = await rowNames();
  const allChains = [...new Set(await page.locator('.tokrow .tokchain').allTextContents())];
  console.log('NETWORK FILTERS THE LIST:',
    'base only ->', JSON.stringify(baseOnly),
    '| all ->', JSON.stringify(allNames));
  console.log('   chains spelled out only while the list spans more than one:',
    wordWhenFiltered === 0, JSON.stringify(allChains));
  if (baseOnly.length >= allNames.length) throw new Error('filtering by Base did not narrow the list');
  if (allChains.length < 2) throw new Error('"all networks" showed only one chain');
  // WHAT EACH ROW IS WORTH. The per-asset figure comes from the same pool
  // quotes the total is built from — no price API — so the rows must add up to
  // the fiat total rather than being a second, independent number.
  const priced = await page.locator('.tokrow').evaluateAll((rs) => rs.map((r) => ({
    name: r.querySelector('.tokname')?.textContent,
    // the value leads the row now and the token amount sits under it: the
    // list is ordered by value, so the number the order is built from is the
    // one that gets read first
    usd: r.querySelector('.tokusd') ? r.querySelector('.amtnum')?.textContent : null,
  })).filter((x) => x.usd));
  console.log('PER-ASSET USD:', JSON.stringify(priced));
  const sum = priced.reduce((t, r) => t + Number(r.usd.replace(/[^0-9.]/g, '')), 0);
  // THE HEADLINE IS THE DOLLAR FIGURE. Not a price API: the rate is a QuoterV2
  // read of a USDC pool on the wallet's own RPC, taken at one ether — so the
  // rows have to add up to it rather than being a second, independent number.
  const fiat = Number((await page.textContent('.balance .big')).replace(/[$,]/g, ''));
  console.log('   rows sum to the headline:', Math.abs(sum - fiat) < 2, `(${sum.toFixed(2)} vs ${fiat})`);
  console.log('   ether is the sub-line:', (await page.textContent('.balance .native')).trim());

  // BIGGEST FIRST. A block per chain in scan order put the largest holding
  // below the fold whenever it was not on Ethereum.
  const order = priced.map((r) => Number(r.usd.replace(/[^0-9.]/g, '')));
  const sorted = order.every((v, i) => i === 0 || order[i - 1] >= v);
  console.log('LIST IS VALUE-SORTED:', sorted, JSON.stringify(order));
  if (!sorted) throw new Error('asset list is not sorted by value');

  await shot('03-home');

  // send + simulate
  await page.click('.actions .tile >> text=SEND');
  const sendOptions = await page.locator('.assetpick option').allTextContents();
  console.log('SEND ASSETS:', JSON.stringify(sendOptions));
  await page.fill('input[placeholder="0x… or name.eth"]', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.fill('input[placeholder="amount in ETH"]', '0.1');
  await page.click('text=SIMULATE FIRST (ALWAYS)');
  await page.waitForSelector('.panel .hd:has-text("TRANSACTION PREVIEW")', { timeout: 15000 });
  await shot('04-send-sim');
  console.log('SIM GAS ROW:', (await page.textContent('.panel')).includes('GAS'));

  // ERC-20 sends use the token contract as the tx target and preserve its
  // decimals; the user still sees the asset transfer, not raw calldata.
  await page.click('text=REFUSE');
  const radOption = await page.locator('.assetpick option', { hasText: '$RAD' }).getAttribute('value');
  await page.selectOption('.assetpick', radOption);
  await page.fill('input[placeholder="0x… or name.eth"]', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.fill('input[placeholder="amount in $RAD"]', '42.5');
  await page.click('text=SIMULATE FIRST (ALWAYS)');
  await page.waitForSelector('.panel .hd:has-text("TRANSACTION PREVIEW")');
  console.log('ERC20 SEND PREVIEW:', (await page.textContent('.panel')).includes('$RAD'));

  // Known token ids can be sent as ERC-721 safeTransferFrom calls. There is no
  // fungible amount field because the selected item itself is the amount.
  await page.click('text=REFUSE');
  const nftOption = await page.locator('.assetpick option', { hasText: 'Bored Ape Yacht Club #1' }).getAttribute('value');
  await page.selectOption('.assetpick', nftOption);
  await page.fill('input[placeholder="0x… or name.eth"]', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  console.log('NFT SEND HAS NO AMOUNT FIELD:', await page.locator('input[placeholder^="amount in"]').count() === 0);
  await page.click('text=SIMULATE FIRST (ALWAYS)');
  await page.waitForSelector('.panel .hd:has-text("TRANSACTION PREVIEW")');
  console.log('NFT SEND PREVIEW:', (await page.textContent('.panel')).includes('BAYC #1'));

  // ---- SETTINGS IS AN INDEX, NOT ONE SCROLL --------------------------------
  // It used to be 500 lines of four different kinds of thing at once: the
  // manifesto, ordinary preferences, per-chain network config, and the three
  // toggles that are the only settings here that make privacy WORSE — with the
  // text-size slider sitting between two of them.
  await page.click('text=REFUSE');
  await page.click('.drawerhead .x');
  await page.waitForTimeout(250);
  const seededScroll = await page.evaluate(() => {
    document.querySelector('#app').style.minHeight = '1600px';
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    return document.scrollingElement.scrollTop;
  });
  if (seededScroll <= 0) throw new Error('scroll-reset check could not seed body scroll');
  await page.click('.tabbar .tab >> text=SETTINGS');
  await page.waitForSelector('.setlist');
  const settingsViewport = await page.evaluate(() => ({
    scrollTop: document.scrollingElement.scrollTop,
    titleTop: document.querySelector('h1')?.getBoundingClientRect().top,
  }));
  await page.evaluate(() => { document.querySelector('#app').style.minHeight = ''; });
  if (settingsViewport.scrollTop !== 0 || settingsViewport.titleTop < 0) {
    throw new Error(`SETTINGS opened above the viewport: ${JSON.stringify(settingsViewport)}`);
  }
  if (await page.locator('h1:text-is("SETTINGS")').count() !== 1) {
    throw new Error('SETTINGS title is not exposed as the screen heading');
  }
  const settingsIndexRows = await page.locator('.setrowlink .slt').allTextContents();
  console.log('SETTINGS INDEX:', JSON.stringify(settingsIndexRows));
  for (const name of ['SECURITY', 'NETWORKS', 'PRIVACY', 'CONNECTED SITES', 'DISPLAY', 'ABOUT']) {
    if (!settingsIndexRows.includes(name)) throw new Error(`SETTINGS omits ${name}`);
  }
  console.log('   each row says where it stands:', JSON.stringify(
    await page.locator('.setrowlink .slh').allTextContents()));
  if (await page.locator('.panel.guarantees').count() !== 0) {
    throw new Error('settings index puts repeated product facts before its controls');
  }
  const section = async (name) => {
    await page.click(`.setrowlink:has-text("${name}")`);
    await page.waitForSelector('.sectback');
    await page.waitForTimeout(200);
  };
  const backToIndex = async () => {
    await page.click('.sectback');
    await page.waitForSelector('.setlist');
    await page.waitForTimeout(150);
  };

  if (await page.locator('.toast').isVisible().catch(() => false)) await page.click('.toast');
  await page.screenshot({ path: `${out}/05b-settings-index.png`, fullPage: true });
  await section('SECURITY');
  if (await page.locator('input[type=checkbox]').count() !== 0) {
    throw new Error('security exposes an ineffective simulation preference in the demo');
  }
  await shot('05c-settings-security');
  await backToIndex();

  // a toggle may be disabled when the platform genuinely cannot do it (Tor
  // needs the extension), but it has to say so rather than just sit there dead
  await section('NETWORKS');
  if (await page.locator('label.row', { hasText: 'Rotate RPC per wallet' }).count() !== 0) {
    throw new Error('networks still exposes an ineffective RPC rotation preference');
  }
  const dead = page.locator('label.row:has(input:disabled)');
  const deadCount = await dead.count();
  let allExplained = true;
  for (let i = 0; i < deadCount; i++) {
    const t = await dead.nth(i).textContent();
    if (!/only|no proxy API/i.test(t)) allExplained = false;
  }
  console.log('NETWORKS SECTION:', await page.locator('input[type=checkbox]').count(),
    'toggles,', deadCount, 'unavailable here and explained:', allExplained,
    '| node line:', (await page.textContent('.privline')).trim());
  const zoomAt = async () => page.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim() || '1');
  const beforeZoom = await zoomAt();
  await backToIndex();
  await section('DISPLAY');
  await page.locator('.scalerow .slider').evaluate((el) => {
    el.value = '180';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 372, height: 780 });
  await page.waitForTimeout(150);
  const largeTextLayout = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.body.scrollWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
    tabs: [...document.querySelectorAll('.tabbar .tab')].map((tab) => {
      const r = tab.getBoundingClientRect();
      return {
        text: tab.textContent.trim(), left: r.left, right: r.right,
        top: r.top, bottom: r.bottom, height: r.height,
      };
    }),
  }));
  if (largeTextLayout.scrollWidth > largeTextLayout.viewport.width + 1
    || largeTextLayout.htmlScrollWidth > largeTextLayout.viewport.width + 1
    || largeTextLayout.tabs.some((tab) => tab.left < -1
      || tab.right > largeTextLayout.viewport.width + 1
      || tab.top < -1 || tab.bottom > largeTextLayout.viewport.height + 1)) {
    throw new Error(`180% text does not reflow in the viewport: ${JSON.stringify(largeTextLayout)}`);
  }
  // the slider is a MULTIPLIER on a 1.2 base, so 100% renders at 1.2 and
  // 180% at 2.16 — the largest setting must still reflow in a phone viewport
  console.log('TEXT SIZE SLIDER: base', beforeZoom, '->', await zoomAt(),
    '| label', await page.textContent('.scaleval'), '| layout', JSON.stringify(largeTextLayout));
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForSelector('.balance .big');
  await page.waitForTimeout(200);
  const largeHomeLayout = await horizontalLayout(page);
  assertNoHorizontalScroll(largeHomeLayout, '372px home at 180% text');
  console.log('LARGE NARROW HOME HAS NO HORIZONTAL SCROLL:', JSON.stringify(largeHomeLayout));
  const homeTabBounds = await page.locator('.tabbar .tab').evaluateAll((tabs) => tabs.map((tab) => {
    const r = tab.getBoundingClientRect();
    return { text: tab.textContent.trim(), top: r.top, bottom: r.bottom };
  }));
  const viewportHeight = page.viewportSize().height;
  if (homeTabBounds.some((tab) => tab.top < -1 || tab.bottom > viewportHeight + 1)) {
    throw new Error(`180% home navigation is outside the viewport: ${JSON.stringify(homeTabBounds)}`);
  }
  if (await page.locator('.toast').isVisible().catch(() => false)) {
    await page.click('.toast');
    await page.waitForSelector('.toast', { state: 'detached' });
  }
  await shot('05a-home-180');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(150);
  await page.click('.tabbar .tab >> text=SETTINGS');
  await page.waitForSelector('.setlist');
  await section('DISPLAY');
  await page.click('.scalerow .act');  // reset
  await page.waitForTimeout(200);
  await backToIndex();

  // Every persistent external-service opt-in must be represented here,
  // including the artwork preference also available from an NFT collection.
  await section('PRIVACY');
  if (await page.locator('.indexerbox').count() !== 5) {
    throw new Error('privacy settings omit an external-service preference');
  }
  const artPreference = page.locator('label.row', { hasText: 'Always load NFT artwork' }).locator('input');
  await artPreference.check();
  await page.waitForFunction(() => document.querySelector('label.row:has(input:checked)') !== null);
  // Persistence is asynchronous; wait for the store to reflect the control.
  for (let i = 0; i < 20; i++) {
    const saved = await idbDump(page);
    if (JSON.parse(saved.prefs || '{}').loadArt === true) break;
    await page.waitForTimeout(100);
  }
  if (JSON.parse((await idbDump(page)).prefs || '{}').loadArt !== true) {
    throw new Error('artwork preference did not persist from privacy settings');
  }
  await backToIndex();
  if (!(await page.locator('.setrowlink', { hasText: 'PRIVACY' }).textContent()).includes('1 of 5')) {
    throw new Error('privacy summary does not count automatic NFT artwork');
  }
  await section('PRIVACY');
  await page.locator('label.row', { hasText: 'Always load NFT artwork' }).locator('input').uncheck();
  await page.setViewportSize({ width: 372, height: 780 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/05d-settings-privacy.png`, fullPage: true });
  const privacyLayout = await horizontalLayout(page);
  if (privacyLayout.html > 373 || privacyLayout.body > 373) {
    console.log('PRIVACY OVERFLOW ELEMENTS:', await page.locator('.content *').evaluateAll((els) => els
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({ tag: el.tagName, cls: el.className, text: el.textContent.slice(0, 100), width: el.clientWidth, scroll: el.scrollWidth }))));
  }
  assertNoHorizontalScroll(privacyLayout, '372px privacy settings');
  await page.setViewportSize({ width: 390, height: 780 });
  console.log('PRIVACY ARTWORK PREFERENCE: persists and counts in the settings summary');
  console.log('LEAKS ARE GROUPED:', await page.locator('.indexerbox').count(),
    'trades, each naming what it hands over:',
    (await page.locator('.indexerbox .leak').allTextContents())
      .every((t) => t.includes('WHAT IS SHARED')));
  const dexRow = page.locator('label.row', { hasText: 'embedded DEX chart' });
  console.log('DEX CHART TOGGLE:', await dexRow.count() === 1,
    '| off by default:', !(await dexRow.locator('input').isChecked()),
    '| explains embedded third-party content:',
    (await page.locator('.indexerbox', { hasText: 'embedded DEX chart' }).textContent())
      .includes('embedded page'));

  // ---- the indexer: several providers, named, rotated -----------------------
  // It used to be one hardcoded provider behind an unlabelled "API key" box, so
  // you could not tell who you were about to hand your address list to.
  const idx = page.locator('.indexerbox').first();
  await idx.locator('input[type=checkbox]').check();
  await page.waitForTimeout(200);
  console.log('INDEXER PROVIDERS OFFERED:', JSON.stringify(
    await idx.locator('select option').allTextContents()));
  console.log('   nothing contacted until one is added:',
    await idx.locator('text=No provider configured').isVisible());
  // the keyless one needs no key field at all
  await idx.locator('select').selectOption('blockscout');
  await page.waitForTimeout(150);
  console.log('   keyless provider asks for no key:',
    (await idx.locator('input.field').count()) === 0);
  await idx.locator('button:has-text("ADD PROVIDER")').click();
  await page.waitForTimeout(200);
  // one that needs a key is refused without one, rather than added broken
  await idx.locator('select').selectOption('alchemy');
  await page.waitForTimeout(150);
  await idx.locator('button:has-text("ADD PROVIDER")').click();
  await page.waitForTimeout(250);
  console.log('   keyed provider refused with no key:',
    (await idx.locator('.rpcrow').count()) === 1,
    '| toast:', (await page.textContent('.toast').catch(() => '')) || 'none');
  await idx.locator('input.field').fill('supersecretkey123');
  await idx.locator('button:has-text("ADD PROVIDER")').click();
  await page.waitForTimeout(250);
  const rows = await idx.locator('.rpcrow .ep').allTextContents();
  console.log('   configured:', JSON.stringify(rows.map((r) => r.replace(/\s+/g, ' ').trim())));
  console.log('   key is masked, never shown whole:',
    rows.join(' ').includes('supe…y123') && !rows.join(' ').includes('supersecretkey123'));
  console.log('   rotation stated:',
    (await idx.textContent()).includes('Rotated per request across 2 providers'));
  // leave it as we found it
  await idx.locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(200);

  // ---- RPC pools: every chain, not just the one you are switched to ---------
  await backToIndex();
  await section('NETWORKS');
  const rpc = page.locator('.panel', { hasText: 'RPC POOL' });
  const eps = async () => rpc.locator('.rpcrow .ep').allTextContents();
  // the panel opens on whichever chain the wallet is switched to, so say which
  // one we mean rather than assuming
  await rpc.locator('select').selectOption('1');
  await page.waitForTimeout(200);
  const onEth = await eps();
  await rpc.locator('select').selectOption('8453');
  await page.waitForTimeout(200);
  const onBase = await eps();
  console.log('RPC POOL IS PER CHAIN: ethereum', onEth.length, 'vs base', onBase.length,
    '| different lists:', JSON.stringify(onEth) !== JSON.stringify(onBase));
  console.log('   base pool:', JSON.stringify(onBase));
  // and editing one does not touch the other
  await rpc.locator('input.field').fill('https://base.example.invalid');
  await rpc.locator('button:has-text("ADD")').click();
  await page.waitForTimeout(200);
  const baseAfter = await eps();
  await rpc.locator('select').selectOption('1');
  await page.waitForTimeout(200);
  console.log('   edit lands on the chosen chain only:',
    baseAfter.length === onBase.length + 1,
    '| ethereum untouched:', JSON.stringify(await eps()) === JSON.stringify(onEth));
  await shot('05-privacy');

  await page.click('.tabbar .tab >> text=HOME');   // leave SETTINGS — the bar is the way back
  await page.waitForSelector('.tokrow');

  // SWAP FOLLOWS THE ASSET. Opening SWAP from a Base token used to show an
  // Ethereum swap page — the screen read the wallet's chain and nothing set it.
  await page.selectOption('.listbar .netsel', '8453');
  await page.waitForTimeout(300);
  await assetRow(page, 'USD Coin').locator('.tokpick').click();
  await page.waitForSelector('.assethead');
  await page.waitForTimeout(300);
  await page.click('.drawerfoot .btn:not(.ghost)');   // SWAP
  await page.waitForSelector('.swaphead');
  await page.waitForTimeout(500);
  console.log('SWAP FOLLOWS THE ASSET:',
    'chain', await page.locator('.swaphead .netsel').inputValue(),
    '| from', await sideSymbol(page, 0),
    '| chains offered', JSON.stringify(await page.locator('.swaphead option').allTextContents()));
  // and back to Ethereum, so what follows tests the mainnet house pair rather
  // than whichever chain the previous check left us on
  await page.locator('.swaphead .netsel').selectOption('1');
  await page.waitForTimeout(400);
  console.log('   chain picker switches in place:',
    await page.locator('.swaphead .netsel').inputValue(),
    '| pair re-chosen for it:', await sideSymbol(page, 0));
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForTimeout(300);
  await page.selectOption('.listbar .netsel', 'all');
  await page.waitForTimeout(300);

  // swap
  await page.click('.actions .tile >> text=SWAP');
  await page.waitForSelector('text=RADSWAP');
  await page.waitForSelector('.pairbox');
  await page.waitForTimeout(900); // debounce
  if (await page.locator('h1:text-is("RADSWAP")').count() !== 1) {
    throw new Error('RADSWAP title is not exposed as the screen heading');
  }
  await page.waitForSelector('.pairbox');
  await page.waitForTimeout(900);
  const swapReadability = await page.evaluate(() => ({
    symbols: [...document.querySelectorAll('.pairside .psym')].map((el) => ({
      text: el.textContent.trim(), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
    })),
    targets: [...document.querySelectorAll('.flip, .pctrow .pct, .setrow input.num')].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.textContent.trim() || el.value, width: r.width, height: r.height };
    }),
  }));
  if (swapReadability.symbols.some((symbol) => symbol.text === '$…' || symbol.scrollWidth > symbol.clientWidth + 1)) {
    throw new Error(`swap destination is clipped: ${JSON.stringify(swapReadability.symbols)}`);
  }
  if (swapReadability.targets.some((target) => target.width < 44 || target.height < 44)) {
    throw new Error(`swap targets smaller than 44px: ${JSON.stringify(swapReadability.targets)}`);
  }
  const swapBody = await page.textContent('body');
  // SWAP is offered on every asset row, so it has to quote more than one pair
  // ---- the token picker ----------------------------------------------------
  // A <select> of four hundred options has no search, no icons, no balances and
  // no way to tell two same-symbol tokens apart. Each side opens a sheet now.
  await page.locator('.pairside').nth(1).click();
  await page.waitForSelector('.drawerbox');
  await page.waitForTimeout(300);
  const buyCount = Number(await page.locator('.drawerhead .count').textContent());
  await page.fill('.drawerfilters input.search', '$RAD');
  const radBuyRows = await page.locator('.pickrow .tokname:text-is("$RAD")').count();
  if (radBuyRows !== 1) throw new Error(`BUY picker exposes ${radBuyRows} canonical $RAD rows`);
  await page.fill('.drawerfilters input.search', '');
  console.log('TOKEN PICKER:', buyCount, 'tokens |',
    await page.locator('.pickrow').count(), 'rows rendered |',
    'icons:', await page.locator('.pickrow .asseticon').count(),
    '| capped honestly:', ((await page.locator('.drawerbody .note').last().textContent()) || '').trim());
  // each row links to the two places that can tell you what a token actually is
  console.log('   row links:', JSON.stringify(
    await page.locator('.pickrow').nth(2).locator('a.exlink').evaluateAll((as) => as.map((a) => {
      const u = new URL(a.href);
      return `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{40}/, '<token>')}`;
    }))));
  // search narrows by symbol AND by the thing that is actually unique
  await page.fill('.drawerfilters input.search', 'wrapped bitcoin');
  await page.waitForTimeout(250);
  console.log('   search by name   :', await page.locator('.pickrow').count(), 'row(s)');
  await page.fill('.drawerfilters input.search', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599');
  await page.waitForTimeout(250);
  console.log('   search by address:', await page.locator('.pickrow').count(), 'row(s):',
    await page.locator('.pickrow .tokname').first().textContent());
  await page.fill('.drawerfilters input.search', 'zzzznothing');
  await page.waitForTimeout(250);
  console.log('   no match says so :', await page.locator('.drawerbody .empty').isVisible());
  await shot('06b-tokenpick');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawerbox', { state: 'detached' });
  console.log('   esc closes it, pair unchanged:', await sideSymbol(page, 1));

  await page.locator('.pairside').nth(0).click();
  await page.waitForSelector('.drawerbox');
  await page.waitForTimeout(250);
  // the SELL side is what you HOLD, and it shows the balance next to each row
  const sellCount = Number(await page.locator('.drawerhead .count').textContent());
  await page.fill('.drawerfilters input.search', '$RAD');
  const radSellRows = await page.locator('.pickrow .tokname:text-is("$RAD")').count();
  if (radSellRows !== 1) throw new Error(`SELL picker exposes ${radSellRows} canonical $RAD rows`);
  console.log('   sell side shows balances:', JSON.stringify(
    await page.locator('.pickrow .amt').allTextContents()));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawerbox', { state: 'detached' });

  const pair = {
    sellable: sellCount, buyable: buyCount,
    from: await sideSymbol(page, 0), to: await sideSymbol(page, 1),
  };
  console.log('SWAP PAIRS:', pair.from, '->', pair.to,
    '| can sell', pair.sellable, '| can buy', pair.buyable);
  console.log('SWAP QUOTE SHOWN:', /10,842/.test(swapBody),
    '| MIN OUT ROW:', swapBody.includes('Minimum you receive'),
    // the claim, not how it is implemented: "no fee address in this codebase"
    // is a fact about our source tree, which is not what a swap screen is for
    '| ZERO FEE STATED:', /Wallet fee\s*0%/.test(swapBody),
    '| YOU PAY CARRIES ITS UNIT:', await page.locator('.payrow .unit').textContent());
  // and the two sides can never be the same token
  await pickToken(page, 1, pair.from);
  await page.waitForTimeout(300);
  const after = `${await sideSymbol(page, 0)}->${await sideSymbol(page, 1)}`;
  console.log('SWAP REFUSES A SELF-PAIR:', !after.split('->').every((x, _, a) => x === a[0]), after);
  await shot('06-swap');

  // receive + QR
  await page.click('.tabbar .tab >> text=HOME');
  await page.click('.actions .tile >> text=RECEIVE');
  await page.waitForSelector('img.qr');
  const qrSrc = await page.getAttribute('img.qr', 'src');
  console.log('QR RENDERED:', qrSrc.startsWith('data:image/svg'));
  await shot('08-receive-qr');

  // stealth: meta-address shown on receive; scan button present
  const stealthShown = await page.isVisible('text=STEALTH RECEIVE · ETHEREUM');
  const meta = await page.textContent('.panel:has-text("STEALTH RECEIVE") .addr');
  if (!stealthShown || !/^st:eth:0x[0-9a-f]{132}$/.test((meta || '').trim())) {
    throw new Error('seed wallet receive screen omitted its Ethereum stealth address');
  }
  console.log('STEALTH META SHOWN:', true, '| Ethereum scope and valid address shown');

  // network webring + activity screen
  await page.click('.drawerhead .x'); // leave RECEIVE
  await page.waitForTimeout(250);
  // the filter lists every registered chain plus "all networks" — the titlebar
  // used to carry a hardcoded "Ethereum" that lied on every other chain
  const chains = await page.locator('.listbar .netsel option').allTextContents();
  console.log('NET DROPDOWN:', JSON.stringify(chains),
    '| titlebar claims no chain:', !(await page.textContent('.titlebar')).includes('Ethereum'));
  console.log('   grouped:', JSON.stringify(
    await page.locator('.listbar .netsel optgroup').evaluateAll((gs) => gs.map((g) => g.label))));

  // ---- testnets are switchable, but their money is not money ---------------
  // Selecting one must not quietly start showing play-money balances: that is
  // what the SETTINGS toggle is for, and the screen says so instead of just
  // going blank.
  const headline = () => page.locator('.balance .big span').textContent();
  const beforeTestnet = await headline();
  await page.selectOption('.listbar .netsel', '11155111');
  await page.waitForTimeout(400);
  console.log('TESTNET SELECTED, TOTAL UNMOVED:', (await headline()) === beforeTestnet,
    '| says why it is empty:', await page.isVisible('text=testnet balances stay hidden'));
  await page.selectOption('.listbar .netsel', 'all');
  await page.waitForTimeout(300);

  // turn them on: the balances appear in their OWN section, below the real
  // chains, and the headline still must not move — 15.75 test ETH from a
  // faucet is not 15.75 ETH
  const scanTestnets = async () => {
    await page.click('.tabbar .tab >> text=SETTINGS');
    await page.click('.setrowlink:has-text("NETWORKS")');
    await page.waitForSelector('.sectback');
    await page.locator('label.row', { hasText: /^Scan testnets/ }).locator('input').click();
    await page.waitForTimeout(500);
    await page.click('.tabbar .tab >> text=HOME');
    await page.waitForTimeout(400);
  };
  await scanTestnets();
  await page.waitForSelector('.testzone');
  const zone = page.locator('.testzone');
  const testChains = [...new Set(await zone.locator('.tokchain').allTextContents())];
  const realNames = [...new Set(await page.evaluate(() => [...document.querySelectorAll('.tokrow')]
    .filter((r) => !r.closest('.testzone'))
    .map((r) => r.querySelector('.tokchain')?.textContent?.trim())))];
  console.log('TESTNETS ON:', JSON.stringify(testChains),
    '| fenced off below', JSON.stringify(realNames));
  console.log('   headline still ignores them:', (await headline()) === beforeTestnet,
    '| no fiat on test rows:', (await zone.textContent()).includes('$') === false);
  // and back off again, so the rest of the run sees the default wallet
  await scanTestnets();
  console.log('   toggling back off hides the section:', !(await page.isVisible('.testzone')));
  // a <select> is sized by its LONGEST option, so registering a chain with a
  // long name used to steal width from the wallet name next to it — at three
  // wallets the identity button collapsed to nothing and the bar looked empty.
  // Measure it on the longest one rather than trusting that it looks fine.
  // the select is no longer in the account bar, so the longest chain name can
  // no longer take width from the wallet name beside it — measure it anyway,
  // because that is how the bug was found the first time
  await page.selectOption('.listbar .netsel', '46630');
  await page.waitForTimeout(200);
  const whoBox = await page.locator('.acctbar button.who').boundingBox();
  console.log('IDENTITY SURVIVES THE LONGEST CHAIN NAME:', Math.round(whoBox.width), 'px wide',
    '| readable:', whoBox.width >= 64);
  await page.selectOption('.listbar .netsel', '8453');
  await page.waitForTimeout(400);
  console.log('NET SWITCHES:',
    (await page.locator('.listbar .netsel').inputValue()) === '8453',
    '->', await page.locator('.listbar .netsel option:checked').textContent());
  await page.selectOption('.listbar .netsel', 'all');
  await page.waitForTimeout(300);
  await page.click('.tabbar .tab >> text=ACTIVITY');
  await page.waitForSelector('.simhead:has-text("ACTIVITY")');
  if (await page.locator('h1:text-is("ACTIVITY")').count() !== 1) {
    throw new Error('ACTIVITY title is not exposed as the screen heading');
  }
  // scanning for stealth payments and sweeping them home is money ARRIVING, so
  // it lives here rather than on RECEIVE, which is about the address you give out
  console.log('ACTIVITY SCREEN: shown, empty:', await page.isVisible('text=NOTHING YET'),
    '| stealth inbox is here:', await page.isVisible('.panel:has-text("STEALTH INBOX")'));
  await page.click('.tabbar .tab >> text=HOME');

  // stealth send detection
  await page.click('.actions .tile >> text=SEND');
  // SEND lists every chain's holdings now, so the asset carries the chain —
  // stealth sends are mainnet ETH only, and that has to be the ETH we pick
  await page.selectOption('.assetpick', 'native:1');
  await page.waitForTimeout(200);
  await page.fill('input[placeholder="0x… or name.eth"]', (meta||'').trim());
  await page.fill('input[placeholder="amount in ETH"]', '0.05');
  await page.locator('.panel', { hasText: 'STEALTH SEND (ERC-5564)' }).waitFor();
  if (!(await page.locator('.drawerfoot button', { hasText: 'SIMULATE FIRST (ALWAYS)' }).isEnabled())) {
    throw new Error('valid Ethereum stealth recipient must offer simulation before signing');
  }
  console.log('STEALTH SEND OFFERS SIMULATION FIRST:', true);
  await page.click('.drawerhead .x');
  await page.waitForTimeout(250);

  // ---- wallets drawer: many seeds, loose keys, nicknames, labels, filter ----
  const OTHER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const LOOSE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
  const drawer = page.locator('.drawer');
  const openDrawer = async () => { await page.click('.acctbar button.who'); await drawer.waitFor(); };

  const addWallet = async (which) => {
    await drawer.locator('button.btn', { hasText: '+ ADD WALLET' }).click();
    await drawer.locator('button.btn', { hasText: which }).click();
  };

  await openDrawer();
  const drawerA11y = await page.evaluate(() => {
    const dialog = document.querySelector('.drawerbox[role="dialog"]');
    const underlay = [...document.querySelectorAll('#app > *')]
      .filter((el) => !el.contains(dialog));
    return {
      modal: dialog?.getAttribute('aria-modal'),
      focusInside: !!dialog?.contains(document.activeElement),
      underlayInert: underlay.length > 0 && underlay.every((el) => el.inert),
    };
  });
  if (drawerA11y.modal !== 'true' || !drawerA11y.focusInside || !drawerA11y.underlayInert) {
    throw new Error(`wallet drawer is not an isolated focus modal: ${JSON.stringify(drawerA11y)}`);
  }
  await addWallet('IMPORT A SEED PHRASE');
  await drawer.locator('textarea.field').fill(OTHER_SEED);
  await drawer.locator('input[placeholder="nickname (optional)"]').fill('burner');
  await drawer.locator('button.btn', { hasText: 'IMPORT' }).click();
  await drawer.waitFor({ state: 'detached' });
  await page.waitForTimeout(300);
  // the wallet name and its seed group now live in sibling elements
  const header = async () =>
    (await page.textContent('.acctbar')) + (await page.textContent('.acctsub').catch(() => ''));
  console.log('SECOND SEED ADDED:', (await header()).includes('burner'));

  await openDrawer();
  await addWallet('IMPORT A PRIVATE KEY');
  await drawer.locator('textarea.field').fill(LOOSE_KEY);
  await drawer.locator('input[placeholder="nickname (optional)"]').fill('cold storage');
  await drawer.locator('button.btn', { hasText: 'IMPORT' }).click();
  await drawer.waitFor({ state: 'detached' });
  // A toast has to outlive the reading of it. This one is the longest warning
  // the wallet raises, and at the old flat 4s it went away mid-sentence — so
  // assert it is STILL up well past that, and that clicking gets rid of it for
  // anyone who has already read it.
  await page.waitForSelector('.toast');
  const warned = (await page.textContent('.toast')).trim();
  await page.waitForTimeout(4600);
  const stillUp = await page.isVisible('.toast');
  await page.click('.toast');
  await page.waitForSelector('.toast', { state: 'detached', timeout: 3000 });
  console.log('LONG WARNING OUTLIVES THE OLD 4s:', stillUp, '| dismissable:', true,
    '|', JSON.stringify(warned.slice(0, 44) + '…'));
  const ringText = await header();
  console.log('PRIVATE KEY IMPORTED:', ringText.includes('cold storage'),
    // the warning is about RECOVERY, not storage: the key is sealed in the same
    // vault as everything else, but no seed phrase can regenerate it. It used to
    // say "not covered by your seed backup", which reads as "we did not save it"
    '| says what it means:', ringText.includes('seed phrase cannot restore this one'));

  // an imported key gets no stealth meta-address, and the UI says so
  await page.click('.actions .tile >> text=RECEIVE');
  await page.waitForSelector('img.qr');
  const importedStealth = page.locator('.panel', { hasText: 'STEALTH RECEIVE' });
  if (!(await importedStealth.textContent()).includes('this wallet uses an imported private key')
      || await importedStealth.locator('.addr').count() !== 0) {
    throw new Error('imported key receive screen must explain why stealth receiving is unavailable');
  }
  console.log('IMPORTED KEY REFUSES STEALTH:', true);
  // three groups can each hold a same-named wallet, so the sheet handing out
  // an address says which group gets paid
  const rcvHead = await page.textContent('.drawerhead');
  if (!rcvHead.includes('imported keys')) {
    throw new Error(`RECEIVE does not name the wallet's group: ${JSON.stringify(rcvHead)}`);
  }
  console.log('RECEIVE NAMES THE GROUP:', true, '|', JSON.stringify(rcvHead.trim()));
  await page.click('.drawerhead .x');
  await page.waitForTimeout(250);

  await openDrawer();
  const groupNames = await drawer.locator('.walletgroup .gname').allTextContents();
  console.log('GROUPS:', JSON.stringify(groupNames));
  await shot('13-wallets');

  // nickname + labels on the first wallet
  const first = drawer.locator('.walletrow').first();
  const rowAction = async (name) => {
    if (!(await first.locator('.acts').isVisible().catch(() => false))) {
      await first.locator('.more').click();
    }
    await first.locator('.act', { hasText: name }).click();
  };
  await rowAction('rename');
  await first.locator('.walletedit input').fill('main bro');
  await first.locator('.act', { hasText: 'save' }).click();
  await rowAction('labels');
  await first.locator('.walletedit input').fill('hot, daily');
  await first.locator('.act', { hasText: 'save' }).click();
  await page.waitForTimeout(200);
  console.log('RENAMED:', (await first.locator('.nick').textContent()) === 'main bro',
    '| LABELS:', JSON.stringify(await first.locator('.rowlabels').allTextContents()));

  // Copying an address you are NOT using: tapping the row switches wallets, so
  // the copy is its own glyph on the row and must yield THAT row's address.
  const other = drawer.locator('.walletrow:not(.sel)').first();
  const before = (await page.textContent('.acctbar')).trim();
  // the row carries a fiat figure in the same element, so read the elided form
  const otherShort = ((await other.locator('.addr').textContent()) || '')
    .match(/0x[0-9a-fA-F]{4}\u2026[0-9a-fA-F]{4}/)[0];
  const copyBtn = other.locator('.copyaddr');
  // the word lives in the tooltip, so it has to actually appear on hover
  const tipShown = async () => Number(await copyBtn.evaluate((b) =>
    getComputedStyle(b, '::after').opacity));
  const tipCold = await tipShown();
  await copyBtn.hover();
  await page.waitForTimeout(250);
  const tipHot = await tipShown();
  await copyBtn.click();
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  console.log('ROW COPIES ITS OWN ADDRESS:',
    copied.startsWith(otherShort.slice(0, 6)) && copied.endsWith(otherShort.slice(-4)),
    '|', copied, 'vs row', otherShort);
  console.log('   copy is a glyph:', (await copyBtn.textContent()).trim(),
    '| named for a screen reader:', await copyBtn.getAttribute('aria-label'),
    '| tooltip hidden -> shown on hover:', tipCold === 0 && tipHot === 1,
    JSON.stringify(await copyBtn.getAttribute('data-tip')));
  // and it copies WITHOUT switching to that wallet — the whole point of it
  console.log('   selection unmoved:', (await page.textContent('.acctbar')).trim() === before);

  // filter the drawer down to one label
  await drawer.locator('.filterrow .chip', { hasText: 'hot' }).click();
  await page.waitForTimeout(200);
  console.log('LABEL FILTER:', await drawer.locator('.walletrow').count(), 'row(s),',
    await drawer.locator('.walletgroup').count(), 'group(s)');
  await drawer.locator('.filterrow .chip', { hasText: 'all' }).click();
  await page.waitForTimeout(200);

  // ---- exporting secrets ---------------------------------------------------
  // A key you cannot take with you is a key you are only borrowing. Both kinds
  // of wallet export, the password is asked for every time (the reveal opens
  // the SEALED vault rather than riding the unlocked session), and the secret
  // arrives blurred.
  const imported = drawer.locator('.walletrow').last();
  await imported.locator('.more').click();
  await imported.locator('.act.danger', { hasText: 'export key' }).click();
  await drawer.locator('.reveal input[name=password]').fill('not-the-password');
  await drawer.locator('.reveal button[type=submit]').click();
  await page.waitForTimeout(700);
  console.log('EXPORT REFUSES A WRONG PASSWORD:', await drawer.locator('.secretbox').count() === 0,
    '| and says so:', ((await page.textContent('.toast').catch(() => '')) || '').trim());
  await drawer.locator('.reveal input[name=password]').fill(PASSWORD);
  await drawer.locator('.reveal button[type=submit]').click();
  await drawer.locator('.secretbox').waitFor({ timeout: 15000 });
  const gotKey = (await drawer.locator('.secretbox').textContent()).trim();
  console.log('EXPORTED KEY IS THE ONE IMPORTED:', gotKey === LOOSE_KEY,
    '| blurred until tapped:', await drawer.locator('.secretbox.hidden').count() === 1);
  await drawer.locator('.reveal button.btn', { hasText: 'COPY?' }).click();
  await page.waitForTimeout(250);
  const firstCopy = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  const firstCopyWarning = ((await page.textContent('.toast').catch(() => '')) || '').trim();
  console.log('SECRET COPY IS TWO STEP:', firstCopy !== gotKey,
    '| warning:', /clipboard can be read by other apps/i.test(firstCopyWarning));
  await drawer.locator('.reveal button.btn', { hasText: 'YES, COPY' }).click();
  await page.waitForTimeout(250);
  const copiedKey = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  console.log('SECRET COPY WRITES ONLY AFTER CONFIRM:', copiedKey === gotKey);
  await page.evaluate(() => navigator.clipboard.writeText('keep me'));
  await page.waitForTimeout(10500);
  const keptClip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  console.log('SECRET CLEAR LEAVES USER REPLACEMENT ALONE:', keptClip === 'keep me');
  await drawer.locator('.reveal button.btn', { hasText: 'DONE' }).click();
  console.log('   and it is gone when you are done:',
    await drawer.locator('.secretbox').count() === 0);

  // the seed phrase behind a group, which is what restores every wallet in it
  const g0 = drawer.locator('.walletgroup').first();
  await g0.locator('.ghead .more').click();
  await g0.locator('.act.danger', { hasText: 'export phrase' }).first().click();
  await drawer.locator('.reveal input[name=password]').fill(PASSWORD);
  await drawer.locator('.reveal button[type=submit]').click();
  await drawer.locator('.secretbox').waitFor({ timeout: 15000 });
  const gotPhrase = (await drawer.locator('.secretbox').textContent()).trim();
  console.log('EXPORTED PHRASE IS THE ONE FROM SETUP:',
    gotPhrase === seed.replace(/\d+/g, ' ').trim().split(/\s+/).join(' '),
    `| ${gotPhrase.split(/\s+/).length} words`);
  await drawer.locator('.reveal button.btn', { hasText: 'COPY?' }).click();
  await drawer.locator('.reveal button.btn', { hasText: 'YES, COPY' }).click();
  await page.waitForTimeout(250);
  const copiedPhrase = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  await page.waitForTimeout(10500);
  const clearedPhrase = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  console.log('SECRET CLEAR REMOVES UNTOUCHED SECRET:', copiedPhrase === gotPhrase, '->', clearedPhrase === '');
  await drawer.locator('.reveal button.btn', { hasText: 'DONE' }).click();

  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  console.log('ESC CLOSES DRAWER: true');

  // ---- portfolio: popup-sized, filterable, one denomination at a time ------
  // The portfolio is a compact browser-extension instrument, so it must hold
  // up at the real popup width and with large text. The demo now has three
  // wallet identities: one generated seed, one imported seed, and one loose
  // key group.
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForSelector('.balance .big');
  const walletBeforePortfolio = (await page.textContent('.acctbar button.who')).trim();
  const networkBeforePortfolio = await page.locator('.listbar .netsel').inputValue();
  await portfolio.openPortfolio(page);
  await portfolio.assertPortfolioShell(page, 'PWA portfolio');
  await page.setViewportSize({ width: 372, height: 600 });
  await page.waitForTimeout(200);
  await portfolio.assertPortfolioResponsive(page, '372x600 PWA portfolio');
  await page.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await page.waitForSelector('.balance .big');
  await page.click('.tabbar .tab >> text=SETTINGS');
  await page.waitForSelector('.setlist');
  await page.click('.setrowlink:has-text("DISPLAY")');
  await page.waitForSelector('.sectback');
  await page.locator('.scalerow .slider').evaluate((el) => {
    el.value = '180';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await portfolio.openPortfolio(page);
  await page.waitForTimeout(200);
  await portfolio.assertPortfolioResponsive(page, '372x600 PWA portfolio at 180% text');
  await portfolio.savePortfolioScreenshot(page, `${out}/portfolio-pwa-180.png`, 'PWA 180%');
  await page.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await page.waitForSelector('.balance .big');
  await page.click('.tabbar .tab >> text=SETTINGS');
  await page.waitForSelector('.setlist');
  await page.click('.setrowlink:has-text("DISPLAY")');
  await page.waitForSelector('.sectback');
  await page.click('.scalerow .act');
  await page.waitForTimeout(250);
  await portfolio.openPortfolio(page);
  await portfolio.setPortfolioCurrency(page, 'USD');
  await portfolio.savePortfolioScreenshot(page, `${out}/portfolio-pwa-usd.png`, 'PWA USD');
  await portfolio.setPortfolioCurrency(page, 'ETH');
  await portfolio.savePortfolioScreenshot(page, `${out}/portfolio-pwa-eth.png`, 'PWA ETH');
  await portfolio.assertPortfolioGroupingAndDetails(page, 'PWA portfolio');
  await portfolio.assertPortfolioFiltersDialog(page, 'PWA portfolio');
  await page.locator('.portfolio-grouping button', { hasText: 'Assets' }).click();
  await page.waitForTimeout(200);
  await portfolio.setPortfolioCurrency(page, 'USD');
  await page.getByRole('button', { name: 'FILTERS', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Portfolio filters' });
  await page.screenshot({ path: `${out}/portfolio-pwa-filters.png`, fullPage: true });
  await filters.getByRole('button', { name: 'Wallets', exact: true }).click();
  await filters.locator('input[placeholder="Search wallets"]').fill('burner');
  await page.waitForTimeout(150);
  const walletFilterText = (await filters.textContent()).replace(/\s+/g, ' ');
  if (!walletFilterText.includes('burner') || walletFilterText.includes('cold storage')) {
    throw new Error(`wallet filter search did not narrow to the named wallet: ${walletFilterText}`);
  }
  await filters.getByRole('button', { name: 'Assets', exact: true }).click();
  await filters.locator('input[placeholder="Search assets"]').fill('$RAD');
  await page.waitForTimeout(150);
  if (!/\$RAD|Radcoin/.test((await filters.textContent()).replace(/\s+/g, ' '))) {
    throw new Error('asset filter search did not expose the Radcoin row');
  }
  await filters.getByRole('button', { name: 'Networks', exact: true }).click();
  if (!(await filters.textContent()).includes('Ethereum')) {
    throw new Error('network filter does not expose Ethereum');
  }
  await filters.getByRole('button', { name: 'Done', exact: true }).click();
  await filters.waitFor({ state: 'detached', timeout: 10000 });
  await portfolio.assertDemoFilterChangesTotal(page, 'PWA portfolio individual wallet exclusion', 'Wallets', async (dialog) => {
    await dialog.locator('.portfolio-filter-members .portfolio-check input').first().uncheck();
  });
  await portfolio.assertDemoFilterChangesTotal(page, 'PWA portfolio seed-group exclusion', 'Wallets', async (dialog) => {
    await dialog.locator('.portfolio-filter-group > .portfolio-check input').first().uncheck();
  });
  await portfolio.assertDemoFilterChangesTotal(page, 'PWA portfolio asset exclusion', 'Assets', async (dialog) => {
    await dialog.locator('.portfolio-check input').first().uncheck();
  });
  await portfolio.assertDemoFilterChangesTotal(page, 'PWA portfolio network exclusion', 'Networks', async (dialog) => {
    await dialog.locator('.portfolio-check input').first().uncheck();
  });
  await portfolio.assertPortfolioEmptyFilterAndReset(page, 'PWA portfolio');
  await page.reload();
  await page.waitForTimeout(600);
  if (await page.locator('text=Locked').count()) {
    await page.fill('input[placeholder="password"]', PASSWORD);
    await page.press('input[placeholder="password"]', 'Enter');
  }
  await page.locator('.portfolio-page').waitFor({ timeout: 30000 });
  await portfolio.assertPortfolioCurrency(page, 'USD', 'PWA portfolio after reload');
  await page.setViewportSize({ width: 372, height: 600 });
  await page.waitForTimeout(250);
  await portfolio.assertPortfolioResponsive(page, '372x600 clean PWA portfolio after reload');
  await portfolio.savePortfolioScreenshot(page, `${out}/portfolio-pwa-default.png`, 'PWA clean default');
  await page.setViewportSize({ width: 372, height: 900 });
  await page.waitForTimeout(250);
  await portfolio.assertPortfolioResponsive(page, '372x900 clean PWA portfolio after reload');
  await portfolio.savePortfolioScreenshot(page, `${out}/portfolio-pwa-docked.png`, 'PWA clean docked height');
  console.log('PORTFOLIO PWA: currency toggle, chart groupings, filters, empty state, details, and popup overflow verified');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await page.waitForSelector('.balance .big');
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForSelector('.balance .big');
  const walletAfterPortfolio = (await page.textContent('.acctbar button.who')).trim();
  const networkAfterPortfolio = await page.locator('.listbar .netsel').inputValue();
  if (walletAfterPortfolio !== walletBeforePortfolio || networkAfterPortfolio !== networkBeforePortfolio) {
    throw new Error(`portfolio changed selected wallet or network: ${JSON.stringify({
      walletBeforePortfolio, walletAfterPortfolio, networkBeforePortfolio, networkAfterPortfolio,
    })}`);
  }

  // lock + unlock roundtrip — and everything above must survive the re-seal
  await page.click('.tabbar .tab >> text=HOME');
  await page.click('.acctbar button.who');
  await page.locator('.drawerfoot').waitFor();
  await page.click('.drawerfoot button:has-text("LOCK IT")');
  await page.waitForSelector('text=Locked');
  // the unlock field is the one a password manager autofills — it has to
  // announce itself as the CURRENT password, not a new one
  console.log('UNLOCK FIELD:', JSON.stringify(await page.evaluate(() => {
    const i = document.querySelector('input[type=password]');
    return { inForm: !!i.form, autocomplete: i.autocomplete, name: i.name };
  })));
  await page.fill('input[placeholder="password"]', PASSWORD);
  // Enter submits the form: the browser has always done this, and the wallet
  // no longer needs a keydown handler of its own to fake it
  await page.press('input[placeholder="password"]', 'Enter');
  await page.waitForSelector('.balance .big', { timeout: 30000 });
  console.log('UNLOCK ROUNDTRIP: ok');

  await openDrawer();
  const afterGroups = await drawer.locator('.walletgroup .gname').allTextContents();
  const afterFirst = await drawer.locator('.walletrow').first().locator('.nick').textContent();
  const afterLabels = await drawer.locator('.filterrow .chip').allTextContents();
  console.log('SURVIVED UNLOCK: groups', JSON.stringify(afterGroups),
    '| first', JSON.stringify(afterFirst), '| labels', JSON.stringify(afterLabels));

  // the ‹ › arrows cycle wallets without opening the drawer
  await page.click('.drawerhead .x');
  await page.locator('.drawerbox').waitFor({ state: 'detached' });
  const whoNow = async () => (await page.textContent('.acctbar button.who')).trim();
  const cycFrom = await whoNow();
  await page.click('.acctbar .cycle >> nth=1');   // next
  await page.waitForTimeout(300);
  const cycTo = await whoNow();
  await page.click('.acctbar .cycle >> nth=0');   // previous
  await page.waitForTimeout(300);
  console.log('WALLET ARROWS:', cycFrom, '->', cycTo, '-> back to', await whoNow(),
    '| cycles:', cycFrom !== cycTo, '| returns:', (await whoNow()) === cycFrom);
  await page.click('.acctbar button.who');
  await page.locator('.drawerbox').waitFor();

  // forgetting a loose key: behind the row overflow, then an armed confirm
  // block — colour alone never carries a destructive action in this UI
  const loose = drawer.locator('.walletrow').last();
  await loose.locator('.more').click();
  await loose.locator('.act.danger', { hasText: 'forget' }).click();
  console.log('FORGET IS ARMED, NOT INSTANT:', await loose.locator('.armed').isVisible());
  await loose.locator('.btn.danger', { hasText: 'FORGET IT' }).click();
  await page.waitForTimeout(300);
  console.log('LOOSE KEY FORGOTTEN:', await drawer.locator('.walletrow').count(), 'wallet(s) left');

  // ---- the icon pass: a glyph is only allowed if it has a name -------------
  // Trading words for glyphs buys width back, and it costs exactly one thing:
  // a glyph is a guess until something tells you what it does. So every
  // glyph-only control has to be nameable — by the tooltip for whoever hovers,
  // and by aria-label for whoever cannot. An unnamed one is a button called
  // "\u2197". This is the check that keeps the next glyph honest.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const nameless = [];
  for (const tab of ['HOME', 'NFTS', 'SWAP', 'ACTIVITY', 'SETTINGS']) {
    await page.click(`.tabbar .tab >> text=${tab}`);
    await page.waitForTimeout(300);
    nameless.push(...await page.evaluate((where) => {
      const bad = [];
      for (const b of document.querySelectorAll('.content button, .content a')) {
        const text = (b.textContent || '').trim();
        // a control that spells itself out needs no help; only the short,
        // wordless ones are in question
        if (!text || text.length > 3 || /[a-z0-9]/i.test(text)) continue;
        if (!b.getAttribute('aria-label') && !b.getAttribute('data-tip')
          && !b.getAttribute('title')) bad.push(`${where}:${text}`);
      }
      return bad;
    }, tab));
    // and a tab-bar screen never carries its own way home. The bar IS the way
    // home; a second control for it is the kind of duplication that makes a
    // screen feel like a document rather than an instrument.
    const backs = await page.locator('.content button', { hasText: '\u2190 back' }).count();
    if (backs) throw new Error(`${tab} carries a back link as well as the tab bar`);
  }
  console.log('EVERY GLYPH-ONLY CONTROL HAS A NAME:', nameless.length === 0,
    nameless.length ? JSON.stringify(nameless) : '');
  if (nameless.length) throw new Error(`unnamed glyph controls: ${nameless.join(' ')}`);
  await page.click('.tabbar .tab >> text=HOME');
  await page.waitForTimeout(300);

  // ---- where the vault actually lives -------------------------------------
  // localStorage is SITE DATA: one "clear browsing data" wipes it, Safari
  // evicts it after seven days, WKWebView drops it under disk pressure. A seed
  // phrase survives that; an imported private key does not, because it is
  // outside every seed backup by design. So the PWA keeps its state in
  // IndexedDB, and nothing is left behind in localStorage.
  const kv = await idbDump(page);
  const leftBehind = await page.evaluate(() => Object.keys(localStorage));
  console.log('VAULT IS IN INDEXEDDB:', typeof kv.vault === 'string' && kv.vault.includes('"ct"'),
    '| keys:', JSON.stringify(Object.keys(kv).sort()),
    '| localStorage left holding:', JSON.stringify(leftBehind));

  // every vault write keeps the copy it replaced. One key overwritten in place
  // means one bad write costs the wallet, and an imported key has no seed
  // phrase to come back from.
  console.log('PREVIOUS VAULT IS KEPT:', typeof kv.vaultPrev === 'string' && kv.vaultPrev !== kv.vault);

  // prove the backup is load-bearing: destroy the live vault and reload
  await idbCorrupt(page, 'vault');
  await page.reload();
  await page.waitForTimeout(900);
  const recovered = await page.locator('text=Locked').count() > 0;
  const toast = ((await page.textContent('.toast').catch(() => '')) || '').trim();
  console.log('A DESTROYED VAULT FALLS BACK TO THE BACKUP:', recovered,
    '| and says so:', JSON.stringify(toast.slice(0, 60)));
  if (!recovered) throw new Error('vault recovery failed — a corrupt vault dropped the wallet');

  await browser.close();
})();
