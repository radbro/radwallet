import { useEffect, useState } from 'preact/hooks';
import {
  endpointForChain, account, say, sayError, DEMO, stealthMeta, poolsAll,
} from '../state.js';
import {
  listPendingStealthSends,
  removePendingStealthSend,
  savePendingStealthSend,
  session,
  type StealthPaymentWire,
  type StoredStealthSend,
} from '../session.js';
import { listHistory, updateStatus, recordTx, type HistoryEntry } from '../history.js';
import { LabeledAddress, QuickAddAddress } from '../addressbook-ui.js';
import {
  chainClient, chainInfo, CHAINS, fetchTx, isReplaceable, buildSpeedUp, buildCancel,
  suggestedFees, endpointFor,
} from '@radwallet/core';

function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_COLOR: Record<HistoryEntry['status'], string> = {
  pending: '#ffe000', confirmed: '#39ff14', failed: '#ff2a2a', demo: '#b26bff',
};

/**
 * The status, as a mark rather than only a colour.
 *
 * A log row was carrying its state in the colour of one word and nowhere else,
 * which is the one encoding a colourblind reader cannot use and a greyscale
 * screenshot destroys. This is NOT the glyph-instead-of-word trade the rest of
 * the wallet makes — the word stays. It is the colour getting a second, legible
 * form.
 */
const STATUS_GLYPH: Record<HistoryEntry['status'], string> = {
  pending: '◷', confirmed: '✓', failed: '✗', demo: '◌',
};

/**
 * Speeding up or cancelling a transaction that is still in the mempool.
 *
 * Both send a NEW transaction at the same nonce with a higher fee; whichever
 * lands first makes the other unmineable. Neither is free, and neither is
 * guaranteed — if the original is already in a block the replacement is just a
 * wasted fee, so we re-read the transaction first and say so.
 */
function Rescue({ entry, onDone }: { entry: HistoryEntry; onDone: () => void }) {
  const [busy, setBusy] = useState<'up' | 'cancel' | null>(null);
  const [armed, setArmed] = useState(false);

  async function replace(kind: 'up' | 'cancel') {
    const acct = account.value;
    if (!acct || busy) return;
    setBusy(kind);
    try {
      const ep = endpointForChain(entry.chainId);
      const tx = await fetchTx(ep, entry.chainId, entry.hash as `0x${string}`);
      if (!tx) throw new Error('the network has never heard of this transaction');
      if (!isReplaceable(tx)) {
        await updateStatus(entry.hash, 'confirmed');
        say('too late — it is already in a block. nothing was sent.');
        onDone();
        return;
      }
      const fees = await suggestedFees(ep, entry.chainId);
      const next = kind === 'up' ? buildSpeedUp(tx, 25, fees) : buildCancel(tx, 25, fees);
      const hash = await session.sendTx(acct.index, ep, entry.chainId, next);
      await recordTx({
        hash, chainId: entry.chainId, kind: kind === 'up' ? 'send' : 'send',
        to: kind === 'up' ? (tx.to ?? tx.from) : tx.from,
      });
      say(kind === 'up'
        ? 'replacement sent with a higher gas fee. waiting for confirmation.'
        : 'cancellation sent. if it confirms first, the original transaction cannot confirm.');
      onDone();
    } catch (e) {
      sayError(e);
    } finally {
      setBusy(null);
      setArmed(false);
    }
  }

  if (armed) {
    return (
      <div class="armed">
        <div class="what">
          cancel it? this submits a replacement transaction sending 0 ETH to yourself.
          cancellation costs gas if confirmed and may lose the race to the original transaction.
        </div>
        <div class="btnrow">
          <button class="btn ghost" onClick={() => setArmed(false)}>LEAVE IT</button>
          <button class="btn danger" disabled={!!busy} onClick={() => void replace('cancel')}>
            {busy === 'cancel' ? '[ CANCELLING ]' : 'CANCEL IT'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="acts">
      <button class="act" disabled={!!busy} onClick={() => void replace('up')}>
        {busy === 'up' ? '[ SPEEDING UP ]' : 'speed up'}
      </button>
      <span class="sep">·</span>
      <button class="act danger" onClick={() => setArmed(true)}>cancel</button>
    </div>
  );
}

/**
 * The stealth inbox.
 *
 * Scanning for ERC-5564 payments and sweeping them home is not a step in
 * handing someone your address, which is where it used to live — it is money
 * arriving, and money arriving belongs where the rest of it is recorded. The
 * meta-address you give out is still on RECEIVE.
 */
function StealthInbox() {
  const acct = account.value;
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [found, setFound] = useState<StealthPaymentWire[]>([]);
  const [pending, setPending] = useState<StoredStealthSend[]>([]);

  const mainnetEndpoint = (addr: string): string => {
    const p = poolsAll.value[1] ?? { endpoints: [...CHAINS[1].defaultEndpoints], epoch: 0 };
    return endpointFor(p, addr);
  };

  async function scan() {
    if (DEMO) { say('demo mode: no chain to scan. the math is real though.'); setScanned(true); return; }
    setScanning(true);
    try {
      setFound(await session.scanStealth(acct!.index, mainnetEndpoint(acct!.address)));
      setScanned(true);
    } catch (e) {
      sayError(e);
    } finally {
      setScanning(false);
    }
  }

  async function loadPending() {
    if (!acct) {
      setPending([]);
      return;
    }
    const all = await listPendingStealthSends();
    setPending(all.filter((p) => p.from.toLowerCase() === acct.address.toLowerCase()));
  }

  useEffect(() => {
    void loadPending();
  }, [acct?.address]);

  if (!acct || !stealthMeta.value) return null;

  async function finishStealthSend(p: StoredStealthSend) {
    try {
      if (p.from.toLowerCase() !== acct!.address.toLowerCase()) {
        throw new Error('stealth recovery belongs to a different account');
      }
      if (!p.plan.from || p.plan.from.toLowerCase() !== p.from.toLowerCase()) {
        throw new Error('stealth recovery plan is not bound to its stored sender');
      }
      if (p.transferHash) {
        await recordTx({ hash: p.transferHash, chainId: 1, kind: 'stealth', to: p.plan.stealthAddress });
        await removePendingStealthSend(p.id);
        await loadPending();
        say('stealth transfer was already recorded. check the chain.');
        return;
      }
      const ep = mainnetEndpoint(acct!.address);
      let announceHash = p.announceHash;
      if (!announceHash) {
        try {
          announceHash = await session.announceStealthPlan(acct!.index, ep, p.plan);
        } catch (e) {
          const reason = e instanceof Error ? e.message.split('\n')[0] : String(e);
          await savePendingStealthSend({ ...p, status: 'prepared' });
          throw new Error(reason);
        }
        const announced = { ...p, status: 'announce_sent' as const, announceHash };
        await savePendingStealthSend(announced);
        await recordTx({ hash: announceHash, chainId: 1, kind: 'stealth', to: 'announcer' });
      }
      say('checking the exact announcement and waiting for finality before ETH can move.');
      try {
        await session.confirmStealthAnnouncement(ep, announceHash, p.plan);
      } catch (e) {
        const confirmationError = e instanceof Error ? e.message.split('\n')[0] : String(e);
        await savePendingStealthSend({
          ...p,
          status: 'announce_sent',
          announceHash,
          transferHash: undefined,
          transferError: confirmationError,
        });
        throw new Error(`announcement is not finalized; ETH was not sent: ${confirmationError}`);
      }
      try {
        const transferHash = await session.transferStealthPlan(acct!.index, ep, p.plan, announceHash);
        await savePendingStealthSend({
          ...p,
          status: 'transfer_sent',
          announceHash,
          transferHash,
          transferError: undefined,
        });
        await recordTx({ hash: transferHash, chainId: 1, kind: 'stealth', to: p.plan.stealthAddress });
      } catch (e) {
        const transferError = e instanceof Error ? e.message.split('\n')[0] : String(e);
        await savePendingStealthSend({
          ...p,
          status: 'transfer_failed',
          announceHash,
          transferHash: p.transferHash,
          transferError,
        });
        throw new Error(transferError);
      }
      await removePendingStealthSend(p.id);
      await loadPending();
      say('stealth transfer finished with the same one-time address. check the chain.');
    } catch (e) {
      sayError(e);
    }
  }

  async function sweep(p: StealthPaymentWire) {
    try {
      const hash = await session.sweepStealth(
        acct!.index, mainnetEndpoint(acct!.address), p, acct!.address as `0x${string}`,
      );
      await recordTx({ hash, chainId: 1, kind: 'stealth', to: acct!.address });
      say('swept home. check the chain.');
      setFound(found.filter((f) => f.stealthAddress !== p.stealthAddress));
    } catch (e) {
      sayError(e);
    }
  }

  return (
    <div class="panel">
      <div class="hd">STEALTH INBOX · ETHEREUM</div>
      <div class="note">
        scan for ETH payments on Ethereum sent using your stealth receiving address.
        the sender knows each payment address, and transactions stay public.
        RADWALLET checks announcement logs through your configured RPC to find your payments.
      </div>
      {pending.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {pending.map((p) => (
            <div class="simrow" key={p.id}>
              <span class="what" style={{ fontSize: 11 }}>
                {p.status === 'prepared' ? 'pending announce' : 'pending transfer'} ·{' '}
                {p.plan.stealthAddress.slice(0, 10)}… · {p.amountEth} ETH
                {p.transferError ? ` · ${p.transferError}` : ''}
              </span>
              <button
                class="redlink"
                style={{ marginLeft: 'auto' }}
                onClick={() => void finishStealthSend(p)}
              >
                {p.transferHash ? 'finish' : p.announceHash ? 'verify + finish' : 'retry announce'}
              </button>
            </div>
          ))}
        </div>
      )}
      <button class="btn ghost block" disabled={scanning} onClick={() => void scan()}>
        {scanning ? '[ SCANNING ]' : '⌕ SCAN FOR PAYMENTS'}
      </button>
      {scanned && found.length === 0 && (
        <div class="note" style={{ marginTop: 6 }}>
          no stealth payments found in the scanned announcement range.
        </div>
      )}
      {found.map((p) => (
        <div class="simrow" key={p.stealthAddress}>
          <span class="what" style={{ fontSize: 11 }}>{p.stealthAddress.slice(0, 10)}… · {p.balanceEth} ETH</span>
          <button class="redlink" style={{ marginLeft: 'auto' }} onClick={() => void sweep(p)}>sweep home</button>
        </div>
      ))}
    </div>
  );
}

export function Activity() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  const reload = () => { void listHistory().then(setEntries); };

  useEffect(() => {
    void (async () => {
      const list = await listHistory();
      setEntries(list);
      if (DEMO) return;
      // resolve pending statuses via the user's own RPC — no indexer API
      for (const e of list.filter((x) => x.status === 'pending')) {
        try {
          const r = await chainClient(endpointForChain(e.chainId), e.chainId).getTransactionReceipt({
            hash: e.hash as `0x${string}`,
          });
          const status = r.status === 'success' ? 'confirmed' : 'failed';
          await updateStatus(e.hash, status);
          setEntries(await listHistory());
        } catch { /* still pending or other-chain endpoint — leave it */ }
      }
    })();
  }, []);

  return (
    <div class="content">
      <h1 class="simhead">ACTIVITY</h1>

      <StealthInbox />

      <div class="testhead">TRANSACTION HISTORY · SAVED ON THIS DEVICE</div>
      <div class="note">transactions are public on-chain. this list shows the latest 100 transactions recorded here across your wallets; earlier activity and incoming transfers may not appear.</div>

      {entries.length === 0 && (
        <div class="panel" style={{ marginTop: 14 }}>
          <div class="hd">NOTHING YET</div>
          <div class="note">no transactions recorded here yet.</div>
        </div>
      )}
      {entries.map((e) => (
        <div class="panel" key={e.hash} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: STATUS_COLOR[e.status], fontWeight: 'bold' }}>
              <span aria-hidden="true">{STATUS_GLYPH[e.status]}</span> {e.status.toUpperCase()}
            </span>{' '}
            · <span class="white">{e.kind}</span> · {CHAINS[e.chainId]?.name ?? e.chainId} ·{' '}
            <span class="dim">{ago(e.ts)}</span>
            {e.origin && <span class="dim"> · {e.origin}</span>}
          </div>
          <div class="dim" style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 4 }}>
            {e.hash}
          </div>
          {e.to && <div class="send-recipient">
            <div class="note">TO</div>
            <LabeledAddress address={e.to} />
            <QuickAddAddress key={e.to.toLowerCase()} address={e.to} />
          </div>}
          {e.status === 'pending' && !DEMO && <Rescue entry={e} onDone={reload} />}
          {e.status !== 'demo' && chainInfo(e.chainId).explorerTx && (
            <a
              class="redlink"
              style={{ fontSize: 11 }}
              href={`${chainInfo(e.chainId).explorerTx}${e.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              check the chain →
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
