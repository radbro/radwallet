/**
 * Local transaction history. Stored on-device only — the wallet remembers
 * what IT signed; it never asks an indexer API about you. Status comes from
 * your own RPC via getTransactionReceipt when you open the screen.
 */
import { kv } from './storage.js';

export interface HistoryEntry {
  hash: string;
  chainId: number;
  kind: 'send' | 'swap' | 'dapp' | 'stealth';
  to?: string;
  origin?: string;
  ts: number;
  status: 'pending' | 'confirmed' | 'failed' | 'demo';
}

const KEY = 'history';
const MAX = 100;

async function load(): Promise<HistoryEntry[]> {
  const raw = await kv.get(KEY);
  try {
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function save(list: HistoryEntry[]): Promise<void> {
  await kv.set(KEY, JSON.stringify(list.slice(0, MAX)));
}

export async function recordTx(entry: Omit<HistoryEntry, 'ts' | 'status'> & { status?: HistoryEntry['status'] }): Promise<void> {
  const list = await load();
  list.unshift({ ts: Date.now(), status: entry.status ?? 'pending', ...entry });
  await save(list);
}

export async function listHistory(): Promise<HistoryEntry[]> {
  return load();
}

export async function updateStatus(hash: string, status: HistoryEntry['status']): Promise<void> {
  const list = await load();
  const hit = list.find((e) => e.hash === hash);
  if (hit && hit.status !== status) {
    hit.status = status;
    await save(list);
  }
}
