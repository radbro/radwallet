#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Deterministic built-UI regressions for RADSWAP picking, routing and approval.
 *
 * The fixture loads apps/wallet/dist as an extension page, gives it a public
 * session status, and answers every RPC locally. It never exposes keys, signs,
 * or broadcasts. Selected tests capture session requests and return mock hashes;
 * the default fixture refuses them.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('playwright-core')); }
const {
  decodeFunctionData,
  encodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  parseUnits,
} = require('viem');

const repo = path.resolve(__dirname, '..', '..');
const dist = path.join(repo, 'apps', 'wallet', 'dist');
const origin = 'http://127.0.0.1:18932';
const screenshotPath = '/tmp/radwallet-swap-picker.png';
const pickerViewportScreenshotPath = '/tmp/radwallet-swap-picker-viewport.png';
const reviewViewportScreenshotPath = '/tmp/radwallet-swap-review-viewport.png';

const OWNER = '0x1111111111111111111111111111111111111111';
const OWNER_2 = '0x2222222222222222222222222222222222222222';
const UNKNOWN_RAD = '0x3333333333333333333333333333333333333333';
const SLOW_RAD = '0x4444444444444444444444444444444444444444';
const DEAD_TOKEN = '0x5555555555555555555555555555555555555555';
const OTHER_RAD = '0x6666666666666666666666666666666666666666';
const BAD_DECIMALS = '0x7777777777777777777777777777777777777777';
const INVALID_CHECKSUM = '0xA0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CANON_RAD = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MAINNET_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const HOOD_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const HOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const HOOD_RAD = '0x8888888888888888888888888888888888888888';
const KYBER_HOST = 'aggregator-api.kyberswap.com';
const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
}];

const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const kyberRouterAbi = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [{
      name: 'execution',
      type: 'tuple',
      components: [
        { name: 'callTarget', type: 'address' },
        { name: 'approveTarget', type: 'address' },
        { name: 'targetData', type: 'bytes' },
        {
          name: 'desc',
          type: 'tuple',
          components: [
            { name: 'srcToken', type: 'address' },
            { name: 'dstToken', type: 'address' },
            { name: 'srcReceivers', type: 'address[]' },
            { name: 'srcAmounts', type: 'uint256[]' },
            { name: 'feeReceivers', type: 'address[]' },
            { name: 'feeAmounts', type: 'uint256[]' },
            { name: 'dstReceiver', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'minReturnAmount', type: 'uint256' },
            { name: 'flags', type: 'uint256' },
            { name: 'permit', type: 'bytes' },
          ],
        },
        { name: 'clientData', type: 'bytes' },
      ],
    }],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
];

const quoterAbi = [
  {
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [
      { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
    inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
];

const tokenFixtures = new Map([
  [UNKNOWN_RAD.toLowerCase(), {
    chainId: 1, symbol: '$RAD', name: 'Shadow Radcoin', decimals: 18,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n },
  }],
  [SLOW_RAD.toLowerCase(), {
    chainId: 1, symbol: '$RAD', name: 'Slow Radcoin', decimals: 18,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n }, slow: true,
  }],
  [OTHER_RAD.toLowerCase(), {
    chainId: 1, symbol: '$RAD', name: 'Other Radcoin', decimals: 18,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n },
  }],
  [BAD_DECIMALS.toLowerCase(), {
    chainId: 1, symbol: 'BAD', name: 'Bad Decimals', decimals: 99,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n },
  }],
  [CANON_RAD.toLowerCase(), {
    chainId: 1, symbol: '$RAD', name: 'Radcoin', decimals: 18,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n },
  }],
  [HOOD_RAD.toLowerCase(), {
    chainId: 4663, symbol: 'HOOD', name: 'Robinhood Fixture Token', decimals: 18,
    balances: { [OWNER.toLowerCase()]: 0n, [OWNER_2.toLowerCase()]: 0n },
  }],
]);

function chainForRpc(pathname) {
  if (pathname === '/eth-rpc' || pathname === '/eth-fallback-rpc') return 1;
  if (pathname === '/base-rpc') return 8453;
  if (pathname === '/arb-rpc') return 42161;
  if (pathname === '/hood-rpc') return 4663;
  if (pathname === '/sepolia-rpc') return 11155111;
  if (pathname === '/base-sepolia-rpc') return 84532;
  return null;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function hexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function lowerAddress(value) {
  return String(value || '').toLowerCase();
}

function encodedUint(value) {
  return encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]);
}

function encodedString(value) {
  return encodeAbiParameters([{ type: 'string' }], [value]);
}

function quoterForChain(chainId) {
  if (chainId === 1) return MAINNET_QUOTER;
  if (chainId === 4663) return HOOD_QUOTER;
  return MAINNET_QUOTER;
}


function amountOutForKyberMode(mode) {
  if (mode === 'low') return parseUnits('4000', 18);
  if (mode === 'tie') return parseUnits('4242', 18);
  if (mode === 'robinhood') return parseUnits('5252', 18);
  return parseUnits('5000', 18);
}

function applyBps(amount, bps) {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

function shortContract(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function fileResponse(filePath) {
  const ext = path.extname(filePath);
  const contentType = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.svg' ? 'image/svg+xml'
          : ext === '.png' ? 'image/png'
            : ext === '.json' || ext === '.webmanifest' ? 'application/json; charset=utf-8'
              : 'application/octet-stream';
  return { status: 200, contentType, body: fs.readFileSync(filePath) };
}

function decodeMaybe(abi, data) {
  try { return decodeFunctionData({ abi, data }); }
  catch { return null; }
}

function isMetadataRead(name) {
  return name === 'symbol' || name === 'name' || name === 'decimals' || name === 'balanceOf';
}

function tokenResult(control, chainId, target, callData) {
  const decoded = decodeMaybe(erc20Abi, callData);
  if (!decoded) return { success: false, returnData: '0x' };
  const token = tokenFixtures.get(lowerAddress(target));
  if (!token || token.chainId !== chainId) return { success: false, returnData: '0x' };
  if (decoded.functionName === 'symbol') return { success: true, returnData: encodedString(token.symbol) };
  if (decoded.functionName === 'name') return { success: true, returnData: encodedString(token.name) };
  if (decoded.functionName === 'decimals') {
    return { success: true, returnData: encodeAbiParameters([{ type: 'uint8' }], [token.decimals]) };
  }
  if (decoded.functionName === 'balanceOf') {
    const [owner] = decoded.args;
    return { success: true, returnData: encodedUint(token.balances[lowerAddress(owner)] ?? 0n) };
  }
  if (decoded.functionName === 'allowance') {
    let amount = 0n;
    if (control.approvalTx && lowerAddress(target) === lowerAddress(control.approvalTx.to)
      && control.receiptState === 'success') {
      control.approvalAllowanceReads += 1;
      if (control.approvalAllowanceReads > control.allowanceLagReads) {
        const [spender, approved] = decodeFunctionData({
          abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
          data: control.approvalTx.data,
        }).args;
        if (lowerAddress(decoded.args[1]) === lowerAddress(spender)) amount = approved;
      }
    }
    return { success: true, returnData: encodedUint(amount) };
  }
  return { success: false, returnData: '0x' };
}

function quoterResult(control, chainId, target, callData) {
  const decoded = decodeMaybe(quoterAbi, callData);
  if (!decoded) return null;
  const amountOut = control.directQuoteOut ?? parseUnits('4242', 18);
  control.quoteCalls.push({ chainId, target: getAddress(target), functionName: decoded.functionName, args: decoded.args, callData });
  if (decoded.functionName === 'quoteExactInputSingle') {
    return {
      success: true,
      returnData: encodeFunctionResult({
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        result: [amountOut, 0n, 1, 100000n],
      }),
    };
  }
  return {
    success: true,
    returnData: encodeFunctionResult({
      abi: quoterAbi,
      functionName: 'quoteExactInput',
      result: [amountOut - 1n, [0n, 0n], [1, 1], 150000n],
    }),
  };
}

function analyzeInnerCall(chainId, call) {
  const target = lowerAddress(call.target);
  const decodedToken = decodeMaybe(erc20Abi, call.callData);
  return {
    chainId,
    target,
    functionName: decodedToken?.functionName ?? null,
    token: tokenFixtures.get(target) ?? null,
  };
}

async function multicallResult(control, chainId, data) {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  const calls = decoded.args[0];
  const analyzed = calls.map((call) => analyzeInnerCall(chainId, call));
  for (const read of analyzed) {
    if (read.functionName && isMetadataRead(read.functionName)) {
      control.metadataLookups.push({ chainId, address: getAddress(read.target), functionName: read.functionName });
    }
  }
  if (analyzed.some((read) => read.token?.slow && read.functionName && isMetadataRead(read.functionName))) {
    await control.releaseSlow.promise;
  }
  const results = calls.map((call) => {
    if (lowerAddress(call.target) === quoterForChain(chainId).toLowerCase()) {
      const quoted = quoterResult(control, chainId, call.target, call.callData);
      if (quoted) return quoted;
    }
    return tokenResult(control, chainId, call.target, call.callData);
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
}

function kyberRouteSummary(url, control, chainName) {
  const tokenIn = getAddress(url.searchParams.get('tokenIn') || KYBER_NATIVE);
  const tokenOut = getAddress(url.searchParams.get('tokenOut') || UNKNOWN_RAD);
  const amountIn = BigInt(url.searchParams.get('amountIn') || '0');
  const amountOut = amountOutForKyberMode(control.kyberMode);
  return {
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    extraFee: { feeAmount: '0', chargeFeeBy: '', feeReceiver: '' },
    route: [[{ exchange: chainName === 'robinhood' ? 'FixtureHoodAMM' : 'FixtureAMM' }]],
  };
}

function kyberSwapCalldata(routeSummary, recipient, slippageTolerance) {
  const amountIn = BigInt(routeSummary.amountIn);
  const amountOut = BigInt(routeSummary.amountOut);
  const minReturnAmount = applyBps(amountOut, Number(slippageTolerance ?? 100));
  const tokenIn = getAddress(routeSummary.tokenIn);
  const tokenOut = getAddress(routeSummary.tokenOut);
  const execution = {
    callTarget: KYBER_ROUTER,
    approveTarget: ZERO_ADDRESS,
    targetData: '0x',
    desc: {
      srcToken: tokenIn,
      dstToken: tokenOut,
      srcReceivers: [],
      srcAmounts: [],
      feeReceivers: [],
      feeAmounts: [],
      dstReceiver: getAddress(recipient),
      amount: amountIn,
      minReturnAmount,
      flags: 0n,
      permit: '0x',
    },
    clientData: '0x',
  };
  return {
    data: encodeFunctionData({ abi: kyberRouterAbi, functionName: 'swap', args: [execution] }),
    amountOut,
    minReturnAmount,
    transactionValue: tokenIn.toLowerCase() === KYBER_NATIVE.toLowerCase() ? amountIn : 0n,
  };
}

async function handleKyberApi(control, req, url) {
  const method = req.method();
  if (method === 'OPTIONS') {
    control.kyberRequests.push({ method, url: url.toString(), pathname: url.pathname, search: url.search, body: null });
    return { status: 204, json: null };
  }
  const body = method === 'POST' ? req.postDataJSON() : null;
  control.kyberRequests.push({ method, url: url.toString(), pathname: url.pathname, search: url.search, body });
  if (control.kyberMode === 'error') {
    return { status: 503, json: { code: 1, message: 'fixture kyber unavailable' } };
  }
  const [, chainName] = url.pathname.match(/^\/(ethereum|robinhood)\//) || [];
  if (!chainName) return { status: 404, json: { code: 1, message: 'unknown fixture chain' } };
  if (url.pathname.endsWith('/api/v1/routes')) {
    return {
      status: 200,
      json: {
        code: 0,
        message: 'OK',
        data: { routerAddress: KYBER_ROUTER, routeSummary: kyberRouteSummary(url, control, chainName) },
      },
    };
  }
  if (url.pathname.endsWith('/api/v1/route/build')) {
    const routeSummary = body?.routeSummary;
    const built = kyberSwapCalldata(routeSummary, body?.recipient || OWNER, body?.slippageTolerance ?? 100);
    return {
      status: 200,
      json: {
        code: 0,
        message: 'OK',
        data: {
          routerAddress: KYBER_ROUTER,
          amountOut: built.amountOut.toString(),
          data: built.data,
          transactionValue: built.transactionValue.toString(),
          routeSummary,
        },
      },
    };
  }
  return { status: 404, json: { code: 1, message: 'unknown fixture endpoint' } };
}

async function handleRpc(control, chainId, payload) {
  if (Array.isArray(payload)) return Promise.all(payload.map((one) => handleRpc(control, chainId, one)));
  const { id, method, params = [] } = payload;
  control.rpc.push({ chainId, method, params });
  let result;
  if (method === 'eth_chainId') result = hexQuantity(chainId);
  else if (method === 'eth_blockNumber') result = hexQuantity(0x12345n);
  else if (method === 'eth_getBalance') result = lowerAddress(params[0]) === OWNER_2.toLowerCase()
    ? hexQuantity(parseUnits('2', 18)) : hexQuantity(parseUnits('1', 18));
  else if (method === 'eth_call') {
    const call = params[0] || {};
    if (lowerAddress(call.to) === MULTICALL3.toLowerCase()) result = await multicallResult(control, chainId, call.data);
    else if (lowerAddress(call.to) === DEAD_TOKEN.toLowerCase()) result = '0x';
    else if (lowerAddress(call.to) === quoterForChain(chainId).toLowerCase()) {
      const quoted = quoterResult(control, chainId, call.to, call.data);
      result = quoted?.returnData ?? '0x';
    } else if (lowerAddress(call.to) === KYBER_ROUTER.toLowerCase()) {
      result = '0x';
    } else {
      const token = tokenResult(control, chainId, call.to, call.data);
      result = token.success ? token.returnData : encodedUint(0n);
    }
  } else if (method === 'eth_getBlockByNumber') {
    result = {
      number: hexQuantity(0x12345n), hash: `0x${'12'.repeat(32)}`, parentHash: `0x${'11'.repeat(32)}`,
      nonce: '0x0000000000000000', sha3Uncles: `0x${'00'.repeat(32)}`, logsBloom: `0x${'00'.repeat(256)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`, miner: `0x${'00'.repeat(20)}`,
      difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: '0x1c9c380',
      gasUsed: '0x0', timestamp: hexQuantity(1_900_000_000n), transactions: [], uncles: [],
      baseFeePerGas: hexQuantity(1_000_000_000n),
    };
  } else if (method === 'eth_getTransactionReceipt') {
    result = !control.approvalTx || control.receiptState === 'pending' ? null : {
      transactionHash: params[0], transactionIndex: '0x0', blockNumber: '0x12345',
      blockHash: `0x${'12'.repeat(32)}`, from: OWNER, to: control.approvalTx.to,
      cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
      contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`,
      status: control.receiptState === 'reverted' ? '0x0' : '0x1', type: '0x2',
    };
  } else if (method === 'eth_getLogs') result = [];
  else if (method === 'eth_gasPrice') result = hexQuantity(1_000_000_000n);
  else if (method === 'eth_maxPriorityFeePerGas') result = hexQuantity(1_000_000_000n);
  else if (method === 'eth_estimateGas') result = hexQuantity(250000n);
  else if (method === 'eth_getCode') result = '0x6000';
  else result = null;
  return { jsonrpc: '2.0', id, result };
}

function makeStatus() {
  const accountShape = (address, index, label) => ({
    address, index, label, named: true, kind: 'seed', groupId: 'fixture-seed', groupLabel: 'Fixture Seed',
    labels: [],
  });
  return {
    locked: false,
    accounts: [accountShape(OWNER, 0, 'Wallet 1'), accountShape(OWNER_2, 1, 'Wallet 2')],
    stealthMetas: {},
    labels: [],
  };
}

function makeStorage(options = {}) {
  return {
    chainId: '1',
    customTokens: '{}',
    customCollections: '{}',
    selectedAddress: OWNER,
    prefs: JSON.stringify({ autoLockMin: 0, ...(options.aggregatorEnabled ? { aggregator: { enabled: true, timeoutMs: 8000 } } : {}) }),
    pools: JSON.stringify({
      1: { endpoints: [`${origin}/eth-rpc`, ...(options.receiptFailover ? [`${origin}/eth-fallback-rpc`] : [])], epoch: 0 },
      8453: { endpoints: [`${origin}/base-rpc`], epoch: 0 },
      42161: { endpoints: [`${origin}/arb-rpc`], epoch: 0 },
      4663: { endpoints: [`${origin}/hood-rpc`], epoch: 0 },
      11155111: { endpoints: [`${origin}/sepolia-rpc`], epoch: 0 },
      84532: { endpoints: [`${origin}/base-sepolia-rpc`], epoch: 0 },
    }),
  };
}

async function openSwapFixture(options = {}) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('apps/wallet/dist is missing; run npm -w @radwallet/wallet run build before this built-UI e2e.');
  }
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  const storage = makeStorage(options);
  const status = makeStatus();
  const control = {
    console: [],
    pageErrors: [],
    rpc: [],
    quoteCalls: [],
    metadataLookups: [],
    unexpected: [],
    kyberRequests: [],
    directQuoteOut: options.directQuoteOut,
    kyberMode: options.kyberMode ?? 'high',
    receiptState: options.receiptState ?? 'success',
    allowanceLagReads: options.allowanceLagReads ?? 0,
    approvalAllowanceReads: 0,
    approvalTx: null,
    receiptEndpoints: [],
    storage,
    status,
    releaseSlow: deferred(),
  };

  page.on('console', (msg) => control.console.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (error) => control.pageErrors.push(error.message));
  await page.exposeFunction('__captureSwapApproval', (message) => {
    if (message.tx?.data?.startsWith('0x095ea7b3')) control.approvalTx = message.tx;
  });

  await page.addInitScript(({ initialStorage, initialStatus, allowMockSign }) => {
    const storageState = { ...initialStorage };
    const statusState = initialStatus;
    const runtimeListeners = [];
    function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
    window.__radwalletSwapFixture = {
      storage: storageState,
      runtimeMessages: [],
      signedTxs: [],
      emitRuntimeMessage(message) {
        for (const listener of [...runtimeListeners]) listener(message, {}, () => {});
      },
    };
    window.chrome = {
      runtime: {
        id: 'swap-fixture',
        lastError: null,
        getURL: (p) => `/${p}`,
        onMessage: {
          addListener(fn) { runtimeListeners.push(fn); },
          removeListener(fn) {
            const i = runtimeListeners.indexOf(fn);
            if (i >= 0) runtimeListeners.splice(i, 1);
          },
        },
        sendMessage(message, callback) {
          window.__radwalletSwapFixture.runtimeMessages.push(message);
          if (message?.t === 'sess.status') callback(clone(statusState));
          else if (message?.t === 'sess.sendTx' || message?.t === 'sess.swapBest') {
            window.__radwalletSwapFixture.signedTxs.push(message);
            if (allowMockSign) void window.__captureSwapApproval(message).then(() => callback({ hash: '0x' + 'ab'.repeat(32) }));
            else callback({ ok: false, error: 'swap fixture refuses signing and broadcast' });
          } else if (message?.t && String(message.t).startsWith('sess.')) {
            callback({ ok: false, error: 'swap fixture has no handler for ' + message.t });
          } else if (message?.type === 'get-approval') callback(null);
          else if (message?.type === 'resolve-approval') callback({ ok: false, error: 'swap fixture has no approval window' });
          else callback({ ok: true });
        },
      },
      storage: {
        local: {
          get(keys, callback) {
            if (keys == null) { callback(clone(storageState)); return; }
            if (typeof keys === 'string') { callback({ [keys]: clone(storageState[keys]) }); return; }
            if (Array.isArray(keys)) {
              callback(Object.fromEntries(keys.map((key) => [key, clone(storageState[key])])));
              return;
            }
            callback(Object.fromEntries(Object.keys(keys).map((key) => [key, clone(storageState[key] ?? keys[key])])));
          },
          set(items, callback) {
            Object.assign(storageState, clone(items));
            callback?.();
          },
          remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key];
            callback?.();
          },
        },
      },
      tabs: { onActivated: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} } },
      windows: { getCurrent(callback) { callback({ id: 1 }); } },
    };
  }, { initialStorage: storage, initialStatus: status, allowMockSign: options.allowMockSign === true });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.host === KYBER_HOST) {
      const res = await handleKyberApi(control, req, url);
      await route.fulfill({
        status: res.status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' },
        body: res.json === null ? '' : JSON.stringify(res.json),
      });
      return;
    }
    if (url.origin !== origin) {
      control.unexpected.push({ type: 'external-request', url: req.url() });
      await route.abort();
      return;
    }
    const rpcChain = chainForRpc(url.pathname);
    if (rpcChain) {
      const payload = req.postDataJSON();
      if (payload.method === 'eth_getTransactionReceipt') {
        control.receiptEndpoints.push(url.pathname);
        if (options.receiptFailover && url.pathname === '/eth-rpc') {
          await route.fulfill({ status: 503, body: 'fixture receipt node unavailable' });
          return;
        }
      }
      const json = await handleRpc(control, rpcChain, payload);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
      return;
    }
    let filePath = path.normalize(path.join(dist, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!filePath.startsWith(dist)) {
      control.unexpected.push({ type: 'path-traversal', url: req.url() });
      await route.abort();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(dist, 'index.html');
    await route.fulfill(fileResponse(filePath));
  });

  await page.goto(`${origin}/index.html`);
  try {
    await page.locator('.actions .tile').filter({ hasText: 'SWAP' }).first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    console.error('Swap fixture boot debug', { console: control.console.slice(-10), pageErrors: control.pageErrors, body: await page.locator('body').innerText().catch((e) => String(e)) });
    throw error;
  }
  return { browser, context, page, control };
}

async function runtimeMessages(page) {
  return page.evaluate(() => window.__radwalletSwapFixture.runtimeMessages);
}

async function signedTxs(page) {
  return page.evaluate(() => window.__radwalletSwapFixture.signedTxs);
}

async function storageSnapshot(page) {
  return page.evaluate(() => ({ ...window.__radwalletSwapFixture.storage }));
}

async function setAggregator(page, enabled = true) {
  const box = page.locator('label.row').filter({ hasText: 'Compare with KyberSwap' }).locator('input[type="checkbox"]');
  await box.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await box.isChecked()) !== enabled) await box.click();
}

async function setAmount(page, amount) {
  await page.locator('.payrow input.field').fill(amount);
}

async function emitRuntimeMessage(page, message) {
  await page.evaluate((msg) => window.__radwalletSwapFixture.emitRuntimeMessage(msg), message);
}

async function waitForText(page, selector, text, timeout = 5000) {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
}

async function goSwap(page) {
  if (await page.locator('h1').filter({ hasText: 'RADSWAP' }).count()) return;
  await page.locator('.actions .tile').filter({ hasText: 'SWAP' }).click();
  await waitForText(page, 'h1', 'RADSWAP');
}

async function goHome(page) {
  const home = page.locator('.tabbar .tab').filter({ hasText: 'HOME' });
  if (await home.count()) await home.click({ force: true });
  await page.locator('.actions .tile').filter({ hasText: 'SWAP' }).first().waitFor({ state: 'visible' });
}

async function openPicker(page, side = 'to') {
  await goSwap(page);
  await page.locator('.pairside').nth(side === 'from' ? 0 : 1).click();
  await page.waitForSelector('.drawerbox[aria-label] .drawerfilters input.search');
  return page.locator('.drawerbox[aria-label] .drawerfilters input.search');
}


async function closePicker(page) {
  const close = page.locator('.drawerbox .x');
  if (await close.count()) await close.click();
  await page.locator('.drawerbox').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

async function waitForContractRow(page, address, name) {
  const row = page.locator('.pickrow').filter({ hasText: shortContract(address) });
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  if (name) await assertText(row, name);
  return row;
}

async function assertText(locator, expected) {
  const text = await locator.textContent({ timeout: 5000 });
  assert(text && text.includes(expected), `expected ${JSON.stringify(text)} to include ${JSON.stringify(expected)}`);
}

async function waitForKyberRequests(control, count, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (control.kyberRequests.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`expected at least ${count} Kyber API requests, saw ${control.kyberRequests.length}`);
}

async function waitForNoNewKyberRequests(control, ms = 1200) {
  const before = control.kyberRequests.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(control.kyberRequests.length, before, 'Kyber API was called while aggregator was disabled');
}

async function waitForKyberRouteAmount(control, amountIn, afterCount = 0, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const routes = control.kyberRequests.filter((req) => req.pathname.endsWith('/api/v1/routes'));
    if (routes.length > afterCount && routes.some((req) => req.search.includes(`amountIn=${amountIn}`))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`expected Kyber route amountIn=${amountIn}, saw ${JSON.stringify(control.kyberRequests)}`);
}

async function waitForQuoteUsing(control, address) {
  const needle = address.slice(2).toLowerCase();
  for (let i = 0; i < 60; i++) {
    if (control.quoteCalls.some((call) => String(call.callData).toLowerCase().includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`quote calldata never contained ${address}`);
}

function metadataCount(control, address, chainId) {
  return control.metadataLookups.filter((call) => lowerAddress(call.address) === lowerAddress(address)
    && (chainId === undefined || call.chainId === chainId)).length;
}

async function assertCustomTokensDoNotContain(page, address) {
  const snap = await storageSnapshot(page);
  const customTokens = String(snap.customTokens ?? '{}').toLowerCase();
  assert(!customTokens.includes(address.toLowerCase()), `customTokens unexpectedly contains ${address}: ${customTokens}`);
}

async function pickContractForSwap(page, address, name, side = 'to') {
  const input = await openPicker(page, side);
  await input.fill(address);
  const row = await waitForContractRow(page, address, name);
  await row.click();
  await page.locator('.drawerbox').waitFor({ state: 'detached' });
}

async function waitForRoute(page, text, timeout = 15_000) {
  await waitForText(page, '.feetable', text, timeout);
}

async function assertReviewLayout(page) {
  const review = page.locator('.swapreview');
  await review.waitFor({ state: 'visible', timeout: 10_000 });
  const overflow = await review.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    bodyScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
  }));
  assert(
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `review panel overflows horizontally: ${JSON.stringify(overflow)}`,
  );
  assert(
    overflow.bodyScrollWidth <= overflow.bodyClientWidth + 1,
    `page overflows horizontally: ${JSON.stringify(overflow)}`,
  );
  const refuse = await review.locator('button.btn').filter({ hasText: 'REFUSE' }).boundingBox();
  const sign = await review.locator('button.btn').filter({ hasText: 'SIGN & SEND' }).boundingBox();
  assert(refuse && sign, 'missing REFUSE or SIGN button bounds');
  assert(
    Math.abs(refuse.width - sign.width) <= 1,
    `REFUSE/SIGN widths differ: ${refuse.width} vs ${sign.width}`,
  );
}

async function scrollReviewForViewportScreenshot(page) {
  const review = page.locator('.swapreview');
  await review.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const buttons = [
    ['REFUSE', review.locator('button.btn').filter({ hasText: 'REFUSE' })],
    ['SIGN & SEND', review.locator('button.btn').filter({ hasText: 'SIGN & SEND' })],
  ];
  const tabbarTop = await page.locator('.tabbar').evaluate((el) => el.getBoundingClientRect().top);
  for (const [label, button] of buttons) {
    const box = await button.boundingBox();
    assert(box, `${label} button has no viewport bounds`);
    assert(box.y >= 0, `${label} button is above the viewport: ${JSON.stringify(box)}`);
    assert(box.y + box.height <= tabbarTop, `${label} button is hidden below the tabbar: ${JSON.stringify({ box, tabbarTop })}`);
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.textContent ?? '';
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert(hit.includes(label), `${label} button center is not hit-test visible: ${JSON.stringify(hit)}`);
  }
}

async function runAggregatorScenario(name, options, fn) {
  const fx = await openSwapFixture(options);
  try {
    await goSwap(fx.page);
    await fn(fx);
    assert.equal(fx.control.unexpected.length, 0, `${name}: unexpected request: ${JSON.stringify(fx.control.unexpected)}`);
  } finally {
    await fx.browser.close();
  }
}

async function runAggregatorFixture() {
  await runAggregatorScenario('default-off', { kyberMode: 'high' }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForRoute(page, 'uniswap v3');
    await waitForNoNewKyberRequests(control);
  });

  await runAggregatorScenario('ethereum-high-kyber', { kyberMode: 'high' }, async ({ page, control }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForKyberRequests(control, 1);
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await waitForText(page, '.feetable', 'Aggregator fee');
    await waitForText(page, 'button.btn', 'REVIEW SWAP');
    await page.locator('button.btn').filter({ hasText: 'REVIEW SWAP' }).click();
    await waitForText(page, '.swapreview', 'REVIEW KYBERSWAP', 15_000);
    await waitForText(page, '.swapreview', 'Minimum you receive');
    await waitForText(page, '.swapreview', UNKNOWN_RAD);
    await waitForText(page, '.swapreview', OWNER);
    await page.setViewportSize({ width: 372, height: 900 });
    await assertReviewLayout(page);
    await scrollReviewForViewportScreenshot(page);
    await page.screenshot({ path: reviewViewportScreenshotPath, fullPage: false });
    await page.screenshot({ path: '/tmp/radwallet-swap-review.png', fullPage: true });
    await page.locator('.swapreview button.btn').filter({ hasText: 'REFUSE' }).click();
    await page.locator('.swapreview').waitFor({ state: 'detached', timeout: 5000 });
    const messages = await runtimeMessages(page);
    assert.equal(messages.filter((msg) => msg?.t === 'sess.sendTx').length, 0, 'REFUSE asked the session to sign');
  });

  await runAggregatorScenario('mock-sign-captures-calldata-and-tracking', { kyberMode: 'high', allowMockSign: true }, async ({ page }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.locator('button.btn').filter({ hasText: 'REVIEW SWAP' }).click();
    await waitForText(page, '.swapreview', 'REVIEW KYBERSWAP', 15_000);
    await page.locator('.swapreview button.btn').filter({ hasText: 'SIGN & SEND' }).click();
    await waitForText(page, '.panel', 'BROADCAST', 15_000);
    const sent = await signedTxs(page);
    const last = sent.at(-1);
    assert(last, 'mock signing did not capture a sendTx request');
    assert(
      String(last.tx?.data || '').toLowerCase().includes(UNKNOWN_RAD.slice(2).toLowerCase()),
      'Kyber calldata did not include chosen token address',
    );
    assert.deepEqual(last.trackOnSuccess, [{
      address: UNKNOWN_RAD, symbol: '$RAD', name: 'Shadow Radcoin', decimals: 18, recipient: OWNER,
    }], `trackOnSuccess did not bind chosen token metadata: ${JSON.stringify(last.trackOnSuccess)}`);
  });

  await runAggregatorScenario('ethereum-low-direct', { kyberMode: 'low' }, async ({ page, control }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForKyberRequests(control, 1);
    await waitForRoute(page, 'uniswap v3');
    assert.equal(await page.locator('.feetable').filter({ hasText: 'Aggregator fee' }).count(), 0, 'lower Kyber route was selected over direct');
  });

  await runAggregatorScenario('ethereum-tie-direct', { kyberMode: 'tie' }, async ({ page, control }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForKyberRequests(control, 1);
    await waitForRoute(page, 'uniswap v3');
    assert.equal(await page.locator('.feetable').filter({ hasText: 'Aggregator fee' }).count(), 0, 'tied Kyber route was selected over direct');
  });

  await runAggregatorScenario('ethereum-api-error-direct', { kyberMode: 'error' }, async ({ page, control }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForKyberRequests(control, 1);
    await waitForText(page, '[role="status"]', 'KyberSwap is unavailable');
    await waitForRoute(page, 'uniswap v3');
  });

  await runAggregatorScenario('quote-invalidation', { kyberMode: 'high' }, async ({ page, control }) => {
    await setAggregator(page, true);
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.locator('button.btn').filter({ hasText: 'REVIEW SWAP' }).click();
    await waitForText(page, '.swapreview', 'REVIEW KYBERSWAP', 15_000);
    const routeCount = control.kyberRequests.filter((req) => req.pathname.endsWith('/api/v1/routes')).length;
    await setAmount(page, '0.20');
    await page.locator('.swapreview').waitFor({ state: 'detached', timeout: 5000 });
    await waitForKyberRouteAmount(control, '200000000000000000', routeCount);
    await waitForRoute(page, 'kyberswap · FixtureAMM');
  });

  await runAggregatorScenario('robinhood-high-kyber', { kyberMode: 'robinhood' }, async ({ page, control }) => {
    await emitRuntimeMessage(page, { type: 'wallet-chain-changed', chainId: 4663 });
    await page.waitForFunction(() => document.querySelector('.swaphead .netsel')?.value === '4663');
    await setAggregator(page, true);
    await pickContractForSwap(page, HOOD_RAD, 'Robinhood Fixture Token');
    await waitForKyberRequests(control, 1);
    assert(control.kyberRequests.some((req) => req.pathname.startsWith('/robinhood/')), 'Robinhood Kyber route API was not called');
    await waitForRoute(page, 'kyberswap · FixtureHoodAMM');
  });

  console.log('Swap aggregator: Kyber opt-in, winning/fallback/default-off/error/invalidation/review/refuse regressions passed (/tmp/radwallet-swap-review.png)');
}

async function runApprovalFixture() {
  await runAggregatorScenario('approval-with-lagging-allowance', {
    aggregatorEnabled: true, allowMockSign: true, allowanceLagReads: 1,
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
        .some((button) => button.textContent === 'REVIEW SWAP' && !button.disabled), null, { timeout: 12_000 });
    } catch (error) {
      console.error('Approval regression:', {
        allowanceReads: control.approvalAllowanceReads,
        buttons: await page.locator('button.btn.block').allTextContents(),
        body: await page.locator('.swapcontent').innerText(),
      });
      throw error;
    }
    assert(control.approvalAllowanceReads >= 2, 'confirmed approval did not retry stale allowance');
    assert.equal((await signedTxs(page)).length, 1, 'allowance recovery sent another transaction');
    await page.screenshot({ path: '/tmp/radwallet-swap-approved.png', fullPage: true });
  });
  await runAggregatorScenario('direct-approval-waits-for-receipt', {
    allowMockSign: true, receiptState: 'pending',
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'uniswap v3');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    await waitForText(page, '[role="status"]', 'Approval sent.');
    assert(await page.getByRole('button', { name: '[ APPROVAL REQUIRED ]', exact: true }).isDisabled(),
      'a pending approval enabled the direct swap');
    assert.equal(control.approvalAllowanceReads, 0, 'read allowance before a successful receipt');
    control.receiptState = 'success';
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
      .some((button) => button.textContent.startsWith('SWAP $RAD') && !button.disabled), null, { timeout: 10_000 });
    assert.equal((await signedTxs(page)).length, 1);
  });
  await runAggregatorScenario('reverted-approval-stays-blocked', {
    aggregatorEnabled: true, allowMockSign: true, receiptState: 'reverted',
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    await waitForText(page, '[role="status"]', 'The approval failed onchain.');
    assert(await page.getByRole('button', { name: 'REVIEW SWAP', exact: true }).isDisabled());
    assert.equal(control.approvalAllowanceReads, 0, 'reverted receipt must not advance to allowance checking');
    assert.equal((await signedTxs(page)).length, 1);
  });
  await runAggregatorScenario('approval-receipt-fails-over', {
    aggregatorEnabled: true, allowMockSign: true, receiptFailover: true,
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
      .some((button) => button.textContent === 'REVIEW SWAP' && !button.disabled), null, { timeout: 10_000 });
    assert(control.receiptEndpoints.includes('/eth-fallback-rpc'), 'receipt did not use the fallback node');
    assert.equal((await signedTxs(page)).length, 1);
  });
  await runAggregatorScenario('approval-recheck-does-not-resend', {
    aggregatorEnabled: true, allowMockSign: true, allowanceLagReads: Infinity,
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    await waitForText(page, '[role="status"]', 'Approval sent.');
    // Advance only the timeout clock; RPC replies and browser timers stay real.
    const started = Date.now();
    while (control.approvalAllowanceReads === 0 && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(control.approvalAllowanceReads > 0, 'approval did not reach its confirmation check');
    await page.evaluate(() => {
      window.__approvalOriginalNow = Date.now;
      Date.now = () => window.__approvalOriginalNow() + 91_000;
    });
    await page.getByRole('button', { name: 'RECHECK APPROVAL', exact: true }).waitFor({ timeout: 10_000 });
    assert(await page.getByRole('button', { name: 'REVIEW SWAP', exact: true }).isDisabled());
    await page.evaluate(() => { Date.now = window.__approvalOriginalNow; });
    control.allowanceLagReads = 0;
    await page.getByRole('button', { name: 'RECHECK APPROVAL', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
      .some((button) => button.textContent === 'REVIEW SWAP' && !button.disabled), null, { timeout: 10_000 });
    assert.equal((await signedTxs(page)).length, 1, 'recheck resent an approval');
  });
  await runAggregatorScenario('old-approval-cannot-unlock-new-chain', {
    aggregatorEnabled: true, allowMockSign: true, receiptState: 'pending',
  }, async ({ page, control }) => {
    await pickContractForSwap(page, UNKNOWN_RAD, 'Shadow Radcoin', 'from');
    await waitForRoute(page, 'kyberswap · FixtureAMM');
    await page.getByRole('button', { name: 'APPROVE 0.10 $RAD', exact: true }).click();
    await waitForText(page, '[role="status"]', 'Approval sent.');
    await emitRuntimeMessage(page, { type: 'wallet-chain-changed', chainId: 4663 });
    await page.waitForFunction(() => document.querySelector('.swaphead .netsel')?.value === '4663');
    control.receiptState = 'success';
    await page.waitForFunction(() => !document.querySelector('.swaphead .netsel')?.disabled, null, { timeout: 10_000 });
    assert.equal(await page.getByText('View approval', { exact: true }).count(), 0, 'old approval leaked into new chain');
    assert.equal(control.approvalAllowanceReads, 0, 'retired approval queried the old allowance');
    assert.equal((await signedTxs(page)).length, 1);
  });
  console.log('Swap approval: stale allowance recovery, pending/reverted receipt gates, RPC failover, no-resend recheck, and chain invalidation passed');
}

async function runSwapFixture() {
  const fx = await openSwapFixture();
  const { browser, page, control } = fx;
  try {
    await goSwap(page);

    let input = await openPicker(page, 'to');
    await input.fill(UNKNOWN_RAD);
    const unknownRow = await waitForContractRow(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await unknownRow.click();
    await page.locator('.drawerbox').waitFor({ state: 'detached' });
    await assertText(page.locator('.pairside').nth(1), '$RAD');
    await waitForText(page, '.balance .big', '$RAD', 15_000);
    await waitForQuoteUsing(control, UNKNOWN_RAD);
    await assertCustomTokensDoNotContain(page, UNKNOWN_RAD);

    input = await openPicker(page, 'to');
    await input.fill('$RAD');
    await waitForContractRow(page, UNKNOWN_RAD, 'Shadow Radcoin');
    await waitForContractRow(page, CANON_RAD, 'Radcoin');
    assert((await page.locator('.pickrow').filter({ hasText: '$RAD' }).count()) >= 2, 'expected same-symbol $RAD rows to stay separate');
    await page.setViewportSize({ width: 372, height: 900 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.screenshot({ path: pickerViewportScreenshotPath, fullPage: false });
    await page.setViewportSize({ width: 430, height: 900 });
    await closePicker(page);

    const beforeInvalid = metadataCount(control, INVALID_CHECKSUM);
    input = await openPicker(page, 'to');
    await input.fill(INVALID_CHECKSUM);
    await waitForText(page, '.note.red', 'invalid contract address or checksum');
    assert.equal(metadataCount(control, INVALID_CHECKSUM), beforeInvalid, 'invalid checksum triggered an RPC lookup');
    assert.equal(await page.locator('.pickrow').filter({ hasText: shortContract(UNKNOWN_RAD) }).count(), 0,
      'previous contract row stayed visible after invalid checksum input');
    await closePicker(page);

    input = await openPicker(page, 'to');
    await input.fill(DEAD_TOKEN);
    await waitForText(page, '.note.red', 'that contract will not say what it is');
    assert(metadataCount(control, DEAD_TOKEN, 1) > 0, 'failed metadata token was not looked up');
    await closePicker(page);

    input = await openPicker(page, 'to');
    await input.fill(BAD_DECIMALS);
    await waitForText(page, '.note.red', 'unsupported decimals');
    await closePicker(page);

    input = await openPicker(page, 'to');
    await input.fill(SLOW_RAD);
    await waitForText(page, '.note.center', `checking ${SLOW_RAD}`);
    await input.fill(OTHER_RAD);
    await waitForContractRow(page, OTHER_RAD, 'Other Radcoin');
    control.releaseSlow.resolve();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await page.locator('.pickrow').filter({ hasText: shortContract(SLOW_RAD) }).count(), 0,
      'stale slow metadata result rendered after the query changed');
    await page.locator('.pickrow').filter({ hasText: shortContract(OTHER_RAD) }).click();
    await page.locator('.drawerbox').waitFor({ state: 'detached' });
    await waitForText(page, '.balance .big', '$RAD', 15_000);
    await waitForQuoteUsing(control, OTHER_RAD);
    await assertCustomTokensDoNotContain(page, OTHER_RAD);

    await emitRuntimeMessage(page, { type: 'wallet-chain-changed', chainId: 8453 });
    await page.waitForFunction(() => document.querySelector('.swaphead .netsel')?.value === '8453');
    input = await openPicker(page, 'to');
    await input.fill(UNKNOWN_RAD);
    await waitForText(page, '.note.red', 'that contract will not say what it is');
    assert(metadataCount(control, UNKNOWN_RAD, 8453) > 0, 'network switch did not re-check the pasted address on Base');
    assert.equal(await page.locator('.pickrow').filter({ hasText: shortContract(UNKNOWN_RAD) }).count(), 0,
      'mainnet transient contract stayed selectable after switching to Base');
    await closePicker(page);

    await emitRuntimeMessage(page, { type: 'wallet-chain-changed', chainId: 1 });
    await page.waitForFunction(() => document.querySelector('.swaphead .netsel')?.value === '1');
    await goHome(page);
    await page.locator('button[aria-label="next wallet"]').click();
    await page.waitForFunction((owner2) => window.__radwalletSwapFixture.storage.selectedAddress?.toLowerCase() === owner2.toLowerCase(), OWNER_2);
    await goSwap(page);
    input = await openPicker(page, 'to');
    await input.fill('$RAD');
    await waitForContractRow(page, CANON_RAD, 'Radcoin');
    assert.equal(await page.locator('.pickrow').filter({ hasText: shortContract(UNKNOWN_RAD) }).count(), 0,
      'first wallet pasted token leaked into the second wallet picker');
    assert.equal(await page.locator('.pickrow').filter({ hasText: shortContract(OTHER_RAD) }).count(), 0,
      'stale selected pasted token leaked into the second wallet picker');
    await closePicker(page);

    const messages = await runtimeMessages(page);
    const forbidden = messages.filter((msg) => msg?.t === 'sess.sendTx' || msg?.t === 'sess.swapBest');
    assert.equal(forbidden.length, 0, `fixture unexpectedly asked session to sign/broadcast: ${JSON.stringify(forbidden)}`);
    assert.equal(control.unexpected.length, 0, `unexpected external/file request: ${JSON.stringify(control.unexpected)}`);
    await assertCustomTokensDoNotContain(page, UNKNOWN_RAD);
    await assertCustomTokensDoNotContain(page, OTHER_RAD);
    console.log(`Swap picker: pasted contract selection, same-symbol display, stale lookup guards, network/account isolation passed (${screenshotPath})`);
    return { screenshotPath, rpcCalls: control.rpc.length, quoteCalls: control.quoteCalls.length };
  } finally {
    await browser.close();
  }
}

module.exports = {
  openSwapFixture,
  runSwapFixture,
  runAggregatorFixture,
  runApprovalFixture,
  setAggregator,
  setAmount,
  emitRuntimeMessage,
  storageSnapshot,
  signedTxs,
  constants: {
    origin,
    screenshotPath,
    pickerViewportScreenshotPath,
    reviewViewportScreenshotPath,
    OWNER,
    OWNER_2,
    UNKNOWN_RAD,
    SLOW_RAD,
    DEAD_TOKEN,
    OTHER_RAD,
    HOOD_RAD,
    BAD_DECIMALS,
    INVALID_CHECKSUM,
    CANON_RAD,
    WETH,
    HOOD_WETH,
    MULTICALL3,
    KYBER_HOST,
    KYBER_NATIVE,
    KYBER_ROUTER,
  },
};

if (require.main === module) {
  (async () => {
    await runSwapFixture();
    await runAggregatorFixture();
    await runApprovalFixture();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
