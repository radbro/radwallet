/**
 * Uniswap V4 leg of RADSWAP. Same rules as the V3 leg: quotes are plain
 * eth_calls against the user's own RPC, execution goes straight to the
 * canonical Universal Router, and there is no fee address anywhere.
 *
 * V4 is a singleton (PoolManager) and swaps native ETH directly — no WETH
 * wrap — so when a V4 pool exists it is usually the cheaper route.
 */
import {
  encodeFunctionData,
  encodeAbiParameters,
  decodeFunctionResult,
  parseEther,
  formatUnits,
  zeroAddress,
} from 'viem';
import { createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { erc20Abi } from 'viem';
import type { SignerAccount } from './keyring.js';
import { client, RAD_TOKEN } from './chain.js';
import { chainClient, isRpcTransportError } from './tokens.js';
import { applySlippage } from './swap.js';

// canonical mainnet deployments (docs.uniswap.org/contracts/v4/deployments)
export const V4_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as const;
export const V4_QUOTER = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203' as const;
export const UNIVERSAL_ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as const;

export interface V4Deployment {
  poolManager: `0x${string}`;
  quoter: `0x${string}`;
  universalRouter: `0x${string}`;
}

/**
 * V4 per chain. Robinhood's were not guessed: the PoolManager is the contract
 * the explorer names, the quoter is the one contract on that chain whose
 * bytecode carries `quoteExactInputSingle` AND whose `poolManager()` returns
 * that manager, and the router is the address real swaps call, confirmed by
 * its bytecode embedding both the PoolManager and Permit2.
 */
export const UNISWAP_V4: Record<number, V4Deployment> = {
  1: {
    poolManager: V4_POOL_MANAGER,
    quoter: V4_QUOTER,
    universalRouter: UNIVERSAL_ROUTER,
  },
  4663: {
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
    universalRouter: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  },
};

/** Permit2 is at the same address on every chain that has it */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export function v4Deployment(chainId: number): V4Deployment | undefined {
  return UNISWAP_V4[chainId];
}

// Universal Router command + v4-periphery action bytes
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

export interface PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface SwapQuoteV4 {
  protocol: 'v4';
  amountInEth: string;
  amountOut: bigint;
  amountOutFormatted: string;
  minOut: bigint;
  minOutFormatted: string;
  slippagePct: number;
  poolKey: PoolKey;
  feeTierPct: string;
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const UR_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// hookless fee/tickSpacing pairs to probe, standard tiers
const CANDIDATE_KEYS: Array<[number, number]> = [
  [500, 10],
  [3000, 60],
  [10000, 200],
];

function radPoolKey(fee: number, tickSpacing: number): PoolKey {
  // native ETH is currency0 (address zero sorts first)
  return {
    currency0: zeroAddress,
    currency1: RAD_TOKEN.address,
    fee,
    tickSpacing,
    hooks: zeroAddress,
  };
}

/** Quote ETH -> $RAD across candidate V4 pools; null when no pool exists. */
export async function quoteEthToRadV4(
  endpoint: string,
  amountInEth: string,
  slippagePct = 1.0,
): Promise<SwapQuoteV4 | null> {
  const c = client(endpoint);
  const exactAmount = parseEther(amountInEth);
  let best: { amountOut: bigint; key: PoolKey } | null = null;
  for (const [fee, tickSpacing] of CANDIDATE_KEYS) {
    const key = radPoolKey(fee, tickSpacing);
    try {
      const data = encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: key, zeroForOne: true, exactAmount, hookData: '0x' }],
      });
      const res = await c.call({ to: V4_QUOTER, data });
      if (!res.data) continue;
      const [amountOut] = decodeFunctionResult({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        data: res.data,
      }) as unknown as [bigint, bigint];
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, key };
      }
    } catch {
      // pool doesn't exist at this tier — that's fine, keep probing
    }
  }
  if (!best) return null;
  const minOut = applySlippage(best.amountOut, slippagePct);
  return {
    protocol: 'v4',
    amountInEth,
    amountOut: best.amountOut,
    amountOutFormatted: fmt(best.amountOut),
    minOut,
    minOutFormatted: fmt(minOut),
    slippagePct,
    poolKey: best.key,
    feeTierPct: `${(best.key.fee / 10_000).toFixed(2)}%`,
  };
}

/**
 * Universal Router calldata for the quoted swap:
 * one V4_SWAP command = [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].
 * Pure function — unit tested against the byte layout.
 */
export function encodeV4SwapCalldata(quote: SwapQuoteV4, deadline: bigint): `0x${string}` {
  const amountIn = parseEther(quote.amountInEth);
  const actions = `0x${[ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;
  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [
      {
        poolKey: quote.poolKey,
        zeroForOne: true,
        amountIn,
        amountOutMinimum: quote.minOut,
        hookData: '0x',
      },
    ],
  );
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [quote.poolKey.currency0, amountIn],
  );
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [quote.poolKey.currency1, quote.minOut],
  );
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]],
  );
  return encodeFunctionData({
    abi: UR_ABI,
    functionName: 'execute',
    args: [`0x${CMD_V4_SWAP.toString(16).padStart(2, '0')}`, [v4Input], deadline],
  });
}

/** Execute the quoted V4 swap through the Universal Router. ETH in, $RAD out. */
export async function swapEthToRadV4(
  endpoint: string,
  account: SignerAccount,
  quote: SwapQuoteV4,
): Promise<`0x${string}`> {
  const latest = await client(endpoint).getBlock();
  const deadline = latest.timestamp + 1200n; // 20 minutes
  const wc = createWalletClient({ account, chain: mainnet, transport: http(endpoint) });
  return wc.sendTransaction({
    account,
    chain: mainnet,
    to: UNIVERSAL_ROUTER,
    data: encodeV4SwapCalldata(quote, deadline),
    value: parseEther(quote.amountInEth),
  });
}

function fmt(raw: bigint): string {
  const s = formatUnits(raw, RAD_TOKEN.decimals);
  const [i, f = ''] = s.split('.');
  const ff = f.slice(0, 2).replace(/0+$/, '');
  return ff ? `${Number(i).toLocaleString('en-US')}.${ff}` : Number(i).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// GENERAL V4: any pair, either direction, pools read off the chain
// ---------------------------------------------------------------------------

/**
 * WHY V4 POOLS HAVE TO BE DISCOVERED RATHER THAN GUESSED.
 *
 * A v3 pool is identified by (tokenA, tokenB, fee) and there are four fees, so
 * probing them all is cheap and complete. A v4 pool is identified by a PoolKey
 * that also carries a tickSpacing AND a hooks address, and neither is drawn
 * from a fixed set: URU on Robinhood trades in pools with fees of 97.369%,
 * 88%, 77%, 50% and 0.0075%, and its deepest market is a 0.30% pool behind the
 * hook at 0x8933d28E. No amount of guessing standard tiers finds any of that.
 *
 * The PoolManager indexes both currencies on its `Initialize` event, so the
 * chain will simply list every pool for a pair — one filtered `eth_getLogs`,
 * no indexer, no third party. Where an endpoint refuses that (mainnet's public
 * nodes cap or refuse full-range log queries) we fall back to probing the
 * standard tiers, which is what this file did before and is strictly better
 * than nothing.
 */
const INITIALIZE_EVENT = {
  type: 'event',
  name: 'Initialize',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false },
    { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

/** v4 sorts currencies by address, and native (the zero address) sorts first */
export function sortCurrencies(
  a: `0x${string}`,
  b: `0x${string}`,
): [`0x${string}`, `0x${string}`] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Whether an endpoint answers the full-range Initialize query is a POLICY,
 * not a state — mainnet's public nodes refuse it every single time — so it is
 * learned once per endpoint per session, and learned by ONE caller.
 *
 * Both halves matter. Without the verdict, every unpriced token on every
 * refresh re-asked a doomed question. Without the single-flight gate, the
 * FIRST refresh asked it for every unpriced token in parallel — the pricing
 * pass fans out under Promise.all — before any refusal could be recorded.
 * Against public nodes that is noise; through a bring-your-own mainnet FORK
 * each query is forwarded upstream with retries, and the resulting storm was
 * measured wedging an anvil node hard enough that a concurrent transaction
 * broadcast starved past a 15s timeout, four attempts in a row.
 */
const logDiscoveryVerdict = new Map<string, 'yes' | 'no'>();
const logDiscoveryProbe = new Map<string, Promise<void>>();

/** every v4 pool this chain has for the pair, straight from the PoolManager */
export async function discoverV4Pools(
  endpoint: string,
  chainId: number,
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
  opts: { throwOnRpcError?: boolean } = {},
): Promise<PoolKey[]> {
  const dep = v4Deployment(chainId);
  if (!dep) return [];
  const [currency0, currency1] = sortCurrencies(tokenA, tokenB);
  const fallback = (): PoolKey[] => CANDIDATE_KEYS.map(([fee, tickSpacing]) => ({
    currency0, currency1, fee, tickSpacing, hooks: zeroAddress,
  }));
  if (logDiscoveryVerdict.get(endpoint) === 'no') return fallback();
  if (!logDiscoveryVerdict.has(endpoint)) {
    const pending = logDiscoveryProbe.get(endpoint);
    if (pending) {
      // someone is already asking this endpoint whether it answers at all;
      // wait for the verdict rather than piling on
      await pending;
      return discoverV4Pools(endpoint, chainId, tokenA, tokenB);
    }
  }
  const isProbe = !logDiscoveryVerdict.has(endpoint);
  let release: (() => void) | undefined;
  if (isProbe) logDiscoveryProbe.set(endpoint, new Promise<void>((r) => { release = r; }));
  try {
    const logs = await chainClient(endpoint, chainId).getLogs({
      address: dep.poolManager,
      event: INITIALIZE_EVENT,
      fromBlock: 0n,
      toBlock: 'latest',
      args: { currency0, currency1 },
    });
    logDiscoveryVerdict.set(endpoint, 'yes');
    const seen = new Set<string>();
    const out: PoolKey[] = [];
    for (const l of logs) {
      const a = l.args as {
        fee?: number | bigint; tickSpacing?: number | bigint; hooks?: `0x${string}`;
      };
      const key: PoolKey = {
        currency0,
        currency1,
        fee: Number(a.fee ?? 0),
        tickSpacing: Number(a.tickSpacing ?? 0),
        hooks: a.hooks ?? zeroAddress,
      };
      const id = `${key.fee}:${key.tickSpacing}:${key.hooks}`.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(key);
    }
    if (out.length) return out;
  } catch (error) {
    if (opts.throwOnRpcError && isRpcTransportError(error)) throw error;
    // the endpoint will not answer a log query — remember the refusal and
    // fall through to probing, this time and every later time it is asked
    logDiscoveryVerdict.set(endpoint, 'no');
  } finally {
    if (isProbe) {
      logDiscoveryProbe.delete(endpoint);
      release?.();
    }
  }
  return fallback();
}

export interface V4PairQuote {
  amountOut: bigint;
  minOut: bigint;
  poolKey: PoolKey;
  zeroForOne: boolean;
}

/**
 * Best v4 quote for a pair, in whichever direction is being asked for.
 *
 * `tokenIn`/`tokenOut` are v4 currencies: native ETH is the ZERO ADDRESS here,
 * not WETH — v4 holds native directly and needs no wrapping.
 */
export async function quoteV4Pair(
  endpoint: string,
  chainId: number,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  slippagePct = 1,
  opts: { needsDepth?: boolean; throwOnRpcError?: boolean } = {},
): Promise<V4PairQuote | null> {
  const dep = v4Deployment(chainId);
  if (!dep || amountIn <= 0n) return null;
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
  const pools = await discoverV4Pools(endpoint, chainId, tokenIn, tokenOut, opts);
  if (!pools.length) return null;
  // selling currency0 is "zero for one"; selling currency1 is the other way
  const zeroForOne = pools[0].currency0.toLowerCase() === tokenIn.toLowerCase();

  /*
    ONE ROUND TRIP FOR EVERY CANDIDATE, like the v3 search.

    This used to fire an eth_call per pool with Promise.all and swallow any
    failure as "no pool". On a rate-limited endpoint that turned a throttled
    batch into "no route at all" — measured on Robinhood: one attempt in three
    came back empty while the next two quoted fine. A throttled request is not
    a missing market. multicall3 makes it a single call, and allowFailure marks
    the genuinely dry pools per entry rather than by losing the whole batch.
  */
  const probes = opts.needsDepth
    ? pools.flatMap((poolKey) => [
      { poolKey, amount: amountIn },
      { poolKey, amount: amountIn * 1000n },
    ])
    : pools.map((poolKey) => ({ poolKey, amount: amountIn }));

  const res = (await chainClient(endpoint, chainId).multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: probes.map((p) => ({
      address: dep.quoter,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: p.poolKey, zeroForOne, exactAmount: p.amount, hookData: '0x' }],
    })) as never,
  })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
  if (opts.throwOnRpcError) {
    const transportFailure = res.find((result) => (
      result.status === 'failure' && isRpcTransportError(result.error)
    ));
    if (transportFailure?.error) throw transportFailure.error;
  }

  const amountOf = (i: number): bigint | null => {
    const r = res[i];
    if (!r || r.status !== 'success') return null;
    const v = (r.result as readonly unknown[] | undefined)?.[0];
    return typeof v === 'bigint' && v > 0n ? v : null;
  };

  const results = pools.map((poolKey, n) => {
    const step = opts.needsDepth ? 2 : 1;
    const amountOut = amountOf(n * step);
    if (amountOut === null) return null;
    if (opts.needsDepth) {
      // THE SAME pool, a thousand times the size. Measured on URU's pools:
      // the real 0.30% market keeps 1.000 of its per-token price at x1000,
      // while the launch pools keep 0.19, 0.24 and 0.34. Half is the line.
      const deep = amountOf(n * step + 1);
      if (deep === null || deep * 2n < amountOut * 1000n) return null;
    }
    return { amountOut, poolKey };
  });

  let best: { amountOut: bigint; poolKey: PoolKey } | null = null;
  for (const r of results) if (r && (!best || r.amountOut > best.amountOut)) best = r;
  if (!best) return null;
  return {
    amountOut: best.amountOut,
    minOut: applySlippage(best.amountOut, slippagePct),
    poolKey: best.poolKey,
    zeroForOne,
  };
}

/**
 * Best v4 quote for a pair where a side may be NATIVE.
 *
 * v4 holds native ETH directly, so the obvious thing is to quote the native
 * currency and stop. That would have been a trap: on Robinhood the native
 * ETH/URU pools are launch-curve pools charging 50%–97%, while the real market
 * is a 0.30% pool against WRAPPED ether — 70,841 URU pays 0.0000672 ETH
 * through the best native pool and 0.0112 through the wrapped one, a factor of
 * 166. So both are quoted and the better wins; `wrapped` says the route runs
 * through WETH and therefore needs a wrap or an unwrap to settle in ETH.
 */
export async function quoteV4Best(
  endpoint: string,
  chainId: number,
  tokenIn: `0x${string}` | null,
  tokenOut: `0x${string}` | null,
  wrappedNative: `0x${string}` | undefined,
  amountIn: bigint,
  slippagePct = 1,
  opts: { needsDepth?: boolean; throwOnRpcError?: boolean } = {},
): Promise<(V4PairQuote & { wrapped: boolean }) | null> {
  if (!v4Deployment(chainId)) return null;
  const variants: { inn: `0x${string}`; out: `0x${string}`; wrapped: boolean }[] = [
    { inn: tokenIn ?? zeroAddress, out: tokenOut ?? zeroAddress, wrapped: false },
  ];
  if (wrappedNative && (tokenIn === null || tokenOut === null)) {
    variants.push({
      inn: tokenIn ?? wrappedNative,
      out: tokenOut ?? wrappedNative,
      wrapped: true,
    });
  }
  let best: (V4PairQuote & { wrapped: boolean }) | null = null;
  for (const v of variants) {
    let q: V4PairQuote | null;
    try {
      q = await quoteV4Pair(endpoint, chainId, v.inn, v.out, amountIn, slippagePct, opts);
    } catch (error) {
      if (opts.throwOnRpcError) throw error;
      q = null;
    }
    if (q && (!best || q.amountOut > best.amountOut)) best = { ...q, wrapped: v.wrapped };
  }
  return best;
}

/**
 * WHY A PRICE NEEDS MORE THAN A QUOTE.
 *
 * Asking a v4 pool what ONE token is worth is not the same as asking what a
 * token is worth. URU has launch-curve pools on Robinhood holding almost
 * nothing: the 50%-fee one pays 2.761e-7 ETH for a single URU — 73% ABOVE the
 * real market — and 1.082e-9 per token once sixty thousand are sold, a
 * hundredfold collapse. Taking the best one-token quote therefore put a price
 * on the asset sheet that was wrong in the flattering direction.
 *
 * The real market does not do that: the deep 0.30% pool pays the same 1.588e-7
 * per token at one, a thousand and sixty thousand. So `needsDepth` re-quotes
 * THE SAME pool at a thousand times the size — a fixed multiple of what was
 * already asked, so it reveals nothing about what anyone holds — and drops any
 * pool that keeps less than half its per-token price. Measured on those pools:
 * the market keeps 1.000, the launch pools keep 0.19, 0.24 and 0.34.
 *
 * A pool that is real but not deep may decline to price under this, and that
 * is the direction to fail in: the answer becomes "no price", which is what
 * the wallet said before, rather than a number that is wrong and flattering.
 *
 * Swapping deliberately does not use it: there the quote is for the amount
 * actually being sold, so a thin pool is already priced as thin.
 */

// ---------------------------------------------------------------------------
// EXECUTION: Universal Router + Permit2
// ---------------------------------------------------------------------------

/**
 * WHICH ExactInputSingleParams STRUCT THIS CHAIN'S ROUTER EXPECTS.
 *
 * v4-periphery added `uint256 minHopPriceX36` between `amountOutMinimum` and
 * `hookData`. Older Universal Router deployments (mainnet, Base) take the
 * struct without it; newer ones (Robinhood) take it. Encode the wrong shape
 * and the calldata silently misaligns — the router reverts with EMPTY data
 * from an out-of-bounds slice inside unlockCallback, which reads like a dead
 * RPC rather than a bug in the transaction.
 *
 * Not a guess: this is the same split the neochibi frontend proved on a real
 * Robinhood mainnet fork, and our encoder is byte-compared against theirs.
 */
const LEGACY_V4_STRUCT = new Set<number>([1, 8453, 84532, 31337]);

export function usesLegacyV4Struct(chainId: number): boolean {
  return LEGACY_V4_STRUCT.has(chainId);
}

/** UniversalRouter command bytes */
const CMD_UNWRAP_WETH = 0x0c;
/** v4-periphery action bytes: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL */
const ACTIONS_EXACT_IN = '0x060c0f' as const;

const PERMIT2_ABI = [
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' }, { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }], outputs: [],
  },
] as const;

/** Permit2 allowances are uint160, and it expires — 30 days, like everyone else */
export const MAX_PERMIT2_AMOUNT = (1n << 160n) - 1n;
const PERMIT2_EXPIRY_SECONDS = 60n * 60n * 24n * 30n;

/**
 * `inputs[0]` for a single exact-input v4 swap.
 *
 * The params MUST go in as ONE tuple, not flat fields: `hookData` is dynamic,
 * so the struct is offset-prefixed, and a flat encoding trips the router's
 * SliceOutOfBounds.
 */
export function encodeV4SwapInput(
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
  chainId: number,
): `0x${string}` {
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const legacy = usesLegacyV4Struct(chainId);
  const components = [
    { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    ...(legacy ? [] : [{ name: 'minHopPriceX36', type: 'uint256' }]),
    { name: 'hookData', type: 'bytes' },
  ];
  const swapParams = encodeAbiParameters(
    [{ type: 'tuple', components }] as never,
    [legacy
      ? { poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }
      // 0 skips the router's per-hop price check; slippage is amountOutMinimum
      : { poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' },
    ] as never,
  );
  const settleParams = encodeAbiParameters(
    [{ name: 'currency', type: 'address' }, { name: 'maxAmount', type: 'uint256' }],
    [inputCurrency, amountIn],
  );
  const takeParams = encodeAbiParameters(
    [{ name: 'currency', type: 'address' }, { name: 'minAmount', type: 'uint256' }],
    [outputCurrency, amountOutMinimum],
  );
  return encodeAbiParameters(
    [{ name: 'actions', type: 'bytes' }, { name: 'params', type: 'bytes[]' }],
    [ACTIONS_EXACT_IN, [swapParams, settleParams, takeParams]],
  );
}

/** the swap transaction itself: one V4_SWAP command at the Universal Router */
export function buildV4SwapTx(
  chainId: number,
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
  deadline: bigint,
): { to: `0x${string}`; data: `0x${string}`; value?: `0x${string}` } {
  const dep = v4Deployment(chainId);
  if (!dep) throw new Error(`no Uniswap v4 on chain ${chainId}`);
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  // a native input rides along as value; an ERC-20 one is pulled via Permit2
  const nativeIn = inputCurrency === zeroAddress;
  return {
    to: dep.universalRouter,
    data: encodeFunctionData({
      abi: UR_ABI,
      functionName: 'execute',
      args: [
        `0x${CMD_V4_SWAP.toString(16).padStart(2, '0')}`,
        [encodeV4SwapInput(poolKey, zeroForOne, amountIn, amountOutMinimum, chainId)],
        deadline,
      ],
    }),
    ...(nativeIn ? { value: `0x${amountIn.toString(16)}` as `0x${string}` } : {}),
  };
}

/** wrap native ETH into the chain's WETH, so a wrapped-ether pool can be used */
export function buildWrapTx(weth: `0x${string}`, amount: bigint) {
  return {
    to: weth,
    data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }),
    value: `0x${amount.toString(16)}` as `0x${string}`,
  };
}

/** and back out again, so a swap that lands in WETH still pays you in ETH */
export function buildUnwrapTx(weth: `0x${string}`, amount: bigint) {
  return {
    to: weth,
    data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [amount] }),
  };
}

export interface V4Approval {
  kind: 'erc20-to-permit2' | 'permit2-to-router';
  to: `0x${string}`;
  data: `0x${string}`;
  /** what the user is being asked to allow, for the preview */
  spender: `0x${string}`;
  amount: bigint;
}

/**
 * What still has to be allowed before a v4 swap can pull an ERC-20.
 *
 * Two hops, because that is how Permit2 works: the token is approved to
 * Permit2 once, and Permit2 is then told which spender may move it and until
 * when. Both are read first, so a wallet that has already done this signs
 * nothing extra. Neither is unlimited — same rule as the v3 path, which
 * rewrites unlimited approvals when a dapp asks for one.
 */
export async function v4ApprovalsNeeded(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  token: `0x${string}`,
  amountIn: bigint,
  nowSeconds: bigint,
): Promise<V4Approval[]> {
  const dep = v4Deployment(chainId);
  if (!dep || token === zeroAddress) return [];
  if (amountIn > MAX_PERMIT2_AMOUNT) throw new Error('amount is too large for Permit2');
  const c = client(endpoint);
  const out: V4Approval[] = [];

  const erc20Allowance = (await c.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2],
  }).catch(() => 0n)) as bigint;
  if (erc20Allowance < amountIn) {
    out.push({
      kind: 'erc20-to-permit2',
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, amountIn] }),
      spender: PERMIT2,
      amount: amountIn,
    });
  }

  const permit = (await c.readContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
    args: [owner, token, dep.universalRouter],
  }).catch(() => [0n, 0, 0] as const)) as readonly [bigint, number, number];
  if (permit[0] < amountIn || BigInt(permit[1]) <= nowSeconds) {
    out.push({
      kind: 'permit2-to-router',
      to: PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token, dep.universalRouter, amountIn, Number(nowSeconds + PERMIT2_EXPIRY_SECONDS)],
      }),
      spender: dep.universalRouter,
      amount: amountIn,
    });
  }
  return out;
}
