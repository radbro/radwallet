/**
 * THE EMBEDDED DEX CHART — opt-in, and the heaviest opt-in in the wallet.
 *
 * Every other third-party in this codebase is a `fetch`: we ask for data, we
 * decide what to do with it, and we draw the pixels ourselves. This one is an
 * IFRAME, which is a different animal and has to be described honestly:
 *
 *   - it runs SOMEONE ELSE'S CODE inside the wallet's own window
 *   - it can set cookies and storage on their origin, and fingerprint the
 *     browser, which a `fetch` for a list of numbers cannot
 *   - it tells them which token you are looking at, when, and your IP
 *   - it keeps telling them for as long as the sheet is open
 *
 * So it is off until asked for, per asset, and the "always load" preference is
 * a separate switch in SETTINGS — the same shape as NFT artwork, which has the
 * same problem.
 *
 * WHY GECKOTERMINAL AND NOT DEXTOOLS. Measured, not chosen by taste, with the
 * real extension build framing each candidate:
 *
 *   - dextools    — REFUSES. The widget URL bounces to www.dextools.io, which
 *                   sends `X-Frame-Options: sameorigin`, and Chrome kills the
 *                   frame. There is no embed to have.
 *   - dexscreener — frames, then renders "Failed connecting to server" (pair
 *                   form) or hangs on "Loading pair…" (token form).
 *   - geckoterminal — renders a full candlestick chart, from a plain TOKEN
 *                   address, so the wallet never has to resolve a pool. Works
 *                   sandboxed. Thin tokens are fine: $RAD and HIKI both have
 *                   live pools on it.
 *
 * This file makes no network calls of its own — it builds a URL and nothing
 * else, which is why it needs no gate of its own and does not appear in the
 * CI telemetry exception list. The gate is that nothing renders the frame
 * until the user asks.
 */

/** the host the frame contacts, verbatim, so the UI can name it */
export const DEXCHART_HOST = 'www.geckoterminal.com';

/**
 * Their network slug per chain of ours, from their own /api/v2/networks.
 * Robinhood Chain was absent when this shipped and has since been added, which
 * is the argument for re-reading the list rather than trusting the comment: a
 * chain missing here gets an honest "no chart" instead of a frame that 404s.
 */
const NETWORK: Record<number, string> = {
  1: 'eth',
  8453: 'base',
  42161: 'arbitrum',
  4663: 'robinhood',
  11155111: 'sepolia-testnet',
};

export interface DexChartConfig {
  /** load the chart automatically, without asking each time */
  enabled: boolean;
}

export const DEXCHART_OFF: DexChartConfig = { enabled: false };

export function dexChartSupports(chainId: number): boolean {
  return chainId in NETWORK;
}

/**
 * The chart URL for a token. Native ETH has no contract, so callers pass the
 * chain's wrapped-native address — the pool a chart would be drawn from is a
 * WETH pool either way.
 *
 * Refuses a chain it has no slug for rather than guessing one: a wrong slug is
 * a 404 inside the frame, which reads as "this wallet is broken".
 */
export function dexChartUrl(chainId: number, token: string): string {
  const net = NETWORK[chainId];
  if (!net) throw new Error(`no DEX chart for chain ${chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('a chart needs a token address');
  // info=0 & swaps=0 drop their header and trade feed: we want the chart, not
  // a second wallet UI inside ours
  return `https://${DEXCHART_HOST}/${net}/tokens/${token}?embed=1&info=0&swaps=0`;
}
