import type { TokenBalance } from './chain.js';
import { CHAINS } from './chains.js';
import type { WalletAccount } from './keyring.js';

export interface PortfolioHolding extends TokenBalance {
  walletAddress: `0x${string}`;
  walletLabel: string;
  groupId: string;
  groupLabel: string;
  ethValue: number | null;
}

export interface PortfolioFilters {
  excludedWallets: string[];
  excludedAssets: string[];
  excludedChains: number[];
}

export type PortfolioGrouping = 'assets' | 'wallets' | 'groups';

export interface PortfolioRow {
  id: string;
  label: string;
  subtitle: string;
  ethValue: number;
  hasValue: boolean;
  unpriced: number;
  holdings: PortfolioHolding[];
}

export interface PortfolioView {
  rows: PortfolioRow[];
  holdings: PortfolioHolding[];
  totalEth: number;
  hasValue: boolean;
  unpricedAssetCount: number;
  pricedAssetCount: number;
  assetCount: number;
  walletCount: number;
}

export function portfolioAssetId(chainId: number, address?: `0x${string}` | null): string {
  return `${chainId}:${address ? address.toLowerCase() : 'native'}`;
}

function positive(raw: bigint): boolean {
  return raw > 0n;
}

function priced(holding: PortfolioHolding): boolean {
  return (
    !CHAINS[holding.chainId ?? 1]?.testnet &&
    holding.ethValue !== null &&
    Number.isFinite(holding.ethValue) &&
    holding.ethValue >= 0
  );
}

function valueOf(holding: PortfolioHolding): number {
  return priced(holding) ? holding.ethValue ?? 0 : 0;
}

function uniqueHoldings(holdings: PortfolioHolding[]): PortfolioHolding[] {
  const out = new Map<string, PortfolioHolding>();
  for (const holding of holdings) {
    const wallet = holding.walletAddress.toLowerCase();
    const chainId = holding.chainId ?? 1;
    out.set(`${wallet}:${portfolioAssetId(chainId, holding.address)}`, {
      ...holding,
      chainId,
    });
  }
  return [...out.values()];
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function rowSubtitle(grouping: PortfolioGrouping, holdings: PortfolioHolding[]): string {
  if (!holdings.length) return '';
  if (grouping === 'assets') {
    const h = holdings[0];
    const chainId = h.chainId ?? 1;
    const chain = CHAINS[chainId]?.name ?? `chain ${chainId}`;
    const identity = h.address ? h.address : 'native';
    const wallets = new Set(holdings.map((x) => x.walletAddress.toLowerCase())).size;
    return `${chain} · ${identity} · ${wallets} wallet${wallets === 1 ? '' : 's'}`;
  }
  if (grouping === 'wallets') {
    const first = holdings[0];
    const assets = new Set(holdings.map((h) => portfolioAssetId(h.chainId ?? 1, h.address))).size;
    return `${first.groupLabel} · ${shortAddress(first.walletAddress)} · ${assets} asset${assets === 1 ? '' : 's'}`;
  }
  const assets = new Set(holdings.map((h) => portfolioAssetId(h.chainId ?? 1, h.address))).size;
  return `${assets} asset${assets === 1 ? '' : 's'}`;
}

function makeRow(grouping: PortfolioGrouping, id: string, holdings: PortfolioHolding[]): PortfolioRow {
  const first = holdings[0];
  const ethValue = holdings.reduce((total, h) => total + valueOf(h), 0);
  const hasValue = holdings.some(priced);
  const unpriced = holdings.filter((h) => positive(h.raw) && !priced(h)).length;
  let label = id;
  if (grouping === 'assets' && first) label = first.symbol;
  if (grouping === 'wallets' && first) label = first.walletLabel;
  if (grouping === 'groups' && first) label = first.groupLabel;
  return {
    id,
    label,
    subtitle: rowSubtitle(grouping, holdings),
    ethValue,
    hasValue,
    unpriced,
    holdings,
  };
}

export function buildPortfolioView(
  holdings: PortfolioHolding[],
  accounts: WalletAccount[],
  filters: PortfolioFilters,
  grouping: PortfolioGrouping,
): PortfolioView {
  const excludedWallets = new Set(filters.excludedWallets.map((a) => a.toLowerCase()));
  const excludedAssets = new Set(filters.excludedAssets.map((a) => a.toLowerCase()));
  const excludedChains = new Set(filters.excludedChains);
  const includedWallets = new Set(
    accounts
      .map((a) => a.address.toLowerCase())
      .filter((address) => !excludedWallets.has(address)),
  );

  const filtered = uniqueHoldings(holdings)
    .filter((h) => includedWallets.has(h.walletAddress.toLowerCase()))
    .filter((h) => !CHAINS[h.chainId ?? 1]?.testnet)
    .filter((h) => !excludedChains.has(h.chainId ?? 1))
    .filter((h) => !excludedAssets.has(portfolioAssetId(h.chainId ?? 1, h.address).toLowerCase()));

  const byRow = new Map<string, PortfolioHolding[]>();
  for (const holding of filtered) {
    const chainId = holding.chainId ?? 1;
    const id = grouping === 'assets'
      ? portfolioAssetId(chainId, holding.address)
      : grouping === 'wallets'
        ? holding.walletAddress.toLowerCase()
        : holding.groupId;
    const list = byRow.get(id) ?? [];
    list.push(holding);
    byRow.set(id, list);
  }

  const rows = [...byRow.entries()]
    .map(([id, rowHoldings]) => makeRow(grouping, id, rowHoldings))
    .sort((a, b) => {
      const byValue = b.ethValue - a.ethValue;
      if (byValue !== 0) return byValue;
      if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  const assetStates = new Map<string, { priced: boolean; unpriced: boolean }>();
  for (const holding of filtered) {
    const id = portfolioAssetId(holding.chainId ?? 1, holding.address);
    const state = assetStates.get(id) ?? { priced: false, unpriced: false };
    if (priced(holding)) state.priced = true;
    if (positive(holding.raw) && !priced(holding)) state.unpriced = true;
    assetStates.set(id, state);
  }

  return {
    rows,
    holdings: filtered,
    totalEth: filtered.reduce((total, holding) => total + valueOf(holding), 0),
    hasValue: filtered.some(priced),
    unpricedAssetCount: [...assetStates.values()].filter((state) => state.unpriced).length,
    pricedAssetCount: [...assetStates.values()].filter((state) => state.priced).length,
    assetCount: assetStates.size,
    walletCount: includedWallets.size,
  };
}
