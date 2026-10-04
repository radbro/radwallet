/**
 * SEND, as a sheet.
 *
 * It used to be a full screen carrying its own "← back", while SWAP — the
 * neighbouring tile in the same action row — was a tab-bar screen with no back
 * link at all. Same shape, two ways out, and the two that behaved differently
 * were the two people use most. This closes the way every other sheet in the
 * wallet closes: header [X], Esc, backdrop.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatEther, isAddress as _isAddress } from 'viem';
import {
  account, chainId, say, scheduleBalanceRefresh, DEMO, sayError, endpointForChain,
  balances, nfts, sendIntent, closeSheet, type SendIntent,
} from '../state.js';
import { session } from '../session.js';
import { recordTx } from '../history.js';
import { AddressBookList, LabeledAddress, QuickAddAddress } from '../addressbook-ui.js';
import {
  buildTransferTx,
  previewDappTx,
  demoPreviewSend,
  resolveEns,
  chainInfo,
  parseMetaAddress,
  newStealthSendPlan,
  preflightStealthSend,
  transferLabel,
  parseTokenAmount,
  type DappTxRequest,
  type TransferAsset,
  type TxPreview,
} from '@radwallet/core';
import { ChainIcon, EthIcon, TxLink, useModalDialog } from '../bits.js';
import {
  planToWire,
  removePendingStealthSend,
  savePendingStealthSend,
  type StealthSendPlanWire,
} from '../session.js';

interface AssetChoice {
  key: string;
  kind: 'native' | 'erc20' | 'erc721';
  chainId: number;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  balanceRaw?: bigint;
  address?: `0x${string}`;
  tokenId?: string;
}

function intentKey(intent: SendIntent | null): string | null {
  if (!intent) return null;
  if (intent.kind === 'native') return `native:${intent.chainId}`;
  if (intent.kind === 'erc20') return `erc20:${intent.chainId}:${intent.address.toLowerCase()}`;
  return `erc721:${intent.chainId}:${intent.address.toLowerCase()}:${intent.tokenId}`;
}

function intentChoice(intent: SendIntent | null): AssetChoice | null {
  if (!intent) return null;
  if (intent.kind === 'native') {
    return {
      key: `native:${intent.chainId}`, kind: 'native', chainId: intent.chainId,
      symbol: chainInfo(intent.chainId).nativeSymbol, name: 'Ether', decimals: 18, balance: 'checking…',
    };
  }
  if (intent.kind === 'erc20') {
    return {
      key: `erc20:${intent.chainId}:${intent.address.toLowerCase()}`, kind: 'erc20', chainId: intent.chainId,
      symbol: intent.symbol, name: intent.name, decimals: intent.decimals,
      balance: intent.balance, balanceRaw: intent.balanceRaw, address: intent.address,
    };
  }
  return {
    key: `erc721:${intent.chainId}:${intent.address.toLowerCase()}:${intent.tokenId}`, kind: 'erc721',
    chainId: intent.chainId, symbol: intent.symbol, name: intent.name, decimals: 0,
    balance: `#${intent.tokenId}`, address: intent.address, tokenId: intent.tokenId,
  };
}

function toTransferAsset(choice: AssetChoice, amount: string): TransferAsset {
  if (choice.kind === 'native') {
    return { kind: 'native', symbol: choice.symbol, decimals: choice.decimals, amount };
  }
  if (choice.kind === 'erc20') {
    return {
      kind: 'erc20', contract: choice.address!, symbol: choice.symbol,
      decimals: choice.decimals, amount,
    };
  }
  return {
    kind: 'erc721', contract: choice.address!, symbol: choice.symbol,
    tokenId: choice.tokenId!,
  };
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function SendSheet() {
  const acct = account.value;
  const box = useRef<HTMLDivElement>(null);
  const close = () => { sendIntent.value = null; closeSheet(); };
  useModalDialog(box, close);

  /*
    EVERY chain's holdings, not just the one the wallet happens to be switched
    to. The asset list on HOME is one flat list across chains, so a SEND that
    silently showed one chain's tokens would be asking you to remember which
    network you were last on. The chain comes from the asset you pick.
  */
  const home = chainId.value;
  const choices: AssetChoice[] = balances.value.map((b) => ({
    key: b.address ? `erc20:${b.chainId ?? 1}:${b.address.toLowerCase()}` : `native:${b.chainId ?? 1}`,
    kind: b.address ? 'erc20' as const : 'native' as const,
    chainId: b.chainId ?? 1,
    symbol: b.symbol,
    name: b.name,
    decimals: b.decimals,
    balance: b.amount,
    balanceRaw: b.raw,
    address: b.address,
  }));
  for (const holding of nfts.value) {
    for (const id of holding.tokenIds) {
      choices.push({
        key: `erc721:${holding.chainId}:${holding.address.toLowerCase()}:${id}`,
        kind: 'erc721', chainId: holding.chainId, symbol: holding.symbol, name: holding.name,
        decimals: 0, balance: `#${id}`, address: holding.address, tokenId: id,
      });
    }
  }
  // the chain you are switched to leads the list, so the plain SEND tile opens
  // on the wallet's own network rather than on whatever sorted first
  choices.sort((a, b) => Number(b.chainId === home) - Number(a.chainId === home));

  const intended = intentChoice(sendIntent.value);
  if (intended && !choices.some((c) => c.key === intended.key)) choices.unshift(intended);
  if (!choices.some((c) => c.kind === 'native' && c.chainId === home)) {
    choices.unshift({
      key: `native:${home}`, kind: 'native', chainId: home,
      symbol: chainInfo(home).nativeSymbol, name: 'Ether', decimals: 18, balance: 'not scanned',
    });
  }

  const [assetKey, setAssetKey] = useState(intentKey(sendIntent.value) ?? choices[0].key);
  const [to, setTo] = useState('');
  const [contactsOpen, setContactsOpen] = useState(false);
  const [amt, setAmt] = useState('');
  const [prev, setPrev] = useState<TxPreview | null>(null);
  const [sim, setSim] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ hash: string; chainId: number } | null>(null);
  const [stealthPlan, setStealthPlan] = useState<StealthSendPlanWire | null>(null);
  const [prepared, setPrepared] = useState<{
    key: string; tx: DappTxRequest | null; endpoint: string;
  } | null>(null);
  const choice = choices.find((c) => c.key === assetKey) ?? choices[0];
  const keyFor = (recipient: string) => JSON.stringify([
    acct?.index, acct?.address, choice.key, choice.decimals, choice.symbol, recipient, amt,
  ]);
  const inputKey = keyFor(to);
  const currentInput = useRef(inputKey);
  currentInput.current = inputKey;
  const previewSequence = useRef(0);
  useEffect(() => () => { previewSequence.current += 1; }, []);
  const currentPreview = prepared?.key === inputKey ? prev : null;

  if (!acct) return null;
  const activeAccount = acct;
  // whichever chain the chosen asset lives on — never a global the screen has
  // to be told about separately
  const currentChain = choice.chainId;

  const looksEns = /\.[a-z]{2,}$/i.test(to) && !to.startsWith('0x') && !to.startsWith('st:');
  const looksStealth = parseMetaAddress(to) !== null;
  const isStealth = looksStealth && choice.kind === 'native' && currentChain === 1;
  const recipientValid = _isAddress(to) || looksEns || isStealth;
  let amountValid = choice.kind === 'erc721';
  let amountError = '';
  if (choice.kind !== 'erc721') {
    try {
      const raw = parseTokenAmount(amt, choice.decimals);
      amountValid = raw > 0n && (choice.balanceRaw === undefined || raw <= choice.balanceRaw);
      if (raw > 0n && choice.balanceRaw !== undefined && raw > choice.balanceRaw) {
        amountError = `not enough ${choice.symbol}`;
      }
    } catch (e) {
      amountValid = false;
      if (amt) amountError = e instanceof Error ? e.message : String(e);
    }
  }
  const valid = recipientValid && amountValid;

  function resetPreview() {
    previewSequence.current += 1;
    setSim(false);
    setPrepared(null);
    setPrev(null);
    setSent(null);
    setStealthPlan(null);
  }

  useEffect(() => {
    if (prepared && prepared.key !== inputKey) resetPreview();
  }, [inputKey, prepared?.key]);

  async function simulate() {
    if (!valid || sending) return;
    const sequence = ++previewSequence.current;
    const current = () => sequence === previewSequence.current && currentInput.current === inputKey;
    setSim(true);
    setPrev(null);
    setPrepared(null);
    try {
      let dest = to;
      if (looksEns) {
        const resolved = DEMO ? null : await resolveEns(endpointForChain(1), to);
        if (!current()) return;
        if (!resolved) {
          say(DEMO ? 'ENS lookup is off in demo mode' : `could not resolve ${to}`);
          return;
        }
        dest = resolved;
      }
      const asset = toTransferAsset(choice, amt);
      const tx = buildTransferTx(activeAccount.address, dest, asset);
      const ep = endpointForChain(currentChain);
      const p = DEMO
        ? await demoPreviewSend(dest, choice.kind === 'erc721' ? '1' : amt)
        : await previewDappTx(ep, activeAccount.address, tx, currentChain);
      if (!current()) return;
      if (looksEns) {
        setTo(dest);
        say(`${to} → ${dest.slice(0, 8)}… (ENS, resolved via your own RPC)`);
      }
      setPrepared({ key: keyFor(dest), tx, endpoint: ep });
      const label = transferLabel(asset);
      setPrev(p.ok
        ? {
          ...p,
          out: [label],
          in_: [{ asset: `${label.asset} → ${short(dest)}`, amount: label.amount }],
        }
        : p);
    } catch (e) {
      if (current()) sayError(e);
    } finally {
      if (sequence === previewSequence.current) setSim(false);
    }
  }

  async function fireStealth() {
    if (sending || !valid || !currentPreview?.ok || !stealthPlan || !prepared) return;
    setSending(true);
    let pendingId: string | null = null;
    try {
      if (DEMO) {
        say('demo mode: stealth address was derived for real, nothing broadcast.');
        setSent({ hash: '0xdemo…nothing was actually sent', chainId: currentChain });
        return;
      }
      const ep = prepared.endpoint;
      if (!stealthPlan.from || stealthPlan.from.toLowerCase() !== activeAccount.address.toLowerCase()) {
        throw new Error('stealth plan sender changed; preview again before signing');
      }
      const createdAt = Date.now();
      pendingId = `${Date.now()}-${stealthPlan.stealthAddress.toLowerCase()}`;
      await savePendingStealthSend({
        id: pendingId,
        from: activeAccount.address,
        amountEth: amt,
        createdAt,
        status: 'prepared',
        plan: stealthPlan,
      });
      const announceHash = await session.announceStealthPlan(activeAccount.index, ep, stealthPlan);
      await savePendingStealthSend({
        id: pendingId,
        from: activeAccount.address,
        amountEth: amt,
        createdAt,
        status: 'announce_sent',
        plan: stealthPlan,
        announceHash,
      });
      await recordTx({ hash: announceHash, chainId: 1, kind: 'stealth', to: 'announcer' });
      say('announcement broadcast; verifying its receipt and waiting for Ethereum finality before ETH can move. this can take about 15 minutes.');
      try {
        await session.confirmStealthAnnouncement(ep, announceHash, stealthPlan);
      } catch (e) {
        const confirmationError = e instanceof Error ? e.message.split('\n')[0] : String(e);
        await savePendingStealthSend({
          id: pendingId,
          from: activeAccount.address,
          amountEth: amt,
          createdAt,
          status: 'announce_sent',
          plan: stealthPlan,
          announceHash,
          transferError: confirmationError,
        });
        setSent({ hash: announceHash, chainId: 1 });
        say(`announcement is not finalized; ETH did not move. Activity can recheck it: ${confirmationError}`);
        return;
      }
      try {
        const transferHash = await session.transferStealthPlan(activeAccount.index, ep, stealthPlan, announceHash);
        await savePendingStealthSend({
          id: pendingId,
          from: activeAccount.address,
          amountEth: amt,
          createdAt,
          status: 'transfer_sent',
          plan: stealthPlan,
          announceHash,
          transferHash,
        });
        await recordTx({ hash: transferHash, chainId: 1, kind: 'stealth', to: stealthPlan.stealthAddress });
        await removePendingStealthSend(pendingId);
        setSent({ hash: transferHash, chainId: 1 });
        say('sent to a fresh stealth address. the transaction remains public.');
      } catch (e) {
        const transferError = e instanceof Error ? e.message.split('\n')[0] : String(e);
        await savePendingStealthSend({
          id: pendingId,
          from: activeAccount.address,
          amountEth: amt,
          createdAt,
          status: 'transfer_failed',
          plan: stealthPlan,
          announceHash,
          transferError,
        });
        setSent({ hash: announceHash, chainId: 1 });
        say(`announcement succeeded; ETH did not move. Activity can retry transfer: ${transferError}`);
      }
    } catch (e) {
      if (pendingId) {
        say('stealth send did not move ETH. Activity keeps the recovery plan.');
      }
      sayError(e);
    } finally {
      setSending(false);
    }
  }

  async function simulateStealth() {
    if (!valid || sending) return;
    const sequence = ++previewSequence.current;
    const current = () => sequence === previewSequence.current && currentInput.current === inputKey;
    setSim(true);
    setPrev(null);
    setStealthPlan(null);
    setPrepared(null);
    try {
      const ep = endpointForChain(1);
      if (DEMO) {
        const plan = planToWire(newStealthSendPlan(to, parseTokenAmount(amt, 18)));
        if (!current()) return;
        setPrepared({ key: inputKey, tx: null, endpoint: ep });
        setStealthPlan(plan);
        setPrev({
          ok: true,
          out: [{ asset: choice.symbol, amount: amt }],
          in_: [{ asset: `${choice.symbol} → ${short(plan.stealthAddress)}`, amount: amt }],
          gasEth: '0',
          gasWei: 0n,
        });
        return;
      }
      const plan = await preflightStealthSend(ep, activeAccount.address, to, parseTokenAmount(amt, 18));
      if (!current()) return;
      const wire = planToWire(plan);
      const gasWei = BigInt(wire.totalMaxWei) - BigInt(wire.valueWei);
      setStealthPlan(wire);
      setPrepared({ key: inputKey, tx: null, endpoint: ep });
      setPrev({
        ok: true,
        out: [{ asset: choice.symbol, amount: amt }],
        in_: [{ asset: `${choice.symbol} → ${short(wire.stealthAddress)}`, amount: amt }],
        gasEth: formatEther(gasWei),
        gasWei,
      });
    } catch (e) {
      if (current()) sayError(e);
    } finally {
      if (sequence === previewSequence.current) setSim(false);
    }
  }

  async function fireIt() {
    if (sending || !valid || !currentPreview?.ok || !prepared?.tx) return;
    setSending(true);
    try {
      if (DEMO) {
        say('demo mode: nothing was broadcast. run the real build for that.');
        setSent({ hash: '0xdemo…nothing was actually sent', chainId: currentChain });
        return;
      }
      const asset = toTransferAsset(choice, amt);
      const hash = await session.sendTx(activeAccount.index, prepared.endpoint, currentChain, prepared.tx);
      await recordTx({ hash, chainId: currentChain, kind: 'send', to });
      setSent({ hash, chainId: currentChain });
      say(`${transferLabel(asset).asset} broadcast. check the chain.`);
      scheduleBalanceRefresh(currentChain, hash);
    } catch (e) {
      sayError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="drawer" onMouseDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('drawer')) close();
    }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label="send" tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead"><ChainIcon chainId={currentChain} /> SEND · {chainInfo(currentChain).name.toUpperCase()}</h2>
          <button class="x" title="close (esc)" onClick={close}>[X]</button>
        </div>

        {sent
          ? (
            <>
              <div class="drawerbody">
                <div class="panel">
                  <div class="hd">{DEMO ? 'DEMO PREVIEW' : 'TRANSACTION SUBMITTED'}</div>
                  <div class="simrow">
                    <span class="dir">TX</span>
                    {DEMO
                      ? <span class="what">{sent.hash}</span>
                      : <TxLink chainId={sent.chainId} hash={sent.hash} className="what">{sent.hash}</TxLink>}
                  </div>
                </div>
                <div class="note center">
                  {DEMO ? 'demo mode — nothing was broadcast.' : 'check the chain.'}
                </div>
              </div>
              <div class="drawerfoot">
                <button class="btn block" onClick={close}>DONE</button>
              </div>
            </>
          )
          : (
            <>
              <div class="drawerbody">
                <select
                  class="field assetpick"
                  aria-label="asset to send" disabled={sending}
                  value={choice.key}
                  onChange={(e) => {
                    setAssetKey((e.target as HTMLSelectElement).value);
                    setAmt('');
                    resetPreview();
                  }}
                >
                  {choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.kind === 'erc721' ? `${c.name} #${c.tokenId}` : `${c.symbol} · ${c.balance}`}
                      {` · ${chainInfo(c.chainId).name}`}
                    </option>
                  ))}
                </select>

                <div class="sendasset">
                  {choice.kind === 'native'
                    ? <EthIcon />
                    : <span class="glyph">{choice.kind === 'erc721' ? '▣' : '○'}</span>}
                  <span class="meta">
                    <span class="name">{choice.kind === 'erc721' ? `${choice.name} #${choice.tokenId}` : choice.name}</span>
                    <span class="detail">
                      {choice.kind === 'native' ? 'native asset' : `${choice.address} · ${choice.kind.toUpperCase()}`}
                    </span>
                  </span>
                  <span class="bal">{choice.kind === 'erc721' ? '1 NFT' : `${choice.balance} ${choice.symbol}`}</span>
                </div>

                <button type="button" class="act contact-action" aria-expanded={contactsOpen} disabled={sending}
                  onClick={() => setContactsOpen(!contactsOpen)}>ADDRESS BOOK {contactsOpen ? '▴' : '▾'}</button>
                {contactsOpen && <div class="send-contacts">
                  <AddressBookList onSelect={(address) => {
                    setTo(address); resetPreview(); setContactsOpen(false);
                  }} />
                </div>}
                <input class="field" aria-label="recipient address" placeholder="0x… or name.eth" value={to} disabled={sending}
                  onInput={(e) => { setTo((e.target as HTMLInputElement).value.trim()); resetPreview(); }} />
                {_isAddress(to) && <div class="send-recipient">
                  <LabeledAddress address={to} />
                  <QuickAddAddress key={to.toLowerCase()} address={to} disabled={sending} />
                </div>}
                {choice.kind !== 'erc721' && (
                  <input class="field" placeholder={`amount in ${choice.symbol}`} value={amt} disabled={sending}
                    onInput={(e) => { setAmt((e.target as HTMLInputElement).value.trim()); resetPreview(); }} />
                )}

                {amountError && <div class="note center" style={{ color: '#ff2a2a' }}>{amountError}</div>}
                {looksStealth && !isStealth && (
                  <div class="note center" style={{ color: '#ff2a2a' }}>
                    stealth sends currently accept mainnet ETH only
                  </div>
                )}
                {to.length > 0 && !_isAddress(to) && !looksEns && !looksStealth && !to.startsWith('st:') && (
                  <div class="note center" style={{ color: '#ff2a2a' }}>that is not an address (or a name), bro</div>
                )}

                {isStealth && (
                  <div class="panel">
                    <div class="hd">STEALTH SEND (ERC-5564)</div>
                    <div style={{ fontSize: 12 }}>
                      two transactions: announcement to the canonical registry first, then ETH to a
                      freshly derived one-time address.
                    </div>
                  </div>
                )}

                {currentPreview?.ok && (
                  <div class="panel">
                    <div class="hd">TRANSACTION PREVIEW</div>
                    {!isStealth && <div class="simrow"><span class="dir">TO</span><LabeledAddress address={to} /></div>}
                    {currentPreview.out.map((x) => (
                      <div class="simrow out" key={`out-${x.asset}`}><span class="dir">− OUT</span><span class="what">{x.amount} {x.asset}</span></div>
                    ))}
                    {currentPreview.in_.map((x) => (
                      <div class="simrow in" key={`in-${x.asset}`}><span class="dir">+ IN</span><span class="what">{x.asset}</span></div>
                    ))}
                    <div class="simrow"><span class="dir">{isStealth ? 'MAX GAS' : 'EST. GAS'}</span><span class="what">{currentPreview.gasEth} ETH</span></div>
                    {!isStealth && <div class="note">Network fees are estimated. The final fee can change before signing.</div>}
                  </div>
                )}
                {currentPreview && !currentPreview.ok && (
                  <div class="obey badver" style={{ fontSize: 13 }}>SIMULATION FAILED: {currentPreview.error}</div>
                )}
              </div>

              {/* the one primary action, pinned: on a 600px popup a long token
                  list must never walk SIGN & SEND off the bottom */}
              <div class="drawerfoot">
                {isStealth && !currentPreview && (
                  <button class="btn block" disabled={!valid || sim || sending} onClick={() => void simulateStealth()}>
                    {sim ? '[ SIMULATION INTENSIFIES ]' : 'SIMULATE FIRST (ALWAYS)'}
                  </button>
                )}
                {!currentPreview && !isStealth && (
                  <button class="btn block" disabled={!valid || sim || sending} onClick={() => void simulate()}>
                    {sim ? '[ SIMULATION INTENSIFIES ]' : 'SIMULATE FIRST (ALWAYS)'}
                  </button>
                )}
                {currentPreview?.ok && (
                  <div class="btnrow">
                    <button class="btn danger" disabled={sending} onClick={() => { resetPreview(); setTo(''); setAmt(''); }}>
                      REFUSE
                    </button>
                    <button class="btn" disabled={sending || !valid} onClick={() => void (isStealth ? fireStealth() : fireIt())}>
                      {sending ? '[ BROADCASTING ]' : 'SIGN & SEND'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
