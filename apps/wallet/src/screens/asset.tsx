/**
 * One asset, opened up: what it is, what it is worth, and the two things you
 * can do with it.
 *
 * The price comes from a real Uniswap pool via QuoterV2 — no price API, no
 * key, no third party. It is a spot quote for one whole token, which is both
 * the honest number ("what you could get") and the private one: quoting your
 * actual balance would put the size of your position into the call.
 *
 * The chart is a different animal. History needs prices at past blocks, and
 * no public endpoint we ship will serve more than ~17 hours of mainnet
 * archive, so a real chart has to come from someone else's server. It is off
 * until switched on in SETTINGS → PRIVACY, and says so here rather than
 * pretending the
 * space is empty for no reason.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  openAsset, screen, openSend, swapIntent, prefs, persistPrefs, account,
  endpointForChain, CHAINS, DEMO,
} from '../state.js';
import {
  spotPriceInEth, fetchChart, priceFeedSupports, canSwapOn,
  explorerTokenUrl,
  dexChartSupports, dexChartUrl, DEXCHART_HOST, type PricePoint,
} from '@radwallet/core';
import { useModalDialog } from '../bits.js';

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** a sparkline, drawn by hand — no chart library, nothing fetched to render it */
function Spark({ points }: { points: PricePoint[] }) {
  if (points.length < 2) return null;
  const w = 320;
  const h = 72;
  const ps = points.map((p) => p.p);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const span = hi - lo || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.p - lo) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = ps[ps.length - 1] >= ps[0];
  const change = ((ps[ps.length - 1] - ps[0]) / ps[0]) * 100;
  return (
    <div class="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="price history">
        <path d={d} fill="none" stroke={up ? 'var(--grn)' : 'var(--red)'} stroke-width="2" />
      </svg>
      <div class="sparkfoot">
        <span>{points.length} points · 7d</span>
        <span class={up ? 'grn' : 'red'}>{up ? '+' : ''}{change.toFixed(2)}%</span>
      </div>
    </div>
  );
}

export function AssetSheet() {
  const a = openAsset.value;
  const box = useRef<HTMLDivElement>(null);
  const close = () => { openAsset.value = null; };
  const [price, setPrice] = useState<string | null>(null);
  const [priceState, setPriceState] = useState<'looking' | 'none' | 'ok'>('looking');
  const [chart, setChart] = useState<PricePoint[]>([]);
  // the embed is per-sheet: opening an asset must not phone anyone, so this
  // starts false every time unless the always-load switch is on
  const [showDex, setShowDex] = useState(prefs.value.dexChart.enabled);
  const feed = prefs.value.priceFeed;
  useModalDialog(box, close);

  useEffect(() => {
    if (!a) return;
    let live = true;
    setPriceState('looking');
    setPrice(null);
    setChart([]);
    setShowDex(prefs.value.dexChart.enabled);
    void (async () => {
      // the demo build ships canned chain data and runs where there is no
      // network at all; quoting a pool there would report "no pool answered",
      // which is a different and wrong claim
      if (DEMO) {
        if (live) { setPrice(a.address ? '0.0000237' : '1'); setPriceState('ok'); }
        return;
      }
      // native ETH is the unit everything else is quoted in
      if (!a.address) {
        if (live) { setPrice('1'); setPriceState('ok'); }
        return;
      }
      const chain = a.chainId ?? 1;
      const p = await spotPriceInEth(endpointForChain(chain), chain, a.address, a.decimals)
        .catch(() => null);
      if (!live) return;
      setPrice(p?.ethPerToken ?? null);
      setPriceState(p ? 'ok' : 'none');
    })();
    void (async () => {
      if (!a.address || !feed?.enabled) return;
      const pts = await fetchChart(feed, a.chainId ?? 1, a.address, 7);
      if (live) setChart(pts);
    })();
    return () => { live = false; };
  }, [a?.chainId, a?.address, feed?.enabled]);

  if (!a) return null;
  const chain = a.chainId ?? 1;
  const explorer = a.address ? explorerTokenUrl(chain, a.address) : null;
  // native ETH has no contract of its own; a chart of it is a chart of the
  // chain's wrapped-native pool, which is the same price
  const dexToken = dexChartSupports(chain)
    ? (a.address ?? CHAINS[chain]?.wrappedNative ?? null)
    : null;
  const worth = price && Number(price) > 0
    ? (Number(a.amount.replace('<', '')) * Number(price))
    : null;

  return (
    <div class="drawer" onMouseDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('drawer')) close();
    }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label={a.symbol} tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">[ {a.symbol} ]</h2>
          <button class="x" title="close (esc)" onClick={close}>[X]</button>
        </div>

        <div class="drawerbody">
          {/*
            One link, and it is about THIS ASSET: the contract. Your own address
            on the explorer is a HOME-screen thing — it belongs next to each
            chain, not repeated inside every token you open.
          */}
          <div class="assethead">
            <div class="aname">{a.name}</div>
            <div class="abal">{a.amount} {a.symbol}</div>
            <div class="note">
              {CHAINS[chain]?.name ?? `chain ${chain}`}
              {a.address && explorer
                ? (
                  <> · <a
                    class="exlink" target="_blank" rel="noreferrer"
                    href={explorer}
                    title={`this token's contract on ${new URL(explorer).host}`}
                    aria-label={`view the ${a.symbol} contract on the block explorer`}
                  >{short(a.address)} ↗</a></>
                )
                : a.address ? ' · no block explorer configured' : ' · native, no contract'}
            </div>
          </div>

          <div class="pricebox">
            {priceState === 'looking' && <div class="note">asking a pool…</div>}
            {priceState === 'none' && (
              <div class="note">
                no Uniswap pool answered on this chain, so there is no on-chain price
                to show. That is not the same as worthless.
              </div>
            )}
            {priceState === 'ok' && price && (
              <>
                <div class="prow">
                  <span>1 {a.symbol}</span>
                  <span class="pval">{Number(price).toPrecision(6)} ETH</span>
                </div>
                {worth !== null && (
                  <div class="prow">
                    <span>your {a.amount}</span>
                    <span class="pval">≈ {worth.toPrecision(6)} ETH</span>
                  </div>
                )}
                <div class="pooltag tip below" data-tip={DEMO
                  ? 'demo mode: canned number. the real build quotes a live pool.'
                  : `quoted from a live pool for 1 ${a.symbol} — the price you could get, not a number from a price API`}
                >{DEMO ? 'canned (demo)' : 'from a pool'}</div>
              </>
            )}
          </div>

          {/*
            The chart, in order of what it costs you. A loaded embed wins; then
            the sparkline we draw ourselves from the opt-in feed; then an
            explanation of why the space is empty and what would fill it.
          */}
          {dexToken && showDex
            ? (
              <div class="dexbox">
                <iframe
                  class="dexframe" src={dexChartUrl(chain, dexToken)}
                  title={`${a.symbol} price chart`}
                  referrerpolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-popups"
                  loading="lazy"
                />
                <div class="note">
                  live from {DEXCHART_HOST} — they see this token and your IP for as
                  long as this is open.{' '}
                  <button class="act" onClick={() => setShowDex(false)}>stop</button>
                  {' · '}
                  <button
                    class="act"
                    onClick={() => {
                      prefs.value = {
                        ...prefs.value,
                        dexChart: { enabled: !prefs.value.dexChart.enabled },
                      };
                      void persistPrefs();
                    }}
                  >{prefs.value.dexChart.enabled ? 'stop doing this automatically' : 'always load it'}</button>
                </div>
              </div>
            )
            : chart.length > 1
              ? <Spark points={chart} />
              : (
                <div class="chartnote">
                  {dexToken
                    ? (
                      <button class="btn ghost block" onClick={() => setShowDex(true)}>
                        LOAD THE CHART (asks {DEXCHART_HOST}, shows them your IP)
                      </button>
                    )
                    : (
                      <div class="note">
                        no DEX chart for {CHAINS[chain]?.name ?? `chain ${chain}`}.
                      </div>
                    )}
                  {a.address && !feed?.enabled && (
                    <div class="note">
                      or draw one here from the opt-in price feed in{' '}
                      <button class="act" onClick={() => { close(); screen.value = 'settings'; }}>
                        SETTINGS → PRIVACY
                      </button>.
                    </div>
                  )}
                  {a.address && feed?.enabled && (
                    <div class="note">
                      {priceFeedSupports(chain)
                        ? 'no history came back for this contract.'
                        : 'the price feed does not cover this chain.'}
                    </div>
                  )}
                </div>
              )}
        </div>

        <div class="drawerfoot">
          <div class="btnrow">
            <button
              class="btn ghost" onClick={() => {
                close();
                openSend(a.address
                  ? {
                    kind: 'erc20', chainId: a.chainId ?? 1, address: a.address, symbol: a.symbol,
                    name: a.name, decimals: a.decimals, balance: a.amount, balanceRaw: a.raw,
                  }
                  : { kind: 'native', chainId: a.chainId ?? 1 });
              }}
            >↗ SEND</button>
            <button
              class="btn" disabled={!canSwapOn(a.chainId ?? 1)}
              title={canSwapOn(a.chainId ?? 1) ? '' : 'no Uniswap pools on this chain'}
              onClick={() => {
                // carry this asset into the swap as the FROM side, WITH its
                // chain: without it the swap screen opened on whatever network
                // the wallet happened to be switched to, which for a Base or
                // Robinhood token meant an Ethereum swap page every time
                swapIntent.value = {
                  chainId: chain, address: a.address ?? null, symbol: a.symbol, decimals: a.decimals,
                };
                close();
                screen.value = 'swap';
              }}
            >⇄ SWAP</button>
          </div>
          <div class="note center">
            {account.value ? `held by ${account.value.label}` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}
