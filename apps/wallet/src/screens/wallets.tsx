/**
 * The wallet drawer: every wallet in the vault, grouped by where it came from.
 *
 * Seed groups list the BIP-44 accounts derived from one mnemonic. Loose keys —
 * raw private keys the user imported — get their own group, because they are
 * genuinely different: your seed phrase does not back them up and they have no
 * stealth meta-address. The UI says so rather than papering over it.
 *
 * The layout follows what every wallet's account switcher has settled on,
 * because those conventions are load-bearing rather than decorative:
 *
 *   [ WALLETS ]              12  [X]   sticky header; Esc / backdrop also close
 *   find a wallet…                     search, once the list is long enough
 *   (all) (hot) (daily)                label chips, once labels exist
 *   ────────────────────────────────   only the list scrolls
 *   SEED #1                   2 BROS   quiet group header carrying a count
 *   ┃▸ main bro       0x9010…129c      one row = one tap target
 *   │  wallet 2        0x58A5…1b25 […]  row actions hidden until asked for
 *   ────────────────────────────────
 *   [+ ADD WALLET]                     one primary action, pinned
 *
 * Per-account balances mean asking the pool about every address you own; each
 * address is swept through its own pinned endpoint (see valueAllWallets), while
 * address-free one-token prices are shared across the resulting snapshots.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WalletAccount } from '@radwallet/core';
import {
  pickerOpen, filteredGroups, knownLabels, labelFilter, selected, groups, accounts,
  selectAccount, addAccount, addSeed, importPrivateKey, renameAccount,
  setAccountLabels, renameGroup, forgetGroup, forgetAccount, sayError, lock,
  valueAllWallets, walletValues, valuingWallets, walletValueProgress,
  allWalletsEth, usdRate, usd,
  refreshEverything, revealKey, revealPhrase, say,
} from '../state.js';
import { IconBtn, useModalDialog, useScreenGuard } from '../bits.js';
import { SecretClipboard, type SecretClipboardStatus } from '../secret-clipboard.js';
import { walletList, loadWalletList, orderedWalletGroups, toggleWalletGroup, moveSeedGroup } from '../wallet-list.js';

/** past this many wallets a search box earns its space; below it, it is clutter */
const SEARCH_AT = 6;

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type Editing = { what: 'acct-nick' | 'acct-labels'; index: number } | { what: 'group-nick'; id: string };

async function guard(run: () => Promise<void>): Promise<void> {
  try { await run(); } catch (e) { sayError(e); }
}

/** one-line text editor used for nicknames and label lists */
function InlineEdit({ initial, placeholder, onDone, onCancel }: {
  initial: string; placeholder: string; onDone: (v: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <div class="walletedit">
      <input
        class="field" autofocus placeholder={placeholder} value={v}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // while this is open, Esc belongs to the editor
          if (e.key === 'Enter') onDone(v);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button class="act" onClick={() => onDone(v)}>save</button>
      <span class="sep">·</span>
      <button class="act" onClick={onCancel}>cancel</button>
    </div>
  );
}

/** the one primary action, pinned to the bottom of the drawer */
function AddWallet({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<null | 'menu' | 'create' | 'seed' | 'key'>(null);
  const [text, setText] = useState('');
  const [nick, setNick] = useState('');
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const [seedId, setSeedId] = useState(() => accounts.value.find((a) => a.index === selected.value)?.groupId);
  const seedGroups = groups.value.filter((g) => g.kind === 'seed');
  const targetSeed = seedGroups.find((g) => g.id === seedId) ?? seedGroups[0];
  useScreenGuard(mode === 'seed' || mode === 'key');

  if (mode === null) {
    return <button class="btn block" onClick={() => setMode('menu')}>+ ADD WALLET</button>;
  }
  if (mode === 'menu') {
    return (
      <div class="addmenu">
        <button class="btn block" onClick={() => setMode('create')}>
          CREATE ANOTHER ADDRESS
        </button>
        <button class="btn ghost block" onClick={() => { setMode('seed'); setText(''); setNick(''); }}>
          IMPORT A SEED PHRASE
        </button>
        <button class="btn ghost block" onClick={() => { setMode('key'); setText(''); setNick(''); }}>
          IMPORT A PRIVATE KEY
        </button>
        <button class="act block center" onClick={() => setMode(null)}>never mind</button>
      </div>
    );
  }

  if (mode === 'create') {
    return (
      <div class="panel addform">
        <div class="hd">CREATE ANOTHER ADDRESS</div>
        {targetSeed ? (
          <>
            <label class="row">
              <span>Use seed phrase</span>
              <select class="netsel wide" style={{ minHeight: 'var(--tap-size, 44px)', background: '#000', color: 'var(--yl)', font: 'inherit' }}
                aria-label="seed phrase for new address" value={targetSeed.id}
                disabled={working} onChange={(e) => setSeedId((e.target as HTMLSelectElement).value)}>
                {seedGroups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <div class="note">The new address is backed up by this same seed phrase. No new phrase is created.</div>
            <div class="btnrow">
              <button class="btn ghost" disabled={working} onClick={() => setMode('menu')}>BACK</button>
              <button class="btn" disabled={working} onClick={() => {
                if (workingRef.current) return;
                workingRef.current = true;
                setWorking(true);
                void guard(async () => {
                  await addAccount(targetSeed.id);
                  onClose();
                  say(`new address created under ${targetSeed.label}. the same seed phrase backs it up.`);
                }).finally(() => { workingRef.current = false; setWorking(false); });
              }}>{working ? 'CREATING…' : 'CREATE ADDRESS'}</button>
            </div>
          </>
        ) : (
          <>
            <div class="note">Imported private keys each control one address. Import a seed phrase first to create another address from it.</div>
            <div class="btnrow">
              <button class="btn ghost" onClick={() => setMode('menu')}>BACK</button>
              <button class="btn" onClick={() => { setMode('seed'); setText(''); setNick(''); }}>IMPORT SEED PHRASE</button>
            </div>
          </>
        )}
      </div>
    );
  }

  const isSeed = mode === 'seed';
  const ready = isSeed ? text.trim().split(/\s+/).length >= 12 : text.trim().length >= 64;

  return (
    <div class="panel addform">
      <div class="hd">{isSeed ? 'IMPORT SEED PHRASE' : 'IMPORT PRIVATE KEY'}</div>
      <div class="note">
        {isSeed
          ? 'an existing seed phrase, sealed into the same vault under the same password.'
          : 'a raw 32-byte key, sealed into the same vault under the same password. your seed phrase cannot restore it — it was never derived from those words — so keep the original. no stealth address either.'}
      </div>
      <textarea
        class="field" placeholder={isSeed ? 'seed phrase…' : '0x…'} value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <input
        class="field" placeholder="nickname (optional)" value={nick}
        onInput={(e) => setNick((e.target as HTMLInputElement).value)}
      />
      <div class="btnrow">
        <button class="btn ghost" disabled={working} onClick={() => setMode('menu')}>BACK</button>
        <button
          class="btn" disabled={!ready || working}
          onClick={() => {
            if (workingRef.current) return;
            workingRef.current = true;
            setWorking(true);
            void guard(async () => {
              const label = nick.trim() || undefined;
              if (isSeed) await addSeed(text, label);
              else await importPrivateKey(text, label);
              setMode(null);
              setText('');
              setNick('');
              onClose();
            }).finally(() => { workingRef.current = false; setWorking(false); });
          }}
        >
          {working ? 'IMPORTING…' : 'IMPORT'}
        </button>
      </div>
    </div>
  );
}

/**
 * Two-step destructive action. Native confirm() is not reliably available in an
 * extension popup, and a wallet should say what it is about to destroy anyway.
 * Red is the ordinary link colour in this UI, so armed destruction gets weight
 * and a block of its own rather than leaning on colour to carry the warning.
 */
function Forget({ what, warning, armed, onArm, onDo }: {
  what: string; warning?: string; armed: boolean; onArm: () => void; onDo: () => void;
}) {
  if (!armed) return <button class="act danger" onClick={onArm}>forget</button>;
  return (
    <div class="armed">
      <div class="what">forget {what}?</div>
      {warning && <div class="note">{warning}</div>}
      <div class="btnrow">
        <button class="btn ghost" onClick={onArm}>KEEP IT</button>
        <button class="btn danger" onClick={onDo}>FORGET IT</button>
      </div>
    </div>
  );
}

/**
 * REVEAL A SECRET — one private key, or one seed phrase.
 *
 * The most dangerous surface in the wallet, so it is built like the forget
 * blocks next to it and then some: it arms into its own bordered block, it
 * asks for the password EVERY time (the session boundary opens the sealed
 * vault with what you type, not with the session you already have open), and
 * the secret arrives blurred so that merely reaching this screen in front of
 * someone does not spend it.
 *
 * This is where words are earned. Everywhere else the wallet states the fact
 * and stops; here it is about to hand over the thing itself, and the warning
 * is the last chance to say what that means.
 */
function Reveal({ label, warning, armed, onArm, load }: {
  label: string;
  warning: string;
  armed: boolean;
  onArm: () => void;
  load: (password: string) => Promise<string>;
}) {
  const [pw, setPw] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyArmed, setCopyArmed] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState<SecretClipboardStatus>('idle');
  const clipboard = useRef<SecretClipboard | null>(null);
  const revealGeneration = useRef(0);
  // from the moment the export is armed, not just once the secret is on screen:
  // the password being typed is worth as much as what it unlocks
  useScreenGuard(armed);

  useLayoutEffect(() => {
    setPw('');
    setSecret(null);
    setShown(false);
    setBusy(false);
    setCopyArmed(false);
    setClipboardStatus('idle');
    if (!armed) return;
    const current = new SecretClipboard(navigator.clipboard, setClipboardStatus);
    clipboard.current = current;
    const clearOnLeave = () => { void current.clearIfUnchanged(); };
    window.addEventListener('pagehide', clearOnLeave);
    return () => {
      revealGeneration.current++;
      clipboard.current = null;
      window.removeEventListener('pagehide', clearOnLeave);
      void current.dispose();
    };
  }, [armed]);

  const close = () => {
    revealGeneration.current++;
    setPw(''); setSecret(null); setShown(false); setCopyArmed(false); onArm();
  };

  if (!armed) return <button class="act danger" onClick={onArm}>{label}</button>;

  if (secret) {
    return (
      <div class="armed reveal">
        <div class="what">{warning}</div>
        {/* blurred until asked for: getting this far should not be the same
            as showing it to the room */}
        <div
          class={`secretbox${shown ? '' : ' hidden'}`}
          onClick={() => setShown(true)}
          title={shown ? '' : 'tap to show'}
        >{secret}</div>
        <div class="btnrow">
          {(clipboardStatus === 'copied' || clipboardStatus === 'unavailable') ? (
            <button class="btn ghost" disabled={busy} onClick={async () => {
              if (!clipboard.current || busy) return;
              setBusy(true);
              try { await clipboard.current.clear(); } finally { setBusy(false); }
            }}>CLEAR CLIPBOARD</button>
          ) : <button
            class="btn ghost" disabled={busy}
            onClick={async () => {
              if (!copyArmed) {
                setCopyArmed(true);
                say('clipboard can be read by other apps. tap again if you still want that.');
                return;
              }
              if (!clipboard.current || busy) return;
              setBusy(true);
              try {
                await clipboard.current.copy(secret);
                setCopyArmed(false);
              } catch (err) { sayError(err); }
              finally { setBusy(false); }
            }}
          >{copyArmed ? 'YES, COPY' : 'COPY?'}</button>}
          <button class="btn" onClick={close}>DONE</button>
        </div>
        {clipboardStatus !== 'idle' && (
          <div class="note clipboard-status" role="status">
            {clipboardStatus === 'copied'
              ? 'Secret copied. Auto-clear is attempted after 10 seconds. Closing the popup can interrupt it; use CLEAR CLIPBOARD before closing.'
              : clipboardStatus === 'cleared' ? 'Clipboard cleared.'
                : clipboardStatus === 'replaced' ? 'Clipboard changed. Your newer copy was kept.'
                  : 'Clipboard clearing was blocked. Use CLEAR CLIPBOARD or clear it yourself before closing.'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="armed reveal">
      <div class="what">{warning}</div>
      <form
        class="pwform"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !pw) return;
          setBusy(true);
          const generation = revealGeneration.current;
          try {
            const next = await load(pw);
            if (generation === revealGeneration.current) setSecret(next);
          } catch (err) {
            if (generation === revealGeneration.current) sayError(err);
          } finally {
            if (generation === revealGeneration.current) { setPw(''); setBusy(false); }
          }
        }}
      >
        <input
          class="field" type="password" name="password" autocomplete="current-password"
          placeholder="your password" value={pw}
          onInput={(e) => setPw((e.target as HTMLInputElement).value)}
        />
        <div class="btnrow">
          <button class="btn ghost" type="button" onClick={close}>CANCEL</button>
          <button class="btn danger" type="submit" disabled={busy || !pw}>
            {busy ? '[ OPENING ]' : 'SHOW IT'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ a, editing, setEditing, armed, setArmed, selectedRef }: {
  a: WalletAccount; editing: Editing | null; setEditing: (e: Editing | null) => void;
  armed: string | null; setArmed: (v: string | null) => void;
  selectedRef?: (node: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSel = selected.value === a.index;
  const editingNick = editing?.what === 'acct-nick' && editing.index === a.index;
  const editingLabels = editing?.what === 'acct-labels' && editing.index === a.index;
  const isArmed = armed === `acct:${a.index}`;

  return (
    <div class={`walletrow${isSel ? ' sel' : ''}`} ref={isSel ? selectedRef : undefined}>
      <div class="line">
        <button
          class="pick" aria-current={isSel ? 'true' : 'false'}
          onClick={() => { selectAccount(a.index); pickerOpen.value = false; }}
        >
          <span class="mark" aria-hidden="true">{isSel ? '▸' : ''}</span>
          <span class="who">
            <span class="nick">{a.label}</span>
            {a.labels.length > 0 && <span class="rowlabels">{a.labels.join(' · ')}</span>}
          </span>
          <span class="addr">
            {short(a.address)}
            {usdRate.value !== null && walletValues.value[a.address] !== undefined && (
              <span class="rowvalue">{usd(walletValues.value[a.address] * usdRate.value)}</span>
            )}
          </span>
        </button>
        {/* tapping the row SWITCHES wallets, so copying the address of one you
            are not using needs its own target. A glyph rather than a word: it
            sits on every row, and a row that reads "copy address" three times
            has stopped being scannable. The tooltip carries the word instead. */}
        <IconBtn
          className="copyaddr" glyph="⧉" tip="copy address"
          label={`copy ${a.label}'s address`}
          onClick={() => {
            void navigator.clipboard.writeText(a.address).then(() => say('address copied'));
          }}
        />
        <button
          class={`more tip${open ? ' on' : ''}`} data-tip="more"
          aria-expanded={open ? 'true' : 'false'}
          aria-label={`more for ${a.label}`}
          onClick={() => setOpen(!open)}
        >…</button>
      </div>

      {editingNick && (
        <InlineEdit
          initial={a.label} placeholder="nickname"
          onCancel={() => setEditing(null)}
          onDone={(v) => { setEditing(null); void guard(() => renameAccount(a.index, v)); }}
        />
      )}
      {editingLabels && (
        <InlineEdit
          initial={a.labels.join(', ')} placeholder="labels, comma, separated"
          onCancel={() => setEditing(null)}
          onDone={(v) => {
            setEditing(null);
            void guard(() => setAccountLabels(a.index, v.split(',')));
          }}
        />
      )}

      {(open || isArmed) && (
        <div class="acts">
          <button
            class="act"
            onClick={() => { setOpen(false); setEditing({ what: 'acct-nick', index: a.index }); }}
          >rename</button>
          <span class="sep">·</span>
          <button
            class="act"
            onClick={() => { setOpen(false); setEditing({ what: 'acct-labels', index: a.index }); }}
          >labels</button>
          <span class="sep">·</span>
          {/* every wallet can be exported, seed-derived or imported. A key you
              cannot take with you is a key you are only borrowing. */}
          <Reveal
            label="export key"
            warning={`the private key for ${a.label}. anyone who reads it owns this wallet — no password, no confirmation, nothing to revoke. put it somewhere only you can reach.`}
            armed={armed === `key:${a.index}`}
            onArm={() => setArmed(armed === `key:${a.index}` ? null : `key:${a.index}`)}
            load={(pw) => revealKey(a.index, pw)}
          />
          {a.kind === 'imported' && (
            <>
              <span class="sep">·</span>
              <Forget
                what={`${a.label} (${short(a.address)}) from this device`}
                warning="you need a backup of its private key to restore it. your seed phrase cannot restore this wallet."
                armed={isArmed}
                onArm={() => setArmed(isArmed ? null : `acct:${a.index}`)}
                onDo={() => { setArmed(null); setOpen(false); void guard(() => forgetAccount(a.index)); }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WalletBackups({ armed, setArmed }: {
  armed: string | null; setArmed: (value: string | null) => void;
}) {
  return (
    <>
      <div class="note">A seed phrase restores every address created from it. Imported private keys need separate backups. Your vault password alone cannot restore either.</div>
      {groups.value.filter((g) => g.kind === 'seed').map((g) => (
        <div class="panel backup-group" key={g.id}>
          <div class="hd">{g.label}</div>
          <div class="note">{g.members.length} wallet{g.members.length === 1 ? '' : 's'} · one seed phrase</div>
          <Reveal
            label="BACK UP SEED PHRASE"
            warning={`the seed phrase for ${g.label} restores every wallet in this group, including addresses you add later. anyone with it can spend their funds.`}
            armed={armed === `backup-phrase:${g.id}`}
            onArm={() => setArmed(armed === `backup-phrase:${g.id}` ? null : `backup-phrase:${g.id}`)}
            load={(pw) => revealPhrase(g.id, pw)}
          />
        </div>
      ))}
      {accounts.value.filter((a) => a.kind === 'imported').map((a) => (
        <div class="panel backup-key" key={a.address}>
          <div class="hd">{a.label}</div>
          <div class="note">{short(a.address)} · imported private key</div>
          <Reveal
            label="BACK UP PRIVATE KEY"
            warning={`the private key for ${a.label} restores only this wallet. your seed phrases cannot restore it. anyone with this key can spend its funds.`}
            armed={armed === `backup-key:${a.index}`}
            onArm={() => setArmed(armed === `backup-key:${a.index}` ? null : `backup-key:${a.index}`)}
            load={(pw) => revealKey(a.index, pw)}
          />
        </div>
      ))}
    </>
  );
}

export function WalletPicker() {
  const [editing, setEditing] = useState<Editing | null>(null);
  /** which destructive action is armed, if any */
  const [armed, setArmed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [openFilterReset, setOpenFilterReset] = useState(0);
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null);
  const dragging = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLDivElement | null>(null);
  const selectedGroupHeading = useRef<HTMLDivElement>(null);
  const autoRevealActive = useRef(true);
  const setSelectedRow = useCallback((node: HTMLDivElement | null) => {
    selectedRow.current = node;
  }, []);

  const close = (): void => { pickerOpen.value = false; };

  /*
    The first open fills missing values. Reopening this drawer reuses them;
    ordinary balance refreshes invalidate the selected row, and ↻ ALL is the
    explicit full re-read. This avoids turning drawer navigation into another
    burst over every address the user owns.
  */
  useEffect(() => {
    void guard(loadWalletList);
    if (accounts.value.some((a) => walletValues.value[a.address] === undefined)) {
      void valueAllWallets();
    }
  }, []);

  useModalDialog(box, close);

  useLayoutEffect(() => {
    const filter = labelFilter.value;
    const current = accounts.value.find((a) => a.index === selected.value);
    if (!filter || !current || current.labels.includes(filter)) return;
    selectedRow.current = null;
    labelFilter.value = null;
    setOpenFilterReset((n) => n + 1);
  }, []);

  useEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    const stopAutoReveal = () => { autoRevealActive.current = false; };
    const stopOnBrowseKey = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
        stopAutoReveal();
      }
    };
    dialog.addEventListener('wheel', stopAutoReveal, { passive: true });
    dialog.addEventListener('pointerdown', stopAutoReveal);
    dialog.addEventListener('touchstart', stopAutoReveal, { passive: true });
    dialog.addEventListener('keydown', stopOnBrowseKey);
    return () => {
      dialog.removeEventListener('wheel', stopAutoReveal);
      dialog.removeEventListener('pointerdown', stopAutoReveal);
      dialog.removeEventListener('touchstart', stopAutoReveal);
      dialog.removeEventListener('keydown', stopOnBrowseKey);
    };
  }, []);

  const seedCount = groups.value.filter((g) => g.kind === 'seed').length;
  const showSearch = accounts.value.length > SEARCH_AT;
  const walletValueCount = Object.keys(walletValues.value).length;
  const q = query.trim().toLowerCase();
  const filtering = !!q || labelFilter.value !== null;
  const orderedSeeds = orderedWalletGroups(groups.value).filter((g) => g.kind === 'seed');

  const finishDrag = () => { dragging.current = null; setDropTarget(null); };
  const moveGroup = (id: string, targetId: string, placement: 'before' | 'after') => {
    if (filtering) return;
    autoRevealActive.current = false;
    void guard(() => moveSeedGroup(id, targetId, placement, groups.value));
  };

  // search rides on top of the label filter rather than replacing it
  const shown = orderedWalletGroups(filteredGroups.value)
    .map((g) => ({
      ...g,
      members: q
        ? g.members.filter((m) =>
          m.label.toLowerCase().includes(q) ||
          m.address.toLowerCase().includes(q) ||
          m.labels.some((l) => l.toLowerCase().includes(q)))
        : g.members,
    }))
    .filter((g) => g.members.length > 0);

  useLayoutEffect(() => {
    if (backingUp || !autoRevealActive.current) return;
    const scrollSelected = () => {
      const scroller = body.current;
      const row = selectedRow.current ?? selectedGroupHeading.current;
      if (!scroller || !row) return;
      const scrollerBox = scroller.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const rowCenter = rowBox.top + (rowBox.height / 2);
      const scrollerCenter = scrollerBox.top + (scrollerBox.height / 2);
      scroller.scrollTop += rowCenter - scrollerCenter;
    };
    scrollSelected();
    const frame = requestAnimationFrame(scrollSelected);
    return () => cancelAnimationFrame(frame);
  }, [backingUp, accounts.value.length, selected.value, openFilterReset, valuingWallets.value, walletValueCount, walletList.value]);

  return (
    <div class="drawer" onMouseDown={(e) => { if (!box.current?.contains(e.target as Node)) close(); }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label="wallets" tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">{backingUp ? '[ WALLET BACKUPS ]' : '[ WALLETS ]'}</h2>
          <span class="count">{accounts.value.length}</span>
          <button class="x" title="close (esc)" onClick={close}>[X]</button>
        </div>

        {/* one row, its own line: five controls across 372px is how the wallet
            name next to them ends up 0px wide */}
        {!backingUp && <div class="drawertotal">
          <span class="grandtotal" title="every wallet, every token, every scanned chain — testnets never counted">
            {valuingWallets.value
              ? `[ ${walletValueProgress.value ?? 'COUNTING'} ]`
              : usdRate.value !== null ? usd(allWalletsEth.value * usdRate.value) : '—'}
          </span>
          <button
            class="act refreshall" title="re-read every wallet on every chain"
            disabled={valuingWallets.value}
            onClick={() => void refreshEverything()}
          >{valuingWallets.value ? '…' : '↻ all'}</button>
        </div>}

        {!backingUp && (showSearch || knownLabels.value.length > 0) && (
          <div class="drawerfilters">
            {showSearch && (
              <input
                class="field search" placeholder="find a wallet…" value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            )}
            {knownLabels.value.length > 0 && (
              <div class="chips filterrow">
                <button
                  class={`chip${labelFilter.value === null ? ' on' : ''}`}
                  onClick={() => (labelFilter.value = null)}
                >all</button>
                {knownLabels.value.map((l) => (
                  <button
                    key={l} class={`chip${labelFilter.value === l ? ' on' : ''}`}
                    onClick={() => (labelFilter.value = labelFilter.value === l ? null : l)}
                  >{l}</button>
                ))}
              </div>
            )}
          </div>
        )}

        <div class="drawerbody" ref={body}>
          {backingUp ? <WalletBackups armed={armed} setArmed={setArmed} /> : <>
          {shown.map((g) => {
            const groupArmed = armed === `group:${g.id}`;
            const groupOpen = openGroup === g.id || groupArmed;
            const noun = g.kind === 'seed' ? 'wallet' : 'key';
            const collapsed = !filtering && walletList.value.collapsed.includes(g.id);
            const groupSelected = collapsed && g.members.some((a) => a.index === selected.value);
            const seedIndex = orderedSeeds.findIndex((seed) => seed.id === g.id);
            const groupLabel = g.kind === 'seed' ? g.label : 'imported keys';
            return (
              <div
                class={`walletgroup${dropTarget?.id === g.id ? ` drop-${dropTarget.placement}` : ''}`}
                key={g.id} data-group-id={g.id}
              >
                <div
                  class={`ghead${groupSelected ? ' group-selected' : ''}`}
                  ref={groupSelected ? selectedGroupHeading : undefined}
                  onDragOver={(event) => {
                    if (filtering || g.kind !== 'seed' || !dragging.current || dragging.current === g.id) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setDropTarget({ id: g.id, placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' });
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
                  }}
                  onDrop={(event) => {
                    const id = dragging.current;
                    if (!id || g.kind !== 'seed' || id === g.id) return;
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    moveGroup(id, g.id, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
                    finishDrag();
                  }}
                >
                  <button
                    class="group-toggle" aria-label={`${collapsed ? 'expand' : 'collapse'} ${groupLabel}`}
                    aria-expanded={!collapsed} aria-controls={`wallet-group-${g.id}`}
                    disabled={filtering}
                    title={filtering ? 'matching wallets stay expanded while filtering' : undefined}
                    onClick={() => {
                      autoRevealActive.current = false;
                      setEditing(null); setArmed(null); setOpenGroup(null);
                      void guard(() => toggleWalletGroup(g.id));
                    }}
                  >
                    <span class="group-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                    <span class="group-title">
                      <span class="gname">{groupLabel}</span>
                      <span class="gcount">
                        {g.members.length} {noun}{g.members.length === 1 ? '' : 's'}{groupSelected ? ' · selected' : ''}
                      </span>
                    </span>
                  </button>
                  {g.kind === 'seed' && seedCount > 1 && (
                    <IconBtn
                      glyph="↕" tip="drag to reorder" label={`reorder ${g.label}`}
                      className="group-drag" draggable={!filtering} disabled={filtering}
                      onClick={() => setOpenGroup(groupOpen ? null : g.id)}
                      onDragStart={(event) => {
                        if (filtering) { event.preventDefault(); return; }
                        autoRevealActive.current = false;
                        dragging.current = g.id;
                        setOpenGroup(null); setEditing(null); setArmed(null);
                        if (event.dataTransfer) {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', g.id);
                        }
                      }}
                      onDragEnd={finishDrag}
                    />
                  )}
                  {g.kind === 'seed' && (
                    <button
                      class={`more tip${groupOpen ? ' on' : ''}`} data-tip="more"
                      aria-label={`more for ${g.label}`}
                      aria-expanded={groupOpen ? 'true' : 'false'}
                      onClick={() => setOpenGroup(groupOpen ? null : g.id)}
                    >…</button>
                  )}
                </div>

                {g.kind === 'imported' && (
                  <div class="gwarn">your seed phrase cannot restore these</div>
                )}

                {editing?.what === 'group-nick' && editing.id === g.id && (
                  <InlineEdit
                    initial={g.label} placeholder="seed nickname"
                    onCancel={() => setEditing(null)}
                    onDone={(v) => { setEditing(null); void guard(() => renameGroup(g.id, v)); }}
                  />
                )}

                {groupOpen && g.kind === 'seed' && (
                  <div class="acts">
                    {seedCount > 1 && <div class="group-order">
                      <button
                        class="act" disabled={filtering || seedIndex === 0}
                        onClick={() => moveGroup(g.id, orderedSeeds[seedIndex - 1].id, 'before')}
                      >move seed up</button>
                      <span class="sep">·</span>
                      <button
                        class="act" disabled={filtering || seedIndex === orderedSeeds.length - 1}
                        onClick={() => moveGroup(g.id, orderedSeeds[seedIndex + 1].id, 'after')}
                      >move seed down</button>
                    </div>}
                    <button
                      class="act"
                      onClick={() => { setOpenGroup(null); setEditing({ what: 'group-nick', id: g.id }); }}
                    >rename seed</button>
                    <span class="sep">·</span>
                    <button class="act" onClick={() => void guard(() => addAccount(g.id))}>+ new wallet</button>
                    <span class="sep">·</span>
                    <Reveal
                      label="export phrase"
                      warning={`the seed phrase behind ${g.label} — every wallet in this group, and every one you ever add to it. anyone who reads it owns all of them.`}
                      armed={armed === `phrase:${g.id}`}
                      onArm={() => setArmed(armed === `phrase:${g.id}` ? null : `phrase:${g.id}`)}
                      load={(pw) => revealPhrase(g.id, pw)}
                    />
                    {seedCount > 1 && (
                      <>
                        <span class="sep">·</span>
                        <Forget
                          what={`${g.label} and its ${g.members.length} wallet(s) — you need the phrase written down to get back in`}
                          armed={groupArmed}
                          onArm={() => setArmed(groupArmed ? null : `group:${g.id}`)}
                          onDo={() => { setArmed(null); setOpenGroup(null); void guard(() => forgetGroup(g.id)); }}
                        />
                      </>
                    )}
                  </div>
                )}

                <div id={`wallet-group-${g.id}`}>
                {!collapsed && g.members.map((a) => (
                  <Row
                    key={a.address} a={a} editing={editing} setEditing={setEditing}
                    armed={armed} setArmed={setArmed}
                    selectedRef={setSelectedRow}
                  />
                ))}
                </div>
              </div>
            );
          })}

          {shown.length === 0 && (
            <div class="note center empty">
              {q
                ? <>no wallet here is called "{query}".</>
                : <>nothing carries the label "{labelFilter.value}". rad and unlabeled.</>}
            </div>
          )}
          </>}
        </div>

        <div class="drawerfoot">
          {backingUp ? (
            <button class="btn ghost block" onClick={() => { setArmed(null); setBackingUp(false); }}>BACK TO WALLETS</button>
          ) : <>
            <AddWallet onClose={close} />
            <button class="act block center" onClick={() => { setArmed(null); setBackingUp(true); }}>BACK UP SEED PHRASES &amp; KEYS</button>
          </>}
          {/* locking is a wallet-level action, so it lives with the wallets */}
          <button class="btn ghost block lockbtn" onClick={() => { close(); lock(); }}>
            LOCK IT
          </button>
          {!backingUp && <div class="note center">
            one password, one vault, every wallet. a seed phrase backs up its own
            wallets only — imported keys are on you.
          </div>}
        </div>
      </div>
    </div>
  );
}
