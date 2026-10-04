const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const http = require('http');
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type','text/html'); res.end('<h1>dapp</h1>'); });
  await new Promise((r) => server.listen(18927, '127.0.0.1', r));
  const ext = require('path').resolve(__dirname, '../../apps/extension/dist');
  // fresh profile per suite: a reused one keeps the previous run's wallet and
  // selected chain, which breaks "MAKE A NEW WALLET" and the default-chain assert
  const profile = require('path').join(require('os').tmpdir(), 'radwallet-e2e-chains');
  require('fs').rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
    ignoreHTTPSErrors: true,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

  const dapp = await ctx.newPage();
  await dapp.goto('http://127.0.0.1:18927/');
  await dapp.waitForTimeout(800);

  console.log('chainId (default):', await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' })));

  // A page may discover the selected chain before connecting, but it cannot
  // use our RPC pool or mutate wallet state. Switching happens inside the
  // wallet UI where the user sees the context.
  console.log('net_version (default):', await dapp.evaluate(() => window.ethereum.request({ method: 'net_version' })));
  const preconnectRead = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'eth_blockNumber' })
      .then(() => 'LEAKED').catch((e) => 'REFUSED code=' + e.code));
  console.log('pre-connect RPC:', preconnectRead, '| private:', preconnectRead.includes('4100'));
  const sw1 = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] })
      .then(() => 'SWITCHED').catch((e) => 'REFUSED code=' + e.code));
  console.log('pre-connect switch to Base:', sw1, '| refused:', sw1.includes('4100'));
  console.log('chainId (after):', await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' })));

  // unsupported chain refused — WITH the code, because a message-only
  // rejection is one a dapp cannot classify, and it stalls mid-handshake
  // instead of falling back to wallet_addEthereumChain
  const bad = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x539' }] })
      .then(() => 'OK').catch((e) => 'REFUSED code=' + e.code));
  console.log('unsupported chain:', bad.replace(' code=4902', ''), '| EIP-3326 code:', bad.includes('4902'));

  // EIP-3085: a site may offer us a whole chain definition, RPC URL included.
  // We take the chain id and DROP the endpoint — a page-chosen node would see
  // every call this wallet makes. Unknown chain: refused outright.
  const added = await dapp.evaluate(() =>
    window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x539', rpcUrls: ['https://evil.example/rpc'], chainName: 'Trust Me' }],
    }).then(() => 'ACCEPTED').catch((e) => 'REFUSED: ' + e.message));
  console.log('site-supplied chain + RPC:', added.startsWith('REFUSED') ? 'REFUSED' : added);
  console.log('   reason given:', added.replace('REFUSED: ', '').slice(0, 78));

  // Even a bundled chain cannot be silently selected by a page. The wallet UI
  // owns that decision; the dapp receives a classified refusal.
  const known = await dapp.evaluate(() =>
    window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xb626' }] })
      .then(() => 'ADDED').catch((e) => 'REFUSED code=' + e.code));
  console.log('pre-connect bundled addEthereumChain:', known, '| refused:', known.includes('4100'));
  console.log('chain still stable:', await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' })));

  await ctx.close(); server.close();
})();
