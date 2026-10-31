import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, multicall3Abi, toHex,
} from 'viem';
import { probeToken, withFailover } from '../src/tokens.js';

const TOKEN = '0x3333333333333333333333333333333333333333';
const OWNER = '0x1111111111111111111111111111111111111111' as const;

type Behaviour = 'token' | 'eoa' | 'bytes32-symbol' | 'throttled' | 'rate-limited';

/** a mainnet-shaped node answering multicall3's aggregate3 for one contract */
async function node(behaviour: Behaviour): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params?: [{ data: `0x${string}` }] };
      const send = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...body as object }));
      };
      if (behaviour === 'throttled') {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('too many requests');
        return;
      }
      if (behaviour === 'rate-limited') { send({ error: { code: -32005, message: 'rate limit exceeded' } }); return; }
      if (call.method === 'eth_chainId') { send({ result: '0x1' }); return; }
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.params![0].data });
      const inner = (args[0] as readonly { callData: `0x${string}` }[]).map(({ callData }) => {
        if (behaviour === 'eoa') return { success: true, returnData: '0x' as `0x${string}` };
        const { functionName } = decodeFunctionData({ abi: erc20Abi, data: callData });
        if (functionName === 'symbol' && behaviour === 'bytes32-symbol') {
          // MKR's shape: a bytes32, not a string
          return { success: true, returnData: encodeAbiParameters([{ type: 'bytes32' }], [toHex('MKR', { size: 32 })]) };
        }
        const result = functionName === 'symbol' ? 'TKN'
          : functionName === 'name' ? 'Token'
            : functionName === 'decimals' ? 6
              : 1_234_567n;
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: erc20Abi, functionName: functionName as never, result: result as never }),
        };
      });
      send({ result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: inner }) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test('probe: the contract answering "not a token" is null; the node failing throws', async () => {
  const token = await node('token');
  const eoa = await node('eoa');
  const bytes32 = await node('bytes32-symbol');
  const throttled = await node('throttled');
  const limited = await node('rate-limited');
  try {
    const found = await probeToken(token.url, 1, TOKEN, OWNER);
    assert.equal(found?.token.symbol, 'TKN');
    assert.equal(found?.balance.raw, 1_234_567n);

    // an address with no code answers with no data: the chain's answer
    assert.equal(await probeToken(eoa.url, 1, TOKEN, OWNER), null);
    // a symbol that will not decode as a string is the contract answering
    // oddly, not the node going away — it must not walk the pool
    assert.equal(await probeToken(bytes32.url, 1, TOKEN, OWNER), null);

    await assert.rejects(probeToken(throttled.url, 1, TOKEN, OWNER));
    await assert.rejects(probeToken(limited.url, 1, TOKEN, OWNER));
    await assert.rejects(probeToken('http://127.0.0.1:1', 1, TOKEN, OWNER));

    // which is what lets a pool walk get past a throttled node to an answer
    const walked = await withFailover([throttled.url, token.url], (ep) => probeToken(ep, 1, TOKEN, OWNER));
    assert.equal(walked?.token.symbol, 'TKN');
  } finally {
    for (const n of [token, eoa, bytes32, throttled, limited]) n.server.close();
  }
});
