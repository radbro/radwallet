/**
 * RADSWAP — direct Uniswap V3 routing, built client-side against the user's
 * own RPC. There is no aggregator API, no API key, and no fee address:
 * the only fee in the route is the pool's LP fee, which goes to LPs.
 * Wallet fee: 0.00%. Forever. (grep this file for a fee transfer; there is none.)
 */
import {
  encodeFunctionData,
  decodeFunctionResult,
  parseEther,
  formatUnits,
  type PublicClient,
} from 'viem';
import { createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import type { SignerAccount } from './keyring.js';
import { client, RAD_TOKEN } from './chain.js';

// canonical mainnet deployments (bundled, not fetched)
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;
export const UNIV3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984' as const;
export const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;
export const SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;

const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface SwapQuote {
  amountInEth: string;
  amountOut: bigint;
  amountOutFormatted: string;
  feeTier: number; // e.g. 3000 = 0.30%
  feeTierPct: string;
  minOut: bigint;
  minOutFormatted: string;
  slippagePct: number;
}

/** minOut after slippage, in basis points of tolerance. Pure — unit tested. */
export function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100)); // 1.0% -> 100 bps
  return (amountOut * (10_000n - bps)) / 10_000n;
}

const tierCache = new Map<string, number>();

/** Find the RAD/WETH pool fee tier (cached per endpoint). */
export async function discoverFeeTier(endpoint: string): Promise<number> {
  const hit = tierCache.get(endpoint);
  if (hit) return hit;
  const c = client(endpoint);
  for (const fee of [10_000, 3_000, 500]) {
    const pool = await c.readContract({
      address: UNIV3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [WETH, RAD_TOKEN.address, fee],
    });
    if (pool !== '0x0000000000000000000000000000000000000000') {
      tierCache.set(endpoint, fee);
      return fee;
    }
  }
  throw new Error('no RAD/ETH pool found on Uniswap V3');
}

/** Quote ETH -> $RAD via QuoterV2 (an eth_call — free, keyless, private). */
export async function quoteEthToRad(
  endpoint: string,
  amountInEth: string,
  slippagePct = 1.0,
): Promise<SwapQuote> {
  const c: PublicClient = client(endpoint);
  const feeTier = await discoverFeeTier(endpoint);
  const amountIn = parseEther(amountInEth);
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: WETH, tokenOut: RAD_TOKEN.address, amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }],
  });
  const res = await c.call({ to: QUOTER_V2, data });
  if (!res.data) throw new Error('quoter returned nothing');
  const [amountOut] = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    data: res.data,
  }) as unknown as [bigint, bigint, number, bigint];
  const minOut = applySlippage(amountOut, slippagePct);
  return {
    amountInEth,
    amountOut,
    amountOutFormatted: fmt(amountOut),
    feeTier,
    feeTierPct: `${(feeTier / 10_000).toFixed(2)}%`,
    minOut,
    minOutFormatted: fmt(minOut),
    slippagePct,
  };
}

/** Execute the quoted swap. ETH in, $RAD out, straight to the user. */
export async function swapEthToRad(
  endpoint: string,
  account: SignerAccount,
  quote: SwapQuote,
): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: WETH,
        tokenOut: RAD_TOKEN.address,
        fee: quote.feeTier,
        recipient: account.address,
        amountIn: parseEther(quote.amountInEth),
        amountOutMinimum: quote.minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const wc = createWalletClient({ account, chain: mainnet, transport: http(endpoint) });
  return wc.sendTransaction({
    account,
    chain: mainnet,
    to: SWAP_ROUTER_02,
    data,
    value: parseEther(quote.amountInEth),
  });
}

function fmt(raw: bigint): string {
  const s = formatUnits(raw, RAD_TOKEN.decimals);
  const [i, f = ''] = s.split('.');
  const ff = f.slice(0, 2).replace(/0+$/, '');
  return ff ? `${Number(i).toLocaleString('en-US')}.${ff}` : Number(i).toLocaleString('en-US');
}
