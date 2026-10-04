/**
 * Encrypted vault: AES-256-GCM, key derived with PBKDF2-SHA256 (600k iters).
 * Everything runs on WebCrypto — works in extension SW, browser, and Node 20+.
 * The vault never leaves the device; there is no server to sync it to.
 */

export interface VaultBlob {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iters: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

const ITERS = 600_000;

/**
 * The only vault layout this build can open.
 *
 * The version travels inside the blob so a future format can be recognised as
 * a FUTURE format instead of failing as a wrong password. From the outside the
 * two are identical — AES-GCM refuses either way — and telling someone their
 * password is wrong when their wallet is merely too new is how a person
 * decides their funds are gone.
 */
export const VAULT_VERSION = 1;

/**
 * PBKDF2 above this is a denial of service, not a security setting: the
 * iteration count is read from the stored blob, so a damaged (or edited) one
 * would otherwise hang the unlock screen forever with no way back.
 */
const MAX_ITERS = 10_000_000;

/**
 * Shape check for something that came off disk. Deliberately version-agnostic:
 * a well-formed blob from a newer build must still parse, so `openVaultKeyed`
 * can tell the user what is actually wrong with it.
 */
export function isVaultBlob(x: unknown): x is VaultBlob {
  if (!x || typeof x !== 'object') return false;
  const b = x as Record<string, unknown>;
  const str = (k: string) => typeof b[k] === 'string' && (b[k] as string).length > 0;
  return (
    typeof b.v === 'number' &&
    typeof b.iters === 'number' &&
    Number.isInteger(b.iters) &&
    b.iters > 0 &&
    str('kdf') &&
    str('salt') &&
    str('iv') &&
    str('ct')
  );
}

const te = new TextEncoder();
const td = new TextDecoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const b = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
  return b;
}

async function deriveKey(password: string, salt: Uint8Array, iters: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iters },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The derived AES key plus the parameters that produced it.
 *
 * A session keeps one of these so it can re-seal the vault after the user
 * renames a wallet or imports a key, WITHOUT holding on to the password and
 * without paying 600k PBKDF2 rounds again. The CryptoKey is non-extractable,
 * so this is strictly less material than the mnemonic the session already has.
 */
export interface VaultKey {
  key: CryptoKey;
  salt: string; // base64, same salt the password derives against
  iters: number;
}

export async function newVaultKey(password: string): Promise<VaultKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(password, salt, ITERS), salt: b64(salt), iters: ITERS };
}

/** Encrypt under an existing key. A fresh IV every time — never reuse (key, iv). */
export async function resealVault(secret: unknown, vk: VaultKey): Promise<VaultBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    vk.key,
    te.encode(JSON.stringify(secret)),
  );
  return { v: 1, kdf: 'PBKDF2-SHA256', iters: vk.iters, salt: vk.salt, iv: b64(iv), ct: b64(ct) };
}

export async function sealVault(secret: unknown, password: string): Promise<VaultBlob> {
  return resealVault(secret, await newVaultKey(password));
}

/** Open a vault and keep the derived key, for later re-sealing. */
export async function openVaultKeyed<T = unknown>(
  blob: VaultBlob,
  password: string,
): Promise<{ secret: T; vaultKey: VaultKey }> {
  if (!isVaultBlob(blob)) throw new Error('VAULT_CORRUPT');
  if (blob.v !== VAULT_VERSION || blob.kdf !== 'PBKDF2-SHA256' || blob.iters > MAX_ITERS) {
    throw new Error('VAULT_UNSUPPORTED');
  }
  const key = await deriveKey(password, unb64(blob.salt), blob.iters);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) as BufferSource },
      key,
      unb64(blob.ct) as BufferSource,
    );
    return {
      secret: JSON.parse(td.decode(pt)) as T,
      vaultKey: { key, salt: blob.salt, iters: blob.iters },
    };
  } catch {
    throw new Error('WRONG_PASSWORD');
  }
}

export async function openVault<T = unknown>(blob: VaultBlob, password: string): Promise<T> {
  return (await openVaultKeyed<T>(blob, password)).secret;
}
