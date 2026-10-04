/**
 * Collectibles — every NFT you hold, across every scanned chain.
 *
 * They used to be listed on HOME as well, mixed into the token rows — a row
 * you cannot compare with the row above it, in a list sorted by value that a
 * collection has none of. Here they are their own kind of thing, and HOME
 * carries one line pointing at them.
 */
import { nfts, openNft, CHAINS, refresh, nftError, openTokenList } from '../state.js';
import { CHAIN_IDS } from '@radwallet/core';
import { AssetIcon, ChainIcon } from '../bits.js';

export function Nfts() {
  const all = nfts.value;
  const total = all.reduce((n, x) => n + x.count, 0);
  // The tracked collection can be on an owner-added chain, which does not
  // belong to the standing privacy sweep. List every registered chain that
  // actually returned a holding instead of filtering it back out here.
  const chains = CHAIN_IDS.filter((id) => all.some((n) => n.chainId === id));

  return (
    <div class="content">
      <h1 class="simhead">[ COLLECTIBLES ]</h1>

      {all.length === 0 && nftError.value && (
        <div class="panel">
          <div class="hd">COULD NOT LOOK</div>
          <div class="note">
            {nftError.value} — this is not the same as owning nothing. Try again,
            or add an endpoint that answers in SETTINGS → NETWORKS.
          </div>
          <button class="btn ghost block" onClick={() => void refresh()}>TRY AGAIN</button>
        </div>
      )}

      {all.length === 0 && !nftError.value && (
        <div class="panel">
          <div class="hd">NOTHING HERE (YET)</div>
          <div class="note">
            We check bundled collections and any you add. For broader NFT discovery,
            enable an indexer in SETTINGS → PRIVACY.
          </div>
          <button class="btn ghost block" onClick={openTokenList}>
            ADD A COLLECTION BY ADDRESS
          </button>
        </div>
      )}

      {chains.map((id) => (
        <div class="chainblock" key={id}>
          <div class="chainhead">
            <ChainIcon chainId={id} />
            <span class="cname">{CHAINS[id].name}</span>
            <span class="ccount">
              {all.filter((n) => n.chainId === id).reduce((t, x) => t + x.count, 0)} held
            </span>
          </div>
          {all.filter((n) => n.chainId === id).map((n) => (
            <button class="nftrow" key={n.address} onClick={() => (openNft.value = n)}>
              <AssetIcon chainId={id}><span class="glyph">▣</span></AssetIcon>
              <span class="nftwho">
                <span class="nftname">{n.name}</span>
                <span class="nftids">
                  {n.tokenIds.length
                    ? `#${n.tokenIds.slice(0, 3).join(' #')}${n.count > n.tokenIds.length ? ` +${n.count - n.tokenIds.length}` : ''}`
                    : 'ids not enumerable on-chain'}
                </span>
              </span>
              <span class="amt">{n.count} ›</span>
            </button>
          ))}
        </div>
      ))}

      {all.length > 0 && (
        <div class="center manage">
          <button class="act" onClick={() => void refresh()}>↻ RESCAN</button>
          <button class="act" onClick={openTokenList}>⚙ ADD BY ADDRESS</button>
        </div>
      )}
      <div class="note center" style={{ marginTop: 10 }}>
        {total} across {chains.length} chain{chains.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}
