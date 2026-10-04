/**
 * NFT holdings, read straight off the chain.
 *
 * There is no UNIVERSAL way to ask a public RPC "what NFTs does this address
 * hold" — but there is a partial one, and it is worth taking where it works.
 * A Transfer query filtered by RECIPIENT is selective enough that some nodes
 * will answer it over the whole chain (see `idsFromLogs`); the ones that will
 * not are refusing on archive access or a block-range cap, not on the filter.
 * Measured, per endpoint, full range, `topics: [Transfer, null, you]`:
 *
 *   rpc.mainnet.chain.robinhood.com  ALLOWED   (result-count limit, not range)
 *   ethereum-rpc.publicnode.com      refused   archive needs a personal token
 *   eth.drpc.org                     refused   >10k blocks needs a paid plan
 *   rpc.flashbots.net                refused   pruned history unavailable
 *   base-rpc.publicnode.com          refused   archive needs a personal token
 *   base.drpc.org / mainnet.base.org refused   10k block cap
 *
 * So: on a young chain with a generous node this gives EXACT token ids for
 * free, and everywhere else we fall back. See `indexer.ts` for the opt-in
 * escape hatch that covers the rest.
 *
 * What IS possible, on any RPC, is reading a collection you can name:
 *
 *   supportsInterface(0x80ac58cd)  is this ERC-721 at all?
 *   supportsInterface(0x780e9d63)  does it implement Enumerable?
 *   balanceOf(owner)               how many do you hold?
 *   tokenOfOwnerByIndex(owner, i)  which ones? (Enumerable only)
 *   tokenURI(id)                   where the metadata lives
 *
 * Bundled chains batch this into one Multicall3 round-trip per chain. An
 * owner-configured chain has no promised Multicall3 deployment, so its reads
 * use a bounded direct fallback instead. Verified live against BAYC: interface
 * flags, holder balance, token id and an ipfs:// URI, with no indexer and no
 * log scan.
 *
 * We never fetch tokenURI here. That would hand an IPFS gateway your address's
 * NFT list and your IP on every wallet open, which is the sort of thing this
 * wallet exists not to do. The URI is handed to the UI as data; fetching it is
 * a separate, explicit opt-in.
 */
import { getAddress, parseAbiItem, type PublicClient } from 'viem';
import { chainClient, readContracts } from './tokens.js';
import { COLLECTIONS, normalizeContract, type KnownCollection } from './chains.js';

/**
 * Token ids this address has RECEIVED, per collection, from Transfer logs.
 *
 * One query for the whole chain: `Transfer(from, to, tokenId)` with `to` bound
 * to you. ERC-20 emits the same signature, so the ERC-721s are picked out by
 * arity — an indexed `tokenId` makes four topics, an unindexed `value` makes
 * three.
 *
 * These are CANDIDATES, exactly like the indexer's answers: a token you were
 * sent and later sold still has a Transfer to you. Ownership is settled by
 * `ownerOf` below, so a stale id costs one slot in a multicall and never
 * reaches the screen.
 *
 * Returns null — not an empty map — when the node refuses, because "you own
 * nothing" and "we could not look" must not be the same value.
 */
export async function idsFromLogs(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
): Promise<Map<string, string[]> | null> {
  try {
    const c = chainClient(endpoint, chainId, 20_000);
    const logs = await c.getLogs({
      event: parseAbiItem(
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      ),
      args: { to: owner },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    const out = new Map<string, string[]>();
    for (const l of logs) {
      const id = l.args?.tokenId;
      if (id === undefined) continue;
      const key = l.address.toLowerCase();
      const list = out.get(key) ?? [];
      const asStr = String(id);
      if (!list.includes(asStr)) list.push(asStr);
      out.set(key, list);
    }
    return out;
  } catch {
    return null;   // archive-gated, range-capped, or too many results
  }
}

/** ERC-165 interface ids */
export const IFACE = {
  erc721: '0x80ac58cd',
  erc721Enumerable: '0x780e9d63',
  erc721Metadata: '0x5b5e139f',
  erc1155: '0xd9b67a26',
} as const;

const abi = [
  { name: 'supportsInterface', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'tokenURI', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/**
 * One collection you hold something in. Token ids are strings: these cross the
 * extension's message boundary, where bigints do not survive JSON.
 */
export interface NftHolding {
  chainId: number;
  address: `0x${string}`;
  name: string;
  symbol: string;
  /** how many you hold, from balanceOf */
  count: number;
  /** which ones, when the collection implements Enumerable */
  tokenIds: string[];
  /** false when we know the count but not the ids */
  enumerable: boolean;
  /** how the current ids were found, when we know */
  idSource?: 'enumerable' | 'logs' | 'ownerOf';
  /** false means there may be more owned ids than the list shows */
  idsComplete?: boolean;
  /** next enumerable owner index to ask for; separate from tokenIds so manual checks do not skip pages */
  idCursor?: number;
  /** metadata location per token id, never fetched here */
  tokenUris: Record<string, string>;
}

/**
 * Keep only entries with a valid, checksummed address. A single bad one poisons
 * an entire multicall batch, so this runs before every scan — bundled list or
 * user-pasted alike.
 */
export function usableCollections(list: KnownCollection[]): KnownCollection[] {
  const seen = new Set<string>();
  const out: KnownCollection[] = [];
  for (const c of list) {
    const addr = normalizeContract(c?.address);
    if (!addr) continue;
    if (seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    out.push({ ...c, address: addr });
  }
  return out;
}

type NftCallResult = { status: 'success' | 'failure'; result?: unknown };

type NftReadClient = {
  multicall(args: {
    allowFailure: true;
    contracts: readonly { address: `0x${string}`; abi: typeof abi; functionName: string; args?: readonly unknown[] }[];
  }): Promise<readonly NftCallResult[]>;
};

function nftCallResult(value: unknown): NftCallResult {
  if (value && typeof value === 'object' && 'status' in value) {
    const status = (value as { status?: unknown }).status;
    if (status === 'success' || status === 'failure') return value as NftCallResult;
  }
  return { status: 'success', result: value };
}

/** Preserve the testable multicall-shaped reader while supporting bare custom nodes. */
function nftReadClient(c: PublicClient, chainId: number): NftReadClient {
  return {
    multicall: ({ contracts }) => readContracts(c, chainId, contracts),
  };
}

async function tokenUrisForIds(
  c: NftReadClient,
  address: `0x${string}`,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const uris: Record<string, string> = {};
  try {
    const rs = (await c.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({
        address, abi, functionName: 'tokenURI', args: [BigInt(id)],
      } as const)),
    })).map(nftCallResult);
    ids.forEach((id, i) => {
      const r = rs[i];
      if (r?.status === 'success' && typeof r.result === 'string') uris[id] = r.result;
    });
  } catch { /* tokenURI is optional */ }
  return uris;
}

export async function readCollectionTokenIdPageWithClient(
  c: NftReadClient,
  owner: `0x${string}`,
  holding: NftHolding,
  start = holding.idCursor ?? holding.tokenIds.length,
  limit = MAX_IDS,
): Promise<{ tokenIds: string[]; tokenUris: Record<string, string>; complete: boolean; nextCursor: number }> {
  if (!holding.enumerable || holding.idSource === 'ownerOf') {
    throw new Error('this collection does not list token IDs by page');
  }
  const count = Math.max(0, Math.min(holding.count, Number.MAX_SAFE_INTEGER));
  const from = Math.max(0, Math.min(count, Math.floor(start)));
  const take = Math.max(0, Math.min(MAX_IDS, Math.floor(limit), count - from));
  if (take === 0) return { tokenIds: [], tokenUris: {}, complete: true, nextCursor: from };
  const ids = (await c.multicall({
    allowFailure: true,
    contracts: Array.from({ length: take }, (_, i) => ({
      address: holding.address, abi, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(from + i)],
    } as const)),
  })).map(nftCallResult);
  const readable = (r: NftCallResult | undefined): r is { status: 'success'; result: bigint } =>
    r?.status === 'success' && typeof r.result === 'bigint' && r.result >= 0n;
  const firstFailed = Array.from({ length: take }, (_, i) => ids[i]).findIndex((r) => !readable(r));
  const tokenIds = ids
    .filter(readable)
    .map((r) => String(r.result));
  return {
    tokenIds,
    tokenUris: await tokenUrisForIds(c, holding.address, tokenIds),
    complete: firstFailed < 0 && from + take >= count,
    nextCursor: firstFailed < 0 ? from + take : from + firstFailed,
  };
}

export async function readCollectionTokenIdPage(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  holding: NftHolding,
  start = holding.idCursor ?? holding.tokenIds.length,
  limit = MAX_IDS,
): Promise<{ tokenIds: string[]; tokenUris: Record<string, string>; complete: boolean; nextCursor: number }> {
  return readCollectionTokenIdPageWithClient(
    nftReadClient(chainClient(endpoint, chainId), chainId), owner, holding, start, limit,
  );
}

export async function verifyCollectionTokenIdWithClient(
  c: NftReadClient,
  owner: `0x${string}`,
  holding: NftHolding,
  tokenId: string,
): Promise<{ tokenId: string; tokenUri?: string }> {
  const input = tokenId.trim();
  if (!/^\d+$/.test(input)) throw new Error('token ID must be a whole number');
  const value = BigInt(input);
  if (value >= (1n << 256n)) throw new Error('token ID is too large');
  const id = value.toString();
  const [ownerOf] = (await c.multicall({
    allowFailure: true,
    contracts: [{ address: holding.address, abi, functionName: 'ownerOf', args: [BigInt(id)] } as const],
  })).map(nftCallResult);
  if (ownerOf?.status !== 'success' || String(ownerOf.result).toLowerCase() !== owner.toLowerCase()) {
    throw new Error('that token ID is not owned by this wallet');
  }
  const tokenUris = await tokenUrisForIds(c, holding.address, [id]);
  return { tokenId: id, ...(tokenUris[id] ? { tokenUri: tokenUris[id] } : {}) };
}

export async function verifyCollectionTokenId(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  holding: NftHolding,
  tokenId: string,
): Promise<{ tokenId: string; tokenUri?: string }> {
  return verifyCollectionTokenIdWithClient(nftReadClient(chainClient(endpoint, chainId), chainId), owner, holding, tokenId);
}

/** how many ids we pull per collection before saying "and more" */
const MAX_IDS = 24;

/**
 * Collections small enough to find your tokens by brute force. Radbro Webring
 * (5000), Radcats (7000) and most PFP sets do NOT implement Enumerable, so
 * `tokenOfOwnerByIndex` is unavailable and the only honest options are "show a
 * count and no ids" or "ask ownerOf about every id". At ~500 calls per
 * multicall a 10k collection costs ~20 batched round-trips, and it only runs
 * for collections you actually hold something in.
 */
const OWNEROF_SUPPLY_CAP = 12_000;
// 250 rather than 500: a browser on a public endpoint gets rate-limited or
// timed out by very large batches far sooner than node does, and a half-read
// collection is worth more than an exception.
const OWNEROF_BATCH = 250;

/**
 * Read holdings for a list of collections on one chain. Unknown or broken
 * contracts drop out silently — a scam contract that reverts on balanceOf
 * should not take the whole sweep down with it.
 */
export async function scanCollections(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  raw: KnownCollection[] = COLLECTIONS[chainId] ?? [],
): Promise<NftHolding[]> {
  // ONE malformed address makes viem reject the whole batch with
  // InvalidAddressError — every other collection then reads as "not held".
  // Drop bad entries instead of losing the scan. (Found the hard way.)
  const collections = usableCollections(raw);
  if (collections.length === 0) return [];
  const c = nftReadClient(chainClient(endpoint, chainId), chainId);

  // pass 1: how many of each, and is it enumerable
  const counts = await c.multicall({
    allowFailure: true,
    contracts: collections.flatMap((col) => [
      { address: col.address, abi, functionName: 'balanceOf', args: [owner] } as const,
      { address: col.address, abi, functionName: 'supportsInterface', args: [IFACE.erc721Enumerable] } as const,
    ]),
  });

  const held: { col: KnownCollection; count: number; enumerable: boolean }[] = [];
  collections.forEach((col, i) => {
    const bal = counts[i * 2];
    const en = counts[i * 2 + 1];
    if (bal.status !== 'success') return;
    const count = Number(bal.result as bigint);
    if (count <= 0) return;
    held.push({ col, count, enumerable: en.status === 'success' && en.result === true });
  });
  if (held.length === 0) return [];

  // pass 2: which ids, for the ones that can tell us
  const idCalls = held.flatMap(({ col, count, enumerable }) =>
    enumerable
      ? Array.from({ length: Math.min(count, MAX_IDS) }, (_, i) => ({
        address: col.address, abi, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)],
      } as const))
      : [],
  );
  const ids = idCalls.length
    ? await c.multicall({ allowFailure: true, contracts: idCalls })
    : [];

  const out: NftHolding[] = [];
  let cursor = 0;
  for (const { col, count, enumerable } of held) {
    const take = enumerable ? Math.min(count, MAX_IDS) : 0;
    const mine: string[] = [];
    let firstMissing = take;
    for (let i = 0; i < take; i++) {
      const r = ids[cursor + i];
      if (r?.status === 'success') mine.push(String(r.result as bigint));
      else firstMissing = Math.min(firstMissing, i);
    }
    cursor += take;
    out.push({
      chainId,
      address: col.address,
      name: col.name,
      symbol: col.symbol,
      count,
      tokenIds: mine,
      enumerable,
      ...(enumerable ? { idSource: 'enumerable' as const, idsComplete: mine.length >= count, idCursor: firstMissing } : {}),
      tokenUris: {},
    });
  }

  // pass 2a: the collections that cannot enumerate — most PFP collections —
  // used to go straight to a supply-wide ownerOf sweep, which is capped and
  // therefore silently incomplete on a big collection. Ask the logs first:
  // where the node will answer, it names your exact ids in ONE call, and the
  // sweep never has to run.
  let nonEnumerable = out.filter((h) => !h.enumerable && h.count > 0);
  if (nonEnumerable.length) {
    const byLogs = await idsFromLogs(endpoint, chainId, owner as `0x${string}`);
    if (byLogs) {
      await Promise.all(nonEnumerable.map(async (h) => {
        const candidates = byLogs.get(h.address.toLowerCase());
        if (!candidates?.length) return;
        // candidates are proposals; the chain decides who owns them now
        try {
          const owners = await c.multicall({
            allowFailure: true,
            contracts: candidates.map((id) => ({
              address: h.address, abi, functionName: 'ownerOf', args: [BigInt(id)],
            } as const)),
          });
          const mine = candidates.filter((_, k) => {
            const r = owners[k];
            return r?.status === 'success'
              && String(r.result).toLowerCase() === owner.toLowerCase();
          });
          if (mine.length) {
            h.tokenIds = mine.slice(0, MAX_IDS);
            h.idSource = 'logs';
            h.idsComplete = mine.length >= h.count;
          }
        } catch { /* fall through to the sweep for this one */ }
      }));
    }
  }

  // pass 2b: whatever the logs could not answer for. Ask who owns each id
  // instead — bounded by supply, and only for ones you hold.
  nonEnumerable = nonEnumerable.filter((h) => h.tokenIds.length < h.count);
  const brute = nonEnumerable;
  if (brute.length) try {
    const supplies = await c.multicall({
      allowFailure: true,
      contracts: brute.map((h) => ({ address: h.address, abi, functionName: 'totalSupply' } as const)),
    });
    await Promise.all(brute.map(async (h, i) => {
      const s = supplies[i];
      if (s.status !== 'success') return;
      const supply = Number(s.result as bigint);
      if (!Number.isFinite(supply) || supply <= 0 || supply > OWNEROF_SUPPLY_CAP) return;
      const found: string[] = [];
      // ids are conventionally 0- or 1-based; walk the whole range either way
      for (let start = 0; start <= supply && found.length < h.count; start += OWNEROF_BATCH) {
        const batch = Array.from(
          { length: Math.min(OWNEROF_BATCH, supply + 1 - start) },
          (_, k) => start + k,
        );
        try {
          const owners = await c.multicall({
            allowFailure: true,
            contracts: batch.map((id) => ({
              address: h.address, abi, functionName: 'ownerOf', args: [BigInt(id)],
            } as const)),
          });
          owners.forEach((r, k) => {
            if (r.status !== 'success') return;
            if (String(r.result).toLowerCase() === owner.toLowerCase()) found.push(String(batch[k]));
          });
        } catch {
          // a rate-limited or slow batch stops THIS collection's sweep and
          // keeps whatever it already found. Losing some ids is a bad day;
          // losing the whole holdings list looks like owning nothing.
          break;
        }
      }
      if (found.length) {
        h.tokenIds = found.slice(0, MAX_IDS);
        h.idSource = 'ownerOf';
        h.idsComplete = found.length >= h.count;
      }
    }));
  } catch { /* ids are a bonus; the counts below are the answer */ }

  // pass 3: where each token's metadata lives (not fetched, just recorded)
  const uriCalls = out.flatMap((h) =>
    h.tokenIds.map((id) => ({ address: h.address, abi, functionName: 'tokenURI', args: [BigInt(id)] } as const)),
  );
  if (uriCalls.length) try {
    const uris = await c.multicall({ allowFailure: true, contracts: uriCalls });
    let k = 0;
    for (const h of out) {
      for (const id of h.tokenIds) {
        const r = uris[k++];
        if (r?.status === 'success') h.tokenUris[id] = r.result as string;
      }
    }
  } catch { /* metadata locations are optional; holdings are not */ }
  return out;
}

/**
 * Identify a contract the user pasted in. Returns null when it is not an
 * ERC-721 we can read — better to refuse than to add a mystery row.
 */
export async function probeCollection(
  endpoint: string,
  chainId: number,
  address: string,
  owner: `0x${string}`,
): Promise<NftHolding | null> {
  const addr = normalizeContract(address);
  if (!addr) throw new Error('that is not a valid address, bro — check the checksum');
  const c = nftReadClient(chainClient(endpoint, chainId), chainId);
  const [is721, name, symbol] = await c.multicall({
    allowFailure: true,
    contracts: [
      { address: addr, abi, functionName: 'supportsInterface', args: [IFACE.erc721] } as const,
      { address: addr, abi, functionName: 'name' } as const,
      { address: addr, abi, functionName: 'symbol' } as const,
    ],
  });
  if (is721.status !== 'success' || is721.result !== true) return null;
  const col: KnownCollection = {
    address: addr,
    name: name.status === 'success' ? (name.result as string) : 'unknown collection',
    symbol: symbol.status === 'success' ? (symbol.result as string) : '???',
  };
  const [holding] = await scanCollections(endpoint, chainId, owner, [col]);
  return holding ?? { ...col, chainId, count: 0, tokenIds: [], enumerable: false, idsComplete: true, tokenUris: {} };
}
