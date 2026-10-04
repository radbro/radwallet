/**
 * A plain local Anvil proves the custom-network boundary without a fork or
 * public RPC: Settings probes its actual id, persists the wallet-owned record,
 * and the injected provider recognises that record while refusing a page's
 * replacement RPC URL.
 *
 * Needs: `anvil` on PATH and Playwright's bundled Chromium.
 */
const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.CUSTOM_NETWORK_ANVIL_PORT || 18546);
const DAPP_PORT = PORT + 1000;
const NODE_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const PROFILE = path.join(os.tmpdir(), `radwallet-e2e-custom-network-${PORT}`);
const LOG = path.join(os.tmpdir(), `radwallet-e2e-custom-network-${PORT}.log`);
const SEED = 'test test test test test test test test test test test junk';
const PASSWORD = 'hunter2hunter2rad';
const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/custom-assets');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params = []) {
  const response = await fetch(NODE_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function startAnvil() {
  if (spawnSync('anvil', ['--version'], { encoding: 'utf8' }).status !== 0) {
    throw new Error('anvil not on PATH — install Foundry with foundryup');
  }
  const log = fs.openSync(LOG, 'w');
  const proc = spawn('anvil', ['--chain-id', String(CHAIN_ID), '--port', String(PORT), '--silent'], {
    stdio: ['ignore', log, log],
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await rpc('eth_chainId'); return proc; } catch { await sleep(250); }
  }
  proc.kill();
  throw new Error(`anvil never answered on ${NODE_URL}`);
}

/** Deploy contracts owned by Anvil's public development account, never a user key. */
function deployFixture(contract) {
  const deployed = spawnSync('forge', [
    'create', `${contract}.sol:${contract}`, '--root', FIXTURE_ROOT,
    '--rpc-url', NODE_URL, '--unlocked', '--from', ANVIL_ACCOUNT, '--broadcast', '--json',
  ], { encoding: 'utf8' });
  if (deployed.status !== 0) throw new Error(`could not deploy ${contract}: ${deployed.stderr || deployed.stdout}`);
  let receipt;
  try { receipt = JSON.parse(deployed.stdout); } catch { throw new Error(`could not parse ${contract} deployment`); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(receipt.deployedTo || '')) {
    throw new Error(`${contract} deployment did not return an address`);
  }
  return receipt.deployedTo;
}

(async () => {
  const anvil = await startAnvil();
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  };
  let context;
  let dappServer;
  try {
    check('the local node reports Anvil chain 31337', parseInt(await rpc('eth_chainId'), 16) === CHAIN_ID);
    const fixtures = {
      token: deployFixture('LocalAnvilToken'),
      collection: deployFixture('LocalAnvilCollection'),
    };
    fs.rmSync(PROFILE, { recursive: true, force: true });
    const extension = path.resolve(__dirname, '../../apps/extension/dist');
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: process.env.E2E_CHANNEL || 'chromium',
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--headless=new'],
      viewport: { width: 390, height: 780 },
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/index.html`);
    await popup.click('text=I ALREADY HAVE ONE');
    await popup.fill('textarea.field', SEED);
    await popup.fill('input[placeholder="new local password"]', PASSWORD);
    await popup.click('button:has-text("IMPORT")');
    await popup.waitForSelector('.balance .big', { timeout: 30_000 });
    await popup.click('.tabbar .tab >> text=SETTINGS');
    await popup.click('.setrowlink:has-text("NETWORKS")');
    await popup.waitForSelector('text=ADD CUSTOM NETWORK', { timeout: 20_000 });

    await popup.getByLabel('custom network name').fill('Local Anvil');
    await popup.getByLabel('custom network RPC URL').fill(NODE_URL);
    await popup.getByLabel('custom network native symbol').fill('ETH');
    await popup.getByRole('button', { name: 'ADD NETWORK' }).click();
    await popup.waitForSelector(`.rpcrow:has-text("Local Anvil · ${NODE_URL}")`, { timeout: 20_000 });
    await popup.screenshot({ path: path.join(os.tmpdir(), 'radwallet-custom-network.png'), fullPage: true });

    const saved = await worker.evaluate(() => new Promise((resolve) =>
      chrome.storage.local.get(['customNetworks', 'pools', 'chainId'], resolve)));
    const networks = JSON.parse(saved.customNetworks || '[]');
    const pools = JSON.parse(saved.pools || '{}');
    check('Settings saved the owner-configured Anvil identity',
      networks.length === 1 && networks[0].id === CHAIN_ID && networks[0].endpoint === NODE_URL
        && networks[0].testnet === true, JSON.stringify(networks));
    check('the custom network uses only its own endpoint',
      saved.chainId === String(CHAIN_ID) && pools[CHAIN_ID]?.endpoints?.join(',') === NODE_URL,
      JSON.stringify({ chainId: saved.chainId, pool: pools[CHAIN_ID] }));

    await popup.click('.tabbar .tab >> text=HOME');
    await popup.getByLabel('add a token or collection by address').click();
    const list = popup.getByRole('dialog', { name: 'token list' });
    await list.getByRole('button', { name: 'Local Anvil', exact: true }).waitFor({ timeout: 20_000 });
    await list.getByPlaceholder('0x… token or NFT contract').fill(fixtures.token);
    await list.getByRole('button', { name: 'ADD IT', exact: true }).click();
    await popup.waitForFunction(async ({ address, chainId }) => {
      const saved = await new Promise((resolve) => chrome.storage.local.get('customTokens', resolve));
      return JSON.parse(saved.customTokens || '{}')[chainId]
        ?.some((token) => token.address.toLowerCase() === address.toLowerCase());
    }, { address: fixtures.token, chainId: CHAIN_ID }, { timeout: 20_000 });
    await popup.getByTitle('Local Anvil Token details').waitFor({ timeout: 20_000 });
    check('a custom ERC-20 is probed and shown on its owner-added network', true, fixtures.token);

    await popup.getByLabel('add a token or collection by address').click();
    const collectionList = popup.getByRole('dialog', { name: 'token list' });
    await collectionList.getByPlaceholder('0x… token or NFT contract').fill(fixtures.collection);
    await collectionList.getByRole('button', { name: 'ADD IT', exact: true }).click();
    await popup.waitForFunction(async ({ address, chainId }) => {
      const saved = await new Promise((resolve) => chrome.storage.local.get('customCollections', resolve));
      return JSON.parse(saved.customCollections || '{}')[chainId]
        ?.some((collection) => collection.address.toLowerCase() === address.toLowerCase());
    }, { address: fixtures.collection, chainId: CHAIN_ID }, { timeout: 20_000 });
    await popup.click('.tabbar .tab >> text=NFTS');
    await popup.getByText('Local Anvil Collection', { exact: true }).waitFor({ timeout: 20_000 });
    await popup.getByText('#7', { exact: true }).waitFor({ timeout: 20_000 });
    await popup.screenshot({ path: path.join(os.tmpdir(), 'radwallet-custom-assets.png'), fullPage: true });
    check('a custom ERC-721 is scanned and rendered on its owner-added network', true, fixtures.collection);

    dappServer = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>local dapp</title>');
    });
    await new Promise((resolve) => dappServer.listen(DAPP_PORT, '127.0.0.1', resolve));
    const dapp = await context.newPage();
    await dapp.goto(`http://127.0.0.1:${DAPP_PORT}/`);
    const approval = context.waitForEvent('page', { timeout: 20_000 });
    const connect = dapp.evaluate(() => window.ethereum.request({ method: 'eth_requestAccounts' }));
    const approvePage = await approval;
    await approvePage.getByRole('button', { name: 'CONNECT' }).click();
    await connect;
    await dapp.evaluate(() => {
      window.__radChainEvents = [];
      window.ethereum.on('chainChanged', (id) => window.__radChainEvents.push(id));
    });
    await popup.click('.tabbar .tab >> text=HOME');
    const networkFilter = '[aria-label="filter the asset list by network"]';
    await popup.selectOption(networkFilter, '1');
    await dapp.waitForFunction(() => window.__radChainEvents.includes('0x1'), { timeout: 20_000 });
    await popup.selectOption(networkFilter, String(CHAIN_ID));
    await dapp.waitForFunction(() => window.__radChainEvents.includes('0x7a69'), { timeout: 20_000 });
    const walletSwitch = await dapp.evaluate(async () => ({
      current: await window.ethereum.request({ method: 'eth_chainId' }),
      events: window.__radChainEvents,
    }));
    check('a wallet-owned network change updates an open dapp',
      walletSwitch.current === '0x7a69'
        && walletSwitch.events.includes('0x1') && walletSwitch.events.includes('0x7a69'),
      JSON.stringify(walletSwitch));
    const dappResult = await dapp.evaluate(async (chainId) => {
      const current = await window.ethereum.request({ method: 'eth_chainId' });
      const added = await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId, chainName: 'site says something else', rpcUrls: ['https://site-controlled.example'] }],
      });
      return { current, added };
    }, `0x${CHAIN_ID.toString(16)}`);
    const afterDapp = await worker.evaluate(() => new Promise((resolve) =>
      chrome.storage.local.get(['customNetworks', 'pools'], resolve)));
    check('the service worker reloads the custom chain for the injected provider',
      dappResult.current === `0x${CHAIN_ID.toString(16)}` && dappResult.added === null,
      JSON.stringify(dappResult));
    check('a website cannot replace the custom network RPC URL',
      JSON.parse(afterDapp.pools || '{}')[CHAIN_ID]?.endpoints?.join(',') === NODE_URL,
      afterDapp.pools || '');
  } finally {
    if (context) await context.close();
    if (dappServer) await new Promise((resolve) => dappServer.close(resolve));
    anvil.kill();
  }
  if (failures) process.exitCode = 1;
})();
