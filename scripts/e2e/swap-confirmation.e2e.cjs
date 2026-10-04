/**
 * Deterministic background confirmation regression. Run after npm run build.
 * Loads the real built extension background in a VM with mocked extension APIs
 * and intercepted JSON-RPC receipts. No keys, signing, broadcasts, or network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const backgroundPath = process.env.SWAP_CONFIRMATION_BACKGROUND
  ? path.resolve(process.env.SWAP_CONFIRMATION_BACKGROUND)
  : path.resolve(__dirname, '../../apps/wallet/dist-bg/background.js');

const chainId = 4663;
const hash = `0x${'a'.repeat(64)}`;
const successHash = `0x${'b'.repeat(64)}`;
const revertedHash = `0x${'c'.repeat(64)}`;
const wrongRecipientHash = `0x${'d'.repeat(64)}`;
const token = '0x2222222222222222222222222222222222222222';
const recipient = '0x1111111111111111111111111111111111111111';
const otherRecipient = '0x3333333333333333333333333333333333333333';
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function padAddress(address) {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function transferLog(to, overrides = {}) {
  return {
    address: token,
    data: `0x${1n.toString(16).padStart(64, '0')}`,
    topics: [
      transferTopic,
      padAddress('0x0000000000000000000000000000000000000000'),
      padAddress(to),
    ],
    blockHash: `0x${'1'.repeat(64)}`,
    blockNumber: '0x1',
    transactionHash: overrides.transactionHash ?? hash,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

function receipt(transactionHash, status, logs) {
  return {
    transactionHash,
    transactionIndex: '0x0',
    blockHash: `0x${'1'.repeat(64)}`,
    blockNumber: '0x1',
    from: recipient,
    to: '0x4444444444444444444444444444444444444444',
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs,
    logsBloom: `0x${'0'.repeat(512)}`,
    status,
    type: '0x2',
  };
}

function watch(transactionHash = hash, to = recipient) {
  return {
    chainId,
    hash: transactionHash,
    queuedAt: Date.now(),
    trackOnSuccess: [{
      address: token,
      symbol: 'BOUGHT',
      name: 'Bought Token',
      decimals: 18,
      recipient: to,
    }],
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = predicate();
    if (last) return last;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function parseStoredJson(store, key, fallback) {
  const raw = store[key];
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storageArea(store) {
  return {
    get(key, callback) {
      if (key == null) {
        callback({ ...store });
        return;
      }
      if (Array.isArray(key)) {
        callback(Object.fromEntries(key.map((name) => [name, store[name]])));
        return;
      }
      if (typeof key === 'object') {
        callback(Object.fromEntries(Object.keys(key).map((name) => [
          name,
          store[name] === undefined ? key[name] : store[name],
        ])));
        return;
      }
      callback({ [key]: store[key] });
    },
    set(items, callback) {
      Object.assign(store, items);
      callback?.();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      callback?.();
    },
    clear(callback) {
      for (const key of Object.keys(store)) delete store[key];
      callback?.();
    },
  };
}

function makeRuntime({ localStore, receipts }) {
  const code = fs.readFileSync(backgroundPath, 'utf8');
  assert.match(code, /trackOnSuccess/, 'built background is missing swap tracking metadata; run npm run build first');
  assert.match(code, /wallet-tokens-tracked/, 'built background is missing tracked-token notifications; run npm run build first');

  const sessionStore = {};
  const runtimeListeners = [];
  const alarmListeners = [];
  const messages = [];
  const notifications = [];
  const fetches = [];

  const chrome = {
    runtime: {
      id: 'swap-confirmation-fixture',
      lastError: undefined,
      getURL: (asset) => `chrome-extension://swap-confirmation-fixture/${asset}`,
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
        removeListener(listener) {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        },
      },
      sendMessage(message, callback) {
        messages.push(message);
        callback?.();
      },
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(sessionStore),
    },
    alarms: {
      created: [],
      create(name, options) {
        chrome.alarms.created.push({ name, options });
      },
      clear(name, callback) {
        chrome.alarms.created = chrome.alarms.created.filter((entry) => entry.name !== name);
        callback?.(true);
      },
      onAlarm: {
        addListener(listener) { alarmListeners.push(listener); },
        removeListener(listener) {
          const index = alarmListeners.indexOf(listener);
          if (index >= 0) alarmListeners.splice(index, 1);
        },
      },
    },
    notifications: {
      create(id, options, callback) {
        notifications.push({ id, options });
        callback?.(id);
      },
    },
    tabs: {
      query(_query, callback) { callback([]); },
      sendMessage(_tabId, _message, callback) { callback?.(); },
    },
    windows: {
      create(_options, callback) { callback?.({ id: 1 }); },
      remove(_id, callback) { callback?.(); },
      onRemoved: {
        addListener() {},
        removeListener() {},
      },
    },
  };

  const context = {
    AbortController,
    AbortSignal,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    chrome,
    clearInterval,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: async (_url, init) => {
      const request = JSON.parse(init?.body ?? '{}');
      fetches.push(request);
      let result = null;
      if (request.method === 'eth_getTransactionReceipt') {
        result = receipts.get(String(request.params?.[0]).toLowerCase()) ?? null;
      } else if (request.method === 'eth_chainId') {
        result = `0x${chainId.toString(16)}`;
      } else {
        throw new Error(`unexpected JSON-RPC method ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
    Headers,
    indexedDB: {
      open() {
        const request = {};
        setTimeout(() => {
          request.onerror?.({ target: request });
        }, 0);
        return request;
      },
    },
    navigator: { language: 'en-US' },
    queueMicrotask,
    Request,
    Response,
    setInterval,
    setTimeout,
    structuredClone,
    TextDecoder,
    TextEncoder,
    URL,
  };
  context.globalThis = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: backgroundPath });

  return {
    chrome,
    fetches,
    messages,
    notifications,
    async triggerConfirmationAlarm() {
      for (const listener of alarmListeners) listener({ name: 'radtx-confirmations' });
      await delay(0);
    },
  };
}

function storedTokenCount(store) {
  const customTokens = parseStoredJson(store, 'customTokens', {});
  return Array.isArray(customTokens[chainId]) ? customTokens[chainId].length : 0;
}

async function runPendingThenRestartSuccess() {
  const localStore = { confirmationWatches: JSON.stringify([watch(successHash)]) };
  const pendingReceipts = new Map();
  const firstRuntime = makeRuntime({ localStore, receipts: pendingReceipts });
  await firstRuntime.triggerConfirmationAlarm();
  await delay(100);
  assert.equal(storedTokenCount(localStore), 0, 'queued tracking must not add a token before a receipt exists');
  assert.equal(parseStoredJson(localStore, 'confirmationWatches', []).length, 1, 'pending watch must stay durable');
  assert.equal(firstRuntime.messages.some((message) => message?.type === 'wallet-tokens-tracked'), false, 'pending watch must not notify token tracking');

  const successReceipt = receipt(successHash, '0x1', [transferLog(recipient, { transactionHash: successHash })]);
  const secondRuntime = makeRuntime({
    localStore,
    receipts: new Map([[successHash.toLowerCase(), successReceipt]]),
  });
  await secondRuntime.triggerConfirmationAlarm();
  await waitFor(() => storedTokenCount(localStore) === 1, 'tracked token write after restarted background');
  await waitFor(
    () => parseStoredJson(localStore, 'confirmationWatches', []).length === 0,
    'settled success watch removal after notification callback',
  );
  assert.equal(secondRuntime.messages.filter((message) => message?.type === 'wallet-tokens-tracked').length, 1, 'success must send one tracked-token update');
  assert.equal(secondRuntime.notifications.some((notice) => notice.options?.title === 'RADWALLET · TX CONFIRMED'), true, 'success must still notify after token metadata is preserved');
}

async function runSettledNoTrackCase(transactionHash, storedWatch, storedReceipt, label) {
  const localStore = { confirmationWatches: JSON.stringify([storedWatch]) };
  const runtime = makeRuntime({
    localStore,
    receipts: new Map([[transactionHash.toLowerCase(), storedReceipt]]),
  });
  await runtime.triggerConfirmationAlarm();
  await waitFor(() => parseStoredJson(localStore, 'confirmationWatches', []).length === 0, `${label} watch removal`);
  assert.equal(storedTokenCount(localStore), 0, `${label} must not add a token`);
  assert.equal(runtime.messages.some((message) => message?.type === 'wallet-tokens-tracked'), false, `${label} must not notify token tracking`);
}

(async () => {
  assert.ok(fs.existsSync(backgroundPath), 'build the extension background before running swap-confirmation.e2e.cjs');

  await runPendingThenRestartSuccess();
  console.log('PASS pending/restart/success: queued metadata survives restart and only successful recipient Transfer adds token');

  await runSettledNoTrackCase(
    revertedHash,
    watch(revertedHash),
    receipt(revertedHash, '0x0', [transferLog(recipient, { transactionHash: revertedHash })]),
    'reverted receipt',
  );
  console.log('PASS reverted: successful-looking Transfer log is ignored when receipt status failed');

  await runSettledNoTrackCase(
    wrongRecipientHash,
    watch(wrongRecipientHash),
    receipt(wrongRecipientHash, '0x1', [transferLog(otherRecipient, { transactionHash: wrongRecipientHash })]),
    'wrong-recipient receipt',
  );
  console.log('PASS wrong recipient: successful receipt without recipient Transfer does not add token');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
