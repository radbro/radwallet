/**
 * THE OPT-IN INDEXER. This is the only file in the wallet that talks to
 * anything other than an RPC endpoint, and it is switched OFF by default.
 *
 * Why it exists: no public RPC will answer "what does this address hold".
 * Open `eth_getLogs` is refused by every endpoint we ship (publicnode:
 * "Please specify an address in your request"; drpc: "Request timeout on the
 * free plan"), so the private path — bundled lists plus contracts you paste —
 * cannot find the long tail. An indexer can, instantly.
 *
 * What it costs, stated plainly because the UI has to repeat it:
 *
 *   - the provider sees EVERY address in your wallet, on every refresh
 *   - the provider sees your IP, and can join the two
 *   - the provider can log, retain and sell that, and you cannot check
 *   - your account set becomes a profile held by a company, which is exactly
 *     the thing the rest of this wallet is built to prevent
 *
 * Three mitigations are built in rather than bolted on: requests go one address
 * at a time (no bulk upload of your whole account list in a single call), you
 * can configure SEVERAL providers and they are rotated per call the way the RPC
 * pool is — so no single one of them sees every refresh — and the Tor toggle in
 * Tor routing covers these hosts too, because it routes by host.
 *
 * Everything a provider returns is treated as A LIST OF ADDRESSES TO CHECK,
 * never as an answer. Balances, ownership, symbols and decimals are all read
 * back off the chain through your own RPC, so an indexer that lies can waste
 * your time but cannot put a holding on your screen that you do not have.
 *
 * The no-telemetry CI grep excludes this file BY NAME. That is a deliberate,
 * documented hole and the only one — see .github/workflows/ci.yml.
 */
import { normalizeContract } from './chains.js';
import type { KnownCollection } from './chains.js';

export type IndexerProvider = 'blockscout' | 'alchemy' | 'moralis';

/** one configured provider. `key` is '' for the providers that need none */
export interface IndexerEntry {
  provider: IndexerProvider;
  key: string;
}

export interface IndexerConfig {
  /** nothing happens unless this is true */
  enabled: boolean;
  /** rotated per call, in the order you added them */
  entries: IndexerEntry[];
}

export const INDEXER_OFF: IndexerConfig = { enabled: false, entries: [] };

export interface ProviderInfo {
  id: IndexerProvider;
  name: string;
  /** the host actually contacted, verbatim, so the UI can name it */
  host: string;
  needsKey: boolean;
  /** where the user gets a key, when one is needed */
  keyFrom: string;
  /** which of our chains this provider can answer for */
  chains: number[];
  /** one line for the picker */
  note: string;
}

/** blockscout runs a public instance per chain, and asks for no key at all */
const BLOCKSCOUT: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com',
  // Robinhood Chain runs Blockscout as its own explorer, on both networks —
  // so the one chain no keyed provider covers is covered by the keyless one
  4663: 'https://robinhoodchain.blockscout.com',
  46630: 'https://explorer.testnet.chain.robinhood.com',
};

const ALCHEMY: Record<number, string> = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  11155111: 'eth-sepolia',
  84532: 'base-sepolia',
};

/** moralis takes the chain as a hex id, which every chain of ours has */
const MORALIS: Record<number, string> = {
  1: '0x1',
  8453: '0x2105',
  42161: '0xa4b1',
  11155111: '0xaa36a7',
  84532: '0x14a34',
};

export const INDEXER_PROVIDERS: ProviderInfo[] = [
  {
    id: 'blockscout',
    name: 'Blockscout',
    host: 'blockscout.com',
    needsKey: false,
    keyFrom: '',
    chains: Object.keys(BLOCKSCOUT).map(Number),
    note: 'No API key required. Includes Robinhood Chain and its testnet.',
  },
  {
    id: 'alchemy',
    name: 'Alchemy',
    host: 'g.alchemy.com',
    needsKey: true,
    keyFrom: 'dashboard.alchemy.com — free tier, one app key',
    chains: Object.keys(ALCHEMY).map(Number),
    note: 'Supports Ethereum, Base, Arbitrum, Sepolia and Base Sepolia.',
  },
  {
    id: 'moralis',
    name: 'Moralis',
    host: 'deep-index.moralis.io',
    needsKey: true,
    keyFrom: 'admin.moralis.io — free tier',
    chains: Object.keys(MORALIS).map(Number),
    note: 'Supports Ethereum, Base, Arbitrum, Sepolia and Base Sepolia.',
  },
];

export function providerInfo(id: IndexerProvider): ProviderInfo | undefined {
  return INDEXER_PROVIDERS.find((p) => p.id === id);
}

/** an entry that could actually run: known provider, has a key if it needs one */
export function entryUsable(e: IndexerEntry, chainId?: number): boolean {
  const info = providerInfo(e.provider);
  if (!info) return false;
  if (info.needsKey && !e.key) return false;
  return chainId === undefined || info.chains.includes(chainId);
}

/** is there anything configured that can answer for this chain? */
export function indexerSupports(cfg: IndexerConfig, chainId: number): boolean {
  return cfg.entries.some((e) => entryUsable(e, chainId));
}

/** what a provider gives us: addresses to go and check, and nothing more */
export interface Discovered {
  tokens: `0x${string}`[];
  collections: KnownCollection[];
}

const NOTHING: Discovered = { tokens: [], collections: [] };

// ---- response parsing: shape-checked, never trusted ------------------------

/** blockscout returns ERC-20 and ERC-721 rows in one list, so split them */
export function parseBlockscout(json: unknown): Discovered {
  if (!Array.isArray(json)) return NOTHING;
  const tokens: `0x${string}`[] = [];
  const collections: KnownCollection[] = [];
  for (const r of json) {
    const row = r as {
      value?: string;
      token?: { address_hash?: string; address?: string; name?: string; symbol?: string; type?: string };
    };
    const t = row?.token;
    // a bad address would poison the whole multicall batch it lands in
    const address = normalizeContract(String(t?.address_hash ?? t?.address ?? ''));
    if (!address) continue;
    const type = String(t?.type ?? '');
    if (/^ERC-?20$/i.test(type)) {
      if (!row.value || /^0+$/.test(row.value)) continue;
      tokens.push(address);
    } else if (/^ERC-?721$/i.test(type)) {
      collections.push({
        address,
        name: typeof t?.name === 'string' && t.name ? t.name : 'unnamed collection',
        symbol: typeof t?.symbol === 'string' && t.symbol ? t.symbol : '???',
      });
    }
  }
  return { tokens, collections };
}

export function parseContracts(json: unknown): KnownCollection[] {
  const list = (json as { contracts?: unknown[] })?.contracts;
  if (!Array.isArray(list)) return [];
  const out: KnownCollection[] = [];
  for (const c of list) {
    const row = c as { address?: string; name?: string; symbol?: string; tokenType?: string };
    if (row?.tokenType && !/^ERC721$/i.test(row.tokenType)) continue;
    const address = normalizeContract(String(row?.address ?? ''));
    if (!address) continue;
    out.push({
      address,
      name: typeof row.name === 'string' && row.name ? row.name : 'unnamed collection',
      symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : '???',
    });
  }
  return out;
}

export function parseTokenBalances(json: unknown): `0x${string}`[] {
  const balances = (json as { result?: { tokenBalances?: unknown[] } })?.result?.tokenBalances;
  if (!Array.isArray(balances)) return [];
  const out: `0x${string}`[] = [];
  for (const b of balances) {
    const row = b as { contractAddress?: string; tokenBalance?: string };
    // skip the zero balances the API returns for tokens you have merely touched
    if (!row?.tokenBalance || /^0x0*$/.test(row.tokenBalance)) continue;
    const addr = normalizeContract(String(row.contractAddress ?? ''));
    if (addr) out.push(addr);
  }
  return out;
}

export function parseMoralisTokens(json: unknown): `0x${string}`[] {
  // v2.2 returns a bare array for /erc20
  const list = Array.isArray(json) ? json : (json as { result?: unknown[] })?.result;
  if (!Array.isArray(list)) return [];
  const out: `0x${string}`[] = [];
  for (const r of list) {
    const row = r as { token_address?: string; balance?: string; possible_spam?: boolean };
    if (row?.possible_spam) continue;
    if (!row?.balance || /^0+$/.test(row.balance)) continue;
    const addr = normalizeContract(String(row.token_address ?? ''));
    if (addr) out.push(addr);
  }
  return out;
}

export function parseMoralisCollections(json: unknown): KnownCollection[] {
  const list = (json as { result?: unknown[] })?.result;
  if (!Array.isArray(list)) return [];
  const out: KnownCollection[] = [];
  for (const r of list) {
    const row = r as {
      token_address?: string; name?: string; symbol?: string;
      contract_type?: string; possible_spam?: boolean;
    };
    if (row?.possible_spam) continue;
    if (row?.contract_type && !/^ERC721$/i.test(row.contract_type)) continue;
    const address = normalizeContract(String(row?.token_address ?? ''));
    if (!address) continue;
    out.push({
      address,
      name: typeof row.name === 'string' && row.name ? row.name : 'unnamed collection',
      symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : '???',
    });
  }
  return out;
}

// ---- URL builders: pure, so the exact host contacted is easy to audit ------

export function blockscoutUrl(chainId: number, owner: string): string {
  const host = BLOCKSCOUT[chainId];
  if (!host) throw new Error(`blockscout has no instance for chain ${chainId}`);
  return `${host}/api/v2/addresses/${encodeURIComponent(owner)}/token-balances`;
}

export function alchemyNftUrl(key: string, chainId: number, owner: string): string {
  const host = ALCHEMY[chainId];
  if (!host) throw new Error(`alchemy has no route for chain ${chainId}`);
  if (!key) throw new Error('alchemy needs your own API key');
  // withMetadata=false keeps the response small and asks for less than we could
  return `https://${host}.g.alchemy.com/nft/v3/${encodeURIComponent(key)}` +
    `/getContractsForOwner?owner=${encodeURIComponent(owner)}&withMetadata=false&pageSize=100`;
}

/**
 * Alchemy's token list is a JSON-RPC method, and it has to go to ALCHEMY'S OWN
 * endpoint. It used to be posted at whichever public node the pool handed over,
 * which does not implement `alchemy_getTokenBalances` and answered with an
 * error we swallowed — so a perfectly good API key silently found nothing.
 */
export function alchemyRpcUrl(key: string, chainId: number): string {
  const host = ALCHEMY[chainId];
  if (!host) throw new Error(`alchemy has no route for chain ${chainId}`);
  if (!key) throw new Error('alchemy needs your own API key');
  return `https://${host}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

export function tokenRpcBody(owner: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [owner, 'erc20'] };
}

export function moralisUrl(chainId: number, owner: string, what: 'erc20' | 'nft'): string {
  const chain = MORALIS[chainId];
  if (!chain) throw new Error(`moralis has no route for chain ${chainId}`);
  const path = what === 'erc20' ? 'erc20' : 'nft/collections';
  return `https://deep-index.moralis.io/api/v2.2/${encodeURIComponent(owner)}/${path}?chain=${chain}`;
}

// ---- the providers themselves ---------------------------------------------

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${new URL(url).host} said ${res.status}`);
  return res.json();
}

const RUNNERS: Record<
  IndexerProvider,
  (entry: IndexerEntry, chainId: number, owner: `0x${string}`) => Promise<Discovered>
> = {
  // one request, both kinds of asset, no key
  blockscout: async (_e, chainId, owner) => parseBlockscout(await getJson(blockscoutUrl(chainId, owner))),

  alchemy: async (e, chainId, owner) => {
    const [nfts, tokens] = await Promise.all([
      getJson(alchemyNftUrl(e.key, chainId, owner)).then(parseContracts),
      getJson(alchemyRpcUrl(e.key, chainId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tokenRpcBody(owner)),
      }).then(parseTokenBalances),
    ]);
    return { tokens, collections: nfts };
  },

  moralis: async (e, chainId, owner) => {
    const headers = { 'x-api-key': e.key };
    const [tokens, collections] = await Promise.all([
      getJson(moralisUrl(chainId, owner, 'erc20'), { headers }).then(parseMoralisTokens),
      getJson(moralisUrl(chainId, owner, 'nft'), { headers }).then(parseMoralisCollections),
    ]);
    return { tokens, collections };
  },
};

/**
 * Where the rotation starts. Module-level and deliberately not per-account:
 * the point is that consecutive refreshes do not all land on the same company.
 */
let cursor = 0;

/**
 * Ask an indexer what this owner holds — token contracts and NFT collections.
 *
 * Providers are tried in a rotating order and failed over exactly like the RPC
 * pool: several configured providers means no single one of them sees every
 * refresh, and one being down costs nothing. Everything that comes back is
 * verified against the chain before it is shown.
 */
export async function discoverAssets(
  cfg: IndexerConfig,
  chainId: number,
  owner: `0x${string}`,
): Promise<Discovered> {
  if (!cfg.enabled) return NOTHING;
  const usable = cfg.entries.filter((e) => entryUsable(e, chainId));
  if (!usable.length) return NOTHING;
  const start = cursor++ % usable.length;
  let last: unknown;
  for (let i = 0; i < usable.length; i++) {
    const e = usable[(start + i) % usable.length];
    try {
      return await RUNNERS[e.provider](e, chainId, owner);
    } catch (err) {
      last = err;
    }
  }
  const msg = last instanceof Error ? last.message.split('\n')[0] : String(last);
  throw new Error(usable.length > 1 ? `all ${usable.length} indexers failed — last said: ${msg}` : msg);
}

/** NFT collections only, for callers that do not want the token half */
export async function discoverCollections(
  cfg: IndexerConfig,
  chainId: number,
  owner: `0x${string}`,
): Promise<KnownCollection[]> {
  return (await discoverAssets(cfg, chainId, owner)).collections;
}
