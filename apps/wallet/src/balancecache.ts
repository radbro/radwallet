/**
 * THE LAST KNOWN BALANCES, kept on device so a wallet never opens blank.
 *
 * Every extension page boots its own store, and the popup is torn down on
 * every lost focus, so without this every open of the wallet started at zero
 * and the rows raced the RPCs onto the screen. Phantom, MetaMask and Rabby all
 * show the last figure at once and correct it when the chain answers; this is
 * that. The snapshot is a display cache, nothing else: refresh() still sweeps
 * every chain and overwrites it, and nothing is ever SIGNED against a cached
 * number — the approval window reads the chain, never this.
 *
 * What it holds is public chain state about addresses this device already
 * stores in the clear (`selectedAddress`, `customTokens`). It is keyed by
 * address, pruned when a wallet is forgotten, and bounded so a device that
 * has held many wallets does not carry all of them forever.
 */
import type { TokenBalance } from '@radwallet/core';
import { kv } from './storage.js';

export interface BalanceSnapshot {
  balances: TokenBalance[];
  /** per-row worth in ETH, keyed by `assetKey` */
  assetEth: Record<string, number>;
  portfolioEth: number | null;
  usdRate: number | null;
  /** ms since epoch when the sweep behind it finished */
  at: number;
}

/** `raw` is a bigint, which JSON refuses; it travels as a decimal string */
interface StoredBalance extends Omit<TokenBalance, 'raw'> { raw: string }
interface StoredSnapshot extends Omit<BalanceSnapshot, 'balances'> { balances: StoredBalance[] }

const KEY = 'balanceCache';
/** wallets remembered at most; the oldest snapshot goes first */
export const MAX_CACHED_WALLETS = 32;

export function encodeSnapshot(s: BalanceSnapshot): string {
  const out: StoredSnapshot = {
    ...s,
    balances: s.balances.map((b) => ({ ...b, raw: b.raw.toString() })),
  };
  return JSON.stringify(out);
}

/** null for anything that does not parse or does not look like ours */
export function decodeSnapshot(text: string): BalanceSnapshot | null {
  try {
    const s = JSON.parse(text) as StoredSnapshot;
    if (!s || !Array.isArray(s.balances) || typeof s.at !== 'number') return null;
    const balances: TokenBalance[] = [];
    for (const b of s.balances) {
      if (!b || typeof b.symbol !== 'string' || typeof b.amount !== 'string') return null;
      if (typeof b.raw !== 'string' || !/^\d+$/.test(b.raw)) return null;
      if (typeof b.decimals !== 'number') return null;
      balances.push({ ...b, raw: BigInt(b.raw) });
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const assetEth: Record<string, number> = {};
    if (s.assetEth && typeof s.assetEth === 'object') {
      for (const [k, v] of Object.entries(s.assetEth)) {
        const n = num(v);
        if (n !== null) assetEth[k] = n;
      }
    }
    return {
      balances,
      assetEth,
      portfolioEth: num(s.portfolioEth),
      usdRate: num(s.usdRate),
      at: s.at,
    };
  } catch {
    return null;
  }
}

type Store = Record<string, string>;

async function readStore(): Promise<Store> {
  try {
    const raw = await kv.get(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function readBalanceSnapshot(address: string): Promise<BalanceSnapshot | null> {
  const store = await readStore();
  const text = store[address.toLowerCase()];
  return text ? decodeSnapshot(text) : null;
}

export async function writeBalanceSnapshot(address: string, s: BalanceSnapshot): Promise<void> {
  const store = await readStore();
  store[address.toLowerCase()] = encodeSnapshot(s);
  // oldest out first, so the bound never evicts the wallet in use
  const keys = Object.keys(store);
  if (keys.length > MAX_CACHED_WALLETS) {
    const byAge = keys
      .map((k) => ({ k, at: decodeSnapshot(store[k])?.at ?? 0 }))
      .sort((a, b) => a.at - b.at);
    for (const { k } of byAge.slice(0, keys.length - MAX_CACHED_WALLETS)) delete store[k];
  }
  await kv.set(KEY, JSON.stringify(store));
}

/** keep only the wallets that still exist — a forgotten wallet leaves no trace here */
export async function pruneBalanceSnapshots(keep: string[]): Promise<void> {
  const store = await readStore();
  const live = new Set(keep.map((a) => a.toLowerCase()));
  let changed = false;
  for (const k of Object.keys(store)) {
    if (!live.has(k)) { delete store[k]; changed = true; }
  }
  if (changed) await kv.set(KEY, JSON.stringify(store));
}

export async function clearBalanceSnapshots(): Promise<void> {
  await kv.del(KEY);
}
