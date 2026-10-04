/**
 * Speeding up and cancelling a transaction that is stuck in the mempool.
 *
 * Both are the same trick: send ANOTHER transaction with the same nonce and a
 * higher fee, so miners prefer it and the original becomes unmineable. There
 * is no "cancel" opcode — a cancellation is just a replacement that does
 * nothing (0 ETH to yourself).
 *
 * The wallet does not store nonces or gas prices, and it does not need to:
 * `eth_getTransactionByHash` returns everything required, from the same RPC
 * pool as everything else. No indexer, no mempool service.
 *
 * The bump is not cosmetic. Geth requires a replacement to beat the original
 * by at least 10% on BOTH fee fields or it rejects it outright with
 * "replacement transaction underpriced", so the default here is 25% — enough
 * to clear the threshold and to actually change the odds, since a 10.1% bump
 * on a fee that was already too low just gets you stuck slightly faster.
 */
import { chainClient } from './tokens.js';
import type { DappTxRequest } from './chain.js';

/** what the chain knows about a transaction we are trying to replace */
export interface PendingTx {
  hash: `0x${string}`;
  nonce: number;
  from: `0x${string}`;
  to: `0x${string}` | null;
  value: bigint;
  data: `0x${string}`;
  /** null while it is still pending — which is the only time this is useful */
  blockNumber: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  /** pre-1559 transactions only carry this one */
  gasPrice: bigint | null;
}

export const MIN_BUMP_PCT = 10;
export const DEFAULT_BUMP_PCT = 25;

/** read a transaction back off the chain so we can replace it */
export async function fetchTx(
  endpoint: string,
  chainId: number,
  hash: `0x${string}`,
): Promise<PendingTx | null> {
  const client = chainClient(endpoint, chainId);
  const tx = await client.getTransaction({ hash }).catch(() => null);
  if (!tx) return null;
  return {
    hash,
    nonce: tx.nonce,
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value,
    data: (tx.input ?? '0x') as `0x${string}`,
    blockNumber: tx.blockNumber ?? null,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
    gasPrice: tx.gasPrice ?? null,
  };
}

/** a transaction already in a block cannot be replaced, only regretted */
export function isReplaceable(tx: PendingTx): boolean {
  return tx.blockNumber === null;
}

function bump(value: bigint, pct: number): bigint {
  return (value * BigInt(100 + Math.max(MIN_BUMP_PCT, Math.round(pct)))) / 100n;
}

/**
 * The fees a replacement needs: the original's, raised past the node's
 * rejection threshold, and never below what the network is asking now.
 */
export function replacementFees(
  tx: PendingTx,
  pct = DEFAULT_BUMP_PCT,
  suggested?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  // a legacy transaction's single gasPrice stands in for both fields
  const oldMax = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  const oldTip = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n;
  const maxFeePerGas = max(bump(oldMax, pct), suggested?.maxFeePerGas ?? 0n);
  const maxPriorityFeePerGas = max(bump(oldTip, pct), suggested?.maxPriorityFeePerGas ?? 0n);
  // the tip can never exceed the cap, or the node rejects the transaction
  return {
    maxFeePerGas: max(maxFeePerGas, maxPriorityFeePerGas),
    maxPriorityFeePerGas,
  };
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Same transaction, same nonce, more money. Everything about what it DOES is
 * copied verbatim — changing the payload while reusing the nonce is how you
 * turn "speed up" into "send something else entirely".
 */
export function buildSpeedUp(
  tx: PendingTx,
  pct = DEFAULT_BUMP_PCT,
  suggested?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): DappTxRequest {
  const fees = replacementFees(tx, pct, suggested);
  return {
    to: tx.to ?? tx.from,
    value: `0x${tx.value.toString(16)}`,
    data: tx.data,
    nonce: tx.nonce,
    maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
  };
}

/**
 * A do-nothing transaction at the same nonce: 0 ETH to yourself, no calldata.
 * If it lands first, the original can never be mined.
 *
 * It is not free and it is not guaranteed — if the original is already in a
 * block, this is just a wasted fee, so callers check `isReplaceable` first.
 */
export function buildCancel(
  tx: PendingTx,
  pct = DEFAULT_BUMP_PCT,
  suggested?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): DappTxRequest {
  const fees = replacementFees(tx, pct, suggested);
  return {
    to: tx.from,
    value: '0x0',
    data: '0x',
    nonce: tx.nonce,
    maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
  };
}

/** what the network is charging right now, so a replacement is not born stale */
export async function suggestedFees(
  endpoint: string,
  chainId: number,
): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  try {
    const client = chainClient(endpoint, chainId);
    const fees = await client.estimateFeesPerGas();
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  } catch {
    return {};
  }
}
