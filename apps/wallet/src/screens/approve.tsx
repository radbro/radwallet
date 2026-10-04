/**
 * Approval window for dapp requests. The window never touches keys — on
 * approve it tells the background to perform the operation; the background
 * validates the signer and signs inside the service worker.
 * Handles: connect · chain switch · personal_sign · eth_signTypedData_v3/v4
 * · eth_sendTransaction (with unlimited-allowance rewriting).
 */
import { useEffect, useState } from 'preact/hooks';
import { erc20Abi, formatUnits } from 'viem';
import {
  account, accounts, groups, endpoint, say, DEMO, chainId, simulateMoves,
} from '../state.js';
import type { SimResult } from '@radwallet/core';
import type { ApprovalRequest, ApprovalOverride } from '../approval-types.js';
import {
  previewDappTx,
  demoPreviewSend,
  decodeApprove,
  isUnlimitedAllowance,
  MAX_UINT256,
  rewriteApprove,
  parseAllowance,
  sanitizeDappTx,
  chainClient,
  swapOutputTokens,
  type DappTxRequest,
  type TxPreview,
  CHAINS,
} from '@radwallet/core';
import { LabeledAddress, QuickAddAddress } from '../addressbook-ui.js';
import { ChainIcon, FooterRing } from '../bits.js';
import { ext } from '../ext.js';

export const approveId: string | null =
  typeof location !== 'undefined' ? new URLSearchParams(location.search).get('approve') : null;

function hexToUtf8(hex: string): string {
  try {
    const b = hex.replace(/^0x/, '');
    const bytes = new Uint8Array(b.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    const s = new TextDecoder().decode(bytes);
    return /[\x00-\x08\x0e-\x1f]/.test(s) ? hex : s;
  } catch {
    return hex;
  }
}

function short(a?: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?';
}

function paramAddress(v: unknown): `0x${string}` | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v as `0x${string}` : null;
}

export function Approve() {
  const [req, setReq] = useState<ApprovalRequest | null>(null);
  const [prev, setPrev] = useState<TxPreview | null>(null);
  const [moves, setMoves] = useState<SimResult | null>(null);
  const [movesOff, setMovesOff] = useState(false);
  const [allowanceMetadata, setAllowanceMetadata] = useState<{
    request: ApprovalRequest;
    decimals: number | null;
  } | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [rewriteAmt, setRewriteAmt] = useState('100');
  const [signUnlimited, setSignUnlimited] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!approveId || !ext?.runtime?.sendMessage) return;
    ext.runtime.sendMessage({ type: 'get-approval', id: approveId }, (r: ApprovalRequest | null) =>
      setReq(r),
    );
  }, []);

  const acct = account.value;
  const isTx = req?.method === 'eth_sendTransaction';
  const tx = (isTx ? req?.params?.[0] ?? {} : {}) as DappTxRequest;
  const isConnect = req?.method === 'eth_requestAccounts';
  const isSwitch = req?.method === 'wallet_switchEthereumChain';
  const switchChainId = isSwitch ? parseInt(String((req?.params?.[0] as any)?.chainId ?? '0x0'), 16) : 0;
  const isTyped = req?.method === 'eth_signTypedData_v4' || req?.method === 'eth_signTypedData_v3';
  const isMsg = req?.method === 'personal_sign';
  const rawMsg = isMsg ? String(req?.params?.[0] ?? '') : '';
  const approvalChainId = req?.chainId ?? chainId.value;
  const approvalEndpoint = req?.endpoint ?? endpoint.value;
  const decodedApprove = isTx ? decodeApprove(tx.to, tx.data) : null;
  const allowanceDecimals = allowanceMetadata?.request === req ? allowanceMetadata.decimals : null;
  const approveCall = decodedApprove && (decodedApprove.amount === MAX_UINT256 || (
    allowanceDecimals !== null && isUnlimitedAllowance(decodedApprove.amount, allowanceDecimals)
  )) ? decodedApprove : null;
  let allowanceError: string | null = null;
  let boundedAllowance: bigint | null = null;
  if (decodedApprove && !signUnlimited) {
    if (allowanceDecimals == null) {
      allowanceError = allowanceMetadata?.request === req
        ? 'Could not read token decimals. The spending limit cannot be verified safely.'
        : 'Checking token decimals before reviewing the spending limit…';
    } else if (approveCall) {
      try { boundedAllowance = parseAllowance(rewriteAmt, allowanceDecimals); }
      catch (e) { allowanceError = e instanceof Error ? e.message : String(e); }
    }
  }
  const previewTx = allowanceError ? null : approveCall && !signUnlimited
    ? boundedAllowance === null ? null : { ...tx, data: rewriteApprove(approveCall, boundedAllowance) }
    : tx;
  const signerAddress = isTx
    ? paramAddress(tx.from)
    : isTyped ? paramAddress(req?.params?.[0])
      : isMsg ? paramAddress(req?.params?.[1])
        : null;
  const signer = signerAddress
    ? accounts.value.find((a) => a.address.toLowerCase() === signerAddress.toLowerCase())
    : isConnect ? acct : null;
  const previewKey = JSON.stringify([
    req?.id, approvalEndpoint, approvalChainId, signer?.address,
    previewTx?.to, previewTx?.data, previewTx?.value,
  ]);
  const missingSigner = Boolean((isTx || isTyped || isMsg) && !signerAddress);
  const unknownSigner = Boolean(signerAddress && !signer);
  const needsSigner = Boolean(isTx || isTyped || isMsg);
  // Token units belong to this request's chain and endpoint. A missing or
  // stale metadata response must never become an assumed 18-decimal token.
  useEffect(() => {
    setAllowanceMetadata(null);
    setRewriteAmt('100');
    setSignUnlimited(false);
    if (!req || !decodedApprove) return;
    let alive = true;
    void (async () => {
      try {
        const decimals = await chainClient(approvalEndpoint, approvalChainId).readContract({
          address: decodedApprove.token, abi: erc20Abi, functionName: 'decimals',
        });
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals');
        if (alive) setAllowanceMetadata({ request: req, decimals });
      } catch {
        if (alive) setAllowanceMetadata({ request: req, decimals: null });
      }
    })();
    return () => { alive = false; };
  }, [req, approvalEndpoint, approvalChainId, decodedApprove?.token]);

  // Preview the actual spending limit, and discard results for an older
  // amount. SIGN stays disabled until the current calldata has been checked.
  useEffect(() => {
    setPrev(null);
    setPreviewFor(null);
    setMoves(null);
    setMovesOff(false);
    if (!req || !isTx || !signer || !previewTx) return;
    let alive = true;
    void (async () => {
      const p = DEMO
        ? await demoPreviewSend(previewTx.to ?? '0x????', '0')
        : await previewDappTx(approvalEndpoint, signer.address, previewTx, approvalChainId);
      if (alive) { setPrev(p); setPreviewFor(previewKey); }
    })();
    // the asset changes are a second, independent question: a node that cannot
    // simulate must not cost us the gas preview
    if (!DEMO) {
      void (async () => {
        const m = await simulateMoves(signer.address, previewTx, approvalChainId);
        if (alive) { if (m) setMoves(m); else setMovesOff(true); }
      })();
    }
    return () => { alive = false; };
  }, [req, signer, previewKey]);

  if (!req) {
    return (
      <div class="content">
        <div class="simhead">[ REQUEST INTENSIFIES ]</div>
        <div class="note center">waiting for the request…</div>
      </div>
    );
  }

  function resolve(refuse: boolean, override?: ApprovalOverride) {
    setWorking(true);
    ext.runtime.sendMessage(
      {
        type: 'resolve-approval', id: req!.id, refuse,
        reason: 'user refused. rad.', override,
        autoTrack: !refuse && moves?.ok ? swapOutputTokens(moves.moves) : [],
      },
      () => window.close(),
    );
  }

  let typed: { domain?: any; primaryType?: string; message?: any } = {};
  if (isTyped) {
    try { typed = JSON.parse(String(req.params?.[1] ?? '{}')); } catch { /* shown raw below */ }
  }

  function buildOverride(): ApprovalOverride | undefined {
    if (isConnect) return { address: acct?.address };
    if (isTx && approveCall && !signUnlimited) {
      if (allowanceError || boundedAllowance === null || previewFor !== previewKey || !prev?.ok) {
        say(allowanceError ?? 'Wait for the updated spending limit to finish its transaction check.');
        throw new Error('Spending limit has not passed its checks');
      }
      return { tx: { ...sanitizeDappTx(tx), data: rewriteApprove(approveCall, boundedAllowance) } };
    }
    return undefined;
  }

  /*
    OUTCOME FIRST.

    The panels used to run provenance → signer → allowance → gas → WHAT MOVES,
    which put the balance diff — the one thing that decides yes or no — last,
    below the fold of a 600px popup. Every wallet worth copying leads with the
    estimated changes and puts "request from" underneath. So: what is wrong
    with this, then what it does to your money, then what would be rewritten,
    then who asked and who signs, then the raw payload.
  */
  return (
    <div class="content">
      <div class="simhead">
        {isConnect ? '[ SITE WANTS TO SEE YOU ]'
          : isSwitch ? '[ SITE WANTS TO SWITCH NETWORKS ]'
          : isTx ? '[ TRANSACTION INTENSIFIES ]'
          : isTyped ? '[ SITE WANTS A TYPED SIGNATURE ]'
          : '[ SITE WANTS A SIGNATURE ]'}
      </div>

      {isTx && (
        <div class="panel approvalchain">
          <div class="hd">NETWORK</div>
          <div class="simrow">
            <span class="dir"><ChainIcon chainId={approvalChainId} /></span>
            <span class="what">
              {CHAINS[approvalChainId]?.name ?? `Unknown chain`}
              <span class="dim"> · chain {approvalChainId}</span>
            </span>
          </div>
        </div>
      )}

      {/* ---- what is wrong with it, if anything ---- */}
      {missingSigner && (
        <div class="obey badver" style={{ fontSize: 13 }}>
          SITE DID NOT NAME A SIGNER.
          <br />
          <span style={{ fontSize: 10, fontWeight: 'normal' }}>
            the background refuses to guess a wallet for signatures or transactions.
          </span>
        </div>
      )}
      {unknownSigner && (
        <div class="obey badver" style={{ fontSize: 13 }}>
          SITE WANTS {short(signerAddress ?? undefined)} — NOT ONE OF YOUR WALLETS.
          <br />
          <span style={{ fontSize: 10, fontWeight: 'normal' }}>
            the background will refuse to sign for an address it does not hold or expose to this site.
          </span>
        </div>
      )}
      {isTx && approveCall && (
        <div class="obey badver">
          THIS CONTRACT WANTS<br />{approveCall.amount === MAX_UINT256 ? 'UNLIMITED ALLOWANCE' : 'A VERY LARGE SPENDING LIMIT'}
        </div>
      )}
      {isTx && prev && !prev.ok && (
        <div class="obey badver" style={{ fontSize: 13 }}>
          SIMULATION FAILED: {prev.error}
          <br />
          <span style={{ fontSize: 10, fontWeight: 'normal' }}>signing anyway is how wallets get drained. REFUSE.</span>
        </div>
      )}


      {/*
        WHAT MOVES. A swap is 1518 bytes of calldata and two assets changing
        hands, and only one of those is worth reading before signing. Run
        against head state through eth_simulateV1, netted for this wallet.
      */}
      {isTx && (!prev || (!moves && !movesOff)) && (
        <div class="note center">[ SIMULATION INTENSIFIES ] — nothing signed yet</div>
      )}
      {isTx && moves && moves.ok && (
        <div class="panel">
          <div class="hd">WHAT MOVES</div>
          {moves.moves.length === 0 && (
            <div class="simrow"><span class="what dim">no assets leave or enter this wallet</span></div>
          )}
          {moves.moves.map((m) => (
            <div class={`simrow ${m.raw < 0n ? 'out' : 'in'}`} key={`${m.address ?? 'native'}-${m.symbol}`}>
              <span class="dir">{m.raw < 0n ? '− OUT' : '+ IN'}</span>
              <span class="what">
                {m.kind === 'erc721'
                  ? `${m.symbol} #${m.tokenIds.slice(0, 4).join(', #')}${m.tokenIds.length > 4 ? ` +${m.tokenIds.length - 4}` : ''}`
                  : `${m.amount} ${m.symbol}`}
              </span>
            </div>
          ))}
          <div class="note dim" style={{ fontSize: 10, marginTop: 6 }}>
            from the chain as it stands right now. it can land differently.
          </div>
        </div>
      )}
      {isTx && movesOff && (
        <div class="note dim" style={{ fontSize: 11 }}>
          no endpoint in this chain's pool can simulate transfers, so the asset
          changes are unknown — the gas and revert check below still ran.
        </div>
      )}

      {/* the rewrite changes what moves, so it sits with it */}
      {isTx && decodedApprove && (
        <div class="panel">
          <div class="hd">{approveCall && !signUnlimited ? 'REWRITTEN BEFORE SIGNING' : 'TOKEN SPENDING LIMIT'}</div>
          <div style={{ fontSize: 12 }}>
            spender <LabeledAddress address={decodedApprove.spender} /> · token{' '}
            <span class="white">{short(decodedApprove.token)}</span>
            <br />asked for: <span class="white">{decodedApprove.amount === MAX_UINT256 ? 'UNLIMITED' : allowanceDecimals == null
              ? `${decodedApprove.amount.toString()} base units`
              : `${formatUnits(decodedApprove.amount, allowanceDecimals)} tokens`}</span>
            {approveCall && !signUnlimited && <>
              <br />spending limit:{' '}
              <input class="field" style={{ width: 120, display: 'inline-block', margin: '4px 0', padding: '2px 6px', fontSize: 13 }}
                aria-label="Token spending limit" inputMode="decimal"
                value={rewriteAmt} disabled={working}
                onInput={(e) => setRewriteAmt((e.target as HTMLInputElement).value.trim())} /> tokens
            </>}
          </div>
          {allowanceError && <div class="note" role="status">{allowanceError}</div>}
          {approveCall && <label class="row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={signUnlimited} disabled={working}
              onChange={(e) => setSignUnlimited((e.target as HTMLInputElement).checked)} />
            <span class="dim">{decodedApprove.amount === MAX_UINT256
              ? 'allow unlimited spending of this token' : "use the site's requested spending limit"}</span>
          </label>}
          <div class="note">{decodedApprove.amount === MAX_UINT256
            ? 'Unlimited approval lets the approved address spend your current and future token balance until you revoke its allowance.'
            : decodedApprove.amount === 0n
              ? 'This revokes the existing spending allowance for this address.'
              : 'This replaces the existing allowance for this address. The approved amount can be spent from your current or future token balance.'}</div>
        </div>
      )}

      {/* ---- who asked, and who would sign ---- */}
      {isTx && typeof tx.to === 'string' && tx.to && (
        <div class="panel">
          <div class="hd">TRANSACTION DESTINATION</div>
          <LabeledAddress address={tx.to} />
          <QuickAddAddress key={tx.to.toLowerCase()} address={tx.to} disabled={working} />
        </div>
      )}
      <div class="panel">
        <div class="hd">WHO IS ASKING</div>
        <div class="white" style={{ fontSize: 13, wordBreak: 'break-all' }}>{req.origin}</div>
      </div>

      {isSwitch && (
        <div class="panel">
          <div class="hd">NETWORK CHANGE</div>
          <div class="simrow">
            <span class="what">{CHAINS[approvalChainId]?.name ?? `chain ${approvalChainId}`}</span>
            <span class="dir">→ {CHAINS[switchChainId]?.name ?? `chain ${switchChainId}`}</span>
          </div>
          <div class="note dim" style={{ fontSize: 10, marginTop: 6 }}>
            this changes which chain the site can read and ask you to sign on. it signs nothing by itself.
          </div>
        </div>
      )}

      {needsSigner && signer && (
        <div class="panel">
          <div class="hd">SIGNING AS</div>
          <div class="simrow">
            <span class="what">
              {signer.label}
              {/* "wallet 1" of WHICH seed — the label repeats across groups */}
              {(groups.value.length > 1 || signer.kind === 'imported') && (
                <span class="dim"> · {signer.groupLabel}</span>
              )}
            </span>
            <span class="dir">{short(signer.address)}</span>
          </div>
        </div>
      )}


      {isConnect && (
        <div class="panel">
          <div class="hd">WHAT THEY GET</div>
          <div style={{ fontSize: 12 }}>
            your address <span class="white">{acct?.address}</span> and the ability to ask for
            signatures (each one prompts again). The site can look up this address's public
            balances and activity. Your keys and other wallet addresses are not shared.
          </div>
        </div>
      )}

      {isMsg && (
        <div class="panel">
          <div class="hd">MESSAGE (decoded locally)</div>
          <div class="white" style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {hexToUtf8(rawMsg)}
          </div>
        </div>
      )}

      {isTyped && (
        <div class="panel">
          <div class="hd">TYPED DATA (EIP-712, decoded locally)</div>
          <div style={{ fontSize: 11 }}>
            <div>domain: <span class="white">{typed.domain?.name ?? '?'} {typed.domain?.version ?? ''}</span>
              {typed.domain?.verifyingContract && <span class="dim"> · {short(typed.domain.verifyingContract)}</span>}</div>
            <div>type: <span class="white">{typed.primaryType ?? '?'}</span></div>
            <pre class="white" style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
              {JSON.stringify(typed.message ?? req.params?.[1], null, 1)}
            </pre>
          </div>
        </div>
      )}

      {/* the cost and the revert check — detail, under the decision */}
      {isTx && prev && prev.ok && (
        <div class="panel">
          <div class="hd">TRANSACTION PREVIEW</div>
          {prev.out.map((o) => (
            <div class="simrow out"><span class="dir">− OUT</span><span class="what">{o.amount} {o.asset}</span></div>
          ))}
          {prev.in_.map((i) => (
            <div class="simrow in"><span class="dir">→</span><span class="what">{i.asset}</span></div>
          ))}
          <div class="simrow"><span class="dir">EST. GAS</span><span class="what">{prev.gasEth} ETH</span></div>
          <div class="note">{DEMO ? 'Demo preview. No RPC request was made.'
            : 'Checked using your selected RPC provider. Results may change before confirmation.'}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button class="btn danger" style={{ flex: 1 }} disabled={working} onClick={() => resolve(true)}>
          REFUSE
        </button>
        <button
          class="btn"
          style={{ flex: 1 }}
          disabled={
            working
            || (isConnect && !acct)
            || (needsSigner && (!signer || missingSigner || unknownSigner))
            || (isTx && (!prev || !prev.ok))
            || (isTx && (previewFor !== previewKey || Boolean(allowanceError)))
            || (isTx && !moves && !movesOff)
          }
          onClick={() => {
            try {
              const ov = buildOverride();
              resolve(false, ov);
            } catch { /* bad amount, stay open */ }
          }}
        >
          {isConnect ? 'CONNECT'
            : isSwitch ? 'SWITCH'
            : working ? '[ WORKING ]'
            : (approveCall && !signUnlimited ? 'SIGN REWRITTEN' : 'SIGN IT')}
        </button>
      </div>
      <div class="note center" style={{ marginTop: 8 }}>
        REFUSE is always as big as the other button. that is policy.
        {acct ? '' : ' unlock first — keys stay in the background worker.'}
      </div>
      <FooterRing />
    </div>
  );
}
