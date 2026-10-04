import { normalizeContract, type SwapSide } from '@radwallet/core';

/** a token as this sheet shows it: the swap side, plus what we know about it */
export interface PickItem extends SwapSide {
  name?: string;
  /** the balance to show on the right, when this is a token you hold */
  amount?: string;
  /** the raw balance behind `amount`, when this was read for the active wallet */
  raw?: bigint;
}

export function sideKeyOf(s: SwapSide): string {
  return s.address ? s.address.toLowerCase() : 'native';
}

export function mergeEphemeralPickItems(list: PickItem[], extra: PickItem[]): PickItem[] {
  const have = new Set(list.map((i) => sideKeyOf(i)));
  const added = extra.filter((i) => !have.has(sideKeyOf(i)));
  return added.length ? [...list, ...added] : list;
}

export function shortContract(address: `0x${string}`): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function fullContractQuery(q: string): `0x${string}` | null {
  const raw = q.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return normalizeContract(raw);
}

export function completeAddressInput(q: string): boolean {
  return q.trim().startsWith('0x') && q.trim().length >= 42;
}
