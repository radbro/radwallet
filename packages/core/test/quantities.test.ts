import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, erc20Abi, parseAbi, parseUnits, zeroAddress } from 'viem';
import { createServer } from 'node:http';
import { buildTransferTx } from '../src/transfers.js';
import { formatTokenAmount, parseTokenAmount } from '../src/amounts.js';
import { buildBestRouteTx } from '../src/router.js';
import { WETH } from '../src/swap.js';
import { previewDappTx, RAD_TOKEN } from '../src/chain.js';

const owner = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';

test('transfers: refuse quantities that would be rounded before signing', () => {
  for (const [decimals, amount] of [[6, '1.0000009'], [18, '0.0000000000000000009'], [0, '1.9']] as const) {
    assert.throws(() => buildTransferTx(owner, recipient, {
      kind: 'erc20', contract: token, symbol: 'TOKEN', decimals, amount,
    }), /decimal places/);
  }
});

test('transfers: exact quantities survive encoding at 6 and 18 decimals', () => {
  for (const decimals of [6, 18]) {
    const amount = `9007199254740993.${'0'.repeat(decimals - 1)}1`;
    const tx = buildTransferTx(owner, recipient, { kind: 'erc20', contract: token, symbol: 'TOKEN', decimals, amount });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    assert.equal(decoded.args?.[1], 9007199254740993n * 10n ** BigInt(decimals) + 1n);
  }
});

test('authorization amounts: retain every integer and fractional digit', () => {
  assert.equal(formatTokenAmount(9007199254740993000000000000000001n, 18), '9,007,199,254,740,993.000000000000000001');
  assert.equal(formatTokenAmount(1n, 18), '0.000000000000000001');
  assert.equal(formatTokenAmount(9999999n, 6), '9.999999');
  assert.throws(() => parseTokenAmount('1.0000009', 6), /decimal places/);
  assert.throws(() => parseTokenAmount('1e3', 18), /token amount/);
  assert.throws(() => parseTokenAmount('1', NaN), /decimals/);
});

test('house v3 swap: transaction retains the displayed input, recipient and exact minimum', () => {
  const minOut = 9007199254740993000000000000000001n;
  const tx = buildBestRouteTx({ best: 'v3', v4: null, v3: {
    amountInEth: '0.100000000000000001', amountOut: minOut + 100n,
    amountOutFormatted: 'not used for signing', minOut, minOutFormatted: 'not used for signing',
    feeTier: 10000, feeTierPct: '1.00%', slippagePct: 1,
  } }, owner, 0n);
  const decoded = decodeFunctionData({ abi: parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  ]), data: tx.data! });
  const params = decoded.args[0];
  assert.equal(params.recipient, owner);
  assert.equal(params.tokenIn, WETH);
  assert.equal(params.tokenOut, RAD_TOKEN.address);
  assert.equal(params.amountIn, parseUnits('0.100000000000000001', 18));
  assert.equal(BigInt(tx.value!), params.amountIn);
  assert.equal(params.amountOutMinimum, minOut);
});

test('house v4 swap: exact input and minimum survive the router action encoding', () => {
  const minOut = 1_000_000_000_000_000_001n;
  const tx = buildBestRouteTx({ best: 'v4', v3: null, v4: {
    protocol: 'v4', amountInEth: '0.100000000000000001', amountOut: minOut + 100n,
    amountOutFormatted: 'not used', minOut, minOutFormatted: 'not used',
    poolKey: { currency0: zeroAddress, currency1: RAD_TOKEN.address, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    feeTierPct: '0.30%', slippagePct: 1,
  } }, owner, 1234n);
  const outer = decodeFunctionData({ abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']), data: tx.data! });
  assert.equal(outer.args[2], 1234n);
  const [, actions] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], outer.args[1][0]);
  const [, takeMinimum] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], actions[2]);
  assert.equal(takeMinimum, minOut);
  assert.equal(BigInt(tx.value!), 100_000_000_000_000_001n);
});

test('transaction preview: one wei of value or gas never displays as zero', async () => {
  const rpc = createServer(async (request, response) => {
    let json = '';
    for await (const chunk of request) json += chunk;
    const body = JSON.parse(json);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_call' ? '0x' : '0x1' }));
  });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  try {
    const address = rpc.address() as { port: number };
    const preview = await previewDappTx(`http://127.0.0.1:${address.port}`, owner, { to: recipient, value: '0x1' });
    assert.equal(preview.ok, true);
    assert.equal(preview.out[0].amount, '0.000000000000000001');
    assert.equal(preview.gasEth, '0.000000000000000001');
  } finally {
    rpc.closeAllConnections();
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
  }
});
