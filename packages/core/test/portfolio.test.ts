import test from 'node:test';
import assert from 'node:assert/strict';
import type { PortfolioFilters, PortfolioHolding, WalletAccount } from '../src/index.js';
import { buildPortfolioView, portfolioAssetId } from '../src/index.js';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;
const C1 = '0x0000000000000000000000000000000000000c01' as const;
const C2 = '0x0000000000000000000000000000000000000c02' as const;

const noFilters: PortfolioFilters = {
  excludedWallets: [],
  excludedAssets: [],
  excludedChains: [],
};

function account(address: `0x${string}`, index: number, groupId = 'seed-1'): WalletAccount {
  return {
    index,
    address,
    label: `wallet ${index + 1}`,
    named: false,
    kind: 'hd',
    groupId,
    groupLabel: groupId === 'seed-1' ? 'seed #1' : 'seed #2',
    hdIndex: index,
    labels: [],
  };
}

function holding(
  wallet: WalletAccount,
  chainId: number,
  symbol: string,
  ethValue: number | null,
  raw = 1n,
  address?: `0x${string}`,
): PortfolioHolding {
  return {
    symbol,
    name: symbol,
    amount: raw.toString(),
    raw,
    decimals: 18,
    chainId,
    ...(address ? { address } : {}),
    walletAddress: wallet.address,
    walletLabel: wallet.label,
    groupId: wallet.groupId,
    groupLabel: wallet.groupLabel,
    ethValue,
  };
}

test('portfolio: filters and aggregates by asset, wallet and group', () => {
  const a = account(A, 0);
  const b = account(B, 1, 'seed-2');
  const holdings = [
    holding(a, 1, 'ETH', 1),
    holding(a, 1, 'RAD', 0.25, 1n, C1),
    holding(b, 8453, 'ETH', 0.5),
  ];

  const assets = buildPortfolioView(holdings, [a, b], noFilters, 'assets');
  assert.equal(assets.totalEth, 1.75);
  assert.equal(assets.walletCount, 2);
  assert.equal(assets.assetCount, 3);
  assert.deepEqual(assets.rows.map((r) => r.id), ['1:native', portfolioAssetId(8453), portfolioAssetId(1, C1)]);

  const wallets = buildPortfolioView(holdings, [a, b], {
    ...noFilters,
    excludedWallets: [B.toUpperCase()],
    excludedAssets: [portfolioAssetId(1, C1)],
  }, 'wallets');
  assert.equal(wallets.totalEth, 1);
  assert.equal(wallets.walletCount, 1);
  assert.deepEqual(wallets.rows.map((r) => r.id), [A.toLowerCase()]);
  assert.equal(wallets.rows[0].subtitle, 'seed #1 · 0x0000...00a1 · 1 asset');

  const groups = buildPortfolioView(holdings, [a, b], { ...noFilters, excludedChains: [8453] }, 'groups');
  assert.equal(groups.totalEth, 1.25);
  assert.deepEqual(groups.rows.map((r) => r.id), ['seed-1']);
});

test('portfolio: duplicate wallet addresses and duplicate holdings are not counted twice', () => {
  const first = account(A, 0);
  const duplicate = { ...account(A, 1), label: 'same address' };
  const holdings = [
    holding(first, 1, 'ETH', 1),
    holding(duplicate, 1, 'ETH', 1),
  ];

  const view = buildPortfolioView(holdings, [first, duplicate], noFilters, 'wallets');
  assert.equal(view.walletCount, 1);
  assert.equal(view.totalEth, 1);
  assert.equal(view.rows[0].ethValue, 1);
});

test('portfolio: null price stays distinct from a priced zero', () => {
  const a = account(A, 0);
  const view = buildPortfolioView([
    holding(a, 1, 'ZERO', 0, 0n, C1),
    holding(a, 1, 'MYSTERY', null, 50n, C2),
  ], [a], noFilters, 'assets');

  assert.equal(view.totalEth, 0);
  assert.equal(view.hasValue, true);
  assert.equal(view.pricedAssetCount, 1);
  assert.equal(view.unpricedAssetCount, 1);
  assert.equal(view.rows.find((r) => r.label === 'MYSTERY')?.unpriced, 1);
});

test('portfolio: non-finite and negative values do not count as priced', () => {
  const a = account(A, 0);
  const view = buildPortfolioView([
    holding(a, 1, 'BAD', NaN, 1n, C1),
    holding(a, 1, 'NEG', -1, 1n, C2),
  ], [a], noFilters, 'assets');

  assert.equal(view.totalEth, 0);
  assert.equal(view.hasValue, false);
  assert.equal(view.pricedAssetCount, 0);
  assert.equal(view.unpricedAssetCount, 2);
});

test('portfolio: excluding every wallet returns an empty selected view', () => {
  const a = account(A, 0);
  const view = buildPortfolioView([holding(a, 1, 'ETH', 1)], [a], {
    ...noFilters,
    excludedWallets: [A],
  }, 'assets');

  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.holdings, []);
  assert.equal(view.totalEth, 0);
  assert.equal(view.hasValue, false);
  assert.equal(view.walletCount, 0);
});

test('portfolio: an included wallet with no scanned holdings still counts as known empty', () => {
  const a = account(A, 0);
  const view = buildPortfolioView([], [a], noFilters, 'wallets');

  assert.equal(view.walletCount, 1);
  assert.equal(view.assetCount, 0);
  assert.equal(view.totalEth, 0);
});

test('portfolio: symbol collisions remain chain-qualified and testnets never count', () => {
  const a = account(A, 0);
  const holdings = [
    holding(a, 4663, 'USDG', 0.1, 1n, C1),
    holding(a, 4663, 'USDG', 0.2, 1n, C2),
    holding(a, 11155111, 'ETH', 12, 12n),
  ];

  const view = buildPortfolioView(holdings, [a], noFilters, 'assets');
  assert.ok(Math.abs(view.totalEth - 0.3) < 1e-12);
  assert.equal(view.assetCount, 2);
  assert.equal(view.unpricedAssetCount, 0);
  assert.deepEqual(
    view.rows.map((r) => r.id).sort(),
    [portfolioAssetId(4663, C1), portfolioAssetId(4663, C2)].sort(),
  );
});

test('portfolio: an asset is unpriced if any positive holding lacks a price', () => {
  const a = account(A, 0);
  const b = account(B, 1);
  const view = buildPortfolioView([
    holding(a, 1, 'MIX', 0.5, 1n, C1),
    holding(b, 1, 'MIX', null, 2n, C1),
  ], [a, b], noFilters, 'assets');

  assert.equal(view.totalEth, 0.5);
  assert.equal(view.pricedAssetCount, 1);
  assert.equal(view.unpricedAssetCount, 1);
  assert.equal(view.rows[0].unpriced, 1);
});
