import { useEffect, useRef, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import {
  buildPortfolioView, CHAINS, SCAN_CHAIN_IDS, formatAmount,
  type PortfolioHolding, type PortfolioRow, type PortfolioGrouping,
} from '@radwallet/core';
import {
  accounts, groups, screen, assetKey, portfolioHoldings, portfolioUpdatedAt,
  portfolioErrors, portfolioStale, portfolioSettings, setPortfolioSettings,
  valueAllWallets, valuingWallets, walletValueProgress, usdRate, usd, sayError,
} from '../state.js';
import { IconBtn, useModalDialog } from '../bits.js';

const COLORS = ['#ffe000', '#fff27a', '#39ff14', '#b26bff', '#9be7ff'];
const OTHER_COLOR = '#8d8d8d';
const GROUPINGS: Array<[PortfolioGrouping, string]> = [['assets', 'Assets'], ['wallets', 'Wallets'], ['groups', 'Seed groups']];
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const network = (id: number | undefined) => CHAINS[id ?? 1]?.name ?? `Chain ${id}`;
const keyOf = (holding: PortfolioHolding) => assetKey(holding.chainId ?? 1, holding.address);
const percent = (value: number, total: number) => total > 0
  ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value / total * 100)}%`
  : '0%';

/** One denomination for the total, chart titles, breakdown and filter values. */
function valueText(value: number | null, currency = portfolioSettings.value.currency): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (currency === 'usd') return usdRate.value !== null ? usd(value * usdRate.value) : '—';
  if (value > 0 && value < 0.000001) return '<0.000001 ETH';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)} ETH`;
}

export function PortfolioNavigation() {
  const active = screen.value === 'portfolio';
  return <nav class="portfolio-nav" aria-label="Wallet and portfolio">
    <button aria-current={!active ? 'page' : undefined} onClick={() => {
      setPortfolioSettings({ active: false });
      screen.value = 'home';
    }}>Wallet</button>
    <button aria-current={active ? 'page' : undefined} onClick={() => {
      setPortfolioSettings({ active: true });
      screen.value = 'portfolio';
    }}>Portfolio</button>
  </nav>;
}

function Donut({ rows, total, label, value }: { rows: PortfolioRow[]; total: number; label: string; value: string }) {
  const positive = rows.filter((row) => row.ethValue > 0);
  const slices = positive.slice(0, COLORS.length).map((row, index) => ({
    id: row.id, label: `${row.label} · ${row.subtitle}`, value: row.ethValue, color: COLORS[index],
  }));
  if (positive.length > COLORS.length) slices.push({
    id: 'other', label: 'Other', value: positive.slice(COLORS.length).reduce((sum, row) => sum + row.ethValue, 0), color: OTHER_COLOR,
  });
  let offset = 0;
  return <div class="portfolio-chart">
    <svg viewBox="0 0 200 200" role="img" aria-label={`Portfolio allocation. ${slices.map((s) => `${s.label}: ${percent(s.value, total)}`).join(', ') || 'No priced holdings'}`}>
      <circle cx="100" cy="100" r="76" fill="none" stroke="#262626" stroke-width="36" />
      {slices.map((slice) => {
        const share = slice.value / total * 100;
        const start = offset;
        offset += share;
        // An SVG chart encodes the current snapshot; it is never a raster mock.
        return <circle key={slice.id} cx="100" cy="100" r="76" fill="none"
          stroke={slice.color} stroke-width="36" pathLength="100"
          stroke-dasharray={`${Math.max(0.04, share - (slices.length > 1 ? Math.min(0.5, share / 3) : 0))} 100`}
          stroke-dashoffset={-start} transform="rotate(-90 100 100)">
          <title>{slice.label}: {valueText(slice.value)} · {percent(slice.value, total)}</title>
        </circle>;
      })}
    </svg>
    <div class="portfolio-chart-center">
      <span>{label}</span>
      <strong class="portfolio-total" aria-live="polite" title={value} style={{ fontSize: `${Math.min(16, 142 / Math.max(1, value.length))}px` }}>{value}</strong>
    </div>
  </div>;
}

function HoldingDetail({ holding, showWallet }: { holding: PortfolioHolding; showWallet: boolean }) {
  return <div class="portfolio-detail-row">
    <div><b>{showWallet ? holding.walletLabel : holding.symbol}</b>
      <span>{showWallet ? `${holding.groupLabel} · ${short(holding.walletAddress)}` : network(holding.chainId)}</span>
      <span>{formatAmount(formatUnits(holding.raw, holding.decimals))} {holding.symbol}</span>
    </div>
    <span>{holding.ethValue === null ? 'Unpriced' : valueText(holding.ethValue)}</span>
  </div>;
}

function RowDetail({ row, grouping }: { row: PortfolioRow; grouping: PortfolioGrouping }) {
  if (grouping === 'groups') {
    const wallets = new Map<string, PortfolioHolding[]>();
    for (const holding of row.holdings) {
      const key = holding.walletAddress.toLowerCase();
      wallets.set(key, [...(wallets.get(key) ?? []), holding]);
    }
    return <div class="portfolio-row-detail">
      {[...wallets].map(([address, holdings]) => <div class="portfolio-group-detail" key={address}>
        <div class="portfolio-detail-heading"><b>{holdings[0].walletLabel}</b><span>{short(address)}</span></div>
        {holdings.map((holding) => <HoldingDetail key={keyOf(holding)} holding={holding} showWallet={false} />)}
      </div>)}
    </div>;
  }
  const first = row.holdings[0];
  return <div class="portfolio-row-detail">
    {grouping === 'assets' && first && <div class="portfolio-asset-identity">
      <span>{first.name} · {network(first.chainId)}</span>
      {first.address && <code>{first.address}</code>}
    </div>}
    {row.holdings.map((holding) => <HoldingDetail
      key={`${holding.walletAddress}:${keyOf(holding)}`} holding={holding} showWallet={grouping === 'assets'} />)}
    {row.unpriced > 0 && <p class="note">Unpriced holdings are excluded from this value.</p>}
  </div>;
}

type FilterTab = 'Wallets' | 'Assets' | 'Networks';

function CheckRow({ label, title, detail, checked, mixed, onChange }: {
  label: string; title: string; detail?: string; checked: boolean; mixed?: boolean; onChange: () => void;
}) {
  return <label class="portfolio-check">
    <input type="checkbox" aria-label={label} checked={checked}
      ref={(node) => { if (node) node.indeterminate = !!mixed; }} onChange={onChange} />
    <span><b>{title}</b>{detail && <small>{detail}</small>}</span>
  </label>;
}

function PortfolioFilters({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, onClose);
  const [tab, setTab] = useState<FilterTab>('Wallets');
  const [search, setSearch] = useState('');
  const settings = portfolioSettings.value;
  const q = search.trim().toLowerCase();
  const assets = [...new Map(portfolioHoldings.value.map((h) => [keyOf(h), h])).values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.chainId ?? 1) - (b.chainId ?? 1));
  const toggle = (kind: 'excludedWallets' | 'excludedAssets', ids: string[]) => {
    const excluded = new Set(settings[kind]);
    const allIncluded = ids.every((id) => !excluded.has(id));
    for (const id of ids) { if (allIncluded) excluded.add(id); else excluded.delete(id); }
    setPortfolioSettings({ [kind]: [...excluded] });
  };
  const selectTab = (all: boolean) => {
    if (tab === 'Wallets') setPortfolioSettings({ excludedWallets: all ? [] : accounts.value.map((a) => a.address.toLowerCase()) });
    if (tab === 'Assets') setPortfolioSettings({ excludedAssets: all ? [] : assets.map(keyOf) });
    if (tab === 'Networks') setPortfolioSettings({ excludedChains: all ? [] : [...SCAN_CHAIN_IDS] });
  };
  return <div class="drawer portfolio-filters" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div class="drawerbox" ref={dialog} role="dialog" aria-modal="true" aria-label="Portfolio filters" tabIndex={-1}>
      <div class="drawerhead"><h2 class="simhead">FILTERS</h2><button class="x" aria-label="Close portfolio filters" onClick={onClose}>[X]</button></div>
      <div class="portfolio-filter-tabs" role="group" aria-label="Filter category">
        {(['Wallets', 'Assets', 'Networks'] as const).map((name) => <button key={name} aria-pressed={tab === name}
          onClick={() => { setTab(name); setSearch(''); }}>{name}</button>)}
      </div>
      <div class="drawerfilters">
        <input class="field search" aria-label={`Search ${tab.toLowerCase()}`} placeholder={`Search ${tab.toLowerCase()}`}
          value={search} onInput={(event) => setSearch(event.currentTarget.value)} />
        <div class="portfolio-filter-actions"><button onClick={() => selectTab(true)}>Select all</button><button onClick={() => selectTab(false)}>Clear selection</button></div>
      </div>
      <div class="drawerbody">
        {tab === 'Wallets' && groups.value.map((group) => {
          const members = group.members.filter((a) => `${group.label} ${a.label} ${a.address} ${a.labels.join(' ')}`.toLowerCase().includes(q));
          if (members.length === 0) return null;
          const ids = group.members.map((a) => a.address.toLowerCase());
          const included = ids.filter((id) => !settings.excludedWallets.includes(id)).length;
          return <section class="portfolio-filter-group" key={group.id}>
            <CheckRow label={`Include seed group ${group.label}`} title={group.label}
              detail={`${included}/${ids.length} wallets${group.kind === 'imported' ? ' · imported keys' : ''}`}
              checked={included === ids.length} mixed={included > 0 && included < ids.length}
              onChange={() => toggle('excludedWallets', ids)} />
            <div class="portfolio-filter-members">{members.map((a) => <CheckRow key={a.address}
              label={`Include wallet ${a.label} ${short(a.address)}`} title={a.label} detail={short(a.address)}
              checked={!settings.excludedWallets.includes(a.address.toLowerCase())}
              onChange={() => toggle('excludedWallets', [a.address.toLowerCase()])} />)}</div>
          </section>;
        })}
        {tab === 'Assets' && assets.filter((a) => `${a.symbol} ${a.name} ${a.address ?? ''} ${network(a.chainId)}`.toLowerCase().includes(q)).map((a) =>
          <CheckRow key={keyOf(a)} label={`Include asset ${a.symbol} on ${network(a.chainId)}`} title={a.symbol}
            detail={`${network(a.chainId)}${a.address ? ` · ${short(a.address)}` : ' · native'}`}
            checked={!settings.excludedAssets.includes(keyOf(a))} onChange={() => toggle('excludedAssets', [keyOf(a)])} />)}
        {tab === 'Assets' && assets.length === 0 && <p class="empty note">No assets loaded yet.</p>}
        {tab === 'Networks' && SCAN_CHAIN_IDS.filter((id) => network(id).toLowerCase().includes(q)).map((id) =>
          <CheckRow key={id} label={`Include network ${network(id)}`} title={network(id)} checked={!settings.excludedChains.includes(id)}
            onChange={() => setPortfolioSettings({ excludedChains: settings.excludedChains.includes(id)
              ? settings.excludedChains.filter((value) => value !== id) : [...settings.excludedChains, id] })} />)}
      </div>
      <div class="drawerfoot">
        <div class="portfolio-filter-summary">{buildPortfolioView(portfolioHoldings.value, accounts.value, settings, 'assets').walletCount} wallets included · changes apply immediately</div>
        <div class="btnrow"><button class="btn ghost" onClick={() => {
          setPortfolioSettings({ excludedWallets: [], excludedAssets: [], excludedChains: [] }); setSearch('');
        }}>Reset filters</button><button class="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  </div>;
}

export function Portfolio() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reviewUnpriced, setReviewUnpriced] = useState(false);
  const settings = portfolioSettings.value;
  const view = buildPortfolioView(portfolioHoldings.value, accounts.value, settings, settings.groupBy);
  const loaded = portfolioUpdatedAt.value !== null;
  const errors = Object.entries(portfolioErrors.value).filter(([key]) => {
    const [address, chainId] = key.split(':');
    return !settings.excludedWallets.includes(address) && !settings.excludedChains.includes(Number(chainId));
  });
  const refreshing = valuingWallets.value;
  const usdUnavailable = settings.currency === 'usd' && usdRate.value === null;
  const filtered = settings.excludedWallets.length + settings.excludedAssets.length + settings.excludedChains.length > 0;
  useEffect(() => { void valueAllWallets().catch(sayError); }, []);
  const total = !loaded || (!view.hasValue && (view.unpricedAssetCount > 0 || (errors.length > 0 && view.walletCount > 0)))
    ? '—' : valueText(view.totalEth);
  const unpriced = view.holdings.filter((h) => h.ethValue === null && h.raw > 0n);
  const colors = new Map(view.rows.filter((r) => r.ethValue > 0).map((row, index) => [row.id, COLORS[index] ?? OTHER_COLOR]));
  return <>
    <main class="content portfolio-page">
      <div class="portfolio-heading"><h1>Portfolio</h1>
        <div class="portfolio-currency" role="group" aria-label="Portfolio value currency">
          {(['usd', 'eth'] as const).map((currency) => <button key={currency} aria-pressed={settings.currency === currency}
            onClick={() => setPortfolioSettings({ currency })}>{currency.toUpperCase()}</button>)}
        </div>
      </div>
      <div class="portfolio-scope"><span>{view.walletCount} wallet{view.walletCount === 1 ? '' : 's'} · {view.assetCount} asset{view.assetCount === 1 ? '' : 's'}</span>
        <button class="btn ghost" aria-label="FILTERS" onClick={() => setFiltersOpen(true)}>FILTERS{filtered ? ' •' : ''}</button>
      </div>
      <div class="portfolio-grouping" role="group" aria-label="Portfolio breakdown">
        {GROUPINGS.map(([groupBy, label]) => <button key={groupBy} aria-pressed={settings.groupBy === groupBy}
          onClick={() => { setPortfolioSettings({ groupBy }); setExpanded(null); }}>{label}</button>)}
      </div>
      <Donut rows={view.rows} total={view.totalEth} value={total}
        label={!loaded ? (refreshing ? 'LOADING' : 'NOT LOADED') : errors.length ? 'PARTIAL TOTAL' : 'SELECTED TOTAL'} />
      {usdUnavailable && loaded && <p class="portfolio-notice">USD price unavailable. Select ETH to view values.</p>}
      {errors.length > 0 && <details class="portfolio-notice"><summary>{errors.length} balance reads unavailable</summary>
        {errors.map(([key, message]) => <p key={key}>{message}</p>)}
      </details>}
      <div class="portfolio-list" aria-label="Balance breakdown">
        {view.rows.map((row) => <section class="portfolio-row" key={row.id}>
          <button class="portfolio-row-toggle" aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
            <span class="portfolio-swatch" style={{ backgroundColor: colors.get(row.id) ?? '#666' }} />
            <span class="portfolio-row-name"><b>{row.label}</b><small>{row.subtitle}</small></span>
            <span class="portfolio-share">{row.hasValue ? percent(row.ethValue, view.totalEth) : '—'}</span>
            <span class="portfolio-row-value">{row.hasValue ? valueText(row.ethValue) : 'Unpriced'}{row.unpriced > 0 && row.hasValue ? '*' : ''}</span>
            <span class="portfolio-chevron" aria-hidden="true">{expanded === row.id ? '⌄' : '›'}</span>
          </button>
          {expanded === row.id && <RowDetail row={row} grouping={settings.groupBy} />}
        </section>)}
        {loaded && view.rows.length === 0 && <div class="portfolio-empty">
          <p>{view.walletCount === 0 ? 'No wallets selected.' : filtered ? 'No holdings match these filters.' : 'No holdings found.'}</p>
          {filtered && <button class="act" onClick={() => setPortfolioSettings({ excludedWallets: [], excludedAssets: [], excludedChains: [] })}>Reset filters</button>}
        </div>}
      </div>
      <footer class="portfolio-footer">
        <div>
          {view.unpricedAssetCount > 0 && <span>{view.unpricedAssetCount} unpriced assets <button class="act" aria-expanded={reviewUnpriced}
            onClick={() => setReviewUnpriced(!reviewUnpriced)}>Review</button></span>}
          <small role="status">{refreshing ? `Refreshing ${walletValueProgress.value ?? ''}`
            : !loaded ? 'No snapshot yet' : portfolioStale.value ? 'Balances changed · refresh'
            : `Updated ${new Date(portfolioUpdatedAt.value!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</small>
        </div>
        <IconBtn glyph="↻" tip="Refresh portfolio" disabled={refreshing} onClick={() => void valueAllWallets().catch(sayError)} />
      </footer>
      {reviewUnpriced && unpriced.length > 0 && <div class="portfolio-unpriced">
        <p class="note">These quantities are held, but have no price. They are excluded from the total and chart.</p>
        {unpriced.map((holding) => <div key={`${holding.walletAddress}:${keyOf(holding)}`}>
          <b>{formatAmount(formatUnits(holding.raw, holding.decimals))} {holding.symbol}</b>
          <span>{network(holding.chainId)} · {holding.walletLabel} · {holding.groupLabel}</span>
          {holding.address && <code>{holding.address}</code>}
        </div>)}
      </div>}
    </main>
    {filtersOpen && <PortfolioFilters onClose={() => setFiltersOpen(false)} />}
  </>;
}
