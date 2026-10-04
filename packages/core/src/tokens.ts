/**
 * Balance sweep + ENS. All reads go through the account's own pool endpoint.
 * The token list is bundled (chains.ts) — no token-list API, no logo CDN.
 */
import { createPublicClient, http, erc20Abi, formatEther, formatUnits, getAddress } from 'viem';
import { normalize } from 'viem/ens';
import type { PublicClient } from 'viem';
import { chainInfo, TOKENS, SCAN_CHAIN_IDS, normalizeContract, type KnownToken } from './chains.js';
import { RAD_TOKEN, type TokenBalance } from './chain.js';

const RAD_KEY = RAD_TOKEN.address.toLowerCase();

/**
 * `timeout` is generous by default because a multicall carrying hundreds of
 * balanceOf calls is a much bigger request than the single eth_call viem sizes
 * its 10s default for, and public endpoints are slow under load.
 */
export function chainClient(endpoint: string, chainId: number, timeout = 8_000): PublicClient {
  return createPublicClient({
    chain: chainInfo(chainId).chain,
    ccipRead: false,
    // retryCount 0 on purpose: the RPC POOL is the retry. Retrying the same
    // unresponsive host just doubles the wait before we try one that works.
    transport: http(endpoint, { timeout, retryCount: 0 }),
  });
}

/** viem nests transport failures under contract/action wrappers when allowFailure is on. */
export function isRpcTransportError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const named = current as { name?: string; cause?: unknown };
    if (named.name === 'HttpRequestError' || named.name === 'TimeoutError') return true;
    current = named.cause;
  }
  return false;
}

/**
 * Native + token balances for one chain, batched where the chain supports it.
 *
 * Every bundled token uses multicall3, so the list can grow to hundreds
 * without turning a refresh into hundreds of requests. An owner-added network
 * has no promised Multicall3 deployment, so its owner-added contracts fall
 * back to bounded direct reads. Zero balances drop out; $RAD keeps its row on
 * mainnet because it is the house token.
 */
/** keep only well-formed, unique token entries; see scanCollections for why */
export function usableTokens(list: KnownToken[]): KnownToken[] {
  const seen = new Set<string>();
  const out: KnownToken[] = [];
  for (const t of list) {
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
    const addr = normalizeContract(t?.address);
    if (!addr) continue;
    if (seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    out.push({ ...t, address: addr });
  }
  return out;
}

/** A contract read that can be served either by Multicall3 or directly. */
export interface ContractRead {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export type ContractReadResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; result?: undefined; error?: unknown };

/**
 * Read contracts through a configured Multicall3, or directly when a custom
 * chain has no declared deployment. `defineChain` deliberately does not guess
 * a Multicall3 address for an owner-supplied chain: an absent deployment must
 * not make every manually added asset appear to have a zero balance.
 */
export async function readContracts(
  c: PublicClient,
  chainId: number,
  contracts: readonly ContractRead[],
  batchSize?: number,
): Promise<ContractReadResult[]> {
  if (chainInfo(chainId).chain.contracts?.multicall3?.address) {
    return c.multicall({
      allowFailure: true,
      ...(batchSize !== undefined ? { batchSize } : {}),
      contracts: contracts as never,
    }) as Promise<ContractReadResult[]>;
  }

  const results: ContractReadResult[] = [];
  // A manually tracked list can still be long. Bound parallel requests so an
  // owner-operated node is not flooded just because it has no Multicall3.
  for (let start = 0; start < contracts.length; start += 16) {
    const batch = await Promise.all(contracts.slice(start, start + 16).map(async (contract) => {
      try {
        return { status: 'success' as const, result: await c.readContract(contract as never) };
      } catch (error) {
        return { status: 'failure' as const, error };
      }
    }));
    results.push(...batch);
  }
  return results;
}

/**
 * Keep the house token visible even when a live/cached holdings list omits
 * zero balances. This is a DISPLAY fallback, not an onchain claim used for
 * signing: a later sweep replaces it with the balance the contract returns.
 *
 * Match the canonical contract, never the symbol. Anyone can deploy a token
 * called `$RAD`; its label must not earn the house-token treatment.
 */
export function withRadBalance(rows: TokenBalance[]): TokenBalance[] {
  const found = rows.findIndex((b) =>
    (b.chainId ?? 1) === 1 && b.address?.toLowerCase() === RAD_KEY,
  );
  if (found >= 0) {
    const canonical = rows[found];
    const normalized: TokenBalance = {
      ...canonical,
      symbol: RAD_TOKEN.symbol,
      name: RAD_TOKEN.name,
      decimals: RAD_TOKEN.decimals,
      address: RAD_TOKEN.address,
      chainId: 1,
    };
    return [...rows.slice(0, found), normalized, ...rows.slice(found + 1)];
  }

  const zero: TokenBalance = {
    ...RAD_TOKEN,
    amount: '0',
    raw: 0n,
    chainId: 1,
  };
  const mainnetNative = rows.findIndex((b) => (b.chainId ?? 1) === 1 && !b.address);
  const at = mainnetNative >= 0 ? mainnetNative + 1 : rows.length;
  return [...rows.slice(0, at), zero, ...rows.slice(at)];
}

export async function sweepBalances(
  endpoint: string,
  chainId: number,
  address: `0x${string}`,
  extra: KnownToken[] = [],
): Promise<TokenBalance[]> {
  const c = chainClient(endpoint, chainId);
  const info = chainInfo(chainId);
  // one malformed address fails the entire multicall batch, taking every other
  // balance with it — so bad entries are dropped, not trusted
  const list = usableTokens([...(TOKENS[chainId] ?? []), ...extra]);

  const [native, balances] = await Promise.all([
    c.getBalance({ address }),
    list.length
      ? readContracts(c, chainId, list.map((t) => ({
        address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [address],
      })),
        // viem chunks multicall calldata at 1KB by default, which is about 25
        // balanceOf calls — so the bundled list quietly became 16 round trips
        // per refresh once it grew. Measured on every endpoint we ship: 396
        // tokens go through as ONE eth_call at this size, and faster.
        16_384)
      : Promise.resolve([]),
  ]).catch((e) => { throw new Error((e as Error).message.split('\n')[0]); });

  const out: TokenBalance[] = [{
    symbol: info.nativeSymbol,
    name: 'Ether',
    amount: formatAmount(formatEther(native)),
    raw: native,
    decimals: 18,
    chainId,
  }];
  balances.forEach((r, i) => {
    if (r.status !== 'success') return;
    const t = list[i];
    const raw = r.result as bigint;
    if (raw === 0n && !(chainId === 1 && t.address.toLowerCase() === RAD_KEY)) return;
    out.push({
      symbol: t.symbol,
      name: t.name,
      amount: formatAmount(formatUnits(raw, t.decimals)),
      raw,
      decimals: t.decimals,
      address: t.address,
      chainId,
    });
  });
  return out;
}

/** one chain's slice of a multi-chain sweep, including how it failed */
export interface ChainSweep {
  chainId: number;
  balances: TokenBalance[];
  error?: string;
}

/**
 * Sweep several chains at once, each through its OWN endpoint.
 *
 * Splitting the read across chains is not just for coverage: no single
 * endpoint gets to see your whole footprint. A chain that fails comes back
 * carrying its error rather than taking the others down — a dead RPC on one
 * chain must never blank the balances you do have.
 */
export async function sweepChains(
  endpointsFor: (chainId: number) => string[],
  address: `0x${string}`,
  chainIds: number[] = SCAN_CHAIN_IDS,
  extra: Record<number, KnownToken[]> = {},
): Promise<ChainSweep[]> {
  const results = await Promise.allSettled(
    chainIds.map((id) => withFailover(endpointsFor(id), (ep) => sweepBalances(ep, id, address, extra[id] ?? []))),
  );
  return chainIds.map((chainId, i) => {
    const r = results[i];
    return r.status === 'fulfilled'
      ? { chainId, balances: r.value }
      : { chainId, balances: [], error: (r.reason as Error).message.split('\n')[0] };
  });
}

/**
 * Try each endpoint in turn until one answers.
 *
 * Accounts are pinned to an endpoint by address hash so that no single node
 * sees your whole address set — but that pinning meant one slow endpoint made
 * one wallet permanently look broken while its neighbours were fine (switching
 * accounts appeared to "fix" it, because it moved you to a different node).
 * The pool is there to be failed over to; this is where that happens.
 */
export async function withFailover<T>(
  endpoints: string[],
  run: (endpoint: string) => Promise<T>,
): Promise<T> {
  const list = endpoints.length ? endpoints : [''];
  let last: unknown;
  for (const ep of list) {
    try {
      return await run(ep);
    } catch (e) {
      last = e;
    }
  }
  const msg = last instanceof Error ? last.message.split('\n')[0] : String(last);
  throw new Error(
    list.length > 1 ? `all ${list.length} endpoints failed — last said: ${msg}` : msg,
  );
}

/**
 * Identify an ERC-20 the user pasted in, so it can join the bundled list.
 * Refuses anything that cannot answer the three questions that make a token a
 * token — a contract that will not say its own decimals cannot be shown as a
 * balance without lying about the amount.
 */
export async function probeToken(
  endpoint: string,
  chainId: number,
  address: string,
  owner: `0x${string}`,
): Promise<{ token: KnownToken; balance: TokenBalance } | null> {
  const addr = normalizeContract(address);
  if (!addr) throw new Error('that is not a valid address, bro — check the checksum');
  const c = chainClient(endpoint, chainId);
  const [sym, name, dec, bal] = await readContracts(c, chainId, [
    { address: addr, abi: erc20Abi, functionName: 'symbol' },
    { address: addr, abi: erc20Abi, functionName: 'name' },
    { address: addr, abi: erc20Abi, functionName: 'decimals' },
    { address: addr, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
  ]);
  if (sym.status !== 'success' || dec.status !== 'success' || bal.status !== 'success') return null;
  const decimals = Number(dec.result);
  const raw = bal.result as bigint;
  const token: KnownToken = {
    address: addr,
    symbol: sym.result as string,
    name: name.status === 'success' ? (name.result as string) : (sym.result as string),
    decimals,
  };
  return {
    token,
    balance: {
      ...token, amount: formatAmount(formatUnits(raw, decimals)), raw, chainId,
    },
  };
}

/**
 * Read a list of discovered token contracts back OFF THE CHAIN.
 *
 * An indexer hands us addresses; this is what turns them into rows. Symbol,
 * name, decimals and the balance all come from the contract itself through the
 * user's own RPC, in one multicall per batch of 50 when the chain has one —
 * so a provider that lies about what you hold produces a contract that answers
 * 0, not a fake balance, and a provider that lies about decimals cannot make
 * 1 USDC read as a million.
 * Anything that will not answer `decimals` and `balanceOf` is dropped: a
 * balance shown without decimals is a wrong number, not a partial one.
 */
export async function readTokens(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  addresses: `0x${string}`[],
): Promise<TokenBalance[]> {
  const list = [...new Set(addresses.map((a) => normalizeContract(a)).filter(Boolean) as `0x${string}`[])];
  if (!list.length) return [];
  const c = chainClient(endpoint, chainId);
  const out: TokenBalance[] = [];
  // batched rather than capped: one multicall per 50 contracts, so a long tail
  // costs more round trips but is never silently truncated
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const res = await readContracts(c, chainId, batch.flatMap((address) => [
      { address, abi: erc20Abi, functionName: 'symbol' },
      { address, abi: erc20Abi, functionName: 'name' },
      { address, abi: erc20Abi, functionName: 'decimals' },
      { address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
    ]));
    batch.forEach((address, j) => {
      const [sym, name, dec, bal] = res.slice(j * 4, j * 4 + 4);
      if (dec.status !== 'success' || bal.status !== 'success') return;
      const raw = bal.result as bigint;
      if (raw === 0n) return;
      const decimals = Number(dec.result);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return;
      const symbol = sym.status === 'success' ? String(sym.result) : '???';
      out.push({
        symbol,
        name: name.status === 'success' ? String(name.result) : symbol,
        amount: formatAmount(formatUnits(raw, decimals)),
        raw,
        decimals,
        address,
        chainId,
      });
    });
  }
  return out;
}

/** Forward ENS: "bro.eth" -> address (mainnet resolver, via the user's pool). */
export async function resolveEns(endpoint: string, name: string): Promise<`0x${string}` | null> {
  try {
    return await chainClient(endpoint, 1).getEnsAddress({ name: normalize(name) });
  } catch {
    return null;
  }
}

/** Reverse ENS: address -> primary name, or null. */
export async function lookupEns(endpoint: string, address: `0x${string}`): Promise<string | null> {
  try {
    return await chainClient(endpoint, 1).getEnsName({ address });
  } catch {
    return null;
  }
}

/**
 * Four decimals is plenty for a balance row, but a dust balance must not
 * render as a flat "0" — a row saying you hold zero of something you actually
 * hold is a lie, and it is exactly what a scam airdrop looks like.
 */
export function formatAmount(s: string): string {
  const [i, f = ''] = s.split('.');
  const ff = f.slice(0, 4).replace(/0+$/, '');
  if (!ff) {
    return i === '0' && /[1-9]/.test(f) ? '<0.0001' : i;
  }
  return `${i}.${ff}`;
}
