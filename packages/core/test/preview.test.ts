import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { previewDappTx, previewDappTxAcross } from '../src/chain.js';

const FROM = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const TX = { to: TO, data: '0x' as const, value: '0x0' };

type Behaviour = 'ok' | 'revert' | 'broke' | 'throttled';

/**
 * A JSON-RPC node with one behaviour for eth_call. 'revert' is the chain
 * answering (code 3, the way geth and anvil report a revert); 'throttled' is a
 * 429, 'broke' a JSON-RPC rate-limit error inside a 200 — both the node.
 */
async function node(behaviour: Behaviour): Promise<{ url: string; calls: string[]; server: Server }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string };
      calls.push(call.method);
      if (behaviour === 'throttled') {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('too many requests');
        return;
      }
      const reply = call.method === 'eth_call' && behaviour === 'revert'
        ? { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted', data: '0x' } }
        : behaviour === 'broke'
          ? { jsonrpc: '2.0', id: call.id, error: { code: -32005, message: 'rate limit exceeded' } }
          : call.method === 'eth_estimateGas'
            ? { jsonrpc: '2.0', id: call.id, result: '0x5208' }
            : call.method === 'eth_gasPrice'
              ? { jsonrpc: '2.0', id: call.id, result: '0x3b9aca00' }
              : { jsonrpc: '2.0', id: call.id, result: '0x' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

test('preview: a revert is the chain answering, a dead or throttled node is not', async () => {
  const reverting = await node('revert');
  const broke = await node('broke');
  const throttled = await node('throttled');
  try {
    const r = await previewDappTx(reverting.url, FROM, TX);
    assert.equal(r.ok, false);
    assert.equal(r.failure, 'revert');

    const b = await previewDappTx(broke.url, FROM, TX);
    assert.equal(b.ok, false);
    assert.equal(b.failure, 'node');

    const t = await previewDappTx(throttled.url, FROM, TX);
    assert.equal(t.ok, false);
    assert.equal(t.failure, 'node');

    const dead = await previewDappTx('http://127.0.0.1:1', FROM, TX);
    assert.equal(dead.ok, false);
    assert.equal(dead.failure, 'node');
  } finally {
    reverting.server.close(); broke.server.close(); throttled.server.close();
  }
});

test('preview: the pool walk asks the next node after a node failure, and stops at a revert', async () => {
  const broke = await node('broke');
  const healthy = await node('ok');
  const reverting = await node('revert');
  try {
    // a node that did not answer must not decide: the next one does
    const passed = await previewDappTxAcross([broke.url, healthy.url], FROM, TX);
    assert.equal(passed.ok, true);
    assert.ok(healthy.calls.includes('eth_call'));

    // a revert is every node's answer: nobody after it is asked
    const before = healthy.calls.length;
    const refused = await previewDappTxAcross([reverting.url, healthy.url], FROM, TX);
    assert.equal(refused.ok, false);
    assert.equal(refused.failure, 'revert');
    assert.equal(healthy.calls.length, before);

    // nobody answered: that is a node failure, not "this would fail"
    const nobody = await previewDappTxAcross([broke.url, 'http://127.0.0.1:1'], FROM, TX);
    assert.equal(nobody.ok, false);
    assert.equal(nobody.failure, 'node');

    const empty = await previewDappTxAcross([], FROM, TX);
    assert.equal(empty.failure, 'node');
  } finally {
    broke.server.close(); healthy.server.close(); reverting.server.close();
  }
});
