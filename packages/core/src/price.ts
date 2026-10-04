/**
 * What a token is worth, asked of the chain itself.
 *
 * No price API, no key, no third party: this quotes a real Uniswap v3 pool
 * through QuoterV2 and reports how much ETH one token would actually fetch
 * right now. That is not "the price" in the CoinGecko sense — it is the price
 * you could get, which is the number a wallet should show anyway.
 *
 * The trade-off, stated because the UI has to: this is a SPOT quote and there
 * is no history in it. A chart needs prices at past blocks, and every public
 * endpoint we ship either refuses archive calls outright (publicnode:
 * "Archive requests require a personal token") or caps them around 5k blocks
 * (~17 hours of mainnet). Historical charting therefore lives behind the
 * opt-in feed in pricefeed.ts, and this file stays RPC-only.
 */
import { encodeFunctionData, decodeFunctionResult, parseUnits, formatEther } from 'viem';
import { chainClient, isRpcTransportError } from './tokens.js';
import { quoteV4Best } from './swapv4.js';
import { CHAINS, UNISWAP_V3 } from './chains.js';

/** QuoterV2, per chain. Absent chains simply have no on-chain price here. */
const QUOTER: Record<number, `0x${string}`> = Object.fromEntries(
  Object.entries(UNISWAP_V3).map(([id, d]) => [Number(id), d.quoter]),
);

/**
 * The token every pool is quoted against — the chain's own wrapped native,
 * read from the registry rather than kept as a second list that can drift.
 */
export const WETH_FOR: Record<number, `0x${string}`> = Object.fromEntries(
  Object.entries(CHAINS)
    .filter(([, c]) => c.wrappedNative)
    .map(([id, c]) => [Number(id), c.wrappedNative!]),
);

/** the fee tiers worth trying, cheapest-to-deepest in practice */
const FEE_TIERS = [500, 3000, 10_000, 100] as const;

const quoterAbi = [{
  type: 'function',
  name: 'quoteExactInputSingle',
  stateMutability: 'nonpayable',
  inputs: [{
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}] as const;

export interface SpotPrice {
  /** ETH received for one whole token, as a decimal string */
  ethPerToken: string;
  /** which pool answered */
  feeTier: number;
  /** the size the quote was taken at, since a quote is size-dependent */
  quotedFor: string;
}

export interface PriceOptions {
  /** Let the caller rotate its RPC pool instead of turning transport failure into “unpriced”. */
  throwOnRpcError?: boolean;
}

/**
 * Ask what one token is worth in ETH. Returns null when no pool answers —
 * which is the honest outcome for a token nobody trades, and for every chain
 * without a Uniswap deployment.
 *
 * Quotes are taken at ONE whole token rather than at your balance: quoting
 * your actual size would leak how much you hold into the call, and a wallet
 * that whispers your position to the mempool has missed the point.
 */
/**
 * Ask what one token is worth in ETH — for a whole list at once.
 *
 * WHY BATCHED. This used to be one function per token, walking four fee tiers
 * with a separate eth_call each and stopping at the first that answered, and
 * `valueInEth` called it in a sequential loop. Valuing eight tokens on
 * Robinhood therefore cost up to thirty-two round trips one after another and
 * measured 5.7 seconds. Every one of those calls is independent, so they all
 * go into a single multicall3 — the same trick the swap route search uses.
 *
 * It also picks the BEST tier rather than the first that answers, which the
 * per-call version could not do without paying for every tier anyway.
 *
 * Quotes are taken at ONE whole token rather than at your balance: quoting
 * your actual size would leak how much you hold into the call, and a wallet
 * that whispers your position to the mempool has missed the point.
 */
export async function spotPricesInEth(
  endpoint: string,
  chainId: number,
  tokens: Array<{ address: `0x${string}`; decimals: number }>,
  opts: PriceOptions = {},
): Promise<Map<string, SpotPrice>> {
  const out = new Map<string, SpotPrice>();
  const quoter = QUOTER[chainId];
  const weth = WETH_FOR[chainId];
  if (!weth || !tokens.length) return out;

  // wrapped native is the unit everything else is quoted in
  const rest: Array<{ address: `0x${string}`; decimals: number }> = [];
  for (const t of tokens) {
    if (t.address.toLowerCase() === weth.toLowerCase()) {
      out.set(t.address.toLowerCase(), { ethPerToken: '1', feeTier: 0, quotedFor: '1' });
    } else {
      rest.push(t);
    }
  }
  if (!rest.length) return out;

  if (quoter) {
    // every token against every tier, in ONE call. QuoterV2 is not `view`, so
    // it works by reverting inside the pool callback and catching — which is
    // fine through multicall3 under eth_call, nothing is committed either way.
    const probes = rest.flatMap((t) => FEE_TIERS.map((fee) => ({ t, fee })));
    let res: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
    try {
      res = (await chainClient(endpoint, chainId).multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: probes.map(({ t, fee }) => ({
          address: quoter,
          abi: quoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [{
            tokenIn: t.address, tokenOut: weth, amountIn: parseUnits('1', t.decimals),
            fee, sqrtPriceLimitX96: 0n,
          }],
        })) as never,
      })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
    } catch (error) {
      if (opts.throwOnRpcError) throw error;
      res = [];
    }
    if (opts.throwOnRpcError) {
      const transportFailure = res.find((result) => (
        result.status === 'failure' && isRpcTransportError(result.error)
      ));
      if (transportFailure?.error) throw transportFailure.error;
    }

    probes.forEach(({ t, fee }, i) => {
      const r = res[i];
      if (!r || r.status !== 'success') return;
      const amountOut = (r.result as readonly unknown[] | undefined)?.[0];
      if (typeof amountOut !== 'bigint' || amountOut <= 0n) return;
      const key = t.address.toLowerCase();
      const had = out.get(key);
      // best tier wins, not merely the first that answered
      if (had && Number(had.ethPerToken) >= Number(formatEther(amountOut))) return;
      out.set(key, { ethPerToken: formatEther(amountOut), feeTier: fee, quotedFor: '1' });
    });
  }

  /*
    NOTHING IN V3, SO ASK V4 BEFORE CLAIMING THERE IS NO PRICE.
    The asset sheet said "no Uniswap pool answered on this chain" about URU
    while the swap screen was quoting it, because this only ever knew about v3.
    A token whose only market is a v4 pool has a price; we were looking in one
    exchange. `needsDepth` keeps a thin launch pool from setting it.
  */
  const missing = rest.filter((t) => !out.has(t.address.toLowerCase()));
  if (missing.length) {
    // A wallet can hold dozens of unpriced spam tokens. Firing one discovery
    // and quote per token at once monopolises the browser's per-origin sockets;
    // four keeps the endpoint busy without turning pricing into a request storm.
    const found: Array<Awaited<ReturnType<typeof quoteV4Best>>> = [];
    const concurrency = 4;
    for (let start = 0; start < missing.length; start += concurrency) {
      const batch = await Promise.all(missing.slice(start, start + concurrency).map(async (t) => {
        try {
          return await quoteV4Best(
            endpoint, chainId, t.address, null, weth, parseUnits('1', t.decimals), 0,
            { needsDepth: true, throwOnRpcError: opts.throwOnRpcError },
          );
        } catch (error) {
          if (opts.throwOnRpcError) throw error;
          return null;
        }
      }));
      found.push(...batch);
    }
    missing.forEach((t, i) => {
      const v4 = found[i];
      if (!v4 || v4.amountOut <= 0n) return;
      out.set(t.address.toLowerCase(), {
        ethPerToken: formatEther(v4.amountOut), feeTier: v4.poolKey.fee, quotedFor: '1',
      });
    });
  }
  return out;
}

/** the same question about a single token, for the asset sheet */
export async function spotPriceInEth(
  endpoint: string,
  chainId: number,
  token: `0x${string}`,
  decimals: number,
  opts: PriceOptions = {},
): Promise<SpotPrice | null> {
  const prices = await spotPricesInEth(endpoint, chainId, [{ address: token, decimals }], opts);
  return prices.get(token.toLowerCase()) ?? null;
}

/** the stablecoin each chain's dollar price is read from */
const USD_FOR: Record<number, { address: `0x${string}`; decimals: number }> = {
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  42161: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
};

/**
 * What one ETH is worth in dollars, read from a USDC pool.
 *
 * This is the whole reason a fiat total is possible here without breaking
 * anything: a price API would be a tracker that learns your holdings, but a
 * Uniswap pool quote is an eth_call to the same RPC that already served your
 * balances. It knows you asked about ETH and USDC; it learns nothing about
 * what you hold, because the quote is taken at ONE ETH, not at your balance.
 *
 * Null on chains with no deployment — the UI then shows ETH alone rather than
 * inventing a number.
 */
export async function usdPerEth(
  endpoint: string,
  chainId: number,
  opts: PriceOptions = {},
): Promise<number | null> {
  const usd = USD_FOR[chainId];
  const weth = WETH_FOR[chainId];
  if (!usd || !weth) return null;
  const quote = await spotPriceInEth(endpoint, chainId, usd.address, usd.decimals, opts);
  if (!quote) return null;
  const ethPerUsd = Number(quote.ethPerToken);
  if (!Number.isFinite(ethPerUsd) || ethPerUsd <= 0) return null;
  return 1 / ethPerUsd;
}

/** a token amount, its price in ETH, and what that came to */
export interface ValuedAsset {
  symbol: string;
  chainId: number;
  /**
   * Which contract this row is, or undefined for the chain's native coin.
   * A symbol is NOT an identity — Robinhood carries two contracts both calling
   * themselves USDG — so anything matching a value back to a row matches on
   * this, never on the symbol.
   */
  address?: `0x${string}`;
  /** null when nothing would quote it — shown as "—", never as zero */
  ethValue: number | null;
}

export interface PriceHolding {
  symbol: string;
  address?: `0x${string}`;
  amount: string;
  decimals: number;
}

export interface WalletValueSnapshot {
  address: string;
  chains: Array<{ chainId: number; holdings: PriceHolding[] }>;
}

export interface WalletValuesResult {
  totals: Record<string, number>;
  pricesByChain: Map<number, Map<string, SpotPrice>>;
}

const amountOf = (holding: { amount: string }): number => Number(holding.amount.replace('<', ''));

/** Apply an already-shared price map without making another network request. */
export function valueWithPrices(
  chainId: number,
  holdings: PriceHolding[],
  prices: Map<string, SpotPrice>,
): ValuedAsset[] {
  return holdings.map((holding) => {
    const amount = amountOf(holding);
    if (!Number.isFinite(amount) || amount === 0) {
      return { symbol: holding.symbol, chainId, address: holding.address, ethValue: 0 };
    }
    if (!holding.address) return { symbol: holding.symbol, chainId, ethValue: amount };
    const per = Number(prices.get(holding.address.toLowerCase())?.ethPerToken ?? NaN);
    return {
      symbol: holding.symbol,
      chainId,
      address: holding.address,
      ethValue: Number.isFinite(per) ? amount * per : null,
    };
  });
}

/**
 * Value a set of wallet snapshots with one token-price lookup per chain.
 *
 * Prices contain neither wallet addresses nor balance sizes, so every wallet
 * can safely share them. The old drawer path repeated the same quote grid for
 * every address even though a token's one-unit quote is wallet-independent.
 */
export async function valueWalletSnapshots(
  snapshots: WalletValueSnapshot[],
  lookup: (
    chainId: number,
    tokens: Array<{ address: `0x${string}`; decimals: number }>,
  ) => Promise<Map<string, SpotPrice>>,
): Promise<WalletValuesResult> {
  const tokensByChain = new Map<number, Map<string, { address: `0x${string}`; decimals: number }>>();
  for (const snapshot of snapshots) {
    for (const chain of snapshot.chains) {
      for (const holding of chain.holdings) {
        const amount = amountOf(holding);
        if (!holding.address || !Number.isFinite(amount) || amount === 0) continue;
        let tokens = tokensByChain.get(chain.chainId);
        if (!tokens) {
          tokens = new Map();
          tokensByChain.set(chain.chainId, tokens);
        }
        const key = holding.address.toLowerCase();
        if (!tokens.has(key)) tokens.set(key, { address: holding.address, decimals: holding.decimals });
      }
    }
  }

  const priced = await Promise.all([...tokensByChain].map(async ([chainId, tokens]) => (
    [chainId, await lookup(chainId, [...tokens.values()])] as const
  )));
  const pricesByChain = new Map(priced);
  const totals: Record<string, number> = {};
  for (const snapshot of snapshots) {
    let total = 0;
    for (const chain of snapshot.chains) {
      const values = valueWithPrices(
        chain.chainId,
        chain.holdings,
        pricesByChain.get(chain.chainId) ?? new Map(),
      );
      for (const value of values) total += value.ethValue ?? 0;
    }
    totals[snapshot.address] = total;
  }
  return { totals, pricesByChain };
}

/**
 * Value a list of holdings in ETH, one pool quote per distinct token.
 *
 * Native balances need no quote at all. A token nobody will quote comes back
 * null rather than 0: "we could not price this" and "this is worthless" are
 * different claims, and only one of them is ours to make.
 */
export async function valueInEth(
  endpoint: string,
  chainId: number,
  holdings: PriceHolding[],
  opts: PriceOptions = {},
): Promise<ValuedAsset[]> {
  // one price lookup for the whole chain, and only for what is actually held:
  // a zero balance is worth zero whatever the price is, and asking anyway
  // burns a request on every refresh
  const worth = holdings.filter((h) => h.address && Number.isFinite(amountOf(h)) && amountOf(h) !== 0);
  const prices = worth.length
    ? await spotPricesInEth(endpoint, chainId, worth.map(
      (h) => ({ address: h.address!, decimals: h.decimals }),
    ), opts).catch((error) => {
      if (opts.throwOnRpcError) throw error;
      return new Map<string, SpotPrice>();
    })
    : new Map<string, SpotPrice>();
  return valueWithPrices(chainId, holdings, prices);
}

/** format a dollar amount the way a balance row should read */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  })}`;
}
