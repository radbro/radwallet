import { getAddress } from 'viem';

export interface SwapTrackToken {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** When present, the confirmed receipt must show this token moved here. */
  recipient?: `0x${string}`;
}

export interface ConfirmationWatchShape {
  chainId: number;
  hash: `0x${string}`;
  queuedAt: number;
  trackOnSuccess?: SwapTrackToken[];
}

export interface ReceiptLogShape {
  address: string;
  data?: string;
  topics?: readonly string[];
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function normalizeContract(address: string): `0x${string}` | null {
  try { return getAddress(address) as `0x${string}`; } catch { return null; }
}

function normalizeRecipient(address: unknown): `0x${string}` | undefined {
  return typeof address === 'string' ? normalizeContract(address) ?? undefined : undefined;
}

export function normalizeSwapTrackTokens(
  raw: unknown,
  defaultRecipient?: unknown,
  recipientMode: 'fallback' | 'bind' = 'fallback',
): SwapTrackToken[] {
  const fallbackRecipient = normalizeRecipient(defaultRecipient);
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: SwapTrackToken[] = [];
  for (const token of source) {
    if (!token || typeof token !== 'object') continue;
    const candidate = token as Partial<SwapTrackToken>;
    const address = typeof candidate.address === 'string' ? normalizeContract(candidate.address) : null;
    const symbol = String(candidate.symbol ?? '').trim();
    const name = String(candidate.name ?? '').trim() || symbol;
    const decimals = Number(candidate.decimals);
    if (!address || !symbol || symbol === '???' || !Number.isInteger(decimals)
      || decimals < 0 || decimals > 255) continue;
    const recipient = recipientMode === 'bind'
      ? fallbackRecipient
      : normalizeRecipient(candidate.recipient) ?? fallbackRecipient;
    const key = `${address.toLowerCase()}:${recipient?.toLowerCase() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, symbol, name, decimals, ...(recipient ? { recipient } : {}) });
  }
  return out;
}

export function mergeConfirmationWatches(
  current: ConfirmationWatchShape[],
  watch: ConfirmationWatchShape,
): ConfirmationWatchShape[] {
  const key = confirmationWatchKey(watch);
  const idx = current.findIndex((entry) => confirmationWatchKey(entry) === key);
  if (idx < 0) return [...current, watch];
  const next = [...current];
  const merged = normalizeSwapTrackTokens([
    ...(next[idx].trackOnSuccess ?? []),
    ...(watch.trackOnSuccess ?? []),
  ]);
  next[idx] = { ...next[idx], ...(merged.length ? { trackOnSuccess: merged } : {}) };
  return next;
}

export function confirmationWatchKey(watch: Pick<ConfirmationWatchShape, 'chainId' | 'hash'>): string {
  return `${watch.chainId}:${watch.hash.toLowerCase()}`;
}

export function validConfirmationWatch(value: unknown, chainIds: readonly number[]): value is ConfirmationWatchShape {
  const watch = value as Partial<ConfirmationWatchShape> | null;
  return Boolean(watch && chainIds.includes(Number(watch.chainId))
    && typeof watch.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(watch.hash)
    && Number.isFinite(watch.queuedAt));
}

export function normalizeConfirmationWatch(
  value: unknown,
  chainIds: readonly number[],
): ConfirmationWatchShape | null {
  if (!validConfirmationWatch(value, chainIds)) return null;
  const watch = value as ConfirmationWatchShape;
  const trackOnSuccess = normalizeSwapTrackTokens(watch.trackOnSuccess);
  return {
    chainId: Number(watch.chainId),
    hash: watch.hash as `0x${string}`,
    queuedAt: Number(watch.queuedAt),
    ...(trackOnSuccess.length ? { trackOnSuccess } : {}),
  };
}

export function trackTokensForReceipt(
  candidates: SwapTrackToken[] | undefined,
  logs: readonly ReceiptLogShape[],
): SwapTrackToken[] {
  const normalized = normalizeSwapTrackTokens(candidates);
  return normalized
    .filter((token) => token.recipient && receiptTransfersTokenTo(logs, token.address, token.recipient))
    .map(({ recipient, ...token }) => token);
}

export function trackTokensForSettledReceipt(
  status: 'success' | 'reverted' | null,
  candidates: SwapTrackToken[] | undefined,
  logs: readonly ReceiptLogShape[],
): SwapTrackToken[] {
  return status === 'success' ? trackTokensForReceipt(candidates, logs) : [];
}

function receiptTransfersTokenTo(
  logs: readonly ReceiptLogShape[],
  tokenAddress: `0x${string}`,
  recipient: `0x${string}`,
): boolean {
  const address = tokenAddress.toLowerCase();
  const toTopic = `0x${'0'.repeat(24)}${recipient.slice(2).toLowerCase()}`;
  return logs.some((log) => {
    const topics = log.topics ?? [];
    if (log.address.toLowerCase() !== address) return false;
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    if (topics[2]?.toLowerCase() !== toTopic) return false;
    try {
      return BigInt(log.data ?? '0x0') > 0n;
    } catch {
      return false;
    }
  });
}
