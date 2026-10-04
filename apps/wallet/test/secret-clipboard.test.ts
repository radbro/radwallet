import assert from 'node:assert/strict';
import test from 'node:test';
import { SecretClipboard, type SecretClipboardStatus } from '../src/secret-clipboard.js';

function fixture() {
  let text = '';
  let denyRead = false;
  let denyWrite = false;
  const states: SecretClipboardStatus[] = [];
  const clipboard = {
    async readText() {
      if (denyRead) throw new Error('clipboard read denied');
      return text;
    },
    async writeText(next: string) {
      if (denyWrite) throw new Error('clipboard write denied');
      text = next;
    },
  };
  return {
    clipboard, states,
    read: () => text,
    replace: (next: string) => { text = next; },
    denyRead: () => { denyRead = true; },
    denyWrite: (next = true) => { denyWrite = next; },
  };
}

test('the copied secret clears after the timer while the view remains open', async () => {
  const f = fixture();
  let cleared!: () => void;
  const done = new Promise<void>((resolve) => { cleared = resolve; });
  const copy = new SecretClipboard(f.clipboard, (state) => {
    f.states.push(state);
    if (state === 'cleared') cleared();
  }, 1);
  await copy.copy('fixture-secret');
  assert.equal(f.read(), 'fixture-secret');
  await done;
  assert.equal(f.read(), '');
  assert.deepEqual(f.states, ['copied', 'cleared']);
  await copy.dispose();
});

test('automatic and lifecycle cleanup preserve a newer clipboard item', async () => {
  const f = fixture();
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  await copy.copy('fixture-secret');
  f.replace('an address copied afterward');
  assert.equal(await copy.clearIfUnchanged(), 'replaced');
  await copy.dispose();
  assert.equal(f.read(), 'an address copied afterward');
});

test('closing the reveal clears its unchanged clipboard and stops UI notifications', async () => {
  const f = fixture();
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  await copy.copy('fixture-secret');
  await copy.dispose();
  assert.equal(f.read(), '');
  assert.deepEqual(f.states, ['copied']);
});

test('explicit clear works when clipboard reading is denied', async () => {
  const f = fixture();
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  await copy.copy('fixture-secret');
  f.denyRead();
  assert.equal(await copy.clearIfUnchanged(), 'unavailable');
  assert.equal(f.read(), 'fixture-secret');
  assert.equal(await copy.clear(), 'cleared');
  assert.equal(f.read(), '');
  await copy.dispose();
});

test('failed explicit clearing stays visible and can be retried', async () => {
  const f = fixture();
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  await copy.copy('fixture-secret');
  f.denyWrite();
  assert.equal(await copy.clear(), 'unavailable');
  assert.equal(f.read(), 'fixture-secret');
  f.denyWrite(false);
  assert.equal(await copy.clear(), 'cleared');
  assert.equal(f.read(), '');
  assert.deepEqual(f.states, ['copied', 'unavailable', 'cleared']);
  await copy.dispose();
});

test('a failed copy never reports success or overwrites the prior clipboard', async () => {
  const f = fixture();
  f.replace('keep this');
  f.denyWrite();
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  await assert.rejects(copy.copy('fixture-secret'), /write denied/);
  assert.equal(f.read(), 'keep this');
  assert.deepEqual(f.states, []);
  await copy.dispose();
});

test('a copy completing after close gets an immediate cleanup attempt', async () => {
  let text = '';
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const clipboard = {
    async readText() { return text; },
    async writeText(next: string) {
      if (next) {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      text = next;
    },
  };
  const states: SecretClipboardStatus[] = [];
  const copy = new SecretClipboard(clipboard, (state) => states.push(state));
  const pending = copy.copy('fixture-secret');
  await waiting;
  await copy.dispose();
  release();
  await pending;
  assert.equal(text, '');
  assert.deepEqual(states, []);
});

test('closing before preparation finishes prevents the clipboard write', async () => {
  const f = fixture();
  f.replace('keep this');
  const copy = new SecretClipboard(f.clipboard, (state) => f.states.push(state));
  const pending = copy.copy('fixture-secret');
  await copy.dispose();
  await assert.rejects(pending, /view closed/);
  assert.equal(f.read(), 'keep this');
  assert.deepEqual(f.states, []);
});

test('stale automatic cleanup cannot overwrite content copied after an explicit clear', async () => {
  const f = fixture();
  let release!: (text: string) => void;
  const copy = new SecretClipboard({
    ...f.clipboard,
    readText: () => new Promise<string>((resolve) => { release = resolve; }),
  }, (state) => f.states.push(state));
  await copy.copy('fixture-secret');
  const automatic = copy.clearIfUnchanged();
  assert.equal(await copy.clear(), 'cleared');
  f.replace('newer copy');
  release('fixture-secret');
  assert.equal(await automatic, 'idle');
  assert.equal(f.read(), 'newer copy');
  await copy.dispose();
});

test('closing after a second copy does not reuse an older pending cleanup', async () => {
  const f = fixture();
  let release!: (text: string) => void;
  let reads = 0;
  const copy = new SecretClipboard({
    ...f.clipboard,
    readText: () => ++reads === 1
      ? new Promise<string>((resolve) => { release = resolve; })
      : f.clipboard.readText(),
  }, (state) => f.states.push(state));
  await copy.copy('first fixture secret');
  const oldCleanup = copy.clearIfUnchanged();
  await copy.copy('second fixture secret');
  await copy.dispose();
  assert.equal(f.read(), '');
  release('first fixture secret');
  assert.equal(await oldCleanup, 'idle');
});
