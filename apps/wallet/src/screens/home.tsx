import {
  screen, account, accounts, groups, cycleAccount, refresh,
  prefs, chainId, ensName, pickerOpen, say,
  balances, nfts, nftError, usdRate, portfolioEth, usd, openAsset,
  openSend, openReceive, openTokenList,
  assetRows, testRows, chainErrors, chainsHeld, viewChain, setViewChain, viewChainEth,
  type AssetRow,
} from '../state.js';
import {
  CHAINS, CHAIN_IDS, SCAN_CHAIN_IDS, TESTNET_CHAIN_IDS, isTestnet, formatAmount,
  explorerAddressUrl,
} from '@radwallet/core';
import { formatEther } from 'viem';
import { AVATAR_BRO, AVATAR_CAT, RADCOIN } from '../assets.js';
import { AssetIcon, BlockCounter, ChainIcon, EthIcon, FooterRing, IconBtn, LetterMark } from '../bits.js';
import { SiteBar } from './site.js';

const AVATARS = [AVATAR_BRO, AVATAR_CAT];

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function Home() {
  const acct = account.value;
  if (!acct) return <div class="content" />;

  // native balance summed across every real chain — the same asset on each, so
  // adding it is honest in a way a bag of different tokens would not be. Test
  // ETH is free, so it never enters this.
  const totalEth = (() => {
    const wei = balances.value
      .filter((b) => !b.address && !isTestnet(b.chainId ?? 1))
      .reduce((t, b) => t + b.raw, 0n);
    return formatAmount(formatEther(wei));
  })();
  const fiat = usdRate.value !== null && portfolioEth.value !== null
    ? usd(portfolioEth.value * usdRate.value)
    : null;
  const rows = assetRows.value;
  const tests = testRows.value;
  // the explorer link is about YOUR ADDRESS, so it sits next to the address —
  // once, rather than repeated on every chain heading in the list
  const explorer = explorerAddressUrl(viewChain.value ?? chainId.value, acct.address);
  const explorerName = CHAINS[viewChain.value ?? chainId.value].name;

  return (
    <div class="content">
      {/*
        Header, balance, actions — the order every modern wallet converged on,
        because it matches what people came to do: who am I, how much, act.

        The network is NOT up here. It used to be, and it named one chain while
        the list below it showed three: a header that says "Ethereum" a scroll
        above a SIGN button should be telling the truth. It lives over the
        asset list now, where it filters what it names.
      */}
      <div class="acctbar">
        <img class="pfp" src={AVATARS[acct.index % AVATARS.length]} alt="" />
        {accounts.value.length > 1 && (
          <button
            class="cycle" title="previous wallet" aria-label="previous wallet"
            onClick={() => cycleAccount(-1)}
          >‹</button>
        )}
        <button class="who" title="all your wallets" onClick={() => (pickerOpen.value = true)}>
          {/* a nickname the user typed outranks reverse-ENS */}
          {acct.named ? acct.label : ensName.value ?? acct.label} ▾
        </button>
        {accounts.value.length > 1 && (
          <button
            class="cycle" title="next wallet" aria-label="next wallet"
            onClick={() => cycleAccount(1)}
          >›</button>
        )}
        <IconBtn
          className="acctrefresh" glyph="↻" tip="refresh balances"
          onClick={() => void refresh()}
        />
      </div>
      <SiteBar />
      {(groups.value.length > 1 || acct.kind === 'imported') && (
        <div class="acctsub">
          {acct.groupLabel}
          {acct.kind === 'imported' && ' · your seed phrase cannot restore this one'}
        </div>
      )}

      {/*
        What it is worth, big — the number every other wallet leads with, and
        the one people open a wallet to read. It is not a tracker: the rate is
        a QuoterV2 read of a USDC pool on your own RPC, taken at ONE ether, so
        the node learns nothing about your size that your balances did not
        already tell it. When no pool answers there is no dollar figure to show
        and the ether takes the headline back.
      */}
      <div class="balance center">
        {fiat
          ? (
            <>
              <div class="big"><span>{fiat}</span></div>
              <div class="native"><EthIcon /><span>{totalEth} ETH</span></div>
            </>
          )
          : (
            <>
              <div class="big"><EthIcon /><span>{totalEth} ETH</span></div>
              <div class="native dim">dollar estimate unavailable</div>
            </>
          )}
        <div class="sub">
          {/* the address IS the copy button — it is the thing people came to
              copy, and making them find a separate word for it is a tax */}
          <button
            class="addrcopy" title="copy this address"
            onClick={async () => {
              await navigator.clipboard.writeText(acct.address);
              say('address copied');
            }}
          >{short(acct.address)} ⧉</button>
          {explorer
            ? <a
              class="addrex tip" href={explorer} target="_blank" rel="noreferrer"
              data-tip={`this address on ${explorerName}`}
              aria-label={`view this address on the ${explorerName} block explorer`}
            >↗</a>
            : <span class="addrex dim" title={`${explorerName} has no configured block explorer`}>—</span>}
        </div>
        <div class="acrossline">
          across {chainsHeld.value || SCAN_CHAIN_IDS.length} chains
        </div>
      </div>

      {/*
        Three verbs on money. SETTINGS used to sit here as a fourth tile, which
        is a destination wearing an action's clothes — and it is already in the
        tab bar, so it was competing with the three things people came to do.
      */}
      <div class="actions">
        <button class="tile" onClick={openReceive}>
          <span class="ic">▤</span><span class="lb">RECEIVE</span>
        </button>
        <button class="tile" onClick={() => openSend(null)}>
          <span class="ic">↗</span><span class="lb">SEND</span>
        </button>
        <button class="tile" onClick={() => (screen.value = 'swap')}>
          <span class="ic">⇄</span><span class="lb">SWAP</span>
        </button>
      </div>

      {/*
        One flat list, biggest first, chain as a badge on the icon.

        It used to be a block per chain, in scan order, each foldable — which
        put your largest holding below the fold whenever it was not on
        Ethereum, and made "what do I own most of" a question you had to add up
        headers to answer. The badge is how every multi-chain wallet answers
        "which chain is this row on", and we were already drawing it.
      */}
      <div class="listbar">
        <label class="netpill" title="which network the list shows">
          {viewChain.value === null
            ? <span class="allmark" aria-hidden="true">◇</span>
            : <ChainIcon chainId={viewChain.value} />}
          <select
            class="netsel" aria-label="filter the asset list by network"
            value={viewChain.value === null ? 'all' : String(viewChain.value)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setViewChain(v === 'all' ? null : Number(v));
            }}
          >
            <option value="all">all networks</option>
            <optgroup label="mainnet">
              {CHAIN_IDS.filter((id) => !isTestnet(id)).map((id) => (
                <option key={id} value={String(id)}>{CHAINS[id].name}</option>
              ))}
            </optgroup>
            {/* a testnet is always switchable — a dapp under development lives
                on one — but it is listed apart so picking one is deliberate */}
            <optgroup label="testnet">
              {TESTNET_CHAIN_IDS.map((id) => (
                <option key={id} value={String(id)}>{CHAINS[id].name}</option>
              ))}
            </optgroup>
          </select>
        </label>
        <span class="lbmeta">
          {viewChain.value !== null && viewChainEth.value !== null && usdRate.value !== null
            && !isTestnet(viewChain.value)
            ? usd(viewChainEth.value * usdRate.value)
            : `${rows.length} asset${rows.length === 1 ? '' : 's'}`}
        </span>
        <IconBtn
          className="lbmanage" glyph="⚙" tip="manage the token list"
          label="add a token or collection by address"
          onClick={openTokenList}
        />
      </div>

      {/* a chain that was asked and did not answer says so once, at the top,
          rather than as a heading buried among the rows it failed to fill */}
      {chainErrors.value.map((c) => (
        <div class="chainerr" key={c.chainId}>no answer from {c.name} — {c.error}</div>
      ))}

      {rows.map((r) => <TokenRow key={rowKey(r)} r={r} showChain={viewChain.value === null} />)}

      {rows.length === 0 && chainErrors.value.length === 0 && (
        <div class="note center" style={{ padding: 12 }}>
          {viewChain.value === null
            ? `checking ${SCAN_CHAIN_IDS.length} chains… (or every RPC is unreachable — see SETTINGS)`
            : `nothing on ${CHAINS[viewChain.value].name} yet.`}
        </div>
      )}

      {/*
        Testnets live BELOW the real chains and outside every total. Test ETH
        is free to mint, so folding it into the balance — or pricing it —
        would put a number on the screen that means nothing.
      */}
      {tests.length > 0 && (
        <div class="testzone">
          <div class="testhead">TESTNETS · NOT MONEY</div>
          {tests.map((r) => <TokenRow key={rowKey(r)} r={r} showChain={viewChain.value === null} />)}
        </div>
      )}

      {viewChain.value !== null && isTestnet(viewChain.value) && !prefs.value.testnets && (
        <div class="note center" style={{ padding: 12 }}>
          on {CHAINS[viewChain.value].name} · testnet balances stay hidden until you
          turn TESTNETS on in SETTINGS → NETWORKS
        </div>
      )}

      {/* collectibles are their own tab, and their own kind of thing: they used
          to be mixed into this list, which is a row you cannot compare with
          the row above it */}
      {nfts.value.length > 0 && (
        <button class="nftlink" onClick={() => (screen.value = 'nfts')}>
          <span class="ic" aria-hidden="true">▣</span>
          <span>{nfts.value.reduce((n, x) => n + x.count, 0)} collectibles</span>
          <span class="go">›</span>
        </button>
      )}
      {nftError.value && (
        <div class="chainerr">collectibles: {nftError.value}</div>
      )}

      <BlockCounter />
      <FooterRing />
    </div>
  );
}

function rowKey(r: AssetRow): string {
  return `${r.chainId}-${r.b.symbol}-${r.b.address ?? 'native'}`;
}

/**
 * One holding: icon + chain badge, name, symbol, value right — then send.
 *
 * The chain is spelled out beside the symbol only while the list spans more
 * than one: filtered to a single network, every row would repeat the same
 * word, and repetition is what stops a row being read.
 */
function TokenRow({ r, showChain }: { r: AssetRow; showChain: boolean }) {
  const { b, chainId: chain } = r;
  return (
    <div class="tokrow">
      {/* the row opens the asset; the send shortcut stays its own target,
          because a button inside a button is neither valid nor clickable in
          the way anyone expects */}
      <button
        class="tokpick" title={`${b.name} details`}
        onClick={() => (openAsset.value = b)}
      >
        {/* no badge when it would just repeat the icon underneath: ETH on
            Ethereum is already wearing the Ethereum mark */}
        <AssetIcon chainId={chain} badge={!(chain === 1 && !b.address)}>
          {b.symbol === '$RAD'
            ? <img src={RADCOIN} alt="" />
            : b.symbol === 'ETH'
              ? <EthIcon />
              : <LetterMark symbol={b.symbol} seed={b.address} />}
        </AssetIcon>
        <span class="tokwho">
          <span class="tokname">{b.name}</span>
          <span class="toksym">
            {b.symbol}
            {showChain && <span class="tokchain"> · {CHAINS[chain]?.name ?? chain}</span>}
            {/*
              TWO CONTRACTS CAN CLAIM THE SAME NAME, and on Robinhood two of
              them do: both call themselves USDG / "Global Dollar" and render
              as identical rows. Where a symbol is not unique on its chain the
              row shows which contract it is — otherwise the choice of which
              one you spend is a coin flip.
            */}
            {b.address && r.dupe && (
              <span class="dupaddr" title={b.address}>
                {` · ${b.address.slice(0, 6)}…${b.address.slice(-4)}`}
              </span>
            )}
          </span>
        </span>
        <span class="amt">
          {/* value first, amount under it: the list is sorted by value, so the
              number the order is built from is the one that leads */}
          {(() => {
            if (r.eth === null || usdRate.value === null || r.eth <= 0 || isTestnet(chain)) {
              return <span class="amtnum">{b.amount} ›</span>;
            }
            return (
              <>
                <span class="amtnum">{usd(r.eth * usdRate.value)} ›</span>
                <span class="tokusd">{b.amount} {b.symbol}</span>
              </>
            );
          })()}
        </span>
      </button>
      {/* one row, one word, times every token you hold: "send" spelled out
          down the whole list stops being read and starts being texture. The
          arrow is the same one the action tile carries. */}
      <IconBtn
        className="toksend" glyph="↗"
        tip={`send ${b.symbol}`}
        label={`send ${b.symbol} on ${CHAINS[chain]?.name ?? chain}`}
        onClick={() => openSend(b.address
          ? {
            kind: 'erc20', chainId: chain, address: b.address,
            symbol: b.symbol, name: b.name, decimals: b.decimals,
            balanceRaw: b.raw, balance: b.amount,
          }
          : { kind: 'native', chainId: chain })}
      />
    </div>
  );
}
