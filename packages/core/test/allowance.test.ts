import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits } from 'viem';
import { decodeApprove, isUnlimitedAllowance, MAX_UINT256, parseAllowance, rewriteApprove } from '../src/allowance.js';

const call = {
  token: '0x1111111111111111111111111111111111111111' as const,
  spender: '0x2222222222222222222222222222222222222222' as const,
  amount: MAX_UINT256,
};

for (const decimals of [0, 6, 18]) {
  test(`allowance: large-spend warning uses token units at ${decimals} decimals`, () => {
    const threshold = 1_000_000_000n * 10n ** BigInt(decimals);
    assert.equal(isUnlimitedAllowance(threshold, decimals), true);
    assert.equal(isUnlimitedAllowance(threshold - 1n, decimals), false);
    assert.equal(isUnlimitedAllowance(MAX_UINT256, decimals), true);
  });
}

for (const decimals of [0, 6, 18]) {
  test(`allowance: exact rewritten calldata uses ${decimals} token decimals`, () => {
    const human = decimals === 0 ? '100' : `100.${'0'.repeat(decimals - 1)}1`;
    const raw = parseAllowance(human, decimals);
    const rewritten = decodeApprove(call.token, rewriteApprove(call, raw));
    assert.equal(rewritten?.amount, 100n * 10n ** BigInt(decimals) + (decimals ? 1n : 0n));
    assert.equal(rewritten?.spender, call.spender);
    assert.equal(formatUnits(rewritten!.amount, decimals), human);
    assert.equal(parseAllowance('0', decimals), 0n, 'zero remains a valid revocation');
  });
}

test('allowance: rejects excess precision before parseUnits can round', () => {
  for (const [human, decimals] of [['0.0000009', 6], ['1.0000000', 6], ['1.9', 0], ['0.0000000000000000009', 18]] as const) {
    assert.throws(() => parseAllowance(human, decimals), /decimal places/);
  }
});

test('allowance: rejects invalid quantities, token decimals and uint256 overflow', () => {
  for (const human of ['', ' ', '-1', '+1', '1e3', 'NaN', 'Infinity', '1,000', '1.2.3', '.']) {
    assert.throws(() => parseAllowance(human, 6), /token amount/);
  }
  for (const decimals of [-1, 256, NaN, Infinity, 6.1]) {
    assert.throws(() => parseAllowance('100', decimals), /decimals are unavailable/);
  }
  assert.throws(() => parseAllowance((MAX_UINT256 + 1n).toString(), 0), /too large/);
  assert.equal(parseAllowance(MAX_UINT256.toString(), 0), MAX_UINT256);
  assert.equal(parseAllowance(' .5 ', 6), 500_000n);
});
