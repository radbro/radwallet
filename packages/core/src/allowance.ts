/**
 * Allowance rewriting — the billboard with teeth.
 * When a dapp transaction is an ERC-20 approve() asking for an unlimited
 * (or absurdly large) allowance, RADWALLET rewrites the amount before
 * signing. Billboards don't get to decide.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import { parseTokenAmount } from './amounts.js';

export interface ApproveCall {
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
}

const APPROVE_SELECTOR = '0x095ea7b3';

/** 2^256 - 1 — the classic "trust me forever" allowance */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** One billion whole tokens is treated as an unusually large allowance. */
const UNLIMITED_TOKEN_THRESHOLD = 1_000_000_000n;

/** Decode tx calldata as an ERC-20 approve, or null if it isn't one. */
export function decodeApprove(
  to: `0x${string}` | undefined,
  data: `0x${string}` | undefined,
): ApproveCall | null {
  if (!to || !data || !data.toLowerCase().startsWith(APPROVE_SELECTOR)) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    if (functionName !== 'approve') return null;
    const [spender, amount] = args as readonly [`0x${string}`, bigint];
    return { token: to, spender, amount };
  } catch {
    return null;
  }
}

export function isUnlimitedAllowance(amount: bigint, decimals = 18): boolean {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals are unavailable.');
  }
  return amount === MAX_UINT256 || amount >= UNLIMITED_TOKEN_THRESHOLD * 10n ** BigInt(decimals);
}

/** Re-encode the approve with a bounded amount. */
export function rewriteApprove(call: ApproveCall, newAmount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [call.spender, newAmount],
  });
}

export function formatAllowance(amount: bigint, decimals = 18): string {
  if (amount >= MAX_UINT256 / 2n) return 'UNLIMITED';
  const s = formatUnits(amount, decimals);
  const [i, f = ''] = s.split('.');
  const ff = f.slice(0, 4).replace(/0+$/, '');
  return ff ? `${i}.${ff}` : i;
}

export function parseAllowance(human: string, decimals: number): bigint {
  return parseTokenAmount(human, decimals);
}
