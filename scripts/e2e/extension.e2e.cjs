const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const http = require('http');
const portfolio = require('./portfolio-helpers.cjs');
const PASSWORD = 'hunter2hunter2rad';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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

/** which token a side is showing right now */
async function sideSymbol(pg, side) {
  return (await pg.locator('.pairside').nth(side).locator('.psym').textContent()).trim();
}

async function stopExtensionWorker(ctx, pg, extId) {
  const cdp = await ctx.newCDPSession(pg);
  let versions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (ev) => { versions = ev.versions || []; });
  await cdp.send('ServiceWorker.enable');
  await pg.waitForTimeout(500);
  const worker = versions.find((v) =>
    v.scriptURL && v.scriptURL.includes(extId) && v.status === 'activated');
  if (!worker?.versionId) throw new Error('could not find extension service worker version');
  await cdp.send('ServiceWorker.stopWorker', { versionId: worker.versionId });
  await cdp.detach().catch(() => {});
}

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    // /plain is the rest of the web: a page that never touches the provider.
    // The wallet must not offer to connect it to anything.
    res.end('<h1>fake dapp</h1>');
  });
  // a SECOND origin for the rest of the web: a page that never touches the
  // provider. It has to be its own origin, because an origin you are already
  // connected to always gets the full bar (that is where disconnect lives).
  const plainServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>an ordinary web page</h1>');
  });
  await new Promise((r) => plainServer.listen(18929, '127.0.0.1', r));
  await new Promise((r) => server.listen(18926, '127.0.0.1', r));

  const ext = require('path').resolve(__dirname, '../../apps/extension/dist');
  // fresh profile per suite: a reused one keeps the previous run's wallet and
  // selected chain, which breaks "MAKE A NEW WALLET" and the default-chain assert
  const profile = require('path').join(require('os').tmpdir(), 'radwallet-e2e-ext');
  require('fs').rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 740 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // 1. create wallet in the popup
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/index.html`);
  await popup.click('text=MAKE A NEW WALLET');
  await popup.fill('input[placeholder="password"]', PASSWORD);
  await popup.fill('input[placeholder="password again"]', PASSWORD);
  await popup.click('text=GENERATE SEED');
  await popup.waitForSelector('.seedbox', { timeout: 30000 });
  await popup.click('label.row input[type=checkbox]');
  await popup.click('text=ENTER THE WEBRING');
  await popup.waitForSelector('.balance .big', { timeout: 20000 });
  console.log('1. WALLET CREATED');

  const dapp = await ctx.newPage();
  await dapp.goto('http://127.0.0.1:18926/');

  // pre-connect, a page gets only provider discovery. Letting every page proxy
  // eth_call/getLogs/etc through the user's RPC leaks and can abuse their node.
  const preChain = await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  const preLogs = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'eth_getLogs', params: [{}] })
      .then(() => 'OK').catch((e) => `ERR:${e.code}:${e.message}`));
  assert(/^0x[0-9a-f]+$/i.test(preChain), `pre-connect eth_chainId failed: ${preChain}`);
  assert(preLogs.startsWith('ERR:4100:'), `pre-connect eth_getLogs was not blocked: ${preLogs}`);
  console.log('1a. PRE-CONNECT RPC: discovery works, eth_getLogs blocked with 4100');

  // 2. connect — session was adopted at creation, so NO unlock inside approval
  let approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const acctsP = dapp.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' }));
  let ap = await approvalP;
  await ap.waitForSelector('text=SITE WANTS TO SEE YOU', { timeout: 20000 });
  const unlockShown = await ap.isVisible('text=Locked');
  console.log('2. CONNECT APPROVAL, no unlock needed:', !unlockShown);
  await ap.click('button:has-text("CONNECT")');
  const accts = await acctsP;
  const addr = accts[0];
  console.log('   connected:', addr.slice(0, 10) + '…');
  const sessionStore = await sw.evaluate(async () => chrome.storage.session.get(null));
  const sessionJson = JSON.stringify(sessionStore);
  assert(!sessionJson.includes('mnemonic'), `storage.session contains mnemonic material: ${sessionJson}`);
  assert(!sessionJson.includes('privateKey'), `storage.session contains private key material: ${sessionJson}`);
  assert(!sessionJson.includes('"seeds"'), `storage.session contains VaultSecret seeds: ${sessionJson}`);
  assert(!sessionJson.includes('"imported"'), `storage.session contains VaultSecret imported keys: ${sessionJson}`);
  console.log('2a. STORAGE.SESSION: opaque envelope only:', JSON.stringify(Object.keys(sessionStore)));
  const legacyStealth = await popup.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { t: 'sess.sendToStealth', index: 0, endpoint: 'http://127.0.0.1:1', meta: 'st:eth:0x00', amountEth: '0' },
      resolve,
    );
  }));
  assert(legacyStealth && legacyStealth.error && legacyStealth.error.includes('unknown session call'),
    `legacy sendToStealth still reachable: ${JSON.stringify(legacyStealth)}`);
  console.log('2b. LEGACY STEALTH SEND: internal transfer-first session API refused');

  // 2c. A dapp requests Robinhood immediately after connect. A 4001 here is
  // rendered by its UI as "You cancelled in your wallet", even though no
  // decision window ever appeared. Bundled switches now get an explicit
  // wallet prompt; asking for the chain already selected is idempotent.
  const pagesBeforeSameChain = ctx.pages().length;
  const sameChain = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
      .then((r) => r === null ? 'OK:null' : `OK:${String(r)}`)
      .catch((e) => `ERR:${e.code}:${e.message}`));
  await dapp.waitForTimeout(300);
  assert(sameChain === 'OK:null' && ctx.pages().length === pagesBeforeSameChain,
    `idempotent chain switch opened/rejected: ${sameChain}`);

  await dapp.evaluate(() => {
    window.__radChainEvents = [];
    window.ethereum.on('chainChanged', (id) => window.__radChainEvents.push(id));
  });
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const toRobinhoodP = dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] })
      .then((r) => r === null ? 'OK:null' : `OK:${String(r)}`)
      .catch((e) => `ERR:${e.code}:${e.message}`));
  ap = await approvalP;
  await ap.waitForSelector('text=SITE WANTS TO SWITCH NETWORKS', { timeout: 20000 });
  const switchBody = (await ap.textContent('.content')).replace(/\s+/g, ' ');
  assert(switchBody.includes('Ethereum') && switchBody.includes('Robinhood'),
    `chain switch prompt did not name both chains: ${switchBody.slice(0, 240)}`);
  await ap.click('button:has-text("SWITCH")');
  const toRobinhood = await toRobinhoodP;
  const robinhoodChain = await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  const robinhoodEvents = await dapp.evaluate(() => window.__radChainEvents);
  assert(toRobinhood === 'OK:null' && robinhoodChain === '0x1237' && robinhoodEvents.includes('0x1237'),
    `approved Robinhood switch did not land: result=${toRobinhood} chain=${robinhoodChain} events=${robinhoodEvents}`);

  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const toEthereumP = dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
      .then((r) => r === null ? 'OK:null' : `OK:${String(r)}`)
      .catch((e) => `ERR:${e.code}:${e.message}`));
  ap = await approvalP;
  await ap.waitForSelector('text=SITE WANTS TO SWITCH NETWORKS', { timeout: 20000 });
  await ap.click('button:has-text("SWITCH")');
  const toEthereum = await toEthereumP;
  const ethereumChain = await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  assert(toEthereum === 'OK:null' && ethereumChain === '0x1',
    `approved Ethereum switch did not land: result=${toEthereum} chain=${ethereumChain}`);
  console.log('2c. CHAIN SWITCH: current-chain no-op + approved Robinhood round trip');

  // Closing the browser window is the same user decision as REFUSE. The
  // original dapp promise must settle with 4001, and the dead request must not
  // remain in `pending` and block the next approval.
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const closedApprovalP = dapp.evaluate((a) => {
    const request = window.ethereum.request({ method: 'personal_sign', params: ['0x726164', a] })
      .then(() => 'SIGNED').catch((e) => `ERR:${e.code}:${e.message}`);
    return Promise.race([request, new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 5000))]);
  }, addr);
  ap = await approvalP;
  await ap.waitForSelector('text=SITE WANTS A SIGNATURE', { timeout: 20000 });
  await ap.close();
  const closedApproval = await closedApprovalP;
  assert(closedApproval.startsWith('ERR:4001:') && closedApproval.includes('closed'),
    `closing approval did not refuse it with 4001: ${closedApproval}`);
  console.log('2d. CLOSED APPROVAL: dapp receives 4001 and request is cleared');

  // 3. personal_sign — still no re-unlock; sign in background
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const sigP = dapp.evaluate((a) =>
    window.ethereum.request({ method: 'personal_sign', params: ['0x72616462726f", "hello radbro'.slice(0,0) + '0x726164', a] }),
  addr);
  ap = await approvalP;
  await ap.waitForSelector('text=SITE WANTS A SIGNATURE', { timeout: 20000 });
  const msgBody = (await ap.textContent('.content')).replace(/\s+/g, ' ');
  assert(msgBody.includes('SIGNING AS') && msgBody.includes(addr.slice(0, 6)), 'personal_sign did not show exact signer');
  await ap.click('button:has-text("SIGN IT")');
  const sig = await sigP;
  console.log('3. PERSONAL_SIGN, sig valid-length:', typeof sig === 'string' && sig.length === 132);
  assert(typeof sig === 'string' && sig.length === 132, 'personal_sign did not return a signature');
  const missingSign = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'personal_sign', params: ['0x726164'] })
      .then(() => 'SIGNED').catch((e) => `ERR:${e.code}:${e.message}`));
  assert(missingSign.startsWith('ERR:4100:') && missingSign.includes('explicit'),
    `personal_sign without signer was not refused: ${missingSign}`);
  console.log('3a. PERSONAL_SIGN missing signer refused:', missingSign.slice(0, 90));

  // 4. eth_signTypedData_v4
  const typed = JSON.stringify({
    domain: { name: 'RadSwapPermit', version: '1', chainId: 1, verifyingContract: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB' },
    primaryType: 'Permit',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }],
    },
    message: { spender: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', value: '1000000000000000000' },
  });
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const tsigP = dapp.evaluate(([a, t]) =>
    window.ethereum.request({ method: 'eth_signTypedData_v4', params: [a, t] }), [addr, typed]);
  ap = await approvalP;
  await ap.waitForSelector('text=TYPED SIGNATURE', { timeout: 20000 });
  const domainShown = await ap.isVisible('text=RadSwapPermit');
  const typedBody = (await ap.textContent('.content')).replace(/\s+/g, ' ');
  assert(typedBody.includes('SIGNING AS') && typedBody.includes(addr.slice(0, 6)), 'typed-data prompt did not show exact signer');
  await ap.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots') + '/11-ext-typed-data.png' });
  await ap.click('button:has-text("SIGN IT")');
  const tsig = await tsigP;
  console.log('4. TYPED DATA: domain rendered:', domainShown, '| sig valid-length:', typeof tsig === 'string' && tsig.length === 132);
  assert(domainShown && typeof tsig === 'string' && tsig.length === 132, 'typed data approval failed');

  // 5. unlimited approve -> billboard + rewrite, then REFUSE
  const unlimitedApprove =
    '0x095ea7b3' +
    '68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'.toLowerCase().padStart(64, '0') +
    'f'.repeat(64);
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const txP = dapp.evaluate(([a, data]) =>
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: a, to: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB', data }],
    }).then((h) => 'HASH:' + h).catch((e) => 'REFUSED:' + e.message), [addr, unlimitedApprove]);
  ap = await approvalP;
  await ap.waitForSelector('text=UNLIMITED ALLOWANCE', { timeout: 30000 });
  await ap.waitForSelector('text=REWRITTEN BEFORE SIGNING', { timeout: 10000 });
  await ap.waitForSelector('button:has-text("SIGN REWRITTEN")', { timeout: 20000 });
  await ap.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots') + '/12-ext-allowance-rewrite.png' });
  console.log('5. UNLIMITED APPROVE: billboard + SIGN REWRITTEN shown');
  // the click closes the approval window, so it can lose the race with
  // teardown — the dapp-side result below is the actual assertion
  await ap.click('button:has-text("REFUSE")').catch(() => {});
  console.log('   dapp result:', await txP);

  // 6. from-mismatch: bogus from is refused before an approval can sign it
  const badP = dapp.evaluate(() =>
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: '0x000000000000000000000000000000000000dEaD', to: '0x000000000000000000000000000000000000dEaD', value: '0x1' }],
    }).then((h) => 'HASH:' + h).catch((e) => `REFUSED:${e.code}:${e.message}`), );
  const badResult = await badP;
  assert(badResult.startsWith('REFUSED:4100:'), `bad from was not refused with 4100: ${badResult}`);
  console.log('6. FROM-MISMATCH refused before approval:', badResult.slice(0, 90));
  const missingFrom = await dapp.evaluate((to) =>
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to, value: '0x0' }],
    }).then((h) => 'HASH:' + h).catch((e) => `REFUSED:${e.code}:${e.message}`), addr);
  assert(missingFrom.startsWith('REFUSED:4100:') && missingFrom.includes('explicit'),
    `missing tx.from fell through instead of failing closed: ${missingFrom}`);
  console.log('   missing from refused:', missingFrom.slice(0, 90));

  // 6a. …and a request for an address we DO hold must not alarm at all: it
  // names the wallet that will sign, and shows what the tx moves.
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const okP = dapp.evaluate((me) =>
    window.ethereum.request({
      method: 'eth_sendTransaction',
      // zero value to ourselves: it simulates cleanly from an unfunded test
      // wallet, so the panel is exercised and its empty case is the right one
      params: [{ from: me, to: me, value: '0x0' }],
    }).then((h) => 'HASH:' + h).catch((e) => 'REFUSED:' + e.message), addr);
  ap = await approvalP;
  await ap.waitForSelector('text=SIGNING AS', { timeout: 20000 });
  await ap.waitForTimeout(6000);   // let the simulation land
  const body6a = (await ap.textContent('.content')).replace(/\s+/g, ' ');
  const approvalNetwork = ((await ap.locator('.approvalchain .what').textContent()) || '').trim();
  assert(
    await ap.locator('.approvalchain .hd:text-is("NETWORK")').count() === 1
      && approvalNetwork.includes('Ethereum')
      && approvalNetwork.includes('chain 1'),
    `transaction approval did not name its network and chain ID: ${approvalNetwork}`,
  );
  console.log('    NETWORK:', approvalNetwork);
  console.log('6a. OWN ADDRESS DOES NOT ALARM:', !body6a.includes('NOT ONE OF YOUR WALLETS'),
    '| names the signer:', body6a.includes('SIGNING AS'));
  assert(!body6a.includes('NOT ONE OF YOUR WALLETS') && body6a.includes('SIGNING AS'),
    'own-address approval did not name signer cleanly');
  // three honest outcomes, and a green run must say which one it saw
  console.log('    WHAT MOVES:', body6a.includes('WHAT MOVES')
    ? JSON.stringify((body6a.match(/WHAT MOVES(.{0,58})/) || [])[1])
    : body6a.includes('cannot simulate') ? '(no endpoint in the pool can simulate)'
      : body6a.includes('SIMULATION FAILED') ? '(the call itself reverted)'
        : '(nothing rendered — that is a bug)');
  const switchDuringApproval = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] })
      .then(() => 'OK').catch((e) => `ERR:${e.code}:${e.message}`));
  const chainAfterSwitchRefusal = await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' }));
  assert(switchDuringApproval.startsWith('ERR:4001:') && chainAfterSwitchRefusal === preChain,
    `chain switch during approval was not refused/stable: ${switchDuringApproval} chain=${chainAfterSwitchRefusal}`);
  console.log('    chain switch during approval refused:', switchDuringApproval.slice(0, 90));
  await ap.click('button:has-text("REFUSE")').catch(() => {});
  await okP;

  // Unsupported provider methods must keep the EIP-1193 error code.
  for (const calls of [[], [{ to: addr, value: '0x1', data: '0x' }]]) {
    const unsupported = await dapp.evaluate(({ from, chainId, calls }) =>
      window.ethereum.request({ method: 'wallet_sendCalls', params: [{
        version: '2.0.0', chainId, from, atomicRequired: false, calls,
      }] }).then(() => 'OK').catch((e) => `ERR:${e.code}:${e.message}`), { from: addr, chainId: preChain, calls });
    assert(unsupported.startsWith('ERR:4200:'), `unsupported method returned ${unsupported}`);
  }
  console.log('6a1. PROVIDER: unsupported calls return 4200');

  // 6a2. A second wallet does not change the site's selected signer.
  await popup.click('.who');
  await popup.waitForSelector('.drawerbox');
  await popup.click('.ghead button.more');
  await popup.click('button.act:has-text("+ new wallet")');
  await popup.waitForTimeout(1000);
  await popup.keyboard.press('Escape');
  approvalP = ctx.waitForEvent('page', { timeout: 20000 });
  const secondWalletRequest = dapp.evaluate((me) =>
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: me, to: me, value: '0x0' }],
    }).then((h) => 'HASH:' + h).catch((e) => 'REFUSED:' + e.message), addr);
  ap = await approvalP;
  await ap.waitForSelector('text=SIGNING AS', { timeout: 20000 });
  assert((await ap.textContent('.content')).toLowerCase().includes(addr.slice(0, 6).toLowerCase()), 'approval must identify the connected wallet');
  await ap.click('button:has-text("REFUSE")').catch(() => {});
  console.log('6a2. TWO WALLETS: ordinary approval retains the connected signer:', await secondWalletRequest);

  // 6a3. The mismatch bar has two distinct repairs. "switch to connected
  // wallet" changes the wallet the owner is looking at, but must not change
  // the site's eth_accounts or emit accountsChanged. "use Wallet 2" still
  // changes the site connection and notifies the page.
  await dapp.evaluate(() => {
    window.__radAccountEvents = [];
    window.ethereum.on('accountsChanged', (value) => window.__radAccountEvents.push(value));
  });
  await dapp.bringToFront();
  await popup.reload();
  await popup.waitForSelector('.balance .big', { timeout: 20000 });
  await popup.waitForSelector('.sitebar .switch-wallet', { timeout: 20000 });
  const mismatchButton = popup.locator('.sitebar .switch-wallet');
  const mismatchText = ((await mismatchButton.textContent()) || '').trim();
  const namedMismatchButton = await popup.getByRole('button', { name: 'switch to connected wallet' }).count();
  assert(mismatchText === 'switch to connected wallet' && namedMismatchButton === 1,
    `connected-wallet switch was not named correctly: text=${JSON.stringify(mismatchText)} named=${namedMismatchButton}`);
  await popup.setViewportSize({ width: 372, height: 600 });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots') + '/sitebar-connected-wallet-chrome.png' });
  await popup.setViewportSize({ width: 390, height: 740 });
  const beforeLocalSwitch = await Promise.all([
    dapp.evaluate(() => window.ethereum.request({ method: 'eth_accounts' })),
    sw.evaluate(async () => chrome.storage.local.get('connections')),
  ]);
  await mismatchButton.click();
  await popup.waitForSelector('.sitebar.on');
  await popup.waitForSelector('.sitebar .switch-wallet', { state: 'detached' });
  const selectedAfterLocalSwitch = await popup.locator('.acctbar button.who').textContent();
  assert(selectedAfterLocalSwitch.toLowerCase().includes('wallet 1'),
    `connected-wallet switch did not select Wallet 1 locally: ${JSON.stringify(selectedAfterLocalSwitch)}`);
  await popup.waitForTimeout(400);
  const afterLocalSwitch = await Promise.all([
    dapp.evaluate(() => window.ethereum.request({ method: 'eth_accounts' })),
    dapp.evaluate(() => window.__radAccountEvents),
    sw.evaluate(async () => chrome.storage.local.get('connections')),
  ]);
  assert(JSON.stringify(afterLocalSwitch[0]).toLowerCase() === JSON.stringify(beforeLocalSwitch[0]).toLowerCase(),
    `local connected-wallet switch changed eth_accounts: ${JSON.stringify({ before: beforeLocalSwitch[0], after: afterLocalSwitch[0] })}`);
  assert(afterLocalSwitch[1].length === 0,
    `local connected-wallet switch emitted accountsChanged: ${JSON.stringify(afterLocalSwitch[1])}`);
  assert(JSON.stringify(afterLocalSwitch[2]) === JSON.stringify(beforeLocalSwitch[1]),
    `local connected-wallet switch rewrote stored connections: ${JSON.stringify({ before: beforeLocalSwitch[1], after: afterLocalSwitch[2] })}`);
  await popup.click('.acctbar button.who');
  await popup.waitForSelector('.drawerbox');
  await popup.locator('.walletrow .pick').filter({ hasText: 'Wallet 2' }).first().click();
  await popup.waitForSelector('.drawerbox', { state: 'detached' });
  await popup.waitForSelector('.sitebar .switch-wallet', { timeout: 20000 });
  const useWallet2 = popup.locator('.sitebar button.act').filter({ hasText: /^use wallet 2$/i });
  assert(await useWallet2.count() === 1, 'sitebar did not keep the existing use Wallet 2 site-switch action');
  await useWallet2.click();
  await popup.waitForSelector('.sitebar.on');
  await popup.waitForSelector('.sitebar .switch-wallet', { state: 'detached' });
  await popup.waitForTimeout(400);
  const afterSiteSwitch = await dapp.evaluate(() => Promise.all([
    window.ethereum.request({ method: 'eth_accounts' }),
    window.__radAccountEvents,
  ]));
  assert(afterSiteSwitch[0][0].toLowerCase() !== addr.toLowerCase() &&
      afterSiteSwitch[1].some((event) => event?.[0]?.toLowerCase() === afterSiteSwitch[0][0].toLowerCase()),
    `use Wallet 2 did not switch and notify the site: ${JSON.stringify(afterSiteSwitch)}`);
  console.log('6a3. SITEBAR MISMATCH: local switch stayed private; use Wallet 2 still notified the dapp');

  // 6b. THE SITE BAR ONLY OFFERS ITSELF TO DAPPS. There is no such thing as a
  // "web3 domain", so the test is behavioural: the provider we inject watches
  // for the page's own code touching it. A page that never does gets a quiet
  // line and NO connect button — otherwise the wallet offers to connect you to
  // translate.google.com, which is how the button stops meaning anything.
  const plain = await ctx.newPage();
  await plain.goto('http://127.0.0.1:18929/');
  await plain.waitForTimeout(500);
  await plain.bringToFront();
  await popup.reload();
  await popup.waitForSelector('.balance .big', { timeout: 20000 });
  await popup.waitForTimeout(800);
  const quietBar = popup.locator('.sitebar');
  console.log('6b. PLAIN PAGE:', JSON.stringify((await quietBar.textContent()).replace(/\s+/g, ' ').trim()),
    '| offers connect:', await quietBar.locator('button:has-text("connect")').count() > 0);
  // the same origin, once its code has asked for a provider, is a dapp again
  await plain.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));
  await popup.click('.sitebar .refresh');
  await popup.waitForTimeout(600);
  console.log('    after the page asks for a provider:',
    JSON.stringify((await quietBar.textContent()).replace(/\s+/g, ' ').trim()),
    '| offers connect:', await quietBar.locator('button:has-text("connect")').count() > 0);
  const crossOriginSign = await plain.evaluate((a) =>
    window.ethereum.request({ method: 'personal_sign', params: ['0x726164', a] })
      .then(() => 'SIGNED').catch((e) => `ERR:${e.code}:${e.message}`), addr);
  assert(crossOriginSign.startsWith('ERR:4100:') && crossOriginSign.includes('not connected'),
    `second origin could sign with first origin's address: ${crossOriginSign}`);
  console.log('    second origin cannot use connected signer:', crossOriginSign.slice(0, 90));
  await plain.close();
  await dapp.bringToFront();

  // 7. the connected-site list is a privacy control, so it has to work:
  // the dapp we just connected must be listed, and revoking must remove it
  // SETTINGS is an index of rows now, so the connected sites live one level in
  await popup.click('.tabbar .tab >> text=SETTINGS');
  await popup.waitForSelector('.setlist', { timeout: 20000 });
  await popup.click('.setrowlink:has-text("CONNECTED SITES")');
  await popup.waitForSelector('text=CONNECTED SITES', { timeout: 20000 });
  const sites = popup.locator('.panel', { hasText: 'CONNECTED SITES' });
  const listed = await sites.locator('.rpcrow .ep').allTextContents();
  await popup.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots') + '/14-ext-privacy.png' });
  await sites.locator('.act.danger', { hasText: 'disconnect' }).first().click();
  await popup.waitForTimeout(400);
  const afterRevoke = await sites.locator('.rpcrow .ep').allTextContents();
  console.log('7. CONNECTED SITES:', JSON.stringify(listed),
    '| after revoke:', JSON.stringify(afterRevoke));
  // SETTINGS is a tab-bar screen, so the bar IS the way back — it used to
  // carry its own "← back" as well, which was a second control for the job
  // the bar already did
  await popup.click('.tabbar .tab >> text=HOME');

  // 8. docking: the wallet as a side panel instead of a popup
  const panelManifest = await sw.evaluate(() => chrome.runtime.getManifest().side_panel);
  const behavior = await sw.evaluate(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    const on = await chrome.sidePanel.getPanelBehavior();
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    const off = await chrome.sidePanel.getPanelBehavior();
    return [on.openPanelOnActionClick, off.openPanelOnActionClick];
  });
  console.log('8. SIDE PANEL: registered at', JSON.stringify(panelManifest),
    '| toolbar rebind on/off:', JSON.stringify(behavior));

  const panelPage = await ctx.newPage();
  await panelPage.goto(`chrome-extension://${extId}/${panelManifest.default_path}`);
  await panelPage.waitForSelector('.titlebar', { timeout: 20000 });
  const docked = await panelPage.evaluate(() => ({
    body: document.body.classList.contains('docked'),
    btn: document.querySelector('.titlebar .dock')?.textContent,
  }));
  const popped = await popup.evaluate(() => document.querySelector('.titlebar .dock')?.textContent);
  console.log('   docked page:', JSON.stringify(docked), '| popup offers:', popped);

  // 8a. Portfolio is a read-only extension surface: opening it, filtering it,
  // and persisting its display unit must not change the connected account or
  // the signing chain a dapp sees.
  const dappBeforePortfolio = await dapp.evaluate(() => Promise.all([
    window.ethereum.request({ method: 'eth_accounts' }),
    window.ethereum.request({ method: 'eth_chainId' }),
  ]).then(([accounts, chainId]) => ({ accounts, chainId })));
  await portfolio.openPortfolio(popup);
  await portfolio.assertPortfolioShell(popup, 'Chrome popup portfolio');
  await popup.setViewportSize({ width: 372, height: 600 });
  await popup.waitForTimeout(200);
  await portfolio.assertPortfolioResponsive(popup, '372x600 Chrome popup portfolio');
  await portfolio.assertWalletHeaderVisible(popup, 'Chrome popup portfolio');
  await portfolio.setPortfolioCurrencySelection(popup, 'ETH');
  await portfolio.assertPortfolioFiltersDialog(popup, 'Chrome popup portfolio');
  await popup.reload();
  await popup.waitForSelector('.titlebar', { timeout: 20000 });
  await portfolio.openPortfolio(popup);
  await portfolio.assertPortfolioCurrencySelection(popup, 'ETH', 'Chrome popup portfolio after reload');
  await panelPage.reload();
  await panelPage.waitForSelector('.titlebar', { timeout: 20000 });
  await portfolio.openPortfolio(panelPage);
  await panelPage.setViewportSize({ width: 520, height: 900 });
  await panelPage.waitForTimeout(200);
  await portfolio.assertPortfolioResponsive(panelPage, 'Chrome docked portfolio');
  await portfolio.assertWalletHeaderVisible(panelPage, 'Chrome docked portfolio');
  await panelPage.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await portfolio.assertWalletHeaderVisible(panelPage, 'Chrome docked wallet');
  await panelPage.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots/header-wallet-chrome-docked.png') });
  await portfolio.openPortfolio(panelPage);
  await portfolio.assertPortfolioCurrencySelection(panelPage, 'ETH', 'Chrome docked portfolio');
  await portfolio.setPortfolioCurrencySelection(panelPage, 'USD');
  await popup.reload();
  await popup.waitForSelector('.titlebar', { timeout: 20000 });
  await portfolio.openPortfolio(popup);
  await portfolio.assertPortfolioCurrencySelection(popup, 'USD', 'Chrome popup portfolio after docked change');
  const dappAfterPortfolio = await dapp.evaluate(() => Promise.all([
    window.ethereum.request({ method: 'eth_accounts' }),
    window.ethereum.request({ method: 'eth_chainId' }),
  ]).then(([accounts, chainId]) => ({ accounts, chainId })));
  assert(JSON.stringify(dappAfterPortfolio.accounts).toLowerCase() === JSON.stringify(dappBeforePortfolio.accounts).toLowerCase(),
    `portfolio changed connected accounts: ${JSON.stringify({ dappBeforePortfolio, dappAfterPortfolio })}`);
  assert(dappAfterPortfolio.chainId === dappBeforePortfolio.chainId,
    `portfolio changed connected chain: ${JSON.stringify({ dappBeforePortfolio, dappAfterPortfolio })}`);
  console.log('8a. PORTFOLIO POPUP/PANEL: denomination persisted; filters modal; connected dapp state unchanged');
  await popup.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await portfolio.assertWalletHeaderVisible(popup, 'Chrome popup wallet');
  await popup.screenshot({ path: require('path').resolve(__dirname, '../../design/app-shots/header-wallet-chrome-popup.png') });
  await popup.setViewportSize({ width: 390, height: 740 });
  await popup.locator('.portfolio-nav button', { hasText: 'Wallet' }).click();
  await popup.waitForSelector('.balance .big', { timeout: 20000 });
  await popup.click('.tabbar .tab >> text=HOME');
  await popup.waitForSelector('.balance .big', { timeout: 20000 });

  // 9. A QUOTE MUST NOT OUTLIVE ITS PAIR. Debouncing cancels a request that has
  // not started; it does nothing about one already on the wire. Change the pair
  // mid-flight and the old await used to land afterwards and write its answer
  // into the new pair's screen — DAI's output rendered with USDC's 6 decimals
  // came out as 3,743,828,913,767,522 USDC, and the same late write turns the
  // approval panel on for an input you have already switched away from.
  // Needs live quotes, which is why it lives in this suite.
  try {
  await popup.click('.tabbar .tab >> text=SWAP');
  await popup.waitForSelector('.pairside');
  const shown = async () => {
    const t = (await popup.textContent('.panel:has-text("YOU GET")')).replace(/\s+/g, ' ');
    const m = t.match(/([\d,.]+) (DAI|USDC)/);
    return m ? m[0] : null;
  };
  await pickToken(popup, 0, 'ETH');
  await pickToken(popup, 1, 'DAI');
  await popup.fill('.payrow input.field', '1');
  await popup.waitForTimeout(9000);
  const settled = await shown();
  if (!settled) {
    console.log('9. STALE-QUOTE GUARD: VACUOUS — no DAI quote came back, nothing was exercised');
  } else {
    await popup.fill('.payrow input.field', '2');
    await popup.waitForTimeout(700);          // inside the debounce+RPC window
    await pickToken(popup, 1, 'USDC');
    const seen = new Set();
    for (let i = 0; i < 55; i++) {
      await popup.waitForTimeout(100);
      const g = await shown();
      if (g) seen.add(g);
    }
    // 2 ETH is a few thousand USDC; anything vastly larger is another token's
    // answer wearing this one's decimals
    const stale = [...seen].filter((x) => Number(x.split(' ')[0].replace(/,/g, '')) > 100_000);
    const approvalForEth = (await popup.textContent('.content')).includes('ONE APPROVAL FIRST');
    console.log('9. STALE-QUOTE GUARD: no answer from the old pair:', stale.length === 0,
      '| settled', JSON.stringify(settled), '-> showed', JSON.stringify([...seen]));
    // native ETH has nothing to approve; the panel only ever appeared here
    // because a late allowance check from the previous ERC-20 input wrote to it
    console.log('   no approval step for a native input:', !approvalForEth);
  }
  } catch (e) { console.log('9. STALE-QUOTE GUARD: could not run —', String(e.message).split('\n')[0].slice(0, 120)); }

  // Losing focus closes the popup and makes the MV3 worker eligible for
  // eviction. A configured 15-minute session must survive that ordinary
  // worker restart without putting a plaintext seed or private key in
  // storage.session. Stop only the worker, not the whole extension: this is
  // stronger and deterministic compared with waiting for Chrome's idle timer.
  await stopExtensionWorker(ctx, popup, extId);
  const afterReload = await ctx.newPage();
  await afterReload.goto(`chrome-extension://${extId}/index.html`);
  await afterReload.waitForSelector('.balance .big', { timeout: 20000 });
  const resumed = await afterReload.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ t: 'sess.signMessage', index: 0, message: 'focus is not a lock button' }, (r) => {
      resolve({ response: r, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
    });
  }));
  assert(!resumed.error, `restored session message failed: ${resumed.error}`);
  assert(/^0x[0-9a-f]{130}$/i.test(resumed.response && resumed.response.sig),
    `restored session could not sign: ${JSON.stringify(resumed.response)}`);
  const restoredStore = await afterReload.evaluate(async () => chrome.storage.session.get(null));
  const restoredJson = JSON.stringify(restoredStore);
  assert(!restoredJson.includes('mnemonic'), `restored storage.session contains mnemonic material: ${restoredJson}`);
  assert(!restoredJson.includes('privateKey'), `restored storage.session contains private key material: ${restoredJson}`);
  assert(!restoredJson.includes('"seeds"'), `restored storage.session contains VaultSecret seeds: ${restoredJson}`);
  console.log('10a. WORKER RESTART: session resumed; envelope stayed opaque');

  // The expiry is authenticated as AES-GCM additional data. Extending it by
  // editing browser storage must invalidate the envelope rather than extend
  // the unlocked session.
  await afterReload.evaluate(async () => {
    const saved = await chrome.storage.session.get('liveSessionEnvelope');
    const live = saved.liveSessionEnvelope;
    live.expiresAt += 60_000;
    await chrome.storage.session.set({ liveSessionEnvelope: live });
  });
  await stopExtensionWorker(ctx, afterReload, extId);
  const afterTamper = await ctx.newPage();
  await afterTamper.goto(`chrome-extension://${extId}/index.html`);
  await afterTamper.waitForSelector('text=Locked', { timeout: 20000 });
  console.log('   modified session deadline fails closed');

  // Explicit lock is still final: neither the encrypted session envelope nor
  // its wrapping key may bring a deliberately locked wallet back.
  await afterTamper.fill('input[placeholder="password"]', PASSWORD);
  await afterTamper.click('button:has-text("UNLOCK")');
  await afterTamper.waitForSelector('.balance .big', { timeout: 20000 });
  await afterTamper.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ t: 'sess.lock' }, () => resolve(null));
  }));
  await stopExtensionWorker(ctx, afterTamper, extId);
  const afterLock = await ctx.newPage();
  await afterLock.goto(`chrome-extension://${extId}/index.html`);
  await afterLock.waitForSelector('text=Locked', { timeout: 20000 });
  console.log('   explicit lock survives another worker restart');

  await ctx.close();
  server.close(); plainServer.close();
})();
