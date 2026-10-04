/**
 * Keyring: one vault holds MANY wallets.
 *
 *  - seed groups — BIP-39 mnemonic → BIP-44 accounts (m/44'/60'/0'/0/index)
 *  - loose keys  — raw secp256k1 private keys imported one at a time
 *
 * Derivation happens in-memory only after the vault is opened; nothing here is
 * ever persisted unencrypted and nothing is transmitted anywhere.
 *
 * Accounts are addressed by their position in one flat list (seed groups in
 * order, each group's accounts in derivation order, then the loose keys). That
 * flat index is what crosses the session boundary as the signer selector.
 */
import {
  generateMnemonic,
  english,
  mnemonicToAccount,
  privateKeyToAccount,
  type HDAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { bytesToHex } from 'viem';

/** anything in this vault that can sign */
export type SignerAccount = HDAccount | PrivateKeyAccount;

/** user-supplied naming, per account. Absent fields fall back to defaults. */
export interface AccountMeta {
  nick?: string;
  labels?: string[];
}

export interface SeedGroup {
  id: string;
  mnemonic: string;
  nick?: string;
  /** one entry per revealed account; length IS the account count */
  accounts: AccountMeta[];
}

export interface ImportedKey {
  id: string;
  privateKey: `0x${string}`;
  nick?: string;
  labels?: string[];
}

export interface VaultSecret {
  seeds: SeedGroup[];
  imported: ImportedKey[];
  /** pre-multi-wallet vaults sealed a bare mnemonic; read-only compatibility */
  mnemonic?: string;
  accountCount?: number;
}

export type AccountKind = 'hd' | 'imported';

export interface WalletAccount {
  /** position in the flat list — the signer selector across the session boundary */
  index: number;
  address: `0x${string}`;
  /** display name: the user's nickname, or the default one */
  label: string;
  /** true when the user chose that name — it outranks reverse-ENS in the UI */
  named: boolean;
  kind: AccountKind;
  /** seed group id, or IMPORTED_GROUP for a loose key */
  groupId: string;
  groupLabel: string;
  /** BIP-44 address index inside its seed group; -1 for a loose key */
  hdIndex: number;
  labels: string[];
}

/** the pseudo-group every imported private key lives in */
export const IMPORTED_GROUP = 'imported';

export function newMnemonic(): string {
  return generateMnemonic(english);
}

export function validateMnemonic(mnemonic: string): boolean {
  try {
    mnemonicToAccount(mnemonic.trim().toLowerCase());
    return true;
  } catch {
    return false;
  }
}

/** Normalize user input to the canonical 0x-prefixed lowercase form. */
export function normalizePrivateKey(input: string): `0x${string}` {
  const hex = input.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('that is not a 32-byte private key, bro');
  const key = `0x${hex}` as `0x${string}`;
  try {
    privateKeyToAccount(key);
  } catch {
    throw new Error('that key is not on the curve, bro');
  }
  return key;
}

export function addressOfPrivateKey(key: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(key).address;
}

export function deriveAccount(mnemonic: string, index: number): HDAccount {
  return mnemonicToAccount(mnemonic.trim().toLowerCase(), { addressIndex: index });
}

// ---------------------------------------------------------------- shape ----
function nextId(prefix: string, taken: string[]): string {
  let n = 1;
  while (taken.includes(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Accept both the current shape and the pre-multi-wallet one (a bare
 * `{ mnemonic, accountCount }`), always returning the current shape. Called on
 * every vault open and on every adopted secret, so an old vault upgrades the
 * first time anything writes to it.
 */
export function normalizeSecret(raw: unknown): VaultSecret {
  const r = (raw ?? {}) as Partial<VaultSecret>;
  const seeds: SeedGroup[] = [];
  if (Array.isArray(r.seeds)) {
    for (const s of r.seeds) {
      if (!s || typeof s.mnemonic !== 'string') continue;
      const accounts = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : [{}];
      seeds.push({
        id: s.id || nextId('seed', seeds.map((x) => x.id)),
        mnemonic: s.mnemonic,
        ...(s.nick ? { nick: s.nick } : {}),
        accounts: accounts.map((a) => ({ ...(a?.nick ? { nick: a.nick } : {}), labels: a?.labels ?? [] })),
      });
    }
  } else if (typeof r.mnemonic === 'string') {
    const count = Math.max(1, Number(r.accountCount) || 1);
    seeds.push({
      id: 'seed-1',
      mnemonic: r.mnemonic,
      accounts: Array.from({ length: count }, () => ({ labels: [] as string[] })),
    });
  }
  const imported: ImportedKey[] = [];
  if (Array.isArray(r.imported)) {
    for (const k of r.imported) {
      if (!k || typeof k.privateKey !== 'string') continue;
      imported.push({
        id: k.id || nextId('key', imported.map((x) => x.id)),
        privateKey: k.privateKey as `0x${string}`,
        ...(k.nick ? { nick: k.nick } : {}),
        labels: k.labels ?? [],
      });
    }
  }
  return { seeds, imported };
}

export function newSecret(mnemonic: string): VaultSecret {
  return { seeds: [{ id: 'seed-1', mnemonic, accounts: [{ labels: [] }] }], imported: [] };
}

export function groupLabel(secret: VaultSecret, groupId: string): string {
  if (groupId === IMPORTED_GROUP) return 'imported keys';
  const i = secret.seeds.findIndex((s) => s.id === groupId);
  if (i < 0) return groupId;
  return secret.seeds[i].nick || `seed #${i + 1}`;
}

// ---------------------------------------------------------------- listing ----
export function listAccounts(secret: VaultSecret): WalletAccount[] {
  const s = normalizeSecret(secret);
  const out: WalletAccount[] = [];
  s.seeds.forEach((seed, gi) => {
    const gl = seed.nick || `seed #${gi + 1}`;
    seed.accounts.forEach((meta, i) => {
      out.push({
        index: out.length,
        address: deriveAccount(seed.mnemonic, i).address,
        label: meta.nick || `wallet ${i + 1}`,
        named: !!meta.nick,
        kind: 'hd',
        groupId: seed.id,
        groupLabel: gl,
        hdIndex: i,
        labels: meta.labels ?? [],
      });
    });
  });
  s.imported.forEach((k, i) => {
    out.push({
      index: out.length,
      address: addressOfPrivateKey(k.privateKey),
      label: k.nick || `imported key ${i + 1}`,
      named: !!k.nick,
      kind: 'imported',
      groupId: IMPORTED_GROUP,
      groupLabel: 'imported keys',
      hdIndex: -1,
      labels: k.labels ?? [],
    });
  });
  return out;
}

/** Every label the user has attached to anything, deduped and sorted. */
export function allLabels(secret: VaultSecret): string[] {
  const set = new Set<string>();
  for (const a of listAccounts(secret)) for (const l of a.labels) set.add(l);
  return [...set].sort();
}

/** Resolve a flat index to a live signer. Throws if the index is out of range. */
export function accountAt(secret: VaultSecret, index: number): SignerAccount {
  const s = normalizeSecret(secret);
  let i = index;
  for (const seed of s.seeds) {
    if (i < seed.accounts.length) return deriveAccount(seed.mnemonic, i);
    i -= seed.accounts.length;
  }
  const k = s.imported[i];
  if (!k) throw new Error(`no account at index ${index}`);
  return privateKeyToAccount(k.privateKey);
}

/**
 * THE RAW PRIVATE KEY behind a flat index.
 *
 * The one function in this file that hands back a secret in the clear, and it
 * exists so a user can leave: a key you cannot export is a key you do not
 * really own. Everything that calls it is gated on the password being typed
 * again, at the moment of asking — see the session boundary.
 *
 * For an imported key that is simply the stored key. For an HD account the key
 * is taken from VIEM'S OWN HD node, not re-derived down a path written out by
 * hand, so it cannot drift from the address the wallet has been showing you.
 * A test asserts the address it implies matches `listAccounts()`.
 */
export function privateKeyAt(secret: VaultSecret, index: number): `0x${string}` {
  const s = normalizeSecret(secret);
  let i = index;
  for (const seed of s.seeds) {
    if (i < seed.accounts.length) {
      const hd = deriveAccount(seed.mnemonic, i).getHdKey();
      if (!hd.privateKey) throw new Error('this seed account has no private key');
      return bytesToHex(hd.privateKey);
    }
    i -= seed.accounts.length;
  }
  const k = s.imported[i];
  if (!k) throw new Error(`no wallet at index ${index}`);
  return k.privateKey;
}

/**
 * The seed phrase of one group, or null if there is no such group. Imported
 * keys have no group and therefore no phrase, which is the whole distinction
 * the wallet keeps warning about.
 */
export function mnemonicOfGroup(secret: VaultSecret, groupId: string): string | null {
  const s = normalizeSecret(secret);
  return s.seeds.find((g) => g.id === groupId)?.mnemonic ?? null;
}

/**
 * The seed group backing a flat index, or null for a loose key. Stealth
 * addresses come from a mnemonic, so imported keys simply do not have one.
 */
export function seedOf(secret: VaultSecret, index: number): SeedGroup | null {
  const s = normalizeSecret(secret);
  let i = index;
  for (const seed of s.seeds) {
    if (i < seed.accounts.length) return seed;
    i -= seed.accounts.length;
  }
  return null;
}

// -------------------------------------------------------------- mutations ----
// All pure: they return a new secret, and the caller re-seals the vault.

export function addHdAccount(secret: VaultSecret, groupId: string): VaultSecret {
  const s = normalizeSecret(secret);
  if (!s.seeds.some((x) => x.id === groupId)) throw new Error(`no seed group ${groupId}`);
  return {
    ...s,
    seeds: s.seeds.map((seed) =>
      seed.id === groupId ? { ...seed, accounts: [...seed.accounts, { labels: [] }] } : seed,
    ),
  };
}

export function addSeedGroup(secret: VaultSecret, mnemonic: string, nick?: string): VaultSecret {
  const s = normalizeSecret(secret);
  const m = mnemonic.trim().toLowerCase();
  if (!validateMnemonic(m)) throw new Error('that is not a valid seed phrase, bro');
  if (s.seeds.some((x) => x.mnemonic === m)) throw new Error('that seed phrase is already in here');
  const seed: SeedGroup = {
    id: nextId('seed', s.seeds.map((x) => x.id)),
    mnemonic: m,
    ...(nick ? { nick } : {}),
    accounts: [{ labels: [] }],
  };
  return { ...s, seeds: [...s.seeds, seed] };
}

export function addImportedKey(secret: VaultSecret, privateKey: string, nick?: string): VaultSecret {
  const s = normalizeSecret(secret);
  const key = normalizePrivateKey(privateKey);
  const addr = addressOfPrivateKey(key).toLowerCase();
  if (listAccounts(s).some((a) => a.address.toLowerCase() === addr)) {
    throw new Error('that account is already in this wallet');
  }
  const k: ImportedKey = {
    id: nextId('key', s.imported.map((x) => x.id)),
    privateKey: key,
    ...(nick ? { nick } : {}),
    labels: [],
  };
  return { ...s, imported: [...s.imported, k] };
}

/** Apply a metadata patch (nickname and/or labels) to one flat index. */
export function editAccount(secret: VaultSecret, index: number, patch: AccountMeta): VaultSecret {
  const s = normalizeSecret(secret);
  let i = index;
  const seeds = s.seeds.map((seed) => {
    if (i < 0) return seed;
    if (i < seed.accounts.length) {
      const at = i;
      i = -1;
      return {
        ...seed,
        accounts: seed.accounts.map((a, j) => (j === at ? { ...a, ...clean(patch) } : a)),
      };
    }
    i -= seed.accounts.length;
    return seed;
  });
  if (i < 0) return { ...s, seeds };
  const at = i;
  if (!s.imported[at]) throw new Error(`no account at index ${index}`);
  return { ...s, seeds, imported: s.imported.map((k, j) => (j === at ? { ...k, ...clean(patch) } : k)) };
}

/** drop undefined fields so a nickname-only patch leaves labels alone */
function clean(patch: AccountMeta): AccountMeta {
  const out: AccountMeta = {};
  if (patch.nick !== undefined) out.nick = patch.nick.trim() || undefined;
  if (patch.labels !== undefined) out.labels = dedupeLabels(patch.labels);
  return out;
}

export function dedupeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const l = raw.trim().toLowerCase();
    if (!l || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

export function renameGroup(secret: VaultSecret, groupId: string, nick: string): VaultSecret {
  const s = normalizeSecret(secret);
  if (groupId === IMPORTED_GROUP) throw new Error('imported keys are not a seed phrase, bro');
  if (!s.seeds.some((x) => x.id === groupId)) throw new Error(`no seed group ${groupId}`);
  return {
    ...s,
    seeds: s.seeds.map((seed) => (seed.id === groupId ? { ...seed, nick: nick.trim() || undefined } : seed)),
  };
}

/** Forget an entire seed group. The last remaining seed group cannot go. */
export function removeSeedGroup(secret: VaultSecret, groupId: string): VaultSecret {
  const s = normalizeSecret(secret);
  if (s.seeds.length <= 1) throw new Error('that is the last seed phrase in here. it stays.');
  if (!s.seeds.some((x) => x.id === groupId)) throw new Error(`no seed group ${groupId}`);
  return { ...s, seeds: s.seeds.filter((seed) => seed.id !== groupId) };
}

/** Forget one imported private key, addressed by its flat index. */
export function removeImported(secret: VaultSecret, index: number): VaultSecret {
  const s = normalizeSecret(secret);
  const hd = s.seeds.reduce((n, seed) => n + seed.accounts.length, 0);
  const at = index - hd;
  if (at < 0 || !s.imported[at]) throw new Error('only imported keys can be forgotten one at a time');
  return { ...s, imported: s.imported.filter((_, j) => j !== at) };
}
