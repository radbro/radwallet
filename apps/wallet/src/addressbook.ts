import { signal } from '@preact/signals';
import { getAddress, isAddress } from 'viem';
import { kv } from './storage.js';

const STORAGE_KEY = 'addressBook';
const CHANNEL_NAME = 'radwallet:addressBook';
const LOCK_NAME = 'radwallet:addressBook';
const MAX_LABEL = 80;
const INVISIBLE_LABEL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export interface AddressBookContact {
  address: `0x${string}`;
  label: string;
}

export const savedContacts = signal<AddressBookContact[]>([]);

type WebLockManager = {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => T | Promise<T>,
  ): Promise<T>;
};

let localQueue: Promise<void> = Promise.resolve();

function normalizeAddress(address: string): `0x${string}` {
  const raw = address.trim();
  if (!raw) throw new Error('address is required');
  try {
    if (!isAddress(raw)) throw new Error('invalid address or checksum');
    return getAddress(raw) as `0x${string}`;
  } catch {
    throw new Error('invalid address or checksum');
  }
}

function normalizeLabel(label: string): string {
  const next = label.trim();
  if (!next) throw new Error('label is required');
  if (next.length > MAX_LABEL) throw new Error(`label must be ${MAX_LABEL} characters or less`);
  if (INVISIBLE_LABEL.test(next)) throw new Error('label has invisible control characters');
  return next;
}

function normalizeContact(raw: unknown): AddressBookContact | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<AddressBookContact>;
  if (typeof row.address !== 'string' || typeof row.label !== 'string') return null;
  try {
    return {
      address: normalizeAddress(row.address),
      label: normalizeLabel(row.label),
    };
  } catch {
    return null;
  }
}

function normalizeAddressBookContacts(raw: unknown): AddressBookContact[] {
  const rows = Array.isArray(raw) ? raw : [];
  const order: string[] = [];
  const byAddress = new Map<string, AddressBookContact>();
  for (const row of rows) {
    const contact = normalizeContact(row);
    if (!contact) continue;
    const key = contact.address.toLowerCase();
    if (!byAddress.has(key)) order.push(key);
    byAddress.set(key, contact);
  }
  return order.flatMap((key) => {
    const contact = byAddress.get(key);
    return contact ? [contact] : [];
  });
}

function parseAddressBook(raw: string | null, strict = false): AddressBookContact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (strict && !Array.isArray(parsed)) throw new Error('address book storage is corrupt');
    return normalizeAddressBookContacts(parsed);
  } catch {
    if (strict) throw new Error('address book storage is corrupt');
    return [];
  }
}

function mergeAddressBookContact(
  contacts: readonly AddressBookContact[],
  address: string,
  label: string,
): AddressBookContact[] {
  const contact = { address: normalizeAddress(address), label: normalizeLabel(label) };
  const key = contact.address.toLowerCase();
  const next = [...normalizeAddressBookContacts(contacts)];
  const index = next.findIndex((entry) => entry.address.toLowerCase() === key);
  if (index >= 0) next[index] = contact;
  else next.push(contact);
  return next;
}

function removeAddressBookContact(
  contacts: readonly AddressBookContact[],
  address: string,
): AddressBookContact[] {
  const normalized = normalizeAddress(address).toLowerCase();
  return normalizeAddressBookContacts(contacts)
    .filter((contact) => contact.address.toLowerCase() !== normalized);
}

function serialize(contacts: readonly AddressBookContact[]): string {
  return JSON.stringify(normalizeAddressBookContacts(contacts));
}

function notifyAddressBookChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: 'addressBookChanged' });
    channel.close();
  } catch {
    // Cross-surface refresh is best effort; persistence already succeeded.
  }
}

async function withLocalQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = localQueue.then(fn, fn);
  localQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function withAddressBookLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: WebLockManager }).locks;
  if (locks?.request) {
    return locks.request(LOCK_NAME, { mode: 'exclusive' }, () => withLocalQueue(fn));
  }
  return withLocalQueue(fn);
}

export async function loadAddressBook(): Promise<void> {
  await withAddressBookLock(async () => {
    savedContacts.value = parseAddressBook(await kv.get(STORAGE_KEY));
  });
}

export async function saveContact(address: string, label: string): Promise<void> {
  await withAddressBookLock(async () => {
    const current = parseAddressBook(await kv.get(STORAGE_KEY), true);
    const updated = mergeAddressBookContact(current, address, label);
    await kv.set(STORAGE_KEY, serialize(updated));
    savedContacts.value = updated;
  });
  notifyAddressBookChanged();
}

export async function removeContact(address: string): Promise<void> {
  await withAddressBookLock(async () => {
    const current = parseAddressBook(await kv.get(STORAGE_KEY), true);
    const updated = removeAddressBookContact(current, address);
    if (updated.length !== current.length) await kv.set(STORAGE_KEY, serialize(updated));
    savedContacts.value = updated;
  });
  notifyAddressBookChanged();
}

export function watchAddressBook(): () => void {
  let stopped = false;
  let channel: BroadcastChannel | null = null;
  const refresh = () => {
    if (!stopped) void loadAddressBook().catch(() => {});
  };
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = refresh;
    } catch {
      channel = null;
    }
  }
  const focusRefresh = () => refresh();
  const visibleRefresh = () => {
    if (typeof document === 'undefined' || !document.hidden) refresh();
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', focusRefresh);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibleRefresh);
  return () => {
    stopped = true;
    if (channel) channel.close();
    if (typeof window !== 'undefined') window.removeEventListener('focus', focusRefresh);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibleRefresh);
  };
}
