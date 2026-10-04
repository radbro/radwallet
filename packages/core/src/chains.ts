/**
 * Chain registry. Everything is bundled — no chain-list API, no logo CDN.
 * Each chain ships with a default public RPC pool (user-editable, as always)
 * and an explorer base URL rendered as plain text links.
 */
import { mainnet, base, arbitrum, sepolia, baseSepolia } from 'viem/chains';
import { defineChain, getAddress as viemGetAddress } from 'viem';
import { VERIFIED_TOKENS } from './tokenlist.js';
import { normalizeEndpoint } from './rpc.js';
import type { Chain } from 'viem';

/**
 * Multicall3, at the same address on every chain we support — verified
 * deployed on Ethereum, Base, Arbitrum and Robinhood Chain. One call reads
 * hundreds of balances, which is what makes scanning a long token list on
 * every chain cheap enough to do on every refresh.
 */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

/**
 * Robinhood Chain — an Arbitrum-stack L2 (chain id 4663, ETH as native gas).
 * viem does not ship a definition for it, so we bundle one rather than fetch
 * a chain list. RPCs and id come from the public EVM chain registry and were
 * checked live: both endpoints answer eth_chainId 4663 and carry multicall3.
 */
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood', url: 'https://robinhoodchain.blockscout.com' } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/**
 * Robinhood Chain testnet (46630 / 0xb626) — where anything being BUILT on
 * Robinhood Chain actually lives. Bundled because a dapp that asks us to
 * switch to a chain we have never heard of gets refused, and "the wallet
 * connected but the site says wrong network" is indistinguishable from a
 * broken wallet. Verified live: the RPC answers 0xb626 and multicall3 is
 * deployed at the usual address.
 */
const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Robinhood', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export interface ChainInfo {
  id: number;
  name: string;
  chain: Chain;
  nativeSymbol: string;
  /** Optional for private or local chains such as Anvil. */
  explorerTx?: string; // prefix for tx links
  /** Optional for private or local chains such as Anvil. */
  explorerAddress?: string; // prefix for address links
  /**
   * Which explorer software this is. The two families agree on `/token/<addr>`
   * and disagree on everything else: a single NFT is `/nft/<addr>/<id>` on
   * etherscan and `/token/<addr>/instance/<id>` on blockscout, and guessing
   * wrong gives you a 404 where you expected your own picture.
   */
  explorerKind?: 'etherscan' | 'blockscout';
  /**
   * The chain's wrapped-native token. Native ETH has no contract, so anything
   * that needs one to talk about ETH — a DEX chart is drawn from a WETH pool —
   * uses this instead of pretending the asset does not exist.
   */
  wrappedNative?: `0x${string}`;
  defaultEndpoints: string[];
  /** play money: never priced, never counted into a portfolio total */
  testnet?: boolean;
}

export const CHAINS: Record<number, ChainInfo> = {
  1: {
    id: 1,
    name: 'Ethereum',
    chain: mainnet,
    nativeSymbol: 'ETH',
    explorerTx: 'https://etherscan.io/tx/',
    explorerAddress: 'https://etherscan.io/address/',
    explorerKind: 'etherscan',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    defaultEndpoints: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.flashbots.net',
    ],
  },
  8453: {
    id: 8453,
    name: 'Base',
    chain: base,
    nativeSymbol: 'ETH',
    explorerTx: 'https://basescan.org/tx/',
    explorerAddress: 'https://basescan.org/address/',
    explorerKind: 'etherscan',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    defaultEndpoints: [
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://mainnet.base.org',
    ],
  },
  4663: {
    id: 4663,
    name: 'Robinhood',
    chain: robinhood,
    nativeSymbol: 'ETH',
    // NOT explorer.chain.robinhood.com — that host resolves but fails the TLS
    // handshake, so every tx link on this chain was dead. Their live explorer
    // is a Blockscout instance, which is also why the indexer can route here.
    explorerTx: 'https://robinhoodchain.blockscout.com/tx/',
    explorerAddress: 'https://robinhoodchain.blockscout.com/address/',
    explorerKind: 'blockscout',
    // read off Robinhood's own SwapRouter02.WETH9(), not guessed
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    defaultEndpoints: [
      'https://rpc.mainnet.chain.robinhood.com',
    ],
  },
  11155111: {
    id: 11155111,
    name: 'Sepolia',
    chain: sepolia,
    nativeSymbol: 'ETH',
    explorerTx: 'https://sepolia.etherscan.io/tx/',
    explorerAddress: 'https://sepolia.etherscan.io/address/',
    explorerKind: 'etherscan',
    wrappedNative: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    defaultEndpoints: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://1rpc.io/sepolia',
    ],
    testnet: true,
  },
  84532: {
    id: 84532,
    name: 'Base Sepolia',
    chain: baseSepolia,
    nativeSymbol: 'ETH',
    explorerTx: 'https://sepolia.basescan.org/tx/',
    explorerAddress: 'https://sepolia.basescan.org/address/',
    explorerKind: 'etherscan',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    defaultEndpoints: [
      'https://base-sepolia-rpc.publicnode.com',
      'https://sepolia.base.org',
      'https://base-sepolia.drpc.org',
    ],
    testnet: true,
  },
  46630: {
    id: 46630,
    name: 'Robinhood Testnet',
    chain: robinhoodTestnet,
    nativeSymbol: 'ETH',
    explorerTx: 'https://explorer.testnet.chain.robinhood.com/tx/',
    explorerAddress: 'https://explorer.testnet.chain.robinhood.com/address/',
    explorerKind: 'blockscout',
    defaultEndpoints: ['https://rpc.testnet.chain.robinhood.com'],
    testnet: true,
  },
  42161: {
    id: 42161,
    name: 'Arbitrum',
    chain: arbitrum,
    nativeSymbol: 'ETH',
    explorerTx: 'https://arbiscan.io/tx/',
    explorerAddress: 'https://arbiscan.io/address/',
    explorerKind: 'etherscan',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    defaultEndpoints: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc',
    ],
  },
};

/**
 * A network is only custom when its owner adds it in the wallet. Dapps never
 * supply this data: an RPC URL selected by a webpage can observe every later
 * wallet request and can lie about the replies. The chain id is probed from
 * that owner-supplied endpoint before this shape ever reaches the registry.
 */
export interface CustomChainConfig {
  id: number;
  name: string;
  nativeSymbol: string;
  endpoint: string;
  /** Local development chains are play money unless their owner says otherwise. */
  testnet: boolean;
  /** Optional Etherscan-compatible explorer base, e.g. https://scan.example. */
  explorer?: string;
}

const BUILTIN_CHAIN_IDS = new Set(Object.keys(CHAINS).map(Number));
const customChainIds = new Set<number>();

function normalizeExplorer(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return normalizeEndpoint(raw) ?? undefined;
}

/** Validate persisted custom-network data before it can become executable RPC configuration. */
export function normalizeCustomChain(raw: unknown): CustomChainConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CustomChainConfig>;
  const id = Number(value.id);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const nativeSymbol = typeof value.nativeSymbol === 'string' ? value.nativeSymbol.trim().toUpperCase() : '';
  const endpoint = normalizeEndpoint(typeof value.endpoint === 'string' ? value.endpoint : '');
  const explorer = normalizeExplorer(value.explorer);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff
    || !name || name.length > 64
    || !/^[A-Z0-9$_.-]{1,16}$/.test(nativeSymbol)
    || !endpoint) return null;
  return {
    id, name, nativeSymbol, endpoint,
    testnet: value.testnet !== false,
    ...(explorer ? { explorer } : {}),
  };
}

/**
 * Register one owner-configured chain for the current runtime. Callers persist
 * the normalized return value themselves, so this pure registry never touches
 * browser storage and cannot be reached by a webpage.
 */
export function registerCustomChain(raw: unknown): CustomChainConfig | null {
  const config = normalizeCustomChain(raw);
  if (!config || BUILTIN_CHAIN_IDS.has(config.id) || CHAINS[config.id]) return null;
  const explorer = config.explorer?.replace(/\/$/, '');
  const chain = defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.endpoint] } },
    ...(explorer ? { blockExplorers: { default: { name: 'Custom explorer', url: explorer } } } : {}),
    testnet: config.testnet,
  });
  CHAINS[config.id] = {
    id: config.id,
    name: config.name,
    chain,
    nativeSymbol: config.nativeSymbol,
    ...(explorer ? {
      explorerTx: `${explorer}/tx/`,
      explorerAddress: `${explorer}/address/`,
      explorerKind: 'etherscan' as const,
    } : {}),
    defaultEndpoints: [config.endpoint],
    testnet: config.testnet,
  };
  CHAIN_IDS.push(config.id);
  if (config.testnet) TESTNET_CHAIN_IDS.push(config.id);
  customChainIds.add(config.id);
  return config;
}

/** Remove a custom chain from this runtime; bundled networks are immutable. */
export function unregisterCustomChain(id: number): boolean {
  if (!customChainIds.delete(id)) return false;
  delete CHAINS[id];
  const chainIndex = CHAIN_IDS.indexOf(id);
  if (chainIndex >= 0) CHAIN_IDS.splice(chainIndex, 1);
  const testIndex = TESTNET_CHAIN_IDS.indexOf(id);
  if (testIndex >= 0) TESTNET_CHAIN_IDS.splice(testIndex, 1);
  return true;
}

/** Replace the runtime custom registry with valid, owner-persisted entries. */
export function replaceCustomChains(raw: unknown): CustomChainConfig[] {
  for (const id of [...customChainIds]) unregisterCustomChain(id);
  if (!Array.isArray(raw)) return [];
  const accepted: CustomChainConfig[] = [];
  for (const value of raw) {
    const config = registerCustomChain(value);
    if (config) accepted.push(config);
  }
  return accepted;
}

/**
 * Normalise a contract address, or refuse it.
 *
 * EIP-55 semantics, deliberately: an all-lowercase address (how most people
 * paste them) is accepted and checksummed, but a MIXED-case address whose
 * checksum does not verify is rejected outright rather than "corrected" —
 * a typo in a contract address points at a different contract, and quietly
 * fixing it is how you show someone a balance from the wrong token.
 *
 * viem's multicall enforces the same rule and fails the ENTIRE batch on one
 * bad address, so every list is run through this before it is scanned.
 */
export function normalizeContract(address: string): `0x${string}` | null {
  if (typeof address !== 'string') return null;
  const raw = address.trim();
  const lower = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return null;
  const body = raw.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  const checksummed = viemGetAddress(lower);
  if (mixed && raw !== checksummed) return null;
  return checksummed;
}

/**
 * Uniswap v3 per chain: the router that swaps, the quoter that prices, and the
 * wrapped native every pool is quoted against.
 *
 * ONE map, because there were THREE — swapany.ts, price.ts and swap.ts each
 * kept their own copy, so a chain added to one was silently unpriceable by the
 * others. Robinhood Chain was missing from all of them, which is why every
 * token on it reported "no pool" when the chain in fact runs 31 DEXes.
 *
 * Robinhood's addresses are NOT the mainnet ones, and two unrelated forks
 * answer at familiar-looking addresses there. These came from the deployer of
 * the factory that live pools actually name, and all three agree on
 * `factory() == 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` — checked on
 * chain, not read off a website.
 */
export interface UniV3Deployment {
  router: `0x${string}`;
  quoter: `0x${string}`;
}

export const UNISWAP_V3: Record<number, UniV3Deployment> = {
  1: {
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
  8453: {
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  },
  42161: {
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
  4663: {
    router: '0xCaf681a66D020601342297493863E78C959E5cb2',
    quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  },
};

/** Mutable only through the owner-controlled custom-chain registry above. */
export const CHAIN_IDS: number[] = Object.keys(CHAINS).map(Number);

/**
 * Chains swept on every refresh. Every extra chain is another endpoint that
 * learns one address, so this is a deliberate list rather than "all of them" —
 * Arbitrum stays available in the switcher without being scanned unasked.
 */
export const SCAN_CHAIN_IDS = [1, 8453, 4663];

/**
 * The play-money chains. Switchable at any time — a dapp under development is
 * on one of these, and refusing the switch is what makes a wallet look broken —
 * but nothing here is swept, summed or priced unless the user turns testnets on
 * in SETTINGS. Test ETH is free; counting it as money would be a lie with a
 * dollar sign on it.
 */
/** Mutable only through the owner-controlled custom-chain registry above. */
export const TESTNET_CHAIN_IDS: number[] = Object.values(CHAINS)
  .filter((c) => c.testnet)
  .map((c) => c.id);

export const isTestnet = (id: number): boolean => !!CHAINS[id]?.testnet;

/** where to look up one transaction on the chain that accepted it */
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const prefix = chainInfo(chainId).explorerTx;
  return prefix ? `${prefix}${hash}` : null;
}

/** where to look this address up, on the chain you are looking at */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const prefix = chainInfo(chainId).explorerAddress;
  return prefix ? `${prefix}${address}` : null;
}

/** the explorer's origin, derived rather than stored a third time */
function explorerBase(chainId: number): string | null {
  const address = chainInfo(chainId).explorerAddress;
  return address ? new URL(address).origin : null;
}

/** a token contract's own page — both explorer families agree on this one */
export function explorerTokenUrl(chainId: number, contract: string): string | null {
  const base = explorerBase(chainId);
  return base ? `${base}/token/${contract}` : null;
}

/** one NFT, where the two families part ways */
export function explorerNftUrl(chainId: number, contract: string, tokenId: string): string | null {
  const base = explorerBase(chainId);
  if (!base) return null;
  return chainInfo(chainId).explorerKind === 'blockscout'
    ? `${base}/token/${contract}/instance/${tokenId}`
    : `${base}/nft/${contract}/${tokenId}`;
}

export function chainInfo(id: number): ChainInfo {
  const c = CHAINS[id];
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

/** Bundled token list — a few honest defaults per chain, not an API. */
export interface KnownToken {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * The hand-kept entries: the house token, and anything we want at the TOP of
 * a chain's list regardless of what the generated list says. Everything else
 * comes from `tokenlist.ts`, which is generated and verified against the chain
 * — see scripts/gen-tokens.mjs.
 */
const CURATED: Record<number, KnownToken[]> = {
  1: [
    { address: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB', symbol: '$RAD', name: 'Radcoin', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai', decimals: 18 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8 },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', name: 'Chainlink', decimals: 18 },
    { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', name: 'Wrapped stETH', decimals: 18 },
    { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', name: 'Rocket Pool ETH', decimals: 18 },
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', name: 'Uniswap', decimals: 18 },
    { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', name: 'Pepe', decimals: 18 },
    { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', symbol: 'LDO', name: 'Lido DAO', decimals: 18 },
    { address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', symbol: 'MATIC', name: 'Polygon', decimals: 18 },
    { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', symbol: 'MKR', name: 'Maker', decimals: 18 },
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18 },
    { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18 },
    { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 },
    { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18 },
    { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', name: 'Brett', decimals: 18 },
  ],
  4663: [
    { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'WETH', decimals: 18 },
  ],
  46630: [],
  11155111: [],
  84532: [],
  42161: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', name: 'Arbitrum', decimals: 18 },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  ],
};

/**
 * Every token this wallet sweeps on a chain: the curated few first, then the
 * verified list, with duplicates dropped by address.
 *
 * Curated entries win a collision so the house token keeps its name and its
 * place at the top; the rest is alphabetical because that is how the generator
 * emits it, and a stable order means a regenerated list diffs cleanly.
 */
function mergeTokens(): Record<number, KnownToken[]> {
  const out: Record<number, KnownToken[]> = {};
  const chainIds = new Set([
    ...Object.keys(CURATED).map(Number),
    ...Object.keys(VERIFIED_TOKENS).map(Number),
  ]);
  for (const id of chainIds) {
    const seen = new Set<string>();
    const list: KnownToken[] = [];
    for (const t of [...(CURATED[id] ?? []), ...(VERIFIED_TOKENS[id] ?? [])]) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(t);
    }
    out[id] = list;
  }
  return out;
}

export const TOKENS: Record<number, KnownToken[]> = mergeTokens();

/**
 * Bundled NFT collections. There is no way to ask a public RPC "what NFTs does
 * this address hold" — open log queries are refused (verified on every default
 * endpoint) — so, exactly like tokens, we check a known list plus whatever the
 * user pastes in. Ownership is read on-chain; nothing here is fetched.
 */
export interface KnownCollection {
  address: `0x${string}`;
  name: string;
  symbol: string;
}

export const COLLECTIONS: Record<number, KnownCollection[]> = {
  1: [
    // the house collections, first. Addresses from research/RADBRO_RESEARCH.md
    // and each confirmed on mainnet: name, symbol, supply and ERC-721 support
    // all read back as expected. None implement Enumerable, which is why the
    // ownerOf sweep in nfts.ts exists.
    { address: '0xABCDB5710B88f456fED1e99025379e2969F29610', name: 'Radbro Webring V2', symbol: 'RADBROS' },
    { address: '0x3bFC3134645ebe0393F90d6a19BcB20bD732964F', name: 'Radbro Webring: Radcats', symbol: 'RADCATS' },
    { address: '0xE83C9F09B0992e4a34fAf125ed4FEdD3407c4a23', name: 'Radbro Webring (V1)', symbol: 'RADBRO' },
    { address: '0xBfE47D6D4090940D1c7a0066B63d23875E3e2Ac5', name: 'SchizoPosters', symbol: 'SCHIZO' },
    { address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', name: 'Bored Ape Yacht Club', symbol: 'BAYC' },
    { address: '0x60E4d786628Fea6478F785A6d7e704777c86a7c6', name: 'Mutant Ape Yacht Club', symbol: 'MAYC' },
    { address: '0xED5AF388653567Af2F388E6224dC7C4b3241C544', name: 'Azuki', symbol: 'AZUKI' },
    { address: '0x49cF6f5d44E70224e2E23fDcdd2C053F30aDA28B', name: 'CloneX', symbol: 'CloneX' },
    { address: '0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e', name: 'Doodles', symbol: 'DOODLE' },
    { address: '0x23581767a106ae21c074b2276D25e5C3e136a68b', name: 'Moonbirds', symbol: 'MOONBIRD' },
    { address: '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB', name: 'CryptoPunks (wrapped)', symbol: 'WPUNKS' },
    { address: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', name: 'ENS Names', symbol: 'ENS' },
  ],
  8453: [
    { address: '0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a', name: 'Base, an Introduction', symbol: 'BASEINTRO' },
  ],
  4663: [],
  46630: [],
  11155111: [],
  84532: [],
  42161: [],
};
