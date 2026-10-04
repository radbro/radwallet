import assert from 'node:assert/strict';
import test from 'node:test';
import {
  quotePonsCurveBuy, withAdditionalPonsBuyTax, type PonsCurveSnapshot,
} from '../src/pons.js';

const snapshot: PonsCurveSnapshot = {
  quoteReserve: 1_000_000n,
  tokenReserve: 10_000_000n,
  sellableTokens: 7_000_000n,
  feeBps: 100n,
  creatorTaxBps: 200n,
};

test('Pons math prices after fees and clamps exhausted inventory with a refund', () => {
  const quote = quotePonsCurveBuy(snapshot, 100_000n);
  assert.equal(quote.fee, 1_000n);
  assert.equal(quote.tax, 2_000n);
  assert.equal(quote.tokensOut, (97_000n * 10_000_000n) / 1_097_000n);

  const thin = quotePonsCurveBuy({ ...snapshot, sellableTokens: 10_000n }, 900_000n);
  assert.equal(thin.tokensOut, 10_000n);
  assert.ok(thin.quoteSpent < thin.quoteIn);
  assert.equal(thin.refund, thin.quoteIn - thin.quoteSpent);
  assert.equal(thin.next.sellableTokens, 0n);
});

test('Pons buy quotes include the recipient launch tax', () => {
  const ordinary = quotePonsCurveBuy(snapshot, 100_000n);
  const taxed = quotePonsCurveBuy(withAdditionalPonsBuyTax(snapshot, 200n), 100_000n);
  assert.ok(taxed.tokensOut < ordinary.tokensOut);
  assert.equal(taxed.tax, 4_000n);
  assert.equal(snapshot.creatorTaxBps, 200n);
  assert.throws(() => withAdditionalPonsBuyTax(snapshot, 10_000n), /leave no executable quote/);
});

