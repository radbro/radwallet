/**
 * Picking the token to swap.
 *
 * This was a native <select>. That is fine for four options and unusable at
 * four hundred, which is what the bundled list became: no search, no icons, no
 * balances, no way to check what a symbol actually IS before selling into it.
 * Two tokens can share a symbol; only the contract tells them apart.
 *
 * So it is a sheet, with the same shape as the wallet drawer: solid black,
 * sticky header, one scrolling list, Esc and backdrop to close. Each row says
 * what it is (icon, symbol, name), what you hold of it, and links out to the
 * two places that can tell you the rest — the DEX chart and the block
 * explorer. Those are LINKS, not embeds: nothing is contacted until clicked.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  CHAINS, dexChartSupports, dexChartUrl, explorerTokenUrl,
  DEXCHART_HOST,
} from '@radwallet/core';
import { AssetIcon, EthIcon, LetterMark, useModalDialog } from '../bits.js';
import { RADCOIN } from '../assets.js';
import {
  completeAddressInput,
  fullContractQuery,
  shortContract,
  sideKeyOf,
  type PickItem,
} from './tokenpick-utils.js';
export {
  completeAddressInput,
  fullContractQuery,
  mergeEphemeralPickItems,
  shortContract,
  sideKeyOf,
  type PickItem,
} from './tokenpick-utils.js';

const RAD = '0xddc6625feca10438857dd8660c021cd1088806fb';

/**
 * A long list is only usable if you can narrow it, and only trustworthy if you
 * can search the thing that is unique. Symbols are not unique; addresses are.
 */
function matches(item: PickItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return item.symbol.toLowerCase().includes(needle)
    || (item.name ?? '').toLowerCase().includes(needle)
    || (item.address ?? '').toLowerCase().includes(needle);
}

/** rows rendered before the list asks you to narrow it instead */
const SHOWN = 60;

export function TokenPicker({
  title, chain, items, selected, lookupContract, onPick, onClose,
}: {
  title: string;
  chain: number;
  items: PickItem[];
  selected: string;
  lookupContract?: (address: `0x${string}`) => Promise<PickItem | null>;
  onPick: (item: PickItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [resolved, setResolved] = useState<{
    item: PickItem; chain: number; lookup: typeof lookupContract;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const lookupSeq = useRef(0);
  useModalDialog(box, onClose);

  const wantedContract = fullContractQuery(query);
  const invalidContract = completeAddressInput(query) && !wantedContract;
  const isKnown = items.some((i) => i.address?.toLowerCase() === wantedContract?.toLowerCase());
  const contract = resolved?.chain === chain && resolved.lookup === lookupContract
    && resolved.item.address?.toLowerCase() === wantedContract?.toLowerCase()
    ? resolved.item : null;
  const found = useMemo(
    () => (invalidContract ? [] : items.filter((i) => matches(i, query))),
    [items, query, invalidContract],
  );
  const contractKnown = contract
    ? found.some((i) => i.address?.toLowerCase() === contract.address?.toLowerCase())
    : false;
  const allFound = contract && !contractKnown ? [contract, ...found] : found;
  const shown = allFound.slice(0, SHOWN);
  const hidden = allFound.length - shown.length;
  const charts = dexChartSupports(chain);

  useEffect(() => {
    const seq = ++lookupSeq.current;
    let live = true;
    setResolved(null);
    setChecking(false);
    setContractError(null);

    const addr = wantedContract;
    if (!addr) {
      if (invalidContract) setContractError('invalid contract address or checksum');
      return () => { live = false; };
    }
    if (isKnown) {
      return () => { live = false; };
    }
    if (!lookupContract) return () => { live = false; };

    setChecking(true);
    lookupContract(addr)
      .then((item) => {
        if (!live || seq !== lookupSeq.current) return;
        if (!item) setContractError('that contract will not say what it is');
        else if (item.address?.toLowerCase() === addr.toLowerCase()) {
          setResolved({ item, chain, lookup: lookupContract });
        } else setContractError('the contract response did not match the address');
      })
      .catch((e) => {
        if (!live || seq !== lookupSeq.current) return;
        setContractError((e as Error).message.split('\n')[0]);
      })
      .finally(() => {
        if (live && seq === lookupSeq.current) setChecking(false);
      });
    return () => { live = false; };
  }, [chain, isKnown, lookupContract, wantedContract, invalidContract]);

  return (
    <div
      class="drawer"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).classList.contains('drawer')) onClose();
      }}
    >
      <div
        class="drawerbox" ref={box} role="dialog" aria-modal="true"
        aria-label={title} tabIndex={-1}
      >
        <div class="drawerhead">
          <h2 class="simhead">[ {title} ]</h2>
          <span class="count">{allFound.length}</span>
          <button class="x" title="close (esc)" onClick={onClose}>[X]</button>
        </div>

        <div class="drawerfilters">
          <input
            ref={field} class="field search" type="search" autofocus
            placeholder="symbol, name or contract address"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value.trim())}
          />
        </div>

        <div class="drawerbody">
          {checking && (
            <div class="note center">
              checking {query} on {CHAINS[chain]?.name ?? `chain ${chain}`}…
            </div>
          )}

          {contractError && !checking && (
            <div class="note red center">
              {contractError}
            </div>
          )}

          {allFound.length === 0 && !checking && !contractError && (
            <div class="note empty center">
              nothing here matches “{query}”.
            </div>
          )}

          {shown.map((item) => {
            const key = sideKeyOf(item);
            // native has no contract of its own, so its chart is the chain's
            // wrapped-native pool and it has no contract page to link at all
            const chartToken = item.address ?? CHAINS[chain]?.wrappedNative ?? null;
            const explorer = item.address ? explorerTokenUrl(chain, item.address) : null;
            return (
              <div class={`tokrow pickrow${key === selected ? ' sel' : ''}`} key={key}>
                <button
                  class="tokpick" title={`swap ${item.symbol}`}
                  onClick={() => { onPick(item); onClose(); }}
                >
                  <AssetIcon chainId={chain} badge={false}>
                    {!item.address
                      ? <EthIcon />
                      : item.address.toLowerCase() === RAD
                        ? <img src={RADCOIN} alt="" />
                        : <LetterMark symbol={item.symbol} seed={item.address} />}
                  </AssetIcon>
                  <span class="tokwho">
                    <span class="tokname">{item.symbol}</span>
                    <span class="toksym">
                      {item.name ?? (item.address ? 'token' : 'native')}
                      {item.address && <span class="dupaddr"> · {shortContract(item.address)}</span>}
                    </span>
                  </span>
                  {item.amount && <span class="amt">{item.amount}</span>}
                </button>
                <div class="toklinks">
                  {charts && chartToken && (
                    <a
                      class="exlink" target="_blank" rel="noreferrer"
                      href={dexChartUrl(chain, chartToken)}
                      title={`${item.symbol} on ${DEXCHART_HOST}`}
                    >chart ↗</a>
                  )}
                  {item.address && explorer
                    ? (
                      <a
                        class="exlink" target="_blank" rel="noreferrer"
                        href={explorer}
                        title={`${item.symbol} contract on ${new URL(explorer).host}`}
                      >explorer ↗</a>
                    )
                    : <span class="dim">{item.address ? 'no explorer configured' : 'native · no contract'}</span>}
                </div>
              </div>
            );
          })}

          {/* never a silent truncation: say what is not on screen and why */}
          {hidden > 0 && (
            <div class="note center">
              showing {shown.length} of {allFound.length} — type to narrow it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
