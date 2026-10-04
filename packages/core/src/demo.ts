/**
 * Demo mode — canned chain data so the UI can be exercised anywhere with no
 * network access at all (e.g. the published mobile demo, which runs inside a
 * sandbox that blocks every external request). Demo mode is loudly labeled
 * in the UI; it exists for testing the experience, not for pretending.
 */
import type { TokenBalance, TxPreview } from './chain.js';
import type { NftHolding } from './nfts.js';

export const DEMO_ADDRESS = '0x1831C0DEba5eD1831c0DEBa5eD1831C0dEbAc4a7' as const;

export function demoBalances(): TokenBalance[] {
  return [
    { symbol: 'ETH', name: 'Ether', amount: '4.2069', raw: 4206900000000000000n, decimals: 18, chainId: 1 },
    {
      symbol: '$RAD',
      name: 'Radcoin',
      amount: '42000.69',
      raw: 42000690000000000000000n,
      decimals: 18,
      address: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB',
      chainId: 1,
    },
    { symbol: 'ETH', name: 'Ether', amount: '0.318', raw: 318000000000000000n, decimals: 18, chainId: 8453 },
    {
      symbol: 'USDC', name: 'USD Coin', amount: '250.5', raw: 250500000n, decimals: 6,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453,
    },
    { symbol: 'ETH', name: 'Ether', amount: '<0.0001', raw: 90000000000n, decimals: 18, chainId: 4663 },
  ];
}

/**
 * What the demo shows once testnets are switched on. Deliberately a LARGE
 * number: it makes the point that a faucet can hand you 12 ETH and it still
 * must not move the balance at the top of the screen.
 */
export function demoTestnetBalances(): TokenBalance[] {
  return [
    { symbol: 'ETH', name: 'Ether', amount: '12.5', raw: 12500000000000000000n, decimals: 18, chainId: 11155111 },
    { symbol: 'ETH', name: 'Ether', amount: '3.25', raw: 3250000000000000000n, decimals: 18, chainId: 84532 },
  ];
}

/** canned NFT holdings for the demo build — same shape the chain returns */
export function demoNfts(): NftHolding[] {
  return [
    {
      chainId: 1,
      address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
      name: 'Bored Ape Yacht Club', symbol: 'BAYC',
      count: 1, tokenIds: ['1'], enumerable: true,
      tokenUris: { 1: 'ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1' },
    },
    {
      chainId: 1,
      address: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
      name: 'ENS Names', symbol: 'ENS',
      count: 7, tokenIds: [], enumerable: false, tokenUris: {},
    },
  ];
}

export function demoBlockNumber(): bigint {
  // block height frozen at a nice number; ticks locally in the UI
  return 23107331n;
}

export async function demoPreviewSend(to: string, ethAmount: string): Promise<TxPreview> {
  await new Promise((r) => setTimeout(r, 350)); // pretend to think
  const n = Number(ethAmount);
  if (!Number.isFinite(n) || n <= 0) {
    return { out: [], in_: [], gasEth: '0', gasWei: 0n, ok: false, error: 'invalid amount' };
  }
  return {
    out: [{ asset: 'ETH', amount: ethAmount }],
    in_: [{ asset: `ETH → ${to.slice(0, 6)}…${to.slice(-4)}`, amount: ethAmount }],
    gasEth: '0.0011',
    gasWei: 1100000000000000n,
    ok: true,
  };
}
