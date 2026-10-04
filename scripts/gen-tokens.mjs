/**
 * Regenerate the bundled token list — packages/core/src/tokenlist.ts.
 *
 * Run: node scripts/gen-tokens.mjs      (needs network; nothing else does)
 *
 * WHY A GENERATOR AND NOT A FETCH. The wallet ships its token list because
 * asking a list server at runtime tells that server your IP every time you
 * open your wallet, and a list server that lies can put a fake USDC in front
 * of you. So the network cost is paid HERE, once, by whoever regenerates it,
 * and the result is committed and reviewable in a diff.
 *
 * WHERE THE ADDRESSES COME FROM. The Uniswap Labs Default list — the same one
 * their interface ships — which covers every mainnet this wallet scans,
 * Robinhood Chain included.
 *
 * WHY IT IS RE-READ FROM THE CHAIN. A list is a claim; the chain is the fact.
 * Every candidate is asked for its own symbol and decimals, and:
 *
 *   - anything that will not answer `decimals()` is dropped. A token whose
 *     decimals we cannot read is a token we would render at the wrong scale,
 *     and a wrong number is worse than a missing row.
 *   - where the list and the chain disagree, THE CHAIN WINS, and the
 *     disagreement is printed so a human can look at it.
 *   - addresses go through the same EIP-55 gate as everything else, because
 *     one malformed entry fails an entire multicall batch and takes every
 *     other balance on that chain down with it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, getAddress } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'packages/core/src/tokenlist.ts');
const SOURCE = 'https://tokens.uniswap.org';

// the chains this wallet can actually sweep, and one endpoint each to verify
// against. Deliberately not read from chains.ts: this script must keep working
// while that file is being edited.
const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com' },
  8453: { name: 'Base', rpc: 'https://base-rpc.publicnode.com' },
  42161: { name: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc' },
  4663: { name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
};
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const erc20 = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

/**
 * A symbol we would be willing to put on screen, or null.
 *
 * Some older tokens (MKR is the famous one) declare `symbol()` as bytes32
 * rather than string, so reading it as a string hands back 64 hex characters —
 * `4d4b5200…` is "MKR" wearing a disguise. Decode that back; refuse anything
 * else that is not short printable text, and let the curated list stand.
 */
function sane(sym) {
  if (!sym) return null;
  let s = sym;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    s = Buffer.from(s, 'hex').toString('utf8').replace(/\u0000+$/, '');
  }
  s = s.replace(/\u0000/g, '').trim();
  if (!s || s.length > 20) return null;
  // printable ASCII only: a symbol is a label, not a payload
  if (!/^[\x20-\x7E]+$/.test(s)) return null;
  return s;
}

/** the EIP-55 gate, same rule as normalizeContract in chains.ts */
function normalize(address) {
  if (typeof address !== 'string') return null;
  const raw = address.trim();
  const lower = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return null;
  const body = raw.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  const checksummed = getAddress(lower);
  if (mixed && raw !== checksummed) return null;
  return checksummed;
}

const listed = await fetch(SOURCE).then((r) => r.json());
const version = `${listed.version.major}.${listed.version.minor}.${listed.version.patch}`;
console.log(`source: ${listed.name} v${version} — ${listed.tokens.length} tokens\n`);

const out = {};
let totalDropped = 0;

for (const [id, chain] of Object.entries(CHAINS)) {
  const chainId = Number(id);
  const candidates = [];
  let badAddress = 0;
  for (const t of listed.tokens) {
    if (t.chainId !== chainId) continue;
    const address = normalize(t.address);
    if (!address) { badAddress++; continue; }
    candidates.push({ address, symbol: t.symbol, name: t.name, decimals: t.decimals });
  }

  const client = createPublicClient({
    transport: http(chain.rpc, { timeout: 30_000, retryCount: 1 }),
    chain: { id: chainId, name: chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.rpc] } }, contracts: { multicall3: { address: MULTICALL3 } } },
  });
  const reads = await client.multicall({
    allowFailure: true,
    batchSize: 16_384,
    contracts: candidates.flatMap((t) => [
      { address: t.address, abi: erc20, functionName: 'symbol' },
      { address: t.address, abi: erc20, functionName: 'decimals' },
    ]),
  });

  const kept = [];
  const notes = [];
  candidates.forEach((t, i) => {
    const sym = reads[i * 2];
    const dec = reads[i * 2 + 1];
    if (dec?.status !== 'success') { notes.push(`  DROPPED ${t.symbol} ${t.address} — no decimals()`); return; }
    const onChainDecimals = Number(dec.result);
    const onChainSymbol = sane(sym?.status === 'success' ? String(sym.result) : null);
    if (onChainDecimals !== t.decimals) {
      notes.push(`  decimals: list says ${t.decimals}, chain says ${onChainDecimals} for ${t.symbol} — using the chain`);
    }
    if (onChainSymbol && onChainSymbol !== t.symbol) {
      notes.push(`  symbol: list says ${t.symbol}, chain says ${onChainSymbol} — using the chain`);
    }
    kept.push({
      address: t.address,
      symbol: onChainSymbol || t.symbol,
      name: t.name,
      decimals: onChainDecimals,
    });
  });

  // deterministic order so a regenerated file diffs cleanly
  kept.sort((a, b) => (a.symbol === b.symbol ? a.address.localeCompare(b.address) : a.symbol.localeCompare(b.symbol)));
  out[chainId] = kept;
  const dropped = candidates.length - kept.length + badAddress;
  totalDropped += dropped;
  console.log(`${chain.name.padEnd(10)} ${String(kept.length).padStart(3)} verified · ${dropped} dropped${badAddress ? ` (${badAddress} bad checksum)` : ''}`);
  for (const n of notes.slice(0, 8)) console.log(n);
  if (notes.length > 8) console.log(`  …and ${notes.length - 8} more`);
}

const body = Object.entries(out).map(([id, toks]) => {
  const rows = toks.map((t) => `  { address: '${t.address}', symbol: ${JSON.stringify(t.symbol)}, name: ${JSON.stringify(t.name)}, decimals: ${t.decimals} },`).join('\n');
  return `  ${id}: [\n${rows.split('\n').map((l) => '  ' + l).join('\n')}\n  ],`;
}).join('\n');

writeFileSync(OUT, `/**
 * GENERATED — do not edit by hand. Run \`node scripts/gen-tokens.mjs\`.
 *
 * Bundled token lists, one per chain this wallet sweeps. Source: the Uniswap
 * Labs Default list (v${version}), with every entry then RE-READ FROM THE CHAIN
 * for its symbol and decimals — the list is a claim, the chain is the fact, and
 * anything that would not answer \`decimals()\` was dropped rather than
 * rendered at a guessed scale.
 *
 * Nothing here is fetched at runtime. Asking a list server when the wallet
 * opens would hand it your IP, and a list server that lies could put a
 * convincing fake USDC in front of you.
 */
import type { KnownToken } from './chains.js';

export const VERIFIED_TOKENS: Record<number, KnownToken[]> = {
${body}
};
`);
console.log(`\nwrote ${OUT.replace(root + '/', '')} — ${Object.values(out).reduce((n, l) => n + l.length, 0)} tokens, ${totalDropped} dropped`);
