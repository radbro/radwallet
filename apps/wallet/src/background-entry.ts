/**
 * RADWALLET background worker (bundled by vite).
 *
 * Chrome loads this as a module service worker, Firefox as a non-persistent
 * event page — both can be torn down at any time, which is why durable state
 * lives in `storage.local` and the unlocked keyring stays memory-only.
 *
 * Holds the ONLY unlocked copy of the keyring in extension mode. UI pages
 * and approval windows talk to it over intra-extension messages; content
 * scripts route dapp RPC here. Auto-locks after a timer. Talks to nothing
 * but the user's own RPC pool — we have no server.
 */
import {
  type VaultSecret,
  type VaultKey,
  type VaultBlob,
  type DappTxRequest,
  type KnownToken,
  openVault,
  openVaultKeyed,
  newVaultKey,
  resealVault,
  normalizeSecret,
  listAccounts,
  accountAt,
  seedOf,
  privateKeyAt,
  mnemonicOfGroup,
  addHdAccount,
  addSeedGroup,
  addImportedKey,
  editAccount,
  renameGroup,
  removeSeedGroup,
  removeImported,
  sendDappTx,
  sanitizeDappTx,
  bestEthToRadRoute,
  executeBestRoute,
  deriveStealthKeys,
  scanStealthPayments,
  sweepStealth,
  CHAINS,
  CHAIN_IDS,
  replaceCustomChains,
  TOKENS,
  mergeTrackedTokens,
  chainClient,
  withFailover,
} from '@radwallet/core';
import { statusOf, secretFrom, wirePayments, STEALTH_REFUSAL, checkedAutoLockMinutes } from './session.js';
import { ext, call, store, showBrowserNotification } from './ext.js';
import { writeVault } from './storage.js';
import {
  confirmationWatchKey,
  mergeConfirmationWatches,
  normalizeConfirmationWatch,
  normalizeSwapTrackTokens,
  trackTokensForSettledReceipt,
  type ConfirmationWatchShape,
} from './swaptrack.js';

/**
 * Read out of the registry, never typed by hand: this string used to say
 * "Ethereum, Base, Arbitrum" while the wallet had shipped Robinhood Chain for
 * weeks, so a site was told to its face that a chain we support does not exist.
 */
function knownChains(): string {
  return `we do ${CHAIN_IDS.map((id) => CHAINS[id].name).join(', ')}.`;
}

/**
 * A service worker can wake after the settings page that registered a custom
 * network has gone away. Rebuild only from the owner's local setting, never a
 * page's wallet_addEthereumChain payload, before deciding whether a chain is
 * available for a proxy call, approval, or receipt watch.
 */
let customNetworksRaw: string | undefined | null = null;
async function syncCustomNetworks(): Promise<void> {
  const raw = await store.get<string>('customNetworks');
  if (raw === customNetworksRaw) return;
  customNetworksRaw = raw;
  try { replaceCustomChains(raw ? JSON.parse(raw) : []); } catch { replaceCustomChains([]); }
}

async function supportsChain(id: number): Promise<boolean> {
  await syncCustomNetworks();
  return CHAIN_IDS.includes(id);
}

// ---------------------------------------------------------------- session --
let secret: VaultSecret | null = null;
/** derived AES key, so metadata edits can re-seal without the password */
let vaultKey: VaultKey | null = null;
let autoLockMin = 15;
let sessionExpiresAt = 0;

/**
 * WHY THE SESSION OUTLIVES THIS WORKER WITHOUT PUTTING A SEED IN STORAGE.
 *
 * Losing focus closes a toolbar popup. Once no wallet view is open, Chrome
 * evicts an idle MV3 worker after roughly 30 seconds and Firefox may unload its
 * event page too. If the decrypted keyring exists only in that heap, a normal
 * context switch becomes a surprise lock long before the user's auto-lock
 * deadline.
 *
 * `storage.session` is the right lifetime (memory-only, browser-session-only,
 * and not exposed to content scripts), but it must not contain a plaintext
 * VaultSecret. It carries only an AES-GCM envelope. The random wrapping key is
 * non-extractable and structured-cloned into extension-origin IndexedDB, which
 * both MV3 workers can use. On explicit lock the envelope and key are deleted;
 * on browser restart session storage drops the envelope, leaving an orphan key
 * that is cleared at the next worker start. The password-derived vaultKey is
 * NEVER cached: after a worker restart, signing survives but a vault mutation
 * still requires a fresh unlock so the sealed vault cannot be opened from disk.
 */
const LIVE = 'liveSessionEnvelope';
const LEGACY_LIVE = 'liveSessionMetadata';
const SESSION_DB = 'radwallet-session';
const SESSION_STORE = 'wrapping-keys';
const CONFIRMATION_WATCHES = 'confirmationWatches';
const CONFIRMATION_ALARM = 'radtx-confirmations';
const CONFIRMATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface LiveSession {
  version: 1;
  keyId: string;
  /** epoch ms after which this is dead, mirroring the alarm */
  expiresAt: number;
  autoLockMin: number;
  iv: string;
  sealed: string;
}

interface LiveSessionPayloadV2 {
  version: 2;
  secret: VaultSecret;
}

let sessionKey: CryptoKey | null = null;
let sessionKeyId: string | null = null;
let sessionCacheQueue: Promise<void> = Promise.resolve();

/** Serialize envelope/key updates so an earlier activity cannot overwrite lock. */
function queueSessionCache(work: () => Promise<void>): Promise<void> {
  const next = sessionCacheQueue.then(work, work);
  sessionCacheQueue = next.catch(() => {});
  return next;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('session key store request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('session key store transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('session key store transaction aborted'));
  });
}

function openSessionDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_STORE)) {
        request.result.createObjectStore(SESSION_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('session key store unavailable'));
    request.onblocked = () => reject(new Error('session key store blocked'));
  });
}

async function replaceSessionKey(id: string, key: CryptoKey): Promise<void> {
  const db = await openSessionDb();
  try {
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(SESSION_STORE);
    store.clear();
    store.put(key, id);
    await done;
  } finally {
    db.close();
  }
}

async function readSessionKey(id: string): Promise<CryptoKey | null> {
  const db = await openSessionDb();
  try {
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const done = transactionDone(tx);
    const found = await requestResult(tx.objectStore(SESSION_STORE).get(id));
    await done;
    return found && (found as CryptoKey).type === 'secret' ? found as CryptoKey : null;
  } finally {
    db.close();
  }
}

async function clearSessionKeys(): Promise<void> {
  const db = await openSessionDb();
  try {
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(SESSION_STORE).clear();
    await done;
  } finally {
    db.close();
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sessionAad(
  live: Pick<LiveSession, 'version' | 'keyId' | 'expiresAt' | 'autoLockMin'>,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${live.version}:${live.keyId}:${live.expiresAt}:${live.autoLockMin}`);
}

function newSessionKeyId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function beginSessionCache(): Promise<void> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const id = newSessionKeyId();
  await queueSessionCache(async () => {
    await replaceSessionKey(id, key);
    sessionKey = key;
    sessionKeyId = id;
  });
}

async function rememberSession(expiresAt: number): Promise<void> {
  if (!ext.storage?.session || !secret || !sessionKey || !sessionKeyId) return;
  const key = sessionKey;
  const payload: LiveSessionPayloadV2 = { version: 2, secret };
  const serialized = JSON.stringify(payload);
  const live: LiveSession = {
    version: 1,
    keyId: sessionKeyId,
    expiresAt,
    autoLockMin,
    iv: '',
    sealed: '',
  };
  await queueSessionCache(async () => {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: sessionAad(live) },
      key,
      new TextEncoder().encode(serialized),
    );
    live.iv = base64(iv);
    live.sealed = base64(new Uint8Array(sealed));
    await call<void>((cb) => ext.storage.session.set({ [LIVE]: live }, cb));
    await call<void>((cb) => ext.storage.session.remove(LEGACY_LIVE, cb)).catch(() => {});
  });
}

function validLiveSession(value: unknown): value is LiveSession {
  const live = value as Partial<LiveSession> | null;
  return live?.version === 1
    && typeof live.keyId === 'string' && /^[0-9a-f]{32}$/.test(live.keyId)
    && typeof live.expiresAt === 'number' && Number.isSafeInteger(live.expiresAt)
    && typeof live.autoLockMin === 'number' && Number.isInteger(live.autoLockMin)
    && live.autoLockMin >= 1 && live.autoLockMin <= 240
    && typeof live.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(live.iv)
    && typeof live.sealed === 'string' && live.sealed.length >= 24 && live.sealed.length <= 1_000_000
    && /^[A-Za-z0-9+/]+={0,2}$/.test(live.sealed);
}

async function restoreSession(): Promise<void> {
  if (secret || !ext.storage?.session) return;
  const live = await call<Record<string, unknown>>(
    (cb) => ext.storage.session.get([LIVE, LEGACY_LIVE], cb),
  ).then((r) => r?.[LIVE]).catch(() => undefined);
  if (!validLiveSession(live)) {
    // Browser restart clears the envelope but IndexedDB intentionally survives;
    // the leftover non-extractable key has nothing to decrypt and is retired.
    await call<void>((cb) => ext.storage.session.remove([LIVE, LEGACY_LIVE], cb)).catch(() => {});
    await clearSessionKeys().catch(() => {});
    return;
  }
  if (Date.now() >= live.expiresAt) {
    await forgetSession();
    return;
  }
  try {
    const key = await readSessionKey(live.keyId);
    if (!key) throw new Error('session wrapping key is gone');
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(live.iv), additionalData: sessionAad(live) },
      key,
      unbase64(live.sealed),
    );
    const parsed = JSON.parse(new TextDecoder().decode(opened)) as VaultSecret | LiveSessionPayloadV2;
    if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 2 && 'secret' in parsed) {
      secret = normalizeSecret(parsed.secret);
    } else {
      // Accept the original payload shape for existing unlocked sessions.
      secret = normalizeSecret(parsed as VaultSecret);
    }
    sessionKey = key;
    sessionKeyId = live.keyId;
    autoLockMin = live.autoLockMin;
    sessionExpiresAt = live.expiresAt;
    ext.alarms.clear('radlock');
    if (autoLockMin > 0) ext.alarms.create('radlock', { when: live.expiresAt });
  } catch {
    // Corrupt, substituted or half-written session state never becomes keys.
    await forgetSession();
  }
}

/** one restore attempt per worker start, awaited by everything that needs keys */
const ready: Promise<void> = restoreSession().catch(() => {});

function armAutoLock(): Promise<void> {
  ext.alarms.clear('radlock');
  if (autoLockMin > 0) ext.alarms.create('radlock', { delayInMinutes: autoLockMin });
  const expiresAt = autoLockMin > 0
    ? Date.now() + autoLockMin * 60_000
    : Number.MAX_SAFE_INTEGER;
  sessionExpiresAt = expiresAt;
  return rememberSession(expiresAt);
}

async function forgetSession(): Promise<void> {
  secret = null;
  vaultKey = null;
  sessionKey = null;
  sessionKeyId = null;
  sessionExpiresAt = 0;
  await queueSessionCache(async () => {
    if (ext.storage?.session) {
      await call<void>((cb) => ext.storage.session.remove([LIVE, LEGACY_LIVE], cb)).catch(() => {});
    }
    await clearSessionKeys().catch(() => {});
  });
}

function forget(): void {
  void forgetSession();
}

ext.alarms.onAlarm.addListener((a: { name: string }) => {
  if (a.name === 'radlock') forget();
  if (a.name === CONFIRMATION_ALARM) void checkConfirmationWatches();
});

// ---- docking ---------------------------------------------------------------
// Chrome only: whether the toolbar button opens the side panel or the popup is
// browser state, not page state, so re-assert the user's choice every time the
// worker spins up. Firefox needs none of this — its sidebar has its own button.
void (async () => {
  if (!ext.sidePanel?.setPanelBehavior) return;
  try {
    const raw = await store.get<string>('prefs');
    const docked = raw ? JSON.parse(raw).docked === true : false;
    ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: docked });
  } catch { /* no prefs yet: leave the default popup behavior */ }
})();

function sessionStatus() {
  return statusOf(secret);
}

/** the open secret, or a refusal */
function open(): VaultSecret {
  if (!secret) throw new Error('locked');
  return secret;
}

/**
 * Commit a mutated secret: re-seal under the key we already hold and hand the
 * blob back so the UI can persist it. The password is never kept for this.
 */
async function write(next: VaultSecret): Promise<{ status: ReturnType<typeof statusOf>; vault: VaultBlob }> {
  if (!vaultKey) throw new Error('locked');
  const vault = await resealVault(next, vaultKey);
  // the UI persists this too, but it can be closed mid-flight — and a change
  // that lives only in worker memory is a change the next unlock loses.
  // Through the boundary, never `store.set` directly: it is what rotates the
  // previous copy into `vaultPrev`, and a raw write here would drop that copy
  // on the floor for the UI as well.
  await writeVault(vault);
  // Only make the new secret recoverable after its sealed vault is durable.
  // Otherwise a failed write followed by worker eviction could resurrect a
  // wallet/import that the vault on disk never received.
  secret = next;
  await armAutoLock();
  return { status: statusOf(next), vault };
}

function stealthKeys(index: number) {
  const seed = seedOf(open(), index);
  if (!seed) throw new Error(STEALTH_REFUSAL);
  void armAutoLock().catch(() => {});
  return deriveStealthKeys(seed.mnemonic);
}

function signer(index: number) {
  const s = open();
  void armAutoLock().catch(() => {}); // signing activity extends the session
  return accountAt(s, index);
}

// ----------------------------------------------------------- dapp routing --
const pending = new Map<string, { request: any; sendResponse: (r: any) => void; windowId: number | null }>();

const READONLY = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_getBalance', 'eth_getCode', 'eth_getLogs', 'eth_getStorageAt',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_feeHistory',
  'eth_maxPriorityFeePerGas', 'net_version', 'eth_chainId',
]);

const DISCOVERY_READONLY = new Set(['eth_chainId', 'net_version']);

const APPROVAL_METHODS = new Set([
  'eth_requestAccounts', 'personal_sign', 'eth_sendTransaction',
  'eth_signTypedData_v4', 'eth_signTypedData_v3',
]);

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function hexAddr(v: unknown): `0x${string}` | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v as `0x${string}` : null;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function originFromSender(sender: any): string {
  const raw = sender.origin || (sender.url ? new URL(sender.url).origin : '');
  if (!/^https?:\/\//.test(raw)) throw new RpcError(4100, 'request origin is not a web origin');
  return raw;
}

/** Only a wallet-owned extension page may use internal session/approval APIs. */
function isWalletPageSender(sender: any): boolean {
  return sender.id === ext.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(ext.runtime.getURL(''));
}

async function selectedChain(): Promise<number> {
  const id = Number((await store.get<string>('chainId')) ?? 1);
  return await supportsChain(id) ? id : 1;
}

async function poolEndpoint(chainId?: number): Promise<string> {
  const id = chainId ?? (await selectedChain());
  if (!(await supportsChain(id))) throw new Error(`unknown chain ${id}`);
  const pools = await store.get<string>('pools');
  try {
    const all = pools ? JSON.parse(pools) : null;
    const p = all?.[id];
    if (p?.endpoints?.length) return p.endpoints[p.epoch % p.endpoints.length];
  } catch { /* fall through to defaults */ }
  return CHAINS[id].defaultEndpoints[0];
}

type ConfirmationWatch = ConfirmationWatchShape;

let confirmationQueueWrite: Promise<void> = Promise.resolve();
let notificationWrite: Promise<void> = Promise.resolve();
let confirmationCheck: Promise<void> | null = null;
const immediateConfirmationWatches = new Set<string>();
const settlingConfirmations = new Set<string>();

async function readConfirmationWatches(): Promise<ConfirmationWatch[]> {
  await syncCustomNetworks();
  const raw = await store.get<string>(CONFIRMATION_WATCHES);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, ConfirmationWatch>();
    for (const value of parsed) {
      const watch = normalizeConfirmationWatch(value, CHAIN_IDS);
      if (!watch) continue;
      unique.set(confirmationWatchKey(watch), watch);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

async function mutateConfirmationWatches(
  mutate: (current: ConfirmationWatch[]) => ConfirmationWatch[],
): Promise<ConfirmationWatch[]> {
  let next: ConfirmationWatch[] = [];
  const write = confirmationQueueWrite.then(async () => {
    next = mutate(await readConfirmationWatches());
    await store.set({ [CONFIRMATION_WATCHES]: JSON.stringify(next) });
  });
  confirmationQueueWrite = write.catch(() => {});
  await write;
  return next;
}

function armConfirmationAlarm(watches?: ConfirmationWatch[]): void {
  // Keep the first ten minutes responsive, then back off hashes that may have
  // been dropped or replaced. This is a one-shot alarm: every check schedules
  // the next one, and Chromium's minimum delay is 30 seconds.
  const ages = (watches ?? []).map((watch) => Math.max(0, Date.now() - watch.queuedAt));
  const delayInMinutes = ages.length === 0 || ages.some((age) => age < 10 * 60_000)
    ? 0.5
    : ages.some((age) => age < 24 * 60 * 60_000) ? 5 : 60;
  ext.alarms.create(CONFIRMATION_ALARM, { delayInMinutes });
}

async function confirmationEndpoints(chainId: number): Promise<string[]> {
  const fallback = [...CHAINS[chainId].defaultEndpoints];
  const raw = await store.get<string>('pools');
  try {
    const pool = raw ? JSON.parse(raw)?.[chainId] : null;
    const endpoints = Array.isArray(pool?.endpoints)
      ? pool.endpoints.filter((endpoint: unknown): endpoint is string => typeof endpoint === 'string')
      : [];
    if (!endpoints.length) return fallback;
    const start = ((Number(pool.epoch) || 0) % endpoints.length + endpoints.length) % endpoints.length;
    return [...endpoints.slice(start), ...endpoints.slice(0, start)];
  } catch {
    return fallback;
  }
}

async function settleConfirmation(
  watch: ConfirmationWatch,
  receipt: {
    status: 'success' | 'reverted';
    logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
  },
): Promise<void> {
  const key = confirmationWatchKey(watch);
  if (settlingConfirmations.has(key)) return;
  settlingConfirmations.add(key);
  try {
    await confirmationQueueWrite;
    const queued = (await readConfirmationWatches()).find((entry) => confirmationWatchKey(entry) === key);
    if (!queued) return;
    const status = receipt.status === 'success' ? 'confirmed' : 'failed';
    if (status === 'confirmed') {
      await rememberTrackedTokens(
        queued.chainId,
        trackTokensForSettledReceipt(receipt.status, queued.trackOnSuccess, receipt.logs),
      ).catch(() => []);
    }
    const network = CHAINS[watch.chainId]?.name ?? `chain ${watch.chainId}`;
    const shortHash = `${watch.hash.slice(0, 10)}…${watch.hash.slice(-6)}`;
    const notify = notificationWrite.then(async () => {
      await showBrowserNotification(
        `radtx:${key}`,
        status === 'confirmed' ? 'RADWALLET · TX CONFIRMED' : 'RADWALLET · TX FAILED',
        `${network} · ${shortHash}`,
      );
      // Firefox can discard notifications created in a tight burst. Keep one
      // per transaction, but space the browser calls rather than aggregating.
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    notificationWrite = notify.catch(() => {});
    await notify;
    const remaining = await mutateConfirmationWatches((current) =>
      current.filter((entry) => confirmationWatchKey(entry) !== key));
    ext.runtime.sendMessage(
      { type: 'wallet-transaction-confirmed', chainId: watch.chainId, hash: watch.hash, status },
      () => void ext.runtime.lastError,
    );
    if (remaining.length === 0) ext.alarms.clear(CONFIRMATION_ALARM);
  } finally {
    settlingConfirmations.delete(key);
  }
}

async function watchConfirmationImmediately(watch: ConfirmationWatch, endpointHint?: string): Promise<void> {
  const key = confirmationWatchKey(watch);
  if (immediateConfirmationWatches.has(key)) return;
  immediateConfirmationWatches.add(key);
  try {
    const endpoints = await confirmationEndpoints(watch.chainId);
    const endpoint = endpointHint || endpoints[0];
    const receipt = await chainClient(endpoint, watch.chainId, 15_000)
      .waitForTransactionReceipt({ hash: watch.hash, timeout: 120_000, confirmations: 1 });
    await settleConfirmation(watch, receipt);
  } catch {
    // The durable alarm retries every endpoint even if this worker disappears.
  } finally {
    immediateConfirmationWatches.delete(key);
  }
}

async function checkConfirmationWatches(): Promise<void> {
  if (confirmationCheck) return confirmationCheck;
  const check = (async () => {
    await confirmationQueueWrite;
    const watches = await mutateConfirmationWatches((current) => current.filter((watch) =>
      Date.now() - watch.queuedAt <= CONFIRMATION_MAX_AGE_MS));
    for (const watch of watches) {
      try {
        const receipt = await withFailover(
          await confirmationEndpoints(watch.chainId),
          (endpoint) => chainClient(endpoint, watch.chainId, 15_000)
            .getTransactionReceipt({ hash: watch.hash }),
        );
        await settleConfirmation(watch, receipt);
      } catch {
        // A missing receipt or unreachable pool stays queued for the next alarm.
      }
    }
    const remaining = await readConfirmationWatches();
    if (remaining.length > 0) armConfirmationAlarm(remaining);
    else ext.alarms.clear(CONFIRMATION_ALARM);
  })();
  confirmationCheck = check.finally(() => { confirmationCheck = null; });
  return confirmationCheck;
}

async function enqueueConfirmation(
  chainId: number,
  hash: string,
  endpointHint?: string,
  trackOnSuccess?: unknown,
): Promise<void> {
  if (!(await supportsChain(chainId)) || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
  const tokens = normalizeSwapTrackTokens(trackOnSuccess);
  const watch: ConfirmationWatch = {
    chainId, hash: hash as `0x${string}`, queuedAt: Date.now(),
    ...(tokens.length ? { trackOnSuccess: tokens } : {}),
  };
  await mutateConfirmationWatches((current) => mergeConfirmationWatches(current, watch));
  armConfirmationAlarm();
  void watchConfirmationImmediately(watch, endpointHint);
}

// Recreate the alarm after browser startup: browsers may clear alarms on restart.
void (async () => {
  await confirmationQueueWrite;
  const queued = await readConfirmationWatches().catch(() => []);
  if (queued.length > 0) {
    armConfirmationAlarm();
    void checkConfirmationWatches();
  }
})();

async function recordDappTx(
  hash: string,
  chainId: number,
  origin: string,
  endpoint?: string,
  trackOnSuccess?: unknown,
): Promise<void> {
  const history = await store.get<string>('history');
  let list: any[] = [];
  try { list = history ? JSON.parse(history) : []; } catch { /* fresh list */ }
  list.unshift({ hash, chainId, kind: 'dapp', origin, ts: Date.now(), status: 'pending' });
  await store.set({ history: JSON.stringify(list.slice(0, 100)) });
  await broadcastWalletTransaction(chainId, hash, endpoint, trackOnSuccess);
}

let trackedTokenWrite: Promise<void> = Promise.resolve();

/**
 * Merge swap outputs into the same on-device custom-token list the manual
 * ADD TOKEN flow uses. Serializing the read-modify-write prevents two approved
 * swaps landing together from erasing each other's new contract.
 */
async function rememberTrackedTokens(chainId: number, raw: unknown): Promise<KnownToken[]> {
  const candidates = Array.isArray(raw)
    ? raw.filter((token): token is KnownToken => Boolean(
      token && typeof token === 'object'
      && typeof token.address === 'string'
      && typeof token.symbol === 'string'
      && typeof token.name === 'string'
      && Number.isInteger(token.decimals),
    ))
    : [];
  if (!candidates.length) return [];
  let added: KnownToken[] = [];
  const write = trackedTokenWrite.then(async () => {
    const stored = await store.get<string>('customTokens');
    let all: Record<number, KnownToken[]> = {};
    try { all = stored ? JSON.parse(stored) : {}; } catch { /* start from a valid map */ }
    const have = Array.isArray(all[chainId]) ? all[chainId] : [];
    const next = mergeTrackedTokens(have, candidates, TOKENS[chainId] ?? []);
    if (next.length === have.length) return;
    added = next.slice(have.length);
    all = { ...all, [chainId]: next };
    await store.set({ customTokens: JSON.stringify(all) });
  });
  trackedTokenWrite = write.catch(() => {});
  await write;
  if (added.length) {
    ext.runtime.sendMessage(
      { type: 'wallet-tokens-tracked', chainId, tokens: added },
      () => void ext.runtime.lastError,
    );
  }
  return added;
}

/**
 * Tell one origin's tabs that its account set changed.
 *
 * EIP-1193 says a provider emits `accountsChanged` whenever the exposed
 * accounts change — including when the change came from the wallet rather
 * than from the page. Connecting from inside the wallet, or switching which
 * wallet a site sees, is exactly that case.
 */
function broadcastAccounts(origin: string, accounts: string[]): void {
  // The message carries the origin and EVERY tab gets it; each content script
  // then drops it unless it is that origin. Filtering here instead would need
  // the `tabs` permission to read tab URLs — that is permission to see every
  // page you have open, forever, and a content script already knows its own
  // origin for free. Telling site B about site A's accounts is exactly the
  // leak this ordering prevents.
  ext.tabs.query({}, (tabs: Array<{ id?: number }>) => {
    for (const t of tabs) {
      if (t.id === undefined) continue;
      ext.tabs.sendMessage(
        t.id, { type: 'accounts-changed', origin, accounts }, () => void ext.runtime.lastError,
      );
    }
  });
}

function broadcastChainChanged(hexId: string): void {
  ext.tabs.query({}, (tabs: Array<{ id?: number }>) => {
    for (const t of tabs) {
      if (t.id !== undefined) {
        ext.tabs.sendMessage(t.id, { type: 'chain-changed', chainId: hexId }, () => void ext.runtime.lastError);
      }
    }
  });
}

/** Persist the receipt watch, then tell open wallet pages about the broadcast. */
async function broadcastWalletTransaction(
  chainId: number,
  hash: string,
  endpoint?: string,
  trackOnSuccess?: unknown,
): Promise<void> {
  // A notification failure must never turn an already-accepted transaction
  // into a signing error. The open page still gets its own receipt watcher.
  await enqueueConfirmation(chainId, hash, endpoint, trackOnSuccess).catch(() => {});
  ext.runtime.sendMessage(
    { type: 'wallet-transaction-broadcast', chainId, hash },
    () => void ext.runtime.lastError,
  );
}

async function proxyRpc(method: string, params: unknown[]): Promise<unknown> {
  const chainId = await selectedChain();
  if (method === 'eth_chainId') return '0x' + chainId.toString(16);
  if (method === 'net_version') return String(chainId);
  const res = await fetch(await poolEndpoint(chainId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

async function connectedAccounts(origin: string): Promise<string[]> {
  const connections = await store.get<string>('connections');
  const map = connections ? JSON.parse(connections) : {};
  return map[origin] ?? [];
}

async function isConnected(origin: string, address: string): Promise<boolean> {
  const exposed = await connectedAccounts(origin);
  return exposed.some((a) => sameAddress(a, address));
}

async function rememberConnection(origin: string, addresses: string[]): Promise<void> {
  const connections = await store.get<string>('connections');
  const map = connections ? JSON.parse(connections) : {};
  map[origin] = addresses;
  await store.set({ connections: JSON.stringify(map) });
}

function openApproval(id: string): void {
  ext.windows.create(
    { url: ext.runtime.getURL(`index.html?approve=${id}`), type: 'popup', width: 390, height: 680 },
    (win: { id: number }) => {
      const entry = pending.get(id);
      if (entry) entry.windowId = win.id;
    },
  );
}

ext.windows.onRemoved.addListener((windowId: number) => {
  for (const [id, entry] of pending) {
    if (entry.windowId !== windowId) continue;
    // Closing the browser window is a user decision, just like REFUSE. Delete
    // first so a simultaneous resolve message cannot answer the dapp twice.
    pending.delete(id);
    entry.sendResponse({ code: 4001, error: 'approval window closed. user refused.' });
    return;
  }
});

/**
 * Resolve the exact account that signs for this request.
 * No default signer exists for dapps: a missing `from`/address used to fall
 * through to wallet 0, which is precisely the wrong fail-open behavior.
 */
function resolveSigner(from: unknown) {
  if (!secret) throw new Error('locked');
  const addr = hexAddr(from);
  if (!addr) throw new RpcError(4100, 'request did not name an explicit signer address. refused.');
  const accounts = listAccounts(secret);
  const hit = accounts.find((a) => sameAddress(a.address, addr));
  if (!hit) throw new RpcError(4100, `signer ${addr} is not one of your wallets. refused.`);
  return hit;
}

async function resolveConnectedSigner(origin: string, from: unknown) {
  const hit = resolveSigner(from);
  if (!(await isConnected(origin, hit.address))) {
    throw new RpcError(4100, `site is not connected to signer ${hit.address}. refused.`);
  }
  return hit;
}

function requestedSigner(method: string, params: unknown[]): `0x${string}` | null {
  if (method === 'personal_sign') return hexAddr(params?.[1]);
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') return hexAddr(params?.[0]);
  if (method === 'eth_sendTransaction') return hexAddr((params?.[0] as DappTxRequest | undefined)?.from);
  return null;
}

async function assertApprovalRequestAllowed(origin: string, method: string, params: unknown[]): Promise<void> {
  if (method === 'eth_requestAccounts') return;
  const addr = requestedSigner(method, params);
  if (!addr) throw new RpcError(4100, `${method} requires an explicit connected signer address`);
  if (!(await isConnected(origin, addr))) {
    throw new RpcError(4100, `site is not connected to signer ${addr}. refused.`);
  }
}

async function approvalChain(request: any): Promise<number> {
  const chainId = Number(request.chainId);
  if (!(await supportsChain(chainId))) throw new Error('approval was created for an unknown chain');
  return chainId;
}

async function assertChainUnchanged(request: any): Promise<number> {
  const chainId = await approvalChain(request);
  const now = await selectedChain();
  if (now !== chainId) {
    throw new RpcError(4001, `chain changed after approval opened (${chainId} -> ${now}). refused.`);
  }
  return chainId;
}

/** Perform the signing operation for an approved dapp request. */
async function performApproved(
  request: any,
  override?: {
    tx?: DappTxRequest;
    address?: string;
  },
  autoTrack?: unknown,
): Promise<unknown> {
  const method = request.method as string;
  if (method === 'wallet_switchEthereumChain') {
    if ((await connectedAccounts(request.origin)).length === 0) {
      throw new RpcError(4100, 'site is no longer connected, so it cannot switch chains');
    }
    const wanted = parseInt(request.params?.[0]?.chainId ?? '0x0', 16);
    if (!(await supportsChain(wanted))) throw new RpcError(4902, `chain ${wanted} not supported. ${knownChains()}`);
    if ((await selectedChain()) === wanted) return null;
    await store.set({ chainId: String(wanted) });
    const hexId = `0x${wanted.toString(16)}`;
    broadcastChainChanged(hexId);
    ext.runtime.sendMessage({ type: 'wallet-chain-changed', chainId: wanted }, () => void ext.runtime.lastError);
    return null;
  }
  if (method === 'eth_requestAccounts') {
    if (!secret) throw new Error('locked');
    const accounts = listAccounts(secret);
    const wanted = override?.address ? hexAddr(override.address) : accounts[0]?.address;
    if (!wanted) throw new RpcError(4100, 'connect did not name one of your wallets. refused.');
    const hit = accounts.find((a) => sameAddress(a.address, wanted));
    if (!hit) throw new RpcError(4100, `connect address ${wanted} is not one of your wallets. refused.`);
    await rememberConnection(request.origin, [hit.address]);
    return [hit.address];
  }
  if (method === 'personal_sign') {
    // params: [message, address]
    const [message, addr] = request.params as [string, string | undefined];
    const account = await resolveConnectedSigner(request.origin, addr);
    const m = message.startsWith('0x') ? { raw: message as `0x${string}` } : message;
    return signer(account.index).signMessage({ message: m });
  }
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
    // params: [address, typedDataJson]
    const [addr, typedJson] = request.params as [string | undefined, string];
    const account = await resolveConnectedSigner(request.origin, addr);
    return signer(account.index).signTypedData(JSON.parse(typedJson));
  }
  if (method === 'eth_sendTransaction') {
    const original = (request.params?.[0] ?? {}) as DappTxRequest;
    // Strip site-supplied nonce and fees from both the request and the override.
    const tx = sanitizeDappTx(override?.tx ?? original);
    const account = await resolveConnectedSigner(request.origin, original.from);
    const chainId = await assertChainUnchanged(request);
    // a dapp does not get to choose the nonce or the fees: picking a nonce
    // lets a site replace a transaction you already signed
    const endpoint = typeof request.endpoint === 'string' ? request.endpoint : await poolEndpoint(chainId);
    const hash = await sendDappTx(endpoint, signer(account.index), tx, chainId);
    // The simulation named these as positive ERC-20 outputs of a trade. Track
    // them only after the durable receipt watcher sees this hash succeed.
    await recordDappTx(
      hash,
      chainId,
      request.origin,
      endpoint,
      normalizeSwapTrackTokens(autoTrack, account.address, 'bind'),
    );
    return hash;
  }
  throw new Error(`cannot perform ${method}`);
}

// --------------------------------------------------------------- messages --
ext.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: any) => void) => {
  // ---- owner-selected network (from our own wallet UI only) ----
  // A direct Settings/Home switch updates the provider just as a dapp-approved
  // EIP-3326 switch does. Without this bridge, an already-open site retained
  // the previous `eth_chainId` until it reloaded, even though the wallet had
  // moved to a valid local network such as Anvil 31337.
  if (msg?.type === 'wallet-select-chain') {
    if (!isWalletPageSender(sender)) {
      sendResponse({ error: 'network selection is wallet-internal' });
      return false;
    }
    (async () => {
      try {
        const wanted = Number(msg.chainId);
        if (!Number.isSafeInteger(wanted) || !(await supportsChain(wanted))) {
          throw new Error('that network is not configured in RADWALLET');
        }
        await store.set({ chainId: String(wanted) });
        const hexId = `0x${wanted.toString(16)}`;
        broadcastChainChanged(hexId);
        ext.runtime.sendMessage({ type: 'wallet-chain-changed', chainId: wanted }, () => void ext.runtime.lastError);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
  }

  // ---- session API (from our own UI pages only) ----
  if (typeof msg?.t === 'string' && msg.t.startsWith('sess.')) {
    if (!isWalletPageSender(sender)) {
      sendResponse({ error: 'session API is wallet-internal' });
      return false;
    }
    (async () => {
      try {
        // A worker that just woke up authenticates and decrypts the opaque
        // browser-session envelope before it answers any session call.
        await ready;
        switch (msg.t) {
          case 'sess.status':
            sendResponse(sessionStatus());
            break;
          case 'sess.unlock': {
            const minutes = checkedAutoLockMinutes(msg.autoLockMin ?? 15);
            const opened = await openVaultKeyed<VaultSecret>(msg.vault, msg.password);
            secret = normalizeSecret(opened.secret);
            vaultKey = opened.vaultKey;
            // pre-multi-wallet installs mirrored the account count in plaintext
            // storage; fold it in once, then let the vault carry it
            const saved = Number((await store.get<string>('accountCount')) ?? '0');
            const first = secret.seeds[0];
            while (first && saved > first.accounts.length) first.accounts.push({ labels: [] });
            autoLockMin = minutes;
            try {
              await beginSessionCache();
              await armAutoLock();
            } catch {
              await forgetSession();
              throw new Error('this browser could not protect the live wallet session. unlock refused.');
            }
            sendResponse(sessionStatus());
            break;
          }
          case 'sess.create': {
            const minutes = checkedAutoLockMinutes(msg.autoLockMin ?? 15);
            vaultKey = await newVaultKey(msg.password);
            secret = secretFrom(msg.init);
            autoLockMin = minutes;
            try {
              await beginSessionCache();
            } catch {
              await forgetSession();
              throw new Error('this browser could not protect the live wallet session. wallet creation refused.');
            }
            sendResponse(await write(secret));
            break;
          }
          case 'sess.setConnection': {
            // wallet-initiated connect / switch / disconnect. The sender check
            // above already refused anything that is not our own UI.
            const origin = String(msg.origin ?? '');
            if (!/^https?:\/\//.test(origin)) throw new Error('that is not a site');
            const raw = await store.get<string>('connections');
            const map = raw ? JSON.parse(raw) : {};
            const next: string[] = Array.isArray(msg.addresses) ? msg.addresses : [];
            if (next.length) map[origin] = next;
            else delete map[origin];
            await store.set({ connections: JSON.stringify(map) });
            broadcastAccounts(origin, next);
            sendResponse({ ok: true, connections: map });
            break;
          }
          case 'sess.lock':
            ext.alarms.clear('radlock');
            await forgetSession();
            sendResponse({});
            break;
          case 'sess.setAutoLock': {
            const minutes = checkedAutoLockMinutes(msg.minutes);
            open();
            autoLockMin = minutes;
            await armAutoLock();
            sendResponse({});
            break;
          }
          case 'sess.addAccount':
            sendResponse(await write(addHdAccount(open(), msg.groupId)));
            break;
          case 'sess.addSeed':
            sendResponse(await write(addSeedGroup(open(), msg.mnemonic, msg.nick)));
            break;
          case 'sess.importKey':
            sendResponse(await write(addImportedKey(open(), msg.privateKey, msg.nick)));
            break;
          case 'sess.editAccount':
            sendResponse(await write(editAccount(open(), msg.index, msg.patch)));
            break;
          case 'sess.renameGroup':
            sendResponse(await write(renameGroup(open(), msg.groupId, msg.nick)));
            break;
          case 'sess.forgetGroup':
            sendResponse(await write(removeSeedGroup(open(), msg.groupId)));
            break;
          case 'sess.forgetAccount':
            sendResponse(await write(removeImported(open(), msg.index)));
            break;
          /*
            REVEALS. These deliberately do NOT read the unlocked session: they
            open the sealed vault with the password typed a moment ago, so a
            wallet someone else left unlocked still cannot be exported by
            walking up to it, and a wrong password fails as a wrong password.
            Nothing is cached, logged, or kept — the secret is returned once
            and this worker forgets it the moment the message is answered.
          */
          case 'sess.revealKey': {
            const secret = normalizeSecret(await openVault<VaultSecret>(msg.vault, msg.password));
            sendResponse({ secret: privateKeyAt(secret, msg.index) });
            break;
          }
          case 'sess.revealPhrase': {
            const secret = normalizeSecret(await openVault<VaultSecret>(msg.vault, msg.password));
            const m = mnemonicOfGroup(secret, msg.groupId);
            if (!m) throw new Error('that group has no seed phrase');
            sendResponse({ secret: m });
            break;
          }
          case 'sess.signMessage': {
            const m = (msg.message as string).startsWith('0x')
              ? { raw: msg.message as `0x${string}` }
              : (msg.message as string);
            sendResponse({ sig: await signer(msg.index).signMessage({ message: m }) });
            break;
          }
          case 'sess.signTypedData':
            sendResponse({ sig: await signer(msg.index).signTypedData(JSON.parse(msg.typedJson)) });
            break;
          case 'sess.sendTx': {
            const account = signer(msg.index);
            const hash = await sendDappTx(msg.endpoint, account, msg.tx, msg.chainId);
            await broadcastWalletTransaction(
              msg.chainId,
              hash,
              msg.endpoint,
              normalizeSwapTrackTokens(msg.trackOnSuccess, account.address, 'bind'),
            );
            sendResponse({ hash });
            break;
          }
          case 'sess.swapBest': {
            const route = await bestEthToRadRoute(msg.endpoint, msg.amountInEth, msg.slippagePct);
            const account = signer(msg.index);
            const hash = await executeBestRoute(msg.endpoint, account, route);
            await broadcastWalletTransaction(
              1,
              hash,
              msg.endpoint,
              normalizeSwapTrackTokens(msg.trackOnSuccess, account.address, 'bind'),
            );
            sendResponse({ hash });
            break;
          }
          case 'sess.scanStealth': {
            const found = await scanStealthPayments(msg.endpoint, stealthKeys(msg.index));
            sendResponse({ payments: wirePayments(found) });
            break;
          }
          case 'sess.sweepStealth': {
            const hash = await sweepStealth(msg.endpoint, stealthKeys(msg.index), msg.payment, msg.to);
            await broadcastWalletTransaction(1, hash, msg.endpoint);
            sendResponse({ hash });
            break;
          }
          default:
            sendResponse({ error: `unknown session call ${msg.t}` });
        }
      } catch (e) {
        sendResponse({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ---- approval UI handshake ----
  if (msg?.type === 'get-approval') {
    if (!isWalletPageSender(sender)) {
      sendResponse({ error: 'approval API is wallet-internal' });
      return false;
    }
    const entry = pending.get(msg.id);
    sendResponse(entry ? entry.request : null);
    return false;
  }
  if (msg?.type === 'resolve-approval') {
    if (!isWalletPageSender(sender)) {
      sendResponse({ error: 'approval API is wallet-internal' });
      return false;
    }
    const entry = pending.get(msg.id);
    if (!entry) {
      sendResponse({ error: 'unknown approval' });
      return false;
    }
    pending.delete(msg.id);
    (async () => {
      // the approval window learns how the ORIGINAL transaction went: with
      let outcome: {
        ok: boolean;
        result?: unknown;
        error?: string;
        code?: number;
      } = { ok: false };
      try {
        if (msg.refuse) {
          // 4001 is EIP-1193 for "the user said no". Dapps use it to stop
          // retrying and put their connect button back, instead of showing a
          // spinner over an error they can't classify.
          entry.sendResponse({ code: 4001, error: msg.reason ?? 'user refused. rad.' });
        } else {
          const result = await performApproved(entry.request, msg.override, msg.autoTrack);
          entry.sendResponse({ result });
          outcome = { ok: true, result };
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const code = (e as any)?.code;
        entry.sendResponse({ code, error });
        outcome = { ok: false, code, error };
      }
      if (entry.windowId) {
        // callback form: Firefox's `chrome` alias returns undefined, not a promise
        await call<void>((cb) => ext.windows.remove(entry.windowId, cb)).catch(() => {});
      }
      sendResponse(outcome);
    })();
    return true;
  }

  // ---- dapp requests (from content scripts) ----
  if (msg?.type === 'rpc-request') {
    const { method, params } = msg;
    (async () => {
      try {
        const origin = originFromSender(sender);
        if (READONLY.has(method)) {
          if (!DISCOVERY_READONLY.has(method) && (await connectedAccounts(origin)).length === 0) {
            throw new RpcError(4100, `${method} is only available after this site is connected`);
          }
          sendResponse({ result: await proxyRpc(method, params) });
          return;
        }
        if (method === 'eth_accounts') {
          sendResponse({ result: await connectedAccounts(origin) });
          return;
        }
        // EIP-3326 / EIP-3085. Unknown chains still get 4902 and page-supplied
        // RPC URLs are never adopted. A site-requested chain switch gets its own
        // wallet approval; silently changing the chain underneath an open
        // signing prompt would change what that prompt means.
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
          const wanted = parseInt((params?.[0] as any)?.chainId ?? '0x0', 16);
          if (!(await supportsChain(wanted))) {
            sendResponse({
              // 4902 tells a dapp "unrecognised chain" — the standard cue to
              // offer wallet_addEthereumChain, which we answer the same way.
              code: 4902,
              error: method === 'wallet_addEthereumChain'
                ? `chain ${wanted} is not configured in RADWALLET, and RADWALLET does not take RPC endpoints from a website. ${knownChains()}`
                : `chain ${wanted} not supported. ${knownChains()}`,
            });
            return;
          }
          if ((await connectedAccounts(origin)).length === 0) {
            throw new RpcError(4100, 'site is not connected, so it cannot ask to switch chains');
          }
          // addChain is only acknowledgement for chains already bundled by
          // the wallet. We deliberately ignore the website's RPC URLs.
          if (method === 'wallet_addEthereumChain') {
            sendResponse({ result: null });
            return;
          }
          const current = await selectedChain();
          if (current === wanted) {
            sendResponse({ result: null });
            return;
          }
          if (pending.size > 0) {
            throw new RpcError(4001, 'finish or refuse the open wallet request before switching chains');
          }
          const endpoint = await poolEndpoint(current);
          const id = crypto.randomUUID();
          pending.set(id, {
            request: { id, origin, method, params, chainId: current, endpoint },
            sendResponse,
            windowId: null,
          });
          openApproval(id);
          return;
        }
        if (APPROVAL_METHODS.has(method)) {
          if (method === 'eth_requestAccounts') {
            const existing = await connectedAccounts(origin);
            if (existing.length) {
              sendResponse({ result: existing });
              return;
            }
          } else {
            await assertApprovalRequestAllowed(origin, method, params ?? []);
          }
          const chainId = await selectedChain();
          const endpoint = await poolEndpoint(chainId);
          const id = crypto.randomUUID();
          pending.set(id, {
            request: { id, origin, method, params, chainId, endpoint },
            sendResponse,
            windowId: null,
          });
          openApproval(id);
          return;
        }
        // 4200: EIP-1193's "the wallet does not do this method"
        sendResponse({ code: 4200, error: `method ${method} not supported (yet)` });
      } catch (e) {
        sendResponse({ code: (e as any)?.code, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  return false;
});
