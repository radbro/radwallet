/** NFT sheet regression: demo shell, real NFT core reads, intercepted local RPC; no keys or writes. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const owner = '0x1111111111111111111111111111111111111111';
const collection = '0x2222222222222222222222222222222222222222';
const someoneElse = '0x3333333333333333333333333333333333333333';
const multicallAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const nftAbi = parseAbi([
  'function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const server = await createServer({
  root: fileURLToPath(new URL('../../apps/wallet', import.meta.url)),
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chromium', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 372, height: 600 } });
const errors = [];
const calls = [];
let holdPage = false;
let releasePage;
let sawHeldPage;
const heldRequest = new Promise((resolve) => { sawHeldPage = resolve; });
const pageGate = new Promise((resolve) => { releasePage = resolve; });
try {
  const shots = process.env.NFT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    errors.push(`Unexpected external request: ${new URL(route.request().url()).host}`);
    await route.abort();
  });
  await context.route('**/nft-rpc', async (route) => {
    const request = route.request().postDataJSON();
    assert.equal(request.method, 'eth_call', 'NFT reads must never sign or broadcast');
    const aggregate = decodeFunctionData({ abi: multicallAbi, data: request.params[0].data });
    const decoded = aggregate.args[0].map((call) => {
      assert.equal(call.target.toLowerCase(), collection);
      const nft = decodeFunctionData({ abi: nftAbi, data: call.callData });
      calls.push(nft);
      return nft;
    });
    if (holdPage && decoded.some((call) => call.functionName === 'tokenOfOwnerByIndex')) {
      sawHeldPage();
      await pageGate;
    }
    const results = decoded.map((call) => {
      let result;
      if (call.functionName === 'tokenOfOwnerByIndex') {
        assert.equal(call.args[0].toLowerCase(), owner);
        result = call.args[1];
      } else if (call.functionName === 'tokenURI') {
        result = `ipfs://fixture-metadata/${call.args[0]}`;
      } else {
        result = call.args[0] === 60n ? owner : someoneElse;
      }
      return { success: true, returnData: encodeFunctionResult({ abi: nftAbi, functionName: call.functionName, result }) };
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results }),
    }) });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.evaluate(async ({ owner, collection, origin }) => {
    const state = await import('/src/state.ts');
    await state.boot();
    if (!state.DEMO) throw new Error('NFT fixture requires demo mode');
    window.__nftState = state;
    window.__nftHolding = (manual = false) => ({
      chainId: 1, address: collection, name: 'Fixture Collection', symbol: 'FIXTURE',
      count: manual ? 2 : 30,
      tokenIds: manual ? [] : Array.from({ length: 24 }, (_, index) => String(index)),
      tokenUris: {}, enumerable: !manual, idSource: manual ? 'ownerOf' : 'enumerable',
      idCursor: manual ? 0 : 24, idsComplete: false,
    });
    state.accounts.value = [{ index: 0, address: owner, label: 'Fixture wallet',
      groupId: 'fixture', groupLabel: 'Fixture', kind: 'hd', pathIndex: 0, labels: [] }];
    state.selected.value = 0;
    state.chainId.value = 1;
    state.poolsAll.value = { 1: { endpoints: [`${origin}/nft-rpc`], epoch: 0 } };
    state.prefs.value = { ...state.prefs.value, loadArt: false };
    const holding = window.__nftHolding();
    state.nfts.value = [holding];
    state.screen.value = 'nfts';
    state.openNft.value = holding;
  }, { owner, collection, origin });
  const dialog = page.getByRole('dialog', { name: 'Fixture Collection' });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.nftitem').count(), 24);
  if (shots) await page.screenshot({ path: join(shots, 'nft-missing-ids.png') });
  await dialog.getByRole('button', { name: 'LOAD MORE IDS', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.drawer .nftitem').length === 30);
  const complete = await page.evaluate(() => window.__nftState.openNft.value);
  assert.equal(complete.idCursor, 30);
  assert.equal(complete.idsComplete, true);
  assert.deepEqual(complete.tokenIds, Array.from({ length: 30 }, (_, index) => String(index)));
  assert.equal(complete.tokenUris['29'], 'ipfs://fixture-metadata/29');
  assert.equal(await dialog.getByRole('button', { name: 'LOAD MORE IDS', exact: true }).count(), 0);
  assert.deepEqual(calls.filter((call) => call.functionName === 'tokenOfOwnerByIndex').map((call) => Number(call.args[1])), [24, 25, 26, 27, 28, 29]);
  console.log('PASS NFT pagination: 24 → 30 IDs with real multicall decoding and matching metadata');

  await dialog.getByTitle('close (esc)').click();
  await page.evaluate(() => {
    const holding = window.__nftHolding(true);
    window.__nftState.nfts.value = [holding];
    window.__nftState.openNft.value = holding;
  });
  const input = dialog.getByRole('textbox', { name: 'NFT token ID to check' });
  await input.fill('00060');
  await dialog.getByRole('button', { name: 'CHECK', exact: true }).click();
  await dialog.locator('.nftid').filter({ hasText: '#60 ↗' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__nftState.openNft.value.tokenIds), ['60']);
  if (shots) {
    await page.getByTitle('dismiss', { exact: true }).click();
    await dialog.locator('.nftid').filter({ hasText: '#60 ↗' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'nft-owned-id.png') });
  }
  await input.fill('61');
  await dialog.getByRole('button', { name: 'CHECK', exact: true }).click();
  await page.getByText('that token ID is not owned by this wallet', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__nftState.openNft.value.tokenIds), ['60']);
  assert.equal(await dialog.locator('.nftitem').count(), 1);
  console.log('PASS explicit NFT ID: verified owned ID normalized to 60; unowned 61 refused');

  await dialog.getByTitle('close (esc)').click();
  await page.evaluate(() => {
    const holding = window.__nftHolding();
    window.__nftState.nfts.value = [holding];
    window.__nftState.openNft.value = holding;
  });
  holdPage = true;
  await dialog.getByRole('button', { name: 'LOAD MORE IDS', exact: true }).click();
  await heldRequest;
  const lateMetadata = page.waitForResponse((response) => {
    if (!response.url().endsWith('/nft-rpc')) return false;
    const request = response.request().postDataJSON();
    const aggregate = decodeFunctionData({ abi: multicallAbi, data: request.params[0].data });
    return aggregate.args[0].length === 6 && aggregate.args[0].every((call) =>
      decodeFunctionData({ abi: nftAbi, data: call.callData }).functionName === 'tokenURI');
  });
  await dialog.getByTitle('close (esc)').click();
  releasePage();
  await (await lateMetadata).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('dialog', { name: 'Fixture Collection' }).count(), 0);
  assert.equal(await page.evaluate(() => window.__nftState.openNft.value), null);
  assert.equal(await page.evaluate(() => window.__nftState.nfts.value[0].tokenIds.length), 24);
  console.log('PASS closed NFT sheet: delayed page cannot reopen or update dismissed collection');
  assert.deepEqual(errors, [], 'fixture must have no runtime errors or external requests');
} finally {
  releasePage?.();
  await context.close();
  await browser.close();
  await server.close();
}
