import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex } from 'viem';
import { SCAN_CHAIN_IDS, type WalletAccount } from '@radwallet/core';
import {
  accounts,
  balances,
  poolsAll,
  readUsdRate,
  refresh,
  usdRate,
  usdRateError,
} from '../src/state.ts';

const multicall3Abi = [{
  type: 'function',
  name: 'aggregate3',
  stateMutability: 'payable',
  inputs: [{
    name: 'calls',
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'allowFailure', type: 'bool' },
      { name: 'callData', type: 'bytes' },
    ],
  }],
  outputs: [{
    name: 'returnData',
    type: 'tuple[]',
    components: [
      { name: 'success', type: 'bool' },
      { name: 'returnData', type: 'bytes' },
    ],
  }],
}] as const;

type RpcRequest = { id?: number | string | null; method: string; params?: unknown[] };

/** one USDC fetches 0.0004 ETH on every fee tier, so ETH reads as $2,500 */
const ETH_PER_USDC = 400_000_000_000_000n;

/** a node that answers every quoter probe, and nothing else */
async function quoterRpc(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const answer = (request: RpcRequest) => {
        if (request.method !== 'eth_call') return { jsonrpc: '2.0', id: request.id ?? null, result: '0x1' };
        const data = (request.params?.[0] as { data?: Hex } | undefined)?.data ?? '0x';
        const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly unknown[];
        const quote = encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
          [ETH_PER_USDC, 0n, 0, 0n],
        );
        const rows = calls.map(() => ({ success: true, returnData: quote }));
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: rows }),
        };
      };
      const request = JSON.parse(body) as RpcRequest | RpcRequest[];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
    });
  });
  return listen(server);
}

/** a node that refuses every request, the way a throttled public RPC does */
async function refusingRpc(): Promise<{ url: string; close(): Promise<void> }> {
  return listen(createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limited"}}');
  }));
}

async function listen(server: Server): Promise<{ url: string; close(): Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function pools(byChain: Record<number, string>): void {
  poolsAll.value = Object.fromEntries(Object.entries(byChain).map(([id, url]) => [
    Number(id), { endpoints: [url], epoch: 0 },
  ]));
}

function wallet(): WalletAccount {
  return {
    index: 0,
    address: '0x00000000000000000000000000000000000000a1',
    label: 'wallet 1',
    named: false,
    kind: 'hd',
    groupId: 'seed-1',
    groupLabel: 'seed #1',
    hdIndex: 0,
    labels: [],
  };
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('usd rate: falls back to Base when Ethereum cannot answer', async () => {
  const refusing = await refusingRpc();
  const quoter = await quoterRpc();
  try {
    pools({ 1: refusing.url, 8453: quoter.url });
    usdRateError.value = 'stale';
    const rate = await readUsdRate();
    assert.equal(rate, 2500);
    assert.equal(usdRateError.value, null);
  } finally {
    await refusing.close();
    await quoter.close();
  }
});

test('usd rate: a failed read names each chain it asked', async () => {
  const refusing = await refusingRpc();
  try {
    pools({ 1: refusing.url, 8453: refusing.url });
    assert.equal(await readUsdRate(), null);
    const host = new URL(refusing.url).host;
    // a throttled node, not "no pool": the rate limit's own JSON-RPC code
    assert.equal(usdRateError.value, `Ethereum — ${host}: RPC error -32005 · Base — ${host}: RPC error -32005`);
  } finally {
    await refusing.close();
  }
});

test('usd rate: a refresh whose read fails keeps the last good rate', async () => {
  const refusing = await refusingRpc();
  try {
    pools(Object.fromEntries(SCAN_CHAIN_IDS.map((id) => [id, refusing.url])));
    accounts.value = [wallet()];
    balances.value = [];
    usdRate.value = 2400;
    usdRateError.value = null;
    await refresh();
    await until(() => usdRateError.value !== null, 'the refresh to try the rate');
    assert.equal(usdRate.value, 2400);
  } finally {
    accounts.value = [];
    await refusing.close();
  }
});
