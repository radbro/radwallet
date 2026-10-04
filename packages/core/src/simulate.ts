/**
 * WHAT THIS TRANSACTION ACTUALLY MOVES.
 *
 * `previewDappTx` answers "does it revert, and what does it cost" — which is
 * necessary and not sufficient. A swap looks like `call → 0x8876…0904 (1518
 * bytes)` and tells you nothing about the two assets changing hands. This
 * module answers the question people actually have before signing: what leaves
 * this wallet, and what arrives.
 *
 * HOW, WITHOUT A SERVER. `eth_simulateV1` executes the call against the real
 * head state and hands back the LOGS it would emit. Every ERC-20 and ERC-721
 * movement is a `Transfer` event, and with `traceTransfers: true` the node
 * synthesises the same shape for native ETH under the sentinel address
 * 0xeee…eee. So one round trip yields the complete picture, decoded here, with
 * nobody's API key and nobody's server.
 *
 * Measured support across the endpoints this wallet ships (the method is
 * recent, and older nodes simply do not have it):
 *
 *   ethereum-rpc.publicnode.com      YES      eth.drpc.org        no
 *   base-rpc.publicnode.com          YES      base.drpc.org       no
 *   mainnet.base.org                 YES      rpc.flashbots.net   no
 *   arbitrum-one-rpc.publicnode.com  YES
 *   rpc.mainnet.chain.robinhood.com  YES
 *
 * At least one endpoint per chain can do it, which is why callers should reach
 * this through the pool's failover rather than the pinned endpoint alone. When
 * nothing can, this returns null — never an empty move list, because "nothing
 * moves" and "we could not find out" must not look the same to someone about
 * to sign.
 *
 * These are the transfers the CURRENT state produces. A transaction is not a
 * promise: state can change before it lands, and a contract can behave
 * differently when it does. The UI says so rather than presenting this as a
 * guarantee.
 */
import { formatUnits, getAddress } from 'viem';
import type { DappTxRequest } from './chain.js';
import { chainClient } from './tokens.js';
import { TOKENS, normalizeContract, type KnownToken } from './chains.js';

/** keccak256('Transfer(address,address,uint256)') */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * The address `eth_simulateV1` reports native ETH movement under when
 * traceTransfers is on. It is not a contract; it is a sentinel.
 */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export interface AssetMove {
  kind: 'native' | 'erc20' | 'erc721';
  /** null for native */
  address: `0x${string}` | null;
  symbol: string;
  name: string;
  decimals: number;
  /** signed and netted: negative leaves this wallet, positive arrives */
  raw: bigint;
  /** formatted, unsigned — the sign is `raw` and the UI draws an arrow */
  amount: string;
  /** for ERC-721, the ids that moved */
  tokenIds: string[];
}

export interface SimResult {
  ok: boolean;
  /** the revert reason, when the call fails */
  reverted?: string;
  gasUsed: bigint;
  /** netted per asset, biggest movement first; empty means nothing moved */
  moves: AssetMove[];
}

export interface SimLog { address: string; topics: string[]; data: string }

export interface NetSlot {
  raw: bigint;
  ids: Map<string, bigint>;
  erc721: boolean;
}

const erc20Meta = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const addrFromTopic = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();

/**
 * Net every Transfer in `logs` that touches `owner`, per asset contract.
 * Canned logs test this pure calculation without a live node.
 */
export function netTransfers(logs: SimLog[], owner: string): Map<string, NetSlot> {
  const me = owner.toLowerCase();
  const netted = new Map<string, NetSlot>();
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER) continue;
    // 3 topics => ERC-20 (amount in data); 4 => ERC-721 (id indexed)
    const erc721 = log.topics.length === 4;
    const from = addrFromTopic(log.topics[1] ?? '');
    const to = addrFromTopic(log.topics[2] ?? '');
    if (from !== me && to !== me) continue;
    if (from === me && to === me) continue; // to yourself: nothing changes

    const key = log.address.toLowerCase();
    const slot = netted.get(key) ?? { raw: 0n, ids: new Map<string, bigint>(), erc721 };
    slot.erc721 = slot.erc721 || erc721;
    const sign = from === me ? -1n : 1n;
    if (erc721) {
      const id = BigInt(log.topics[3] ?? '0x0').toString();
      slot.ids.set(id, (slot.ids.get(id) ?? 0n) + sign);
      slot.raw += sign;
    } else {
      const amount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n;
      slot.raw += sign * amount;
    }
    netted.set(key, slot);
  }
  return netted;
}

/**
 * Run the transaction against head state and net every asset that moves for
 * `owner`. Returns null when this endpoint cannot simulate.
 */
export async function simulateTx(
  endpoint: string,
  chainId: number,
  owner: `0x${string}`,
  tx: DappTxRequest,
): Promise<SimResult | null> {
  const c = chainClient(endpoint, chainId, 20_000);
  // a dapp may hand `value` over as a bigint or as hex; the node wants hex
  const hexValue = typeof tx.value === 'bigint'
    ? `0x${tx.value.toString(16)}`
    : tx.value;
  const call: Record<string, string> = { from: tx.from ?? owner };
  if (tx.to) call.to = tx.to;
  if (tx.data) call.data = tx.data;
  if (hexValue && hexValue !== '0x0' && hexValue !== '0x') call.value = hexValue;

  let res: any;
  try {
    res = await (c as any).request({
      method: 'eth_simulateV1',
      params: [
        {
          blockStateCalls: [{ calls: [call] }],
          traceTransfers: true,
          // the point is what it DOES, not whether this wallet could pay for
          // it right now — gas is priced separately by previewDappTx
          validation: false,
        },
        'latest',
      ],
    });
  } catch {
    return null; // method absent, or the node refused: caller keeps the old preview
  }

  const first = res?.[0]?.calls?.[0];
  if (!first) return null;
  const ok = first.status === '0x1';
  const gasUsed = BigInt(first.gasUsed ?? '0x0');
  if (!ok) {
    return { ok, gasUsed, reverted: decodeRevert(first), moves: [] };
  }

  // ---- net every Transfer for the signer --------------------------------
  const logs = (first.logs ?? []) as SimLog[];
  const netted = netTransfers(logs, owner);

  // ---- name what moved --------------------------------------------------
  const known = new Map(
    (TOKENS[chainId] ?? []).map((t) => [t.address.toLowerCase(), t]),
  );
  const unknown = [...netted.keys()].filter(
    (a) => a !== NATIVE_SENTINEL && !known.has(a),
  );
  const fetched = new Map<string, { symbol: string; name: string; decimals: number }>();
  if (unknown.length) {
    const usable = unknown.map((a) => normalizeContract(a)).filter(Boolean) as `0x${string}`[];
    const reads = await c.multicall({
      allowFailure: true,
      batchSize: 16_384,
      contracts: usable.flatMap((address) => [
        { address, abi: erc20Meta, functionName: 'symbol' } as const,
        { address, abi: erc20Meta, functionName: 'name' } as const,
        { address, abi: erc20Meta, functionName: 'decimals' } as const,
      ]),
    }).catch(() => []);
    usable.forEach((address, i) => {
      const sym = reads[i * 3];
      const name = reads[i * 3 + 1];
      const dec = reads[i * 3 + 2];
      const symbol = sym?.status === 'success' ? String(sym.result) : '???';
      fetched.set(address.toLowerCase(), {
        symbol,
        name: name?.status === 'success' ? String(name.result) : symbol,
        // an NFT has no decimals(); 0 is the right scale for a token id anyway
        decimals: dec?.status === 'success' ? Number(dec.result) : 0,
      });
    });
  }

  const build = (net: Map<string, NetSlot>): AssetMove[] => {
    const moves: AssetMove[] = [];
    for (const [address, slot] of net) {
      if (slot.raw === 0n && !slot.erc721) continue; // in and out cancelled exactly
      if (address === NATIVE_SENTINEL) {
        moves.push({
          kind: 'native', address: null, symbol: 'ETH', name: 'Ether', decimals: 18,
          raw: slot.raw, amount: formatUnits(abs(slot.raw), 18), tokenIds: [],
        });
        continue;
      }
      const meta = known.get(address) ?? fetched.get(address);
      const ids = [...slot.ids.entries()].filter(([, n]) => n !== 0n).map(([id]) => id);
      if (slot.erc721) {
        if (!ids.length) continue;
        moves.push({
          kind: 'erc721',
          address: getAddress(address),
          symbol: meta?.symbol ?? '???',
          name: meta?.name ?? meta?.symbol ?? '???',
          decimals: 0,
          raw: slot.raw,
          amount: String(ids.length),
          tokenIds: ids,
        });
        continue;
      }
      moves.push({
        kind: 'erc20',
        address: getAddress(address),
        symbol: meta?.symbol ?? '???',
        name: meta?.name ?? meta?.symbol ?? '???',
        decimals: meta?.decimals ?? 18,
        raw: slot.raw,
        amount: formatUnits(abs(slot.raw), meta?.decimals ?? 18),
        tokenIds: [],
      });
    }
    // what leaves first, then what arrives: the order people read a trade in
    moves.sort((a, b) => (a.raw < 0n && b.raw >= 0n ? -1 : a.raw >= 0n && b.raw < 0n ? 1 : 0));
    return moves;
  };

  return { ok, gasUsed, moves: build(netted) };
}

/**
 * ERC-20 contracts a swap-like transaction would deliver to this wallet.
 *
 * A positive token movement alone may be a claim, mint or unsolicited asset;
 * it is not enough to call the transaction a swap. Something else must leave
 * the wallet in the same simulation. The result contains only metadata the
 * token itself answered onchain and is safe to persist as a custom scan target.
 */
export function swapOutputTokens(moves: AssetMove[]): KnownToken[] {
  if (!moves.some((move) => move.raw < 0n)) return [];
  const seen = new Set<string>();
  const tokens: KnownToken[] = [];
  for (const move of moves) {
    if (move.kind !== 'erc20' || move.raw <= 0n || !move.address) continue;
    const address = normalizeContract(move.address);
    const symbol = move.symbol.trim();
    const name = move.name.trim() || symbol;
    if (!address || !symbol || symbol === '???' || !Number.isInteger(move.decimals)
      || move.decimals < 0 || move.decimals > 255) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ address, symbol, name, decimals: move.decimals });
  }
  return tokens;
}

/** Add scan targets without duplicating contracts already tracked or bundled. */
export function mergeTrackedTokens(
  existing: KnownToken[], candidates: KnownToken[], bundled: KnownToken[] = [],
): KnownToken[] {
  const seen = new Set(
    [...existing, ...bundled].map((token) => token.address.toLowerCase()),
  );
  const merged = [...existing];
  for (const candidate of candidates) {
    const address = normalizeContract(candidate.address);
    const symbol = String(candidate.symbol ?? '').trim();
    const name = String(candidate.name ?? '').trim() || symbol;
    const decimals = Number(candidate.decimals);
    if (!address || !symbol || symbol === '???' || !Number.isInteger(decimals)
      || decimals < 0 || decimals > 255) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ address, symbol, name, decimals });
  }
  return merged;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** the revert string, when the node gives one back */
function decodeRevert(call: { returnData?: string; error?: { message?: string } }): string {
  const msg = call.error?.message;
  if (msg) return String(msg).slice(0, 140);
  const data = call.returnData;
  if (!data || data.length < 138) return 'reverted';
  try {
    // Error(string): 0x08c379a0 + offset + length + utf8
    if (!data.startsWith('0x08c379a0')) return 'reverted';
    const len = parseInt(data.slice(74, 138), 16);
    const hex = data.slice(138, 138 + len * 2);
    const text = hex.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
    return text || 'reverted';
  } catch {
    return 'reverted';
  }
}
