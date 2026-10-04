/** Local drawer layout only. Never reorder the vault or its account indices. */
import { signal } from '@preact/signals';
import { kv } from './storage.js';

interface WalletListLayout {
  order: string[];
  collapsed: string[];
}
type Group = { id: string; kind: 'seed' | 'imported' };

export const walletList = signal<WalletListLayout>({ order: [], collapsed: [] });

function parse(raw: string | null): WalletListLayout {
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  try {
    const value = JSON.parse(raw ?? '{}');
    return { order: strings(value?.order), collapsed: strings(value?.collapsed) };
  } catch {
    return { order: [], collapsed: [] };
  }
}

/** Missing/new seeds retain vault order; imported keys always remain last. */
export function orderedWalletGroups<T extends Group>(groups: readonly T[], order = walletList.value.order): T[] {
  const seeds = groups.filter((g) => g.kind === 'seed');
  const byId = new Map(seeds.map((g) => [g.id, g]));
  const ids = [...new Set([...order, ...seeds.map((g) => g.id)])];
  return [
    ...ids.flatMap((id) => { const group = byId.get(id); return group ? [group] : []; }),
    ...groups.filter((g) => g.kind === 'imported'),
  ];
}

// Read/modify/write under one lock so popup and sidebar edits do not overwrite
// each other. The queue also covers platforms without the Web Locks API.
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = pending.then(async () => {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request('radwallet:wallet-list', run);
    }
    return run();
  });
  pending = next.catch(() => {});
  return next;
}

export function loadWalletList(): Promise<void> {
  return serialized(async () => { walletList.value = parse(await kv.get('walletList')); });
}

function changeLayout(update: (current: WalletListLayout) => WalletListLayout): Promise<void> {
  return serialized(async () => {
    const next = update(parse(await kv.get('walletList')));
    await kv.set('walletList', JSON.stringify(next));
    walletList.value = next;
  });
}

export function toggleWalletGroup(id: string): Promise<void> {
  return changeLayout((current) => ({
    ...current,
    collapsed: current.collapsed.includes(id)
      ? current.collapsed.filter((value) => value !== id)
      : [...current.collapsed, id],
  }));
}

/** Seed IDs can be reused after removal. A fresh seed must get a fresh layout. */
export function forgetWalletGroupLayout(id: string): Promise<void> {
  return changeLayout((current) => ({
    order: current.order.filter((value) => value !== id),
    collapsed: current.collapsed.filter((value) => value !== id),
  }));
}

export function resetWalletList(): Promise<void> {
  return changeLayout(() => ({ order: [], collapsed: [] }));
}

export function moveSeedGroup(
  id: string, targetId: string, placement: 'before' | 'after', groups: readonly Group[],
): Promise<void> {
  return changeLayout((current) => {
    const seeds = orderedWalletGroups(groups, current.order).filter((g) => g.kind === 'seed');
    if (id === targetId || !seeds.some((g) => g.id === id) || !seeds.some((g) => g.id === targetId)) return current;
    const order = seeds.filter((g) => g.id !== id).map((g) => g.id);
    order.splice(order.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, id);
    return { ...current, order };
  });
}
