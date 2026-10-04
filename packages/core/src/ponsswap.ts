/**
 * A Pons bonding curve as a SWAP VENUE.
 *
 * Before a Pons V2 launch graduates, its only market is the curve contract
 * itself — no Uniswap pool exists, so RADSWAP's v3/v4 search finds nothing and
 * the honest answer used to be "no pool". This module lets `quoteSwap` ask
 * the curve alongside the pools: resolve the token to its curve, prove the
 * curve is the one the canonical factory registered, price the trade with
 * the curve's own arithmetic (`pons.ts`, measured against live events), and
 * build the one call — `buy` or `sell` — that executes it. After graduation
 * the curve refuses and the Uniswap pool takes over; the caller never has to
 * know which phase the token is in.
 *
 * Custody-neutral like the rest of the Pons modules: reads public state,
 * builds transaction requests, never sees a key.
 */
import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import type { DappTxRequest } from './chain.js';
import { chainClient } from './tokens.js';
import {
  PONS_CHAIN_ID, PONS_V2_FACTORY, PONS_NATIVE_QUOTE,
  PONS_CURVE_ABI, PONS_TOKEN_ABI, PONS_FACTORY_ABI,
  quotePonsCurveBuy, quotePonsCurveSell, withAdditionalPonsBuyTax,
  type PonsCurveSnapshot,
} from './pons.js';

const BASIS_POINTS = 10_000n;

/** what the curve is, proven from the factory registry and both reverse links */
export interface PonsVenue {
  token: Address;
  curve: Address;
  factory: Address;
  /** the asset the curve is priced in: zero address = native ETH */
  pairToken: Address;
  nativeQuote: boolean;
  graduated: boolean;
  readyToGraduate: boolean;
  snapshot: PonsCurveSnapshot;
  launchedAt: bigint;
  snipeTaxSeconds: bigint;
  tokenSymbol: string;
  tokenDecimals: number;
}

export type PonsVenueSide = 'buy' | 'sell';

/** one priced trade against the curve — everything the route table shows */
export interface PonsVenueQuote {
  side: PonsVenueSide;
  token: Address;
  curve: Address;
  pairToken: Address;
  nativeQuote: boolean;
  tokenSymbol: string;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** the per-recipient launch tax at quote time, already capped as the curve caps it */
  snipeTaxBps: bigint;
  /** the base fee, in the quote asset */
  fee: bigint;
  /** the creator tax, in the quote asset */
  tax: bigint;
  /** the launch tax, in the quote asset (buys only; zero after the launch seconds) */
  snipeTax: bigint;
  /** buys only: quote the curve hands back because its inventory ran out first */
  refund: bigint;
  launchedAt: bigint;
  snipeTaxSeconds: bigint;
}

interface PonsSwapClient {
  multicall(args: unknown): Promise<readonly unknown[]>;
  readContract(args: {
    address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[];
  }): Promise<unknown>;
  call(args: { account: Address; to: Address; data: `0x${string}`; value?: bigint }): Promise<unknown>;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Did the CONTRACT refuse, or did the NODE? A plain ERC-20 reverts on
 * `launchFactory()` and an EOA returns no data — both are the contract
 * saying "not a Pons token", and null is the right answer. A throttled or
 * unreachable endpoint is neither: viem folds that into the same per-call
 * failure shape under allowFailure, and reading it as "not Pons" would price
 * a launch through the pools it does not have. Measured live: the public
 * Robinhood node answers 429 mid-quote under modest load.
 */
function isContractRefusal(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 8; depth++) {
    const name = (cur as { name?: string }).name ?? '';
    if (name === 'ContractFunctionRevertedError' || name === 'ContractFunctionZeroDataError'
      || name === 'RawContractError' || name === 'AbiDecodingZeroDataError') return true;
    if (name === 'HttpRequestError' || name === 'RpcRequestError' || name === 'TimeoutError'
      || name === 'LimitExceededRpcError' || name === 'InternalRpcError') return false;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Is this token a Pons V2 launch, and where is its curve?
 *
 * Returns null for anything that is simply NOT a Pons token — an ordinary
 * ERC-20 reverts on `launchFactory()` and that is the expected answer, not an
 * error. A token that CLAIMS the canonical factory but fails the registry or
 * either reverse link is a different thing and throws: something is
 * impersonating a launch.
 *
 * TWO round trips, deliberately. The public Robinhood node throttles — a
 * first cut with separate `eth_getCode` probes was measured being refused
 * with 429 mid-quote — so the token's claim is one multicall (an address
 * with no code simply fails to decode) and every provenance, state and
 * metadata read is the other. Pass `recipient` to fold the launch-tax read
 * into that second call as well.
 */
export async function resolvePonsVenueWithClient(
  client: PonsSwapClient,
  chainId: number,
  tokenAddress: Address,
  recipient?: Address,
): Promise<(PonsVenue & { snipeTaxBps: bigint }) | null> {
  if (chainId !== PONS_CHAIN_ID) return null;
  const token = getAddress(tokenAddress);

  const claims = (await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: [
      { address: token, abi: PONS_TOKEN_ABI, functionName: 'launchFactory' },
      { address: token, abi: PONS_TOKEN_ABI, functionName: 'curve' },
    ],
  })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
  const refused = claims.find((c) => c.status !== 'success');
  if (refused) {
    if (isContractRefusal(refused.error)) return null;
    throw new Error(`could not ask ${token} whether it is a Pons launch: ${
      String((refused.error as Error)?.message ?? refused.error).split('\n')[0]}`);
  }
  const factory = getAddress(claims[0].result as Address);
  const curve = getAddress(claims[1].result as Address);
  if (!sameAddress(factory, PONS_V2_FACTORY)) return null;

  const taxRead = recipient
    ? [{ address: curve, abi: PONS_CURVE_ABI, functionName: 'currentSnipeTaxBps', args: [getAddress(recipient)] }]
    : [];
  const answers = (await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: [
      { address: factory, abi: PONS_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'token' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'factory' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'pairToken' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'graduated' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'readyToGraduate' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'getReserves' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'sellableTokens' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'feeBps' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'creatorTaxBps' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'launchedAt' },
      { address: curve, abi: PONS_CURVE_ABI, functionName: 'snipeTaxSeconds' },
      { address: token, abi: PONS_TOKEN_ABI, functionName: 'symbol' },
      { address: token, abi: PONS_TOKEN_ABI, functionName: 'decimals' },
      ...taxRead,
    ],
  })) as { status: 'success' | 'failure'; result?: unknown }[];
  // a curve that will not answer its own questions is not a curve we trade on;
  // the failing read is named so a partial deployment can be told from a lie
  const missing = answers.findIndex((a) => a.status !== 'success');
  if (missing >= 0) {
    const name = missing === 0 ? 'getLaunchedToken' : missing < 12 ? 'curve state' : missing < 14 ? 'token metadata' : 'launch tax';
    throw new Error(`Pons curve ${curve} did not answer ${name}`);
  }
  const [registered, curveToken, curveFactory, pairTokenValue, graduated, readyToGraduate,
    reservesValue, sellableTokens, feeBps, creatorTaxBps, launchedAt, snipeTaxSeconds,
    symbol, decimals, snipeTaxValue] = answers.map((a) => a.result);
  if (!sameAddress(getAddress(registered as Address), token)) {
    throw new Error('canonical Pons factory does not register this token as a launch');
  }
  if (!sameAddress(getAddress(curveToken as Address), token)) {
    throw new Error('Pons curve does not point back to this token');
  }
  if (!sameAddress(getAddress(curveFactory as Address), factory)) {
    throw new Error('Pons token and curve disagree about their factory');
  }
  const tokenDecimals = Number(decimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error('Pons token decimals are invalid');
  }
  const reserves = reservesValue as readonly [bigint, bigint];
  const pairToken = getAddress(pairTokenValue as Address);
  return {
    token,
    curve,
    factory,
    pairToken,
    nativeQuote: sameAddress(pairToken, PONS_NATIVE_QUOTE),
    graduated: graduated === true,
    readyToGraduate: readyToGraduate === true,
    snapshot: {
      quoteReserve: BigInt(reserves[0]),
      tokenReserve: BigInt(reserves[1]),
      sellableTokens: BigInt(sellableTokens as bigint),
      feeBps: BigInt(feeBps as bigint),
      creatorTaxBps: BigInt(creatorTaxBps as bigint),
    },
    launchedAt: BigInt(launchedAt as bigint),
    snipeTaxSeconds: BigInt(snipeTaxSeconds as bigint),
    tokenSymbol: String(symbol),
    tokenDecimals,
    snipeTaxBps: recipient ? BigInt(snipeTaxValue as bigint) : 0n,
  };
}

export async function resolvePonsVenue(
  endpoint: string,
  chainId: number,
  token: Address,
  recipient?: Address,
): Promise<(PonsVenue & { snipeTaxBps: bigint }) | null> {
  const client = chainClient(endpoint, chainId) as unknown as PonsSwapClient;
  return resolvePonsVenueWithClient(client, chainId, token, recipient);
}

/** a venue that will not trade says why, in words a person can act on */
export function requireOpenPonsVenue(venue: PonsVenue): void {
  if (venue.graduated) {
    throw new Error(`${venue.tokenSymbol} has graduated from its Pons curve — its market is a Uniswap pool now`);
  }
  if (venue.readyToGraduate || venue.snapshot.sellableTokens === 0n) {
    throw new Error(`the Pons curve for ${venue.tokenSymbol} is sold out and waiting to graduate; nothing trades until it does`);
  }
}

/**
 * Price one trade against the curve. `snipeTaxBps` is what
 * `currentSnipeTaxBps(recipient)` said a moment ago; the curve caps it so a
 * buyer always nets at least 1% of the spend, and so does this.
 */
export function quotePonsVenue(
  venue: PonsVenue,
  side: PonsVenueSide,
  amountIn: bigint,
  snipeTaxBps = 0n,
): PonsVenueQuote {
  requireOpenPonsVenue(venue);
  const base = {
    side,
    token: venue.token,
    curve: venue.curve,
    pairToken: venue.pairToken,
    nativeQuote: venue.nativeQuote,
    tokenSymbol: venue.tokenSymbol,
    amountIn,
    feeBps: venue.snapshot.feeBps,
    creatorTaxBps: venue.snapshot.creatorTaxBps,
    launchedAt: venue.launchedAt,
    snipeTaxSeconds: venue.snipeTaxSeconds,
  };
  if (side === 'sell') {
    const q = quotePonsCurveSell(venue.snapshot, amountIn);
    return {
      ...base, amountOut: q.quoteOut, snipeTaxBps: 0n, fee: q.fee, tax: q.tax, snipeTax: 0n, refund: 0n,
    };
  }
  let snipe = snipeTaxBps < 0n ? 0n : snipeTaxBps;
  if (snipe > 0n) {
    const cap = BASIS_POINTS - venue.snapshot.feeBps - venue.snapshot.creatorTaxBps - 100n;
    if (snipe > cap) snipe = cap;
  }
  const q = quotePonsCurveBuy(withAdditionalPonsBuyTax(venue.snapshot, snipe), amountIn);
  // the buy quote folds the launch tax into the creator bucket for the
  // arithmetic; split it back out so the receipt names each take
  const snipeTax = (q.quoteSpent * snipe) / BASIS_POINTS;
  return {
    ...base,
    amountOut: q.tokensOut,
    snipeTaxBps: snipe,
    fee: q.fee,
    tax: q.tax - snipeTax,
    snipeTax,
    refund: q.refund,
  };
}

/**
 * Which way round a pair trades on this venue, if it does at all: you BUY the
 * launched token with the curve's quote asset, or SELL it back for the same.
 * Anything else — two Pons tokens, or a pre-graduation token against an
 * asset its curve is not priced in — is null; the curve cannot do it.
 */
export function ponsVenueSide(
  venue: PonsVenue,
  from: Address | null,
  to: Address | null,
): PonsVenueSide | null {
  const isQuote = (a: Address | null) => (venue.nativeQuote
    ? a === null
    : a !== null && sameAddress(a, venue.pairToken));
  const isToken = (a: Address | null) => a !== null && sameAddress(a, venue.token);
  if (isQuote(from) && isToken(to)) return 'buy';
  if (isToken(from) && isQuote(to)) return 'sell';
  return null;
}

/** what the wallet spends on this trade — the token the curve must be allowed to pull, or null for ETH */
export function ponsVenueSpendToken(q: Pick<PonsVenueQuote, 'side' | 'token' | 'pairToken' | 'nativeQuote'>): Address | null {
  if (q.side === 'sell') return q.token;
  return q.nativeQuote ? null : q.pairToken;
}

/** the curve's own `buy` or `sell`, recipient = the wallet that signs */
export function buildPonsVenueSwapTx(
  q: Pick<PonsVenueQuote, 'side' | 'curve' | 'nativeQuote'>,
  owner: Address,
  amountIn: bigint,
  minOut: bigint,
): DappTxRequest {
  if (amountIn <= 0n || minOut <= 0n) throw new Error('Pons swap limits must be positive');
  const from = getAddress(owner);
  if (q.side === 'buy') {
    return {
      from,
      to: getAddress(q.curve),
      data: encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'buy', args: [amountIn, minOut, from] }),
      ...(q.nativeQuote ? { value: `0x${amountIn.toString(16)}` as `0x${string}` } : {}),
    };
  }
  return {
    from,
    to: getAddress(q.curve),
    data: encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'sell', args: [amountIn, minOut, from] }),
  };
}

/** an exact allowance for the curve — never unlimited, same rule as the router */
export function buildPonsVenueApproveTx(token: Address, curve: Address, amount: bigint): DappTxRequest {
  return {
    to: getAddress(token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [getAddress(curve), amount] }),
  };
}

export async function ponsVenueAllowance(
  client: PonsSwapClient,
  token: Address,
  owner: Address,
  curve: Address,
): Promise<bigint> {
  const have = await client.readContract({
    address: getAddress(token), abi: erc20Abi, functionName: 'allowance',
    args: [getAddress(owner), getAddress(curve)],
  });
  return BigInt(have as bigint);
}

/**
 * Run the trade as an eth_call from the wallet before anything is signed. A
 * curve that graduated or sold out between the quote and the plan reverts
 * here, with the reason, instead of at the signing prompt.
 */
export async function preflightPonsVenueSwap(client: PonsSwapClient, tx: DappTxRequest): Promise<void> {
  if (!tx.from || !tx.to || !tx.data) throw new Error('Pons swap request is incomplete');
  try {
    await client.call({
      account: tx.from, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined,
    });
  } catch (e) {
    const first = (e as Error).message.split('\n')[0];
    throw new Error(`the Pons curve refused this trade: ${first}`);
  }
}

/**
 * The whole venue path for one pair, on one endpoint: find the curve behind
 * whichever side is the launched token, check it trades the OTHER side, read
 * the wallet's launch tax, and price it. Null when neither side is a Pons
 * token — the ordinary answer for most pairs on the chain. Throws, in words,
 * when a Pons token is involved but the curve cannot serve this trade.
 */
export async function quotePonsVenueSwap(
  endpoint: string,
  chainId: number,
  from: Address | null,
  to: Address | null,
  amountIn: bigint,
  owner: Address,
): Promise<PonsVenueQuote | null> {
  if (chainId !== PONS_CHAIN_ID || amountIn <= 0n) return null;
  const client = chainClient(endpoint, chainId) as unknown as PonsSwapClient;
  // the launched token is the ERC-20 side; ask about both when both are
  // tokens, because either could be the launch
  const candidates = [to, from].filter((a): a is Address => a !== null);
  for (const candidate of candidates) {
    const venue = await resolvePonsVenueWithClient(client, chainId, candidate, owner);
    if (!venue) continue;
    // after graduation the market is a Uniswap pool and the pool search is
    // the right place to look — the curve has nothing to say about the pair
    if (venue.graduated) return null;
    const side = ponsVenueSide(venue, from, to);
    if (!side) {
      const quoteName = venue.nativeQuote ? 'ETH' : `its quote token ${venue.pairToken}`;
      throw new Error(`${venue.tokenSymbol} trades on its Pons curve against ${quoteName} only, until it graduates`);
    }
    requireOpenPonsVenue(venue);
    return quotePonsVenue(venue, side, amountIn, side === 'buy' ? venue.snipeTaxBps : 0n);
  }
  return null;
}
