/** Source-level browser regression; isolated Vite server, public fixture accounts, no signing. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { decodeFunctionData, encodeAbiParameters, erc20Abi, parseAbi, parseUnits } from 'viem';
import { fileURLToPath } from 'node:url';

const owner = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const otherRecipient = '0x4444444444444444444444444444444444444444';
const token = '0x3333333333333333333333333333333333333333';
const rad = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB';
const server = await createServer({
  root: fileURLToPath(new URL('../../apps/wallet', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chromium', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const errors = [];
const rpc = [];
let releaseOld;
let oldPreviewArrived;
const oldPreview = new Promise((resolve) => { oldPreviewArrived = resolve; });
const oldGate = new Promise((resolve) => { releaseOld = resolve; });
let quoteOut = parseUnits('9007199254740993.000000000000000001', 18);
const initialQuoteOut = quoteOut;
try {
  await context.addInitScript(({ owner, origin }) => {
    const stored = {
      chainId: '1', pools: JSON.stringify(Object.fromEntries([1, 8453, 42161, 4663, 11155111, 84532, 46630]
        .map((chain) => [chain, { endpoints: [`${origin}/quantity-rpc`], epoch: 0 }]))),
    };
    window.__sends = [];
    const status = { locked: false, accounts: [{ index: 0, address: owner,
      label: 'Wallet 1', groupId: 'fixture', groupLabel: 'Fixture', kind: 'hd', pathIndex: 0, labels: [],
    }], stealthMetas: {}, labels: [] };
    const chrome = window.chrome ?? {};
    chrome.runtime = { id: 'quantity-fixture', onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        if (message.t === 'sess.status') callback(status);
        else if (message.t === 'sess.sendTx') {
          window.__sends.push(message);
          callback({ hash: `0x${'a'.repeat(64)}` });
        } else if (message.t === 'sess.swapBest') throw new Error('Signing must not replace the displayed quote');
        else callback?.(null);
      },
    };
    chrome.storage = { local: {
      get(key, callback) { callback({ [key]: stored[key] }); },
      set(items, callback) { Object.assign(stored, items); callback?.(); },
    } };
    window.chrome = chrome;
  }, { owner, origin });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    errors.push(`Unexpected external network request: ${new URL(route.request().url()).host}`);
    await route.abort();
  });
  await context.route('**/quantity-rpc', async (route) => {
    const body = route.request().postDataJSON();
    rpc.push(body);
    let result = '0x';
    if (body.method === 'eth_call') {
      const call = body.params[0];
      if (call.data?.startsWith('0xa9059cbb')) {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (decoded.args[1] === 1_000_001n && decoded.args[0].toLowerCase() === recipient) {
          oldPreviewArrived(); await oldGate;
        }
      } else if (call.to?.toLowerCase() === '0x1f98431c8ad98523631ae4a59f267346ea31f984') {
        result = `0x${'0'.repeat(24)}5555555555555555555555555555555555555555`;
      } else if (call.to?.toLowerCase() === '0x61ffe014ba17989e743c5f6cb21bf9697530b21e') {
        result = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }], [quoteOut, 0n, 0, 50000n]);
      }
    } else if (body.method === 'eth_estimateGas') result = '0xc350';
    else if (body.method === 'eth_gasPrice') result = '0x1';
    else if (body.method === 'eth_blockNumber') result = '0x123';
    else if (body.method === 'eth_getTransactionReceipt') result = null;
    else if (body.method === 'eth_getBalance') result = '0x0';
    else if (body.method === 'eth_getBlockByNumber') result = { number: '0x123', timestamp: '0x1234567', transactions: [], baseFeePerGas: '0x1' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?approve=quantity-fixture`);
  await page.getByText('waiting for the request…').waitFor({ timeout: 15000 }).catch(async (error) => { console.error('INITIAL UI', await page.locator('body').innerText(), 'RUNTIME', errors); throw error; });
  await page.evaluate(async ({ token }) => {
    const state = await import('/src/state.ts');
    window.__state = state;
    state.balances.value = [{ symbol: 'USDC', name: 'USD Coin', address: token, chainId: 8453,
      decimals: 6, amount: '100', raw: 100_000_000n }];
    state.openSend({ kind: 'erc20', chainId: 8453, address: token, symbol: 'USDC', name: 'USD Coin',
      decimals: 6, balance: '100', balanceRaw: 100_000_000n });
  }, { token });
  const amount = page.getByPlaceholder('amount in USDC');
  const destination = page.getByPlaceholder('0x… or name.eth');
  const simulate = page.getByRole('button', { name: 'SIMULATE FIRST (ALWAYS)', exact: true });
  await destination.fill(recipient);
  await amount.fill('1.0000009');
  assert.equal(await simulate.isEnabled(), false, 'unrepresentable send amount must be refused');
  await amount.fill('1.000001');
  await simulate.click();
  await oldPreview;
  await amount.fill('2.000002');
  await destination.fill(otherRecipient);
  releaseOld();
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: 'SIGN & SEND', exact: true }).count(), 0, 'old preview must not authorize edited input');
  await simulate.click();
  await page.getByRole('button', { name: 'SIGN & SEND', exact: true }).click();
  const [send] = await page.evaluate(() => window.__sends);
  const sent = decodeFunctionData({ abi: erc20Abi, data: send.tx.data });
  assert.equal(sent.args[0].toLowerCase(), otherRecipient);
  assert.equal(sent.args[1], 2_000_002n);
  assert.equal(send.chainId, 8453);
  assert.ok(rpc.some((call) => call.method === 'eth_call' && call.params[0].data === send.tx.data), 'sent bytes must be the checked bytes');
  console.log('PASS SEND: excess precision blocked; stale response ignored; captured exact recipient/amount/chain');
  await page.getByRole('button', { name: 'DONE', exact: true }).click();
  await page.evaluate(({ token }) => {
    window.__state.openSend({ kind: 'erc20', chainId: 8453, address: token, symbol: 'USDC', name: 'USD Coin',
      decimals: 6, balance: '100', balanceRaw: 100_000_000n });
  }, { token });
  await destination.fill(otherRecipient);
  await amount.fill('1.000001');
  await simulate.click();
  await page.getByRole('button', { name: 'SIGN & SEND', exact: true }).waitFor();
  await page.evaluate(({ token }) => {
    window.__state.balances.value = [{ symbol: 'USDC', name: 'USD Coin', address: token, chainId: 8453,
      decimals: 18, amount: '100', raw: 100n * 10n ** 18n }];
  }, { token });
  await page.getByRole('button', { name: 'SIGN & SEND', exact: true }).waitFor({ state: 'detached' });
  await amount.fill('1.000000000000000001');
  await simulate.click();
  await page.getByRole('button', { name: 'SIGN & SEND', exact: true }).click();
  const [, changedSend] = await page.evaluate(() => window.__sends);
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: changedSend.tx.data }).args[1], 1_000_000_000_000_000_001n);
  console.log('PASS SEND METADATA: changed decimals invalidate prior preview; 18-decimal amount encoded exactly');
  await page.getByRole('button', { name: 'DONE', exact: true }).click();
  await page.evaluate(async () => {
    const s = window.__state;
    s.chainId.value = 1;
    s.balances.value = [{ symbol: 'ETH', name: 'Ether', chainId: 1, decimals: 18, amount: '1', raw: 10n ** 18n }];
    s.screen.value = 'swap';
  });
  const minRow = page.locator('tr').filter({ hasText: 'Minimum you receive' });
  await minRow.waitFor();
  const exactMinimum = initialQuoteOut * 9900n / 10000n;
  const minString = `${exactMinimum / 10n ** 18n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    + '.' + `${exactMinimum % 10n ** 18n}`.padStart(18, '0').replace(/0+$/, '');
  assert.ok((await minRow.textContent()).includes(minString), 'displayed minimum must retain exact token units');
  const slippage = page.getByRole('textbox', { name: 'maximum slippage percent' });
  await slippage.fill('0.005');
  assert.equal(await page.getByRole('button', { name: 'SWAP ETH → $RAD', exact: true }).isEnabled(), false, 'slippage must not silently round to a basis point');
  await slippage.fill('1.0');
  await minRow.waitFor();
  quoteOut = 1n; // a fresh quote would now be much worse
  await page.getByRole('button', { name: 'SWAP ETH → $RAD', exact: true }).click();
  await page.waitForFunction(() => window.__sends.length === 3);
  const [, , swap] = await page.evaluate(() => window.__sends);
  const swapDecoded = decodeFunctionData({ abi: parseAbi([
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256)',
  ]), data: swap.tx.data });
  assert.equal(swapDecoded.args[0].amountOutMinimum, exactMinimum, 'signing must preserve displayed minOut instead of re-quoting');
  assert.equal(swapDecoded.args[0].amountIn, parseUnits('0.10', 18));
  assert.equal(swapDecoded.args[0].tokenOut.toLowerCase(), rad.toLowerCase());
  console.log('PASS SWAP: exact minimum displayed and encoded; unsupported slippage refused; signing preserves displayed quote');
  assert.deepEqual(errors, [], 'real source UI must have no runtime errors');
} finally {
  releaseOld?.();
  await context.close();
  await browser.close();
  await server.close();
}
