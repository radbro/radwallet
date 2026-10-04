/**
 * SETTINGS — an index of rows, each opening one thing.
 *
 * Keep third-party data settings together so each opt-in is easy to find and
 * its disclosure stays beside the control.
 */
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import {
  prefs, pool, updatePoolFor, poolFor, persistPrefs, rotateNow, addCustomNetwork, removeCustomNetwork, customNetworks,
  accounts, chainId, say, DEMO, refresh, sayError, endpoint, poolsAll, nfts,
  bioSealed, bioReady, enableBiometrics, disableBiometrics, updateAutoLock,
} from '../state.js';
import { IS_NATIVE } from '../native.js';
import {
  CHAINS, CHAIN_IDS, INDEXER_PROVIDERS, providerInfo, DEXCHART_HOST,
  normalizeEndpoint, probeChainId, coverage, entryUsable, blockscoutUrl,
  alchemyNftUrl, alchemyRpcUrl, moralisUrl, chartUrl, priceFeedSupports,
  DEFAULT_GATEWAY, toLoadableUrl, KYBER_HOST,
  type IndexerProvider,
} from '@radwallet/core';
import { session, SESSION_IS_REMOTE } from '../session.js';
import { AddressBookSettings } from '../addressbook-ui.js';
import { store as extStore, HAS_PROXY_API, isTorOn, setTorPac, clearTorPac } from '../ext.js';

type Section = 'security' | 'networks' | 'leaks' | 'sites' | 'addresses' | 'display' | 'about';

const SECTIONS: { id: Section; title: string; hint: string }[] = [
  { id: 'security', title: 'SECURITY', hint: 'auto-lock, simulation, biometrics' },
  { id: 'networks', title: 'NETWORKS', hint: 'RPC pool, your own node, testnets, Tor' },
  { id: 'leaks', title: 'PRIVACY', hint: 'asset discovery, charts, swap quotes, NFT artwork' },
  { id: 'sites', title: 'CONNECTED SITES', hint: 'manage wallet connections' },
  { id: 'addresses', title: 'ADDRESS BOOK', hint: 'saved addresses and your wallets' },
  { id: 'display', title: 'DISPLAY', hint: 'text size' },
  { id: 'about', title: 'ABOUT', hint: 'wallet details, version, source code' },
];

/**
 * Firefox will not let an extension touch proxy.settings unless that extension
 * is allowed to run in private windows — the proxy is global, so it would
 * otherwise affect private browsing from outside it. It is a one-time,
 * user-granted toggle and no permission we can declare, so the honest thing is
 * to name the switch instead of forwarding "requires private browsing
 * permission" and leaving the user to guess.
 */
function explainProxyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/private browsing/i.test(msg)) {
    return 'Firefox needs RADWALLET allowed in private windows to change the proxy: '
      + 'about:addons → RADWALLET → Run in Private Windows: Allow. Then try again.';
  }
  return `browser refused the proxy change: ${msg}`;
}

/** show enough of a key to tell two apart, never the whole thing */
function mask(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function addHost(out: Set<string>, raw: string): void {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    out.add(u.host.toLowerCase());
  } catch { /* not a URL */ }
}

function torHosts(): { hosts: string[]; mediaIsDataDependent: boolean } {
  const hosts = new Set<string>();
  let mediaIsDataDependent = false;
  for (const p of Object.values(poolsAll.value)) {
    for (const ep of p.endpoints) addHost(hosts, ep);
  }

  const pref = prefs.value;
  if (pref.aggregator?.enabled) hosts.add(KYBER_HOST);
  if (pref.indexer.enabled) {
    for (const entry of pref.indexer.entries) {
      for (const id of CHAIN_IDS) {
        if (!entryUsable(entry, id)) continue;
        try {
          if (entry.provider === 'blockscout') addHost(hosts, blockscoutUrl(id, ZERO_ADDRESS));
          if (entry.provider === 'alchemy') {
            addHost(hosts, alchemyNftUrl(entry.key, id, ZERO_ADDRESS));
            addHost(hosts, alchemyRpcUrl(entry.key, id));
          }
          if (entry.provider === 'moralis') {
            addHost(hosts, moralisUrl(id, ZERO_ADDRESS, 'erc20'));
            addHost(hosts, moralisUrl(id, ZERO_ADDRESS, 'nft'));
          }
        } catch { /* provider is not usable on this chain */ }
      }
    }
  }

  if (pref.priceFeed?.enabled) {
    for (const id of CHAIN_IDS) {
      if (!priceFeedSupports(id)) continue;
      try { addHost(hosts, chartUrl(id, ZERO_ADDRESS, 7)); } catch { /* unsupported */ }
    }
  }
  if (pref.dexChart?.enabled) addHost(hosts, `https://${DEXCHART_HOST}/`);

  if (pref.loadArt) {
    addHost(hosts, DEFAULT_GATEWAY);
    for (const holding of nfts.value) {
      for (const uri of Object.values(holding.tokenUris)) {
        const url = toLoadableUrl(uri);
        if (url) addHost(hosts, url);
        if (!url || /^https?:\/\//i.test(url)) mediaIsDataDependent = true;
      }
    }
  }

  return { hosts: [...hosts].sort(), mediaIsDataDependent };
}

function torPac(hosts: string[]): string {
  return `function FindProxyForURL(url, host) {
  var targets = ${JSON.stringify(hosts)};
  var m = String(url || "").match(/^[a-z]+:\\/\\/([^\\/]+)/i);
  var urlHost = (m ? m[1].split("@").pop() : String(host || "")).toLowerCase();
  for (var i = 0; i < targets.length; i++) if (urlHost === targets[i]) return "SOCKS5 127.0.0.1:9050";
  return "DIRECT";
}`;
}

export function Settings() {
  const [section, setSection] = useState<Section | null>(null);
  const [newEp, setNewEp] = useState('');
  const [customName, setCustomName] = useState('');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [customSymbol, setCustomSymbol] = useState('ETH');
  const [customTestnet, setCustomTestnet] = useState(true);
  const [armBio, setArmBio] = useState(false);
  const [bioPw, setBioPw] = useState('');
  const [connections, setConnections] = useState<Record<string, string[]>>({});
  const [newProv, setNewProv] = useState<IndexerProvider>('blockscout');
  const [newKey, setNewKey] = useState('');
  // the pool panel edits ANY chain, not just the one the wallet is switched to
  const [poolChain, setPoolChain] = useState(chainId.value);
  const newInfo = providerInfo(newProv);
  const editing = poolFor(poolChain);
  const [adding, setAdding] = useState(false);
  const [addingNetwork, setAddingNetwork] = useState(false);
  const [lockInput, setLockInput] = useState(String(prefs.value.autoLockMin));
  const [savingLock, setSavingLock] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const lockMinutes = Number(lockInput);
  const validLock = /^\d+$/.test(lockInput) && Number.isInteger(lockMinutes)
    && lockMinutes >= 1 && lockMinutes <= 240;

  async function saveAutoLock() {
    if (!validLock || savingLock) return;
    setSavingLock(true);
    try {
      await updateAutoLock(lockMinutes);
      say(`Auto-lock timer restarted: ${lockMinutes} minute${lockMinutes === 1 ? '' : 's'}.`);
    } catch (e) { sayError(e); }
    finally { setSavingLock(false); }
  }

  // Each settings section is its own view. Opening one from the bottom of the
  // index must not strand its heading above the viewport.
  useLayoutEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    document.scrollingElement?.scrollTo({ top: 0, left: 0 });
    setLockInput(String(prefs.value.autoLockMin));
  }, [section]);

  /**
   * Add an endpoint to the chosen chain's pool — after ASKING it what it is.
   *
   * Two ways a bring-your-own node goes wrong quietly: plaintext http to a
   * remote host (everything you look up, in the clear), and a perfectly good
   * node for the WRONG chain (right-looking wallet, wrong balances, and a
   * transaction signed against them). The first is refused outright, the second
   * is refused by `eth_chainId`. Both explain themselves on failure rather
   * than lecturing on arrival.
   */
  async function addEndpoint() {
    const ep = normalizeEndpoint(newEp);
    if (!ep) {
      say(/^http:\/\//i.test(newEp.trim())
        ? 'plain http only to your own machine — localhost or 127.0.0.1. anything else, https://'
        : 'enter an HTTPS RPC URL, or an HTTP URL on localhost');
      return;
    }
    if (editing.endpoints.includes(ep)) { say('already in the pool'); return; }
    const want = CHAINS[poolChain];
    if (!DEMO) {
      setAdding(true);
      const got = await probeChainId(ep);
      setAdding(false);
      if (got === null) { say(`no answer from ${ep} — is it running?`); return; }
      if (got !== poolChain) {
        const named = CHAINS[got]?.name;
        say(`that node is on chain ${got}${named ? ` (${named})` : ''}, not ${want.name}`);
        return;
      }
    }
    updatePoolFor(poolChain, { ...editing, endpoints: [...editing.endpoints, ep] });
    setNewEp('');
    say(`${ep} added to ${want.name}`);
  }

  /**
   * A custom network is a wallet-owned endpoint plus the chain id it reports.
   * Never accept an id or RPC URL from a dapp here: a site-controlled node can
   * observe every future request and return fabricated chain data.
   */
  async function addNetwork() {
    if (DEMO) { say('custom networks need the wallet build, not the offline demo'); return; }
    const name = customName.trim();
    const symbol = customSymbol.trim().toUpperCase();
    const ep = normalizeEndpoint(customEndpoint);
    if (!name) { say('give this network a name'); return; }
    if (!/^[A-Z0-9$_.-]{1,16}$/.test(symbol)) { say('native symbol: 1–16 letters, numbers, $, _, . or -'); return; }
    if (!ep) {
      say(/^http:\/\//i.test(customEndpoint.trim())
        ? 'plain http only to your own machine — localhost or 127.0.0.1. anything else, https://'
        : 'enter an HTTPS RPC URL, or an HTTP URL on localhost');
      return;
    }
    setAddingNetwork(true);
    try {
      const id = await probeChainId(ep);
      if (id === null) { say(`no answer from ${ep} — is it running?`); return; }
      const network = await addCustomNetwork({
        id, name, nativeSymbol: symbol, endpoint: ep, testnet: customTestnet,
      });
      setPoolChain(network.id);
      setCustomName('');
      setCustomEndpoint('');
      setCustomSymbol('ETH');
      setCustomTestnet(true);
    } catch (e) { sayError(e); }
    finally { setAddingNetwork(false); }
  }

  useEffect(() => {
    if (!SESSION_IS_REMOTE) return;
    void extStore.get<string>('connections').then((raw) => {
      try { setConnections(raw ? JSON.parse(raw) : {}); } catch { /* empty */ }
    });
  }, []);

  const [torOn, setTorOn] = useState(false);
  useEffect(() => {
    if (!SESSION_IS_REMOTE || !HAS_PROXY_API) return;
    void isTorOn().then(setTorOn).catch(() => { /* proxy locked down; leave off */ });
  }, []);

  function toggleTor() {
    if (!SESSION_IS_REMOTE) { say('Tor routing needs the extension build'); return; }
    if (!HAS_PROXY_API) {
      // Firefox for Android has no proxy API. Say so instead of lying.
      say('this browser gives extensions no proxy API — route at the OS level instead');
      return;
    }
    if (torOn) {
      void clearTorPac()
        .then(() => { setTorOn(false); say('RADWALLET Tor routing turned off.'); })
        .catch((e) => say(explainProxyError(e)));
      return;
    }
    const targets = torHosts();
    const pac = torPac(targets.hosts);
    void setTorPac(pac)
      .then(() => {
        setTorOn(true);
        say(`Tor routing enabled for ${targets.hosts.length} host${targets.hosts.length === 1 ? '' : 's'}. Tor must be running at 127.0.0.1:9050 for those requests to connect.`);
      })
      .catch((e) => say(explainProxyError(e)));
  }

  async function revoke(origin: string) {
    if (revoking) return;
    setRevoking(origin);
    try {
      setConnections(await session.setConnection(origin, []));
      say(`${origin} disconnected.`);
    } catch (e) { sayError(e); }
    finally { setRevoking(null); }
  }
  const p = prefs.value;
  const cov = accounts.value.length
    ? coverage(pool.value, accounts.value.map((a) => a.address))
    : 0;
  const host = (() => { try { return new URL(endpoint.value).host; } catch { return endpoint.value; } })();

  function setFeed(next: typeof p.priceFeed) {
    prefs.value = { ...p, priceFeed: next };
    void persistPrefs();
  }

  function setIndexer(next: typeof p.indexer) {
    prefs.value = { ...p, indexer: next };
    void persistPrefs();
  }

  function toggle(key: 'testnets' | 'loadArt') {
    prefs.value = { ...p, [key]: !p[key] };
    void persistPrefs();
    // turning testnets on changes which chains get swept, and nobody should
    // have to find the refresh button to see the switch take effect
    if (key === 'testnets') void refresh();
  }

  /** Count every persistent opt-in, including artwork enabled from an NFT. */
  const leaksOn = [p.indexer.enabled, p.priceFeed?.enabled === true, p.dexChart?.enabled === true,
    p.loadArt === true, p.aggregator?.enabled === true]
    .filter(Boolean).length;
  const torTargets = torHosts();

  function hintFor(s: Section): string {
    if (s === 'leaks') {
      return leaksOn === 0 ? 'all 5 optional features off' : `${leaksOn} of 5 optional features on`;
    }
    if (s === 'sites') {
      const n = Object.keys(connections).length;
      return !SESSION_IS_REMOTE ? 'available in the browser extension' : n === 0 ? 'no sites connected' : `${n} site${n === 1 ? '' : 's'}`;
    }
    if (s === 'security') return `auto-lock after ${p.autoLockMin} minute${p.autoLockMin === 1 ? '' : 's'}`;
    if (s === 'networks') return DEMO ? 'demo mode — no node' : host;
    if (s === 'display') return `text at ${Math.round((p.uiScale ?? 1) * 100)}%`;
    return SECTIONS.find((x) => x.id === s)!.hint;
  }

  // ---- the index -----------------------------------------------------------
  if (section === null) {
    return (
      <div class="content">
        <h1 class="simhead">SETTINGS</h1>

        <div class="setlist">
          {SECTIONS.map((s) => (
            <button class="setrowlink" key={s.id} onClick={() => setSection(s.id)}>
              <span class="sl">
                <span class="slt">{s.title}</span>
                <span class="slh">{hintFor(s.id)}</span>
              </span>
              <span class="go" aria-hidden="true">›</span>
            </button>
          ))}
        </div>

        <div class="obey" style={{ fontSize: 15 }}>WE CAN'T SEE YOU.<br />THAT'S THE POINT.</div>
      </div>
    );
  }

  const title = SECTIONS.find((s) => s.id === section)!.title;
  return (
    <div class="content">
      {/*
        A section is a sub-view of the SETTINGS tab, so it gets a way back to
        the index — that is not the second navigation control a tab-bar screen
        must not have, it is the only one this level has.
      */}
      <button class="sectback" onClick={() => setSection(null)}>‹ ALL SETTINGS</button>
      <h1 class="simhead">{title}</h1>

      {section === 'addresses' && <AddressBookSettings />}

      {section === 'security' && (
        <div class="panel">
          <div class="hd">KEYS AND SIGNING</div>
          <div class="setrow">
            <span>Auto-lock after</span>
            <input
              class="field num" value={lockInput} disabled={savingLock}
              inputMode="numeric" aria-label="auto-lock minutes"
              onInput={(e) => setLockInput(e.currentTarget.value)}
            />
            <span>minutes</span>
            <button class="act" disabled={!validLock || savingLock} onClick={() => void saveAutoLock()}>
              {savingLock ? 'APPLYING…' : 'APPLY'}
            </button>
            <span class="dim">Choose 1–240 whole minutes. APPLY restarts the timer now.
              Signing, wallet edits and stealth scans also restart it.</span>
          </div>
          <div class="fact">
            <span class="tick">✓</span>
            <span>Transaction simulation is required before signing.
              <span class="dim"> Previews use your configured RPC nodes.</span>
            </span>
          </div>
          {/*
            Biometric unlock is a SECOND credential on the same wallet, so the
            copy has to say what it costs rather than sell the convenience. Off
            until asked for, and on a phone that cannot do it the row says which
            reason rather than sitting there dead.
          */}
          {IS_NATIVE && (
            <label class="row">
              <input
                type="checkbox" checked={!!bioSealed.value} disabled={!bioReady.value.available}
                onChange={() => {
                  if (bioSealed.value) { void disableBiometrics().catch(sayError); setBioPw(''); setArmBio(false); }
                  else setArmBio(true);
                }}
              />
              <span>Unlock with biometrics
                <span class="dim"> — your password is sealed in this phone's keystore behind your
                fingerprint or face. The wallet becomes as strong as the weakest one enrolled on the
                phone. Adding a new fingerprint switches this off and the password still works.
                {bioReady.value.available ? '' : ` ${bioReady.value.reason}.`}</span></span>
            </label>
          )}
          {armBio && !bioSealed.value && (
            <div class="armed">
              <div class="what">Enter your wallet password to enable biometric unlock.</div>
              <form class="pwform" onSubmit={(e) => {
                e.preventDefault();
                void enableBiometrics(bioPw)
                  .then(() => { setArmBio(false); setBioPw(''); say('biometric unlock is on.'); })
                  .catch(sayError);
              }}>
                <input
                  class="field" type="password" name="password" autocomplete="current-password"
                  placeholder="password" value={bioPw}
                  onInput={(e) => setBioPw((e.target as HTMLInputElement).value)} />
                <div class="btnrow">
                  <button class="btn" type="submit">TURN IT ON</button>
                  <button class="btn ghost" type="button" onClick={() => { setArmBio(false); setBioPw(''); }}>CANCEL</button>
                </div>
              </form>
            </div>
          )}
          <div class="note">
            To back up a seed phrase or private key, open the wallet list from HOME
            and choose BACK UP SEED PHRASES &amp; KEYS.
          </div>
        </div>
      )}

      {section === 'networks' && (
        <>
          <div class="panel">
            <div class="hd">ADD CUSTOM NETWORK</div>
            <div class="note">
              RADWALLET asks this URL for its chain ID before saving anything. It never takes an RPC URL from a website.
              A new network is treated as test/development money until you deliberately change that below.
            </div>
            <input class="field" aria-label="custom network name" placeholder="name — e.g. Local Anvil"
              value={customName} onInput={(e) => setCustomName((e.target as HTMLInputElement).value)} />
            <input class="field" aria-label="custom network RPC URL" placeholder="http://127.0.0.1:8545"
              value={customEndpoint} onInput={(e) => setCustomEndpoint((e.target as HTMLInputElement).value.trim())} />
            <input class="field" aria-label="custom network native symbol" placeholder="native symbol" maxLength={16}
              value={customSymbol} onInput={(e) => setCustomSymbol((e.target as HTMLInputElement).value)} />
            <label class="row">
              <input type="checkbox" checked={customTestnet} onChange={() => setCustomTestnet(!customTestnet)} />
              <span>Test/development network
                <span class="dim"> — balances stay out of portfolio totals. Scan testnets checks every test network; adding a contract by address checks just that owner-selected chain.</span></span>
            </label>
            <div class="btnrow">
              <button class="btn" disabled={addingNetwork} onClick={addNetwork}>
                {addingNetwork ? 'CHECKING…' : 'ADD NETWORK'}
              </button>
            </div>
            {customNetworks.value.map((network) => (
              <div class="rpcrow" key={network.id}>
                <span class="n">{network.id}</span>
                <span class="ep">{network.name} · {network.endpoint}</span>
                <button
                  class="drop" title={`remove ${network.name}`} aria-label={`remove ${network.name}`}
                  onClick={() => void removeCustomNetwork(network.id).then(() => {
                    if (poolChain === network.id) setPoolChain(1);
                  }).catch(sayError)}
                >×</button>
              </div>
            ))}
          </div>

          <div class="panel">
            <div class="hd">
              <span>RPC POOL</span>
              {/* every chain has its own pool; this panel used to silently follow
                  the network selector, which made the other chains' endpoints look
                  like they did not exist */}
              <select
                class="netsel wide" value={String(poolChain)}
                aria-label="which chain's endpoints"
                onChange={(e) => setPoolChain(Number((e.target as HTMLSelectElement).value))}
              >
                {CHAIN_IDS.map((id) => (
                  <option key={id} value={String(id)}>{CHAINS[id].name.toUpperCase()}</option>
                ))}
              </select>
            </div>
            {editing.endpoints.map((ep, i) => (
              <div class="rpcrow" key={ep}>
                <span class="n">{i + 1}</span>
                <span class="ep">{ep}</span>
                <button
                  class="drop" title={`remove ${ep}`} aria-label={`remove ${ep}`}
                  onClick={() => {
                    if (editing.endpoints.length <= 1) { say('keep at least one endpoint, bro'); return; }
                    updatePoolFor(poolChain, {
                      ...editing, endpoints: editing.endpoints.filter((x) => x !== ep),
                    });
                  }}
                >×</button>
              </div>
            ))}
            <input class="field" placeholder="https://your.own.node — or http://localhost:8545" value={newEp}
              onInput={(e) => setNewEp((e.target as HTMLInputElement).value.trim())} />
            <div class="btnrow">
              <button class="btn ghost" disabled={adding} onClick={addEndpoint}>
                {adding ? 'CHECKING…' : 'ADD'}
              </button>
              <button class="btn" onClick={rotateNow} disabled={poolChain !== chainId.value}
                title={poolChain === chainId.value
                  ? 'move each wallet to the next RPC endpoint on this network'
                  : `switch to ${CHAINS[poolChain].name} to change its RPC assignments`}
              >ROTATE NOW</button>
            </div>
            {/*
              Which node is serving THIS wallet. Accounts are pinned to an
              endpoint by address hash, so the answer differs per wallet — which
              is the point, and it is a network fact, not home-screen furniture.
            */}
            <div class="privline">
              <span class="ic" aria-hidden="true">⬡</span> {DEMO ? 'none (demo)' : host}
              <span class="dim"> — assigned to this wallet on {CHAINS[chainId.value].name}</span>
            </div>
          </div>

          <div class="panel">
            <div class="hd">HOW THEY ARE USED</div>
            <div class="note">
              Each wallet is assigned an RPC endpoint from this network's list.
              Wallets can share an endpoint; failed requests may use another.
              With multiple endpoints, ROTATE NOW moves each wallet to the next one on the selected network.
            </div>
            <label class="row">
              <input type="checkbox" checked={p.testnets} onChange={() => toggle('testnets')} />
              <span>Scan testnets
                <span class="dim"> — includes Sepolia, Base Sepolia and Robinhood Testnet in balance scans.
                Testnet balances are shown separately and excluded from portfolio totals.
                Their RPC providers receive your wallet address.</span></span>
            </label>
            <label class="row">
              <input
                type="checkbox" checked={torOn}
                disabled={!SESSION_IS_REMOTE || !HAS_PROXY_API} onChange={toggleTor}
              />
              <span>Tor/SOCKS routing
                <span class="dim"> — {torTargets.hosts.length} current wallet host{torTargets.hosts.length === 1 ? '' : 's'},
                via Tor running on your computer at 127.0.0.1:9050.
                Applies to browser requests to these hosts. After changing providers or endpoints,
                turn this off and on to update the host list.
                {SESSION_IS_REMOTE ? (HAS_PROXY_API ? '' : ' this browser gives extensions no proxy API.') : ' extension only.'}
                {torTargets.mediaIsDataDependent ? ' NFT artwork may load from additional hosts outside this list.' : ''}
                </span></span>
            </label>
          </div>
        </>
      )}

      {/* All persistent third-party opt-ins, with their disclosures. */}
      {section === 'leaks' && (
        <>
          <div class="note">
            RPC providers receive your wallet addresses and requests. These optional
            features contact additional services. Charts and artwork can also be loaded
            once from an asset's page without enabling automatic loading.
          </div>

          <div class="indexerbox">
            <label class="row">
              <input
                type="checkbox" checked={p.indexer.enabled}
                onChange={() => setIndexer({ ...p.indexer, enabled: !p.indexer.enabled })}
              />
              <span>Find more tokens and NFTs with an indexer
                <span class="dim"> — checks supported networks for assets beyond your token list.</span>
              </span>
            </label>
            <div class={`leak${p.indexer.enabled ? ' on' : ''}`}>
              <b>WHAT IS SHARED.</b> Providers receive <b class="white">the wallet addresses
              being scanned</b> and the IP used to connect. They can retain those requests
              and link addresses to a profile. Discovered balances are checked through
              your RPC nodes. An indexer may miss assets.
            </div>
            {p.indexer.enabled && (
              <>
                {p.indexer.entries.map((e, i) => {
                  const info = providerInfo(e.provider);
                  return (
                    <div class="rpcrow" key={`${e.provider}-${i}`}>
                      <span class="n">{i + 1}</span>
                      <span class="ep">
                        {info?.name ?? e.provider}
                        <span class="dim"> · {info?.host}
                          {info?.needsKey ? ` · key ${mask(e.key)}` : ' · no key'}</span>
                      </span>
                      <button
                        class="drop" title={`remove ${info?.name ?? e.provider}`}
                        aria-label={`remove ${info?.name ?? e.provider}`}
                        onClick={() => setIndexer({
                          ...p.indexer,
                          entries: p.indexer.entries.filter((_, j) => j !== i),
                        })}
                      >×</button>
                    </div>
                  );
                })}
                {p.indexer.entries.length === 0 && (
                  <div class="note">No provider configured. Add one to enable discovery.</div>
                )}

                <div class="addrow">
                  <select
                    class="netsel wide" value={newProv}
                    onChange={(e) => setNewProv((e.target as HTMLSelectElement).value as IndexerProvider)}
                  >
                    {INDEXER_PROVIDERS.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name}{pr.needsKey ? '' : ' (no key)'}
                      </option>
                    ))}
                  </select>
                  {newInfo?.needsKey && (
                    <input
                      class="field" placeholder="provider API key"
                      value={newKey}
                      onInput={(e) => setNewKey((e.target as HTMLInputElement).value.trim())}
                    />
                  )}
                </div>
                <div class="note">
                  {newInfo?.note}{newInfo?.needsKey ? ` Key from ${newInfo.keyFrom}.` : ''}
                </div>
                <div class="btnrow">
                  <button class="btn ghost" onClick={() => {
                    if (newInfo?.needsKey && !newKey) { say('enter an API key for this provider'); return; }
                    setIndexer({
                      ...p.indexer,
                      entries: [...p.indexer.entries, { provider: newProv, key: newInfo?.needsKey ? newKey : '' }],
                    });
                    setNewKey('');
                  }}>ADD PROVIDER</button>
                </div>

                <div class="note">
                  {p.indexer.entries.length > 1
                    ? `Rotated per request across ${p.indexer.entries.length} providers, `
                      + 'where their network coverage overlaps.'
                    : 'Add another provider to alternate requests where their network coverage overlaps.'}
                  {' '}Rotation does not prevent providers from linking your addresses.
                  Turning this off disables discovery on future refreshes. An in-progress scan may finish.
                </div>
              </>
            )}
          </div>

          <div class="indexerbox">
            <label class="row">
              <input
                type="checkbox" checked={p.priceFeed?.enabled === true}
                onChange={() => setFeed({ ...p.priceFeed, enabled: !p.priceFeed?.enabled })}
              />
              <span>Price history from CoinGecko
                <span class="dim"> — historical price charts on supported networks.</span>
              </span>
            </label>
            <div class={`leak${p.priceFeed?.enabled ? ' on' : ''}`}>
              <b>WHAT IS SHARED.</b> CoinGecko receives <b class="white">the token you look at</b>,
              when you request its chart, and the IP used to connect. Requests do not include
              your wallet address. Current prices still come from pools through your RPC nodes.
            </div>
          </div>

          <div class="indexerbox">
            <label class="row">
              <input
                type="checkbox" checked={p.dexChart?.enabled === true}
                onChange={() => {
                  prefs.value = { ...p, dexChart: { enabled: !p.dexChart?.enabled } };
                  void persistPrefs();
                }}
              />
              <span>Always load the embedded DEX chart
                <span class="dim"> — otherwise each asset asks first.</span>
              </span>
            </label>
            <div class={`leak${p.dexChart?.enabled ? ' on' : ''}`}>
              <b>WHAT IS SHARED.</b> {DEXCHART_HOST} receives the token you view and the IP
              used to connect. Its embedded page can use cookies and browser fingerprinting
              while the chart is open.
            </div>
          </div>

          <div class="indexerbox">
            <label class="row">
              <input type="checkbox" checked={p.aggregator?.enabled === true}
                onChange={() => {
                  prefs.value = { ...p, aggregator: { enabled: !p.aggregator?.enabled } };
                  void persistPrefs();
                }} />
              <span>Compare swaps with KyberSwap
                <span class="dim"> — Ethereum and Robinhood, 0% platform fee.</span>
              </span>
            </label>
            <div class={`leak${p.aggregator?.enabled ? ' on' : ''}`}>
              <b>WHAT IS SHARED.</b> {KYBER_HOST} receives the pair, amount, wallet address
              and IP used to connect. Quotes are compared with direct routes; the higher
              quoted output is selected. Gas and pool fees still apply.
            </div>
          </div>

          <div class="indexerbox">
            <label class="row">
              <input type="checkbox" checked={p.loadArt === true} onChange={() => toggle('loadArt')} />
              <span>Always load NFT artwork
                <span class="dim"> — otherwise each collection asks first.</span>
              </span>
            </label>
            <div class={`leak${p.loadArt ? ' on' : ''}`}>
              <b>WHAT IS SHARED.</b> NFT metadata and image hosts receive the files you
              request and the IP used to connect. Hosts vary by collection. Turning this
              off makes collections ask before loading artwork the next time you open them.
            </div>
          </div>
        </>
      )}

      {section === 'sites' && (
        <div class="panel">
          <div class="hd">CONNECTED SITES</div>
          {!SESSION_IS_REMOTE && (
            <div class="note">Website connections are available in the browser extension.</div>
          )}
          {SESSION_IS_REMOTE && Object.keys(connections).length === 0 && (
            <div class="note">No sites connected.</div>
          )}
          {SESSION_IS_REMOTE && Object.keys(connections).length > 0 && (
            <div class="note">Disconnecting stops wallet access. Sites may retain addresses
              already shared and can still read their public transaction history.</div>
          )}
          {Object.entries(connections).map(([origin, addrs]) => (
            <div class="rpcrow" key={origin}>
              <span class="ep">{origin}</span>
              <span class="dim">{addrs.length} wallet{addrs.length === 1 ? '' : 's'}</span>
              <button class="act danger" disabled={revoking !== null} onClick={() => void revoke(origin)}>
                {revoking === origin ? 'disconnecting…' : 'disconnect'}
              </button>
            </div>
          ))}
        </div>
      )}

      {section === 'display' && (
        <div class="panel">
          <div class="hd">DISPLAY</div>
          {/*
            Type size is a preference, not a design decision someone else gets to
            make for you. It scales the whole UI rather than only the text,
            because bigger type inside fixed boxes just moves the problem.
          */}
          <div class="setrow scalerow">
            <span>Text size</span>
            <input
              class="slider" type="range" min="90" max="180" step="5"
              value={String(Math.round((p.uiScale ?? 1) * 100))}
              aria-label="text size"
              onInput={(e) => {
                const v = Number((e.target as HTMLInputElement).value) / 100;
                prefs.value = { ...p, uiScale: v };
              }}
              onChange={() => void persistPrefs()}
            />
            <span class="scaleval">{Math.round((p.uiScale ?? 1) * 100)}%</span>
            {(p.uiScale ?? 1) !== 1 && (
              <button
                class="act"
                onClick={() => { prefs.value = { ...p, uiScale: 1 }; void persistPrefs(); }}
              >reset</button>
            )}
          </div>
        </div>
      )}

      {section === 'about' && (
        <>
          <div class="panel">
            <div class="hd">WALLET DETAILS</div>
            <div class="fact">
              <span class="tick">✓</span>
              <span>Telemetry: <b class="white">NONE</b>
                <span class="dim"> — there is no server to send it to.</span>
              </span>
            </div>
            <div class="fact">
              <span class="tick">✓</span>
              <span>RADWALLET swap fee: <b class="white">0%</b>
                <span class="dim"> — network fees and pool or curve fees still apply.</span>
              </span>
            </div>
            <div class="fact">
              <span class="tick">✓</span>
              <span>Stealth receiving (ERC-5564): <b class="white">SEED WALLETS ONLY</b>
                <span class="dim"> — copy your stealth address from RECEIVE and check for
                payments in ACTIVITY. Regular payments still use your public wallet address.</span>
              </span>
            </div>
            <div class="fact">
              <span class="tick">✓</span>
              <span>Keys: <b class="white">ON THIS DEVICE ONLY</b>
                <span class="dim"> — sealed with AES-256-GCM, PBKDF2 at 600k rounds.</span>
              </span>
            </div>
          </div>

          <div class="panel">
            <div class="hd">VERSION AND NETWORK</div>
            <table class="feetable">
              <tr><td>RPC endpoints assigned on {CHAINS[chainId.value].name}</td>
                <td>{DEMO ? '0 (demo)' : `${cov} of ${pool.value.endpoints.length}`}</td></tr>
              <tr><td>version</td><td class="white">v{__APP_VERSION__}</td></tr>
              <tr><td>source code</td><td class="white"><a href="https://github.com/radbro/radwallet"
                target="_blank" rel="noreferrer">GitHub ↗</a></td></tr>
            </table>
            <div class="note">RPC assignments are not a request log. Failover can contact other endpoints.</div>
          </div>
        </>
      )}
    </div>
  );
}
