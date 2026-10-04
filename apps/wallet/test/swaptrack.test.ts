import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmationWatchKey,
  mergeConfirmationWatches,
  normalizeConfirmationWatch,
  normalizeSwapTrackTokens,
  trackTokensForSettledReceipt,
  type ConfirmationWatchShape,
  type ReceiptLogShape,
  type SwapTrackToken,
} from '../src/swaptrack.js';

const CHAIN_IDS = [1, 4663];
const HASH = `0x${'1'.repeat(64)}` as `0x${string}`;
const TOKEN = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const RECIPIENT = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const ATTACKER = '0x4444444444444444444444444444444444444444' as `0x${string}`;

function transferLog(to: `0x${string}`, value: bigint, address = TOKEN): ReceiptLogShape {
  return {
    address,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${'0'.repeat(64)}`,
      `0x${'0'.repeat(24)}${to.slice(2).toLowerCase()}`,
    ],
    data: `0x${value.toString(16)}`,
  };
}

test('swap tracking metadata normalizes across persisted confirmation restarts', () => {
  const watch = normalizeConfirmationWatch({
    chainId: '4663',
    hash: HASH,
    queuedAt: 123,
    trackOnSuccess: [
      { address: TOKEN, symbol: ' NEW ', name: '', decimals: 18, recipient: RECIPIENT },
      { address: 'nope', symbol: 'BAD', name: 'Bad', decimals: 18, recipient: RECIPIENT },
      { address: TOKEN, symbol: 'DUP', name: 'Duplicate', decimals: 18, recipient: RECIPIENT },
    ],
  }, CHAIN_IDS);

  assert.deepEqual(watch, {
    chainId: 4663,
    hash: HASH,
    queuedAt: 123,
    trackOnSuccess: [{
      address: TOKEN,
      symbol: 'NEW',
      name: 'NEW',
      decimals: 18,
      recipient: RECIPIENT,
    }],
  });
  assert.equal(confirmationWatchKey(watch!), `4663:${HASH}`);
});

test('confirmation queue dedupes hash entries while preserving later tracking metadata', () => {
  const existing: ConfirmationWatchShape = { chainId: 4663, hash: HASH, queuedAt: 1 };
  const incoming: ConfirmationWatchShape = {
    chainId: 4663,
    hash: HASH,
    queuedAt: 2,
    trackOnSuccess: [{ address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: RECIPIENT }],
  };

  assert.deepEqual(mergeConfirmationWatches([existing], incoming), [{
    ...existing,
    trackOnSuccess: incoming.trackOnSuccess,
  }]);
});

test('confirmed receipts track only tokens actually transferred to the expected recipient', () => {
  const tokens = normalizeSwapTrackTokens([
    { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: RECIPIENT },
    {
      address: '0x4444444444444444444444444444444444444444',
      symbol: 'MISS',
      name: 'Missing Token',
      decimals: 18,
      recipient: RECIPIENT,
    },
  ]);

  assert.deepEqual(trackTokensForSettledReceipt('success', tokens, [transferLog(RECIPIENT, 10n)]), [{
    address: TOKEN,
    symbol: 'NEW',
    name: 'New Token',
    decimals: 18,
  }]);
});

test('bound tracking metadata uses the signer recipient over candidate-supplied recipients', () => {
  assert.deepEqual(normalizeSwapTrackTokens([
    { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: ATTACKER },
  ], RECIPIENT, 'bind'), [{
    address: TOKEN,
    symbol: 'NEW',
    name: 'New Token',
    decimals: 18,
    recipient: RECIPIENT,
  }]);
});

test('confirmed receipts ignore tracking metadata without a recipient proof', () => {
  const tokens = normalizeSwapTrackTokens([
    { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18 },
  ]);

  assert.deepEqual(trackTokensForSettledReceipt('success', tokens, [transferLog(RECIPIENT, 10n)]), []);
});

test('reverted and pending confirmations do not track swap output tokens', () => {
  const tokens = normalizeSwapTrackTokens([
    { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: RECIPIENT },
  ]);
  const logs = [transferLog(RECIPIENT, 10n)];

  assert.deepEqual(trackTokensForSettledReceipt('reverted', tokens, logs), []);
  assert.deepEqual(trackTokensForSettledReceipt(null, tokens, logs), []);
});

test('successful receipts do not track zero-value or wrong-recipient transfers', () => {
  const tokens = normalizeSwapTrackTokens([
    { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: RECIPIENT },
  ]);

  assert.deepEqual(trackTokensForSettledReceipt('success', tokens, [
    transferLog(RECIPIENT, 0n),
    transferLog('0x5555555555555555555555555555555555555555', 10n),
  ]), []);
});

test('persisted confirmation queue tracks after restart only when the receipt proves delivery', async () => {
  class QueueFixture {
    private watchWrite: Promise<void> = Promise.resolve();
    private tokenWrite: Promise<void> = Promise.resolve();

    constructor(public rawWatches = '[]', public rawTokens = '{}') {}

    read(): ConfirmationWatchShape[] {
      const parsed = JSON.parse(this.rawWatches) as unknown[];
      return parsed
        .map((value) => normalizeConfirmationWatch(value, CHAIN_IDS))
        .filter((value): value is ConfirmationWatchShape => value !== null);
    }

    async enqueue(watch: ConfirmationWatchShape): Promise<void> {
      const write = this.watchWrite.then(async () => {
        this.rawWatches = JSON.stringify(mergeConfirmationWatches(this.read(), watch));
      });
      this.watchWrite = write.catch(() => {});
      await write;
    }

    async settle(
      hash: `0x${string}`,
      status: 'success' | 'reverted',
      logs: ReceiptLogShape[],
    ): Promise<SwapTrackToken[]> {
      let added: SwapTrackToken[] = [];
      const write = this.watchWrite.then(async () => {
        const watches = this.read();
        const watch = watches.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
        if (!watch) return;
        const tokens = trackTokensForSettledReceipt(status, watch.trackOnSuccess, logs);
        const tokenWrite = this.tokenWrite.then(async () => {
          const all = JSON.parse(this.rawTokens) as Record<number, SwapTrackToken[]>;
          const have = all[watch.chainId] ?? [];
          const seen = new Set(have.map((token) => token.address.toLowerCase()));
          const fresh = tokens.filter((token) => !seen.has(token.address.toLowerCase()));
          const next = [...have, ...fresh];
          added = next.slice(have.length);
          this.rawTokens = JSON.stringify({ ...all, [watch.chainId]: next });
        });
        this.tokenWrite = tokenWrite.catch(() => {});
        await tokenWrite;
        this.rawWatches = JSON.stringify(watches.filter((entry) => entry !== watch));
      });
      this.watchWrite = write.catch(() => {});
      await write;
      return added;
    }
  }

  const firstWorker = new QueueFixture();
  await firstWorker.enqueue({
    chainId: 4663,
    hash: HASH,
    queuedAt: 1,
    trackOnSuccess: normalizeSwapTrackTokens([
      { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: ATTACKER },
    ], RECIPIENT, 'bind'),
  });

  const restartedWorker = new QueueFixture(firstWorker.rawWatches, firstWorker.rawTokens);
  assert.deepEqual(await restartedWorker.settle(HASH, 'reverted', [transferLog(RECIPIENT, 10n)]), []);
  assert.deepEqual(JSON.parse(restartedWorker.rawTokens), { 4663: [] });
  assert.deepEqual(restartedWorker.read(), []);

  await restartedWorker.enqueue({
    chainId: 4663,
    hash: HASH,
    queuedAt: 2,
    trackOnSuccess: normalizeSwapTrackTokens([
      { address: TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18, recipient: ATTACKER },
    ], RECIPIENT, 'bind'),
  });
  assert.deepEqual(await restartedWorker.settle(HASH, 'success', [transferLog(RECIPIENT, 10n)]), [{
    address: TOKEN,
    symbol: 'NEW',
    name: 'New Token',
    decimals: 18,
  }]);
  assert.deepEqual(JSON.parse(restartedWorker.rawTokens), {
    4663: [{
      address: TOKEN,
      symbol: 'NEW',
      name: 'New Token',
      decimals: 18,
    }],
  });
  assert.deepEqual(restartedWorker.read(), []);
});
