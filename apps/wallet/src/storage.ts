/**
 * Where the wallet's own state lives on disk — and the one place that decides
 * which storage a build gets.
 *
 * Three backends, one interface:
 *
 *   extension  — `chrome.storage.local`, via the browser boundary in ext.ts.
 *                Survives "clear browsing data"; not reachable by web pages or
 *                other extensions.
 *   preferences — the Android app. SharedPreferences, which lives in app-private
 *                storage inside file-based encryption on any device with a lock
 *                screen, and which `allowBackup=false` keeps out of Google
 *                Drive. The WebView's own IndexedDB would have been the easy
 *                choice and it is the wrong one: it is web storage inside an
 *                app, evictable under pressure and wiped by anything that
 *                clears WebView data.
 *   indexeddb  — the PWA. Chosen over localStorage because localStorage is
 *                SITE DATA: one "clear browsing data" wipes it, Safari evicts
 *                it after seven days of not visiting, and WKWebView drops it
 *                under disk pressure. The vault is recoverable from the seed
 *                phrase, but an IMPORTED PRIVATE KEY is outside every seed
 *                backup by design — for that user, eviction is final.
 *   localstorage — only when IndexedDB refuses to open (private windows in
 *                some browsers). Worse durability, still better than losing
 *                the write.
 *
 * None of this is a confidentiality mechanism. The vault is AES-GCM ciphertext
 * before it reaches any of these, which is the whole point: `storage.local` is
 * a plain LevelDB directory in the browser profile, and IndexedDB is a plain
 * file too. The API buys isolation; the vault buys secrecy.
 */
import { IS_EXTENSION, store as extStore } from './ext.js';
import { IS_NATIVE } from './native.js';
import { Preferences } from '@capacitor/preferences';
import { isVaultBlob, type VaultBlob } from '@radwallet/core';

/**
 * Every key the wallet persists. The list exists because migration has to know
 * what to carry across — add a key here when you add one anywhere else.
 */
export const PERSISTED_KEYS = [
  'vault', 'vaultPrev', 'prefs', 'pools', 'pool', 'chainId',
  'customTokens', 'customCollections', 'customNetworks', 'selectedAddress', 'history', 'bio',
  'balanceCache', 'confirmationWatches', 'portfolioSettings', 'addressBook', 'walletList',
] as const;

const DB_NAME = 'radwallet';
const DB_STORE = 'kv';
const MIGRATED = '__migrated_from_localstorage';
/** the native move has its own marker: it is a different move, out of a
 *  different store, and the two must not be able to mark each other done */
const MIGRATED_NATIVE = '__migrated_to_preferences';

export type Backend = 'extension' | 'preferences' | 'indexeddb' | 'localstorage';

let resolved: Backend = IS_EXTENSION ? 'extension' : IS_NATIVE ? 'preferences' : 'indexeddb';
/** which storage the last read/write actually used */
export function backend(): Backend {
  return resolved;
}

// ------------------------------------------------------------- indexeddb ----
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('indexeddb request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexeddb')); return; }
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('indexeddb open failed'));
    r.onblocked = () => reject(new Error('indexeddb blocked'));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<string | null> {
  const tx = db.transaction(DB_STORE, 'readonly');
  return req<string | undefined>(tx.objectStore(DB_STORE).get(key)).then((v) => v ?? null);
}

/**
 * Wait for the TRANSACTION, not just the request.
 *
 * `onsuccess` on a write fires before the transaction commits, so a promise
 * that resolves there reports a write that has not landed yet — and a caller
 * that moves on (or a page that goes away) can lose it. That is precisely the
 * failure this file exists to prevent, so writes wait for `oncomplete`.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
  });
}

function idbSet(db: IDBDatabase, key: string, value: string): Promise<void> {
  const tx = db.transaction(DB_STORE, 'readwrite');
  tx.objectStore(DB_STORE).put(value, key);
  return txDone(tx);
}

function idbDel(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(DB_STORE, 'readwrite');
  tx.objectStore(DB_STORE).delete(key);
  return txDone(tx);
}

/**
 * Carry an older PWA's localStorage across, once.
 *
 * Copy, READ BACK, and only then clear the originals: a migration that clears
 * first and fails second is the one bug this whole change exists to prevent.
 * If anything fails to verify, the marker is not written and the originals
 * stay put, so the next boot tries again.
 */
async function migrate(db: IDBDatabase): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  if (await idbGet(db, MIGRATED)) return;
  const moved: string[] = [];
  for (const key of PERSISTED_KEYS) {
    const old = localStorage.getItem(key);
    if (old === null) continue;
    await idbSet(db, key, old);
    if ((await idbGet(db, key)) !== old) return; // verify or leave it alone
    moved.push(key);
  }
  await idbSet(db, MIGRATED, '1');
  for (const key of moved) localStorage.removeItem(key);
}

let dbp: Promise<IDBDatabase> | null = null;
/** the open database, or null when this build/browser has to use localStorage */
async function db(): Promise<IDBDatabase | null> {
  if (IS_EXTENSION) return null;
  if (resolved === 'localstorage') return null;
  if (!dbp) dbp = openDb().then(async (d) => { await migrate(d); return d; });
  try {
    return await dbp;
  } catch {
    resolved = 'localstorage';
    dbp = null;
    return null;
  }
}

// ---------------------------------------------------------- native move ----
/**
 * Move an older Android install off the WebView's own storage, once.
 *
 * A build before this one kept the vault in the WebView's IndexedDB, which is
 * web storage wearing an app's clothes: evictable under disk pressure and gone
 * the moment anything clears WebView data. Same discipline as the PWA
 * migration — copy, read back, and only then delete the original. A failure
 * anywhere leaves the old copy exactly where it was and retries next launch.
 */
async function migrateToPreferences(): Promise<void> {
  if ((await Preferences.get({ key: MIGRATED_NATIVE })).value) return;
  let d: IDBDatabase | null = null;
  try { d = await openDb(); } catch { /* no IndexedDB is a clean install */ }
  const moved: string[] = [];
  for (const key of PERSISTED_KEYS) {
    const old = d ? await idbGet(d, key) : null;
    const web = old ?? (typeof localStorage === 'undefined' ? null : localStorage.getItem(key));
    if (web === null) continue;
    await Preferences.set({ key, value: web });
    if ((await Preferences.get({ key })).value !== web) return; // verify or leave it alone
    moved.push(key);
  }
  await Preferences.set({ key: MIGRATED_NATIVE, value: '1' });
  for (const key of moved) {
    if (d) await idbDel(d, key);
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  }
}

let nativeMove: Promise<void> | null = null;
/** every native read and write waits on the one-time move */
function nativeReady(): Promise<void> {
  if (!IS_NATIVE) return Promise.resolve();
  if (!nativeMove) nativeMove = migrateToPreferences().catch(() => {});
  return nativeMove;
}

// ------------------------------------------------------------------- kv -----
export const kv = {
  async get(key: string): Promise<string | null> {
    if (IS_EXTENSION) return (await extStore.get<string>(key)) ?? null;
    if (IS_NATIVE) { await nativeReady(); return (await Preferences.get({ key })).value; }
    const d = await db();
    if (d) return idbGet(d, key);
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (IS_EXTENSION) return extStore.set({ [key]: value });
    if (IS_NATIVE) { await nativeReady(); return Preferences.set({ key, value }); }
    const d = await db();
    if (d) return idbSet(d, key, value);
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  },
  async del(key: string): Promise<void> {
    if (IS_EXTENSION) return extStore.set({ [key]: '' });
    if (IS_NATIVE) { await nativeReady(); return Preferences.remove({ key }); }
    const d = await db();
    if (d) return idbDel(d, key);
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

// ---------------------------------------------------------------- vault -----
/**
 * Persist the vault, keeping the copy it replaces.
 *
 * One key overwritten in place means one interrupted or malformed write costs
 * the wallet, and an imported private key has no seed phrase to restore it
 * from. `vaultPrev` is that second chance. Both the UI and the background
 * worker re-seal vaults, so both must come through here — a direct write from
 * either one loses the rotation for the other.
 */
export async function writeVault(blob: VaultBlob): Promise<void> {
  const next = JSON.stringify(blob);
  const current = await kv.get('vault');
  if (current && current !== next) await kv.set('vaultPrev', current);
  await kv.set('vault', next);
}

export interface VaultRead {
  blob: VaultBlob | null;
  /** true when `vault` was unreadable and `vaultPrev` is what came back */
  recovered: boolean;
}

function parse(raw: string | null): VaultBlob | null {
  if (!raw) return null;
  try {
    const b: unknown = JSON.parse(raw);
    return isVaultBlob(b) ? b : null;
  } catch {
    return null;
  }
}

/** Read the vault, falling back to the previous copy if the current one is junk. */
export async function readVault(): Promise<VaultRead> {
  const [cur, prev] = await Promise.all([kv.get('vault'), kv.get('vaultPrev')]);
  const blob = parse(cur);
  if (blob) return { blob, recovered: false };
  const backup = parse(prev);
  return { blob: backup, recovered: !!backup };
}

// ----------------------------------------------------------- persistence ----
let asked = false;
/**
 * Ask the browser to stop counting this origin as evictable cache.
 *
 * Extensions never need it. In a PWA it is the difference between a wallet
 * that is still there next month and one the browser reclaimed for space.
 * Firefox prompts, so it is asked once, after there is actually a vault worth
 * keeping — never at boot.
 */
export async function requestPersistence(): Promise<boolean | null> {
  if (IS_EXTENSION || asked) return null;
  asked = true;
  const s = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!s?.persist) return null;
  try {
    return (await s.persisted?.()) || (await s.persist());
  } catch {
    return null;
  }
}
