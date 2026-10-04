/**
 * One collection, opened up: every token id we could read, and where its
 * metadata lives.
 *
 * The art is deliberately NOT loaded by default. Every image sits behind an
 * ipfs:// or https:// URL owned by someone else, so fetching it tells that
 * host your IP and exactly which NFTs you hold — the same leak the indexer
 * warns about, arriving quietly through an <img> tag. So the URI is shown as
 * text, copyable, and the art loads only when you ask for it, per collection,
 * for that session.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  openNft, prefs, persistPrefs, CHAINS, openSend, nfts, account, endpointForChain, say, sayError,
} from '../state.js';
import {
  resolveArt, explorerTokenUrl, explorerNftUrl,
  readCollectionTokenIdPage, verifyCollectionTokenId,
  type NftHolding,
} from '@radwallet/core';
import { ChainIcon, useModalDialog } from '../bits.js';

/**
 * tokenURI points at a metadata DOCUMENT, not a picture — the image is a field
 * inside it. Pointing an <img> at the tokenURI shows nothing at all, which is
 * exactly what it did before. resolveArt does both hops.
 */
function useArt(uris: string[], on: boolean): Record<string, string> {
  const [art, setArt] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!on) { setArt({}); return; }
    let live = true;
    void (async () => {
      for (const uri of uris) {
        const src = await resolveArt(uri, { allowed: true });
        if (!live) return;
        if (src) setArt((prev) => ({ ...prev, [uri]: src }));
      }
    })();
    return () => { live = false; };
  }, [on, uris.join('|')]);
  return art;
}

export function NftSheet() {
  const n = openNft.value;
  const box = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0);
  const close = () => { reqSeq.current += 1; openNft.value = null; };
  const [showArt, setShowArt] = useState(prefs.value.loadArt === true);
  const [checking, setChecking] = useState(false);
  const [tokenId, setTokenId] = useState('');
  const uris = n ? n.tokenIds.map((id) => n.tokenUris[id]).filter(Boolean) : [];
  const art = useArt(uris, showArt && !!n);
  useModalDialog(box, close);
  if (!n) return null;
  const collectionExplorer = explorerTokenUrl(n.chainId, n.address);
  const hidden = Math.max(0, n.count - n.tokenIds.length);
  const canLoadMore = hidden > 0 && n.enumerable && n.idSource !== 'ownerOf' && n.idsComplete !== true;

  function stillOpenFor(requestSeq: number, requested: NftHolding, address: `0x${string}`): boolean {
    const current = openNft.value;
    return requestSeq === reqSeq.current
      && account.value?.address.toLowerCase() === address.toLowerCase()
      && current?.chainId === requested.chainId
      && current.address.toLowerCase() === requested.address.toLowerCase();
  }

  function replaceHolding(next: NftHolding): void {
    openNft.value = next;
    nfts.value = nfts.value.map((holding) =>
      holding.chainId === next.chainId && holding.address.toLowerCase() === next.address.toLowerCase()
        ? next
        : holding);
  }

  async function loadMoreIds(): Promise<void> {
    const acct = account.value;
    if (!acct || !n || checking) return;
    const requested = n;
    const seq = ++reqSeq.current;
    setChecking(true);
    try {
      const page = await readCollectionTokenIdPage(
        endpointForChain(requested.chainId), requested.chainId, acct.address, requested,
      );
      if (!stillOpenFor(seq, requested, acct.address)) return;
      const current = openNft.value ?? requested;
      const tokenIds = [...new Set([...current.tokenIds, ...page.tokenIds])];
      replaceHolding({
        ...current,
        tokenIds,
        tokenUris: { ...current.tokenUris, ...page.tokenUris },
        idCursor: page.nextCursor,
        idsComplete: page.complete || tokenIds.length >= current.count,
      });
      say(page.tokenIds.length ? `loaded ${page.tokenIds.length} more token ID${page.tokenIds.length === 1 ? '' : 's'}.` : 'no more token IDs returned.');
    } catch (e) {
      if (stillOpenFor(seq, requested, acct.address)) sayError(e);
    } finally {
      if (seq === reqSeq.current) setChecking(false);
    }
  }

  async function checkTokenId(): Promise<void> {
    const acct = account.value;
    if (!acct || !n || checking) return;
    const requested = n;
    const seq = ++reqSeq.current;
    setChecking(true);
    try {
      const found = await verifyCollectionTokenId(
        endpointForChain(requested.chainId), requested.chainId, acct.address, requested, tokenId,
      );
      if (!stillOpenFor(seq, requested, acct.address)) return;
      const current = openNft.value ?? requested;
      const tokenIds = [...new Set([...current.tokenIds, found.tokenId])];
      replaceHolding({
        ...current,
        tokenIds,
        tokenUris: { ...current.tokenUris, ...(found.tokenUri ? { [found.tokenId]: found.tokenUri } : {}) },
        idsComplete: tokenIds.length >= current.count,
      });
      setTokenId('');
      say(`#${found.tokenId} belongs to this wallet.`);
    } catch (e) {
      if (stillOpenFor(seq, requested, acct.address)) sayError(e);
    } finally {
      if (seq === reqSeq.current) setChecking(false);
    }
  }

  return (
    <div class="drawer" onMouseDown={(e) => {
      if ((e.target as HTMLElement).classList.contains('drawer')) close();
    }}>
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label={n.name} tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">[ {n.symbol} ]</h2>
          <span class="count">{n.count}</span>
          <button class="x" title="close (esc)" onClick={close}>[X]</button>
        </div>

        <div class="drawerbody">
          <div class="nftmeta">
            <div class="nftname">{n.name}</div>
            <div class="note">
              <ChainIcon chainId={n.chainId} />{' '}
              {CHAINS[n.chainId]?.name ?? `chain ${n.chainId}`} ·{' '}
              {collectionExplorer
                ? <a
                  class="exlink" target="_blank" rel="noreferrer"
                  href={collectionExplorer}
                  title={`this collection on ${new URL(collectionExplorer).host}`}
                  aria-label={`view the ${n.symbol} collection on the block explorer`}
                >{`${n.address.slice(0, 6)}…${n.address.slice(-4)}`} ↗</a>
                : <span class="dim">no block explorer configured</span>}
            </div>
            {hidden > 0 && (
              <div class="note">
                showing {n.tokenIds.length} of {n.count}. scan limits can leave token IDs missing.
                {canLoadMore ? ' Load the next page, or check a specific ID.' : ' Check a specific ID if you know it.'}
              </div>
            )}
            {n.tokenIds.length === 0 && (
              <div class="note">
                we could read your collection balance, but could not identify the individual tokens.
              </div>
            )}
          </div>

          {hidden > 0 && (
            <div class="panel">
              <div class="hd">MISSING IDS</div>
              {canLoadMore && (
                <button class="btn ghost block" disabled={checking} onClick={() => void loadMoreIds()}>
                  {checking ? '[ CHECKING ]' : 'LOAD MORE IDS'}
                </button>
              )}
              <div class="setrow">
                <span>token ID</span>
                <input
                  class="field" inputMode="numeric" aria-label="NFT token ID to check"
                  value={tokenId} onInput={(e) => setTokenId((e.target as HTMLInputElement).value)}
                />
                <button class="act" disabled={checking || !tokenId.trim()} onClick={() => void checkTokenId()}>
                  CHECK
                </button>
              </div>
              <div class="note">Checking an ID asks the chain who owns that token.</div>
            </div>
          )}

          {n.tokenIds.length > 0 && (
            <div class="artrow">
              {showArt
                ? (
                  <div class="note">
                    loaded {Object.keys(art).length} of {uris.length} artwork sources.
                    external hosts may receive your IP address.{' '}
                    <button class="act" onClick={() => setShowArt(false)}>hide artwork</button>
                    {' · '}
                    <button
                      class="act"
                      onClick={() => {
                        prefs.value = { ...prefs.value, loadArt: !prefs.value.loadArt };
                        void persistPrefs();
                      }}
                    >{prefs.value.loadArt ? 'stop doing this automatically' : 'always load art'}</button>
                  </div>
                )
                : (
                  <button class="btn ghost block" onClick={() => setShowArt(true)}>
                    LOAD THE ART (external hosts may receive your IP)
                  </button>
                )}
            </div>
          )}

          {n.tokenIds.map((id) => {
            const uri = n.tokenUris[id];
            const tokenExplorer = explorerNftUrl(n.chainId, n.address, id);
            return (
              <div class="nftitem" key={id}>
                {showArt && uri && (
                  art[uri]
                    ? <img class="nftart" src={art[uri]} alt={`${n.name} #${id}`} loading="lazy" />
                    : <span class="nftart pending" aria-hidden="true">…</span>
                )}
                <div class="nftitemtext">
                  {/* the id is the link to this exact token on the explorer —
                      etherscan and blockscout disagree on the path, so the
                      registry knows which family each chain runs */}
                  <div class="nftid">
                    {tokenExplorer
                      ? <a
                        class="exlink" target="_blank" rel="noreferrer"
                        href={tokenExplorer}
                        title={`#${id} on ${new URL(tokenExplorer).host}`}
                      >#{id} ↗</a>
                      : <span class="dim">#{id}</span>}
                  </div>
                  {uri
                    ? <a
                      class="uri" href={uri} title={uri}
                      target="_blank" rel="noreferrer noopener"
                    >{uri.length > 46 ? `${uri.slice(0, 44)}…` : uri} ↗</a>
                    : <span class="note">no tokenURI</span>}
                </div>
                <button
                  class="btn ghost nftsend"
                  onClick={() => {
                    openNft.value = null;
                    openSend({
                      kind: 'erc721', chainId: n.chainId, address: n.address,
                      symbol: n.symbol, name: n.name, tokenId: id,
                    });
                  }}
                >SEND ↗</button>
              </div>
            );
          })}
        </div>

        <div class="drawerfoot">
          <div class="note center">read from the chain</div>
        </div>
      </div>
    </div>
  );
}
