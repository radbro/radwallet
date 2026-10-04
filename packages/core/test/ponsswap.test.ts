import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import {
  PONS_CURVE_ABI, PONS_V2_FACTORY, quotePonsCurveSell, quotePonsCurveBuy, type PonsCurveSnapshot,
} from '../src/pons.js';
import {
  resolvePonsVenueWithClient, quotePonsVenue, ponsVenueSide, ponsVenueSpendToken,
  buildPonsVenueSwapTx, buildPonsVenueApproveTx, preflightPonsVenueSwap, requireOpenPonsVenue,
  type PonsVenue,
} from '../src/ponsswap.js';
import { describeRoute } from '../src/swapany.js';

const TOKEN = getAddress('0x1000000000000000000000000000000000000001');
const CURVE = getAddress('0x2000000000000000000000000000000000000002');
const OWNER = getAddress('0x3000000000000000000000000000000000000003');
const PAIR = getAddress('0x5000000000000000000000000000000000000005');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/**
 * A live sample, recorded rather than invented: curve
 * 0xd26c2d746f06f861ed246fc117007c7ffa7506e1 (PREDDY) at Robinhood block
 * 53632671, then the CurveSell it emitted in block 53632672 — the only curve
 * log in that block, so the parent-block reserves are the reserves it saw.
 */
const LIVE = {
  snapshot: {
    quoteReserve: 2_614_497_580_870_732_555n,
    tokenReserve: 642_570_875_678_719_358_977_085_285n,
    sellableTokens: 356_856_589_964_433_644_691_371_000n,
    feeBps: 100n,
    creatorTaxBps: 100n,
  } satisfies PonsCurveSnapshot,
  tokensIn: 1_458_092_262_822_172_867_075_912n,
  quoteOut: 5_800_880_559_610_660n,
  fee: 59_192_658_771_537n,
  tax: 59_192_658_771_537n,
};

test('Pons sell math reproduces a live CurveSell to the wei', () => {
  const q = quotePonsCurveSell(LIVE.snapshot, LIVE.tokensIn);
  assert.equal(q.quoteOut, LIVE.quoteOut);
  assert.equal(q.fee, LIVE.fee);
  assert.equal(q.tax, LIVE.tax);
  // the fee and tax leave the reserve too — they become fee balances, which
  // the curve's getReserves() subtracts
  assert.equal(q.next.quoteReserve, LIVE.snapshot.quoteReserve - q.grossQuote);
  assert.equal(q.next.tokenReserve, LIVE.snapshot.tokenReserve + LIVE.tokensIn);
  assert.throws(() => quotePonsCurveSell(LIVE.snapshot, 0n), /positive/);
});

function venue(overrides: Partial<PonsVenue> = {}): PonsVenue {
  return {
    token: TOKEN,
    curve: CURVE,
    factory: PONS_V2_FACTORY,
    pairToken: ZERO,
    nativeQuote: true,
    graduated: false,
    readyToGraduate: false,
    snapshot: {
      quoteReserve: 1_000_000n, tokenReserve: 10_000_000n, sellableTokens: 7_000_000n,
      feeBps: 100n, creatorTaxBps: 200n,
    },
    launchedAt: 1_800_000_000n,
    snipeTaxSeconds: 3n,
    tokenSymbol: 'PONS',
    tokenDecimals: 18,
    ...overrides,
  };
}

function fakeClient(opts: {
  tokenIsPons?: boolean;
  registered?: Address;
  curveToken?: Address;
  graduated?: boolean;
  curveMute?: boolean;
  callFails?: string;
  allowance?: bigint;
  snipeTaxBps?: bigint;
} = {}) {
  const curveValues: Record<string, unknown> = {
    token: opts.curveToken ?? TOKEN,
    factory: PONS_V2_FACTORY,
    pairToken: ZERO,
    graduated: opts.graduated ?? false,
    readyToGraduate: false,
    getReserves: [1_000_000n, 10_000_000n],
    sellableTokens: 7_000_000n,
    feeBps: 100n,
    creatorTaxBps: 200n,
    launchedAt: 1_800_000_000n,
    snipeTaxSeconds: 3n,
    currentSnipeTaxBps: opts.snipeTaxBps ?? 0n,
  };
  const tokenValues: Record<string, unknown> = {
    symbol: 'PONS', decimals: 18, allowance: opts.allowance ?? 0n,
    ...(opts.tokenIsPons === false ? {} : { launchFactory: PONS_V2_FACTORY, curve: CURVE }),
  };
  const factoryValues: Record<string, unknown> = { getLaunchedToken: opts.registered ?? TOKEN };
  const reads: string[] = [];
  const read = (c: { address: Address; functionName: string }) => {
    reads.push(`${c.address.slice(0, 6)}.${c.functionName}`);
    const values = c.address.toLowerCase() === CURVE.toLowerCase()
      ? curveValues
      : c.address.toLowerCase() === PONS_V2_FACTORY.toLowerCase() ? factoryValues : tokenValues;
    if (!(c.functionName in values)) throw new Error(`no ${c.functionName} here`);
    if (opts.curveMute && c.address.toLowerCase() === CURVE.toLowerCase()) throw new Error('no code');
    return values[c.functionName];
  };
  return {
    reads,
    async multicall(args: { allowFailure?: boolean; contracts: { address: Address; functionName: string }[] }) {
      if (args.allowFailure) {
        return args.contracts.map((c) => {
          try {
            return { status: 'success', result: read(c) };
          } catch (e) {
            // the shape viem gives a call the CONTRACT refused, as opposed to
            // one the node dropped (see isContractRefusal)
            const revert = new Error('reverted');
            revert.name = 'ContractFunctionRevertedError';
            return { status: 'failure', error: Object.assign(e as Error, { cause: revert }) };
          }
        });
      }
      return args.contracts.map(read);
    },
    async readContract(c: { address: Address; functionName: string }) { return read(c); },
    async call() { if (opts.callFails) throw new Error(opts.callFails); return { data: '0x' }; },
  };
}

test('ponsswap: an ordinary ERC-20 is not a venue, a Pons launch is', async () => {
  // an ordinary token (or an EOA) fails the two claim reads, and that is the
  // whole answer — nothing else is asked
  const plain = fakeClient({ tokenIsPons: false });
  assert.equal(await resolvePonsVenueWithClient(plain, 4663, TOKEN), null);
  assert.equal(plain.reads.length, 2);
  assert.equal(await resolvePonsVenueWithClient(fakeClient(), 1, TOKEN), null);

  const v = await resolvePonsVenueWithClient(fakeClient(), 4663, TOKEN);
  assert.ok(v);
  assert.equal(v.curve, CURVE);
  assert.equal(v.nativeQuote, true);
  assert.equal(v.snapshot.sellableTokens, 7_000_000n);
  assert.equal(v.tokenSymbol, 'PONS');
  assert.equal(v.snipeTaxBps, 0n);

  // two round trips, and the recipient's launch tax rides in the second one
  const taxed = fakeClient({ snipeTaxBps: 618n });
  const withTax = await resolvePonsVenueWithClient(taxed, 4663, TOKEN, OWNER);
  assert.equal(withTax?.snipeTaxBps, 618n);
  assert.ok(taxed.reads.includes(`${CURVE.slice(0, 6)}.currentSnipeTaxBps`));
});

test('ponsswap: a token that claims the factory but fails the registry is refused, not ignored', async () => {
  const other = getAddress('0x9000000000000000000000000000000000000009');
  await assert.rejects(
    resolvePonsVenueWithClient(fakeClient({ registered: other }), 4663, TOKEN),
    /does not register/,
  );
  await assert.rejects(
    resolvePonsVenueWithClient(fakeClient({ curveToken: other }), 4663, TOKEN),
    /point back/,
  );
  // a claimed curve that answers nothing is named, not trusted
  await assert.rejects(
    resolvePonsVenueWithClient(fakeClient({ curveMute: true }), 4663, TOKEN),
    /did not answer curve state/,
  );
});

test('ponsswap: sides — buy with the quote asset, sell back for it, nothing else', () => {
  const v = venue();
  assert.equal(ponsVenueSide(v, null, TOKEN), 'buy');
  assert.equal(ponsVenueSide(v, TOKEN, null), 'sell');
  assert.equal(ponsVenueSide(v, PAIR, TOKEN), null);
  assert.equal(ponsVenueSide(v, TOKEN, PAIR), null);
  const erc = venue({ pairToken: PAIR, nativeQuote: false });
  assert.equal(ponsVenueSide(erc, PAIR, TOKEN), 'buy');
  assert.equal(ponsVenueSide(erc, null, TOKEN), null);
  assert.equal(ponsVenueSide(erc, TOKEN, PAIR), 'sell');
});

test('ponsswap: quotes price with the curve math and name every take', () => {
  const v = venue();
  const buy = quotePonsVenue(v, 'buy', 100_000n);
  const ref = quotePonsCurveBuy(v.snapshot, 100_000n);
  assert.equal(buy.amountOut, ref.tokensOut);
  assert.equal(buy.fee, 1_000n);
  assert.equal(buy.tax, 2_000n);
  assert.equal(buy.snipeTax, 0n);

  // a launch tax comes off the spend on top; the creator tax is reported
  // separately from it, and the curve's cap (buyer nets at least 1%) holds
  const taxed = quotePonsVenue(v, 'buy', 100_000n, 5_000n);
  assert.ok(taxed.amountOut < buy.amountOut);
  assert.equal(taxed.snipeTaxBps, 5_000n);
  assert.equal(taxed.snipeTax, 50_000n);
  assert.equal(taxed.tax, 2_000n);
  const capped = quotePonsVenue(v, 'buy', 100_000n, 9_999n);
  assert.equal(capped.snipeTaxBps, 10_000n - 100n - 200n - 100n);

  const sell = quotePonsVenue(v, 'sell', 50_000n);
  assert.equal(sell.amountOut, quotePonsCurveSell(v.snapshot, 50_000n).quoteOut);
  assert.equal(sell.snipeTaxBps, 0n);

  assert.throws(() => quotePonsVenue(venue({ graduated: true }), 'buy', 1n), /graduated/);
  assert.throws(() => requireOpenPonsVenue(venue({ readyToGraduate: true })), /sold out/);
});

test('ponsswap: the transactions are the curve’s own buy and sell, recipient = signer', () => {
  const v = venue();
  const buy = buildPonsVenueSwapTx(quotePonsVenue(v, 'buy', 100_000n), OWNER, 100_000n, 90_000n);
  assert.equal(buy.to, CURVE);
  assert.equal(buy.value, `0x${(100_000n).toString(16)}`);
  const b = decodeFunctionData({ abi: PONS_CURVE_ABI, data: buy.data! });
  assert.equal(b.functionName, 'buy');
  assert.deepEqual(b.args, [100_000n, 90_000n, OWNER]);

  const sell = buildPonsVenueSwapTx(quotePonsVenue(v, 'sell', 50_000n), OWNER, 50_000n, 1n);
  assert.equal(sell.value, undefined);
  const s = decodeFunctionData({ abi: PONS_CURVE_ABI, data: sell.data! });
  assert.equal(s.functionName, 'sell');
  assert.deepEqual(s.args, [50_000n, 1n, OWNER]);

  // an ERC-20 quote asset: the buy carries no ETH and needs the pair token approved
  const erc = venue({ pairToken: PAIR, nativeQuote: false });
  const ercBuy = quotePonsVenue(erc, 'buy', 100_000n);
  assert.equal(buildPonsVenueSwapTx(ercBuy, OWNER, 100_000n, 1n).value, undefined);
  assert.equal(ponsVenueSpendToken(ercBuy), PAIR);
  assert.equal(ponsVenueSpendToken(quotePonsVenue(v, 'buy', 1_000n)), null);
  assert.equal(ponsVenueSpendToken(quotePonsVenue(v, 'sell', 1_000n)), TOKEN);

  // the allowance is exact and goes to the curve, never unlimited
  const approve = buildPonsVenueApproveTx(TOKEN, CURVE, 50_000n);
  const a = decodeFunctionData({ abi: erc20Abi, data: approve.data! });
  assert.deepEqual(a.args, [CURVE, 50_000n]);
  assert.equal(approve.to, TOKEN);
});

test('ponsswap: the preflight reports the curve’s refusal in words', async () => {
  const tx = buildPonsVenueSwapTx(quotePonsVenue(venue(), 'buy', 100n), OWNER, 100n, 1n);
  await preflightPonsVenueSwap(fakeClient(), tx);
  await assert.rejects(
    preflightPonsVenueSwap(fakeClient({ callFails: 'CurveGraduated()' }), tx),
    /Pons curve refused this trade: CurveGraduated/,
  );
});

test('ponsswap: the route table names the curve and each of its takes', () => {
  const base = { amountOut: 1n, minOut: 1n, feeTier: 100, hops: [ZERO, TOKEN] as Address[], fees: [100] };
  const q = quotePonsVenue(venue(), 'buy', 100_000n, 618n);
  assert.equal(
    describeRoute({ ...base, protocol: 'pons', pons: q }),
    'pons curve · 1.00% fee + 2.00% creator tax + 6.18% launch tax right now',
  );
  assert.equal(
    describeRoute({ ...base, protocol: 'pons', pons: quotePonsVenue(venue(), 'sell', 1_000n) }),
    'pons curve · 1.00% fee + 2.00% creator tax',
  );
});
