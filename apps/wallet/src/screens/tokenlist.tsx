/**
 * Manage the token list: paste a contract, and it joins the sweep.
 *
 * No public RPC will tell us what an address holds without being told which
 * contracts to ask about (open log queries are refused), so this is how the
 * long tail gets in. It refuses anything that will not identify itself.
 *
 * A sheet rather than a block at the bottom of HOME, because COLLECTIBLES
 * needs it too — its empty state used to send you to HOME and leave you to
 * find the button.
 */
import { useRef, useState } from 'preact/hooks';
import { closeSheet, addContract, say, chainId, customTokens, customCollections } from '../state.js';
import { CHAINS, CHAIN_IDS } from '@radwallet/core';
import { useModalDialog } from '../bits.js';

export function TokenListSheet() {
  const box = useRef<HTMLDivElement>(null);
  const [addr, setAddr] = useState('');
  // A custom network becomes the selected signing chain as soon as its owner
  // adds it, so it is the natural target for the next contract they paste.
  const [target, setTarget] = useState(chainId.value);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useModalDialog(box, closeSheet);

  const added = CHAIN_IDS.flatMap((id) => [
    ...(customTokens.value[id] ?? []).map((t) => ({ id, name: t.symbol, address: t.address })),
    ...(customCollections.value[id] ?? []).map((c) => ({ id, name: c.name, address: c.address })),
  ]);

  return (
    <div class="drawer" onMouseDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('drawer')) closeSheet();
    }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label="token list" tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">[ TOKEN LIST ]</h2>
          <button class="x" title="close (esc)" onClick={closeSheet}>[X]</button>
        </div>

        <div class="drawerbody">
          {failed && (
            <div class="note red">
              {failed} — check the contract address and selected network.
            </div>
          )}
          <div class="chips filterrow">
            {CHAIN_IDS.map((id) => (
              <button
                key={id} class={`chip${target === id ? ' on' : ''}`}
                onClick={() => setTarget(id)}
              >{CHAINS[id].name}</button>
            ))}
          </div>
          <input
            class="field" placeholder="0x… token or NFT contract" value={addr}
            onInput={(e) => setAddr((e.target as HTMLInputElement).value)}
          />
          <div class="note">
            add a token or ERC-721 collection that is missing from the bundled list.
            we read it from your selected chain's own node; that does not verify its safety or authenticity.
            Adding one is also your instruction to check that chain on future refreshes.
          </div>

          {added.length > 0 && (
            <>
              <div class="testhead" style={{ marginTop: 12 }}>TRACKED CONTRACTS</div>
              {added.map((a) => (
                <div class="rpcrow" key={`${a.id}-${a.address}`}>
                  <span class="ep">{a.name}<span class="dim"> · {CHAINS[a.id].name}</span></span>
                </div>
              ))}
            </>
          )}
        </div>

        <div class="drawerfoot">
          <button
            class="btn block" disabled={working || addr.trim().length < 42}
            onClick={() => {
              setWorking(true);
              setFailed(null);
              addContract(target, addr)
                .then((msg) => { say(msg); setAddr(''); closeSheet(); })
                .catch((e) => setFailed((e as Error).message.split('\n')[0]))
                .finally(() => setWorking(false));
            }}
          >{working ? '[ CHECKING ]' : 'ADD IT'}</button>
        </div>
      </div>
    </div>
  );
}
