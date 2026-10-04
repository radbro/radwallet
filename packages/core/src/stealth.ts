/**
 * ERC-5564 stealth addresses, scheme 1 (secp256k1 + view tags).
 *
 * Receive without linking payments to your public address: you publish a
 * stealth META-address; each sender derives a fresh one-time address only
 * you can spend from, and posts an announcement to the canonical singleton.
 * You scan announcements with your viewing key — locally, via your own RPC.
 *
 * Key hygiene: spending/viewing keys are derived from the wallet seed on a
 * dedicated path (m/44'/60'/0'/5564/{0,1}), so they never collide with
 * transaction accounts, and the viewing key alone can never move funds.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  keccak256, encodeFunctionData, parseAbiItem, decodeEventLog, toHex, getAddress, formatEther,
} from 'viem';
import type { PublicClient } from 'viem';
import type { SignerAccount } from './keyring.js';
import { privateKeyToAccount } from 'viem/accounts';
import { chainClient } from './tokens.js';
import { sendDappTx, type DappTxRequest } from './chain.js';

/** canonical ERC-5564 announcer singleton (verified on-chain, vanity 0x5564…5564) */
export const ANNOUNCER = '0x55649E01B5Df198D18D95b5cc5051630cfD45564' as const;
/** Mainnet creation tx 0xcafab020...fa300, measured through Blockscout + publicnode on 2026-08-28. */
export const ANNOUNCER_DEPLOY_BLOCK = 20_042_207n;
export const SCHEME_ID = 1n;

const ANNOUNCE_ABI = [
  {
    name: 'announce',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schemeId', type: 'uint256' },
      { name: 'stealthAddress', type: 'address' },
      { name: 'ephemeralPubKey', type: 'bytes' },
      { name: 'metadata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export const ANNOUNCEMENT_EVENT = parseAbiItem(
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
);

export interface StealthKeys {
  spendPriv: Uint8Array;
  viewPriv: Uint8Array;
  spendPub: Uint8Array; // compressed, 33 bytes
  viewPub: Uint8Array; // compressed, 33 bytes
  metaAddress: string; // st:eth:0x<spendPub><viewPub>
}

export interface StealthPayment {
  stealthAddress: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  blockNumber: bigint;
  balanceWei: bigint;
  balanceEth: string;
}

export interface StealthScanOptions {
  /** Inclusive start block. Defaults to the full chain, not a recent lookback. */
  fromBlock?: bigint;
  /** Inclusive end block. Defaults to the current head. */
  toBlock?: bigint;
  /** Public RPCs commonly cap log ranges; keep chunks modest by default. */
  chunkBlocks?: bigint;
  /**
   * False by default: a failed chunk means the wallet does not know whether
   * older payments exist, so returning "none" would be a lie.
   */
  allowIncomplete?: boolean;
}

export interface StealthScanResult {
  payments: StealthPayment[];
  fromBlock: bigint;
  toBlock: bigint;
  complete: boolean;
  failedRanges: { fromBlock: bigint; toBlock: bigint; error: string }[];
}

export interface StealthSendPlan {
  chainId: 1;
  from?: `0x${string}`;
  stealthAddress: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  viewTag: number;
  valueWei: bigint;
  transfer: DappTxRequest;
  announce: DappTxRequest;
  transferGas: bigint;
  announceGas: bigint;
  gasPriceWei: bigint;
  totalMaxWei: bigint;
}

export type StealthSendResult =
  | {
    status: 'sent';
    transferHash: `0x${string}`;
    announceHash: `0x${string}`;
    stealthAddress: `0x${string}`;
    plan: StealthSendPlan;
  }
  | {
    status: 'announcement_unconfirmed';
    announceHash: `0x${string}`;
    confirmationError: string;
    stealthAddress: `0x${string}`;
    plan: StealthSendPlan;
  }
  | {
    status: 'transfer_failed';
    announceHash: `0x${string}`;
    transferError: string;
    stealthAddress: `0x${string}`;
    plan: StealthSendPlan;
  };

const CURVE_N = secp256k1.CURVE.n;

function toBig(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pubToAddress(pubCompressed: Uint8Array): `0x${string}` {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(pubCompressed).toRawBytes(false); // 65B, 0x04 prefix
  const hash = keccak256(uncompressed.slice(1));
  return getAddress(`0x${hash.slice(-40)}`);
}

/** hash the shared-secret point and reduce into the scalar field */
function sharedScalar(sharedPointCompressed: Uint8Array): { scalar: bigint; viewTag: number } {
  const h = hexToBytes(keccak256(sharedPointCompressed));
  return { scalar: toBig(h) % CURVE_N, viewTag: h[0] };
}

/** Derive the stealth keypair set from the wallet seed (dedicated path). */
export function deriveStealthKeys(mnemonic: string): StealthKeys {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic.trim().toLowerCase()));
  const spend = root.derive("m/44'/60'/0'/5564/0").privateKey!;
  const view = root.derive("m/44'/60'/0'/5564/1").privateKey!;
  const spendPub = secp256k1.getPublicKey(spend, true);
  const viewPub = secp256k1.getPublicKey(view, true);
  return {
    spendPriv: spend,
    viewPriv: view,
    spendPub,
    viewPub,
    metaAddress: `st:eth:0x${toHex(spendPub).slice(2)}${toHex(viewPub).slice(2)}`,
  };
}

export function parseMetaAddress(meta: string): { spendPub: Uint8Array; viewPub: Uint8Array } | null {
  const m = meta.trim().match(/^st:eth:0x([0-9a-fA-F]{132})$/);
  if (!m) return null;
  try {
    const spendPub = hexToBytes(m[1].slice(0, 66));
    const viewPub = hexToBytes(m[1].slice(66));
    secp256k1.ProjectivePoint.fromHex(spendPub); // throws on invalid points
    secp256k1.ProjectivePoint.fromHex(viewPub);
    return { spendPub, viewPub };
  } catch {
    return null;
  }
}

/** SENDER: one-time stealth address for a recipient's meta-address. */
export function generateStealthAddress(meta: string): {
  stealthAddress: `0x${string}`;
  ephemeralPubKey: `0x${string}`;
  viewTag: number;
} {
  const parsed = parseMetaAddress(meta);
  if (!parsed) throw new Error('not a stealth meta-address');
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, parsed.viewPub, true);
  const { scalar, viewTag } = sharedScalar(shared);
  const stealthPoint = secp256k1.ProjectivePoint.fromHex(parsed.spendPub).add(
    secp256k1.ProjectivePoint.BASE.multiply(scalar),
  );
  return {
    stealthAddress: pubToAddress(stealthPoint.toRawBytes(true)),
    ephemeralPubKey: toHex(ephPub) as `0x${string}`,
    viewTag,
  };
}

/** RECIPIENT: does this announcement pay us? Returns the stealth private key if so. */
export function checkAnnouncement(
  keys: StealthKeys,
  stealthAddress: string,
  ephemeralPubKey: string,
  metadata?: string,
): `0x${string}` | null {
  let ephPub: Uint8Array;
  try {
    ephPub = hexToBytes(ephemeralPubKey);
    secp256k1.ProjectivePoint.fromHex(ephPub);
  } catch {
    return null;
  }
  const shared = secp256k1.getSharedSecret(keys.viewPriv, ephPub, true);
  const { scalar, viewTag } = sharedScalar(shared);
  // view tag pre-filter (first metadata byte) — cheap rejection before EC math
  if (metadata && metadata.length >= 4) {
    const tag = parseInt(metadata.slice(2, 4), 16);
    if (tag !== viewTag) return null;
  }
  const stealthPoint = secp256k1.ProjectivePoint.fromHex(keys.spendPub).add(
    secp256k1.ProjectivePoint.BASE.multiply(scalar),
  );
  if (pubToAddress(stealthPoint.toRawBytes(true)).toLowerCase() !== stealthAddress.toLowerCase()) {
    return null;
  }
  const stealthPriv = (toBig(keys.spendPriv) + scalar) % CURVE_N;
  return `0x${stealthPriv.toString(16).padStart(64, '0')}` as `0x${string}`;
}

/** Announce calldata for the canonical singleton. */
export function announceCalldata(
  stealthAddress: `0x${string}`,
  ephemeralPubKey: `0x${string}`,
  viewTag: number,
): `0x${string}` {
  return encodeFunctionData({
    abi: ANNOUNCE_ABI,
    functionName: 'announce',
    args: [SCHEME_ID, stealthAddress, ephemeralPubKey, toHex(new Uint8Array([viewTag]))],
  });
}

type LogClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'getBalance'>;

function errLine(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

function requestValue(v: DappTxRequest['value']): bigint {
  if (v === undefined) return 0n;
  return typeof v === 'bigint' ? v : BigInt(v);
}

function withGasHeadroom(gas: bigint): bigint {
  return (gas * 12n + 9n) / 10n;
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a as `0x${string}`) === getAddress(b as `0x${string}`);
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function assertPinnedTx(name: string, tx: DappTxRequest, from: `0x${string}`): void {
  if (!tx.from || !sameAddress(tx.from, from)) throw new Error(`stealth ${name} sender changed`);
  if (tx.nonce === undefined) throw new Error(`stealth ${name} missing reserved nonce`);
  if (!tx.gas) throw new Error(`stealth ${name} missing fixed gas limit`);
  if (!tx.maxFeePerGas) throw new Error(`stealth ${name} missing fixed max fee`);
  if (!tx.maxPriorityFeePerGas) throw new Error(`stealth ${name} missing fixed priority fee`);
}

/** Refuse any stealth plan that was not preflighted into durable, retry-safe txs. */
export function validateStealthSendPlan(plan: StealthSendPlan, sender?: `0x${string}`): void {
  if (!plan.from) throw new Error('stealth plan was not preflighted with a sender');
  if (!Number.isInteger(plan.viewTag) || plan.viewTag < 0 || plan.viewTag > 255) {
    throw new Error('stealth plan has an invalid view tag');
  }
  if (sender && !sameAddress(plan.from, sender)) throw new Error('stealth plan sender does not match signer');
  assertPinnedTx('announcement', plan.announce, plan.from);
  assertPinnedTx('transfer', plan.transfer, plan.from);
  if (plan.transfer.nonce !== plan.announce.nonce! + 1) {
    throw new Error('stealth transfer nonce must immediately follow announcement nonce');
  }
  if (!plan.transfer.to || !sameAddress(plan.transfer.to, plan.stealthAddress)) {
    throw new Error('stealth transfer target changed');
  }
  if (requestValue(plan.transfer.value) !== plan.valueWei) throw new Error('stealth transfer amount changed');
  if (!plan.announce.to || !sameAddress(plan.announce.to, ANNOUNCER)) throw new Error('stealth announcer target changed');
  if (requestValue(plan.announce.value) !== 0n) throw new Error('stealth announcement cannot carry ETH');
  if (plan.announce.data !== announceCalldata(plan.stealthAddress, plan.ephemeralPubKey, plan.viewTag)) {
    throw new Error('stealth announcement calldata changed');
  }
}

interface StealthAnnouncementTransaction {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  input: `0x${string}`;
  nonce: number;
}

interface StealthAnnouncementReceipt {
  transactionHash: `0x${string}`;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  logs: readonly {
    address: `0x${string}`;
    data: `0x${string}`;
    topics: readonly `0x${string}`[];
  }[];
}

/**
 * Prove that the exact nonce-bound announcement was mined successfully and
 * emitted the exact discovery data the receiver needs. A receipt for the same
 * nonce is not enough: a replacement transaction can let the following ETH
 * transfer mine while making the one-time address undiscoverable.
 */
export function verifyStealthAnnouncement(
  plan: StealthSendPlan,
  announceHash: `0x${string}`,
  tx: StealthAnnouncementTransaction,
  receipt: StealthAnnouncementReceipt,
): void {
  validateStealthSendPlan(plan);
  if (!sameHex(tx.hash, announceHash) || !sameHex(receipt.transactionHash, announceHash)) {
    throw new Error('stealth announcement receipt belongs to a different transaction');
  }
  if (receipt.status !== 'success') throw new Error('stealth announcement reverted');
  if (!sameAddress(tx.from, plan.from!) || !sameAddress(receipt.from, plan.from!)) {
    throw new Error('stealth announcement sender changed');
  }
  if (!tx.to || !receipt.to || !sameAddress(tx.to, ANNOUNCER) || !sameAddress(receipt.to, ANNOUNCER)) {
    throw new Error('stealth announcement target changed');
  }
  if (tx.nonce !== plan.announce.nonce) throw new Error('stealth announcement nonce changed');
  if (!plan.announce.data || !sameHex(tx.input, plan.announce.data)) {
    throw new Error('stealth announcement calldata changed on chain');
  }

  const expectedMetadata = toHex(new Uint8Array([plan.viewTag]));
  const matched = receipt.logs.some((log) => {
    if (!sameAddress(log.address, ANNOUNCER)) return false;
    try {
      const decoded = decodeEventLog({
        abi: [ANNOUNCEMENT_EVENT],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== 'Announcement') return false;
      const args = decoded.args as {
        schemeId: bigint;
        stealthAddress: `0x${string}`;
        caller: `0x${string}`;
        ephemeralPubKey: `0x${string}`;
        metadata: `0x${string}`;
      };
      return args.schemeId === SCHEME_ID
        && sameAddress(args.stealthAddress, plan.stealthAddress)
        && sameAddress(args.caller, plan.from!)
        && sameHex(args.ephemeralPubKey, plan.ephemeralPubKey)
        && sameHex(args.metadata, expectedMetadata);
    } catch {
      return false;
    }
  });
  if (!matched) throw new Error('stealth announcement receipt is missing the exact discovery log');
}

const STEALTH_RECEIPT_TIMEOUT_MS = 10 * 60_000;
const STEALTH_FINALITY_TIMEOUT_MS = 20 * 60_000;
const STEALTH_FINALITY_POLL_MS = 12_000;

type StealthConfirmationClient = Pick<
  PublicClient,
  'waitForTransactionReceipt' | 'getTransactionReceipt' | 'getTransaction' | 'getBlock'
>;

/**
 * Wait for the exact announcement to be finalized before allowing the ETH
 * transfer. Finality closes the shallow-reorg version of the same loss mode:
 * after a reorg, another transaction at the announcement nonce could land and
 * unlock the already-signed transfer without restoring receiver discovery.
 */
export async function confirmStealthAnnouncementWithClient(
  c: StealthConfirmationClient,
  announceHash: `0x${string}`,
  plan: StealthSendPlan,
): Promise<void> {
  validateStealthSendPlan(plan);
  let receipt = await c.waitForTransactionReceipt({
    hash: announceHash,
    confirmations: 1,
    timeout: STEALTH_RECEIPT_TIMEOUT_MS,
  });
  let tx = await c.getTransaction({ hash: announceHash });
  verifyStealthAnnouncement(plan, announceHash, tx, receipt);

  const deadline = Date.now() + STEALTH_FINALITY_TIMEOUT_MS;
  while (true) {
    const finalized = await c.getBlock({ blockTag: 'finalized' });
    if (finalized.number !== null && finalized.number >= receipt.blockNumber) {
      // A shallow reorg can invalidate the proof object above while finalized
      // later advances beyond its old height. Re-read the exact proof and bind
      // its block hash to the canonical chain before releasing any ETH.
      [receipt, tx] = await Promise.all([
        c.getTransactionReceipt({ hash: announceHash }),
        c.getTransaction({ hash: announceHash }),
      ]);
      verifyStealthAnnouncement(plan, announceHash, tx, receipt);
      const canonicalBlock = await c.getBlock({ blockNumber: receipt.blockNumber });
      if (!canonicalBlock.hash || !sameHex(canonicalBlock.hash, receipt.blockHash)) {
        throw new Error('stealth announcement receipt is not in the canonical chain');
      }
      // The exact tx can be re-included at a later height after a reorg. That
      // new block must itself become finalized before this function returns.
      const currentFinalized = await c.getBlock({ blockTag: 'finalized' });
      if (currentFinalized.number !== null && currentFinalized.number >= receipt.blockNumber) return;
    }
    if (Date.now() >= deadline) {
      throw new Error('stealth announcement was mined but did not finalize before the safety timeout');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STEALTH_FINALITY_POLL_MS));
  }
}

export function confirmStealthAnnouncement(
  endpoint: string,
  announceHash: `0x${string}`,
  plan: StealthSendPlan,
): Promise<void> {
  return confirmStealthAnnouncementWithClient(
    chainClient(endpoint, 1, 30_000),
    announceHash,
    plan,
  );
}

/** Scan the announcer's logs for payments to us; check balances of matches. */
export async function scanStealthPaymentRange(
  c: LogClient,
  keys: StealthKeys,
  opts: StealthScanOptions = {},
): Promise<StealthScanResult> {
  const head = opts.toBlock ?? await c.getBlockNumber();
  const from = opts.fromBlock ?? ANNOUNCER_DEPLOY_BLOCK;
  const out: StealthPayment[] = [];
  const failedRanges: StealthScanResult['failedRanges'] = [];
  const chunk = opts.chunkBlocks ?? 10_000n; // public RPCs cap getLogs ranges
  for (let start = from; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    let logs;
    try {
      logs = await c.getLogs({
        address: ANNOUNCER,
        event: ANNOUNCEMENT_EVENT,
        args: { schemeId: SCHEME_ID },
        fromBlock: start,
        toBlock: end,
      });
    } catch (e) {
      failedRanges.push({ fromBlock: start, toBlock: end, error: errLine(e) });
      continue;
    }
    for (const log of logs) {
      const { stealthAddress, ephemeralPubKey, metadata } = log.args as {
        stealthAddress: `0x${string}`;
        ephemeralPubKey: `0x${string}`;
        metadata: `0x${string}`;
      };
      if (!stealthAddress || !ephemeralPubKey) continue;
      const priv = checkAnnouncement(keys, stealthAddress, ephemeralPubKey, metadata);
      if (!priv) continue;
      const balanceWei = await c.getBalance({ address: stealthAddress });
      out.push({
        stealthAddress,
        ephemeralPubKey,
        blockNumber: log.blockNumber ?? 0n,
        balanceWei,
        balanceEth: formatEther(balanceWei),
      });
    }
  }
  return { payments: out, fromBlock: from, toBlock: head, complete: failedRanges.length === 0, failedRanges };
}

export async function scanStealthPayments(
  endpoint: string,
  keys: StealthKeys,
  opts: StealthScanOptions = {},
): Promise<StealthPayment[]> {
  const result = await scanStealthPaymentRange(chainClient(endpoint, 1, 30_000), keys, opts);
  if (!result.complete && !opts.allowIncomplete) {
    const first = result.failedRanges[0];
    throw new Error(
      `stealth scan incomplete at blocks ${first.fromBlock}-${first.toBlock}: ${first.error}`,
    );
  }
  return result.payments;
}

/** Sweep a discovered stealth payment to a destination address. */
export async function sweepStealth(
  endpoint: string,
  keys: StealthKeys,
  payment: { stealthAddress: `0x${string}`; ephemeralPubKey: `0x${string}` },
  to: `0x${string}`,
): Promise<`0x${string}`> {
  const priv = checkAnnouncement(keys, payment.stealthAddress, payment.ephemeralPubKey);
  if (!priv) throw new Error('that payment is not ours to sweep');
  const account = privateKeyToAccount(priv);
  const c = chainClient(endpoint, 1);
  const [balance, gasPrice] = await Promise.all([
    c.getBalance({ address: account.address }),
    c.getGasPrice(),
  ]);
  const gasLimit = 21_000n;
  const fee = gasLimit * gasPrice * 12n / 10n; // 20% headroom
  if (balance <= fee) throw new Error('stealth balance too small to cover gas');
  return sendDappTx(endpoint, account, {
    to,
    value: balance - fee,
    gas: toHex(gasLimit),
  }, 1);
}

export function newStealthSendPlan(meta: string, valueWei: bigint): StealthSendPlan {
  if (valueWei <= 0n) throw new Error('stealth send amount must be greater than zero');
  const { stealthAddress, ephemeralPubKey, viewTag } = generateStealthAddress(meta);
  const transfer: DappTxRequest = { to: stealthAddress, value: valueWei };
  const announce: DappTxRequest = { to: ANNOUNCER, data: announceCalldata(stealthAddress, ephemeralPubKey, viewTag) };
  return {
    chainId: 1,
    stealthAddress,
    ephemeralPubKey,
    viewTag,
    valueWei,
    transfer,
    announce,
    transferGas: 0n,
    announceGas: 0n,
    gasPriceWei: 0n,
    totalMaxWei: valueWei,
  };
}

export async function preflightStealthSend(
  endpoint: string,
  from: `0x${string}`,
  meta: string,
  valueWei: bigint,
  plan = newStealthSendPlan(meta, valueWei),
): Promise<StealthSendPlan> {
  if (!parseMetaAddress(meta)) throw new Error('not a stealth meta-address');
  if (plan.valueWei !== valueWei) throw new Error('stealth plan amount changed');
  const c = chainClient(endpoint, 1, 30_000);
  try {
    await c.call({ account: from, to: plan.announce.to, data: plan.announce.data });
    const [transferEstimate, announceEstimate, gasPriceWei, fees, balance, nonce] = await Promise.all([
      c.estimateGas({ account: from, to: plan.transfer.to, value: valueWei }),
      c.estimateGas({ account: from, to: plan.announce.to, data: plan.announce.data }),
      c.getGasPrice(),
      c.estimateFeesPerGas(),
      c.getBalance({ address: from }),
      c.getTransactionCount({ address: from, blockTag: 'pending' }),
    ]);
    const transferGas = withGasHeadroom(transferEstimate);
    const announceGas = withGasHeadroom(announceEstimate);
    const maxFeePerGas = fees.maxFeePerGas ?? gasPriceWei;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
    const feeCap = maxFeePerGas > maxPriorityFeePerGas ? maxFeePerGas : maxPriorityFeePerGas;
    const totalMaxWei = valueWei + ((transferGas + announceGas) * feeCap);
    if (balance < totalMaxWei) {
      throw new Error(
        `not enough ETH for stealth send plus both gas payments: need ${formatEther(totalMaxWei)} ETH`,
      );
    }
    const pinned: StealthSendPlan = {
      ...plan,
      from,
      transferGas,
      announceGas,
      gasPriceWei,
      totalMaxWei,
      announce: {
        ...plan.announce,
        from,
        nonce,
        gas: toHex(announceGas),
        maxFeePerGas: toHex(feeCap),
        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
      },
      transfer: {
        ...plan.transfer,
        from,
        nonce: nonce + 1,
        gas: toHex(transferGas),
        maxFeePerGas: toHex(feeCap),
        maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
      },
    };
    validateStealthSendPlan(pinned, from);
    return pinned;
  } catch (e) {
    throw new Error(`stealth preflight failed: ${errLine(e)}`);
  }
}

export async function broadcastStealthPlan(
  plan: StealthSendPlan,
  send: (tx: DappTxRequest) => Promise<`0x${string}`>,
  confirm: (announceHash: `0x${string}`, plan: StealthSendPlan) => Promise<void>,
): Promise<StealthSendResult> {
  validateStealthSendPlan(plan);
  const announceHash = await send(plan.announce);
  try {
    await confirm(announceHash, plan);
  } catch (e) {
    return {
      status: 'announcement_unconfirmed',
      announceHash,
      confirmationError: errLine(e),
      stealthAddress: plan.stealthAddress,
      plan,
    };
  }
  try {
    const transferHash = await send(plan.transfer);
    return { status: 'sent', transferHash, announceHash, stealthAddress: plan.stealthAddress, plan };
  } catch (e) {
    return {
      status: 'transfer_failed',
      announceHash,
      transferError: errLine(e),
      stealthAddress: plan.stealthAddress,
      plan,
    };
  }
}

export async function announceStealthPlan(
  endpoint: string,
  sender: SignerAccount,
  plan: StealthSendPlan,
): Promise<`0x${string}`> {
  validateStealthSendPlan(plan, sender.address);
  return sendDappTx(endpoint, sender, plan.announce, 1);
}

export async function transferStealthPlan(
  endpoint: string,
  sender: SignerAccount,
  plan: StealthSendPlan,
  announceHash: `0x${string}`,
): Promise<`0x${string}`> {
  validateStealthSendPlan(plan, sender.address);
  // This primitive is safe on its own: callers cannot accidentally release
  // the transfer merely by forgetting the UI-level confirmation step.
  await confirmStealthAnnouncement(endpoint, announceHash, plan);
  return sendDappTx(endpoint, sender, plan.transfer, 1);
}
