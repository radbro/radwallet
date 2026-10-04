import assert from 'node:assert/strict';
import test from 'node:test';

type Handler = (message: unknown, sender: unknown, reply: (value: any) => void) => boolean;
let handler!: Handler;
let approvalWindows = 0;
const extensionId = 'wallet-fixture';
const extensionUrl = `chrome-extension://${extensionId}/`;

// Use the callback API that both supported browsers expose.
(globalThis as any).chrome = {
  runtime: {
    id: extensionId,
    getURL: (path: string) => extensionUrl + path,
    onMessage: { addListener: (listener: Handler) => { handler = listener; } },
  },
  storage: { local: { get: (_key: unknown, reply: (value: object) => void) => reply({}) } },
  alarms: { onAlarm: { addListener: () => {} } },
  windows: {
    onRemoved: { addListener: () => {} },
    create: () => { approvalWindows++; },
  },
};
await import('../src/background-entry.js');

function request(message: unknown, sender: unknown): Promise<any> {
  return new Promise((resolve) => handler(message, sender, resolve));
}
const site = { origin: 'https://dapp.example', url: 'https://dapp.example/' };
const wallet = { id: extensionId, url: extensionUrl + 'index.html' };

test('unsupported wallet RPC methods return 4200 without an approval window', async () => {
  for (const method of ['wallet_sendCalls', 'wallet_getCallsStatus']) {
    const response = await request({ type: 'rpc-request', method, params: [] }, site);
    assert.equal(response.code, 4200);
    assert.match(response.error, /not supported/);
  }
  assert.equal(approvalWindows, 0);
});

test('unknown internal session calls fail closed', async () => {
  const response = await request({ t: 'sess.unsupported' }, wallet);
  assert.match(response.error, /unknown session call/);
  assert.equal(response.result, undefined);
  assert.equal(approvalWindows, 0);
});

test('web pages cannot call the internal session API', async () => {
  const response = await request({ t: 'sess.status' }, site);
  assert.equal(response.error, 'session API is wallet-internal');
  assert.equal(response.accounts, undefined);
});
