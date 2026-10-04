import type { ComponentChildren, JSX, RefObject } from 'preact';
/** Shared visual bits: starfield, footer ritual, LCD counter. */
import { blockNumber, screen, nfts, type Screen } from './state.js';
import { CHAINS, explorerTxUrl } from '@radwallet/core';
import { useEffect, useLayoutEffect } from 'preact/hooks';
import { guardScreen } from './native.js';
import { BADGE, AWARD } from './assets.js';

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Give a wallet sheet the behavior promised by role="dialog": move focus in,
 * keep keyboard navigation inside, make the wallet behind it inert, and put
 * focus back where it came from after close.
 */
export function useModalDialog(
  dialogRef: RefObject<HTMLElement>,
  onClose: () => void,
): void {
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const underlay = [...document.querySelectorAll<HTMLElement>('#app > *')]
      .filter((node) => !node.contains(dialog))
      .map((node) => ({
        node,
        inert: node.inert,
        ariaHidden: node.getAttribute('aria-hidden'),
      }));
    for (const { node } of underlay) {
      node.inert = true;
      node.setAttribute('aria-hidden', 'true');
    }

    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((node) => node.getClientRects().length > 0);
    const focusFirst = () => {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      (preferred ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    };
    focusFirst();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (nodes.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const prior of underlay) {
        prior.node.inert = prior.inert;
        if (prior.ariaHidden === null) prior.node.removeAttribute('aria-hidden');
        else prior.node.setAttribute('aria-hidden', prior.ariaHidden);
      }
      if (previousFocus?.isConnected) {
        requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
      }
    };
    // A dialog component exists only while its sheet is open. Re-running this
    // effect on ordinary renders would steal focus back from fields mid-entry.
  }, []);
}

const COLS = ['#fff', '#aab6ff', '#e0b0ff', '#ff9ecb', '#9be7ff'];

/**
 * A control that is a glyph and nothing else.
 *
 * Words cost width the popup does not have, and a list that spells the same
 * action out once per row has stopped being scannable — the third "copy
 * address" tells you nothing the first two did not. So the glyph carries the
 * action and the word moves to the tooltip, where it is there when you need
 * to check and gone when you do not.
 *
 * `tip` is not decoration: it is the accessible name too, so a screen reader
 * never meets a button called "\u29c9". Pass `label` when the row's own
 * subject should be in that name ("copy main bro's address") and the tooltip
 * should stay short.
 *
 * NOT for anything consequential. A glyph is a guess until you hover, and
 * hovering does not exist on a phone — REFUSE, CANCEL IT and SIGN & SEND keep
 * their words, because being sure matters more there than being narrow.
 */
export function IconBtn({
  glyph, tip, label, onClick, disabled, className = '', below, expanded, ...drag
}: Pick<JSX.HTMLAttributes<HTMLButtonElement>, 'draggable' | 'onDragStart' | 'onDragEnd'> & {
  glyph: string;
  tip: string;
  label?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  below?: boolean;
  /** set when the button folds something away, so a screen reader is told
      which way it currently sits rather than only what it does */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      class={`iconbtn tip${below ? ' below' : ''}${className ? ` ${className}` : ''}`}
      data-tip={tip}
      aria-label={label ?? tip}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      {...drag}
    >{glyph}</button>
  );
}

/**
 * A transaction hash is useful because it is a door into the chain, not a
 * receipt-shaped wall of hex. The chain ID travels with the hash so a Base tx
 * can never be opened on Etherscan and look as if it vanished.
 */
export function TxLink({
  chainId, hash, children, className = 'addr',
}: {
  chainId: number;
  hash: string;
  children?: ComponentChildren;
  className?: string;
}) {
  const href = explorerTxUrl(chainId, hash);
  const network = CHAINS[chainId]?.name ?? `chain ${chainId}`;
  if (!href) {
    return <span class={`${className} txlink dim`.trim()} title={`${network} has no configured block explorer`}>
      {children ?? hash}
    </span>;
  }
  return (
    <a
      class={`${className} txlink`.trim()}
      href={href}
      title={`view on ${new URL(href).host}`}
      aria-label={`view this transaction on the ${network} block explorer`}
      target="_blank"
      rel="noreferrer"
    >{children ?? hash}</a>
  );
}

export function EthIcon({ className = '' }: { className?: string }) {
  return (
    <svg class={`ethicon ${className}`.trim()} viewBox="0 0 32 32" role="img" aria-label="Ether">
      <circle cx="16" cy="16" r="16" fill="#627eea" />
      <path fill="#fff" fill-opacity=".72" d="M16 3.8v9l7.6 3.4z" />
      <path fill="#fff" d="M16 3.8 8.4 16.2l7.6-3.4z" />
      <path fill="#fff" fill-opacity=".72" d="m16 28.1 7.6-10.5-7.6 4.5z" />
      <path fill="#fff" d="m8.4 17.6 7.6 10.5v-6z" />
      <path fill="#fff" fill-opacity=".35" d="m16 20.7 7.6-4.5-7.6-3.4z" />
      <path fill="#fff" fill-opacity=".72" d="m8.4 16.2 7.6 4.5v-7.9z" />
    </svg>
  );
}

/**
 * Which mainnet a testnet is a copy of. A testnet flies its parent's flag with
 * the colour drained out: one rule for all of them, so the mark reads as "that
 * chain, but not the real one" at 16px without anyone reading the label.
 */
const TESTNET_PARENT: Record<number, number> = { 11155111: 1, 84532: 8453, 46630: 4663 };

/** Local, tracker-free chain marks. No logo CDN request leaves the wallet. */
export function ChainIcon({ chainId }: { chainId: number }) {
  const parent = TESTNET_PARENT[chainId];
  if (parent) {
    return (
      <span class="chainmark test" title={`${CHAINS[chainId]?.name ?? 'testnet'} — test network`}>
        <ChainIcon chainId={parent} />
      </span>
    );
  }
  if (chainId === 1) return <EthIcon className="chainicon" />;
  if (chainId === 8453) {
    return (
      <svg class="chainicon" viewBox="0 0 32 32" role="img" aria-label="Base">
        <circle cx="16" cy="16" r="16" fill="#0052ff" />
        <path fill="#fff" d="M8 11.2h11.4a6.2 6.2 0 1 1 0 9.6H8v-4h11.2a2.2 2.2 0 1 0 0-1.6H8z" />
      </svg>
    );
  }
  if (chainId === 42161) {
    return (
      <svg class="chainicon" viewBox="0 0 32 32" role="img" aria-label="Arbitrum">
        <circle cx="16" cy="16" r="16" fill="#213147" />
        <path fill="#2d8fff" d="m9.2 23.4 3.4 2 8.9-15.1-3.4-2z" />
        <path fill="#72c7ff" d="m14.4 26.4 3.5 2 7.6-12.9-2-4.1z" />
        <path fill="#fff" d="m6.6 18.9 2.1 4.2 7.3-12.4-2.4-4z" />
      </svg>
    );
  }
  if (chainId === 4663) {
    // the official Robinhood Chain mark: their feather, on their lime. Taken
    // from robinhood's own docs asset (feather-light.svg) and bundled rather
    // than hotlinked, like every other icon here. Colours sampled from their
    // favicon: #CCFF00 ground, black feather.
    return (
      <svg class="chainicon" viewBox="0 0 32 32" role="img" aria-label="Robinhood Chain">
        <circle cx="16" cy="16" r="16" fill="#CCFF00" />
        <g transform="translate(8.6 5.6) scale(0.465)">
          <path fill="#000" d="M0.237711 42H1.14916C1.31483 42 1.48056 41.9157 1.53587 41.7753C8.41284 23.9672 15.8974 15.1474 20.5926 9.86673C20.786 9.64201 20.7031 9.47355 20.4269 9.47355H12.0309C11.727 9.47355 11.4702 9.59707 11.2576 9.86673L5.23667 17.4507C4.3529 18.5742 4.13199 19.6134 4.13199 21.1021V28.8546C2.17104 34.4442 0.92819 38.2362 0.0168015 41.663C-0.038442 41.882 0.0444232 42 0.237711 42ZM30.5353 1.13119C29.2372 -0.273195 23.3821 -0.329391 20.6754 0.738011C20.1121 0.959852 19.5707 1.33622 19.3221 1.5525C16.8364 3.71537 15.1794 5.4288 13.6051 7.11409C13.4117 7.31068 13.4947 7.50727 13.7709 7.50727H23.0783C23.9345 7.50727 24.4316 8.01291 24.4316 8.88359V19.5573C24.4316 19.8382 24.6525 19.9225 24.8183 19.6696L30.4248 12.2261C31.3362 11.0183 31.6124 10.6532 31.8609 8.96792C32.1924 6.49613 31.999 2.70423 30.5353 1.13119ZM18.5212 29.4445L22.3601 23.0121C22.4431 22.8437 22.4706 22.647 22.4706 22.5066V11.7767C22.4706 11.4958 22.2773 11.3836 22.0841 11.6082C16.3118 18.1529 11.8099 25.0346 7.6395 33.3207C7.53455 33.5285 7.66712 33.7139 7.91572 33.6297L16.5327 30.9332C17.5048 30.6298 18.0517 30.231 18.5212 29.4445Z" />
        </g>
      </svg>
    );
  }
  return <span class="chainicon unknown" aria-label={`chain ${chainId}`}>?</span>;
}

function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 48271) % 2147483647), s / 2147483647);
}

export function Starfield({ seed = 1337 }: { seed?: number }) {
  const r = lcg(seed);
  const shadows: string[] = [];
  for (let i = 0; i < 220; i++) {
    shadows.push(
      `${Math.floor(r() * 430)}px ${Math.floor(r() * 900)}px 0 ${r() < 0.12 ? 1 : 0}px ${
        COLS[Math.floor(r() * COLS.length)]
      }`,
    );
  }
  return (
    <div class="starlayer">
      <div style={{ width: 1, height: 1, background: '#fff', boxShadow: shadows.join(',') }} />
    </div>
  );
}

export function BlockCounter({ caption = 'current block' }: { caption?: string }) {
  const n = blockNumber.value;
  return (
    <div class="counterline">
      <span class="lcd">{n === 0n ? '········' : String(n)}</span>
      <br />
      <span>{caption}</span>
    </div>
  );
}

export function FooterRing({ note }: { note?: string }) {
  return (
    <div class="footerring">
      <img src={BADGE} alt="" />
      <img class="aw" src={AWARD} alt="" />
      <div class="madewith">{note ?? 'open source · no server · check the chain'}</div>
    </div>
  );
}

/**
 * The bottom tab bar every wallet on a phone has, because thumbs live down
 * there. Five destinations, always visible, current one lit — the same
 * arrangement as Phantom's, wearing our own clothes.
 *
 * SWAP appears here AND in the action tiles on HOME; that duplication is
 * deliberate and matches how the wallets people already use behave.
 */
const TABS: { to: Screen; ic: string; label: string }[] = [
  { to: 'home', ic: '⌂', label: 'HOME' },
  { to: 'nfts', ic: '▣', label: 'NFTS' },
  { to: 'swap', ic: '⇄', label: 'SWAP' },
  { to: 'activity', ic: '◷', label: 'ACTIVITY' },
  { to: 'settings', ic: '◈', label: 'SETTINGS' },
];

export function TabBar() {
  const here = screen.value;
  const count = nfts.value.reduce((n, x) => n + x.count, 0);
  return (
    <nav class="tabbar" aria-label="main">
      {TABS.map((t) => (
        <button
          key={t.to}
          class={`tab${here === t.to ? ' on' : ''}`}
          aria-current={here === t.to ? 'page' : undefined}
          onClick={() => (screen.value = t.to)}
        >
          <span class="ic">{t.ic}</span>
          <span class="lb">{t.label}</span>
          {t.to === 'nfts' && count > 0 && <span class="badge">{count > 99 ? '99+' : count}</span>}
        </button>
      ))}
    </nav>
  );
}

/**
 * A token's own icon with its chain badged onto the corner — the arrangement
 * every multi-chain wallet uses, because "USDC" means nothing until you know
 * which chain it is sitting on, and a separate column for that costs a line
 * of width the popup does not have.
 *
 * The badge is dropped on chains where it would be noise: on a single-chain
 * view, or where the token IS the chain's native coin and the icon already
 * says so.
 */
export function AssetIcon({ chainId, badge = true, children }: {
  chainId: number; badge?: boolean; children: ComponentChildren;
}) {
  return (
    <span class="asseticon">
      {children}
      {badge && (
        <span class="chainbadge" aria-hidden="true">
          <ChainIcon chainId={chainId} />
        </span>
      )}
    </span>
  );
}

/**
 * A token with no bundled icon gets a lettermark: its own symbol, on a colour
 * derived from its contract address.
 *
 * The alternative was drawing brand logos from memory, which is precisely how
 * the Robinhood mark ended up being a letter "R" that nobody at Robinhood has
 * ever used. A lettermark cannot be wrong about what it depicts: it shows the
 * symbol the contract itself reports.
 *
 * The colour is a hash of the address, so a given token looks the same every
 * time and two tokens in one list rarely collide — which is the actual job,
 * telling rows apart at a glance.
 */
const MARK_COLOURS = ['#ffe000', '#39ff14', '#b26bff', '#ff2a2a', '#4da6ff', '#ff8c1a', '#00d4c8'];

export function LetterMark({ symbol, seed }: { symbol: string; seed?: string }) {
  const clean = (symbol || '?').replace(/^\$/, '');
  // three characters is the most that stays legible at row size; the full
  // symbol is printed next to the icon anyway, so the mark only has to make
  // rows tellable apart, not spell the token out
  const letters = clean.slice(0, 3).toUpperCase();
  const key = (seed || symbol || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const colour = MARK_COLOURS[hash % MARK_COLOURS.length];
  // longer symbols shrink, and everything sits a touch high and left of centre
  // so the chain badge in the bottom-right corner cannot sit on top of it
  const size = letters.length === 3 ? 12 : letters.length === 2 ? 15 : 18;
  return (
    <svg class="chainicon lettermark" viewBox="0 0 32 32" role="img" aria-label={symbol}>
      <circle cx="16" cy="16" r="16" fill={colour} />
      <text
        x="15" y="14.5" fill="#000" font-size={size} font-weight="bold"
        font-family="'Courier New',monospace" text-anchor="middle" dominant-baseline="central"
      >{letters}</text>
    </svg>
  );
}

/**
 * Hold FLAG_SECURE for as long as `active` is true.
 *
 * A hook rather than a call so the flag can never be left on: the cleanup runs
 * when the screen unmounts, including when it unmounts because the user hit
 * back, which is exactly the path a manual `guardScreen(false)` forgets.
 */
export function useScreenGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    void guardScreen(true);
    return () => { void guardScreen(false); };
  }, [active]);
}
