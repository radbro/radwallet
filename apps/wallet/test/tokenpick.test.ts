import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'viem';
import {
  completeAddressInput,
  fullContractQuery,
  mergeEphemeralPickItems,
  shortContract,
  sideKeyOf,
  type PickItem,
} from '../src/screens/tokenpick-utils.ts';

const LOWER = '0xddc6625feca10438857dd8660c021cd1088806fb';
const CHECKSUM = getAddress(LOWER);

test('contract paste: lowercase addresses are accepted and checksummed', () => {
  assert.equal(fullContractQuery(LOWER), CHECKSUM);
  assert.equal(fullContractQuery(`  ${LOWER}  `), CHECKSUM);
  assert.equal(completeAddressInput(LOWER), true);
  assert.equal(shortContract(CHECKSUM), '0xdDc6…06FB');
});

test('contract paste: bad mixed-case addresses are refused before lookup', () => {
  const bad = `0x${CHECKSUM.slice(2).replace('d', 'D')}`;
  assert.equal(fullContractQuery(bad), null);
  assert.equal(completeAddressInput(bad), true);
  assert.equal(fullContractQuery('0x1234'), null);
  assert.equal(completeAddressInput('0x1234'), false);
});

test('contract paste: ephemeral tokens join the picker without mutating the source list', () => {
  const source: PickItem[] = [
    { address: null, symbol: 'ETH', decimals: 18 },
    { address: '0x1111111111111111111111111111111111111111', symbol: 'AAA', decimals: 18 },
  ];
  const pasted: PickItem = {
    address: CHECKSUM,
    symbol: 'RAD',
    name: 'Radcoin impostor name collision test',
    decimals: 18,
    amount: '0',
    raw: 0n,
  };

  const merged = mergeEphemeralPickItems(source, [pasted]);

  assert.equal(source.length, 2, 'pasted CA is not pre-added to the tracked source list');
  assert.equal(merged.length, 3);
  assert.equal(sideKeyOf(merged[2]!), CHECKSUM.toLowerCase(), 'selection key stays the pasted contract');
  assert.equal(merged[2]!.address, CHECKSUM, 'quote uses the resolved contract address');
  assert.equal(merged[2]!.raw, 0n, 'sell-side balance read can be displayed even at zero');
});

test('contract paste: stale duplicate lookups cannot replace an already-listed token', () => {
  const source: PickItem[] = [
    { address: null, symbol: 'ETH', decimals: 18 },
    { address: CHECKSUM, symbol: 'RAD', name: 'Radcoin', decimals: 18 },
  ];
  const stale: PickItem = {
    address: CHECKSUM,
    symbol: 'FAKE',
    name: 'stale lookup',
    decimals: 6,
    amount: '999',
    raw: 999n,
  };

  const merged = mergeEphemeralPickItems(source, [stale]);

  assert.equal(merged.length, source.length);
  assert.equal(merged[1]!.symbol, 'RAD');
  assert.equal(merged[1]!.decimals, 18);
});
