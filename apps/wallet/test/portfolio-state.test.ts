import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
} from 'viem';
import {
  CHAINS,
  SCAN_CHAIN_IDS,
  type PortfolioHolding,
  type WalletAccount,
} from '@radwallet/core';
import {
  accounts,
  assetEth,
  balances,
  customTokens,
  markPortfolioStale,
  poolsAll,
  portfolioErrors,
  portfolioEth,
  portfolioHoldings,
  portfolioStale,
  portfolioUpdatedAt,
  usdRate,
  valuingWallets,
  valueAllWallets,
  walletValueProgress,
  walletValues,
} from '../src/state.ts';

const ADDRESS = '0x00000000000000000000000000000000000000a1' as const;
const TOKEN = '0x00000000000000000000000000000000000000b0' as const;
const ONE_ETH = 1_000_000_000_000_000_000n;
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

type RpcRequest = {
  id?: number | string | null;
  method: string;
  params?: unknown[];
};

function account(): WalletAccount {
  return {
    index: 0,
    address: ADDRESS,
    label: 'wallet 1',
    named: false,
    kind: 'hd',
    groupId: 'seed-1',
    groupLabel: 'seed #1',
    hdIndex: 0,
    labels: [],
  };
}

function oldHolding(): PortfolioHolding {
  return {
    symbol: 'ETH',
    name: 'Ether',
    amount: '7',
    raw: 7n * ONE_ETH,
    decimals: 18,
    chainId: 1,
    walletAddress: ADDRESS,
    walletLabel: 'wallet 1',
    groupId: 'seed-1',
    groupLabel: 'seed #1',
    ethValue: 7,
  };
}

function hexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function slowPricingRpc(): Promise<{
  url: string;
  pricingRequested: Promise<void>;
  releasePricing(): void;
  close(): Promise<void>;
}> {
  const pricingRequested = deferred();
  const pricingReleased = deferred();
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      void (async () => {
        const request = JSON.parse(body) as RpcRequest | RpcRequest[];
        const payload = Array.isArray(request)
          ? await Promise.all(request.map((item) => answerRpc(item, pricingRequested, pricingReleased.promise)))
          : await answerRpc(request, pricingRequested, pricingReleased.promise);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      })().catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (error as Error).message }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    pricingRequested: pricingRequested.promise,
    releasePricing: () => pricingReleased.resolve(),
    close: () => closeServer(server),
  };
}

async function answerRpc(
  request: RpcRequest,
  pricingRequested: ReturnType<typeof deferred>,
  pricingReleased: Promise<void>,
): Promise<{ jsonrpc: '2.0'; id: RpcRequest['id']; result: unknown }> {
  if (request.method === 'eth_chainId') return rpcResult(request, '0x1');
  if (request.method === 'net_version') return rpcResult(request, '1');
  if (request.method === 'eth_getBalance') return rpcResult(request, hexQuantity(ONE_ETH));
  if (request.method === 'eth_call') {
    const call = request.params?.[0] as { data?: Hex } | undefined;
    return rpcResult(request, await answerMulticall(call?.data ?? '0x', pricingRequested, pricingReleased));
  }
  return rpcResult(request, '0x');
}

function rpcResult(request: RpcRequest, result: unknown): { jsonrpc: '2.0'; id: RpcRequest['id']; result: unknown } {
  return { jsonrpc: '2.0', id: request.id ?? null, result };
}

async function answerMulticall(
  data: Hex,
  pricingRequested: ReturnType<typeof deferred>,
  pricingReleased: Promise<void>,
): Promise<Hex> {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  const calls = decoded.args[0] as readonly { target: Hex; callData: Hex }[];
  const isPricing = calls.some((call) => !call.callData.startsWith('0x70a08231'));
  if (isPricing) {
    pricingRequested.resolve();
    await pricingReleased;
  }
  const rows = calls.map((call) => ({
    success: true,
    returnData: isPricing
      ? encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'uint160' },
          { type: 'uint32' },
          { type: 'uint256' },
        ],
        [1_000_000_000_000_000n, 0n, 0, 0n],
      )
      : encodeFunctionResult({
        abi: erc20Abi,
        functionName: 'balanceOf',
        result: call.target.toLowerCase() === TOKEN.toLowerCase() ? ONE_ETH : 0n,
      }),
  }));
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: rows });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resetPortfolioState(): void {
  accounts.value = [];
  customTokens.value = {};
  poolsAll.value = {};
  portfolioHoldings.value = [];
  portfolioUpdatedAt.value = null;
  portfolioErrors.value = {};
  portfolioStale.value = true;
  walletValues.value = {};
  balances.value = [];
  assetEth.value = {};
  portfolioEth.value = null;
  usdRate.value = null;
  walletValueProgress.value = null;
  valuingWallets.value = false;
}

test('portfolio state: stale mark during valueAllWallets pricing aborts portfolio and HOME publication', async () => {
  const rpc = await slowPricingRpc();
  const prior = oldHolding();
  resetPortfolioState();
  try {
    accounts.value = [account()];
    poolsAll.value = Object.fromEntries(SCAN_CHAIN_IDS.map((id) => [
      id,
      { endpoints: [rpc.url], epoch: 0 },
    ]));
    customTokens.value = {
      1: [{
        chainId: 1,
        address: TOKEN,
        symbol: 'MOCK',
        name: 'Mock Token',
        decimals: 18,
      }],
    };
    portfolioHoldings.value = [prior];
    portfolioUpdatedAt.value = 123;
    portfolioStale.value = false;
    walletValues.value = { [ADDRESS]: 7 };
    balances.value = [prior];
    assetEth.value = { '1:native': 7 };
    portfolioEth.value = 7;
    usdRate.value = 2000;

    const run = valueAllWallets();
    await timeout(rpc.pricingRequested, 2_000, 'pricing multicall was not requested');
    assert.equal(valuingWallets.value, true);
    assert.equal(walletValueProgress.value, 'PRICING');

    markPortfolioStale();
    rpc.releasePricing();
    await timeout(run, 2_000, 'valueAllWallets did not finish after pricing released');

    assert.equal(valuingWallets.value, false);
    assert.equal(walletValueProgress.value, null);
    assert.equal(portfolioStale.value, true);
    assert.equal(portfolioUpdatedAt.value, 123);
    assert.deepEqual(portfolioHoldings.value, [prior]);
    assert.deepEqual(walletValues.value, { [ADDRESS]: 7 });
    assert.equal(portfolioEth.value, 7);
    assert.deepEqual(assetEth.value, { '1:native': 7 });
    assert.deepEqual(balances.value, [prior]);
    assert.deepEqual(portfolioErrors.value, {});
  } finally {
    rpc.releasePricing();
    await rpc.close();
    resetPortfolioState();
    poolsAll.value = Object.fromEntries(SCAN_CHAIN_IDS.map((id) => [
      id,
      { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 },
    ]));
  }
});
