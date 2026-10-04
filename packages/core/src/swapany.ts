/**
 * Swapping any pair, not just the house one.
 *
 * `swap.ts` quotes and executes ETH→$RAD on mainnet and does it well (racing
 * v3 against v4 in `router.ts`). But the UI now offers SWAP on every asset
 * row, and a button that errors on everything except one pair is the wallet
 * overstating itself. This module is the general path:
 *
 *   quoteSwap()      what you would get, across fee tiers
 *   buildApproveTx() the allowance an ERC-20 input needs first
 *   buildSwapTx()    the swap itself
 *
 * ROUTING. Direct pools across every fee tier, plus two-hop routes through a
 * short list of tokens that actually have depth (the chain's WETH first, then
 * its major stables). Every candidate is quoted in ONE multicall — the whole
 * search is a single round trip, where the old direct-only version took four —
 * and the best output wins.
 *
 * Deliberate limits, stated rather than hidden behind a spinner:
 *
 *   - two hops, not three. Each extra hop multiplies the candidate set by the
 *     fee tiers and buys less each time; three-hop routes are where an
 *     aggregator earns its keep, and this is a wallet.
 *   - GAS IS NOT MODELLED. A two-hop route costs more gas than a direct one,
 *     so a route that wins by a hair may not be worth it at a high base fee.
 *     Ties go to the shorter path, the route is shown on screen rather than
 *     hidden, and that is the honest extent of it.
 *   - v3 first, v4 every time, and on Robinhood the PONS CURVE as a third
 *     venue (`ponsswap.ts`). A Pons launch has no pool at all until it
 *     graduates — its curve IS the market — so the search asks the curve in
 *     parallel with the pools and the best output wins, whichever kind of
 *     contract pays it.
 *   - no fee address, here or anywhere. Uniswap takes its pool fee, a Pons
 *     curve takes its own; we take nothing, which is the whole point of
 *     RADSWAP.
 */
import { encodeFunctionData, encodePacked, erc20Abi, getAddress } from 'viem';
import type { DappTxRequest } from './chain.js';
import { chainClient } from './tokens.js';
import { UNISWAP_V3, TOKENS } from './chains.js';
import {
  quoteV4Best, v4Deployment, buildV4SwapTx, buildWrapTx, buildUnwrapTx, v4ApprovalsNeeded,
  type PoolKey,
} from './swapv4.js';
import {
  quotePonsVenueSwap, buildPonsVenueSwapTx, buildPonsVenueApproveTx, ponsVenueAllowance,
  ponsVenueSpendToken, preflightPonsVenueSwap, type PonsVenueQuote,
} from './ponsswap.js';
import { WETH_FOR } from './price.js';
// one slippage rule for every pair, shared with the house-pair path
import { applySlippage } from './swap.js';

/** SwapRouter02 per chain, from the one registry map. Absent = cannot swap. */
export const ROUTER_FOR: Record<number, `0x${string}`> = Object.fromEntries(
  Object.entries(UNISWAP_V3).map(([id, d]) => [Number(id), d.router]),
);

const QUOTER_FOR: Record<number, `0x${string}`> = Object.fromEntries(
  Object.entries(UNISWAP_V3).map(([id, d]) => [Number(id), d.quoter]),
);

const FEE_TIERS = [500, 3000, 10_000, 100] as const;
/**
 * Fee tiers tried on each leg of a two-hop route. The 1bp tier is left out
 * here on purpose: it exists for stable-to-stable pairs and including it would
 * square the candidate count for routes that almost never win.
 */
const HOP_FEES = [500, 3000, 10_000] as const;

/**
 * Tokens worth routing THROUGH, per chain — the ones with real depth against
 * everything else. The chain's wrapped native is always tried first and is not
 * repeated here. Every address below was read back off its own chain for
 * symbol and decimals before being trusted, like the bundled token list.
 */
const HOP_TOKENS: Record<number, `0x${string}`[]> = {
  1: [
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  ],
  8453: [
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
  ],
  42161: [
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
  ],
  4663: [
    '0x94b53E072798E6cce65cF21f050d3CB9F2bFb058', // USDG
  ],
};

/** at most this many intermediates, so the candidate set stays one round trip */
const MAX_HOP_TOKENS = 4;

export function canSwapOn(chainId: number): boolean {
  return chainId in ROUTER_FOR && chainId in QUOTER_FOR;
}

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
] as const;

const routerAbi = [
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function', name: 'exactInput', stateMutability: 'payable',
    inputs: [{
      type: 'tuple',
      components: [
        { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function', name: 'unwrapWETH9', stateMutability: 'payable',
    inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function', name: 'multicall', stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

/** null address means the chain's native coin */
export type SwapSide = { address: `0x${string}` | null; symbol: string; decimals: number };

export interface AnyQuote {
  amountOut: bigint;
  /** the first hop's fee tier — what a direct quote has always reported */
  feeTier: number;
  /** what the router will be told is acceptable, after slippage */
  minOut: bigint;
  /** every token along the route, in order. length 2 = direct */
  hops: `0x${string}`[];
  /** the pool fee for each hop; one shorter than `hops` */
  fees: number[];
  /**
   * Which venue this quote came from. Only 'v3' can be built by buildSwapTx;
   * 'v4' and 'pons' quotes are REAL prices off a real contract, but their
   * transactions come out of planSwap, which knows their extra steps.
   */
  protocol: 'v3' | 'v4' | 'pons';
  /** v4 only: the pool the quote came from, hooks and all */
  poolKey?: PoolKey;
  /** v4 only: true when selling the pool's currency0 */
  zeroForOne?: boolean;
  /** v4 only: the route goes through WRAPPED native and needs a wrap/unwrap */
  wrapped?: boolean;
  /** pons only: the curve, the side, and every take the curve makes */
  pons?: PonsVenueQuote;
}

/**
 * A v3 path: token, fee, token, fee, token … packed tight. The router walks it
 * left to right, so the order is the order the swap happens in.
 */
export function encodePath(tokens: `0x${string}`[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) throw new Error('a path needs one fee per hop');
  const types: string[] = ['address'];
  const values: (string | number)[] = [tokens[0]];
  fees.forEach((fee, i) => {
    types.push('uint24', 'address');
    values.push(fee, tokens[i + 1]);
  });
  return encodePacked(types, values);
}

/** the router address every input token must be approved for */
export function routerFor(chainId: number): `0x${string}` {
  const r = ROUTER_FOR[chainId];
  if (!r) throw new Error(`no Uniswap router on chain ${chainId}`);
  return r;
}

function wrapped(side: SwapSide, chainId: number): `0x${string}` {
  if (side.address) return getAddress(side.address);
  const weth = WETH_FOR[chainId];
  if (!weth) throw new Error(`no wrapped native token on chain ${chainId}`);
  return weth;
}

/**
 * What this pair pays right now, taking the best fee tier. Returns null when
 * no pool answers — which is the honest result for a pair nobody has made a
 * market in, and better than a route through three hops the user never asked
 * for.
 */
/** the tokens worth routing through on this chain, minus the pair itself */
export function hopCandidates(
  chainId: number,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): `0x${string}`[] {
  const seen = new Set([tokenIn.toLowerCase(), tokenOut.toLowerCase()]);
  const out: `0x${string}`[] = [];
  // wrapped native first: on every chain here it is the token most pairs are
  // actually made against
  for (const t of [WETH_FOR[chainId], ...(HOP_TOKENS[chainId] ?? [])]) {
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(getAddress(t));
    if (out.length >= MAX_HOP_TOKENS) break;
  }
  return out;
}

/** every route worth asking about for this pair, direct and two-hop */
export function routeCandidates(
  chainId: number,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): { hops: `0x${string}`[]; fees: number[] }[] {
  const out: { hops: `0x${string}`[]; fees: number[] }[] = [];
  for (const fee of FEE_TIERS) out.push({ hops: [tokenIn, tokenOut], fees: [fee] });
  for (const mid of hopCandidates(chainId, tokenIn, tokenOut)) {
    for (const a of HOP_FEES) {
      for (const b of HOP_FEES) out.push({ hops: [tokenIn, mid, tokenOut], fees: [a, b] });
    }
  }
  return out;
}

export async function quoteSwap(
  endpoint: string,
  chainId: number,
  from: SwapSide,
  to: SwapSide,
  amountIn: bigint,
  slippagePct = 1,
  /**
   * Who will sign. Only the Pons venue needs it: a launch charges a
   * PER-RECIPIENT tax in its first seconds, so the price depends on who is
   * buying. Without an owner the curve is not consulted at all — a quote
   * that ignored the tax would be wrong in the flattering direction.
   */
  owner?: `0x${string}`,
): Promise<AnyQuote | null> {
  if (!canSwapOn(chainId) || amountIn <= 0n) return null;
  const tokenIn = wrapped(from, chainId);
  const tokenOut = wrapped(to, chainId);
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

  const client = chainClient(endpoint, chainId);
  const quoter = QUOTER_FOR[chainId];
  const cands = routeCandidates(chainId, tokenIn, tokenOut);

  // THE CURVE IS ASKED IN PARALLEL WITH THE POOLS. Its failure is kept, not
  // swallowed: when no pool answers either, "why the curve would not" is the
  // one useful thing the screen can say.
  const ponsAsked = owner
    ? quotePonsVenueSwap(endpoint, chainId, from.address, to.address, amountIn, getAddress(owner))
      .catch((e: Error) => e)
    : Promise.resolve(null);

  // ONE round trip for the whole search. QuoterV2's methods are nonpayable —
  // they work by reverting inside the pool callback and catching it — which is
  // fine through multicall3 under eth_call: nothing is committed either way.
  // batchSize matters: viem chunks multicall calldata at 1KB by default, which
  // would split this back into the many requests it exists to avoid.
  const res = (await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: cands.map((c) => (c.fees.length === 1
      ? {
        address: quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: c.hops[0], tokenOut: c.hops[1], amountIn, fee: c.fees[0], sqrtPriceLimitX96: 0n,
        }],
      }
      : {
        address: quoter, abi: quoterAbi, functionName: 'quoteExactInput',
        args: [encodePath(c.hops, c.fees), amountIn],
      })) as never,
  })) as { status: 'success' | 'failure'; result?: unknown }[];

  let best: AnyQuote | null = null;
  for (let i = 0; i < res.length; i++) {
    const r = res[i];
    if (r.status !== 'success') continue; // no pool on some leg of this route
    const amountOut = (r.result as readonly unknown[] | undefined)?.[0] as bigint;
    if (typeof amountOut !== 'bigint' || amountOut <= 0n) continue;
    const c = cands[i];
    // best output wins; a tie goes to the shorter path, which is the cheaper
    // one to execute. Gas is not priced in — see the note at the top.
    const better = !best
      || amountOut > best.amountOut
      || (amountOut === best.amountOut && c.hops.length < best.hops.length);
    if (!better) continue;
    best = {
      amountOut,
      feeTier: c.fees[0],
      minOut: applySlippage(amountOut, slippagePct),
      hops: c.hops,
      fees: c.fees,
      protocol: 'v3',
    };
  }
  /*
    AND ALSO ASK V4, EVERY TIME.

    v4 is a different exchange, not a newer one: URU on Robinhood has no v3
    pool at all and seven v4 pools. It used to be consulted only when v3 came
    back empty, which was right while v4 could not be signed — but it can be
    now, so "v3 found something" is no longer a reason to stop looking. A thin
    v3 pool would otherwise quietly beat a deep v4 one.
  */
  const v3Best = best;
  const v4 = v4Deployment(chainId)
    ? await quoteV4Best(
      endpoint, chainId, from.address, to.address, WETH_FOR[chainId], amountIn, slippagePct,
    ).catch(() => null)
    : null;
  // ties go to v3: one signature instead of up to four, and no Permit2
  const poolBest: AnyQuote | null = (!v4 || (v3Best && v4.amountOut <= v3Best.amountOut))
    ? v3Best
    : {
      amountOut: v4.amountOut,
      feeTier: v4.poolKey.fee,
      minOut: v4.minOut,
      hops: [tokenIn, tokenOut],
      fees: [v4.poolKey.fee],
      protocol: 'v4',
      poolKey: v4.poolKey,
      zeroForOne: v4.zeroForOne,
      wrapped: v4.wrapped,
    };

  /*
    AND THE PONS CURVE, ON ROBINHOOD.

    Before graduation the curve is the only market the token has; after it,
    the curve refuses and the pool search above is the answer. The comparison
    is real anyway — ties go to the pools, and a curve that pays less than a
    pool loses. A curve that could not serve the pair (sold out, priced in a
    token you are not offering) is reported only when the pools had nothing
    either: that is the case where the reason is the whole message.
  */
  const pons = await ponsAsked;
  if (pons instanceof Error) {
    if (poolBest) return poolBest;
    throw pons;
  }
  if (!pons || (poolBest && pons.amountOut <= poolBest.amountOut)) return poolBest;
  return {
    amountOut: pons.amountOut,
    feeTier: Number(pons.feeBps),
    minOut: applySlippage(pons.amountOut, slippagePct),
    hops: [tokenIn, tokenOut],
    fees: [Number(pons.feeBps)],
    protocol: 'pons',
    pons,
  };
}

/**
 * What a quote actually routes through, in words.
 *
 * A two-hop route is a different trade from a direct one — more gas, another
 * pool's depth — so it is named by the token in the middle. "via USDC" is the
 * part a person can judge; a pair of fee percentages on their own is not.
 */
export function describeRoute(q: AnyQuote): string {
  const fees = q.fees.map((f) => `${(f / 10_000).toFixed(2)}%`).join(' + ');
  if (q.protocol === 'pons' && q.pons) {
    // every take the curve makes, by name: the fee and the creator tax are
    // permanent, the launch tax is a few seconds old and says so
    const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
    const parts = [`pons curve · ${pct(q.pons.feeBps)} fee`];
    if (q.pons.creatorTaxBps > 0n) parts.push(`${pct(q.pons.creatorTaxBps)} creator tax`);
    if (q.pons.snipeTaxBps > 0n) parts.push(`${pct(q.pons.snipeTaxBps)} launch tax right now`);
    return parts.join(' + ');
  }
  if (q.protocol === 'v4') {
    const hook = q.poolKey && q.poolKey.hooks !== '0x0000000000000000000000000000000000000000';
    return `uniswap v4 · ${fees}${q.wrapped ? ' · wrapped-ether pool' : ''}${hook ? ' · hooked' : ''}`;
  }
  if (q.fees.length < 2) return `uniswap v3 · ${fees}`;
  const via = q.hops.slice(1, -1).map(tokenSymbol).join(' → ');
  return `uniswap v3 · via ${via} · ${fees}`;
}

/** the bundled list is the only name we have for a token we merely route through */
function tokenSymbol(address: `0x${string}`): string {
  const want = address.toLowerCase();
  for (const list of Object.values(TOKENS)) {
    const hit = list.find((t) => t.address.toLowerCase() === want);
    if (hit) return hit.symbol;
  }
  return `${address.slice(0, 6)}…`;
}

/** the approval an ERC-20 input needs before the router can pull it */
export function buildApproveTx(
  chainId: number,
  token: `0x${string}`,
  amount: bigint,
): DappTxRequest {
  return {
    to: getAddress(token),
    // exact amount, never unlimited: this wallet rewrites unlimited approvals
    // when a dapp asks for one, so it is not about to sign one for itself
    data: encodeFunctionData({
      abi: erc20Abi, functionName: 'approve', args: [routerFor(chainId), amount],
    }),
  };
}

/** how much the router is currently allowed to pull */
export async function allowanceFor(
  endpoint: string,
  chainId: number,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const client = chainClient(endpoint, chainId);
  return client.readContract({
    address: getAddress(token), abi: erc20Abi, functionName: 'allowance',
    args: [owner, routerFor(chainId)],
  }) as Promise<bigint>;
}

/**
 * The swap itself.
 *
 * A native OUTPUT has to be unwrapped, so the router keeps the WETH and hands
 * it back as ETH in the same transaction — otherwise you would end up holding
 * WETH you did not ask for.
 */
export function buildSwapTx(
  chainId: number,
  owner: `0x${string}`,
  from: SwapSide,
  to: SwapSide,
  amountIn: bigint,
  quote: AnyQuote,
): DappTxRequest {
  if (quote.protocol === 'v4') {
    // v4 settles through the Universal Router, not SwapRouter02 — planSwap()
    // builds that one, together with the Permit2 steps it needs
    throw new Error('v4 swaps are built by planSwap, not buildSwapTx');
  }
  if (quote.protocol === 'pons') {
    // the curve is not a router: it takes its own buy/sell call, from planSwap
    throw new Error('Pons curve swaps are built by planSwap, not buildSwapTx');
  }
  const router = routerFor(chainId);
  const tokenIn = wrapped(from, chainId);
  const tokenOut = wrapped(to, chainId);
  const nativeIn = from.address === null;
  const nativeOut = to.address === null;

  // native out lands at the router first, then unwrapWETH9 forwards it
  const recipient = nativeOut ? router : getAddress(owner);
  const multiHop = quote.fees.length > 1;

  // a direct route keeps exactInputSingle: same trade, less calldata and less
  // gas than walking a one-hop path
  const swap = multiHop
    ? encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInput',
      args: [{
        path: encodePath(quote.hops, quote.fees),
        recipient,
        amountIn,
        amountOutMinimum: quote.minOut,
      }],
    })
    : encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn,
        tokenOut,
        fee: quote.feeTier,
        recipient,
        amountIn,
        amountOutMinimum: quote.minOut,
        sqrtPriceLimitX96: 0n,
      }],
    });

  if (!nativeOut) {
    return {
      to: router,
      data: swap,
      ...(nativeIn ? { value: `0x${amountIn.toString(16)}` as `0x${string}` } : {}),
    };
  }

  const unwrap = encodeFunctionData({
    abi: routerAbi, functionName: 'unwrapWETH9', args: [quote.minOut, getAddress(owner)],
  });
  return {
    to: router,
    data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [[swap, unwrap]] }),
    ...(nativeIn ? { value: `0x${amountIn.toString(16)}` as `0x${string}` } : {}),
  };
}


// ---------------------------------------------------------------------------
// THE WHOLE SWAP, AS STEPS
// ---------------------------------------------------------------------------

export interface SwapStep {
  /** what this asks the user to sign, in their words */
  label: string;
  tx: DappTxRequest;
}

/**
 * Everything a swap needs signed, in order.
 *
 * v3 is one approval and one call. v4 is up to two approvals — Permit2 is a
 * separate contract, so a token is approved to Permit2 and Permit2 is then
 * told which spender may move it — and, when the best pool is denominated in
 * WRAPPED ether but you asked for ETH, a wrap before or an unwrap after.
 *
 * Putting the sequence here rather than in the screen keeps one place that
 * knows what a swap costs in signatures, and lets the UI just walk the list.
 */
export interface SwapPlan {
  /** must be signed before the swap; re-read from the chain, so usually empty */
  approvals: SwapStep[];
  /** native ETH turned into WETH so a wrapped-ether pool can take it */
  wrap?: SwapStep;
  swap: SwapStep;
  /** WETH turned back into ETH, so you are paid in what you asked for */
  unwrap?: SwapStep;
  /** the same, sized against the balance the swap actually produced */
  unwrapAll?: () => Promise<DappTxRequest>;
}

export async function planSwap(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  from: SwapSide,
  to: SwapSide,
  amountIn: bigint,
  quote: AnyQuote,
  /**
   * Chain time, NOT the user's clock. A v4 swap carries a deadline the router
   * checks against `block.timestamp`, and a laptop twenty minutes slow would
   * have every swap revert as expired with nothing on screen to explain it.
   * Read from the chain when the caller does not supply it.
   */
  nowSeconds?: bigint,
): Promise<SwapPlan> {
  if (quote.protocol === 'pons') {
    if (!quote.pons) throw new Error('Pons quote carries no curve');
    const q = quote.pons;
    const client = chainClient(endpoint, chainId) as unknown as Parameters<typeof ponsVenueAllowance>[0];
    const approvals: SwapStep[] = [];
    // selling the token, or buying with an ERC-20 quote asset, means the
    // curve pulls from you — an exact allowance, like the router gets
    const spendToken = ponsVenueSpendToken(q);
    let allowed = true;
    if (spendToken) {
      const have = await ponsVenueAllowance(client, spendToken, owner, q.curve).catch(() => 0n);
      if (have < amountIn) {
        allowed = false;
        approvals.push({
          label: `let the Pons curve move your ${from.symbol}`,
          tx: buildPonsVenueApproveTx(spendToken, q.curve, amountIn),
        });
      }
    }
    const tx = buildPonsVenueSwapTx(q, getAddress(owner), amountIn, quote.minOut);
    // dry-run the exact call now, so a curve that graduated or sold out since
    // the quote says so here rather than at the signing prompt. A sell that
    // still needs its approval cannot be dry-run yet: the curve would revert
    // on the pull, not on the trade.
    if (allowed) await preflightPonsVenueSwap(client, tx);
    return {
      approvals,
      swap: {
        label: q.side === 'buy'
          ? `buy ${to.symbol} on its Pons curve`
          : `sell ${from.symbol} back to its Pons curve`,
        tx,
      },
    };
  }
  if (quote.protocol === 'v3') {
    const approvals: SwapStep[] = [];
    if (from.address) {
      const have = await allowanceFor(endpoint, chainId, from.address, owner).catch(() => 0n);
      if (have < amountIn) {
        approvals.push({
          label: `let the router move your ${from.symbol}`,
          tx: buildApproveTx(chainId, from.address, amountIn),
        });
      }
    }
    return {
      approvals,
      swap: {
        label: `swap ${from.symbol} for ${to.symbol}`,
        tx: buildSwapTx(chainId, owner, from, to, amountIn, quote),
      },
    };
  }

  const dep = v4Deployment(chainId);
  if (!dep || !quote.poolKey) throw new Error(`no Uniswap v4 on chain ${chainId}`);
  const now = nowSeconds ?? (await chainClient(endpoint, chainId).getBlock()).timestamp;
  const weth = WETH_FOR[chainId];
  const wrappedRoute = quote.wrapped === true;
  // through a wrapped-ether pool the swap spends and pays WETH, so native sides
  // gain a step at whichever end they are on
  const spendToken = from.address ?? (wrappedRoute ? weth : null);
  const plan: SwapPlan = {
    approvals: [],
    swap: {
      label: `swap ${from.symbol} for ${to.symbol}`,
      tx: buildV4SwapTx(
        chainId, quote.poolKey, quote.zeroForOne === true, amountIn, quote.minOut,
        now + 1200n,
      ),
    },
  };
  if (!from.address && wrappedRoute && weth) {
    plan.wrap = { label: `wrap ${from.symbol} into WETH`, tx: buildWrapTx(weth, amountIn) };
  }
  if (!to.address && wrappedRoute && weth) {
    /*
      minOut is the FLOOR, not what arrives. Unwrapping it would leave the
      difference — up to the whole slippage allowance — sitting as WETH you
      never asked for, so this is rebuilt against the real balance once the
      swap has landed (see `unwrapAllTx`). The planned one is the fallback if
      that read fails, and it is safe because minOut is guaranteed.
    */
    plan.unwrap = { label: `unwrap WETH back into ${to.symbol}`, tx: buildUnwrapTx(weth, quote.minOut) };
    plan.unwrapAll = async (): Promise<DappTxRequest> => {
      const held = (await chainClient(endpoint, chainId).readContract({
        address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [owner],
      }).catch(() => 0n)) as bigint;
      return held > 0n ? buildUnwrapTx(weth, held) : buildUnwrapTx(weth, quote.minOut);
    };
  }
  if (spendToken) {
    const needed = await v4ApprovalsNeeded(endpoint, chainId, owner, spendToken, amountIn, now);
    plan.approvals = needed.map((a) => ({
      label: a.kind === 'erc20-to-permit2'
        ? `let Permit2 hold your ${from.symbol} allowance`
        : `let the router spend that ${from.symbol} allowance`,
      tx: { to: a.to, data: a.data },
    }));
  }
  return plan;
}
