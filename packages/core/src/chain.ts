/**
 * Chain client: balances, transaction preview (local simulation), send.
 * All reads go through the account's own pool endpoint (see rpc.ts).
 * A transaction is never signed before the user has seen the simulated
 * IN/OUT effect — "check the chain" is a UI guarantee, not a slogan.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  erc20Abi,
  formatUnits,
  keccak256,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import type { SignerAccount } from './keyring.js';
import { chainInfo } from './chains.js';

export interface TokenBalance {
  symbol: string;
  name: string;
  amount: string;
  raw: bigint;
  decimals: number;
  address?: `0x${string}`;
  /** which chain this balance was read from, for the multi-chain sweep */
  chainId?: number;
}

export interface TxPreview {
  out: { asset: string; amount: string; usd?: string }[];
  in_: { asset: string; amount: string; usd?: string }[];
  gasEth: string;
  gasWei: bigint;
  ok: boolean;
  error?: string;
}

/** $RAD — Radcoin, the ecosystem token. Bundled locally, not fetched. */
export const RAD_TOKEN = {
  address: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB' as `0x${string}`,
  symbol: '$RAD',
  name: 'Radcoin',
  decimals: 18,
};

export function client(endpoint: string): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(endpoint), ccipRead: false });
}

/**
 * Ask an endpoint which chain it is actually on. Null = it did not answer.
 *
 * An endpoint in the wrong chain's pool does not look broken, it looks like a
 * wallet with the wrong balances in it — and a transaction built against those
 * numbers gets signed for the wrong network. So a user-added endpoint is asked
 * before it is trusted, on its own, with no retry: this runs while someone is
 * waiting on a button.
 */
export async function probeChainId(endpoint: string, timeoutMs = 6000): Promise<number | null> {
  try {
    const c = createPublicClient({
      transport: http(endpoint, { timeout: timeoutMs, retryCount: 0 }),
      ccipRead: false,
    });
    return await c.getChainId();
  } catch {
    return null;
  }
}

export async function nativeBalance(endpoint: string, address: `0x${string}`): Promise<TokenBalance> {
  const raw = await client(endpoint).getBalance({ address });
  return { symbol: 'ETH', name: 'Ether', amount: trim(formatEther(raw)), raw, decimals: 18 };
}

export async function radBalance(endpoint: string, address: `0x${string}`): Promise<TokenBalance> {
  const raw = await client(endpoint).readContract({
    address: RAD_TOKEN.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  return {
    symbol: RAD_TOKEN.symbol,
    name: RAD_TOKEN.name,
    amount: trim(formatUnits(raw, RAD_TOKEN.decimals)),
    raw,
    decimals: RAD_TOKEN.decimals,
    address: RAD_TOKEN.address,
  };
}

/** Simulate a plain ETH transfer locally before anything is signed. */
export async function previewSend(
  endpoint: string,
  from: `0x${string}`,
  to: `0x${string}`,
  ethAmount: string,
): Promise<TxPreview> {
  const c = client(endpoint);
  try {
    const value = parseEther(ethAmount);
    const [gas, gasPrice] = await Promise.all([
      c.estimateGas({ account: from, to, value }),
      c.getGasPrice(),
    ]);
    const gasWei = gas * gasPrice;
    return {
      out: [{ asset: 'ETH', amount: ethAmount }],
      in_: [{ asset: `ETH → ${to.slice(0, 6)}…${to.slice(-4)}`, amount: ethAmount }],
      gasEth: trim(formatEther(gasWei)),
      gasWei,
      ok: true,
    };
  } catch (e) {
    return {
      out: [],
      in_: [],
      gasEth: '0',
      gasWei: 0n,
      ok: false,
      error: e instanceof Error ? e.message.split('\n')[0] : String(e),
    };
  }
}

export async function sendEth(
  endpoint: string,
  account: SignerAccount,
  to: `0x${string}`,
  ethAmount: string,
): Promise<`0x${string}`> {
  const wc = createWalletClient({ account, chain: mainnet, transport: http(endpoint) });
  return wc.sendTransaction({ account, to, value: parseEther(ethAmount), chain: mainnet });
}

/** A dapp-supplied transaction request (EIP-1193 eth_sendTransaction param). */
export interface DappTxRequest {
  from?: `0x${string}`;
  to?: `0x${string}`;
  value?: `0x${string}` | bigint;
  data?: `0x${string}`;
  gas?: `0x${string}`;
  /**
   * Replacement fields, for speeding up or cancelling a stuck transaction.
   *
   * These are WALLET-INTERNAL. A dapp that could pick its own nonce could
   * replace a transaction you already signed — quietly swapping a send for
   * something else at the same nonce — so `sanitizeDappTx` strips them from
   * anything arriving over the provider. Hex strings, not bigints, because
   * these cross the extension's message boundary.
   */
  nonce?: number;
  maxFeePerGas?: `0x${string}`;
  maxPriorityFeePerGas?: `0x${string}`;
}

/**
 * Strip the fields only the wallet itself may set. Everything a dapp sends
 * goes through here before it reaches a signer.
 */
export function sanitizeDappTx(tx: DappTxRequest): DappTxRequest {
  const { nonce, maxFeePerGas, maxPriorityFeePerGas, ...safe } = tx;
  void nonce; void maxFeePerGas; void maxPriorityFeePerGas;
  return safe;
}

function txValue(v: DappTxRequest['value']): bigint {
  if (v === undefined) return 0n;
  return typeof v === 'bigint' ? v : BigInt(v);
}

/** Simulate an arbitrary dapp transaction before the user signs anything. */
export async function previewDappTx(
  endpoint: string,
  from: `0x${string}`,
  tx: DappTxRequest,
  chainId = 1,
): Promise<TxPreview> {
  const c = createPublicClient({ chain: chainInfo(chainId).chain, transport: http(endpoint), ccipRead: false });
  const value = txValue(tx.value);
  try {
    // eth_call first: surfaces reverts with reasons that estimateGas hides
    await c.call({ account: from, to: tx.to, value, data: tx.data });
    const [gas, gasPrice] = await Promise.all([
      c.estimateGas({ account: from, to: tx.to, value, data: tx.data }),
      c.getGasPrice(),
    ]);
    const gasWei = gas * gasPrice;
    const out = [];
    if (value > 0n) out.push({ asset: 'ETH', amount: formatEther(value) });
    return {
      out,
      in_: tx.to
        ? [{ asset: `call → ${tx.to.slice(0, 6)}…${tx.to.slice(-4)}${tx.data ? ` (${tx.data.length / 2 - 1} bytes)` : ''}`, amount: '' }]
        : [{ asset: 'contract deployment', amount: '' }],
      gasEth: formatEther(gasWei),
      gasWei,
      ok: true,
    };
  } catch (e) {
    return {
      out: [],
      in_: [],
      gasEth: '0',
      gasWei: 0n,
      ok: false,
      error: e instanceof Error ? e.message.split('\n')[0] : String(e),
    };
  }
}

async function broadcastRawDappTx(
  endpoint: string,
  raw: `0x${string}`,
  chainId: number,
): Promise<`0x${string}`> {
  const wc = createWalletClient({
    chain: chainInfo(chainId).chain,
    transport: http(endpoint, { timeout: 30_000 }),
  });
  const hash = keccak256(raw);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await wc.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/already known|already imported|same hash/i.test(msg)) return hash;
      if (/nonce too low/i.test(msg)) {
        const found = await wc.request({
          method: 'eth_getTransactionByHash',
          params: [hash],
        } as never).catch(() => null) as { hash?: string } | null;
        if (found?.hash?.toLowerCase() === hash.toLowerCase()) return hash;
        throw e;
      }
      if (!/took too long|timed out|timeout/i.test(msg)) throw e;
    }
  }
  throw lastErr;
}

/** Sign and broadcast a dapp transaction (after the user approved the preview). */
export async function sendDappTx(
  endpoint: string,
  account: SignerAccount,
  tx: DappTxRequest,
  chainId = 1,
): Promise<`0x${string}`> {
  const chain = chainInfo(chainId).chain;
  // Sign once, then broadcast the SAME bytes with patience and retries.
  // viem's transport deliberately never retries eth_sendRawTransaction
  // (verified in a fetch log: one attempt, then the abort) — right for a
  // transport that cannot know two attempts are the same transaction, but
  // here they provably are: identical bytes, identical hash. And the timeout
  // is generous on purpose: an anvil mainnet fork (a first-class endpoint in
  // this wallet) was measured taking ~60 SECONDS to answer a broadcast while
  // its rate-limited upstream stalled the miner — the node was fine, the
  // transaction mined, and the only failure was every client that hung up
  // early. Four 30s attempts outwait that stall with room to spare; a real
  // network answers in milliseconds and never feels the difference. A first
  // attempt whose RESPONSE was the only casualty makes the node call the
  // rebroadcast a duplicate — a success wearing an error message, which is
  // why the hash is computed from the bytes before any attempt.
  const wc = createWalletClient({ account, chain, transport: http(endpoint, { timeout: 30_000 }) });
  const prepared = await wc.prepareTransactionRequest({
    account,
    chain,
    to: tx.to,
    value: txValue(tx.value),
    data: tx.data,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
    // a replacement reuses the stuck transaction's nonce on purpose
    nonce: tx.nonce,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
  } as never);
  const raw = await wc.signTransaction(prepared as never);
  return broadcastRawDappTx(endpoint, raw, chainId);
}

function trim(s: string): string {
  const [i, f = ''] = s.split('.');
  const ff = f.slice(0, 4).replace(/0+$/, '');
  return ff ? `${i}.${ff}` : i;
}
