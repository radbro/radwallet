/**
 * RECEIVE, as a sheet: the address to give out, and nothing else.
 *
 * It used to carry the stealth SCAN and SWEEP as well, which is a different
 * job wearing the same heading — scanning for payments and sweeping them home
 * is an inbox, not a step in handing someone your address. That half lives on
 * ACTIVITY now, where the money that arrives already goes.
 */
import { useMemo, useRef } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { screen, account, groups, stealthMeta, say, closeSheet } from '../state.js';
import { useModalDialog } from '../bits.js';

/** QR rendered locally as an SVG — no image service, obviously. */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let rects = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rects += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
    }
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><g fill="#000">${rects}</g></svg>`,
  )}`;
}

export function ReceiveSheet() {
  const acct = account.value;
  const box = useRef<HTMLDivElement>(null);
  const qr = useMemo(() => (acct ? qrSvg(acct.address) : ''), [acct?.address]);
  useModalDialog(box, closeSheet);

  if (!acct) return null;

  return (
    <div class="drawer" onMouseDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('drawer')) closeSheet();
    }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label="receive" tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">RECEIVE · {acct.label.toUpperCase()}</h2>
          {/* two seeds can each hold a "wallet 1"; say which one gets paid */}
          {(groups.value.length > 1 || acct.kind === 'imported') && (
            <span class="count">{acct.groupLabel}</span>
          )}
          <button class="x" title="close (esc)" onClick={closeSheet}>[X]</button>
        </div>

        <div class="drawerbody">
          <div class="center">
            <img class="qr" src={qr} width={150} height={150} alt={`QR code for ${acct.address}`} />
          </div>
          <div class="addr">{acct.address}</div>

          <div class="panel" style={{ marginTop: 12 }}>
            <div class="hd">STEALTH RECEIVE · ETHEREUM</div>
            <div class="note">
              receive ETH on Ethereum at a fresh address for each payment. the sender needs
              a wallet that supports ERC-5564. the sender knows the payment address, and
              transactions stay public.
            </div>
            {stealthMeta.value
              ? (
                <>
                  <div class="addr" style={{ fontSize: 10 }}>{stealthMeta.value}</div>
                  <div class="btnrow">
                    <button class="btn ghost" onClick={async () => {
                      await navigator.clipboard.writeText(stealthMeta.value!);
                      say('stealth receiving address copied. share it with a sender who supports ERC-5564.');
                    }}>⧉ COPY IT</button>
                    <button class="btn ghost" onClick={() => { closeSheet(); screen.value = 'activity'; }}>
                      CHECK FOR PAYMENTS
                    </button>
                  </div>
                </>
              )
              : (
                <div class="note" style={{ marginTop: 6, color: '#ff2a2a' }}>
                  this wallet uses an imported private key. RADWALLET derives stealth receiving
                  addresses from a seed phrase, so switch to a seed wallet to receive stealth payments.
                </div>
              )}
          </div>
        </div>

        <div class="drawerfoot">
          <button class="btn block" onClick={async () => {
            await navigator.clipboard.writeText(acct.address);
            say('address copied. go get paid, bro.');
          }}>⧉ COPY ADDRESS</button>
        </div>
      </div>
    </div>
  );
}
