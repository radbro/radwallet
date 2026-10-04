/**
 * RADSWAP — any pair the chain will quote, not just the house one.
 *
 * SWAP appears on every asset row, so it has to work on every asset row. The
 * general path (`swapany.ts`) quotes a single-hop v3 pool across fee tiers and
 * builds the swap; ERC-20 inputs get an approval step first, for the exact
 * amount rather than an unlimited one — this wallet rewrites unlimited
 * approvals when a dapp asks for one, so it is not about to sign one itself.
 *
 * ETH→$RAD on mainnet keeps its own path: `bestEthToRadRoute` races v3 against
 * v4 and picks the better fill. That is the house pair and the reason RADSWAP
 * exists, so it keeps the better engine.
 *
 * On Robinhood the search also asks the PONS CURVE (`ponsswap.ts`): a launch
 * that has not graduated has no pool, its curve is the market, and the quote
 * comes back with the curve's fee, creator tax and — in the first seconds —
 * the launch tax, each named on the route row. The signing wallet is passed
 * into the quote because that launch tax is charged PER RECIPIENT.
 *
 * Still no fee address, on any pair. Uniswap takes its pool fee, a curve takes
 * its own; we take zero.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatUnits } from 'viem';
import {
  screen, account, endpointForChain, endpointsForChain, chainId, setChain, say, scheduleBalanceRefresh,
  DEMO, sayError, visibleBalances, swapIntent, CHAINS, customTokens,
  prefs, persistPrefs,
} from '../state.js';
import { recordTx } from '../history.js';
import { session } from '../session.js';
import {
  bestEthToRadRouteAcross, quoteSwap, canSwapOn,
  chainInfo, TOKENS, CHAIN_IDS, describeRoute, withFailover, planSwap,
  chainClient, mergeTrackedTokens, probeToken,
  type SwapPlan, type SwapStep,
  quoteKyberSwap, buildKyberSwap, kyberAllowanceFor, validateKyberSwapTx,
  canUseKyberSwap, buildKyberApproveTx, KYBER_HOST, type KyberRouteQuote, type KyberBuiltSwap,
  parseTokenAmount, formatTokenAmount, buildBestRouteTx, previewDappTx,
  type RouteComparison, type AnyQuote, type SwapSide,
} from '@radwallet/core';
import { RADCOIN } from '../assets.js';
import { AssetIcon, EthIcon, LetterMark, TxLink } from '../bits.js';
import { TokenPicker, mergeEphemeralPickItems, type PickItem } from './tokenpick.js';

const RAD = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB'.toLowerCase();

function sideKey(s: SwapSide): string {
  return s.address ? s.address.toLowerCase() : 'native';
}

function Icon({ side, chain }: { side: SwapSide; chain: number }) {
  return (
    <AssetIcon chainId={chain} badge={false}>
      {!side.address
        ? <EthIcon />
        : side.address.toLowerCase() === RAD
          ? <img src={RADCOIN} alt="" />
          : <LetterMark symbol={side.symbol} seed={side.address} />}
    </AssetIcon>
  );
}

/**
 * A percentage of a balance, in the token's own units and without going near a
 * float: 100% has to be the EXACT balance or the swap reverts for one wei, and
 * `Number(formatUnits(...)) * 0.25` quietly rounds a 18-decimal number.
 */
function fractionOf(raw: bigint, pct: number, decimals: number): string {
  const part = pct >= 100 ? raw : (raw * BigInt(pct)) / 100n;
  return formatUnits(part, decimals);
}

export function Swap() {
  const acct = account.value;
  const accountKey = acct ? `${acct.index}:${acct.address.toLowerCase()}` : 'locked';
  const chain = chainId.value;
  const swappable = canSwapOn(chain);
  const [pastedTokens, setPastedTokens] = useState<{
    accountKey: string; chains: Record<number, PickItem[]>;
  }>({ accountKey, chains: {} });
  const pastedOnChain = pastedTokens.accountKey === accountKey ? pastedTokens.chains[chain] ?? [] : [];

  // everything you hold on this chain can be sold; everything bundled can be bought
  const heldBase: PickItem[] = visibleBalances.value
    .filter((b) => (b.chainId ?? 1) === chain)
    .map((b) => ({
      address: b.address ?? null, symbol: b.symbol, decimals: b.decimals,
      name: b.name, amount: b.amount, raw: b.raw,
    }));
  const native: PickItem = {
    address: null, symbol: chainInfo(chain).nativeSymbol, decimals: 18, name: 'Ether',
  };
  if (!heldBase.some((h) => !h.address)) heldBase.unshift(native);
  const held = mergeEphemeralPickItems(heldBase, pastedOnChain);
  const buyableTokens = mergeTrackedTokens(
    TOKENS[chain] ?? [], customTokens.value[chain] ?? [],
  );
  const buyableBase: PickItem[] = [
    native,
    ...buyableTokens.map((t) => ({
      address: t.address, symbol: t.symbol, decimals: t.decimals, name: t.name,
    })),
  ];
  const buyable = mergeEphemeralPickItems(buyableBase, pastedOnChain);

  const intent = swapIntent.value;
  /** the pair to start from on a given chain: the incoming asset, or what you hold */
  const startKey = () => (intent && intent.chainId === chain
    ? sideKey(intent)
    : sideKey(held[0] ?? native));
  const destKey = (start: string) => {
    // the house pair is the default destination — unless you are selling $RAD,
    // in which case "swap $RAD for $RAD" is not a trade anyone wants
    const rad = buyable.find((b) => b.address?.toLowerCase() === RAD);
    const pick = rad && sideKey(rad) !== start ? rad : buyable.find((b) => sideKey(b) !== start);
    return sideKey(pick ?? native);
  };
  const [fromKey, setFromKey] = useState(startKey);
  const [toKey, setToKey] = useState<string>(() => destKey(startKey()));
  const rememberPasted = (item: PickItem) => {
    if (!item.address) return;
    setPastedTokens((prev) => {
      const chains = prev.accountKey === accountKey ? prev.chains : {};
      const have = chains[chain] ?? [];
      if (have.some((t) => t.address?.toLowerCase() === item.address?.toLowerCase())) return prev;
      return { accountKey, chains: { ...chains, [chain]: [...have, item] } };
    });
  };
  const lookupContract = useCallback(async (address: `0x${string}`): Promise<PickItem | null> => {
    if (DEMO) throw new Error('demo mode has no chain to check');
    if (!acct) throw new Error('unlock a wallet before checking contracts');
    return withFailover(endpointsForChain(chain), async (node) => {
      const found = await probeToken(node, chain, address, acct.address);
      if (!found) throw new Error('that contract will not say what it is');
      if (!Number.isInteger(found.token.decimals) || found.token.decimals < 0 || found.token.decimals > 36) {
        throw new Error('that token reports unsupported decimals');
      }
      return {
        address: found.token.address,
        symbol: found.token.symbol,
        name: found.token.name,
        decimals: found.token.decimals,
        amount: found.balance.amount,
        raw: found.balance.raw,
      };
    });
  }, [chain, accountKey]);

  /**
   * SWAP FOLLOWS THE ASSET, NOT THE LAST NETWORK YOU LOOKED AT.
   *
   * The screen has always read `chainId`, but nothing set it: opening SWAP from
   * a Base or Robinhood token left the wallet on whatever chain it was already
   * on, so you got an Ethereum swap page with Ethereum's token lists and an
   * Ethereum quote. The intent carries its chain now, and this puts the wallet
   * on it before anything is quoted.
   */
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current) return;
    settled.current = true;
    if (intent && intent.chainId !== chain) setChain(intent.chainId);
  }, []);

  /*
    The intent is dropped when the screen goes away, whichever way you leave.
    It used to be cleared by this screen's own back button — which stopped
    being the way home the moment the tab bar took that job, and a stale
    intent means coming back to SWAP re-opens the asset you arrived with days
    ago instead of what you hold now. Clearing it on ARRIVAL is wrong for a
    different reason: setChain re-runs the pair chooser a render later, and it
    reads the intent to decide which side you are selling.
  */
  useEffect(() => () => { swapIntent.value = null; }, []);

  // changing chains changes both token lists underneath the pair, so the pair
  // has to be re-chosen — a key from the old chain matches nothing on the new
  // one and would silently fall back to its first entry
  const known = useRef(chain);
  useEffect(() => {
    if (known.current === chain) return;
    known.current = chain;
    const start = startKey();
    setFromKey(start);
    setToKey(destKey(start));
  }, [chain]);
  const from = held.find((h) => sideKey(h) === fromKey) ?? held[0] ?? native;
  let to = buyable.find((b) => sideKey(b) === toKey) ?? buyable[0];
  // choosing the same token on both sides is not a trade: slide the other side
  if (sideKey(to) === sideKey(from)) {
    to = buyable.find((b) => sideKey(b) !== sideKey(from)) ?? to;
  }

  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  /** what the wallet holds of the FROM token on this chain, for the % buttons */
  const fromBalance = (() => {
    const want = from.address?.toLowerCase() ?? null;
    const b = visibleBalances.value.find((x) => (x.chainId ?? 1) === chain
      && (x.address?.toLowerCase() ?? null) === want);
    return b ? { raw: b.raw, amount: b.amount }
      : from.raw !== undefined && from.amount !== undefined ? { raw: from.raw, amount: from.amount } : null;
  })();
  const [amt, setAmt] = useState('0.10');
  const [slip, setSlip] = useState('1.0');
  const [route, setRoute] = useState<RouteComparison | null>(null);
  const [routeEndpoint, setRouteEndpoint] = useState<string | null>(null);
  const [quote, setQuote] = useState<AnyQuote | null>(null);
  const [kyber, setKyber] = useState<KyberRouteQuote | null>(null);
  const [kyberApproval, setKyberApproval] = useState<SwapStep | null>(null);
  const [aggregatorNote, setAggregatorNote] = useState<string | null>(null);
  const [review, setReview] = useState<{
    key: string; quote: KyberRouteQuote; built: KyberBuiltSwap; gasEth: string; createdAt: number;
  } | null>(null);
  const aggregatorEnabled = prefs.value.aggregator?.enabled === true;
  const [quoting, setQuoting] = useState(false);
  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; chainId: number } | null>(null);
  const [working, setWorking] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ key: string; hash: `0x${string}` } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /**
   * Which quote request is the current one.
   *
   * Debouncing cancels a request that has not STARTED; it does nothing about
   * one already in flight. Change the pair while a quote is on the wire and
   * the old await lands afterwards, writing its answer into the new pair's
   * screen — observed live: switching ETH→PEPE to ETH→USDC mid-flight showed
   * "1,415,276,947,390,362,800,000 USDC", which is PEPE's output formatted
   * with USDC's decimals. The same late write flips needsApproval on for an
   * ERC-20 you have already switched away from, so the approval panel appears
   * offering to let the router move your ETH — which needs no approval at all.
   *
   * A stale quote is not just a cosmetic wrong number: `fire()` signs with it.
   */
  const reqSeq = useRef(0);

  let inRaw = 0n;
  let inputError: string | null = null;
  try { inRaw = parseTokenAmount(amt, from.decimals); }
  catch (e) { if (amt) inputError = e instanceof Error ? e.message : String(e); }
  const amtOk = inRaw > 0n;
  let slipOk = false;
  try { slipOk = parseTokenAmount(slip, 2) <= 5000n; }
  catch { /* slippage is represented in whole basis points */ }
  if (!slipOk) inputError = 'Enter slippage from 0 to 50%, with at most 2 decimal places.';
  const quoteKey = JSON.stringify([
    accountKey, chain, sideKey(from), from.decimals, from.symbol,
    sideKey(to), to.decimals, to.symbol, amt, slip, aggregatorEnabled,
  ]);
  const currentQuoteKey = useRef(quoteKey);
  currentQuoteKey.current = quoteKey;
  const quoteReady = readyKey === quoteKey && amtOk && slipOk;
  const approvalSteps = kyber ? (kyberApproval ? [kyberApproval] : []) : plan?.approvals ?? [];
  const needsApproval = quoteReady && approvalSteps.length > 0;
  /** the house pair still gets the v3-vs-v4 race */
  const isHousePair = chain === 1 && !from.address && to.address?.toLowerCase() === RAD;

  useEffect(() => {
    // bumping this synchronously retires anything already on the wire, before
    // the new request is even scheduled
    const seq = ++reqSeq.current;
    const current = () => seq === reqSeq.current && currentQuoteKey.current === quoteKey;
    setReadyKey(null);
    setRoute(null); setRouteEndpoint(null); setQuote(null); setErr(null); setPlan(null);
    setKyber(null); setKyberApproval(null); setReview(null); setAggregatorNote(null);
    setPendingApproval(null); setApprovalError(null);
    setQuoting(false); setSent(null);
    if (!amtOk || !slipOk || !swappable || sideKey(from) === sideKey(to)) return;
    clearTimeout(timer.current);
    const ctrl = new AbortController();
    timer.current = setTimeout(async () => {
      if (DEMO) {
        if (!current()) return;
        const out = Number(amt) * 108427;
        setRoute({
          v3: {
            amountInEth: amt, amountOut: 0n,
            amountOutFormatted: out.toLocaleString('en-US', { maximumFractionDigits: 1 }),
            feeTier: 10000, feeTierPct: '1.00%', minOut: 0n,
            minOutFormatted: (out * (1 - Number(slip) / 100)).toLocaleString('en-US', { maximumFractionDigits: 1 }),
            slippagePct: Number(slip),
          },
          v4: null, best: 'v3',
        });
        setReadyKey(quoteKey);
        return;
      }
      setQuoting(true);
      try {
        const ep = endpointForChain(chain);
        const asked = aggregatorEnabled && canUseKyberSwap(chain) && acct
          ? quoteKyberSwap({ enabled: true, signal: ctrl.signal }, chain, acct.address, from, to, inRaw, Number(slip))
            .catch(() => {
              if (current()) setAggregatorNote('KyberSwap is unavailable for this quote. Direct routes are still checked.');
              return null;
            })
          : Promise.resolve(null);
        const useAggregator = async (directOut: bigint) => {
          const candidate = await asked;
          if (!current() || !candidate || candidate.amountOut <= directOut || !acct) return false;
          let approval: SwapStep | null = null;
          if (from.address) {
            const allowance = await withFailover(endpointsForChain(chain), (node) =>
              kyberAllowanceFor(node, chain, from.address!, acct.address)).catch(() => 0n);
            if (!current()) return false;
            if (allowance < inRaw) approval = {
              label: `Allow KyberSwap to spend ${from.symbol}`,
              tx: buildKyberApproveTx(chain, from.address, inRaw),
            };
          }
          setKyber(candidate); setKyberApproval(approval); setRouteEndpoint(ep); setReadyKey(quoteKey);
          return true;
        };
        if (isHousePair) {
          const found = await bestEthToRadRouteAcross(
            endpointsForChain(chain), amt, Number(slip),
          ).catch(() => null);
          if (!current()) return;
          const directOut = found?.best ? (found.best === 'v4' ? found.v4! : found.v3!).amountOut : 0n;
          if (await useAggregator(directOut) || !current()) return;
          if (found) {
            setRoute(found);
            setRouteEndpoint(found.endpoint);
            setReadyKey(quoteKey);
          } else {
            setErr('no route found — all configured RPCs failed or pools missing');
          }
        } else {
          /*
            THROUGH THE POOL, NOT ONE PINNED ENDPOINT.
            Accounts are pinned to an endpoint by address hash, and some of the
            endpoints we ship cannot answer this at all: flashbots serves no
            eth_call ("the method does not exist"), and drpc throttles a large
            batch into a blanket failure. Pinned to either, EVERY pair reported
            "no route" forever, and switching wallets appeared to fix it —
            the same trap the balance sweep already failed over out of.
            A null answer is treated as a reason to ask the next node; "no
            route" is only true once every node has said so.
          */
          // a curve that would not serve the pair says why, and that reason
          // is kept: "sold out, waiting to graduate" is a different message
          // from "no pool", and the only one worth showing
          let refusal: string | null = null;
          const found = await withFailover(endpointsForChain(chain), async (node) => {
            const r = await quoteSwap(
              node, chain, from, to, inRaw, Number(slip), acct?.address,
            );
            if (!r) throw new Error('no route');
            return { quote: r, endpoint: node };
          }).catch((e: Error) => {
            const said = e.message.split('last said: ').pop() ?? '';
            if (/pons/i.test(said)) refusal = said;
            return null;
          });
          if (!current()) return;
          if (await useAggregator(found?.quote.amountOut ?? 0n) || !current()) return;
          if (!found) {
            setErr(refusal ?? `no Uniswap pool for ${from.symbol} → ${to.symbol} on ${chainInfo(chain).name}`);
          } else if (acct) {
            // one place decides what a swap costs in signatures — v3's single
            // approval, or v4's Permit2 pair plus any wrap/unwrap. The deadline
            // comes off the chain inside planSwap, never off this machine's
            // clock: a laptop twenty minutes slow would expire every swap.
            const p = await planSwap(
              found.endpoint, chain, acct.address, from, to, inRaw, found.quote,
            );
            if (!current()) return;
            setQuote(found.quote);
            setRouteEndpoint(found.endpoint);
            setPlan(p);
            setReadyKey(quoteKey);
          } else {
            setQuote(found.quote);
            setRouteEndpoint(found.endpoint);
            setReadyKey(quoteKey);
          }
        }
      } catch (e) {
        if (current()) setErr((e as Error).message.split('\n')[0]);
      } finally {
        if (current()) setQuoting(false);
      }
    }, 500);
    return () => { clearTimeout(timer.current); ctrl.abort(); reqSeq.current += 1; };
  }, [quoteKey]);

  /** sign the next approval the plan is waiting on, one at a time */
  async function approve() {
    const activePlan = plan;
    const step = approvalSteps[0];
    if (!acct || !step || working || !quoteReady) return;
    const approvalSeq = reqSeq.current;
    const current = () => approvalSeq === reqSeq.current && currentQuoteKey.current === quoteKey;
    setWorking(true);
    setApprovalError(null);
    try {
      const ep = routeEndpoint ?? endpointForChain(chain);
      let hash = pendingApproval?.key === quoteKey ? pendingApproval.hash : null;
      if (!hash) {
        const preview = await previewDappTx(ep, acct.address, step.tx, chain);
        if (!preview.ok) throw new Error(preview.error ?? 'The approval would revert.');
        if (!current()) return;
        hash = await session.sendTx(acct.index, ep, chain, step.tx);
        if (current()) setPendingApproval({ key: quoteKey, hash });
        await recordTx({ hash, chainId: chain, kind: 'send', to: step.tx.to });
      }
      // A mined receipt and the allowance can become visible at different
      // times. Keep checking the configured pool before advancing the plan;
      // a failed read must neither strand the UI nor count as an approval.
      const nodes = [...new Set([ep, ...endpointsForChain(chain)])];
      const until = Date.now() + 90_000;
      while (current()) {
        const result = await withFailover(nodes, async (node) => {
          if (!current()) throw new Error('Swap details changed.');
          const receipt = await chainClient(node, chain).getTransactionReceipt({ hash });
          if (!current()) throw new Error('Swap details changed.');
          if (receipt.status !== 'success') return { reverted: true as const, node, plan: null };
          let checked: SwapPlan | null = null;
          if (kyber && from.address) {
            const allowed = await kyberAllowanceFor(node, chain, from.address, acct.address);
            if (allowed < inRaw) throw new Error('The allowance is not visible yet.');
          } else if (quote && activePlan) {
            checked = await planSwap(node, chain, acct.address, from, to, inRaw, quote);
            if (checked.approvals.length >= activePlan.approvals.length) {
              throw new Error('The allowance is not visible yet.');
            }
          } else {
            throw new Error('The swap needs a fresh quote.');
          }
          return { reverted: false as const, node, plan: checked };
        }).catch(() => null);
        if (!current()) return;
        if (result?.reverted) {
          setPendingApproval(null);
          throw new Error('The approval failed onchain. You can try approving again.');
        }
        if (result) {
          if (kyber) setKyberApproval(null);
          else setPlan(result.plan);
          setRouteEndpoint(result.node);
          setPendingApproval(null);
          say(`approved exactly ${amt} ${from.symbol}. not a penny more.`);
          return;
        }
        if (Date.now() >= until) {
          throw new Error('Approval confirmation is still unavailable. Recheck approval to check the same transaction without sending another.');
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } catch (e) {
      if (current()) {
        setApprovalError(e instanceof Error ? e.message : String(e));
        sayError(e);
      }
    } finally {
      setWorking(false);
    }
  }

  const trackOnSuccess = to.address ? [{
    address: to.address, symbol: to.symbol, name: to.name ?? to.symbol,
    decimals: to.decimals, recipient: acct?.address,
  }] : [];

  async function prepareKyberReview() {
    if (!acct || !kyber || !quoteReady || needsApproval || working) return;
    setWorking(true); setReview(null);
    try {
      if (!prefs.value.aggregator?.enabled) throw new Error('KyberSwap is off.');
      const fresh = await quoteKyberSwap(prefs.value.aggregator, chain, acct.address, from, to, inRaw, Number(slip));
      if (currentQuoteKey.current !== quoteKey) return;
      if (!fresh) throw new Error('No fresh KyberSwap quote is available.');
      const built = await buildKyberSwap(prefs.value.aggregator, fresh, acct.address, kyber.minOut);
      if (currentQuoteKey.current !== quoteKey) return;
      const checked = await withFailover(endpointsForChain(chain), async (node) => {
        const preview = await previewDappTx(node, acct.address, built.tx, chain);
        if (!preview.ok) throw new Error(preview.error ?? 'The swap would revert.');
        return { preview, endpoint: node };
      });
      if (currentQuoteKey.current !== quoteKey) return;
      setRouteEndpoint(checked.endpoint);
      setReview({ key: quoteKey, quote: fresh, built, gasEth: checked.preview.gasEth, createdAt: Date.now() });
    } catch (e) { sayError(e); }
    finally { setWorking(false); }
  }

  async function signKyberReview() {
    if (!acct || !review || review.key !== quoteKey || !quoteReady || needsApproval || working) return;
    setWorking(true);
    try {
      if (!prefs.value.aggregator?.enabled || Date.now() - review.createdAt > 60_000) {
        setReview(null);
        throw new Error('This review expired. Review a fresh quote before signing.');
      }
      validateKyberSwapTx(chain, acct.address, review.quote.tokenIn, review.quote.tokenOut,
        inRaw, review.built.minReturnAmount, review.built.tx);
      const ep = routeEndpoint ?? endpointForChain(chain);
      const checked = await previewDappTx(ep, acct.address, review.built.tx, chain);
      if (!checked.ok) throw new Error(checked.error ?? 'The swap would revert.');
      if (currentQuoteKey.current !== quoteKey) throw new Error('Swap details changed; review a new quote.');
      const hash = await session.sendTx(acct.index, ep, chain, review.built.tx, { trackOnSuccess });
      await recordTx({ hash, chainId: chain, kind: 'swap', to: to.symbol });
      setSent({ hash, chainId: chain }); setReview(null);
      say(`${from.symbol} → ${to.symbol} broadcast. Wallet fee: 0%.`);
      scheduleBalanceRefresh(chain, hash, trackOnSuccess);
    } catch (e) { sayError(e); }
    finally { setWorking(false); }
  }

  async function fire() {
    if (!acct || working || !quoteReady || needsApproval) return;
    if (kyber) { await prepareKyberReview(); return; }
    setWorking(true);
    try {
      if (DEMO) {
        say('demo mode: nothing was broadcast.');
        setSent({ hash: '0xdemo…nothing was actually swapped', chainId: chain });
        return;
      }
      const ep = routeEndpoint ?? endpointForChain(chain);
      let hash: `0x${string}`;
      if (isHousePair && route?.best) {
        const deadline = route.best === 'v4'
          ? (await chainClient(ep, chain).getBlock()).timestamp + 1200n : 0n;
        const tx = buildBestRouteTx(route, acct.address, deadline);
        const checked = await previewDappTx(ep, acct.address, tx, chain);
        if (!checked.ok) throw new Error(checked.error ?? 'The displayed swap would revert.');
        if (currentQuoteKey.current !== quoteKey) throw new Error('Swap details changed; review a new quote.');
        hash = await session.sendTx(acct.index, ep, chain, tx, { trackOnSuccess });
      } else if (quote && plan) {
        if (quote.protocol === 'pons' &&
            (!plan.swap.tx.from || plan.swap.tx.from.toLowerCase() !== acct.address.toLowerCase())) {
          throw new Error('wallet changed — quote this Pons swap again before signing');
        }
        // a wrapped-ether pool needs native in turned into WETH first, and the
        // proceeds turned back after — otherwise you asked for ETH and would
        // be handed WETH you never mentioned
        if (plan.wrap) {
          const w = await session.sendTx(acct.index, ep, chain, plan.wrap.tx);
          await recordTx({ hash: w, chainId: chain, kind: 'send', to: plan.wrap.tx.to });
        }
        hash = await session.sendTx(
          acct.index, ep, chain, plan.swap.tx, trackOnSuccess ? { trackOnSuccess } : undefined,
        );
        if (plan.unwrap) {
          // wait for the swap, then unwrap what actually arrived. minOut is the
          // floor, so unwrapping that would leave the rest of the slippage
          // allowance sitting as WETH nobody asked for.
          await chainClient(ep, chain).waitForTransactionReceipt({ hash, timeout: 90_000 })
            .catch(() => null);
          const tx = plan.unwrapAll ? await plan.unwrapAll() : plan.unwrap.tx;
          const u = await session.sendTx(acct.index, ep, chain, tx);
          await recordTx({ hash: u, chainId: chain, kind: 'send', to: tx.to });
        }
      } else {
        return;
      }
      await recordTx({ hash, chainId: chain, kind: 'swap', to: to.symbol });
      setSent({ hash, chainId: chain });
      say(`${from.symbol} → ${to.symbol} broadcast. 0% of it was ours.`);
      scheduleBalanceRefresh(chain, hash, trackOnSuccess);
    } catch (e) {
      sayError(e);
    } finally {
      setWorking(false);
    }
  }

  const outText = !quoteReady ? null : kyber ? formatTokenAmount(kyber.amountOut, to.decimals) : route?.best
    ? DEMO ? (route.best === 'v4' ? route.v4! : route.v3!).amountOutFormatted
      : formatTokenAmount((route.best === 'v4' ? route.v4! : route.v3!).amountOut, to.decimals)
    : quote
      ? formatTokenAmount(quote.amountOut, to.decimals)
      : null;
  const minText = !quoteReady ? null : kyber ? formatTokenAmount(kyber.minOut, to.decimals) : route?.best
    ? DEMO ? (route.best === 'v4' ? route.v4! : route.v3!).minOutFormatted
      : formatTokenAmount((route.best === 'v4' ? route.v4! : route.v3!).minOut, to.decimals)
    : quote
      ? formatTokenAmount(quote.minOut, to.decimals)
      : null;

  return (
    <>
      <div class="content swapcontent">
      <div class="simhead swaphead">
        <h1>RADSWAP</h1>
        {/* pick the chain here rather than going back to HOME for it: this
            screen is the only place the choice actually changes anything */}
        <select
          class="netsel wide" value={String(chain)} aria-label="network to swap on" disabled={working}
          onChange={(e) => setChain(Number((e.target as HTMLSelectElement).value))}
        >
          {CHAIN_IDS.filter((id) => canSwapOn(id) || id === chain).map((id) => (
            <option key={id} value={String(id)}>{CHAINS[id].name.toUpperCase()}</option>
          ))}
        </select>
      </div>

      {!swappable && (
        <div class="panel">
          <div class="hd">NO POOLS HERE</div>
          <div class="note">
            {chainInfo(chain).name} has no Uniswap deployment we can quote, so there is
            nothing to swap against. Pick another chain above.
          </div>
        </div>
      )}

      {swappable && (
        <>
          {canUseKyberSwap(chain) && (
            <div class="panel">
              <label class="row">
                <input type="checkbox" checked={aggregatorEnabled} disabled={working}
                  onChange={() => {
                    prefs.value = { ...prefs.value, aggregator: { enabled: !aggregatorEnabled } };
                    void persistPrefs();
                  }} />
                <span>Compare with KyberSwap · 0% platform fee</span>
              </label>
              <div class="note">When enabled, {KYBER_HOST} receives the pair, amount, wallet address and IP.
                The route with the higher quoted output is selected. Gas and pool fees still apply.</div>
              {aggregatorNote && <div class="note" role="status">{aggregatorNote}</div>}
            </div>
          )}
          <div class="pairbox">
            {/* a <select> of four hundred tokens has no search, no icons, no
                balances and no way to tell two same-symbol tokens apart, so
                each side opens a real picker instead */}
            <button class="pairside" disabled={working} onClick={() => setPicking('from')}>
              <span class="plabel">FROM</span>
              <Icon side={from} chain={chain} />
              <span class="psym">{from.symbol}</span>
              <span class="pcaret">▾</span>
            </button>
            <button
              class="act flip" title="swap the pair around" aria-label="swap the pair around" disabled={working}
              onClick={() => {
                const f = fromKey;
                setFromKey(held.some((h) => sideKey(h) === toKey) ? toKey : fromKey);
                setToKey(buyable.some((b) => sideKey(b) === f) ? f : toKey);
              }}
            >⇅</button>
            <button class="pairside" disabled={working} onClick={() => setPicking('to')}>
              <span class="plabel">TO</span>
              <Icon side={to} chain={chain} />
              <span class="psym">{to.symbol}</span>
              <span class="pcaret">▾</span>
            </button>
          </div>


          <div class="panel">
            <div class="hd">YOU PAY</div>
            {/* the amount carries its unit: the field sat alone under a
                heading, so the one number you type had nothing saying what
                you were typing it IN */}
            <div class="payrow">
              <input
                class="field" value={amt} inputMode="decimal" disabled={working}
                aria-label={`amount in ${from.symbol}`}
                onInput={(e) => setAmt((e.target as HTMLInputElement).value)}
              />
              <span class="unit">{from.symbol}</span>
            </div>
            {/* the amount people actually mean is usually a fraction of what
                they hold, and typing 18 decimals by hand to sell "all of it"
                is how you leave dust behind or overshoot */}
            {fromBalance !== null && (
              <div class="pctrow">
                {[25, 50, 100].map((pct) => (
                  <button
                    key={pct} class="act pct" disabled={working || fromBalance.raw === 0n}
                    title={`${pct}% of your ${from.symbol}`}
                    onClick={() => setAmt(fractionOf(fromBalance.raw, pct, from.decimals))}
                  >{pct === 100 ? 'MAX' : `${pct}%`}</button>
                ))}
                <span class="dim">{fromBalance.amount} {from.symbol}</span>
              </div>
            )}
            <div class="setrow">
              <span>slippage</span>
              <input
                class="field num" value={slip} inputMode="decimal" disabled={working}
                aria-label="maximum slippage percent"
                onInput={(e) => setSlip((e.target as HTMLInputElement).value)}
              />
              <span>%</span>
            </div>
            {inputError && <div class="note red" role="status">{inputError}</div>}
          </div>

          <div class="panel">
            <div class="hd">YOU GET</div>
            {quoting && <div class="note">[ QUOTING INTENSIFIES ]</div>}
            {err && <div class="note red">{err}</div>}
            {outText && (
              <>
                <div class="balance"><div class="big">{outText} {to.symbol}</div></div>
                <table class="feetable">
                  <tr><td>Minimum you receive</td><td>{minText} {to.symbol}</td></tr>
                  {/* a two-hop route is a different trade from a direct one —
                      more gas, another pool's depth — so it is named, not
                      folded into a single fee percentage */}
                  <tr><td>{kyber ? 'Route' : quote?.protocol === 'pons'
                    ? 'Venue'
                    : quote && quote.fees.length > 1 ? 'Route' : 'Pool'}</td><td>
                    {kyber ? kyber.routeLabel : route?.best
                      ? `uniswap ${route.best} · ${(route.best === 'v4' ? route.v4! : route.v3!).feeTierPct}`
                      : quote ? describeRoute(quote) : 'uniswap v3'}
                  </td></tr>
                  {/* the launch tax is the one number on this table that is
                      about to change: it decays to nothing over the curve's
                      first seconds, so it is called out on its own row */}
                  {quote?.pons && quote.pons.snipeTaxBps > 0n && (
                    <tr><td class="red">Launch tax</td><td class="red">
                      {(Number(quote.pons.snipeTaxBps) / 100).toFixed(2)}% right now · gone{' '}
                      {Number(quote.pons.snipeTaxSeconds)}s after launch
                    </td></tr>
                  )}
                  <tr><td>Wallet fee</td><td class="free">0%</td></tr>
                  {kyber && <tr><td>Aggregator fee</td><td class="free">0%</td></tr>}
                </table>
                <div class="note">Network fees and any trading fees still apply.</div>
              </>
            )}
            {!outText && !quoting && !err && <div class="note">enter an amount.</div>}
          </div>

          {needsApproval && outText && (
            <div class="panel">
              <div class="hd">
                {approvalSteps.length > 1 ? `${approvalSteps.length} APPROVALS FIRST` : 'ONE APPROVAL FIRST'}
              </div>
              <div class="note">
                {approvalSteps[0].label} — for <b class="white">exactly {amt}</b>, not the
                unlimited approval most wallets sign here.
              </div>
              <button class="btn block" disabled={working} onClick={() => void approve()}>
                {working ? (pendingApproval ? '[ CONFIRMING APPROVAL ]' : '[ APPROVING ]')
                  : pendingApproval ? 'RECHECK APPROVAL' : `APPROVE ${amt} ${from.symbol}`}
              </button>
              {pendingApproval && <div class="note" role="status">
                Approval sent. Waiting for confirmation and allowance.
                {' '}<TxLink chainId={chain} hash={pendingApproval.hash}>View approval</TxLink>
              </div>}
              {approvalError && <div class="note red" role="status">{approvalError}</div>}
            </div>
          )}

          {review && review.key === quoteKey && quoteReady ? (
            <div class="panel swapreview">
              <div class="hd">REVIEW KYBERSWAP</div>
              <table class="feetable">
                <tr><td>You pay</td><td>{amt} {from.symbol}</td></tr>
                <tr><td>Quoted output</td><td>{formatTokenAmount(review.built.amountOut, to.decimals)} {to.symbol}</td></tr>
                <tr><td>Minimum you receive</td><td>{formatTokenAmount(review.built.minReturnAmount, to.decimals)} {to.symbol}</td></tr>
                <tr><td>Receive token</td><td>{to.address ?? chainInfo(chain).nativeSymbol}</td></tr>
                <tr><td>Recipient</td><td>{acct?.address}</td></tr>
                <tr><td>Estimated gas</td><td>{review.gasEth} {chainInfo(chain).nativeSymbol}</td></tr>
                <tr><td>Wallet / aggregator fee</td><td class="free">0% / 0%</td></tr>
              </table>
              <div class="note">Simulation passed. Prices and network fees can change before confirmation.
                A purchased token is added after a successful receipt confirms it arrived.</div>
              <div class="btnrow">
                <button class="btn" disabled={working} onClick={() => setReview(null)}>REFUSE</button>
                <button class="btn" disabled={working || !!sent} onClick={() => void signKyberReview()}>
                  {working ? '[ SIGNING ]' : 'SIGN & SEND'}
                </button>
              </div>
            </div>
          ) : <button
            class="btn block"
            disabled={!outText || working || needsApproval || !!sent}
            onClick={() => void fire()}
          >
            {working ? (needsApproval ? '[ APPROVAL REQUIRED ]' : '[ SWAPPING INTENSIFIES ]')
              : kyber ? 'REVIEW SWAP' : `SWAP ${from.symbol} → ${to.symbol}`}
          </button>}
        </>
      )}

      {sent && (
        <div class="panel">
          <div class="hd">BROADCAST</div>
          {DEMO
            ? <div class="addr">{sent.hash}</div>
            : <TxLink chainId={sent.chainId} hash={sent.hash}>{sent.hash}</TxLink>}
        </div>
      )}


      </div>

      {/*
        OUTSIDE `.content` on purpose. `.content` is position:relative with
        z-index:1, which makes it a stacking context — a sheet rendered inside
        it paints UNDER the sticky tab bar no matter how high its own z-index
        goes. The wallet drawer has always been a sibling for the same reason.
      */}
      {picking && (
        <TokenPicker
          title={picking === 'from' ? 'SELL' : 'BUY'}
          chain={chain}
          items={picking === 'from' ? held : buyable}
          selected={picking === 'from' ? fromKey : sideKey(to)}
          lookupContract={lookupContract}
          onPick={(item) => {
            rememberPasted(item);
            if (picking === 'from') setFromKey(sideKey(item));
            else setToKey(sideKey(item));
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
