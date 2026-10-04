/**
 * App state. One store, signal-based, no framework magic.
 * Keys live behind the session boundary (see session.ts): in the extension
 * that's the background service worker; in the PWA it's page memory.
 * The only thing ever persisted is the encrypted vault + non-secret prefs.
 */
import { signal, computed } from '@preact/signals';
import {
  type VaultBlob,
  type WalletAccount,
  type TokenBalance,
  type RpcPoolState,
  type NftHolding,
  type KnownToken,
  type KnownCollection,
  newMnemonic,
  validateMnemonic,
  normalizePrivateKey,
  endpointFor,
  rotate,
  retireEndpoints,
  sweepChains,
  withRadBalance,
  withFailover,
  scanCollections,
  mergeTrackedTokens,
  normalizeContract,
  registerCustomChain,
  unregisterCustomChain,
  replaceCustomChains,
  probeToken,
  probeCollection,
  lookupEns,
  chainClient,
  CHAINS,
  CHAIN_IDS,
  SCAN_CHAIN_IDS,
  TESTNET_CHAIN_IDS,
  COLLECTIONS,
  TOKENS,
  INDEXER_OFF,
  PRICEFEED_OFF,
  DEXCHART_OFF,
  type IndexerConfig,
  type PriceFeedConfig,
  type DexChartConfig,
  type CustomChainConfig,
  type PortfolioGrouping,
  type PortfolioHolding,
  type SpotPrice,
  discoverAssets,
  readTokens,
  spotPricesInEth,
  usdPerEth,
  valueInEth,
  valueWalletSnapshots,
  valueWithPrices,
  portfolioAssetId,
  usd,
  demoBalances,
  demoTestnetBalances,
  demoNfts,
  demoBlockNumber,
  simulateTx,
  openVault,
} from '@radwallet/core';
import {
  session, onRemoteLocked, type SessionStatus, type SessionWrite, type VaultInit,
} from './session.js';
import {
  IS_EXTENSION, HAS_SIDEBAR, CAN_REBIND_ACTION,
  primeSidebar, openSidebar, closeSidebar, setActionOpensSidebar, publishWalletChainSelection,
} from './ext.js';
import { kv, readVault, writeVault, requestPersistence } from './storage.js';
import { savedContacts, loadAddressBook, saveContact, type AddressBookContact } from './addressbook.js';
import { loadWalletList, forgetWalletGroupLayout, resetWalletList } from './wallet-list.js';
import { updateStatus } from './history.js';
import { readBalanceSnapshot, writeBalanceSnapshot, pruneBalanceSnapshots } from './balancecache.js';
import { trackTokensForSettledReceipt, type SwapTrackToken } from './swaptrack.js';
import {
  IS_NATIVE, biometricAvailable, biometricEnable, biometricUnlock, biometricDisable,
  type SealedSecret,
} from './native.js';

export type Screen =
  | 'welcome'
  | 'create'
  | 'import'
  | 'unlock'
  | 'home'
  | 'portfolio'
  | 'swap'
  | 'settings'
  | 'activity'
  | 'nfts'
  | 'approve';

/**
 * The overlays that are not screens.
 *
 * SEND and RECEIVE used to be full screens carrying their own "← back", while
 * SWAP — the third thing in the same action row — was a tab-bar screen with no
 * back link at all. Same shape, two ways out, and the two that behaved
 * differently were the two people use most. They are sheets now, closing the
 * way every other sheet in this wallet closes: header [X], Esc, backdrop.
 */
export type Sheet = 'send' | 'receive' | 'tokenlist';
export const sheet = signal<Sheet | null>(null);
export function closeSheet(): void { sheet.value = null; }

/** set when this window was opened by the background SW to approve a dapp request */
export const approveMode =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('approve');

/** set when this page is the docked side panel / sidebar, not the popup */
export const panelMode =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('panel');

// ---- environment ----------------------------------------------------------
export const DEMO = import.meta.env?.VITE_DEMO === '1';

/** every persisted read and write in the UI goes through the storage boundary */
const storage = kv;

// ---- signals --------------------------------------------------------------
export const screen = signal<Screen>('welcome');
export const vaultBlob = signal<VaultBlob | null>(null);
export const accounts = signal<WalletAccount[]>([]);
export type AddressBookEntry = AddressBookContact & { owned: boolean };
/** Vault names stay authoritative; never persist a second copy of owned wallets. */
export const addressBook = computed(() => {
  const entries = new Map<string, AddressBookEntry>();
  for (const wallet of accounts.value) {
    const key = wallet.address.toLowerCase();
    if (!entries.has(key)) entries.set(key, { address: wallet.address, label: wallet.label, owned: true });
  }
  for (const contact of savedContacts.value) {
    const key = contact.address.toLowerCase();
    if (!entries.has(key)) entries.set(key, { ...contact, owned: false });
  }
  return entries;
});
export function addressBookEntry(address: string): AddressBookEntry | undefined {
  return addressBook.value.get(address.trim().toLowerCase());
}
export async function saveAddressContact(address: string, label: string): Promise<void> {
  if (addressBookEntry(address)?.owned) throw new Error('rename your wallet in the wallets list');
  await saveContact(address, label);
}
export const selected = signal(0);
export const chainId = signal(1);
export const ensName = signal<string | null>(null);
/** ERC-5564 meta-address per seed group; loose keys are absent by design */
export const stealthMetas = signal<Record<string, string>>({});
/** every label the user has attached to a wallet */
export const knownLabels = signal<string[]>([]);
/** wallet picker: only show wallets carrying this label */
export const labelFilter = signal<string | null>(null);
/** wallet picker open/closed */
export const pickerOpen = signal(false);
/** the NFT collection whose contents are open, if any */
export const openNft = signal<NftHolding | null>(null);
/** the token whose detail sheet is open, if any */
export const openAsset = signal<TokenBalance | null>(null);
/** which asset SWAP should start from, set when you swap from an asset row */
export const swapIntent = signal<
  { chainId: number; address: `0x${string}` | null; symbol: string; decimals: number } | null
>(null);
/** Optional asset preselection when SEND is opened from a balance/NFT row. */
export type SendIntent =
  | { kind: 'native'; chainId: number }
  | {
    kind: 'erc20'; chainId: number; address: `0x${string}`; symbol: string;
    name: string; decimals: number; balanceRaw: bigint; balance: string;
  }
  | {
    kind: 'erc721'; chainId: number; address: `0x${string}`; symbol: string;
    name: string; tokenId: string;
  };
export const sendIntent = signal<SendIntent | null>(null);

/**
 * Open the SEND sheet, optionally aimed at one asset.
 *
 * The chain comes with the asset, never from whatever the wallet happens to be
 * switched to: a Base token opened from the list is a Base send.
 */
export function openSend(intent: SendIntent | null = null): void {
  sendIntent.value = intent;
  if (intent) setChain(intent.chainId);
  sheet.value = 'send';
}
export function openReceive(): void { sheet.value = 'receive'; }
export function openTokenList(): void { sheet.value = 'tokenlist'; }
export { CHAINS };

/**
 * Networks the wallet owner added locally. They live beside the owner-edited
 * RPC pools, never in a dapp request or an online chain list. A fresh Anvil is
 * marked testnet by default, so its freely minted ETH cannot become a dollar
 * total just because a development node happened to be selected.
 */
export const customNetworks = signal<CustomChainConfig[]>([]);

export async function addCustomNetwork(raw: unknown): Promise<CustomChainConfig> {
  const config = registerCustomChain(raw);
  if (!config) throw new Error('that chain is already built in, already added, or has invalid network details');
  customNetworks.value = [...customNetworks.value, config];
  poolsAll.value = {
    ...poolsAll.value,
    [config.id]: { endpoints: [config.endpoint], epoch: 0 },
  };
  chainId.value = config.id;
  await persistPrefs();
  publishWalletChainSelection(config.id);
  say(`network: ${config.name}. your node, your rules.`);
  tickBlocks();
  void refresh();
  return config;
}

export async function removeCustomNetwork(id: number): Promise<void> {
  const network = customNetworks.value.find((candidate) => candidate.id === id);
  if (!network || !unregisterCustomChain(id)) return;
  const wasSelected = chainId.value === id;
  if (wasSelected) chainId.value = 1;
  customNetworks.value = customNetworks.value.filter((candidate) => candidate.id !== id);
  const nextPools = { ...poolsAll.value };
  delete nextPools[id];
  poolsAll.value = nextPools;
  await persistPrefs();
  if (wasSelected) publishWalletChainSelection(chainId.value);
  say(`${network.name} removed from this wallet.`);
  tickBlocks();
  void refresh();
}

function defaultPools(): Record<number, RpcPoolState> {
  const out: Record<number, RpcPoolState> = {};
  for (const id of CHAIN_IDS) out[id] = { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 };
  return out;
}
export const poolsAll = signal<Record<number, RpcPoolState>>(defaultPools());
export const pool = computed<RpcPoolState>(
  () => poolsAll.value[chainId.value] ?? { endpoints: [...CHAINS[chainId.value].defaultEndpoints], epoch: 0 },
);
export function updatePool(next: RpcPoolState): void {
  updatePoolFor(chainId.value, next);
}
/**
 * Every chain has its own pool, and SETTINGS can edit any of them without
 * making you switch networks first — the panel used to follow the network
 * selector, so the other chains' endpoints looked like they did not exist.
 */
export function updatePoolFor(id: number, next: RpcPoolState): void {
  poolsAll.value = { ...poolsAll.value, [id]: next };
  void persistPrefs();
}
export function poolFor(id: number): RpcPoolState {
  return poolsAll.value[id] ?? { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 };
}
export const balances = signal<TokenBalance[]>([]);
/** NFT holdings across the scanned chains */
export const nfts = signal<NftHolding[]>([]);
/** per-chain sweep failures, so a dead RPC is visible instead of silent */
export const sweepErrors = signal<Record<number, string>>({});
/**
 * Why the NFT scan came back empty, if it did. An empty collectibles list and
 * a failed scan look identical on screen, and one of those means "you own
 * nothing" while the other means "we could not find out".
 */
export const nftError = signal<string | null>(null);
/** dollars per ETH, read from a USDC pool on your own RPC. null = no pools */
export const usdRate = signal<number | null>(null);
/** this wallet's holdings valued in ETH; null until priced */
export const portfolioEth = signal<number | null>(null);
/**
 * Each holding's worth in ETH, keyed by chain and contract.
 *
 * `valueInEth` already computes this on every refresh and the total used to
 * throw it away, so showing a per-row figure costs no extra request. Keyed by
 * CONTRACT, never by symbol: two contracts on one chain can share a symbol
 * (Robinhood has two USDG), and keying by symbol would price one row with the
 * other's number.
 */
export const assetEth = signal<Record<string, number>>({});

/** how a holding is identified in `assetEth` */
export function assetKey(chainId: number, address?: `0x${string}` | null): string {
  return `${chainId}:${address ? address.toLowerCase() : 'native'}`;
}
/** every wallet's value in ETH, filled on demand when the drawer opens */
export const walletValues = signal<Record<string, number>>({});
export const valuingWallets = signal(false);
export const walletValueProgress = signal<string | null>(null);
export const portfolioHoldings = signal<PortfolioHolding[]>([]);
export const portfolioUpdatedAt = signal<number | null>(null);
export const portfolioErrors = signal<Record<string, string>>({});
export const portfolioStale = signal(true);

export interface PortfolioSettings {
  active: boolean;
  currency: 'usd' | 'eth';
  groupBy: PortfolioGrouping;
  excludedWallets: string[];
  excludedAssets: string[];
  excludedChains: number[];
}

const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  active: false,
  currency: 'usd',
  groupBy: 'assets',
  excludedWallets: [],
  excludedAssets: [],
  excludedChains: [],
};

export const portfolioSettings = signal<PortfolioSettings>({ ...DEFAULT_PORTFOLIO_SETTINGS });
/**
 * The address whose LIVE sweep is on screen, '' while the rows are a cached
 * snapshot or nothing. A cache read that lands after the chain has answered
 * must not put yesterday's rows back over today's.
 */
let liveAddress = '';
let portfolioEpoch = 0;
/** extra scan targets learned from swaps or pasted by the user; always on-device */
export const customTokens = signal<Record<number, KnownToken[]>>({});
export const customCollections = signal<Record<number, KnownCollection[]>>({});
export const blockNumber = signal<bigint>(0n);
export const busy = signal<string | null>(null);
export const toast = signal<string | null>(null);
export const toastTransaction = signal<{ chainId: number; hash: string } | null>(null);
export const prefs = signal({
  rotateRpc: true, simulate: true, freshAddress: true, autoLockMin: 15,
  /** wallet docked into the browser's side panel / sidebar instead of the popup */
  docked: false,
  /** OFF by default: an indexer sees every address you own — see indexer.ts */
  indexer: INDEXER_OFF as IndexerConfig,
  /** whole-UI zoom, 1 = as designed. Courier runs small and screens differ. */
  uiScale: 1,
  /** fetching NFT art means asking whoever hosts it; off until asked */
  loadArt: false,
  /** OFF: price history comes from someone else's server — see pricefeed.ts */
  priceFeed: PRICEFEED_OFF as PriceFeedConfig,
  /** OFF: hosted quotes disclose the pair, size, signer address and IP. */
  aggregator: { enabled: false },
  /**
   * OFF: load the embedded DEX chart without asking each time. An iframe runs
   * someone else's code inside the wallet, which is a bigger ask than any
   * fetch — see dexchart.ts.
   */
  dexChart: DEXCHART_OFF as DexChartConfig,
  /**
   * OFF: sweep the testnets too, and list what they hold. Test ETH is free, so
   * it is never summed into a balance and never priced — it gets its own
   * section under the real chains. Off by default because three more chains is
   * three more endpoints learning your address for money that isn't money.
   */
  testnets: false,
});

export const account = computed<WalletAccount | null>(
  () => accounts.value[selected.value] ?? null,
);
/**
 * What balance-driven UI may show. The raw sweep stays untouched so pricing,
 * ownership and signing never mistake the zero `$RAD` fallback for chain
 * state; HOME and RADSWAP still get the permanent house-token row.
 */
export const visibleBalances = computed<TokenBalance[]>(
  () => account.value ? withRadBalance(balances.value) : balances.value,
);
export const endpoint = computed(() =>
  account.value ? endpointFor(pool.value, account.value.address) : pool.value.endpoints[0],
);
export const unlocked = computed(() => accounts.value.length > 0);

/** the selected wallet's stealth meta-address — null for an imported key */
export const stealthMeta = computed<string | null>(() => {
  const a = account.value;
  return a && a.kind === 'hd' ? stealthMetas.value[a.groupId] ?? null : null;
});

export interface WalletGroup {
  id: string;
  label: string;
  kind: 'seed' | 'imported';
  members: WalletAccount[];
}

/** accounts folded into their groups, in flat-list order */
export const groups = computed<WalletGroup[]>(() => {
  const out: WalletGroup[] = [];
  for (const a of accounts.value) {
    let g = out.find((x) => x.id === a.groupId);
    if (!g) {
      g = { id: a.groupId, label: a.groupLabel, kind: a.kind === 'hd' ? 'seed' : 'imported', members: [] };
      out.push(g);
    }
    g.members.push(a);
  }
  return out;
});

/** the same groups with the label filter applied; empty groups drop out */
export const filteredGroups = computed<WalletGroup[]>(() => {
  const f = labelFilter.value;
  if (!f) return groups.value;
  return groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => m.labels.includes(f)) }))
    .filter((g) => g.members.length > 0);
});

/**
 * How long a toast stays up.
 *
 * It was a flat 4s, which is two different bugs at once: plenty for "address
 * copied", and not enough to finish reading "key imported. it is NOT covered
 * by your seed phrase backup." — so the messages that matter most were the
 * ones that vanished mid-sentence. Time to NOTICE it plus time to READ it,
 * bounded at both ends so a one-word confirmation still feels instant and a
 * long RPC error does not camp on the screen.
 */
function dwell(msg: string): number {
  const words = msg.trim().split(/\s+/).length;
  return Math.min(12_000, Math.max(5_000, 2_000 + words * 500));
}

/**
 * Which toast is current. Comparing the TEXT instead meant that saying the
 * same thing twice let the first timer clear the second one early — rare, but
 * it is exactly the repeated-action case (copy, copy) where it would show.
 */
let toastSeq = 0;

export function say(msg: string): void {
  const seq = ++toastSeq;
  toast.value = msg;
  toastTransaction.value = null;
  setTimeout(() => {
    if (toastSeq === seq) {
      toast.value = null;
      toastTransaction.value = null;
    }
  }, dwell(msg));
}

/** dismiss the current toast early — clicking it is faster than waiting */
export function hush(): void {
  toastSeq++;
  toast.value = null;
  toastTransaction.value = null;
}

/**
 * Every way the keys can go away lands here: the auto-lock timer, and the
 * background being torn down under us (MV3 idles it out, an add-on reload
 * restarts it). Showing an unlocked wallet that cannot sign anything is a lie,
 * so the screen goes where the truth is.
 */
function dropToUnlock(why: string): void {
  if (screen.value === 'unlock' || screen.value === 'welcome') return;
  accounts.value = [];
  balances.value = [];
  assetEth.value = {};
  portfolioEth.value = null;
  clearPortfolioSnapshot();
  liveAddress = '';
  pickerOpen.value = false;
  // a sheet floating over the unlock screen would be a wallet claiming a
  // session it no longer has
  sheet.value = null;
  openAsset.value = null;
  openNft.value = null;
  screen.value = vaultBlob.value ? 'unlock' : 'welcome';
  say(why);
}

session.onAutoLock = () => dropToUnlock('auto-locked. the vault waits for no one.');

// the background answered 'locked' — it idled out or the extension reloaded
onRemoteLocked(() =>
  dropToUnlock('the background dropped your keys (it sleeps when idle). unlock again — nothing is lost.'),
);

function clearPortfolioSnapshot(): void {
  portfolioEpoch++;
  portfolioHoldings.value = [];
  portfolioUpdatedAt.value = null;
  portfolioErrors.value = {};
  portfolioStale.value = true;
}

export function markPortfolioStale(): void {
  portfolioEpoch++;
  portfolioStale.value = true;
}

function portfolioSnapshotFresh(epoch: number): boolean {
  return portfolioEpoch === epoch;
}

function accountsFingerprint(list: WalletAccount[]): string {
  return list.map((a) => `${a.address.toLowerCase()}:${a.groupId}:${a.label}`).join('|');
}

function screenAfterUnlock(): Screen {
  return !approveMode && portfolioSettings.value.active ? 'portfolio' : approveMode ? 'approve' : 'home';
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean))];
}

function cleanPortfolioSettings(raw: unknown): PortfolioSettings {
  const p = raw && typeof raw === 'object' ? raw as Partial<PortfolioSettings> : {};
  const groupBy: PortfolioGrouping = p.groupBy === 'wallets' || p.groupBy === 'groups' ? p.groupBy : 'assets';
  return {
    active: p.active === true,
    currency: p.currency === 'eth' ? 'eth' : 'usd',
    groupBy,
    excludedWallets: cleanStrings(p.excludedWallets),
    excludedAssets: cleanStrings(p.excludedAssets),
    excludedChains: Array.isArray(p.excludedChains)
      ? [...new Set(p.excludedChains.map(Number).filter((id) => CHAIN_IDS.includes(id)))]
      : [],
  };
}

export async function hydratePortfolioSettings(): Promise<void> {
  await portfolioSettingsWrite;
  const raw = await storage.get('portfolioSettings');
  if (!raw) return;
  try {
    portfolioSettings.value = cleanPortfolioSettings(JSON.parse(raw));
  } catch {
    portfolioSettings.value = { ...DEFAULT_PORTFOLIO_SETTINGS };
  }
}

let portfolioSettingsWrite: Promise<void> = Promise.resolve();

export function setPortfolioSettings(patch: Partial<PortfolioSettings>): void {
  const next = cleanPortfolioSettings({ ...portfolioSettings.value, ...patch });
  portfolioSettings.value = next;
  portfolioSettingsWrite = portfolioSettingsWrite
    .catch(() => {})
    .then(() => storage.set('portfolioSettings', JSON.stringify(next)))
    .catch(sayError);
}

/**
 * Show an error to the user. 'locked' is not a message anyone can act on —
 * dropToUnlock has already said the useful version — so it never reaches a
 * toast on its own.
 */
export function sayError(e: unknown): void {
  const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  if (msg === 'locked') return;
  // the vault throws a CODE so callers can branch on it; a person reading a
  // toast should get the sentence, not the constant
  if (msg === 'WRONG_PASSWORD') { say('wrong password, bro'); return; }
  // AES-GCM refuses an unsupported vault exactly the way it refuses a wrong
  // password. Saying "wrong password" to someone whose wallet is merely too new
  // is how a person concludes their funds are gone and starts typing their seed
  // phrase into whatever asks for it.
  if (msg === 'VAULT_UNSUPPORTED') {
    say('this vault was written by a newer radwallet. update the wallet — your password is fine.');
    return;
  }
  if (msg === 'VAULT_CORRUPT') { say('the vault file is damaged. restore using your backed-up seed phrases and imported private keys.'); return; }
  // a cancelled fingerprint prompt is a decision, not a failure — say nothing
  if (msg === 'BIOMETRIC_CANCELLED') return;
  if (msg === 'BIOMETRIC_KEY_GONE') {
    say('a new fingerprint or face was added to this phone, so biometric unlock was switched off. your password still works.');
    return;
  }
  say(msg);
}

/**
 * A popup re-boots every time you open it, so it can never drift. A docked
 * sidebar stays open for hours while the background sleeps behind it — so
 * re-check the session whenever this page comes back to the foreground.
 */
let sessionRevalidation: Promise<void> | null = null;

export function revalidateSession(): Promise<void> {
  if (!IS_EXTENSION || !unlocked.value) return Promise.resolve();
  if (sessionRevalidation) return sessionRevalidation;
  sessionRevalidation = (async () => {
    await hydratePortfolioSettings();
    const st = await session.status().catch(() => null);
    if (st && st.locked) {
      dropToUnlock('the background dropped your keys while you were away. unlock again.');
      return;
    }
    // Visibility and focus usually arrive as a pair. Keep that pair to one
    // session check and one privacy-preserving balance sweep.
    if (st) await refresh();
  })().finally(() => { sessionRevalidation = null; });
  return sessionRevalidation;
}

// ---- persistence ----------------------------------------------------------
export async function boot(): Promise<void> {
/**
 * Prefs written by an older build. The indexer used to be ONE provider with one
 * key (`{ provider, key }`); it is now a rotated list, and a stored key must
 * survive the upgrade rather than silently switching itself off.
 */
function migratePrefs(raw: unknown): Record<string, unknown> {
  const p = { ...(raw as Record<string, unknown>) };
  if (typeof p.autoLockMin !== 'number' || !Number.isInteger(p.autoLockMin)
    || p.autoLockMin < 1 || p.autoLockMin > 240) p.autoLockMin = 15;
  const idx = p.indexer as (Partial<IndexerConfig> & { provider?: string; key?: string }) | undefined;
  if (idx && !Array.isArray(idx.entries)) {
    const provider = idx.provider === 'moralis' || idx.provider === 'blockscout'
      ? idx.provider
      : 'alchemy';
    p.indexer = {
      enabled: idx.enabled === true,
      entries: idx.key ? [{ provider, key: idx.key }] : [],
    } satisfies IndexerConfig;
  }
  return p;
}

/**
 * ArrowRPC's Robinhood tunnel now answers every JSON-RPC method with
 * Cloudflare 530/1033. Remove it from saved pools as well as new defaults,
 * while leaving every user-added endpoint untouched.
 */
function migratePools(raw: unknown): Record<number, RpcPoolState> {
  const saved = raw as Record<number, RpcPoolState>;
  const migrated = { ...saved };
  const robinhood = saved[4663];
  if (robinhood?.endpoints) {
    migrated[4663] = retireEndpoints(
      robinhood,
      ['https://rpc.arrowrpc.com'],
      CHAINS[4663].defaultEndpoints,
    );
  }
  return migrated;
}

  const [v, p, pr, ch, ct, cc, cn, sel, portfolio] = await Promise.all([
    readVault(),
    storage.get('pools'),
    storage.get('prefs'),
    storage.get('chainId'),
    storage.get('customTokens'),
    storage.get('customCollections'),
    storage.get('customNetworks'),
    storage.get('selectedAddress'),
    storage.get('portfolioSettings'),
    loadAddressBook().catch(() => { say('address book could not be loaded'); }),
    loadWalletList().catch(() => { say('wallet list layout could not be loaded'); }),
  ]);
  // read BEFORE applyStatus, which is what turns it back into an index
  wantedAddress = (sel ?? '').toLowerCase();
  try { if (ct) customTokens.value = JSON.parse(ct); } catch { /* keep defaults */ }
  try { if (cc) customCollections.value = JSON.parse(cc); } catch { /* keep defaults */ }
  let customNetworkConfigs: CustomChainConfig[] = [];
  try { customNetworkConfigs = replaceCustomChains(cn ? JSON.parse(cn) : []); } catch { /* discard malformed local network data */ }
  customNetworks.value = customNetworkConfigs;
  const savedPools = p ? migratePools(JSON.parse(p)) : {};
  const customPools = Object.fromEntries(customNetworkConfigs.map((network) => [
    network.id,
    savedPools[network.id]?.endpoints?.length
      ? savedPools[network.id]
      : { endpoints: [network.endpoint], epoch: 0 },
  ]));
  poolsAll.value = { ...poolsAll.value, ...savedPools, ...customPools };
  if (p || cn) void storage.set('pools', JSON.stringify(poolsAll.value));
  if (cn && JSON.stringify(customNetworkConfigs) !== cn) {
    void storage.set('customNetworks', JSON.stringify(customNetworkConfigs));
  }
  if (pr) prefs.value = { ...prefs.value, ...migratePrefs(JSON.parse(pr)) };
  if (portfolio) {
    try { portfolioSettings.value = cleanPortfolioSettings(JSON.parse(portfolio)); } catch { /* keep defaults */ }
  }
  if (ch && CHAIN_IDS.includes(Number(ch))) chainId.value = Number(ch);
  vaultBlob.value = v.blob;
  // a vault that would not parse is not a vault that is gone: `vaultPrev` holds
  // the copy before the last write, and saying nothing here would let someone
  // keep using a wallet that is quietly one write out of date
  if (v.recovered) {
    say('the stored vault was unreadable — restored the previous copy. a wallet added in the last write may be missing.');
  }

  // the background session may already be unlocked (extension)
  const st = await session.status().catch(() => null);
  if (st && !st.locked) {
    applyStatus(st);
    screen.value = screenAfterUnlock();
    // last known rows first, so the popup never opens on an empty list
    if (!approveMode && account.value) void hydrateBalances(account.value.address);
    // The approval window shows no balances, so it does not sweep or price:
    // that burst is pointless work on a popup that renders none of it, and it
    // saturates the browser's per-origin sockets to the user's node at the
    // exact moment the window may need them to simulate and sign (measured
    // against an Anvil fork: a transaction send timed out behind it).
    if (!approveMode) void refresh();
  } else if (vaultBlob.value) {
    screen.value = 'unlock';
  } else {
    screen.value = 'welcome';
  }
  primeSidebar();
  tickBlocks();
  void loadBiometrics();
}

// ---- docking --------------------------------------------------------------
/** the side panel (Chrome) / sidebar (Firefox) is an extension-only trick */
export const canDock = IS_EXTENSION && HAS_SIDEBAR;

/**
 * Open the wallet as a sidebar and remember that choice. Must be called
 * straight from a click — both browsers require a user gesture, so the
 * open() call happens before anything that could await.
 */
export function dock(): void {
  openSidebar();
  prefs.value = { ...prefs.value, docked: true };
  void persistPrefs();
  if (CAN_REBIND_ACTION) void setActionOpensSidebar(true);
}

/** Back to the popup. */
export function undock(): void {
  prefs.value = { ...prefs.value, docked: false };
  void persistPrefs();
  if (CAN_REBIND_ACTION) void setActionOpensSidebar(false);
  if (!closeSidebar()) {
    say('toolbar button goes back to the popup — close this panel with the browser\'s ✕');
  }
}

/**
 * Write the vault through the boundary, which keeps the copy it replaces.
 * Asking for persistent storage waits until here on purpose — there is no
 * point prompting a PWA user to keep data they have not created yet.
 */
async function persistVault(): Promise<void> {
  if (!vaultBlob.value) return;
  await writeVault(vaultBlob.value);
  void requestPersistence();
}
export async function persistPrefs(): Promise<void> {
  await storage.set('prefs', JSON.stringify(prefs.value));
  await storage.set('customTokens', JSON.stringify(customTokens.value));
  await storage.set('customCollections', JSON.stringify(customCollections.value));
  await storage.set('customNetworks', JSON.stringify(customNetworks.value));
  await storage.set('pools', JSON.stringify(poolsAll.value));
  await storage.set('chainId', String(chainId.value));
  await storage.set('selectedAddress', accounts.value[selected.value]?.address ?? '');
  // legacy key some background paths read for the active chain's endpoint
  await storage.set('pool', JSON.stringify(pool.value));
}

export async function updateAutoLock(minutes: number): Promise<void> {
  await session.setAutoLock(minutes);
  prefs.value = { ...prefs.value, autoLockMin: minutes };
  await persistPrefs();
}

/** jump straight to a chain (the dropdown); switchChain still cycles */
export function setChain(id: number): void {
  if (!CHAIN_IDS.includes(id) || id === chainId.value) return;
  chainId.value = id;
  void persistPrefs();
  publishWalletChainSelection(id);
  say(`network: ${CHAINS[id].name}. same rules everywhere.`);
  tickBlocks();
  void refresh();
}

/** Adopt a chain already persisted by the extension background. */
export function adoptChain(id: number): void {
  if (!CHAIN_IDS.includes(id) || id === chainId.value) return;
  chainId.value = id;
  tickBlocks();
  void refresh();
}

export function switchChain(dir: 1 | -1): void {
  const i = CHAIN_IDS.indexOf(chainId.value);
  chainId.value = CHAIN_IDS[(i + dir + CHAIN_IDS.length) % CHAIN_IDS.length];
  void persistPrefs();
  publishWalletChainSelection(chainId.value);
  say(`network: ${CHAINS[chainId.value].name}. same rules everywhere.`);
  tickBlocks();
  void refresh();
}

// ---- wallet lifecycle -----------------------------------------------------
/** fold a session status into the signals */
function applyStatus(st: SessionStatus): void {
  const before = accountsFingerprint(accounts.value);
  accounts.value = st.accounts;
  stealthMetas.value = st.stealthMetas;
  knownLabels.value = st.labels;
  if (labelFilter.value && !st.labels.includes(labelFilter.value)) labelFilter.value = null;
  /*
    WHICH WALLET IS SELECTED IS SHARED STATE, and it is stored as an ADDRESS.
    Every extension page boots its own copy of this store — the popup, the
    docked panel, and the approval window are three separate pages — so a
    selection kept only in memory meant each of them started on wallet 1. The
    approval window then compared the site's `from` against the wrong wallet
    and announced a mismatch that was not real.
    An address rather than an index, because indexes shift the moment a wallet
    is added or forgotten, and a stale index silently points at someone else.
  */
  if (wantedAddress) {
    const at = st.accounts.findIndex((a) => a.address.toLowerCase() === wantedAddress);
    if (at >= 0) selected.value = at;
  }
  if (selected.value > st.accounts.length - 1) selected.value = Math.max(0, st.accounts.length - 1);
  const after = accountsFingerprint(accounts.value);
  if (before && before !== after) clearPortfolioSnapshot();
}

/** the address last selected, read from storage at boot; '' until then */
let wantedAddress = '';

/**
 * Apply a vault-mutating call: the session hands back the re-sealed blob, we
 * persist it. Sealing lives behind the session boundary; this side never sees
 * a key.
 */
async function applyWrite(w: SessionWrite): Promise<void> {
  vaultBlob.value = w.vault;
  await persistVault();
  applyStatus(w.status);
  // a forgotten wallet leaves no cached rows behind
  void pruneBalanceSnapshots(accounts.value.map((a) => a.address)).catch(() => {});
  // adding or renaming a wallet changes what is on screen, so re-read it.
  // Nobody should have to press refresh to see a wallet they just made.
  void refresh();
  // per-wallet values in the drawer are now stale by definition
  walletValues.value = {};
  clearPortfolioSnapshot();
}

export async function createWallet(password: string): Promise<string> {
  const mnemonic = newMnemonic();
  // stays on the create screen: the seed backup step is not skippable
  await newVault({ mnemonic }, password, false);
  return mnemonic;
}

export async function importWallet(mnemonic: string, password: string): Promise<void> {
  if (!validateMnemonic(mnemonic)) throw new Error('that is not a valid seed phrase, bro');
  await newVault({ mnemonic: mnemonic.trim().toLowerCase() }, password, true);
}

/** first-run import of a bare private key: a vault with one loose key and no seed */
export async function importKeyAsWallet(key: string, password: string): Promise<void> {
  await newVault({ privateKey: normalizePrivateKey(key) }, password, true);
}

async function newVault(init: VaultInit, password: string, navigate: boolean): Promise<void> {
  busy.value = 'sealing vault (600k rounds)…';
  try {
    await applyWrite(await session.create(init, password, prefs.value.autoLockMin));
    await resetWalletList().catch(sayError);
    selected.value = 0;
    if (navigate) screen.value = approveMode ? 'approve' : 'home';
    if (!approveMode) void refresh();
  } finally {
    busy.value = null;
  }
}

export async function unlock(password: string): Promise<void> {
  if (!vaultBlob.value) return;
  busy.value = 'opening vault…';
  try {
    applyStatus(await session.unlock(vaultBlob.value, password, prefs.value.autoLockMin));
    await restoreLegacyAccountCount();
    screen.value = screenAfterUnlock();
    if (!approveMode && account.value) void hydrateBalances(account.value.address);
    if (!approveMode) void refresh();
  } finally {
    busy.value = null;
  }
}

/**
 * Pre-multi-wallet PWA installs never re-sealed the vault when you revealed an
 * account — they mirrored the count in localStorage instead. Fold that back in
 * once, then retire the key; the vault carries it from here.
 * (The extension's background does the same thing at unlock for its own store.)
 */
async function restoreLegacyAccountCount(): Promise<void> {
  if (IS_EXTENSION) return;
  const want = Number((await storage.get('accountCount')) ?? '0');
  if (!want) return;
  const gid = groups.value.find((g) => g.kind === 'seed')?.id;
  if (gid) {
    while ((groups.value.find((g) => g.id === gid)?.members.length ?? want) < want) {
      await applyWrite(await session.addAccount(gid));
    }
  }
  await storage.set('accountCount', '0');
}

// ---- biometrics -----------------------------------------------------------
/** the sealed password, if the user turned biometric unlock on */
export const bioSealed = signal<SealedSecret | null>(null);
/** what the phone says about biometrics — the reason is shown when it says no */
export const bioReady = signal<{ available: boolean; reason: string }>({ available: false, reason: '' });

export async function loadBiometrics(): Promise<void> {
  if (!IS_NATIVE) return;
  bioReady.value = await biometricAvailable();
  const raw = await kv.get('bio');
  try { bioSealed.value = raw ? (JSON.parse(raw) as SealedSecret) : null; } catch { bioSealed.value = null; }
}

/**
 * Turn it on. The password is verified against the vault FIRST — sealing a
 * wrong password behind a fingerprint builds a door that opens onto nothing,
 * and you would not find out until the day you needed it.
 */
export async function enableBiometrics(password: string): Promise<void> {
  if (!vaultBlob.value) throw new Error('no vault');
  await openVault(vaultBlob.value, password);
  const sealed = await biometricEnable(password);
  bioSealed.value = sealed;
  await kv.set('bio', JSON.stringify(sealed));
}

export async function disableBiometrics(): Promise<void> {
  await biometricDisable();
  bioSealed.value = null;
  await kv.del('bio');
}

/** Ask for a finger, then unlock exactly the way a typed password would. */
export async function unlockWithBiometrics(): Promise<void> {
  const sealed = bioSealed.value;
  if (!sealed) throw new Error('biometric unlock is not set up');
  const password = await biometricUnlock(sealed);
  await unlock(password);
}

export function lock(): void {
  void session.lock();
  accounts.value = [];
  balances.value = [];
  assetEth.value = {};
  portfolioEth.value = null;
  clearPortfolioSnapshot();
  liveAddress = '';
  pickerOpen.value = false;
  sheet.value = null;
  openAsset.value = null;
  openNft.value = null;
  screen.value = 'unlock';
}

// ---- wallets --------------------------------------------------------------
/** reveal the next account inside a seed group (defaults to the current one) */
export async function addAccount(groupId?: string): Promise<void> {
  const gid = groupId ?? account.value?.groupId;
  const seedGroup = gid && gid !== 'imported' ? gid : groups.value.find((g) => g.kind === 'seed')?.id;
  if (!seedGroup) throw new Error('no seed phrase to derive from');
  await applyWrite(await session.addAccount(seedGroup));
  // the new account lands at the end of its own group, not of the whole list
  const mates = accounts.value.filter((a) => a.groupId === seedGroup);
  selectAccount(mates.length ? mates[mates.length - 1].index : accounts.value.length - 1);
}

/** add another seed phrase as its own group */
export async function addSeed(mnemonic: string, nick?: string): Promise<void> {
  busy.value = 'deriving…';
  try {
    await applyWrite(await session.addSeed(mnemonic.trim().toLowerCase(), nick));
    const added = accounts.value[accounts.value.length - 1];
    if (added) await forgetWalletGroupLayout(added.groupId).catch(sayError);
    selectAccount(accounts.value.length - 1);
    say('seed phrase added. it lives in the same vault, under the same password.');
  } finally {
    busy.value = null;
  }
}

/** import a single raw private key */
export async function importPrivateKey(key: string, nick?: string): Promise<void> {
  const normalized = normalizePrivateKey(key); // throws before anything is stored
  busy.value = 'importing…';
  try {
    await applyWrite(await session.importKey(normalized, nick));
    selectAccount(accounts.value.length - 1);
    say('key imported and sealed in the vault. your seed phrase cannot restore it — keep the original.');
  } finally {
    busy.value = null;
  }
}

export async function renameAccount(index: number, nick: string): Promise<void> {
  await applyWrite(await session.editAccount(index, { nick }));
}

export async function setAccountLabels(index: number, labels: string[]): Promise<void> {
  await applyWrite(await session.editAccount(index, { labels }));
}

export async function renameGroup(groupId: string, nick: string): Promise<void> {
  await applyWrite(await session.renameGroup(groupId, nick));
}

export async function forgetGroup(groupId: string): Promise<void> {
  await applyWrite(await session.forgetGroup(groupId));
  await forgetWalletGroupLayout(groupId).catch(sayError);
  selectAccount(Math.min(selected.value, accounts.value.length - 1));
  say('seed phrase and its wallets removed from this device.');
}

export async function forgetAccount(index: number): Promise<void> {
  await applyWrite(await session.forgetAccount(index));
  selectAccount(Math.min(selected.value, accounts.value.length - 1));
  say('imported wallet removed from this device.');
}

/**
 * EXPORTING SECRETS. A key you cannot get out is a key you do not really own —
 * and for an imported key this wallet is the only copy there is, because no
 * seed phrase can regenerate it.
 *
 * Both go through the session, which opens the SEALED vault with the password
 * typed just now rather than reading the unlocked one. So the password is a
 * real gate and not a formality: leaving the wallet unlocked on a desk does
 * not hand your seed phrase to whoever sits down at it.
 *
 * Nothing here is stored. The caller holds the string for as long as the sheet
 * is open and drops it on close.
 */
export async function revealKey(index: number, password: string): Promise<string> {
  const v = vaultBlob.value;
  if (!v) throw new Error('no vault on this device');
  return session.revealKey(v, password, index);
}

export async function revealPhrase(groupId: string, password: string): Promise<string> {
  const v = vaultBlob.value;
  if (!v) throw new Error('no vault on this device');
  return session.revealPhrase(v, password, groupId);
}

/**
 * What a pending transaction would actually move, netted for one wallet.
 *
 * Walks the pool rather than using the pinned endpoint: `eth_simulateV1` is a
 * recent method and roughly half the endpoints this wallet ships do not have
 * it, so the first one that can answer wins. null when none can — the approval
 * screen then says it could not look, instead of implying nothing moves.
 */
export async function simulateMoves(
  owner: `0x${string}`,
  tx: Parameters<typeof simulateTx>[3],
  requestChainId = chainId.value,
): Promise<Awaited<ReturnType<typeof simulateTx>>> {
  for (const ep of endpointsForChain(requestChainId)) {
    const r = await simulateTx(ep, requestChainId, owner, tx).catch(() => null);
    if (r) return r;
  }
  return null;
}


export function selectAccount(index: number): void {
  if (index < 0 || index >= accounts.value.length) return;
  selected.value = index;
  wantedAddress = accounts.value[index].address.toLowerCase();
  void persistPrefs();
  ensName.value = null;
  // this wallet's last known rows go up while its chains are asked; the other
  // wallet's figures must not sit under this one's name for even a frame
  liveAddress = '';
  balances.value = [];
  assetEth.value = {};
  portfolioEth.value = null;
  void hydrateBalances(accounts.value[index].address);
  void refresh();
}

export function cycleAccount(dir: 1 | -1): void {
  if (accounts.value.length === 0) return;
  selectAccount((selected.value + dir + accounts.value.length) % accounts.value.length);
}

// ---- chain data -----------------------------------------------------------
async function readUsdRate(): Promise<number | null> {
  return withFailover(endpointsForChain(1), async (ep) => {
    const found = await usdPerEth(ep, 1, { throwOnRpcError: true });
    if (found === null) throw new Error('no ETH/USD pool answered');
    return found;
  }).catch(() => null);
}

/**
 * Put the last known figures for a wallet on screen while the chains are asked
 * again — a wallet that opens blank on every focus loss is a wallet that looks
 * broken several times an hour. Display only: nothing is signed against a
 * cached number, and refresh() overwrites it (see balancecache.ts).
 */
async function hydrateBalances(address: string): Promise<void> {
  if (DEMO) return;
  const snap = await readBalanceSnapshot(address).catch(() => null);
  if (!snap) return;
  // the user moved on, or the live sweep already landed: never paint over it
  if (account.value?.address !== address || liveAddress === address) return;
  balances.value = snap.balances;
  assetEth.value = snap.assetEth;
  if (portfolioEth.value === null) portfolioEth.value = snap.portfolioEth;
  if (usdRate.value === null && snap.usdRate !== null) usdRate.value = snap.usdRate;
}

/** remember what is on screen for this wallet, for its next open */
function persistBalances(address: string): void {
  if (DEMO || account.value?.address !== address) return;
  void writeBalanceSnapshot(address, {
    balances: balances.value,
    assetEth: assetEth.value,
    portfolioEth: portfolioEth.value,
    usdRate: usdRate.value,
    at: Date.now(),
  }).catch(() => {/* a cache that failed to write costs one blank open, nothing more */});
}

// A refresh may be started by unlock, a network switch, and a contract add in
// quick succession. Only its newest generation may publish a full sweep: an
// older, narrower scan must not erase the asset a later owner action proved.
let refreshGeneration = 0;

export async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  const acct = account.value;
  if (!acct) return;
  const stillCurrent = () => refreshGeneration === generation && account.value?.address === acct.address;
  markPortfolioStale();
  if (DEMO) {
    balances.value = prefs.value.testnets
      ? [...demoBalances(), ...demoTestnetBalances()]
      : demoBalances();
    nfts.value = demoNfts();
    usdRate.value = 1881;
    // the demo prices itself from the same numbers the asset sheet shows, so
    // the rows and the total agree instead of being two canned constants
    const demoPer: Record<string, number> = {};
    for (const b of balances.value) {
      if (CHAINS[b.chainId ?? 1]?.testnet) continue;
      const amt = Number(b.amount.replace('<', ''));
      if (!Number.isFinite(amt)) continue;
      const rate = !b.address ? 1 : b.symbol === 'USDC' ? 1 / 1881 : 0.0000237;
      demoPer[assetKey(b.chainId ?? 1, b.address)] = amt * rate;
    }
    assetEth.value = demoPer;
    portfolioEth.value = Object.values(demoPer).reduce((t, v) => t + v, 0);
    ensName.value = 'radbro.eth';
    return;
  }
  // Any ordinary refresh can change this wallet's drawer total. Keep the
  // other cached rows, but make the next drawer open revalue the stale one.
  if (walletValues.value[acct.address] !== undefined) {
    const next = { ...walletValues.value };
    delete next[acct.address];
    walletValues.value = next;
  }
  busy.value = 'checking the chains…';
  // pinned once: switching chains mid-sweep must not mix two chain lists
  const scan = scanChains.value;
  try {
    // every chain through its OWN pool endpoint: no single node gets to see
    // the whole footprint, and one dead RPC cannot blank the others
    const sweeps = await sweepChains(
      endpointsForChain,
      acct.address,
      scan,
      customTokens.value,
    );
    // A newer refresh or account switch owns the rows now.
    if (!stillCurrent()) return;
    const errs: Record<number, string> = {};
    for (const s of sweeps) if (s.error) errs[s.chainId] = s.error;
    // a chain that did not answer keeps the rows it had — the banner above the
    // list says it was not reached, which is a truer picture than the rows
    // vanishing as if the holdings had
    const kept = balances.value.filter((b) => errs[b.chainId ?? 1] !== undefined);
    balances.value = [...sweeps.flatMap((s) => s.balances), ...kept];
    sweepErrors.value = errs;
    liveAddress = acct.address;
    if (Object.keys(errs).length === scan.length) {
      say('every RPC is unreachable — try other endpoints in SETTINGS → NETWORKS');
    } else {
      persistBalances(acct.address);
    }
  } finally {
    if (refreshGeneration === generation) busy.value = null;
  }

  // value the holdings: one pool quote per token, on the same RPC that just
  // served the balances, so it learns nothing new about you
  void (async () => {
    // through the pool, not one pinned endpoint: an account pinned to a relay
    // like flashbots gets no eth_call service, and a null price would read as
    // "this wallet is worth nothing"
    const rate = await readUsdRate();
    if (!stillCurrent()) return;
    usdRate.value = rate;
    const per: Record<string, number> = {};
    for (const id of scan) {
      // testnet ETH is play money: pricing it would put fake dollars in a real
      // total, which is a worse lie than showing nothing
      if (CHAINS[id].testnet) continue;
      const here = balances.value.filter((b) => (b.chainId ?? 1) === id);
      if (!here.length) continue;
      const valued = await withFailover(
        endpointsForChain(id),
        (ep) => valueInEth(ep, id, here, { throwOnRpcError: true }),
      )
        .catch(() => []);
      if (!stillCurrent()) return; // superseded mid-price
      for (const v of valued) {
        if (v.ethValue !== null) per[assetKey(v.chainId, v.address)] = v.ethValue;
      }
      // publish per chain rather than at the end, so rows fill in as they
      // price — over the cached figures, not instead of them
      assetEth.value = { ...assetEth.value, ...per };
    }
    if (!stillCurrent()) return;
    // a row no longer held loses its price; a chain that would not price keeps
    // its last one, and the total is the sum of what the rows show
    const held = new Set(balances.value.map((b) => assetKey(b.chainId ?? 1, b.address)));
    const final: Record<string, number> = {};
    for (const [k, v] of Object.entries({ ...assetEth.value, ...per })) if (held.has(k)) final[k] = v;
    assetEth.value = final;
    portfolioEth.value = Object.values(final).reduce((t, v) => t + v, 0);
    persistBalances(acct.address);
  })();

  // Discovery + NFTs are a second pass: slower, and never worth blocking
  // balances on.
  const idx = prefs.value.indexer;
  let indexerTrouble: string | null = null;
  void Promise.allSettled(
    scan.map(async (id) => {
      // when (and only when) the user has opted in, the indexer contributes
      // ADDRESSES TO CHECK — both ERC-20 contracts and NFT collections. Every
      // one of them is then read back off the chain, so a compromised or lying
      // indexer cannot invent a holding.
      const found = idx.enabled
        ? await discoverAssets(idx, id, acct.address).catch((e) => {
          // losing the indexer costs the long tail and nothing else — the
          // bundled lists and your pasted contracts are still read straight
          // off the chain below. One note for the whole sweep, not one per
          // chain.
          indexerTrouble = (e as Error).message.split('\n')[0];
          return { tokens: [], collections: [] };
        })
        : { tokens: [], collections: [] };

      // the tokens it found: identified and balanced through OUR rpc, then
      // merged in as they arrive rather than waiting for every chain
      if (found.tokens.length) {
        void withFailover(endpointsForChain(id), (ep) =>
          readTokens(ep, id, acct.address, found.tokens))
          .then((rows) => {
            if (!stillCurrent()) return;
            const have = new Set(
              balances.value.map((b) => `${b.chainId ?? 1}:${(b.address ?? '').toLowerCase()}`),
            );
            const fresh = rows.filter((r) => !have.has(`${r.chainId}:${(r.address ?? '').toLowerCase()}`));
            if (fresh.length) {
              balances.value = [...balances.value, ...fresh];
              persistBalances(acct.address);
            }
          })
          .catch(() => {/* the bundled sweep already rendered; this is extra */});
      }

      return withFailover(endpointsForChain(id), (ep) =>
        scanCollections(ep, id, acct.address, [
          ...(COLLECTIONS[id] ?? []),
          ...(customCollections.value[id] ?? []),
          ...found.collections,
        ]));
    }),
  ).then((rs) => {
    if (!stillCurrent()) return; // superseded mid-scan
    nfts.value = rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (indexerTrouble) {
      say(`indexer unavailable (${indexerTrouble}) — read the chain directly instead`);
    }
    const failed = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    nftError.value = failed.length
      ? `${failed.length} of ${scan.length} chains did not answer: ${
        String(failed[0].reason?.message ?? failed[0].reason).split('\n')[0]}`
      : null;
  });

  // reverse-ENS the selected account (mainnet resolver via mainnet pool)
  ensName.value = null;
  void lookupEns(endpointForChain(1), acct.address).then((n) => {
    if (stillCurrent()) ensName.value = n;
  });
}

/**
 * Chains swept on a refresh: the standing list, plus whatever chain you are
 * currently switched to. Selecting a chain already hands its RPC your address,
 * so reading your balance there costs no privacy that the switch didn't — and
 * a wallet sitting "on" Robinhood Testnet while showing nothing from it is
 * indistinguishable from a broken one. Arbitrum gets the same deal.
 */
export const scanChains = computed(() => {
  const out = [...SCAN_CHAIN_IDS];
  const sel = chainId.value;
  // the chain you switched to counts as one you asked about — unless it is a
  // testnet, which has its own opt-in and does not get let in through the back
  // door by being selected
  if (!out.includes(sel) && !CHAINS[sel]?.testnet) out.push(sel);
  if (prefs.value.testnets) for (const id of TESTNET_CHAIN_IDS) if (!out.includes(id)) out.push(id);
  // Pasting a contract is a narrower, owner-made privacy choice than enabling
  // every testnet: the selected node already saw this address while proving
  // the token or collection, and the owner explicitly asked to see it again.
  // Keep that one chain refreshed even if the broad testnet sweep stays off.
  const tracked = new Set([
    ...Object.keys(customTokens.value),
    ...Object.keys(customCollections.value),
  ].map(Number));
  for (const id of tracked) if (CHAIN_IDS.includes(id) && !out.includes(id)) out.push(id);
  return out;
});

/** the scanned chains that hold real money — the only ones that get totalled */
export const realChains = computed(() => scanChains.value.filter((id) => !CHAINS[id]?.testnet));

/** the pool endpoint this account is pinned to on a given chain */
export function endpointForChain(id: number): string {
  return endpointsForChain(id)[0];
}

/**
 * The whole pool for a chain, pinned endpoint first. Pinning keeps one node
 * from seeing your whole address set; the rest of the list is what we fail
 * over to when that node is slow, instead of telling you the chain is down.
 */
export function endpointsForChain(id: number): string[] {
  const p = poolsAll.value[id] ?? { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 };
  const a = account.value;
  const pinned = a ? endpointFor(p, a.address) : p.endpoints[0];
  return [pinned, ...p.endpoints.filter((e) => e !== pinned)];
}

/**
 * Which chain the asset list is FILTERED to, or null for all of them.
 *
 * This is a viewing choice, and it used to be conflated with `chainId` — the
 * chain a signature goes out on. The header said "Ethereum" while the list
 * under it showed Base and Robinhood, which is a bad thing for a header to say
 * a scroll above a SIGN button. Naming a chain here filters the list AND
 * switches the wallet to it; "all networks" leaves the wallet where it was and
 * lets the asset you tap decide.
 */
export const viewChain = signal<number | null>(null);
export function setViewChain(id: number | null): void {
  viewChain.value = id;
  if (id !== null) setChain(id);
}

/** one row of the asset list: a holding, its chain, and what it is worth */
export interface AssetRow {
  b: TokenBalance;
  chainId: number;
  /** worth in ETH, or null while nothing has priced it */
  eth: number | null;
  /** another contract on the SAME chain also calls itself this */
  dupe: boolean;
}

function rowsFor(ids: number[]): AssetRow[] {
  // a symbol that is not unique ON ITS CHAIN has to show its contract: anyone
  // can deploy a token with your token's name, and Robinhood carries two
  // contracts both calling themselves USDG. Across chains it is not a clash —
  // the badge on the icon already says which chain a row is on.
  const seen = new Map<string, number>();
  for (const b of visibleBalances.value) {
    const k = `${b.chainId ?? 1}:${b.symbol}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const rows = visibleBalances.value
    .filter((b) => ids.includes(b.chainId ?? 1))
    .filter((b) => viewChain.value === null || (b.chainId ?? 1) === viewChain.value)
    .map((b) => ({
      b,
      chainId: b.chainId ?? 1,
      eth: assetEth.value[assetKey(b.chainId ?? 1, b.address)] ?? null,
      dupe: (seen.get(`${b.chainId ?? 1}:${b.symbol}`) ?? 0) > 1,
    }));
  // biggest first, which is the order every wallet's list is in and the order
  // the question "what do I hold" is actually asked in. Rows nothing has
  // priced yet sink to the bottom rather than claiming to be worth zero.
  return rows.sort((x, y) => {
    if (x.eth === null && y.eth === null) return 0;
    if (x.eth === null) return 1;
    if (y.eth === null) return -1;
    return y.eth - x.eth;
  });
}

/** the asset list: one flat, value-sorted list across every real chain */
export const assetRows = computed(() => rowsFor(realChains.value));

/**
 * Test assets, kept in their own list under the real one. Test ETH is free, so
 * it is never summed into a balance and never priced.
 */
export const testRows = computed(() => rowsFor(scanChains.value.filter((id) => CHAINS[id]?.testnet)));

/** chains that were asked and did not answer — one banner, not one per block */
export const chainErrors = computed(() =>
  scanChains.value
    .filter((id) => sweepErrors.value[id])
    .map((id) => ({ chainId: id, name: CHAINS[id].name, error: sweepErrors.value[id] })),
);

/** how many real chains actually hold something */
export const chainsHeld = computed(
  () => new Set(balances.value
    .filter((b) => !CHAINS[b.chainId ?? 1]?.testnet)
    .map((b) => b.chainId ?? 1)).size,
);

/** what the chain the list is filtered to is worth, in ETH. null = not priced */
export const viewChainEth = computed(() => {
  const id = viewChain.value;
  if (id === null) return null;
  const priced = balances.value
    .filter((b) => (b.chainId ?? 1) === id)
    .map((b) => assetEth.value[assetKey(id, b.address)])
    .filter((v): v is number => v !== undefined);
  return priced.length === 0 ? null : priced.reduce((t, v) => t + v, 0);
});

/** add a token or NFT contract by address; refuses what it cannot read */
export async function addContract(chainIdIn: number, address: string): Promise<string> {
  const acct = account.value;
  if (!acct) throw new Error('unlock first');
  if (!CHAIN_IDS.includes(chainIdIn)) throw new Error('that network is not configured in RADWALLET');
  const ep = endpointForChain(chainIdIn);
  const col = await probeCollection(ep, chainIdIn, address, acct.address).catch(() => null);
  if (col) {
    const have = customCollections.value[chainIdIn] ?? [];
    if (!have.some((c) => c.address.toLowerCase() === col.address.toLowerCase())) {
      customCollections.value = {
        ...customCollections.value,
        [chainIdIn]: [...have, { address: col.address, name: col.name, symbol: col.symbol }],
      };
      await persistPrefs();
    }
    // The probe above has already read this exact collection from the chosen
    // owner node. Show it now instead of making the drawer wait for unrelated
    // public-chain sweeps to finish; the following refresh remains the source
    // of truth for every tracked collection.
    const without = nfts.value.filter((held) =>
      held.chainId !== chainIdIn || held.address.toLowerCase() !== col.address.toLowerCase());
    nfts.value = col.count > 0 ? [...without, col] : without;
    void refresh();
    return `${col.name} added — you hold ${col.count}`;
  }
  const tok = await probeToken(ep, chainIdIn, address, acct.address);
  if (!tok) throw new Error('that contract will not say what it is. not adding it.');
  const have = customTokens.value[chainIdIn] ?? [];
  if (!have.some((t) => t.address.toLowerCase() === tok.token.address.toLowerCase())) {
    customTokens.value = { ...customTokens.value, [chainIdIn]: [...have, tok.token] };
    await persistPrefs();
  }
  // `probeToken` just obtained this balance directly from the owner-selected
  // node. Publish that verified row immediately; a complete refresh can take
  // longer while the standing privacy sweep tries separate public RPC pools.
  const without = balances.value.filter((held) =>
    held.chainId !== chainIdIn || held.address?.toLowerCase() !== tok.token.address.toLowerCase());
  balances.value = tok.balance.raw > 0n ? [...without, tok.balance] : without;
  persistBalances(acct.address);
  void refresh();
  return `${tok.token.symbol} added — balance ${tok.balance.amount}`;
}

let trackedTokenWrite: Promise<void> = Promise.resolve();

/** Persist ERC-20 scan targets proved by a successful swap receipt. */
export async function trackSwapTokens(
  chainIdIn: number, candidates: KnownToken[],
): Promise<KnownToken[]> {
  let added: KnownToken[] = [];
  const write = trackedTokenWrite.then(async () => {
    const have = customTokens.value[chainIdIn] ?? [];
    const next = mergeTrackedTokens(have, candidates, TOKENS[chainIdIn] ?? []);
    if (next.length === have.length) return;
    added = next.slice(have.length);
    customTokens.value = { ...customTokens.value, [chainIdIn]: next };
    await storage.set('customTokens', JSON.stringify(customTokens.value));
  });
  trackedTokenWrite = write.catch(() => {});
  await write;
  return added;
}

/** Adopt the background worker's durable write into any wallet view already open. */
export function adoptTrackedTokens(chainIdIn: number, candidates: KnownToken[]): void {
  const have = customTokens.value[chainIdIn] ?? [];
  const next = mergeTrackedTokens(have, candidates, TOKENS[chainIdIn] ?? []);
  if (next.length === have.length) return;
  customTokens.value = { ...customTokens.value, [chainIdIn]: next };
}

let balanceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
type TransactionOutcome = 'confirmed' | 'failed';
const confirmationWaits = new Map<string, Promise<TransactionOutcome>>();
const announcedConfirmations = new Set<string>();

function confirmationKey(chainIdIn: number, hash: string): string {
  return `${chainIdIn}:${hash.toLowerCase()}`;
}

/** Adopt either the page's receipt or the background worker's failover result. */
export function adoptTransactionConfirmation(
  chainIdIn: number,
  hash: string,
  status: TransactionOutcome,
): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
  const key = confirmationKey(chainIdIn, hash);
  markPortfolioStale();
  void updateStatus(hash, status).catch(() => {});
  if (!approveMode && unlocked.value && !announcedConfirmations.has(key)) {
    announcedConfirmations.add(key);
    setTimeout(() => announcedConfirmations.delete(key), 5 * 60_000);
    const network = CHAINS[chainIdIn]?.name ?? `chain ${chainIdIn}`;
    say(status === 'confirmed'
      ? `✓ transaction confirmed · ${network}`
      : `✗ transaction failed · ${network}`);
    toastTransaction.value = { chainId: chainIdIn, hash };
  }
  if (balanceRefreshTimer) clearTimeout(balanceRefreshTimer);
  balanceRefreshTimer = setTimeout(() => {
    balanceRefreshTimer = null;
    if (unlocked.value) void refresh();
  }, 0);
}

/** Refresh after confirmation, with the old one-block delay as a fallback. */
export function scheduleBalanceRefresh(
  chainIdIn?: number,
  hash?: string,
  trackOnSuccess?: SwapTrackToken[],
): void {
  if (approveMode || !unlocked.value) return;
  markPortfolioStale();
  // Extension broadcasts include the accepted hash. The screen call that
  // follows is only retained for the in-page PWA session.
  if (IS_EXTENSION && !hash) return;
  if (balanceRefreshTimer) clearTimeout(balanceRefreshTimer);
  balanceRefreshTimer = setTimeout(() => {
    balanceRefreshTimer = null;
    if (unlocked.value) void refresh();
  }, 12_000);
  if (!chainIdIn || !/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) return;
  const txHash = hash as `0x${string}`;
  const key = confirmationKey(chainIdIn, txHash);
  const existing = confirmationWaits.get(key);
  if (existing) {
    // An extension broadcast can reach this page before its screen has saved
    // the history row. Re-apply the settled result after that save completes.
    void existing.then((status) => updateStatus(txHash, status)).catch(() => {});
    return;
  }
  const receipt = chainClient(endpointForChain(chainIdIn), chainIdIn)
    .waitForTransactionReceipt({ hash: txHash, timeout: 120_000, confirmations: 1 })
    .then((result): TransactionOutcome => {
      if (trackOnSuccess?.length) {
        const tokens = trackTokensForSettledReceipt(result.status, trackOnSuccess, result.logs);
        if (tokens.length) void trackSwapTokens(chainIdIn, tokens).catch(() => []);
      }
      return result.status === 'success' ? 'confirmed' : 'failed';
    });
  confirmationWaits.set(key, receipt);
  void (async () => {
    try {
      adoptTransactionConfirmation(chainIdIn, txHash, await receipt);
    } catch {
      // The delayed sweep above remains the fallback; the extension worker
      // also retries pending receipts durably across popup closure/restarts.
    } finally {
      setTimeout(() => confirmationWaits.delete(key), 15_000);
    }
  })();
}

let blockTimer: ReturnType<typeof setInterval> | null = null;
function tickBlocks(): void {
  if (blockTimer) clearInterval(blockTimer);
  if (DEMO) {
    blockNumber.value = demoBlockNumber();
    blockTimer = setInterval(() => (blockNumber.value += 1n), 12000);
    return;
  }
  const poll = async () => {
    try {
      blockNumber.value = await chainClient(endpoint.value, chainId.value).getBlockNumber();
    } catch {
      /* leave the counter frozen; RPC errors surface elsewhere */
    }
  };
  void poll();
  blockTimer = setInterval(poll, 12000);
}

export function rotateNow(): void {
  updatePool(rotate(pool.value));
  say(pool.value.endpoints.length > 1
    ? 'RPC assignments rotated. Every wallet moved to the next endpoint on this network.'
    : 'Only one RPC endpoint configured. Add another to rotate between them.');
  void refresh();
}

/**
 * Value every wallet, not just the open one.
 *
 * This is the expensive, privacy-relevant one and it runs ONLY when the wallet
 * drawer is opened: it sweeps every account on every scanned chain. Each
 * account goes through ITS OWN pinned endpoint, so the pool still spreads your
 * address set across nodes rather than handing one node the lot — which is the
 * mitigation, not a cure. Wallet sweeps run two at a time; token prices contain
 * no address or balance size, so one quote map per chain is shared by all of
 * them instead of repeating the same pool calls for every account.
 */
type WalletSweepSnapshot = {
  account: WalletAccount;
  sweeps: Awaited<ReturnType<typeof sweepChains>>;
};

function uniqueAccountsForPortfolio(list: WalletAccount[]): WalletAccount[] {
  const seen = new Set<string>();
  const out: WalletAccount[] = [];
  for (const a of list) {
    const address = a.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(a);
  }
  return out;
}

function portfolioErrorKey(address: string, chainIdIn: number): string {
  return `${address.toLowerCase()}:${chainIdIn}`;
}

function amountFromRaw(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === 0n) return whole.toString();
  const s = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${s}`;
}

function scaledDemoBalance(b: TokenBalance, bps: number): TokenBalance {
  const raw = (b.raw * BigInt(bps)) / 10_000n;
  return {
    ...b,
    raw,
    amount: raw === 0n ? '0' : amountFromRaw(raw, b.decimals),
  };
}

function demoPortfolioHoldings(snapshotAccounts: WalletAccount[]): PortfolioHolding[] {
  const base = demoBalances();
  const scales = [10_000, 1_250, 275, 40];
  return snapshotAccounts.flatMap((accountIn, i) => {
    const scale = scales[i] ?? 25;
    return base
      .map((b) => scaledDemoBalance(b, scale))
      .filter((b) => b.raw > 0n)
      .map((b) => {
        const chain = b.chainId ?? 1;
        const amt = Number(b.amount.replace('<', ''));
        const rate = CHAINS[chain]?.testnet ? NaN : !b.address ? 1 : b.symbol === 'USDC' ? 1 / 1881 : 0.0000237;
        return {
          ...b,
          walletAddress: accountIn.address,
          walletLabel: accountIn.label,
          groupId: accountIn.groupId,
          groupLabel: accountIn.groupLabel,
          ethValue: Number.isFinite(amt) && Number.isFinite(rate) ? amt * rate : null,
        };
      });
  });
}

function holdingsFromSnapshot(
  snapshot: WalletSweepSnapshot,
  pricesByChain: Map<number, Map<string, SpotPrice>>,
): PortfolioHolding[] {
  const out: PortfolioHolding[] = [];
  for (const sweep of snapshot.sweeps) {
    if (sweep.error) continue;
    const values = new Map(
      valueWithPrices(
        sweep.chainId,
        sweep.balances,
        pricesByChain.get(sweep.chainId) ?? new Map(),
      ).map((value) => [portfolioAssetId(value.chainId, value.address), value.ethValue] as const),
    );
    for (const b of sweep.balances) {
      out.push({
        ...b,
        chainId: sweep.chainId,
        walletAddress: snapshot.account.address,
        walletLabel: snapshot.account.label,
        groupId: snapshot.account.groupId,
        groupLabel: snapshot.account.groupLabel,
        ethValue: CHAINS[sweep.chainId]?.testnet
          ? null
          : values.get(portfolioAssetId(sweep.chainId, b.address)) ?? null,
      });
    }
  }
  return out;
}

export async function valueAllWallets(): Promise<void> {
  if (!IS_EXTENSION && DEMO) {
    const snapshotAccounts = uniqueAccountsForPortfolio(accounts.value);
    const holdings = demoPortfolioHoldings(snapshotAccounts);
    portfolioHoldings.value = holdings;
    portfolioUpdatedAt.value = Date.now();
    portfolioErrors.value = {};
    portfolioStale.value = false;
    walletValues.value = Object.fromEntries(snapshotAccounts.map((a) => [
      a.address,
      holdings
        .filter((h) => h.walletAddress.toLowerCase() === a.address.toLowerCase())
        .reduce((total, h) => total + (h.ethValue ?? 0), 0),
    ]));
    return;
  }
  if (valuingWallets.value || accounts.value.length === 0) return;
  valuingWallets.value = true;
  const epoch = portfolioEpoch;
  portfolioStale.value = true;
  const snapshotAccounts = uniqueAccountsForPortfolio(accounts.value);
  walletValueProgress.value = `0/${snapshotAccounts.length}`;
  try {
    if (usdRate.value === null) {
      usdRate.value = await readUsdRate();
    }
    if (!portfolioSnapshotFresh(epoch)) return;
    const snapshots: WalletSweepSnapshot[] = [];
    const concurrency = 2;
    for (let start = 0; start < snapshotAccounts.length; start += concurrency) {
      const batch = await Promise.all(snapshotAccounts.slice(start, start + concurrency).map(async (a) => ({
        account: a,
        sweeps: await sweepChains(
          (id) => {
            const p = poolsAll.value[id] ?? { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 };
            const pinned = endpointFor(p, a.address);
            return [pinned, ...p.endpoints.filter((e) => e !== pinned)];
          },
          a.address,
          // the standing list, never scanChains: test ETH is not money
          SCAN_CHAIN_IDS,
          customTokens.value,
        ).catch((error) => SCAN_CHAIN_IDS.map((id) => ({
          chainId: id,
          balances: [],
          error: (error as Error).message.split('\n')[0],
        }))),
      })));
      if (!portfolioSnapshotFresh(epoch)) return;
      snapshots.push(...batch);
      walletValueProgress.value = `${snapshots.length}/${snapshotAccounts.length}`;
    }

    walletValueProgress.value = 'PRICING';
    const priced = await valueWalletSnapshots(
      snapshots.map((snapshot) => ({
        address: snapshot.account.address,
        chains: snapshot.sweeps.map((sweep) => ({
          chainId: sweep.chainId,
          holdings: sweep.balances,
        })),
      })),
      async (id, tokens) => {
        const p = poolsAll.value[id] ?? { endpoints: [...CHAINS[id].defaultEndpoints], epoch: 0 };
        return withFailover(
          p.endpoints,
          (ep) => spotPricesInEth(ep, id, tokens, { throwOnRpcError: true }),
        ).catch(() => new Map());
      },
    );
    if (!portfolioSnapshotFresh(epoch)) return;

    const errors: Record<string, string> = {};
    for (const snapshot of snapshots) {
      for (const sweep of snapshot.sweeps) {
        if (sweep.error) {
          const chain = CHAINS[sweep.chainId]?.name ?? `chain ${sweep.chainId}`;
          errors[portfolioErrorKey(snapshot.account.address, sweep.chainId)] =
            `${snapshot.account.label} · ${chain}: ${sweep.error}`;
        }
      }
    }

    const freshHoldings = snapshots.flatMap((snapshot) => holdingsFromSnapshot(snapshot, priced.pricesByChain));
    const failedWalletChains = new Set<string>();
    for (const snapshot of snapshots) {
      for (const sweep of snapshot.sweeps) {
        if (sweep.error) failedWalletChains.add(portfolioErrorKey(snapshot.account.address, sweep.chainId));
      }
    }
    const scannedWallets = new Set(snapshotAccounts.map((a) => a.address.toLowerCase()));
    const retainedHoldings = portfolioHoldings.value.filter((h) =>
      scannedWallets.has(h.walletAddress.toLowerCase()) &&
      failedWalletChains.has(portfolioErrorKey(h.walletAddress, h.chainId ?? 1)));
    const nextHoldings = [...freshHoldings, ...retainedHoldings];
    portfolioHoldings.value = nextHoldings;
    portfolioUpdatedAt.value = Date.now();
    portfolioErrors.value = errors;
    portfolioStale.value = Object.keys(errors).length > 0;

    const nextWalletValues = { ...walletValues.value };
    for (const a of snapshotAccounts) {
      const lower = a.address.toLowerCase();
      const attempted = snapshots.find((snapshot) => snapshot.account.address.toLowerCase() === lower);
      const anySuccess = attempted?.sweeps.some((sweep) => !sweep.error) ?? false;
      const hasRetained = retainedHoldings.some((h) => h.walletAddress.toLowerCase() === lower);
      if (!anySuccess && !hasRetained) {
        delete nextWalletValues[a.address];
        continue;
      }
      nextWalletValues[a.address] = nextHoldings
        .filter((h) => h.walletAddress.toLowerCase() === lower)
        .reduce((total, h) => total + (h.ethValue ?? 0), 0);
    }
    walletValues.value = nextWalletValues;

    // Refresh-all already swept the selected wallet. Publish that snapshot to
    // HOME instead of immediately asking every chain for it a second time.
    const current = account.value;
    const selectedSnapshot = current
      ? snapshots.find((snapshot) => snapshot.account.address === current.address)
      : undefined;
    if (current && selectedSnapshot) {
      const selectedErrors: Record<number, string> = {};
      for (const sweep of selectedSnapshot.sweeps) {
        if (sweep.error) selectedErrors[sweep.chainId] = sweep.error;
      }
      const kept = balances.value.filter((b) => selectedErrors[b.chainId ?? 1] !== undefined);
      balances.value = [...selectedSnapshot.sweeps.flatMap((sweep) => sweep.balances), ...kept];
      sweepErrors.value = selectedErrors;
      const per: Record<string, number> = {};
      for (const sweep of selectedSnapshot.sweeps) {
        if (sweep.error) continue;
        for (const value of valueWithPrices(
          sweep.chainId,
          sweep.balances,
          priced.pricesByChain.get(sweep.chainId) ?? new Map(),
        )) {
          if (value.ethValue !== null) per[assetKey(value.chainId, value.address)] = value.ethValue;
        }
      }
      assetEth.value = per;
      portfolioEth.value = nextWalletValues[current.address] ?? null;
      liveAddress = current.address;
      persistBalances(current.address);
    }
  } finally {
    walletValueProgress.value = null;
    valuingWallets.value = false;
  }
}

/** every wallet added up, in ETH */
export const allWalletsEth = computed(() =>
  uniqueAccountsForPortfolio(accounts.value).reduce((n, a) => n + (walletValues.value[a.address] ?? 0), 0),
);

export { usd };

/** re-read every wallet once; valueAllWallets also publishes the selected one to HOME */
export async function refreshEverything(): Promise<void> {
  walletValues.value = {};
  await valueAllWallets();
}
