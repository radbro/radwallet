/**
 * The session keyring boundary.
 *
 * Extension: decrypted keys live ONLY in the background service worker. UI
 * pages (popup, approval windows) never see any mnemonic or private key — they
 * send signing requests over intra-extension messages and get back
 * signatures/hashes. An opaque browser-session envelope lets a replacement
 * worker resume until auto-lock; plaintext key material never enters the UI or
 * storage.session. Unlock once; the background auto-locks after a timer.
 *
 * PWA / demo: no background exists, so LocalSession keeps the unlocked
 * secret in page memory with the same interface and the same auto-lock.
 *
 * The session also owns the vault KEY (see core/vault.ts). Anything that
 * mutates the vault — adding a wallet, renaming one, editing labels — happens
 * behind this boundary and comes back as a re-sealed blob for the UI to
 * persist. The password itself never lives anywhere but the unlock call.
 */
import {
  type VaultSecret,
  type WalletAccount,
  type AccountMeta,
  type DappTxRequest,
  type KnownToken,
  type VaultBlob,
  type VaultKey,
  openVault,
  openVaultKeyed,
  newVaultKey,
  resealVault,
  normalizeSecret,
  listAccounts,
  allLabels,
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
  bestEthToRadRoute,
  executeBestRoute,
  deriveStealthKeys,
  scanStealthPayments,
  sweepStealth,
  announceStealthPlan as coreAnnounceStealthPlan,
  confirmStealthAnnouncement as coreConfirmStealthAnnouncement,
  transferStealthPlan as coreTransferStealthPlan,
  validateStealthSendPlan,
  type StealthSendPlan,
} from '@radwallet/core';
import { toHex } from 'viem';
import { ext, IS_EXTENSION, call as extCall } from './ext.js';
import { kv } from './storage.js';

export interface SessionStatus {
  locked: boolean;
  accounts: WalletAccount[];
  /** ERC-5564 stealth meta-address per seed group; loose keys have none */
  stealthMetas: Record<string, string>;
  /** every label in use, for the wallet picker's filter row */
  labels: string[];
}

/** a status plus the re-sealed vault the caller must persist */
export interface SessionWrite {
  status: SessionStatus;
  vault: VaultBlob;
}

/** what a brand-new vault is built around: exactly one of these */
export type VaultInit = { mnemonic: string } | { privateKey: string };

/** JSON-safe on the wire, and the only place a fresh secret is shaped */
export function secretFrom(init: VaultInit): VaultSecret {
  if ('mnemonic' in init) return normalizeSecret({ mnemonic: init.mnemonic, accountCount: 1 });
  return addImportedKey({ seeds: [], imported: [] }, init.privateKey);
}

/** bigint-free stealth payment shape, safe to cross the message boundary */
export interface StealthPaymentWire {
  stealthAddress: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  blockNumber: string;
  balanceEth: string;
}

export interface SendTxOptions {
  trackOnSuccess?: Array<KnownToken & { recipient?: `0x${string}` }>;
}

interface DappTxWire {
  from?: `0x${string}`;
  to?: `0x${string}`;
  value?: `0x${string}`;
  data?: `0x${string}`;
  gas?: `0x${string}`;
  nonce?: number;
  maxFeePerGas?: `0x${string}`;
  maxPriorityFeePerGas?: `0x${string}`;
}

export interface StealthSendPlanWire {
  chainId: 1;
  from?: `0x${string}`;
  stealthAddress: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  viewTag: number;
  valueWei: string;
  transfer: DappTxWire;
  announce: DappTxWire;
  transferGas: string;
  announceGas: string;
  gasPriceWei: string;
  totalMaxWei: string;
}

export type StoredStealthSendStatus = 'prepared' | 'announce_sent' | 'transfer_failed' | 'transfer_sent';

export interface StoredStealthSend {
  id: string;
  from: `0x${string}`;
  amountEth: string;
  createdAt: number;
  status: StoredStealthSendStatus;
  plan: StealthSendPlanWire;
  announceHash?: `0x${string}`;
  transferHash?: `0x${string}`;
  transferError?: string;
}

export interface WalletSession {
  status(): Promise<SessionStatus>;
  unlock(vault: VaultBlob, password: string, autoLockMin: number): Promise<SessionStatus>;
  /** seal a brand-new vault around one seed phrase or one private key */
  create(init: VaultInit, password: string, autoLockMin: number): Promise<SessionWrite>;
  lock(): Promise<void>;
  /** Restart the unlocked session's timer with a newly saved interval. */
  setAutoLock(minutes: number): Promise<void>;
  /** reveal the next BIP-44 account inside one seed group */
  addAccount(groupId: string): Promise<SessionWrite>;
  /** add another seed phrase as its own group */
  addSeed(mnemonic: string, nick?: string): Promise<SessionWrite>;
  /** import a raw private key as a loose key */
  importKey(privateKey: string, nick?: string): Promise<SessionWrite>;
  /** nickname and/or labels for one account */
  editAccount(index: number, patch: AccountMeta): Promise<SessionWrite>;
  renameGroup(groupId: string, nick: string): Promise<SessionWrite>;
  /** forget a whole seed group (never the last one) */
  forgetGroup(groupId: string): Promise<SessionWrite>;
  /** forget one loose key */
  forgetAccount(index: number): Promise<SessionWrite>;
  /**
   * REVEAL A SECRET — the private key behind one wallet, or a seed group's
   * phrase. Both take the password and the sealed vault, and both open THAT
   * rather than reading the unlocked session: a reveal is the one thing that
   * must never ride on a session someone else left unlocked, and a wrong
   * password has to fail as a wrong password rather than as a permission.
   */
  revealKey(vault: VaultBlob, password: string, index: number): Promise<`0x${string}`>;
  revealPhrase(vault: VaultBlob, password: string, groupId: string): Promise<string>;
  signMessage(index: number, message: string): Promise<`0x${string}`>;
  signTypedData(index: number, typedJson: string): Promise<`0x${string}`>;
  sendTx(
    index: number,
    endpoint: string,
    chainId: number,
    tx: DappTxRequest,
    options?: SendTxOptions,
  ): Promise<`0x${string}`>;
  swapBest(
    index: number,
    endpoint: string,
    amountInEth: string,
    slippagePct: number,
    options?: SendTxOptions,
  ): Promise<`0x${string}`>;
  scanStealth(index: number, endpoint: string): Promise<StealthPaymentWire[]>;
  sweepStealth(index: number, endpoint: string, payment: StealthPaymentWire, to: `0x${string}`):
    Promise<`0x${string}`>;
  announceStealthPlan(index: number, endpoint: string, plan: StealthSendPlanWire): Promise<`0x${string}`>;
  confirmStealthAnnouncement(
    endpoint: string, announceHash: `0x${string}`, plan: StealthSendPlanWire,
  ): Promise<void>;
  transferStealthPlan(
    index: number, endpoint: string, plan: StealthSendPlanWire, announceHash: `0x${string}`,
  ): Promise<`0x${string}`>;
  /**
   * Connect, switch or disconnect a site from inside the wallet. Returns the
   * new connection map. PWA builds have no tabs to notify, so LocalSession
   * refuses rather than pretending.
   */
  setConnection(origin: string, addresses: string[]): Promise<Record<string, string[]>>;
  /** fires in LocalSession when the auto-lock timer trips */
  onAutoLock?: () => void;
}

const isExtension = IS_EXTENSION;

export function checkedAutoLockMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 240) {
    throw new Error('auto-lock must be a whole number from 1 to 240 minutes');
  }
  return value;
}

/** shared by both session implementations so status shape can never diverge */
export function statusOf(secret: VaultSecret | null): SessionStatus {
  if (!secret) return { locked: true, accounts: [], stealthMetas: {}, labels: [] };
  const metas: Record<string, string> = {};
  for (const seed of secret.seeds) metas[seed.id] = deriveStealthKeys(seed.mnemonic).metaAddress;
  return { locked: false, accounts: listAccounts(secret), stealthMetas: metas, labels: allLabels(secret) };
}

// ---------------------------------------------------------------- local ----
class LocalSession implements WalletSession {
  private secret: VaultSecret | null = null;
  private vaultKey: VaultKey | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lockMin = 15;
  onAutoLock?: () => void;

  private arm(minutes: number): void {
    this.lockMin = minutes;
    if (this.timer) clearTimeout(this.timer);
    if (minutes > 0) {
      this.timer = setTimeout(() => {
        this.secret = null;
        this.vaultKey = null;
        this.onAutoLock?.();
      }, minutes * 60_000);
    }
  }

  async status(): Promise<SessionStatus> {
    return statusOf(this.secret);
  }

  async unlock(vault: VaultBlob, password: string, autoLockMin: number): Promise<SessionStatus> {
    const minutes = checkedAutoLockMinutes(autoLockMin);
    const opened = await openVaultKeyed<VaultSecret>(vault, password);
    this.secret = normalizeSecret(opened.secret);
    this.vaultKey = opened.vaultKey;
    this.arm(minutes);
    return this.status();
  }

  async create(init: VaultInit, password: string, autoLockMin: number): Promise<SessionWrite> {
    const minutes = checkedAutoLockMinutes(autoLockMin);
    this.vaultKey = await newVaultKey(password);
    this.secret = secretFrom(init);
    this.arm(minutes);
    return this.write(this.secret);
  }

  async lock(): Promise<void> {
    this.secret = null;
    this.vaultKey = null;
    if (this.timer) clearTimeout(this.timer);
  }

  async setAutoLock(minutes: number): Promise<void> {
    const interval = checkedAutoLockMinutes(minutes);
    if (!this.secret) throw new Error('locked');
    this.arm(interval);
  }

  /** commit a mutated secret: re-seal, re-arm, hand the blob back to persist */
  private async write(next: VaultSecret): Promise<SessionWrite> {
    if (!this.vaultKey) throw new Error('locked');
    this.secret = next;
    this.arm(this.lockMin);
    return { status: statusOf(next), vault: await resealVault(next, this.vaultKey) };
  }

  private get open(): VaultSecret {
    if (!this.secret) throw new Error('locked');
    return this.secret;
  }

  addAccount(groupId: string): Promise<SessionWrite> {
    return this.write(addHdAccount(this.open, groupId));
  }
  addSeed(mnemonic: string, nick?: string): Promise<SessionWrite> {
    return this.write(addSeedGroup(this.open, mnemonic, nick));
  }
  importKey(privateKey: string, nick?: string): Promise<SessionWrite> {
    return this.write(addImportedKey(this.open, privateKey, nick));
  }
  editAccount(index: number, patch: AccountMeta): Promise<SessionWrite> {
    return this.write(editAccount(this.open, index, patch));
  }
  renameGroup(groupId: string, nick: string): Promise<SessionWrite> {
    return this.write(renameGroup(this.open, groupId, nick));
  }
  forgetGroup(groupId: string): Promise<SessionWrite> {
    return this.write(removeSeedGroup(this.open, groupId));
  }
  forgetAccount(index: number): Promise<SessionWrite> {
    return this.write(removeImported(this.open, index));
  }

  async revealKey(vault: VaultBlob, password: string, index: number): Promise<`0x${string}`> {
    return privateKeyAt(normalizeSecret(await openVault<VaultSecret>(vault, password)), index);
  }

  async revealPhrase(vault: VaultBlob, password: string, groupId: string): Promise<string> {
    const secret = normalizeSecret(await openVault<VaultSecret>(vault, password));
    const m = mnemonicOfGroup(secret, groupId);
    if (!m) throw new Error('that group has no seed phrase');
    return m;
  }

  async setConnection(): Promise<Record<string, string[]>> {
    throw new Error('connecting to a site needs the extension build');
  }

  private signer(index: number) {
    const s = this.open;
    this.arm(this.lockMin);
    return accountAt(s, index);
  }

  async signMessage(index: number, message: string): Promise<`0x${string}`> {
    const m = message.startsWith('0x') ? { raw: message as `0x${string}` } : message;
    return this.signer(index).signMessage({ message: m });
  }

  async signTypedData(index: number, typedJson: string): Promise<`0x${string}`> {
    return this.signer(index).signTypedData(JSON.parse(typedJson));
  }

  async sendTx(index: number, endpoint: string, chainId: number, tx: DappTxRequest): Promise<`0x${string}`> {
    return sendDappTx(endpoint, this.signer(index), tx, chainId);
  }

  async swapBest(index: number, endpoint: string, amountInEth: string, slippagePct: number): Promise<`0x${string}`> {
    const route = await bestEthToRadRoute(endpoint, amountInEth, slippagePct);
    return executeBestRoute(endpoint, this.signer(index), route);
  }

  private stealthKeys(index: number) {
    const seed = seedOf(this.open, index);
    if (!seed) throw new Error(STEALTH_REFUSAL);
    this.arm(this.lockMin);
    return deriveStealthKeys(seed.mnemonic);
  }

  async scanStealth(index: number, endpoint: string): Promise<StealthPaymentWire[]> {
    return wirePayments(await scanStealthPayments(endpoint, this.stealthKeys(index)));
  }

  async sweepStealth(
    index: number, endpoint: string, payment: StealthPaymentWire, to: `0x${string}`,
  ): Promise<`0x${string}`> {
    return sweepStealth(endpoint, this.stealthKeys(index), payment, to);
  }

  async announceStealthPlan(index: number, endpoint: string, plan: StealthSendPlanWire): Promise<`0x${string}`> {
    return coreAnnounceStealthPlan(endpoint, this.signer(index), planFromWire(plan));
  }

  confirmStealthAnnouncement(
    endpoint: string, announceHash: `0x${string}`, plan: StealthSendPlanWire,
  ): Promise<void> {
    return coreConfirmStealthAnnouncement(endpoint, announceHash, planFromWire(plan));
  }

  async transferStealthPlan(
    index: number, endpoint: string, plan: StealthSendPlanWire, announceHash: `0x${string}`,
  ): Promise<`0x${string}`> {
    return coreTransferStealthPlan(endpoint, this.signer(index), planFromWire(plan), announceHash);
  }
}

export const STEALTH_REFUSAL =
  'this is a loose private key — stealth addresses come from a seed phrase. use a seed wallet.';

export function wirePayments(
  found: Array<{ stealthAddress: `0x${string}`; ephemeralPubKey: `0x${string}`; blockNumber: bigint; balanceEth: string }>,
): StealthPaymentWire[] {
  return found.map((f) => ({
    stealthAddress: f.stealthAddress,
    ephemeralPubKey: f.ephemeralPubKey,
    blockNumber: String(f.blockNumber),
    balanceEth: f.balanceEth,
  }));
}

function txToWire(tx: DappTxRequest): DappTxWire {
  return {
    from: tx.from,
    to: tx.to,
    value: tx.value === undefined ? undefined : typeof tx.value === 'bigint' ? toHex(tx.value) : tx.value,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  };
}

function txFromWire(tx: DappTxWire): DappTxRequest {
  return {
    from: tx.from,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  };
}

export function planToWire(plan: StealthSendPlan): StealthSendPlanWire {
  return {
    chainId: plan.chainId,
    from: plan.from,
    stealthAddress: plan.stealthAddress,
    ephemeralPubKey: plan.ephemeralPubKey,
    viewTag: plan.viewTag,
    valueWei: String(plan.valueWei),
    transfer: txToWire(plan.transfer),
    announce: txToWire(plan.announce),
    transferGas: String(plan.transferGas),
    announceGas: String(plan.announceGas),
    gasPriceWei: String(plan.gasPriceWei),
    totalMaxWei: String(plan.totalMaxWei),
  };
}

function planFromWire(plan: StealthSendPlanWire): StealthSendPlan {
  return {
    chainId: 1,
    from: plan.from,
    stealthAddress: plan.stealthAddress,
    ephemeralPubKey: plan.ephemeralPubKey,
    viewTag: plan.viewTag,
    valueWei: BigInt(plan.valueWei),
    transfer: txFromWire(plan.transfer),
    announce: txFromWire(plan.announce),
    transferGas: BigInt(plan.transferGas),
    announceGas: BigInt(plan.announceGas),
    gasPriceWei: BigInt(plan.gasPriceWei),
    totalMaxWei: BigInt(plan.totalMaxWei),
  };
}

function validateWirePlanSender(plan: StealthSendPlanWire, from: `0x${string}`): void {
  validateStealthSendPlan(planFromWire(plan), from);
}

const PENDING_STEALTH_KEY = 'stealthPending';

export async function listPendingStealthSends(): Promise<StoredStealthSend[]> {
  const raw = await kv.get(PENDING_STEALTH_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as StoredStealthSend[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function savePendingStealthSend(entry: StoredStealthSend): Promise<void> {
  const list = (await listPendingStealthSends()).filter((x) => x.id !== entry.id);
  list.unshift(entry);
  await kv.set(PENDING_STEALTH_KEY, JSON.stringify(list.slice(0, 20)));
}

export async function removePendingStealthSend(id: string): Promise<void> {
  const list = (await listPendingStealthSends()).filter((x) => x.id !== id);
  await kv.set(PENDING_STEALTH_KEY, JSON.stringify(list));
}

// --------------------------------------------------------------- remote ----
/**
 * The background holds the decrypted keys. Browsers tear that process down
 * whenever they feel like it — MV3 idles a service worker out after ~30s and
 * Firefox unloads event pages — so the replacement worker first authenticates
 * and decrypts the browser-session envelope. If that envelope is missing,
 * corrupt or expired, every call answers 'locked' while a long-lived page may
 * still look open. Treat that answer as the lock event it is.
 */
const LOCKED = 'locked';
let lockedListener: (() => void) | undefined;

/** register the one handler that drops the UI back to the unlock screen */
export function onRemoteLocked(fn: () => void): void {
  lockedListener = fn;
}

/** one background round trip; a 'locked' answer also drops the UI to unlock */
function sessionCall<T>(msg: Record<string, unknown>): Promise<T> {
  return extCall<any>((cb) => ext.runtime.sendMessage(msg, cb)).then((resp) => {
    if (resp && resp.error) {
      if (resp.error === LOCKED) lockedListener?.();
      throw new Error(resp.error);
    }
    return resp as T;
  });
}

class RemoteSession implements WalletSession {
  status(): Promise<SessionStatus> {
    return sessionCall({ t: 'sess.status' });
  }
  unlock(vault: VaultBlob, password: string, autoLockMin: number): Promise<SessionStatus> {
    return sessionCall({ t: 'sess.unlock', vault, password, autoLockMin });
  }
  create(init: VaultInit, password: string, autoLockMin: number): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.create', init, password, autoLockMin });
  }
  lock(): Promise<void> {
    return sessionCall({ t: 'sess.lock' });
  }
  setAutoLock(minutes: number): Promise<void> {
    return sessionCall({ t: 'sess.setAutoLock', minutes });
  }
  addAccount(groupId: string): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.addAccount', groupId });
  }
  addSeed(mnemonic: string, nick?: string): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.addSeed', mnemonic, nick });
  }
  importKey(privateKey: string, nick?: string): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.importKey', privateKey, nick });
  }
  editAccount(index: number, patch: AccountMeta): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.editAccount', index, patch });
  }
  renameGroup(groupId: string, nick: string): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.renameGroup', groupId, nick });
  }
  forgetGroup(groupId: string): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.forgetGroup', groupId });
  }
  forgetAccount(index: number): Promise<SessionWrite> {
    return sessionCall({ t: 'sess.forgetAccount', index });
  }
  revealKey(vault: VaultBlob, password: string, index: number): Promise<`0x${string}`> {
    return sessionCall<{ secret: `0x${string}` }>({ t: 'sess.revealKey', vault, password, index })
      .then((r) => r.secret);
  }
  revealPhrase(vault: VaultBlob, password: string, groupId: string): Promise<string> {
    return sessionCall<{ secret: string }>({ t: 'sess.revealPhrase', vault, password, groupId })
      .then((r) => r.secret);
  }
  signMessage(index: number, message: string): Promise<`0x${string}`> {
    return sessionCall<{ sig: `0x${string}` }>({ t: 'sess.signMessage', index, message }).then((r) => r.sig);
  }
  signTypedData(index: number, typedJson: string): Promise<`0x${string}`> {
    return sessionCall<{ sig: `0x${string}` }>({ t: 'sess.signTypedData', index, typedJson }).then((r) => r.sig);
  }
  setConnection(origin: string, addresses: string[]): Promise<Record<string, string[]>> {
    return sessionCall<{ connections: Record<string, string[]> }>({ t: 'sess.setConnection', origin, addresses })
      .then((r) => r.connections);
  }

  sendTx(
    index: number,
    endpoint: string,
    chainId: number,
    tx: DappTxRequest,
    options?: SendTxOptions,
  ): Promise<`0x${string}`> {
    return sessionCall<{ hash: `0x${string}` }>({
      t: 'sess.sendTx',
      index,
      endpoint,
      chainId,
      tx,
      trackOnSuccess: options?.trackOnSuccess,
    }).then((r) => r.hash);
  }
  swapBest(
    index: number,
    endpoint: string,
    amountInEth: string,
    slippagePct: number,
    options?: SendTxOptions,
  ): Promise<`0x${string}`> {
    return sessionCall<{ hash: `0x${string}` }>({
      t: 'sess.swapBest',
      index,
      endpoint,
      amountInEth,
      slippagePct,
      trackOnSuccess: options?.trackOnSuccess,
    })
      .then((r) => r.hash);
  }
  scanStealth(index: number, endpoint: string): Promise<StealthPaymentWire[]> {
    return sessionCall<{ payments: StealthPaymentWire[] }>({ t: 'sess.scanStealth', index, endpoint })
      .then((r) => r.payments);
  }
  sweepStealth(
    index: number, endpoint: string, payment: StealthPaymentWire, to: `0x${string}`,
  ): Promise<`0x${string}`> {
    return sessionCall<{ hash: `0x${string}` }>({ t: 'sess.sweepStealth', index, endpoint, payment, to })
      .then((r) => r.hash);
  }
  private async accountAddress(index: number): Promise<`0x${string}`> {
    const acct = (await this.status()).accounts[index];
    if (!acct) throw new Error('account not found');
    return acct.address;
  }
  async announceStealthPlan(index: number, endpoint: string, plan: StealthSendPlanWire): Promise<`0x${string}`> {
    const from = await this.accountAddress(index);
    validateWirePlanSender(plan, from);
    return this.sendTx(index, endpoint, 1, txFromWire(plan.announce));
  }
  confirmStealthAnnouncement(
    endpoint: string, announceHash: `0x${string}`, plan: StealthSendPlanWire,
  ): Promise<void> {
    return coreConfirmStealthAnnouncement(endpoint, announceHash, planFromWire(plan));
  }
  async transferStealthPlan(
    index: number, endpoint: string, plan: StealthSendPlanWire, announceHash: `0x${string}`,
  ): Promise<`0x${string}`> {
    const from = await this.accountAddress(index);
    validateWirePlanSender(plan, from);
    await coreConfirmStealthAnnouncement(endpoint, announceHash, planFromWire(plan));
    return this.sendTx(index, endpoint, 1, txFromWire(plan.transfer));
  }
}

const local = isExtension ? null : new LocalSession();
export const session: WalletSession = local ?? new RemoteSession();
export const SESSION_IS_REMOTE = isExtension;
