import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbiParameters,
  zeroAddress,
} from 'viem';
import type { DappTxRequest } from '../src/chain.js';
import {
  KYBER_HOST,
  KYBER_NATIVE,
  KYBER_ROUTER_ABI,
  KYBER_ROUTER_FOR,
  buildKyberApproveTx,
  buildKyberSwap,
  canUseKyberSwap,
  quoteKyberSwap,
  validateKyberSwapTx,
  type KyberRouteQuote,
} from '../src/aggregator.js';

const OWNER = '0x000000000000000000000000000000000000dEaD' as const;
const OTHER = '0x000000000000000000000000000000000000bEEF' as const;
const EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996' as const;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const WETH_RH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;
const USDG_RH = '0x94b53E072798E6cce65cF21f050d3CB9F2bFb058' as const;
const AMOUNT = 10_000_000_000_000_000n;
const OUT = 24_789_856n;
const MIN = 24_541_957n;

const SIMPLE_SWAP_DATA = parseAbiParameters(
  'address[] firstPools, uint256[] firstSwapAmounts, bytes[] swapDatas, uint256 deadline, bytes destTokenFeeData',
);

type FetchCall = { url: string; init?: RequestInit };
type Desc = {
  srcToken: `0x${string}`;
  dstToken: `0x${string}`;
  srcReceivers: `0x${string}`[];
  srcAmounts: bigint[];
  feeReceivers: `0x${string}`[];
  feeAmounts: bigint[];
  dstReceiver: `0x${string}`;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: `0x${string}`;
};

function installFetch(t: test.TestContext, handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const result = await handler(url, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function routeSummary(overrides: Record<string, unknown> = {}) {
  return {
    tokenIn: KYBER_NATIVE,
    tokenOut: USDC,
    amountIn: AMOUNT.toString(),
    amountOut: OUT.toString(),
    gas: '128253',
    routeID: 'fixture-route',
    checksum: 'fixture-checksum',
    timestamp: 1_786_000_000,
    route: [[{ exchange: 'UniswapV3', pool: '0x1111111111111111111111111111111111111111' }]],
    extraFee: { feeAmount: '', chargeFeeBy: '', isInBps: false, feeReceiver: '' },
    ...overrides,
  };
}

function routeResponse(summary = routeSummary(), router = KYBER_ROUTER_FOR[1]) {
  return { code: 0, message: 'OK', data: { routerAddress: router, routeSummary: summary } };
}

function baseDesc(overrides: Partial<Desc> = {}): Desc {
  return {
    srcToken: KYBER_NATIVE,
    dstToken: USDC,
    srcReceivers: [],
    srcAmounts: [],
    feeReceivers: [],
    feeAmounts: [],
    dstReceiver: OWNER,
    amount: AMOUNT,
    minReturnAmount: MIN,
    flags: 0x200n,
    permit: '0x',
    ...overrides,
  };
}

function swapTx(descOverrides: Partial<Desc> = {}, txOverrides: Partial<DappTxRequest> = {}): DappTxRequest {
  const desc = baseDesc(descOverrides);
  return {
    to: KYBER_ROUTER_FOR[1],
    value: desc.srcToken.toLowerCase() === KYBER_NATIVE.toLowerCase() ? `0x${desc.amount.toString(16)}` : '0x0',
    data: encodeFunctionData({
      abi: KYBER_ROUTER_ABI,
      functionName: 'swap',
      args: [{
        callTarget: EXECUTOR,
        approveTarget: zeroAddress,
        targetData: '0x1234',
        desc,
        clientData: '0x',
      }],
    }),
    ...txOverrides,
  };
}

function swapGenericTx(chainId: number): DappTxRequest {
  return {
    to: KYBER_ROUTER_FOR[chainId],
    value: '0x0',
    data: encodeFunctionData({
      abi: KYBER_ROUTER_ABI,
      functionName: 'swapGeneric',
      args: [{
        callTarget: EXECUTOR,
        approveTarget: zeroAddress,
        targetData: '0x1234',
        desc: baseDesc({
          srcToken: WETH_RH,
          dstToken: USDG_RH,
          srcReceivers: [EXECUTOR],
          srcAmounts: [AMOUNT],
          minReturnAmount: 5_884_588_574_878_083_475_045n,
        }),
        clientData: '0x',
      }],
    }),
  };
}

function simpleModeTx(descOverrides: Partial<Desc> = {}, amount = AMOUNT): DappTxRequest {
  const executorData = encodeAbiParameters(SIMPLE_SWAP_DATA, [[EXECUTOR], [amount], ['0x1234'], 9_999_999_999n, '0x']);
  return {
    to: KYBER_ROUTER_FOR[1],
    value: '0x0',
    data: encodeFunctionData({
      abi: KYBER_ROUTER_ABI,
      functionName: 'swapSimpleMode',
      args: [EXECUTOR, baseDesc({
        srcToken: WETH_RH,
        dstToken: USDC,
        srcReceivers: [EXECUTOR],
        srcAmounts: [amount],
        flags: 0x220n,
        ...descOverrides,
      }), executorData, '0x'],
    }),
  };
}

function quoteFixture(overrides: Partial<KyberRouteQuote> = {}): KyberRouteQuote {
  const summary = routeSummary();
  return {
    protocol: 'kyber',
    chainId: 1,
    chainName: 'ethereum',
    router: KYBER_ROUTER_FOR[1],
    tokenIn: KYBER_NATIVE,
    tokenOut: USDC,
    amountIn: AMOUNT,
    amountOut: OUT,
    minOut: MIN,
    slippageBps: 100,
    routeSummary: summary,
    routeLabel: 'kyberswap · UniswapV3',
    ...overrides,
  };
}

test('Kyber adapter is opt-in and never fetches when disabled', async (t) => {
  const calls = installFetch(t, () => { throw new Error('fetch should not run'); });
  const quote = await quoteKyberSwap({ enabled: false }, 1, OWNER, { address: null }, { address: USDC }, AMOUNT, 1);
  assert.equal(quote, null);
  assert.equal(calls.length, 0);
});

test('Kyber route quoting binds chain slug, owner, amount, pair and zero fee data', async (t) => {
  const calls = installFetch(t, () => routeResponse());
  const quote = await quoteKyberSwap({ enabled: true, timeoutMs: 500 }, 1, OWNER, { address: null }, { address: USDC }, AMOUNT, 1);
  assert.ok(quote);
  assert.equal(quote.chainName, 'ethereum');
  assert.equal(quote.amountOut, OUT);
  assert.equal(quote.minOut, 24_541_957n);
  assert.equal(quote.routeLabel, 'kyberswap · UniswapV3');
  assert.equal(canUseKyberSwap(1), true);
  assert.equal(canUseKyberSwap(4663), true);
  assert.equal(canUseKyberSwap(8453), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`^https://${KYBER_HOST}/ethereum/api/v1/routes\\?`));
  assert.match(calls[0].url, /amountIn=10000000000000000/);
  assert.match(calls[0].url, /origin=0x000000000000000000000000000000000000dEaD/);
  assert.equal(calls[0].init?.credentials, 'omit');
  assert.equal(calls[0].init?.referrerPolicy, 'no-referrer');
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-client-id'], 'RADWALLET');
});

test('Kyber route quoting rejects fee-bearing or tampered routes', async (t) => {
  installFetch(t, () => routeResponse(routeSummary({
    extraFee: { feeAmount: '1', chargeFeeBy: '', isInBps: false, feeReceiver: '' },
  })));
  await assert.rejects(
    quoteKyberSwap({ enabled: true }, 1, OWNER, { address: null }, { address: USDC }, AMOUNT, 1),
    /fee amount/,
  );
});


test('Kyber route quoting refuses a zero minimum return', async (t) => {
  installFetch(t, () => routeResponse(routeSummary({ amountOut: '1' })));
  await assert.rejects(
    quoteKyberSwap({ enabled: true }, 1, OWNER, { address: null }, { address: USDC }, AMOUNT, 1),
    /minimum is zero/,
  );
});

test('Kyber route quoting surfaces network failures', async (t) => {
  installFetch(t, () => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }));
  await assert.rejects(
    quoteKyberSwap({ enabled: true }, 1, OWNER, { address: null }, { address: USDC }, AMOUNT, 1),
    /KyberSwap 403: forbidden/,
  );
});

test('Kyber validator accepts exact native, ERC-20 and simple mode swaps', () => {
  assert.equal(validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx()), MIN);
  const erc20 = swapTx({ srcToken: WETH_RH, srcReceivers: [EXECUTOR], srcAmounts: [AMOUNT] });
  assert.equal(validateKyberSwapTx(1, OWNER, WETH_RH, USDC, AMOUNT, MIN, erc20), MIN);
  assert.equal(validateKyberSwapTx(1, OWNER, WETH_RH, USDC, AMOUNT, MIN, simpleModeTx()), MIN);
  assert.equal(validateKyberSwapTx(1, OWNER, WETH_RH, USDC, AMOUNT, MIN, simpleModeTx({
    srcReceivers: [], srcAmounts: [],
  })), MIN);
});

test('Kyber validator rejects router, recipient, pair, amount, value, min, fee and flag tampering', () => {
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, {
    ...swapTx(), to: OTHER,
  }), /unverified router/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    dstReceiver: OTHER,
  })), /recipient/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    dstToken: OTHER,
  })), /pair/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    amount: AMOUNT - 1n,
  })), /amount/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, {
    ...swapTx(), value: '0x0',
  }), /native value/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    minReturnAmount: MIN - 1n,
  })), /minimum/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    feeReceivers: [OTHER],
  })), /fee/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    flags: 0x201n,
  })), /unsupported flags/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, KYBER_NATIVE, USDC, AMOUNT, MIN, swapTx({
    permit: '0x1234',
  })), /permit/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, WETH_RH, USDC, AMOUNT, MIN, swapTx({
    srcToken: WETH_RH, srcReceivers: [zeroAddress], srcAmounts: [AMOUNT],
  })), /source receiver/);
  assert.throws(() => validateKyberSwapTx(1, OWNER, WETH_RH, USDC, 0n, MIN, simpleModeTx({ amount: 0n }, 0n)), /input amount/);
});

test('Kyber Robinhood validator rejects swapGeneric because the verified router lacks it', () => {
  assert.throws(
    () => validateKyberSwapTx(4663, OWNER, WETH_RH, USDG_RH, AMOUNT, 5_884_588_574_878_083_475_045n, swapGenericTx(4663)),
    /does not expose swapGeneric/,
  );
});

test('Kyber builder accepts V1 build responses without routeSummary and enforces the accepted floor', async (t) => {
  const quote = quoteFixture();
  let n = 0;
  const calls = installFetch(t, () => ({ code: 0, message: 'OK', data: {
    routerAddress: KYBER_ROUTER_FOR[1],
    amountOut: (n++ === 0 ? OUT : MIN - 1n).toString(),
    transactionValue: AMOUNT.toString(),
    data: swapTx().data,
  } }));
  const built = await buildKyberSwap({ enabled: true }, quote, OWNER, MIN);
  assert.equal(built.amountOut, OUT);
  assert.equal(built.minReturnAmount, MIN);
  assert.equal(JSON.parse(String(calls[0].init?.body)).slippageTolerance, 99);

  await assert.rejects(buildKyberSwap({ enabled: true }, quote, OWNER, MIN), /below the accepted floor/);
});

test('Kyber approval builder gives the fixed router exact allowance only', () => {
  const tx = buildKyberApproveTx(4663, WETH_RH, AMOUNT);
  assert.equal(tx.to, WETH_RH);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  assert.equal(decoded.functionName, 'approve');
  assert.equal(decoded.args[0], KYBER_ROUTER_FOR[4663]);
  assert.equal(decoded.args[1], AMOUNT);
});
