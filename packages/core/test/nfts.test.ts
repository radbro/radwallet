import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readCollectionTokenIdPageWithClient,
  verifyCollectionTokenIdWithClient,
  type NftHolding,
} from '../src/nfts.js';

const owner = '0x1111111111111111111111111111111111111111' as const;
const other = '0x2222222222222222222222222222222222222222' as const;
const collection = '0x3333333333333333333333333333333333333333' as const;

function holding(patch: Partial<NftHolding> = {}): NftHolding {
  return {
    chainId: 1,
    address: collection,
    name: 'Collection',
    symbol: 'COL',
    count: 30,
    tokenIds: Array.from({ length: 24 }, (_, i) => String(i + 1)),
    enumerable: true,
    idSource: 'enumerable',
    idsComplete: false,
    idCursor: 24,
    tokenUris: {},
    ...patch,
  };
}

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    async multicall(args: { contracts: readonly { functionName: string; args?: readonly unknown[] }[] }) {
      return args.contracts.map((call) => {
        calls.push(`${call.functionName}:${String(call.args?.[1] ?? call.args?.[0] ?? '')}`);
        if (call.functionName === 'tokenOfOwnerByIndex') {
          return { status: 'success' as const, result: BigInt(Number(call.args![1]) + 1) };
        }
        if (call.functionName === 'ownerOf') {
          return { status: 'success' as const, result: String(call.args![0]) === '29' ? owner : other };
        }
        if (call.functionName === 'tokenURI') {
          return { status: 'success' as const, result: `ipfs://metadata/${String(call.args![0])}` };
        }
        return { status: 'failure' as const };
      });
    },
  };
}

test('nfts: enumerable collections can load the next owned token-id page', async () => {
  const client = fakeClient();
  const page = await readCollectionTokenIdPageWithClient(client, owner, holding());

  assert.deepEqual(page.tokenIds, ['25', '26', '27', '28', '29', '30']);
  assert.equal(page.complete, true);
  assert.equal(page.nextCursor, 30);
  assert.equal(page.tokenUris['29'], 'ipfs://metadata/29');
});


test('nfts: manual token-id checks do not advance enumerable page cursor', async () => {
  const client = fakeClient();
  const page = await readCollectionTokenIdPageWithClient(
    client,
    owner,
    holding({ tokenIds: [...holding().tokenIds, '29'], idCursor: 24 }),
  );

  assert.deepEqual(page.tokenIds, ['25', '26', '27', '28', '29', '30']);
  assert.equal(page.nextCursor, 30);
  assert.ok(client.calls.includes('tokenOfOwnerByIndex:24'));
});

test('nfts: manual token-id checks add only ids owned by this wallet', async () => {
  const client = fakeClient();
  assert.deepEqual(
    await verifyCollectionTokenIdWithClient(client, owner, holding({ enumerable: false }), '29'),
    { tokenId: '29', tokenUri: 'ipfs://metadata/29' },
  );
  await assert.rejects(
    verifyCollectionTokenIdWithClient(client, owner, holding({ enumerable: false }), '30'),
    /not owned/,
  );
  await assert.rejects(
    verifyCollectionTokenIdWithClient(client, owner, holding({ enumerable: false }), '29.5'),
    /whole number/,
  );
});

test('nfts: a failed page stays retryable at its first missing index', async () => {
  const client = fakeClient();
  const page = await readCollectionTokenIdPageWithClient({
    async multicall(args) {
      const results = await client.multicall(args);
      return results.map((result, i) => args.contracts[i].functionName === 'tokenOfOwnerByIndex'
        && args.contracts[i].args?.[1] === 26n ? { status: 'failure', error: new Error('temporary failure') } : result);
    },
  }, owner, holding());
  assert.equal(page.complete, false);
  assert.equal(page.nextCursor, 26);
  assert.deepEqual(page.tokenIds, ['25', '26', '28', '29', '30']);
  const retried = await readCollectionTokenIdPageWithClient(client, owner, holding({ idCursor: page.nextCursor }));
  assert.deepEqual(retried.tokenIds, ['27', '28', '29', '30']);
  assert.equal(retried.complete, true);
});

test('nfts: manual IDs use one canonical uint256 value before calling RPC', async () => {
  const client = fakeClient();
  const found = await verifyCollectionTokenIdWithClient(client, owner, holding(), '00029');
  assert.equal(found.tokenId, '29');
  const calls = client.calls.length;
  await assert.rejects(verifyCollectionTokenIdWithClient(client, owner, holding(), (1n << 256n).toString()), /too large/);
  assert.equal(client.calls.length, calls);
});
