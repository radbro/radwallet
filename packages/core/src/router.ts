/**
 * Best execution: quote V3 and V4 in parallel, route to whichever pays more.
 * Both quotes are shown to the user — the route table is the receipt.
 */
import type { SignerAccount } from './keyring.js';
import { quoteEthToRad, swapEthToRad, type SwapQuote } from './swap.js';
import { quoteEthToRadV4, swapEthToRadV4, type SwapQuoteV4 } from './swapv4.js';
import { withFailover } from './tokens.js';
import { buildSwapTx } from './swapany.js';
import { encodeV4SwapCalldata, UNIVERSAL_ROUTER } from './swapv4.js';
import { RAD_TOKEN, type DappTxRequest } from './chain.js';
import { WETH } from './swap.js';
import { parseTokenAmount } from './amounts.js';

export interface RouteComparison {
  v3: SwapQuote | null;
  v4: SwapQuoteV4 | null;
  best: 'v3' | 'v4' | null;
}

export interface LocatedRouteComparison extends RouteComparison {
  /** The endpoint that actually produced this quote. Keep execution on it. */
  endpoint: string;
}

/** Build the displayed quote without replacing its minimum with a new quote. */
export function buildBestRouteTx(
  route: RouteComparison,
  owner: `0x${string}`,
  deadline: bigint,
): DappTxRequest {
  if (route.best === 'v4' && route.v4) {
    return {
      to: UNIVERSAL_ROUTER,
      data: encodeV4SwapCalldata(route.v4, deadline),
      value: `0x${parseTokenAmount(route.v4.amountInEth, 18).toString(16)}`,
    };
  }
  if (route.best === 'v3' && route.v3) {
    return buildSwapTx(1, owner,
      { address: null, symbol: 'ETH', decimals: 18 },
      { address: RAD_TOKEN.address, symbol: RAD_TOKEN.symbol, decimals: RAD_TOKEN.decimals },
      parseTokenAmount(route.v3.amountInEth, 18),
      { ...route.v3, protocol: 'v3', hops: [WETH, RAD_TOKEN.address], fees: [route.v3.feeTier] },
    );
  }
  throw new Error('No displayed swap route is available.');
}

export async function bestEthToRadRoute(
  endpoint: string,
  amountInEth: string,
  slippagePct = 1.0,
): Promise<RouteComparison> {
  const [v3r, v4r] = await Promise.allSettled([
    quoteEthToRad(endpoint, amountInEth, slippagePct),
    quoteEthToRadV4(endpoint, amountInEth, slippagePct),
  ]);
  const v3 = v3r.status === 'fulfilled' ? v3r.value : null;
  const v4 = v4r.status === 'fulfilled' ? v4r.value : null;
  let best: RouteComparison['best'] = null;
  if (v3 && v4) best = v4.amountOut > v3.amountOut ? 'v4' : 'v3';
  else if (v3) best = 'v3';
  else if (v4) best = 'v4';
  return { v3, v4, best };
}

/**
 * Ask the account's pinned endpoint first, then the rest of its RPC pool.
 *
 * `bestEthToRadRoute` intentionally turns a failed V3/V4 pair into `best:
 * null`, because that is also how a genuinely missing market looks. At the
 * wallet boundary, however, one endpoint's empty answer cannot stand in for
 * the whole pool. The endpoint is returned with the quote so the signing path
 * does not immediately jump back to the node that just failed.
 */
export async function bestEthToRadRouteAcross(
  endpoints: readonly string[],
  amountInEth: string,
  slippagePct = 1.0,
  probe: typeof bestEthToRadRoute = bestEthToRadRoute,
): Promise<LocatedRouteComparison> {
  return withFailover([...endpoints], async (endpoint) => {
    const route = await probe(endpoint, amountInEth, slippagePct);
    if (!route.best) throw new Error('no ETH/$RAD route from this endpoint');
    return { ...route, endpoint };
  });
}

export async function executeBestRoute(
  endpoint: string,
  account: SignerAccount,
  route: RouteComparison,
): Promise<`0x${string}`> {
  if (route.best === 'v4' && route.v4) return swapEthToRadV4(endpoint, account, route.v4);
  if (route.best === 'v3' && route.v3) return swapEthToRad(endpoint, account, route.v3);
  throw new Error('no route available — is the RPC reachable?');
}
