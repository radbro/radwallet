import { render } from 'preact';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import {
  screen, boot, busy, toast, toastTransaction, hush, DEMO, blockNumber, account,
  panelMode, canDock, dock, undock, pickerOpen, unlocked, revalidateSession, openNft, approveMode,
  prefs, openAsset, lock, sheet, adoptChain, adoptTrackedTokens, scheduleBalanceRefresh,
  adoptTransactionConfirmation,
} from './state.js';
import {
  onWalletChainChanged, onWalletTokensTracked, onWalletTransaction, onWalletTransactionConfirmed,
} from './ext.js';
import { onBackground } from './native.js';
import { watchAddressBook } from './addressbook.js';
import { Starfield, TabBar, TxLink } from './bits.js';
import { LOGO } from './assets.js';
import { Welcome, Create, Import, Unlock } from './screens/onboard.js';
import { Home } from './screens/home.js';
import { Portfolio, PortfolioNavigation } from './screens/portfolio.js';
import { SendSheet } from './screens/send.js';
import { ReceiveSheet } from './screens/receive.js';
import { TokenListSheet } from './screens/tokenlist.js';
import { Swap } from './screens/swap.js';
import { Settings } from './screens/settings.js';
import { Approve } from './screens/approve.js';
import { Activity } from './screens/activity.js';
import { WalletPicker } from './screens/wallets.js';
import { NftSheet } from './screens/nft.js';
import { Nfts } from './screens/nfts.js';
import { AssetSheet } from './screens/asset.js';
import './style.css';

const SCREENS: Record<string, () => preact.JSX.Element> = {
  welcome: Welcome, create: Create, import: Import, unlock: Unlock,
  home: Home, portfolio: Portfolio, swap: Swap,
  settings: Settings, approve: Approve,
  activity: Activity, nfts: Nfts,
};

/**
 * Screens that belong to the tab bar. Onboarding, unlock and the dapp
 * approval window get no bar: there is nowhere else to be from those, and an
 * approval popup with navigation in it is an invitation to misclick.
 *
 * SEND and RECEIVE are not on this list because they are no longer screens —
 * they are sheets, closing the way every other sheet does.
 */
const TABBED = new Set(['home', 'nfts', 'swap', 'activity', 'settings']);

function App() {
  // one knob scales the whole UI, not just the text: growing type inside
  // fixed boxes just moves the unreadability somewhere else. CSS zoom still
  // does that job, but the layout width is divided by the same factor so the
  // enlarged UI reflows instead of becoming wider than the viewport.
  useEffect(() => {
    // 1.0 on the slider renders at 1.2: the design was simply too small, and
    // "everyone should immediately drag the slider" is not a default
    const BASE_ZOOM = 1.2;
    const scale = prefs.value.uiScale ?? 1;
    const zoom = scale * BASE_ZOOM;
    const syncLayout = () => {
      const root = document.documentElement;
      const maxPhysicalWidth = panelMode ? root.clientWidth : Math.min(root.clientWidth, 430);
      root.style.setProperty('--ui-zoom', String(zoom));
      root.style.setProperty('--ui-layout-width', `${maxPhysicalWidth / zoom}px`);
      root.style.setProperty('--ui-layout-height', `${root.clientHeight / zoom}px`);
      // Targets stay at least 45 physical pixels at every text setting.
      root.style.setProperty('--tap-size', `${45 / zoom}px`);
      document.body.dataset.uiScale = scale >= 1.4 ? 'large' : 'normal';
    };
    syncLayout();
    window.addEventListener('resize', syncLayout);
    return () => window.removeEventListener('resize', syncLayout);
  }, [prefs.value.uiScale]);

  // A screen is a new place, not the continuation of the previous screen's
  // scroll position. Reset both legacy scroll roots because extension pages
  // and the PWA do not agree on whether <html> or <body> owns the scroll.
  useLayoutEffect(() => {
    const reset = () => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.scrollingElement?.scrollTo({ top: 0, left: 0 });
    };
    reset();
  }, [screen.value]);

  useEffect(() => {
    void boot();
    // a docked sidebar outlives the background worker; re-check on focus
    const recheck = () => { if (!document.hidden) void revalidateSession(); };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    const stopChainSync = onWalletChainChanged(adoptChain);
    const stopTokenSync = onWalletTokensTracked(adoptTrackedTokens);
    const stopTransactionSync = onWalletTransaction(scheduleBalanceRefresh);
    const stopConfirmationSync = onWalletTransactionConfirmed(adoptTransactionConfirmation);
    const stopAddressBookSync = watchAddressBook();
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      stopChainSync();
      stopTokenSync();
      stopTransactionSync();
      stopConfirmationSync();
      stopAddressBookSync();
    };
  }, []);
  const S = SCREENS[screen.value] ?? Welcome;
  const toastPosition = pickerOpen.value || openNft.value || openAsset.value || sheet.value
    ? ' above-drawer'
    : unlocked.value && TABBED.has(screen.value) ? ' above-tabs' : '';
  return (
    <>
      <div id="app" class={screen.value === 'portfolio' ? 'portfolio-app' : undefined}>
      <Starfield />
      <div class="titlebar">
        <img src={LOGO} alt="" />
        <span class="t">RADWALLET</span>
        <span>v{__APP_VERSION__}</span>
        {canDock && (
          panelMode
            ? <button class="dock" title="back to the popup" onClick={undock}>[UNDOCK]</button>
            : <button class="dock" title="keep the wallet open as a sidebar" onClick={dock}>[DOCK]</button>
        )}
        {/* the network lives in the header dropdown, next to the wallet it
            belongs to. This used to read a hardcoded "Ethereum" that never
            changed, which was a lie on every other chain. */}
        {DEMO && <span class="net demo">● DEMO MODE</span>}
      </div>
      {unlocked.value && !approveMode && (TABBED.has(screen.value) || screen.value === 'portfolio') && <PortfolioNavigation />}
      <S />
      {unlocked.value && !approveMode && TABBED.has(screen.value) && <TabBar />}
      {pickerOpen.value && unlocked.value && <WalletPicker />}
      {openNft.value && <NftSheet />}
      {openAsset.value && <AssetSheet />}
      {unlocked.value && sheet.value === 'send' && <SendSheet />}
      {unlocked.value && sheet.value === 'receive' && <ReceiveSheet />}
      {unlocked.value && sheet.value === 'tokenlist' && <TokenListSheet />}
      </div>
      {/*
        Outside #app on purpose: zoom captures position:fixed descendants, so
        a toast inside the zoomed box drifts to the middle of the screen as the
        text size goes up. Out here it stays pinned, and scales on its own.
      */}
      {busy.value && <div class="busy">{busy.value}</div>}
      {/* role=status so it is announced rather than silently appearing; the
          click is a shortcut, not the only way out — it still times out.
          The [X] is the same shortcut made visible (and focusable): a bare
          clickable box looks like a notice, not a control */}
      {toast.value && (
        <div class={`toast${toastPosition}`} role="status" onClick={hush}>
          <span class="toastmsg">{toast.value}</span>
          {toastTransaction.value && (
            <TxLink
              chainId={toastTransaction.value.chainId}
              hash={toastTransaction.value.hash}
              className="toasttx"
            >view tx ↗</TxLink>
          )}
          <button class="x" title="dismiss" onClick={hush}>[X]</button>
        </div>
      )}
    </>
  );
}

if (panelMode) document.body.classList.add('docked');

/**
 * Lock the moment the app leaves the foreground.
 *
 * Mobile has no background worker to hand the keys to — LocalSession holds them
 * in page memory — and Android kills a backgrounded app whenever it likes. So
 * the choice is not "lock now or lock later", it is "drop the keys deliberately
 * or wait and see whether the OS did it for us". The auto-lock timer still runs
 * for the case where the app stays in front and the person walks away.
 */
onBackground(() => { if (unlocked.value) lock(); });

render(<App />, document.getElementById('root')!);

// PWA service worker — web only, never inside the extension
// The Capacitor WebView serves these files from local disk over http://localhost,
// which looks exactly like a PWA to the check below — but a service worker there
// is a second cache in front of files that are already local, and one more thing
// that can serve a stale app after an update.
const MOBILE = import.meta.env.VITE_MOBILE === '1';
if ('serviceWorker' in navigator && !DEMO && !MOBILE && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// touch these so TS keeps the live imports even when a screen forgets one
void blockNumber; void account;
