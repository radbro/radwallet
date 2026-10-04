import test from 'node:test';
import assert from 'node:assert/strict';

const rows = new Map<string, string>();
let failWrites = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => rows.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error('disk said no');
    rows.set(key, value);
  },
  removeItem: (key: string) => rows.delete(key),
} });
const layout = await import('../src/wallet-list.js');
const groups = [
  { id: 'seed-1', kind: 'seed' as const, accountIndex: 0 },
  { id: 'seed-2', kind: 'seed' as const, accountIndex: 3 },
  { id: 'seed-3', kind: 'seed' as const, accountIndex: 4 },
  { id: 'imported', kind: 'imported' as const, accountIndex: 7 },
];
const ids = () => layout.orderedWalletGroups(groups).map((g) => g.id);
test.beforeEach(async () => {
  rows.clear(); failWrites = false;
  await layout.loadWalletList();
});

test('display order preserves source groups, account indices, and imported keys at the end', async () => {
  await layout.moveSeedGroup('seed-3', 'seed-1', 'before', groups);
  assert.deepEqual(ids(), ['seed-3', 'seed-1', 'seed-2', 'imported']);
  assert.deepEqual(groups.map((g) => g.accountIndex), [0, 3, 4, 7]);
  assert.equal(layout.orderedWalletGroups(groups)[0], groups[2]);
  await layout.moveSeedGroup('seed-3', 'seed-2', 'after', groups);
  assert.deepEqual(ids(), groups.map((g) => g.id));
});

test('unknown and duplicate stored IDs cannot hide new seeds or duplicate groups', async () => {
  rows.set('walletList', JSON.stringify({ order: ['gone', 'seed-2', 'seed-2', 'imported', 8], collapsed: [false, 'seed-1', 'seed-1'] }));
  await layout.loadWalletList();
  assert.deepEqual(ids(), ['seed-2', 'seed-1', 'seed-3', 'imported']);
  assert.deepEqual(layout.walletList.value.collapsed, ['seed-1']);
});

test('malformed optional preferences fall back to an expanded vault-ordered list', async () => {
  for (const raw of ['bad json', 'null', '{"order":false,"collapsed":{}}']) {
    rows.set('walletList', raw);
    await layout.loadWalletList();
    assert.deepEqual(ids(), groups.map((g) => g.id));
    assert.deepEqual(layout.walletList.value.collapsed, []);
  }
});

test('overlapping collapse, reorder and reload preserve each edit', async () => {
  await Promise.all([
    layout.toggleWalletGroup('seed-1'),
    layout.moveSeedGroup('seed-3', 'seed-1', 'before', groups),
    layout.loadWalletList(),
    layout.toggleWalletGroup('seed-2'),
  ]);
  assert.deepEqual(ids(), ['seed-3', 'seed-1', 'seed-2', 'imported']);
  assert.deepEqual(layout.walletList.value.collapsed, ['seed-1', 'seed-2']);
  assert.deepEqual(JSON.parse(rows.get('walletList')!), layout.walletList.value);
  await Promise.all([layout.toggleWalletGroup('seed-1'), layout.toggleWalletGroup('seed-1')]);
  assert.deepEqual(layout.walletList.value.collapsed, ['seed-2', 'seed-1']);
});

test('failed writes retain the last saved layout and later edits recover', async () => {
  await layout.toggleWalletGroup('seed-1');
  failWrites = true;
  await assert.rejects(layout.toggleWalletGroup('seed-2'), /disk said no/);
  assert.deepEqual(layout.walletList.value.collapsed, ['seed-1']);
  failWrites = false;
  await layout.toggleWalletGroup('seed-3');
  assert.deepEqual(layout.walletList.value.collapsed, ['seed-1', 'seed-3']);
});

test('reused seed IDs start expanded at the end of the seed list', async () => {
  await layout.moveSeedGroup('seed-3', 'seed-1', 'before', groups);
  await layout.toggleWalletGroup('seed-3');
  await layout.forgetWalletGroupLayout('seed-3');
  assert.deepEqual(ids(), ['seed-1', 'seed-2', 'seed-3', 'imported']);
  assert.deepEqual(layout.walletList.value.collapsed, []);
});

test('imported, removed and self drop targets cannot change seed order', async () => {
  await layout.moveSeedGroup('seed-2', 'seed-1', 'before', groups);
  for (const [from, to] of [['imported', 'seed-1'], ['seed-2', 'gone'], ['seed-1', 'seed-1']]) {
    await layout.moveSeedGroup(from, to, 'after', groups);
    assert.deepEqual(ids(), ['seed-2', 'seed-1', 'seed-3', 'imported']);
  }
});
