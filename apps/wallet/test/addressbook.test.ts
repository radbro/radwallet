import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';

class MemoryStorage {
  private rows = new Map<string, string>();
  failWrites = false;
  failReads = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('disk went away');
    return this.rows.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('disk said no');
    this.rows.set(key, String(value));
  }

  removeItem(key: string): void {
    this.rows.delete(key);
  }

  clear(): void {
    this.rows.clear();
    this.failWrites = false;
    this.failReads = false;
  }
}

const local = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true });

const addressbook = await import('../src/addressbook.js');

const ONE = getAddress('0x1234567890abcdef1234567890abcdef12345678') as `0x${string}`;
const TWO = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd') as `0x${string}`;

function badChecksum(address: string): string {
  const chars = [...address];
  const index = chars.findIndex((char, i) => i > 1 && /[a-fA-F]/.test(char));
  chars[index] = chars[index] === chars[index].toLowerCase()
    ? chars[index].toUpperCase()
    : chars[index].toLowerCase();
  return chars.join('');
}

test.beforeEach(() => {
  local.clear();
  addressbook.savedContacts.value = [];
});

test('address book validates checksums, labels, and case-insensitive dedupe', async () => {
  await addressbook.saveContact(ONE.toLowerCase(), '  Alice  ');
  await addressbook.saveContact(ONE, 'Treasury');

  assert.deepEqual(addressbook.savedContacts.value, [{ address: ONE, label: 'Treasury' }]);
  assert.equal(local.getItem('addressBook'), JSON.stringify([{ address: ONE, label: 'Treasury' }]));

  await assert.rejects(
    addressbook.saveContact(badChecksum(ONE), 'Typo'),
    /invalid address or checksum/,
  );
  await assert.rejects(addressbook.saveContact(TWO, '   '), /label is required/);
  await assert.rejects(addressbook.saveContact(TWO, 'x'.repeat(81)), /80 characters/);
  await assert.rejects(addressbook.saveContact(TWO, 'Bob\u202E'), /invisible control/);
});

test('address book boot reads skip malformed rows and keep the last duplicate label', async () => {
  local.setItem('addressBook', JSON.stringify([
    { address: ONE.toLowerCase(), label: 'First' },
    { address: 'nope', label: 'Bad' },
    { address: TWO, label: '   ' },
    { address: ONE, label: 'Second' },
    null,
  ]));

  await addressbook.loadAddressBook();

  assert.deepEqual(addressbook.savedContacts.value, [{ address: ONE, label: 'Second' }]);
});

test('address book tolerates corrupt reads but refuses to overwrite corrupt storage', async () => {
  local.setItem('addressBook', 'not json');
  await addressbook.loadAddressBook();

  assert.deepEqual(addressbook.savedContacts.value, []);
  await assert.rejects(addressbook.saveContact(ONE, 'Alice'), /storage is corrupt/);
  assert.equal(local.getItem('addressBook'), 'not json');
  assert.deepEqual(addressbook.savedContacts.value, []);
});

test('address book publishes signal changes only after a successful write', async () => {
  await addressbook.saveContact(ONE, 'Alice');
  local.failWrites = true;

  await assert.rejects(addressbook.saveContact(TWO, 'Bob'), /disk said no/);

  assert.deepEqual(addressbook.savedContacts.value, [{ address: ONE, label: 'Alice' }]);
  assert.equal(local.getItem('addressBook'), JSON.stringify([{ address: ONE, label: 'Alice' }]));
});

test('address book failed refresh retains last successful signal state', async () => {
  await addressbook.saveContact(ONE, 'Alice');
  local.failReads = true;

  await assert.rejects(addressbook.loadAddressBook(), /disk went away/);

  assert.deepEqual(addressbook.savedContacts.value, [{ address: ONE, label: 'Alice' }]);
});

test('address book remove validates addresses and persists removals', async () => {
  await addressbook.saveContact(ONE, 'Alice');
  await addressbook.saveContact(TWO, 'Bob');
  await addressbook.removeContact(ONE.toLowerCase());

  assert.deepEqual(addressbook.savedContacts.value, [{ address: TWO, label: 'Bob' }]);
  assert.equal(local.getItem('addressBook'), JSON.stringify([{ address: TWO, label: 'Bob' }]));
});

test('overlapping saves and refreshes preserve both contacts and the latest label', async () => {
  await Promise.all([
    addressbook.saveContact(ONE, 'Alice'),
    addressbook.loadAddressBook(),
    addressbook.saveContact(TWO, 'Bob'),
    addressbook.saveContact(ONE, 'Treasury'),
  ]);

  const expected = [{ address: ONE, label: 'Treasury' }, { address: TWO, label: 'Bob' }];
  assert.deepEqual(addressbook.savedContacts.value, expected);
  assert.deepEqual(JSON.parse(local.getItem('addressBook')!), expected);
});
