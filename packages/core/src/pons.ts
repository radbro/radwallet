/** Shared Pons V2 curve definitions and arithmetic for ordinary swaps. */
import { getAddress, parseAbi } from 'viem';

export const PONS_CHAIN_ID = 4663;
export const PONS_V2_FACTORY = getAddress('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
export const PONS_NATIVE_QUOTE = getAddress('0x0000000000000000000000000000000000000000');

export const PONS_TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function launchFactory() view returns (address)',
  'function curve() view returns (address)',
]);

/** Canonical V2 factory registry. A launched token maps back to itself. */
export const PONS_FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns (address)',
]);

export const PONS_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function factory() view returns (address)',
  'function pairToken() view returns (address)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function launchedAt() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event CurveBuyRefunded(address indexed buyer, uint256 refund)',
]);

export interface PonsCurveSnapshot {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellableTokens: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
}

export interface PonsBuyQuote {
  quoteIn: bigint;
  quoteSpent: bigint;
  tokensOut: bigint;
  fee: bigint;
  tax: bigint;
  refund: bigint;
  next: PonsCurveSnapshot;
}

const BASIS_POINTS = 10_000n;

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('cannot divide by zero or a negative value');
  return (numerator + denominator - 1n) / denominator;
}

export function quotePonsCurveBuy(snapshot: PonsCurveSnapshot, quoteIn: bigint): PonsBuyQuote {
  if (quoteIn <= 0n) throw new Error('quote input must be positive');
  if (snapshot.quoteReserve <= 0n || snapshot.tokenReserve <= 0n) {
    throw new Error('curve reserves must be positive');
  }
  if (snapshot.sellableTokens <= 0n || snapshot.sellableTokens > snapshot.tokenReserve) {
    throw new Error('curve sellable inventory is invalid');
  }
  if (snapshot.feeBps < 0n || snapshot.creatorTaxBps < 0n ||
      snapshot.feeBps + snapshot.creatorTaxBps >= BASIS_POINTS) {
    throw new Error('curve fee configuration is invalid');
  }

  let quoteSpent = quoteIn;
  let fee = (quoteSpent * snapshot.feeBps) / BASIS_POINTS;
  let tax = (quoteSpent * snapshot.creatorTaxBps) / BASIS_POINTS;
  let netQuote = quoteSpent - fee - tax;
  let tokensOut = (netQuote * snapshot.tokenReserve) / (snapshot.quoteReserve + netQuote);
  if (tokensOut <= 0n) throw new Error('buy is too small to produce token output');

  if (tokensOut > snapshot.sellableTokens) {
    tokensOut = snapshot.sellableTokens;
    const remainingReserve = snapshot.tokenReserve - tokensOut;
    if (remainingReserve <= 0n) throw new Error('curve inventory cannot be priced safely');
    const netRequired = (tokensOut * snapshot.quoteReserve) / remainingReserve + 1n;
    quoteSpent = divideRoundUp(
      netRequired * BASIS_POINTS,
      BASIS_POINTS - snapshot.feeBps - snapshot.creatorTaxBps,
    );
    if (quoteSpent > quoteIn) quoteSpent = quoteIn;
    fee = (quoteSpent * snapshot.feeBps) / BASIS_POINTS;
    tax = (quoteSpent * snapshot.creatorTaxBps) / BASIS_POINTS;
    netQuote = quoteSpent - fee - tax;
  }

  return {
    quoteIn,
    quoteSpent,
    tokensOut,
    fee,
    tax,
    refund: quoteIn - quoteSpent,
    next: {
      quoteReserve: snapshot.quoteReserve + netQuote,
      tokenReserve: snapshot.tokenReserve - tokensOut,
      sellableTokens: snapshot.sellableTokens - tokensOut,
      feeBps: snapshot.feeBps,
      creatorTaxBps: snapshot.creatorTaxBps,
    },
  };
}

export interface PonsSellQuote {
  tokensIn: bigint;
  /** what the constant product pays before the curve takes its cut */
  grossQuote: bigint;
  fee: bigint;
  tax: bigint;
  quoteOut: bigint;
  next: PonsCurveSnapshot;
}

/**
 * The curve's own `sell`, mirrored. Measured against live `CurveSell` events
 * on three different curves (block 53632664..53632673, every single-log
 * block matched to the wei) and then read off the verified
 * PonsV2BondingCurve source: gross = tokensIn * quoteReserve /
 * (tokenReserve + tokensIn), then the base fee and the creator tax come out
 * of the GROSS. There is no snipe tax on a sell and no sellable cap — the
 * curve refuses only once it has graduated or run out of inventory.
 */
export function quotePonsCurveSell(snapshot: PonsCurveSnapshot, tokensIn: bigint): PonsSellQuote {
  if (tokensIn <= 0n) throw new Error('sell input must be positive');
  if (snapshot.quoteReserve <= 0n || snapshot.tokenReserve <= 0n) {
    throw new Error('curve reserves must be positive');
  }
  if (snapshot.feeBps < 0n || snapshot.creatorTaxBps < 0n ||
      snapshot.feeBps + snapshot.creatorTaxBps >= BASIS_POINTS) {
    throw new Error('curve fee configuration is invalid');
  }
  const grossQuote = (tokensIn * snapshot.quoteReserve) / (snapshot.tokenReserve + tokensIn);
  const fee = (grossQuote * snapshot.feeBps) / BASIS_POINTS;
  const tax = (grossQuote * snapshot.creatorTaxBps) / BASIS_POINTS;
  const quoteOut = grossQuote - fee - tax;
  if (quoteOut <= 0n) throw new Error('sell is too small to produce quote output');
  return {
    tokensIn,
    grossQuote,
    fee,
    tax,
    quoteOut,
    next: {
      // the fee and tax leave the reserve too: they move into the curve's
      // fee balances, which getReserves() subtracts
      quoteReserve: snapshot.quoteReserve - grossQuote,
      tokenReserve: snapshot.tokenReserve + tokensIn,
      sellableTokens: snapshot.sellableTokens + tokensIn,
      feeBps: snapshot.feeBps,
      creatorTaxBps: snapshot.creatorTaxBps,
    },
  };
}

/**
 * Include the recipient launch tax in a buy quote.
 * This change affects the quote snapshot only.
 */
export function withAdditionalPonsBuyTax(
  snapshot: PonsCurveSnapshot,
  additionalTaxBps: bigint,
): PonsCurveSnapshot {
  if (additionalTaxBps < 0n || additionalTaxBps > BASIS_POINTS) {
    throw new Error('additional Pons buy tax is invalid');
  }
  if (snapshot.feeBps + snapshot.creatorTaxBps + additionalTaxBps >= BASIS_POINTS) {
    throw new Error('combined Pons buy taxes leave no executable quote');
  }
  return {
    ...snapshot,
    creatorTaxBps: snapshot.creatorTaxBps + additionalTaxBps,
  };
}

