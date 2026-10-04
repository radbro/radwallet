/**
 * The site you are looking at, and which wallet it can see.
 *
 * Every wallet makes you start the handshake from the page: find the site's
 * own Connect button, pick the wallet from a list, approve. But the wallet
 * already knows which tab is in front of you, so it can offer the same thing
 * directly — and, more usefully, it can tell you when the site is connected to
 * a DIFFERENT wallet than the one you are looking at, which is otherwise
 * invisible until a transaction comes from an address you did not expect.
 *
 * Changing the site's connection emits EIP-1193 `accountsChanged`. Selecting
 * its already-connected wallet only changes which wallet the owner is viewing.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { account, accounts, say, sayError, pickerOpen, selectAccount } from '../state.js';
import { session } from '../session.js';
import {
  activeTab, onTabChanged, store as extStore, IS_EXTENSION, type DappSighting,
} from '../ext.js';

function host(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function SiteBar() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [dapp, setDapp] = useState<DappSighting>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);
  const acct = account.value;

  const load = async () => {
    if (!IS_EXTENSION) return;
    const seq = ++seqRef.current;
    const tab = await activeTab();
    if (seq !== seqRef.current) return;   // a newer switch already won
    const o = tab?.origin ?? null;
    setOrigin(o);
    setDapp(tab?.dapp ?? null);
    if (!o) return;
    const raw = await extStore.get<string>('connections');
    try {
      const map = raw ? JSON.parse(raw) : {};
      setConnected(Array.isArray(map[o]) ? map[o] : []);
    } catch { setConnected([]); }
  };

  useEffect(() => {
    void load();
    // follow the tab while docked. The events carry no URL — they only say
    // "look again" — and a stale answer from a tab you have already left is
    // dropped by the sequence check in load().
    return onTabChanged(() => { void load(); });
  }, []);

  // no content script answered: not a web page (new tab, settings, a PDF), so
  // there is nothing to connect to and nothing to say about it
  if (!IS_EXTENSION || !acct || !origin) return null;

  /*
    Most of the web is not a dapp, and offering to connect your wallet to
    translate.google.com is noise that makes the button mean less everywhere
    else. There is no reliable list of "web3 sites" to check against — but the
    provider we inject can see whether the page's own code ever touched it,
    which is the only signal that actually means anything (see inpage.js).
    A site you are already connected to always gets the full bar, so you can
    always find the disconnect.
  */
  if (!dapp && connected.length === 0) {
    return (
      <div class="sitebar quiet">
        <span class="who">
          <span class="hostname">{host(origin)}</span>
          <span class="state">no wallet request detected</span>
        </span>
        <button class="act refresh tip" data-tip="re-check" aria-label="re-check this site" onClick={() => void load()}>↻</button>
      </div>
    );
  }

  const mine = connected.some((a) => a.toLowerCase() === acct.address.toLowerCase());
  const other = !mine && connected.length > 0 ? connected[0] : null;
  const otherAccount = other
    ? accounts.value.find((a) => a.address.toLowerCase() === other.toLowerCase())
    : undefined;
  const otherLabel = otherAccount?.label ?? (other ? short(other) : null);

  async function set(addresses: string[], msg: string) {
    if (busy) return;
    setBusy(true);
    try {
      await session.setConnection(origin!, addresses);
      setConnected(addresses);
      say(msg);
    } catch (e) {
      sayError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={`sitebar${mine ? ' on' : ''}`}>
      <span class="dot" aria-hidden="true">{mine ? '●' : '○'}</span>
      <span class="who">
        <span class="hostname">{host(origin)}</span>
        <span class="state">
          {mine
            ? `connected as ${acct.label}`
            : other
              ? `connected as ${otherLabel} — not this wallet`
              : 'not connected'}
        </span>
        {otherAccount && (
          <button
            class="act switch-wallet" disabled={busy}
            onClick={() => selectAccount(otherAccount.index)}
          >switch to connected wallet</button>
        )}
      </span>
      {mine ? (
        <button
          class="act danger" disabled={busy}
          onClick={() => void set([], `disconnected from ${host(origin)}.`)}
        >disconnect</button>
      ) : (
        <button
          class="act" disabled={busy}
          onClick={() => void set(
            [acct.address],
            other
              ? `${host(origin)} switched to ${acct.label}.`
              : `connected ${acct.label} to ${host(origin)}.`,
          )}
        >{busy ? '…' : other ? `use ${acct.label}` : 'connect'}</button>
      )}
      {other && (
        <button
          class="act tip" data-tip="pick a different wallet" aria-label="pick a different wallet"
          onClick={() => (pickerOpen.value = true)}
        >⇅</button>
      )}
      {/* the bar follows the tab on its own; this is for a connection made
          from the site's own button while the wallet was already open */}
      <button class="act refresh tip" data-tip="re-check" aria-label="re-check this site" onClick={() => void load()}>↻</button>
    </div>
  );
}
