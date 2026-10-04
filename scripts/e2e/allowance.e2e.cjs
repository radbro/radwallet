/**
 * Deterministic approval UI regression. Run after npm run build.
 * Loads the real built wallet with a public-account-only extension bridge and
 * intercepted RPC replies. Captures the approval message; no keys or signing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = (() => { try { return require('playwright'); } catch { return require('playwright-core'); } })();
const { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, parseUnits } = require('viem');

const dist = process.env.ALLOWANCE_DIST_DIR
  ? path.resolve(process.env.ALLOWANCE_DIST_DIR)
  : path.resolve(__dirname, '../../apps/wallet/dist');
const origin = 'http://127.0.0.1:18931';
const owner = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const replacementToken = '0x4444444444444444444444444444444444444444';
const spender = '0x3333333333333333333333333333333333333333';
const approve = (amount) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function openApproval(browser, decimals, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 430, height: 900 } });
  const rpc = [];
  const unexpected = [];
  const errors = [];
  const metadata = deferred();
  const heldPreview = deferred();
  const request = {
    id: `allowance-${decimals}`, origin: 'https://allowance-fixture.invalid',
    method: 'eth_sendTransaction',
    params: [options.transaction ?? { from: owner, to: token, data: approve(options.requestedAmount ?? maxUint256) }],
    // The selected wallet remains on Ethereum; token units must come from
    // the approval's Base endpoint, never the selected network's endpoint.
    chainId: 8453, endpoint: `${origin}/request-rpc`,
  };
  await context.addInitScript(({ request, owner, origin }) => {
    const storage = {
      chainId: '1',
      pools: JSON.stringify({
        1: { endpoints: [`${origin}/selected-rpc`], epoch: 0 },
        8453: { endpoints: [`${origin}/approval-pool-rpc`], epoch: 0 },
      }),
    };
    const status = { locked: false, accounts: [{
      index: 0, address: owner, label: 'Wallet 1', groupId: 'fixture',
      groupLabel: 'Fixture', kind: 'hd', pathIndex: 0, labels: [],
    }], stealthMetas: {}, labels: [] };
    window.__resolved = [];
    window.__setApproval = null;
    window.close = () => {};
    const chrome = window.chrome ?? {};
    chrome.runtime = {
      id: 'allowance-fixture',
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        if (message.t === 'sess.status') callback(status);
        else if (message.type === 'get-approval') {
          window.__setApproval = callback;
          callback(request);
        } else if (message.type === 'resolve-approval') {
          window.__resolved.push(message);
          callback({ ok: true, result: `0x${'b'.repeat(64)}` });
        } else callback?.(null);
      },
    };
    chrome.storage = { local: {
      get(key, callback) { callback({ [key]: storage[key] }); },
      set(items, callback) { Object.assign(storage, items); callback?.(); },
    } };
    window.chrome = chrome;
  }, { request, owner, origin });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpected.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname.endsWith('-rpc')) {
      const body = route.request().postDataJSON();
      rpc.push({ url: url.href, ...body });
      let result;
      let error;
      if (body.method === 'eth_call' && body.params[0].data === '0x313ce567') {
        const replacement = body.params[0].to === replacementToken;
        if (!replacement) await metadata.promise;
        const tokenDecimals = replacement ? options.replacementDecimals : decimals;
        if (tokenDecimals === null) result = '0x';
        else result = `0x${tokenDecimals.toString(16).padStart(64, '0')}`;
      } else if (body.method === 'eth_call') {
        if (options.holdAmount !== undefined && body.params[0].data === approve(options.holdAmount)) {
          await heldPreview.promise;
          error = { code: 3, message: 'execution reverted: stale preview' };
        } else result = '0x';
      } else if (body.method === 'eth_estimateGas') result = '0xc350';
      else if (body.method === 'eth_gasPrice') result = '0x3b9aca00';
      else if (body.method === 'eth_blockNumber') result = '0x123';
      else if (body.method === 'eth_getTransactionCount') result = '0x0';
      else if (body.method === 'eth_getBlockByNumber') result = { number: '0x123', baseFeePerGas: '0x3b9aca00', transactions: [] };
      else if (body.method === 'eth_maxPriorityFeePerGas') result = '0x1';
      else if (body.method === 'eth_simulateV1') result = [{ calls: [{ status: '0x1', gasUsed: '0xc350', logs: [] }] }];
      else {
        unexpected.push(body.method);
        error = { code: -32601, message: 'Fixture has no signing or broadcast method' };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(error ? { error } : { result }) }) });
      return;
    }
    const file = path.resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    assert.ok(file.startsWith(`${dist}/`), 'asset path must stay in the built wallet');
    if (!fs.existsSync(file)) { await route.fulfill({ status: 404, body: '' }); return; }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream';
    await route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html?approve=${request.id}`);
  const input = page.getByRole('textbox', { name: 'Token spending limit' });
  const sign = page.getByRole('button', { name: options.finite ? 'SIGN IT' : 'SIGN REWRITTEN', exact: true });
  try {
    if (options.finite || options.requestedAmount !== undefined) {
      await page.getByText('WHO IS ASKING', { exact: true }).waitFor();
    } else {
      await input.waitFor();
      await page.getByRole('status').filter({ hasText: 'Checking token decimals' }).waitFor();
      assert.equal(await sign.isEnabled(), false, 'signing must wait for token metadata');
    }
  } catch (error) {
    console.error({ pageErrors: errors, unexpected, body: await page.locator('body').innerText() });
    throw error;
  }
  return {
    page, input, sign, rpc, request, metadata, heldPreview,
    async close() {
      metadata.resolve(); heldPreview.resolve();
      await context.close();
      assert.deepEqual(errors, [], 'built UI must not throw');
      assert.deepEqual(unexpected, [], 'fixture must make no external or signing request');
    },
  };
}

async function waitEnabled(page, button) {
  await button.waitFor();
  await page.waitForFunction((element) => !element.disabled, await button.elementHandle());
  assert.equal(await button.isEnabled(), true);
}

(async () => {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'build the wallet before running allowance.e2e.cjs');
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined, headless: true,
  });
  try {
    const ordinary = await openApproval(browser, 6, {
      finite: true, transaction: { from: owner, to: spender, value: '0x1', data: '0x' },
    });
    try {
      await waitEnabled(ordinary.page, ordinary.sign);
      assert.ok((await ordinary.page.textContent('.content')).includes('0.000000000000000001 ETH'), 'ordinary approval must show a nonzero exact one-wei value');
      assert.equal(ordinary.rpc.some((call) => call.method === 'eth_call' && call.params[0].data === '0x313ce567'), false, 'ordinary transactions do not need token metadata');
      await ordinary.sign.click();
      const [message] = await ordinary.page.evaluate(() => window.__resolved);
      assert.equal(message.override, undefined, 'ordinary transactions remain unchanged');
      assert.ok(ordinary.rpc.some((call) => call.method === 'eth_call' && call.url === ordinary.request.endpoint
        && call.params[0].value === '0x1'), 'ordinary exact value must be simulated on the approval endpoint');
      console.log('PASS ordinary approval: exact native value, request endpoint, no allowance metadata dependency');
    } finally { await ordinary.close(); }

    const finite = await openApproval(browser, 6, { finite: true, requestedAmount: 123_456_789n });
    try {
      assert.equal(await finite.sign.isEnabled(), false, 'finite approvals must wait for verified token units');
      finite.metadata.resolve();
      await finite.page.locator('.panel').filter({ hasText: 'TOKEN SPENDING LIMIT' }).waitFor({ timeout: 1500 });
      await finite.sign.click();
      assert.ok((await finite.page.textContent('.content')).includes('123.456789 tokens'), 'ordinary finite allowance must show its exact token quantity');
      const [message] = await finite.page.evaluate(() => window.__resolved);
      assert.equal(message.override, undefined, 'ordinary finite approval must preserve the requested calldata');
      assert.ok(finite.rpc.some((call) => call.method === 'eth_call' && call.url === finite.request.endpoint
        && call.params[0].data === approve(123_456_789n)), 'ordinary finite approval must preview its displayed amount');
      console.log('PASS finite allowance: verified token units, exact visible quantity, original calldata retained');
    } finally { await finite.close(); }

    for (const decimals of [6, 18]) {
      const fixture = await openApproval(browser, decimals);
      try {
        const { page, input, sign, rpc } = fixture;
        fixture.metadata.resolve();
        await waitEnabled(page, sign);
        assert.equal(await input.inputValue(), '100');
        assert.ok(rpc.some((call) => call.method === 'eth_call'
          && call.params[0].data === approve(100n * 10n ** BigInt(decimals))), 'default 100 tokens must use verified token units');
        const metadataCalls = rpc.filter((call) => call.method === 'eth_call' && call.params[0].data === '0x313ce567');
        assert.equal(metadataCalls.length, 1);
        assert.equal(metadataCalls[0].url, fixture.request.endpoint, 'decimals must use the request endpoint');
        assert.equal(metadataCalls[0].params[0].to, token);
        for (const invalid of ['', '-1', '1e3', 'NaN', `0.${'0'.repeat(decimals)}9`]) {
          await input.fill(invalid);
          await page.getByRole('status').waitFor();
          assert.equal(await sign.isEnabled(), false, `must refuse invalid amount ${invalid}`);
          assert.equal(await page.evaluate(() => window.__resolved.length), 0);
        }
        const exact = `100.${'0'.repeat(decimals - 1)}1`;
        await input.fill(exact);
        await waitEnabled(page, sign);
        await sign.click();
        const [message] = await page.evaluate(() => window.__resolved);
        const decoded = decodeFunctionData({ abi: erc20Abi, data: message.override.tx.data });
        assert.equal(decoded.functionName, 'approve');
        assert.equal(decoded.args[0], spender);
        assert.equal(decoded.args[1], parseUnits(exact, decimals));
        assert.ok(rpc.some((call) => call.method === 'eth_call' && call.url === fixture.request.endpoint
          && call.params[0].data === message.override.tx.data), 'outgoing calldata must have been previewed');
        assert.ok(rpc.some((call) => call.method === 'eth_simulateV1'
          && call.url === `${origin}/approval-pool-rpc`
          && call.params[0].blockStateCalls[0].calls[0].data === message.override.tx.data), 'asset simulation must use the rewritten amount on the approval chain');
        console.log(`PASS ${decimals}-decimal token: pending/invalid amounts blocked; captured exact ${decoded.args[1]} base units and matching simulation`);
      } finally { await fixture.close(); }
    }

    const missing = await openApproval(browser, null);
    try {
      missing.metadata.resolve();
      await missing.page.getByRole('status').filter({ hasText: 'Could not read token decimals' }).waitFor();
      assert.equal(await missing.sign.isEnabled(), false);
      await missing.input.fill('100');
      assert.equal(await missing.sign.isEnabled(), false, 'missing metadata must never fall back to 18 decimals');
      assert.equal(await missing.page.evaluate(() => window.__resolved.length), 0);
      console.log('PASS missing decimals: exact approval remains blocked');
    } finally { await missing.close(); }

    const changed = await openApproval(browser, null, { replacementDecimals: 18 });
    try {
      const replacement = { ...changed.request, id: 'replacement-request',
        endpoint: `${origin}/replacement-rpc`,
        params: [{ from: owner, to: replacementToken, data: approve(maxUint256) }],
      };
      await changed.page.evaluate((request) => window.__setApproval(request), replacement);
      await waitEnabled(changed.page, changed.sign);
      changed.metadata.resolve();
      await changed.page.waitForTimeout(200);
      assert.equal(await changed.sign.isEnabled(), true, 'an old missing-decimals response cannot replace current metadata');
      await changed.sign.click();
      const [message] = await changed.page.evaluate(() => window.__resolved);
      assert.equal(message.id, replacement.id);
      assert.equal(message.override.tx.to, replacementToken);
      assert.equal(decodeFunctionData({ abi: erc20Abi, data: message.override.tx.data }).args[1], 100n * 10n ** 18n);
      console.log('PASS changed request: stale missing metadata ignored; replacement token retains verified units');
    } finally { await changed.close(); }

    const stale = await openApproval(browser, 6, { holdAmount: 100_000_001n, requestedAmount: 10n ** 27n + 1n });
    try {
      stale.metadata.resolve();
      await waitEnabled(stale.page, stale.sign);
      assert.ok((await stale.page.textContent('.content')).includes('1000000000000000000000.000001 tokens'), 'requested allowance must display all six decimal places');
      await stale.input.fill('100.000001');
      await stale.page.waitForTimeout(100);
      assert.equal(await stale.sign.isEnabled(), false, 'signing must wait for this exact preview');
      await stale.input.fill('200.000002');
      await waitEnabled(stale.page, stale.sign);
      stale.heldPreview.resolve();
      await stale.page.waitForTimeout(200);
      assert.equal(await stale.sign.isEnabled(), true, 'an older failed preview cannot overwrite the current successful preview');
      await stale.sign.click();
      const [message] = await stale.page.evaluate(() => window.__resolved);
      assert.equal(decodeFunctionData({ abi: erc20Abi, data: message.override.tx.data }).args[1], 200_000_002n);
      console.log('PASS updated amount: stale simulation ignored; displayed allowance preserves exact precision');
    } finally { await stale.close(); }

    const largeFinite = await openApproval(browser, 6, { finite: true, requestedAmount: 10n ** 15n });
    try {
      largeFinite.metadata.resolve();
      const sign = largeFinite.page.getByRole('button', { name: 'SIGN REWRITTEN', exact: true });
      await waitEnabled(largeFinite.page, sign);
      assert.ok((await largeFinite.page.textContent('.content')).includes('1000000000 tokens'));
      assert.ok((await largeFinite.page.textContent('.content')).includes('A VERY LARGE SPENDING LIMIT'));
      await sign.click();
      const [message] = await largeFinite.page.evaluate(() => window.__resolved);
      assert.equal(decodeFunctionData({ abi: erc20Abi, data: message.override.tx.data }).args[1], 100_000_000n);
      console.log('PASS large finite allowance: six-decimal threshold normalized before rewriting');
    } finally { await largeFinite.close(); }

  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
