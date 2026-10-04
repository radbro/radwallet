/**
 * Price HISTORY, from a third party. The third and last documented exception
 * to "nothing but RPC", and like the other two it does nothing until asked.
 *
 * Why it cannot be done on-chain: a chart needs a price at each past block,
 * which means archive `eth_call`s. Measured on the endpoints we ship —
 * publicnode refuses archive entirely ("Archive requests require a personal
 * token"), drpc caps out around 5,000 blocks (~17 hours of mainnet), and only
 * Base's own RPC goes meaningfully further. A week of history is simply not
 * available from a public node, so a real chart has to come from someone
 * else's server.
 *
 * What that costs you, which the UI repeats before switching it on: the
 * provider learns which assets you hold and when you look at them, tied to
 * your IP. It is a smaller leak than the indexer's (they see one contract at
 * a time, not your address) — but it is still a leak, so it is still a switch.
 *
 * `spotPriceInEth` in price.ts stays the default: no API, no key, no third
 * party, and it is the price you could actually get right now.
 */

export interface PriceFeedConfig {
  /** nothing here runs unless this is true */
  enabled: boolean;
  /** optional API key; the free tier needs none but is rate-limited */
  key?: string;
}

export const PRICEFEED_OFF: PriceFeedConfig = { enabled: false };

/** coingecko's name for each chain we scan */
const PLATFORM: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum-one',
};

export function priceFeedSupports(chainId: number): boolean {
  return chainId in PLATFORM;
}

/** one point on the chart */
export interface PricePoint {
  /** ms since epoch */
  t: number;
  /** price in the requested currency */
  p: number;
}

/** built as a pure function so the exact URL is easy to audit and to test */
export function chartUrl(chainId: number, contract: string, days: number, vs = 'usd'): string {
  const platform = PLATFORM[chainId];
  if (!platform) throw new Error(`no price feed for chain ${chainId}`);
  return `https://api.coingecko.com/api/v3/coins/${platform}/contract/` +
    `${encodeURIComponent(contract.toLowerCase())}/market_chart` +
    `?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(String(days))}`;
}

/** shape-check the response rather than trusting it */
export function parseChart(json: unknown): PricePoint[] {
  const rows = (json as { prices?: unknown })?.prices;
  if (!Array.isArray(rows)) return [];
  const out: PricePoint[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const t = Number(row[0]);
    const p = Number(row[1]);
    if (Number.isFinite(t) && Number.isFinite(p) && p > 0) out.push({ t, p });
  }
  return out;
}

/**
 * Fetch a price history. Returns an empty list rather than throwing: a chart
 * is a nicety, and a rate-limited provider should not break the screen it
 * sits on.
 */
export async function fetchChart(
  cfg: PriceFeedConfig,
  chainId: number,
  contract: string,
  days = 7,
): Promise<PricePoint[]> {
  if (!cfg.enabled) return [];
  if (!priceFeedSupports(chainId)) return [];
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cfg.key) headers['x-cg-demo-api-key'] = cfg.key;
    const res = await fetch(chartUrl(chainId, contract, days), { headers });
    if (!res.ok) return [];
    return parseChart(await res.json());
  } catch {
    return [];
  }
}
