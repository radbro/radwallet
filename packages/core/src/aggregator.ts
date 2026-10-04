import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbiParameters,
  zeroAddress,
  type Abi,
} from 'viem';
import type { DappTxRequest } from './chain.js';
import { chainClient } from './tokens.js';

export const KYBER_HOST = 'aggregator-api.kyberswap.com';
export const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

export interface KyberAggregatorConfig {
  enabled: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface KyberSwapSide {
  address: `0x${string}` | null;
}

export interface KyberRouteQuote {
  protocol: 'kyber';
  chainId: number;
  chainName: 'ethereum' | 'robinhood';
  router: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  slippageBps: number;
  routeSummary: Record<string, unknown>;
  routeLabel: string;
}

export interface KyberBuiltSwap {
  tx: DappTxRequest;
  amountOut: bigint;
  minReturnAmount: bigint;
}

export const KYBER_ROUTER_FOR: Record<number, `0x${string}`> = {
  1: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  4663: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
};

export const KYBER_CHAIN_NAME: Record<number, KyberRouteQuote['chainName']> = {
  1: 'ethereum',
  4663: 'robinhood',
};

const SWAP_DESCRIPTION_COMPONENTS = [
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
] as const;

const SWAP_EXECUTION_COMPONENTS = [
  { name: 'callTarget', type: 'address' },
  { name: 'approveTarget', type: 'address' },
  { name: 'targetData', type: 'bytes' },
  { name: 'desc', type: 'tuple', components: SWAP_DESCRIPTION_COMPONENTS },
  { name: 'clientData', type: 'bytes' },
] as const;

const UINT256_PAIR_OUTPUTS = [
  { name: 'returnAmount', type: 'uint256' },
  { name: 'gasUsed', type: 'uint256' },
] as const;

export const KYBER_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [{ name: 'execution', type: 'tuple', components: SWAP_EXECUTION_COMPONENTS }],
    outputs: UINT256_PAIR_OUTPUTS,
  },
  {
    type: 'function',
    name: 'swapGeneric',
    stateMutability: 'payable',
    inputs: [{ name: 'execution', type: 'tuple', components: SWAP_EXECUTION_COMPONENTS }],
    outputs: UINT256_PAIR_OUTPUTS,
  },
  {
    type: 'function',
    name: 'swapSimpleMode',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'caller', type: 'address' },
      { name: 'desc', type: 'tuple', components: SWAP_DESCRIPTION_COMPONENTS },
      { name: 'executorData', type: 'bytes' },
      { name: 'clientData', type: 'bytes' },
    ],
    outputs: UINT256_PAIR_OUTPUTS,
  },
] as const satisfies Abi;

const SIMPLE_SWAP_DATA = parseAbiParameters(
  'address[] firstPools, uint256[] firstSwapAmounts, bytes[] swapDatas, uint256 deadline, bytes destTokenFeeData',
);

const FLAG_PARTIAL_FILL = 0x01n;
const FLAG_REQUIRES_EXTRA_ETH = 0x02n;
const FLAG_SHOULD_CLAIM = 0x04n;
const FLAG_BURN_FROM_MSG_SENDER = 0x08n;
const FLAG_BURN_FROM_TX_ORIGIN = 0x10n;
const FLAG_SIMPLE_SWAP = 0x20n;
const FLAG_FEE_ON_DST = 0x40n;
const FLAG_FEE_IN_BPS = 0x80n;
const FLAG_APPROVE_FUND = 0x100n;
// Observed in Kyber V1 build calldata on Ethereum and Robinhood, but unused by
// the verified MetaAggregationRouterV2 source. Any other unknown bit is refused.
const FLAG_OBSERVED_INERT = 0x200n;
const SAFE_FLAGS = FLAG_OBSERVED_INERT | FLAG_SIMPLE_SWAP;
const UNSAFE_FLAGS = FLAG_PARTIAL_FILL | FLAG_REQUIRES_EXTRA_ETH | FLAG_SHOULD_CLAIM
  | FLAG_BURN_FROM_MSG_SENDER | FLAG_BURN_FROM_TX_ORIGIN | FLAG_FEE_ON_DST
  | FLAG_FEE_IN_BPS | FLAG_APPROVE_FUND;

function kyberChain(chainId: number): KyberRouteQuote['chainName'] | null {
  return KYBER_CHAIN_NAME[chainId] ?? null;
}

export function canUseKyberSwap(chainId: number): boolean {
  return kyberChain(chainId) !== null && KYBER_ROUTER_FOR[chainId] !== undefined;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string, label = key): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new Error(`${label} is missing`);
  return value;
}

function bigintField(obj: Record<string, unknown>, key: string, label = key): bigint {
  const value = stringField(obj, key, label);
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} is malformed`);
  return BigInt(value);
}

function sameToken(a: `0x${string}`, b: `0x${string}`): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function checkedToken(value: string): `0x${string}` {
  if (sameToken(value as `0x${string}`, KYBER_NATIVE)) return KYBER_NATIVE;
  return getAddress(value);
}

function tokenForKyber(side: KyberSwapSide): `0x${string}` {
  return side.address ? getAddress(side.address) : KYBER_NATIVE;
}

function slippageBps(slippagePct: number): number {
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 20) {
    throw new Error('Kyber slippage must be between 0% and 20%');
  }
  return Math.round(slippagePct * 100);
}

function applySlippageBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

function buildSlippageBps(quote: KyberRouteQuote, acceptedMinOut: bigint): number {
  if (acceptedMinOut <= 0n) throw new Error('Kyber accepted minimum must be positive');
  if (acceptedMinOut >= quote.amountOut) return 0;
  const exactMax = Number(((quote.amountOut - acceptedMinOut) * 10_000n) / quote.amountOut);
  // Kyber recomputes the build output when encoding. Tighten by one bip so
  // one-wei route drift does not produce calldata below the accepted floor.
  return Math.max(0, Math.min(quote.slippageBps, exactMax > 0 ? exactMax - 1 : 0));
}

function assertZeroExtraFee(value: unknown): void {
  if (value === undefined || value === null) return;
  const fee = asObject(value, 'Kyber fee data');
  const amount = String(fee.feeAmount ?? '').trim();
  const by = String(fee.chargeFeeBy ?? '').trim();
  const receiver = String(fee.feeReceiver ?? '').trim();
  if (by || receiver) throw new Error('Kyber route includes a fee receiver');
  if (!amount) return;
  for (const part of amount.split(',')) {
    const piece = part.trim() || '0';
    if (!/^[0-9]+$/.test(piece)) throw new Error('Kyber fee amount is malformed');
    if (BigInt(piece) !== 0n) throw new Error('Kyber route includes a fee amount');
  }
}

async function kyberFetch(cfg: KyberAggregatorConfig, path: string, init?: RequestInit): Promise<unknown | null> {
  if (!cfg.enabled) return null;
  const ctrl = new AbortController();
  if (cfg.signal?.aborted) ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8_000);
  const abortFromCaller = () => ctrl.abort();
  cfg.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const res = await fetch(`https://${KYBER_HOST}${path}`, {
      ...init,
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        accept: 'application/json',
        'x-client-id': 'RADWALLET',
        ...(init?.headers ?? {}),
      },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && typeof json === 'object' && 'message' in json ? String(json.message) : res.statusText;
      throw new Error(`KyberSwap ${res.status}: ${msg}`);
    }
    return json;
  } finally {
    cfg.signal?.removeEventListener('abort', abortFromCaller);
    clearTimeout(timer);
  }
}

function routeLabel(route: unknown): string {
  if (!Array.isArray(route)) return 'kyberswap';
  const names = new Set<string>();
  for (const leg of route) {
    if (!Array.isArray(leg)) continue;
    for (const hop of leg) {
      if (hop && typeof hop === 'object' && typeof (hop as { exchange?: unknown }).exchange === 'string') {
        names.add(String((hop as { exchange: string }).exchange));
      }
    }
  }
  const venues = [...names].slice(0, 3);
  return venues.length ? `kyberswap · ${venues.join(' + ')}` : 'kyberswap';
}

export async function quoteKyberSwap(
  cfg: KyberAggregatorConfig,
  chainId: number,
  owner: `0x${string}`,
  from: KyberSwapSide,
  to: KyberSwapSide,
  amountIn: bigint,
  slippagePct = 1,
): Promise<KyberRouteQuote | null> {
  const chain = kyberChain(chainId);
  const router = KYBER_ROUTER_FOR[chainId];
  if (!chain || !router || amountIn <= 0n) return null;
  const tokenIn = tokenForKyber(from);
  const tokenOut = tokenForKyber(to);
  if (sameToken(tokenIn, tokenOut)) return null;
  const bps = slippageBps(slippagePct);
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    origin: getAddress(owner),
  });
  const json = await kyberFetch(cfg, `/${chain}/api/v1/routes?${params}`);
  if (!json) return null;
  const top = asObject(json, 'Kyber response');
  if (Number(top.code) !== 0) throw new Error(String(top.message ?? 'KyberSwap route failed'));
  const data = asObject(top.data, 'Kyber route data');
  if (!sameToken(getAddress(stringField(data, 'routerAddress', 'Kyber router')), router)) {
    throw new Error('Kyber route uses an unverified router');
  }
  const routeSummary = asObject(data.routeSummary, 'Kyber route summary');
  assertZeroExtraFee(routeSummary.extraFee);
  const routedTokenIn = checkedToken(stringField(routeSummary, 'tokenIn', 'Kyber input token'));
  const routedTokenOut = checkedToken(stringField(routeSummary, 'tokenOut', 'Kyber output token'));
  if (!sameToken(routedTokenIn, tokenIn) || !sameToken(routedTokenOut, tokenOut)) {
    throw new Error('Kyber route changed the requested pair');
  }
  if (bigintField(routeSummary, 'amountIn', 'Kyber input amount') !== amountIn) {
    throw new Error('Kyber route changed the requested amount');
  }
  const amountOut = bigintField(routeSummary, 'amountOut', 'Kyber output amount');
  if (amountOut <= 0n) throw new Error('Kyber route returned no output');
  const minOut = applySlippageBps(amountOut, bps);
  if (minOut <= 0n) throw new Error('Kyber route minimum is zero');
  return {
    protocol: 'kyber',
    chainId,
    chainName: chain,
    router,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    minOut,
    slippageBps: bps,
    routeSummary,
    routeLabel: routeLabel(routeSummary.route),
  };
}

function txValue(tx: DappTxRequest): bigint {
  const value = tx.value ?? 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

type KyberDesc = {
  srcToken: `0x${string}`;
  dstToken: `0x${string}`;
  srcReceivers: readonly `0x${string}`[];
  srcAmounts: readonly bigint[];
  feeReceivers: readonly `0x${string}`[];
  feeAmounts: readonly bigint[];
  dstReceiver: `0x${string}`;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: `0x${string}`;
};

function assertSimpleData(executorData: `0x${string}`, amountIn: bigint): void {
  const [firstPools, firstSwapAmounts, swapDatas, , destTokenFeeData] = decodeAbiParameters(
    SIMPLE_SWAP_DATA,
    executorData,
  ) as [`0x${string}`[], bigint[], `0x${string}`[], bigint, `0x${string}`];
  if (!firstPools.length || firstPools.length !== firstSwapAmounts.length || firstPools.length !== swapDatas.length) {
    throw new Error('Kyber simple swap data is malformed');
  }
  const total = firstSwapAmounts.reduce((sum, value) => sum + value, 0n);
  if (total !== amountIn) throw new Error('Kyber simple swap is not exact input');
  if (destTokenFeeData !== '0x') throw new Error('Kyber simple swap includes destination fee data');
}

function assertKyberDescription(
  desc: KyberDesc,
  owner: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  acceptedMinOut: bigint,
  tx: DappTxRequest,
  simpleExecutorData?: `0x${string}`,
): bigint {
  if (!sameToken(desc.srcToken, tokenIn) || !sameToken(desc.dstToken, tokenOut)) {
    throw new Error('Kyber calldata changed the requested pair');
  }
  if (!sameToken(desc.dstReceiver, getAddress(owner))) throw new Error('Kyber recipient is not the signer');
  if (desc.amount !== amountIn) throw new Error('Kyber calldata changed the requested amount');
  if (desc.minReturnAmount <= 0n) throw new Error('Kyber minimum is zero');
  if (desc.minReturnAmount < acceptedMinOut) throw new Error('Kyber minimum is below the accepted floor');
  if (desc.permit !== '0x') throw new Error('Kyber calldata includes a permit');
  if (desc.feeReceivers.length || desc.feeAmounts.length) throw new Error('Kyber calldata includes a fee');
  if ((desc.flags & UNSAFE_FLAGS) !== 0n || (desc.flags & ~SAFE_FLAGS) !== 0n) {
    throw new Error('Kyber calldata includes unsupported flags');
  }
  const simple = (desc.flags & FLAG_SIMPLE_SWAP) !== 0n || simpleExecutorData !== undefined;
  if (simpleExecutorData) {
    if (!simple) throw new Error('Kyber simple mode flag is missing');
    if (sameToken(desc.srcToken, KYBER_NATIVE)) throw new Error('Kyber simple mode cannot spend native ETH');
    assertSimpleData(simpleExecutorData, amountIn);
  } else if (simple) {
    throw new Error('Kyber simple swap data is missing');
  }
  if (amountIn <= 0n) throw new Error('Kyber input amount must be positive');
  const value = txValue(tx);
  if (sameToken(desc.srcToken, KYBER_NATIVE)) {
    if (value !== amountIn) throw new Error('Kyber native value does not match input');
    if (desc.srcReceivers.length || desc.srcAmounts.length) throw new Error('Kyber native swap moves tokens');
  } else {
    if (value !== 0n) throw new Error('Kyber ERC-20 swap unexpectedly sends native ETH');
    if (!simpleExecutorData || desc.srcReceivers.length || desc.srcAmounts.length) {
      if (desc.srcReceivers.length !== desc.srcAmounts.length) throw new Error('Kyber source receiver lengths differ');
      const total = desc.srcAmounts.reduce((sum, value) => sum + value, 0n);
      if (total !== amountIn) throw new Error('Kyber ERC-20 swap is not exact input');
      if (desc.srcReceivers.some((receiver) => sameToken(receiver, zeroAddress))) {
        throw new Error('Kyber source receiver is zero');
      }
    }
  }
  return desc.minReturnAmount;
}

export function validateKyberSwapTx(
  chainId: number,
  owner: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  acceptedMinOut: bigint,
  tx: DappTxRequest,
): bigint {
  const router = KYBER_ROUTER_FOR[chainId];
  if (acceptedMinOut <= 0n) throw new Error('Kyber accepted minimum must be positive');
  if (!router) throw new Error(`KyberSwap is not enabled on chain ${chainId}`);
  if (!tx.to || !sameToken(getAddress(tx.to), router)) throw new Error('Kyber tx uses an unverified router');
  if (!tx.data) throw new Error('Kyber tx has no calldata');
  let decoded: ReturnType<typeof decodeFunctionData<typeof KYBER_ROUTER_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: tx.data });
  } catch {
    throw new Error('Kyber calldata is not a verified router swap');
  }
  if (decoded.functionName === 'swap' || decoded.functionName === 'swapGeneric') {
    if (chainId === 4663 && decoded.functionName === 'swapGeneric') {
      throw new Error('Kyber Robinhood router does not expose swapGeneric');
    }
    const execution = decoded.args[0] as unknown as {
      approveTarget: `0x${string}`;
      targetData: `0x${string}`;
      desc: KyberDesc;
    };
    if (!sameToken(execution.approveTarget, zeroAddress)) throw new Error('Kyber calldata uses approveTarget');
    const simpleData = (execution.desc.flags & FLAG_SIMPLE_SWAP) !== 0n ? execution.targetData : undefined;
    return assertKyberDescription(
      execution.desc, owner, tokenIn, tokenOut, amountIn, acceptedMinOut, tx, simpleData,
    );
  }
  if (decoded.functionName === 'swapSimpleMode') {
    const desc = decoded.args[1] as unknown as KyberDesc;
    const executorData = decoded.args[2] as `0x${string}`;
    return assertKyberDescription(desc, owner, tokenIn, tokenOut, amountIn, acceptedMinOut, tx, executorData);
  }
  throw new Error('Kyber calldata is not a swap');
}

export async function buildKyberSwap(
  cfg: KyberAggregatorConfig,
  quote: KyberRouteQuote,
  owner: `0x${string}`,
  acceptedMinOut = quote.minOut,
): Promise<KyberBuiltSwap> {
  const json = await kyberFetch(cfg, `/${quote.chainName}/api/v1/route/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routeSummary: quote.routeSummary,
      sender: getAddress(owner),
      recipient: getAddress(owner),
      slippageTolerance: buildSlippageBps(quote, acceptedMinOut),
    }),
  });
  if (!json) throw new Error('KyberSwap is off');
  const top = asObject(json, 'Kyber build response');
  if (Number(top.code) !== 0) throw new Error(String(top.message ?? 'KyberSwap build failed'));
  const data = asObject(top.data, 'Kyber build data');
  assertZeroExtraFee(quote.routeSummary.extraFee);
  if (data.routeSummary !== undefined) {
    assertZeroExtraFee(asObject(data.routeSummary, 'Kyber build route summary').extraFee);
  }
  const router = getAddress(stringField(data, 'routerAddress', 'Kyber build router'));
  if (!sameToken(router, quote.router)) throw new Error('Kyber build uses an unverified router');
  const amountOut = bigintField(data, 'amountOut', 'Kyber build output amount');
  if (amountOut < acceptedMinOut) throw new Error('Kyber build output is below the accepted floor');
  const tx: DappTxRequest = {
    to: router,
    data: stringField(data, 'data', 'Kyber calldata') as `0x${string}`,
    value: `0x${bigintField(data, 'transactionValue', 'Kyber transaction value').toString(16)}` as `0x${string}`,
  };
  const minReturnAmount = validateKyberSwapTx(
    quote.chainId, owner, quote.tokenIn, quote.tokenOut, quote.amountIn, acceptedMinOut, tx,
  );
  return { tx, amountOut, minReturnAmount };
}

export function buildKyberApproveTx(chainId: number, token: `0x${string}`, amount: bigint): DappTxRequest {
  const router = KYBER_ROUTER_FOR[chainId];
  if (!router) throw new Error(`KyberSwap is not enabled on chain ${chainId}`);
  return {
    to: getAddress(token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, amount] }),
  };
}

export async function kyberAllowanceFor(
  endpoint: string,
  chainId: number,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const router = KYBER_ROUTER_FOR[chainId];
  if (!router) throw new Error(`KyberSwap is not enabled on chain ${chainId}`);
  return chainClient(endpoint, chainId).readContract({
    address: getAddress(token), abi: erc20Abi, functionName: 'allowance', args: [owner, router],
  }) as Promise<bigint>;
}
