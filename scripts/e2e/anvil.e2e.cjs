/**
 * Bring-your-own-node, end to end, against a LOCAL ANVIL FORK OF MAINNET.
 *
 * Everything else in this repo proves the wallet against public endpoints it
 * ships. This proves the opposite claim — that you can point it at your own
 * node and stop trusting ours — and it is the only suite where the wallet
 * signs and broadcasts a real transaction, because the chain is disposable.
 *
 * The fork is mainnet, so nothing is mocked: multicall3, the Uniswap quoter
 * and every token in the bundled list are the real deployments at a real block.
 *
 * Needs: anvil on PATH (foundry), Playwright's bundled Chromium, and network
 * (the fork's upstream RPC). Set ANVIL_URL to reuse a node you already run.
 */
const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.ANVIL_PORT || 18545);
const NODE_URL = process.env.ANVIL_URL || `http://127.0.0.1:${PORT}`;
const FORK_RPC = process.env.FORK_RPC || 'https://ethereum-rpc.publicnode.com';
const PROFILE = path.join(os.tmpdir(), `radwallet-e2e-anvil-${PORT}`);
const LOG = path.join(os.tmpdir(), `radwallet-e2e-anvil-${PORT}.log`);

// anvil's own dev seed, and its first account (10000 ETH on any fork)
const SEED = 'test test test test test test test test test test test junk';
const ADDR0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/**
 * Where the test ETH goes. NOT anvil account 1: the dev keys are public, so on
 * real mainnet those addresses have been claimed — 0x7099…79C8 carries an
 * EIP-7702 delegation, and a FORK keeps mainnet CODE while overriding the dev
 * balances. Sending there mined a perfectly successful transfer whose ETH the
 * delegate forwarded onward inside the same transaction, so the recipient's
 * balance never moved. The burn address has no code and never will.
 */
const SINK = '0x000000000000000000000000000000000000dEaD';
const PASSWORD = 'hunter2hunter2rad';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** talk to the fork directly, so the wallet's claims can be checked against it */
async function rpc(method, params = []) {
  const res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const eth = (wei) => Number(BigInt(wei)) / 1e18;

/** anvil's latest fork can have a base fee above the tx cap our wallet signs */
async function makeNextBlockMineable() {
  await rpc('anvil_setNextBlockBaseFeePerGas', ['0x1']);
}

async function startAnvil() {
  if (process.env.ANVIL_URL) {
    console.log('using the node already running at', NODE_URL);
    return null;
  }
  if (spawnSync('anvil', ['--version'], { encoding: 'utf8' }).status !== 0) {
    throw new Error('anvil not on PATH — install foundry (foundryup), or set ANVIL_URL');
  }
  const log = fs.openSync(LOG, 'w');
  const proc = spawn('anvil', ['--fork-url', FORK_RPC, '--port', String(PORT), '--silent'], {
    stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 120; i++) {
    try { await rpc('eth_chainId'); return proc; } catch { await sleep(500); }
  }
  proc.kill();
  throw new Error(`anvil never answered on ${NODE_URL} (fork upstream: ${FORK_RPC})`);
}

/** the endpoints currently listed for the chain the RPC POOL panel is showing */
const listed = (panel) => panel.locator('.rpcrow .ep').allTextContents();

(async () => {
  const anvil = await startAnvil();
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };

  try {
    const chainId = parseInt(await rpc('eth_chainId'), 16);
    const forkBlock = parseInt(await rpc('eth_blockNumber'), 16);
    console.log(`fork up: chain ${chainId} at block ${forkBlock} (${NODE_URL})`);
    check('the fork is mainnet, so the wallet needs no special case for it', chainId === 1);

    const ext = path.resolve(__dirname, '../../apps/extension/dist');
    fs.rmSync(PROFILE, { recursive: true, force: true });
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: process.env.E2E_CHANNEL || 'chromium',
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
      viewport: { width: 390, height: 780 },
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;

    // ---- 1. import anvil's dev seed, so the wallet holds the funded account --
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await popup.goto(`chrome-extension://${extId}/index.html`);
    await popup.click('text=I ALREADY HAVE ONE');
    await popup.fill('textarea.field', SEED);
    await popup.fill('input[placeholder="new local password"]', PASSWORD);
    await popup.click('button:has-text("IMPORT")');
    await popup.waitForSelector('.balance .big', { timeout: 30000 });
    const who = (await popup.textContent('.balance .addrcopy')).trim();
    check('imported wallet is anvil account 0', who.slice(0, 6).toLowerCase() === ADDR0.slice(0, 6).toLowerCase(), who);
    // ---- 2. the RPC pool takes your own node, and refuses two ways to get it wrong
    // SETTINGS is an index of rows now; the pool lives one level in
    const openNetworks = async () => {
      await popup.click('.tabbar .tab >> text=SETTINGS');
      await popup.waitForSelector('.setlist', { timeout: 20000 });
      await popup.click('.setrowlink:has-text("NETWORKS")');
      await popup.waitForSelector('.sectback', { timeout: 20000 });
    };
    await openNetworks();
    const panel = popup.locator('.panel', { hasText: 'RPC POOL' });
    await panel.waitFor();
    const before = await listed(panel);
    console.log('   ethereum pool as shipped:', JSON.stringify(before));

    // (a) plaintext http to someone else's machine: refused, and told why
    await panel.locator('input.field').fill('http://eth.example');
    await panel.locator('button:has-text("ADD")').click();
    await popup.waitForTimeout(400);
    let toast = await popup.textContent('.toast').catch(() => '');
    check('plaintext http to the internet is refused',
      (await listed(panel)).length === before.length && /localhost/.test(toast), toast);

    // (b) a perfectly good node, for the wrong chain: refused by eth_chainId,
    //     because wrong-chain reads look like a wallet, not like an error
    await popup.click('.toast').catch(() => {});
    await panel.locator('input.field').fill('https://base-rpc.publicnode.com');
    await panel.locator('button:has-text("ADD")').click();
    await popup.waitForTimeout(6000);
    toast = await popup.textContent('.toast').catch(() => '');
    check('a Base endpoint is refused from the Ethereum pool',
      (await listed(panel)).length === before.length && /8453/.test(toast), toast);

    // (c) the local fork: accepted
    await popup.click('.toast').catch(() => {});
    await panel.locator('input.field').fill(NODE_URL);
    await panel.locator('button:has-text("ADD")').click();
    await popup.waitForTimeout(4000);
    let now = await listed(panel);
    check('the local fork is accepted into the pool', now.includes(NODE_URL), JSON.stringify(now));

    // ---- 3. drop everything else: from here the wallet only knows our node --
    for (const ep of before) {
      await panel.locator('.rpcrow', { hasText: ep }).locator('button.drop').click();
      await popup.waitForTimeout(200);
    }
    now = await listed(panel);
    check('ethereum now goes through your node alone', now.length === 1 && now[0] === NODE_URL, JSON.stringify(now));

    // ---- 4. read: the balance is the fork's, not a public endpoint's --------
    await popup.goto(`chrome-extension://${extId}/index.html`);
    await popup.waitForSelector('.balance .big', { timeout: 30000 });
    // what the node says, not a number this script assumed: the fork keeps
    // whatever earlier runs spent, and a hardcoded 10000 would fail on a node
    // that is merely reused.
    // The headline is the dollar figure; the ether it is a valuation OF sits
    // under it, and that is the number the chain can be checked against.
    const onChain = eth(await rpc('eth_getBalance', [ADDR0, 'latest']));
    let big = '', shown = NaN;
    for (let i = 0; i < 60; i++) {
      big = (await popup.textContent('.balance .native')).trim();
      shown = parseFloat(big.replace(/[^0-9.]/g, ''));
      if (Math.abs(shown - onChain) < 0.001) break;
      await sleep(1000);
    }
    check('home shows the balance the fork reports', Math.abs(shown - onChain) < 0.001,
      `${big} vs ${onChain} ETH on chain`);

    // ---- 4b. the last known balances survive a reopen ---------------------
    // The toolbar popup dies on every lost focus and every page boots its own
    // store, so a reopen used to start on an empty list and race the RPCs onto
    // the screen. Reopen with the node UNREACHABLE: the only place a number
    // can come from is the on-device snapshot, and a blank list is a failure.
    let refused = 0;
    const refuse = (route) => { refused++; return route.abort('connectionrefused'); };
    const isNode = (u) => u.href.startsWith(NODE_URL);
    await ctx.route(isNode, refuse);
    await popup.goto(`chrome-extension://${extId}/index.html`);
    let cachedEth = NaN, cachedRows = 0;
    for (let i = 0; i < 50; i++) {
      const bal = (await popup.textContent('.balance').catch(() => '')) || '';
      cachedEth = parseFloat(((bal.match(/([0-9.,]+) ETH/) || [])[1] || '').replace(/,/g, ''));
      cachedRows = await popup.locator('.tokrow').count();
      if (Math.abs(cachedEth - onChain) < 0.001 && cachedRows > 0) break;
      await sleep(100);
    }
    check('a reopened popup shows the last known balances before any RPC answers',
      Math.abs(cachedEth - onChain) < 0.001 && cachedRows > 0,
      `${cachedEth} ETH, ${cachedRows} rows, node refused ${refused} calls`);
    await ctx.unroute(isNode, refuse);
    // let the live sweep land again before the next steps read the screen
    await popup.goto(`chrome-extension://${extId}/index.html`);
    await popup.waitForSelector('.balance .big', { timeout: 30000 });
    // which node is serving this wallet is a NETWORKS fact, not home-screen
    // furniture — it used to sit between the action tiles and the assets
    await openNetworks();
    const nodeLine = (await popup.textContent('.privline')).trim();
    check('settings names the node it is reading from', nodeLine.includes('127.0.0.1'), nodeLine);
    await popup.click('.tabbar .tab >> text=HOME');
    await popup.waitForSelector('.balance .big', { timeout: 20000 });

    // ---- 5. write: simulate, sign, broadcast — a real tx on a real fork -----
    check('the recipient is a plain address, with no code to move the ETH on',
      (await rpc('eth_getCode', [SINK, 'latest'])) === '0x');
    const balBefore = BigInt(await rpc('eth_getBalance', [SINK, 'latest']));
    await popup.click('.actions .tile >> text=SEND');
    await popup.waitForSelector('.assetpick', { timeout: 20000 });
    await popup.fill('input[placeholder="0x… or name.eth"]', SINK);
    await popup.fill('input[placeholder="amount in ETH"]', '1');
    await popup.click('button:has-text("SIMULATE FIRST")');
    await popup.waitForSelector('text=TRANSACTION PREVIEW', { timeout: 30000 });
    check('the fork simulated the send before anything was signed', true);
    await makeNextBlockMineable();
    await popup.click('button:has-text("SIGN & SEND")');
    const receiptLink = popup.locator('.panel:has-text("TRANSACTION SUBMITTED") a.txlink');
    await receiptLink.waitFor({ timeout: 30000 });
    const sendHash = ((await receiptLink.textContent()) || '').trim();
    const receiptHref = await receiptLink.getAttribute('href');
    check('the send receipt links the exact transaction on the chain explorer',
      /^0x[0-9a-fA-F]{64}$/.test(sendHash) && receiptHref === `https://etherscan.io/tx/${sendHash}`,
      `${sendHash} → ${receiptHref}`);
    let balAfter = balBefore;
    let confirmationToast = '';
    let confirmationHref = null;
    let notificationIds = [];
    for (let i = 0; i < 80; i++) {
      balAfter = BigInt(await rpc('eth_getBalance', [SINK, 'latest']));
      confirmationToast = await popup.textContent('.toast').catch(() => confirmationToast);
      confirmationHref = await popup.getAttribute('.toast a.txlink', 'href').catch(() => confirmationHref);
      notificationIds = await sw.evaluate(() => new Promise((resolve) =>
        chrome.notifications.getAll((active) => resolve(Object.keys(active)))));
      if (balAfter > balBefore && /transaction confirmed/i.test(confirmationToast)
        && confirmationHref === `https://etherscan.io/tx/${sendHash}`
        && notificationIds.some((id) => id.startsWith('radtx:1:'))) break;
      await sleep(250);
    }
    check('1 ETH landed on chain, through your own node',
      balAfter - balBefore === 10n ** 18n, `${eth(balBefore)} → ${eth(balAfter)} ETH`);
    check('the open wallet pops a receipt-confirmed toast',
      /transaction confirmed/i.test(confirmationToast), confirmationToast);
    check('the receipt-confirmed toast links the exact transaction on the chain explorer',
      confirmationHref === `https://etherscan.io/tx/${sendHash}`,
      `${sendHash} → ${confirmationHref}`);
    check('the extension posts an OS notification only after the receipt',
      notificationIds.some((id) => id.startsWith('radtx:1:')), JSON.stringify(notificationIds));
    let confirmationQueue = null;
    let latestSend = null;
    for (let i = 0; i < 20; i++) {
      ({ confirmationQueue, latestSend } = await sw.evaluate(async () => {
        const stored = await chrome.storage.local.get(['confirmationWatches', 'history']);
        const queue = JSON.parse(stored.confirmationWatches || '[]');
        const history = JSON.parse(stored.history || '[]');
        return { confirmationQueue: queue, latestSend: history.find((entry) => entry.kind === 'send') || null };
      }));
      if (confirmationQueue.length === 0 && latestSend?.status === 'confirmed') break;
      await sleep(100);
    }
    check('confirmation settlement clears its durable watch', confirmationQueue.length === 0,
      JSON.stringify(confirmationQueue));
    check('confirmation settlement updates local transaction history', latestSend?.status === 'confirmed',
      JSON.stringify(latestSend));
    await sw.evaluate((ids) => Promise.all(ids.map((id) => new Promise((resolve) =>
      chrome.notifications.clear(id, resolve)))), notificationIds);
    const mined = parseInt(await rpc('eth_blockNumber'), 16);
    check('the fork mined the wallet\'s transaction', mined > forkBlock, `block ${forkBlock} → ${mined}`);

    // ---- 6. quote: the Uniswap read path works over a local node too --------
    await popup.goto(`chrome-extension://${extId}/index.html`);
    await popup.waitForSelector('.balance .big', { timeout: 30000 });
    await popup.click('.actions .tile >> text=SWAP');
    await popup.waitForSelector('.payrow input.field', { timeout: 20000 });
    await popup.fill('.payrow input.field', '1');
    const got = popup.locator('.panel', { hasText: 'YOU GET' }).locator('.balance .big');
    let quote = '';
    for (let i = 0; i < 45; i++) {
      quote = (await got.textContent().catch(() => '') || '').trim();
      if (quote) break;
      await sleep(1000);
    }
    check('a swap quote comes back from the fork', /\d/.test(quote), quote || '(none)');

    await ctx.close();
  } finally {
    if (anvil) anvil.kill();
  }

  console.log(failures === 0 ? '\nALL GOOD — the wallet ran entirely on your own node.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
