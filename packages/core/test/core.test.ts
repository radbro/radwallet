import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics,
  encodeFunctionResult, erc20Abi, multicall3Abi, offchainLookupAbiItem, toHex,
} from 'viem';
import {
  sealVault, openVault, openVaultKeyed, resealVault, isVaultBlob, VAULT_VERSION,
} from '../src/vault.js';
import {
  type VaultSecret,
  newMnemonic, validateMnemonic, deriveAccount, listAccounts, normalizeSecret, newSecret,
  normalizePrivateKey, addressOfPrivateKey, accountAt, seedOf, allLabels,
  addHdAccount, addSeedGroup, addImportedKey, editAccount, renameGroup,
  removeSeedGroup, removeImported,
} from '../src/keyring.js';
import {
  defaultPool, endpointFor, rotate, coverage, normalizeEndpoint, isLoopback, retireEndpoints,
  summarizeRpcError, alchemyWebSocketEndpoint,
} from '../src/rpc.js';

// the well-known test mnemonic (anvil/hardhat dev seed) and its account 0
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const TEST_ADDR0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TEST_ADDR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// account 0's private key, and a second well-known dev key that is NOT in the seed
const TEST_PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LOOSE_PRIV = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const LOOSE_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const OTHER_ADDR0 = '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25';

test('vault: seal/open roundtrip', async () => {
  const blob = await sealVault({ mnemonic: TEST_MNEMONIC, accountCount: 1 }, 'hunter2');
  assert.equal(blob.v, 1);
  const secret = await openVault<{ mnemonic: string }>(blob, 'hunter2');
  assert.equal(secret.mnemonic, TEST_MNEMONIC);
});

test('vault: wrong password rejects', async () => {
  const blob = await sealVault({ mnemonic: TEST_MNEMONIC }, 'hunter2');
  await assert.rejects(() => openVault(blob, 'hunter3'), /WRONG_PASSWORD/);
});

/**
 * A vault this build cannot open must not be reported as a wrong password.
 * The two are indistinguishable to AES-GCM, and the wrong one sends a person
 * looking for their seed phrase over a version mismatch.
 */
test('vault: an unsupported layout is refused as unsupported, not as a bad password', async () => {
  const blob = await sealVault({ mnemonic: TEST_MNEMONIC }, 'hunter2');
  await assert.rejects(
    () => openVault({ ...blob, v: (VAULT_VERSION + 1) as 1 }, 'hunter2'),
    /VAULT_UNSUPPORTED/,
  );
  await assert.rejects(
    () => openVault({ ...blob, kdf: 'scrypt' as 'PBKDF2-SHA256' }, 'hunter2'),
    /VAULT_UNSUPPORTED/,
  );
});

/**
 * The iteration count comes off disk, so a damaged blob claiming a billion
 * rounds would otherwise wedge the unlock screen with no way back. Refusing it
 * has to be instant — this test would time out if the guard were missing.
 */
test('vault: an absurd iteration count is refused instead of derived', async () => {
  const blob = await sealVault({ mnemonic: TEST_MNEMONIC }, 'hunter2');
  const started = Date.now();
  await assert.rejects(() => openVault({ ...blob, iters: 1e12 }, 'hunter2'), /VAULT_UNSUPPORTED/);
  assert.ok(Date.now() - started < 1000, 'refusal must not pay for the derivation');
});

test('vault: junk off disk is not mistaken for a vault', async () => {
  const blob = await sealVault({ mnemonic: TEST_MNEMONIC }, 'hunter2');
  assert.equal(isVaultBlob(blob), true);
  for (const bad of [null, undefined, 42, 'vault', {}, { ...blob, ct: '' }, { ...blob, iters: 0 },
    { ...blob, iters: 1.5 }, { ...blob, salt: 7 }]) {
    assert.equal(isVaultBlob(bad), false, JSON.stringify(bad ?? String(bad)));
  }
  // a well-formed blob from a FUTURE build still parses — that is what lets the
  // unlock screen say "too new" instead of "corrupt"
  assert.equal(isVaultBlob({ ...blob, v: 2 }), true);
  await assert.rejects(() => openVault({ ct: 'x' } as never, 'hunter2'), /VAULT_CORRUPT/);
});

test('keyring: BIP-44 derivation matches known vectors', () => {
  assert.equal(deriveAccount(TEST_MNEMONIC, 0).address, TEST_ADDR0);
  assert.equal(deriveAccount(TEST_MNEMONIC, 1).address, TEST_ADDR1);
});

test('keyring: generated mnemonics validate; garbage does not', () => {
  const m = newMnemonic();
  assert.equal(m.split(' ').length, 12);
  assert.ok(validateMnemonic(m));
  assert.ok(!validateMnemonic('radbro radbro radbro radbro radbro radbro'));
});

test('keyring: listAccounts derives sequential accounts', () => {
  const accts = listAccounts(normalizeSecret({ mnemonic: TEST_MNEMONIC, accountCount: 2 }));
  assert.deepEqual(
    accts.map((a) => a.address),
    [TEST_ADDR0, TEST_ADDR1],
  );
});

// ---- v0.7: many wallets in one vault ----

test('keyring: a pre-multi-wallet vault migrates to a single seed group', () => {
  const s = normalizeSecret({ mnemonic: TEST_MNEMONIC, accountCount: 3 });
  assert.equal(s.seeds.length, 1);
  assert.equal(s.seeds[0].id, 'seed-1');
  assert.equal(s.seeds[0].accounts.length, 3);
  assert.deepEqual(s.imported, []);
  // and it is idempotent — normalizing the new shape changes nothing
  assert.deepEqual(normalizeSecret(s), s);
});

test('keyring: private keys normalize, validate, and reject garbage', () => {
  assert.equal(normalizePrivateKey(TEST_PRIV.slice(2)), TEST_PRIV); // 0x optional
  assert.equal(normalizePrivateKey(`  ${TEST_PRIV.toUpperCase()} `), TEST_PRIV);
  assert.equal(addressOfPrivateKey(TEST_PRIV), TEST_ADDR0);
  assert.throws(() => normalizePrivateKey('0xdeadbeef'), /32-byte/);
  assert.throws(() => normalizePrivateKey(`0x${'0'.repeat(64)}`), /curve/);
});

test('keyring: seed groups and loose keys share one flat index space', () => {
  let s = newSecret(TEST_MNEMONIC);
  s = addHdAccount(s, 'seed-1');
  s = addSeedGroup(s, OTHER_MNEMONIC, 'burner');
  s = addImportedKey(s, LOOSE_PRIV, 'cold');

  const accts = listAccounts(s);
  assert.deepEqual(accts.map((a) => a.index), [0, 1, 2, 3]);
  assert.deepEqual(accts.map((a) => a.kind), ['hd', 'hd', 'hd', 'imported']);
  assert.deepEqual(accts.map((a) => a.groupId), ['seed-1', 'seed-1', 'seed-2', 'imported']);
  assert.deepEqual(accts.map((a) => a.groupLabel), ['seed #1', 'seed #1', 'burner', 'imported keys']);
  assert.deepEqual(accts.map((a) => a.address), [TEST_ADDR0, TEST_ADDR1, OTHER_ADDR0, LOOSE_ADDR]);

  // the flat index resolves to the right signer on both sides of the boundary
  for (const a of accts) assert.equal(accountAt(s, a.index).address, a.address);
  // and stealth only exists where a mnemonic does
  assert.equal(seedOf(s, 2)?.id, 'seed-2');
  assert.equal(seedOf(s, 3), null);
});

test('keyring: duplicate seeds and duplicate addresses are refused', () => {
  let s = newSecret(TEST_MNEMONIC);
  assert.throws(() => addSeedGroup(s, TEST_MNEMONIC), /already/);
  assert.throws(() => addSeedGroup(s, 'not a seed phrase at all'), /valid seed phrase/);
  // account 0 of the seed is already here, so importing its key is a no-op refusal
  assert.throws(() => addImportedKey(s, TEST_PRIV), /already/);
  s = addImportedKey(s, LOOSE_PRIV);
  assert.throws(() => addImportedKey(s, LOOSE_PRIV), /already/);
});

test('keyring: nicknames and labels survive, and edits stay scoped', () => {
  let s = newSecret(TEST_MNEMONIC);
  s = addImportedKey(s, LOOSE_PRIV);
  s = editAccount(s, 0, { nick: 'main' });
  s = editAccount(s, 0, { labels: ['Hot', ' hot ', 'daily'] }); // deduped and normalized
  s = editAccount(s, 1, { labels: ['cold'] });
  s = renameGroup(s, 'seed-1', 'house seed');

  const accts = listAccounts(s);
  assert.equal(accts[0].label, 'main');
  assert.equal(accts[0].named, true); // a chosen name outranks reverse-ENS in the UI
  assert.equal(accts[1].named, false);
  assert.deepEqual(accts[0].labels, ['hot', 'daily']);
  assert.equal(accts[0].groupLabel, 'house seed');
  assert.equal(accts[1].label, 'imported key 1'); // untouched default
  assert.deepEqual(accts[1].labels, ['cold']);
  assert.deepEqual(allLabels(s), ['cold', 'daily', 'hot']);

  // a nickname-only patch must not wipe labels
  s = editAccount(s, 0, { nick: 'renamed' });
  assert.deepEqual(listAccounts(s)[0].labels, ['hot', 'daily']);
});

test('keyring: forgetting is scoped, and the last seed phrase stays', () => {
  let s = newSecret(TEST_MNEMONIC);
  s = addImportedKey(s, LOOSE_PRIV);
  assert.throws(() => removeSeedGroup(s, 'seed-1'), /last seed phrase/);
  assert.throws(() => removeImported(s, 0), /only imported keys/); // index 0 is HD

  s = addSeedGroup(s, OTHER_MNEMONIC);
  s = removeSeedGroup(s, 'seed-1');
  assert.deepEqual(listAccounts(s).map((a) => a.address), [OTHER_ADDR0, LOOSE_ADDR]);
  s = removeImported(s, 1);
  assert.deepEqual(listAccounts(s).map((a) => a.address), [OTHER_ADDR0]);
});

test('vault: re-sealing under the held key keeps the password working', async () => {
  const blob = await sealVault(newSecret(TEST_MNEMONIC), 'hunter2');
  const { secret, vaultKey } = await openVaultKeyed<VaultSecret>(blob, 'hunter2');
  const next = addImportedKey(secret, LOOSE_PRIV, 'cold');
  const resealed = await resealVault(next, vaultKey);

  assert.notEqual(resealed.iv, blob.iv); // fresh IV every seal
  assert.equal(resealed.salt, blob.salt); // same salt: same password opens it
  const reopened = await openVault<VaultSecret>(resealed, 'hunter2');
  assert.deepEqual(listAccounts(reopened).map((a) => a.address), [TEST_ADDR0, LOOSE_ADDR]);
  await assert.rejects(() => openVault(resealed, 'hunter3'), /WRONG_PASSWORD/);
});

test('rpc pool: assignment is stable, rotation remaps, coverage counts', () => {
  const pool = defaultPool();
  const a = endpointFor(pool, TEST_ADDR0);
  assert.equal(endpointFor(pool, TEST_ADDR0), a); // stable
  const rotated = rotate(pool);
  assert.notEqual(endpointFor(rotated, TEST_ADDR0), a); // epoch remaps
  const cov = coverage(pool, [TEST_ADDR0, TEST_ADDR1]);
  assert.ok(cov >= 1 && cov <= pool.endpoints.length);
});

test('rpc pool: your own node is addable, plaintext to the internet is not', () => {
  // the point of the whole feature: a node on your own machine
  assert.equal(normalizeEndpoint('http://127.0.0.1:8545'), 'http://127.0.0.1:8545');
  assert.equal(normalizeEndpoint('  http://localhost:8545/  '), 'http://localhost:8545');
  assert.equal(normalizeEndpoint('http://[::1]:8545'), 'http://[::1]:8545');
  assert.equal(normalizeEndpoint('http://reth.localhost:8545'), 'http://reth.localhost:8545');
  // https anywhere, path and query preserved (keyed provider URLs)
  assert.equal(normalizeEndpoint('https://eth.example/v2/abc?k=1'), 'https://eth.example/v2/abc?k=1');
  assert.equal(normalizeEndpoint('https://eth.example'), 'https://eth.example');
  // plaintext to anyone but yourself, and anything that is not http(s), refused
  assert.equal(normalizeEndpoint('http://eth.example'), null);
  assert.equal(normalizeEndpoint('http://127.0.0.1.evil.example'), null);
  assert.equal(normalizeEndpoint('ws://127.0.0.1:8545'), null);
  assert.equal(normalizeEndpoint('file:///etc/passwd'), null);
  assert.equal(normalizeEndpoint('ethereum-rpc.publicnode.com'), null);
  assert.equal(normalizeEndpoint(''), null);
  assert.ok(isLoopback('127.0.0.1') && isLoopback('LOCALHOST') && !isLoopback('127.0.0.1.example'));
});

test('rpc pool: derives only documented Alchemy WebSocket twins without dropping keyed paths', () => {
  assert.equal(
    alchemyWebSocketEndpoint('https://robinhood-mainnet.g.alchemy.com/v2/private-key'),
    'wss://robinhood-mainnet.g.alchemy.com/v2/private-key',
  );
  assert.equal(alchemyWebSocketEndpoint('https://rpc.mainnet.chain.robinhood.com'), null);
  assert.equal(alchemyWebSocketEndpoint('wss://robinhood-mainnet.g.alchemy.com/v2/key'), null);
  assert.equal(alchemyWebSocketEndpoint('https://g.alchemy.com.evil.example/v2/key'), null);
});

test('rpc pool: retiring a dead default preserves custom nodes and repairs an empty pool', () => {
  const official = 'https://rpc.mainnet.chain.robinhood.com';
  const retired = 'https://rpc.arrowrpc.com';
  assert.deepEqual(
    retireEndpoints({ endpoints: [retired, 'https://my.node'], epoch: 3 }, [retired], [official]),
    { endpoints: ['https://my.node'], epoch: 0 },
  );
  assert.deepEqual(
    retireEndpoints({ endpoints: [retired], epoch: 1 }, [retired], [official]),
    { endpoints: [official], epoch: 0 },
  );
});

test('rpc errors: provider HTML is reduced to a bounded transport reason', () => {
  assert.equal(
    summarizeRpcError('HTTP request failed. Status: 530 Details: <html>request metadata</html>'),
    'HTTP 530',
  );
  assert.equal(summarizeRpcError('node timed out', 8), 'node ti…');
});

// ---- v0.2: swap math ----
import { applySlippage } from '../src/swap.js';

test('swap: applySlippage math', () => {
  assert.equal(applySlippage(10_000n, 1.0), 9_900n); // 1% -> 100 bps
  assert.equal(applySlippage(10_000n, 0.5), 9_950n);
  assert.equal(applySlippage(10_000n, 0), 10_000n);
  assert.equal(applySlippage(1_000_000_000_000_000_000n, 1.0), 990_000_000_000_000_000n);
});

// ---- v0.3: uniswap v4 calldata encoding ----
import { encodeV4SwapCalldata, UNIVERSAL_ROUTER } from '../src/swapv4.js';

test('swap v4: universal router calldata layout', () => {
  const quote = {
    protocol: 'v4' as const,
    amountInEth: '0.1',
    amountOut: 4_000_000_000_000_000_000_000n,
    amountOutFormatted: '4,000',
    minOut: 3_960_000_000_000_000_000_000n,
    minOutFormatted: '3,960',
    slippagePct: 1.0,
    poolKey: {
      currency0: '0x0000000000000000000000000000000000000000' as const,
      currency1: '0xdDc6625FEcA10438857DD8660C021Cd1088806FB' as const,
      fee: 10000,
      tickSpacing: 200,
      hooks: '0x0000000000000000000000000000000000000000' as const,
    },
    feeTierPct: '1.00%',
  };
  const data = encodeV4SwapCalldata(quote, 1_800_000_000n);
  assert.ok(data.startsWith('0x3593564c'), 'execute(bytes,bytes[],uint256) selector');
  const body = data.toLowerCase();
  assert.ok(body.includes('060c0f'), 'action bytes swap/settle_all/take_all');
  assert.ok(body.includes('ddc6625feca10438857dd8660c021cd1088806fb'), 'RAD currency present');
  assert.ok(body.includes((100_000_000_000_000_000n).toString(16)), 'amountIn 0.1 ETH');
  assert.ok(body.includes(quote.minOut.toString(16)), 'minOut enforced');
  assert.equal(UNIVERSAL_ROUTER.toLowerCase(), '0x66a9893cc07d91d95644aedd05d03f95e1dba8af');
});

// ---- v0.4: allowance rewriting ----
import {
  decodeApprove, isUnlimitedAllowance, rewriteApprove, formatAllowance, parseAllowance, MAX_UINT256,
} from '../src/allowance.js';

const TOKEN = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB' as const;
const SPENDER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;

test('allowance: decode + detect unlimited + rewrite roundtrip', () => {
  // approve(spender, MAX_UINT256)
  const unlimited = rewriteApprove({ token: TOKEN, spender: SPENDER, amount: 0n }, MAX_UINT256);
  const call = decodeApprove(TOKEN, unlimited);
  assert.ok(call, 'decodes approve calldata');
  assert.equal(call!.spender.toLowerCase(), SPENDER.toLowerCase());
  assert.equal(call!.amount, MAX_UINT256);
  assert.ok(isUnlimitedAllowance(call!.amount));

  // rewrite to exactly 100 tokens
  const bounded = rewriteApprove(call!, parseAllowance('100', 18));
  const call2 = decodeApprove(TOKEN, bounded);
  assert.equal(call2!.amount, 100n * 10n ** 18n);
  assert.ok(!isUnlimitedAllowance(call2!.amount));
});

test('allowance: non-approve calldata is left alone', () => {
  assert.equal(decodeApprove(TOKEN, '0xa9059cbb' as `0x${string}`), null); // transfer()
  assert.equal(decodeApprove(TOKEN, undefined), null);
  assert.equal(decodeApprove(undefined, '0x095ea7b3'), null);
});

test('allowance: formatting', () => {
  assert.equal(formatAllowance(MAX_UINT256), 'UNLIMITED');
  assert.equal(formatAllowance(1_500_000_000_000_000_000n), '1.5');
});

test('keyring: an exported key is the key for the address shown', async () => {
  const {
    privateKeyAt, mnemonicOfGroup, addressOfPrivateKey, listAccounts,
    normalizeSecret, addImportedKey,
  } = await import('../src/keyring.js');
  const M = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const K = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
  let secret = normalizeSecret({
    seeds: [{ id: 'seed-1', mnemonic: M, accounts: [{}, {}] }], imported: [],
  });
  secret = addImportedKey(secret, K, 'cold');

  // THE property that matters: exporting a key must hand back the key for the
  // address the wallet has been showing, on both kinds of wallet. A key that
  // derives a different address is worse than no export at all — you would
  // restore it elsewhere and find an empty wallet.
  for (const a of listAccounts(secret)) {
    const pk = privateKeyAt(secret, a.index);
    assert.match(pk, /^0x[0-9a-f]{64}$/, `${a.label} exports a well-formed key`);
    assert.equal(
      addressOfPrivateKey(pk).toLowerCase(), a.address.toLowerCase(),
      `${a.kind} wallet ${a.index} exports the key for its own address`,
    );
  }
  // an imported key comes back byte-identical to what was pasted in
  assert.equal(privateKeyAt(secret, 2), K);
  assert.throws(() => privateKeyAt(secret, 9), /no wallet at index/);

  // a seed group gives up its phrase; an imported key has no group and no phrase
  assert.equal(mnemonicOfGroup(secret, 'seed-1'), M);
  assert.equal(mnemonicOfGroup(secret, 'imported'), null);
  assert.equal(mnemonicOfGroup(secret, 'nope'), null);
});

// ---- v0.5: chain registry + token lists ----
import {
  CHAINS, CHAIN_IDS, SCAN_CHAIN_IDS, TESTNET_CHAIN_IDS, isTestnet,
  chainInfo, explorerAddressUrl, explorerTxUrl, explorerTokenUrl, explorerNftUrl,
  TOKENS, COLLECTIONS, MULTICALL3, registerCustomChain, unregisterCustomChain,
} from '../src/chains.js';
import { client as mainnetClient, sendDappTx } from '../src/chain.js';
import { chainClient, readContracts } from '../src/tokens.js';

test('chains: registry sanity', () => {
  assert.deepEqual(
    CHAIN_IDS.sort((a, b) => a - b),
    [1, 4663, 8453, 42161, 46630, 84532, 11155111],
  );
  for (const id of CHAIN_IDS) {
    const c = chainInfo(id);
    assert.equal(c.chain.id, id);
    // A pool IS the retry, so a mainnet normally needs more than one node.
    // Robinhood currently publishes exactly one usable public mainnet RPC;
    // keyed or user-owned providers can still be added in SETTINGS.
    const minimumEndpoints = c.testnet || id === 4663 ? 1 : 2;
    assert.ok(
      c.defaultEndpoints.length >= minimumEndpoints,
      `${c.name} has a pool to rotate`,
    );
    assert.ok(c.explorerTx.startsWith('https://'));
    // every chain can be opened in an explorer, and the two links must point at
    // the SAME explorer — a copy-pasted prefix from another chain sends you to
    // an address page on the wrong network, which looks like an empty wallet
    assert.ok(c.explorerAddress.startsWith('https://'), `${c.name} has an address link`);
    assert.equal(
      new URL(c.explorerAddress).host,
      new URL(c.explorerTx).host,
      `${c.name}: tx and address links are the same explorer`,
    );
    assert.ok(c.explorerAddress.endsWith('/address/'), `${c.name} address prefix ends in /address/`);
  }
  assert.deepEqual(CHAINS[4663].defaultEndpoints, ['https://rpc.mainnet.chain.robinhood.com']);
  const who = '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B';
  const tx = `0x${'ab'.repeat(32)}`;
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
  for (const id of CHAIN_IDS) {
    assert.equal(explorerAddressUrl(id, who), `${CHAINS[id].explorerAddress}${who}`);
    assert.equal(explorerTxUrl(id, tx), `${CHAINS[id].explorerTx}${tx}`);
    // an asset link has to land on the same explorer as the address link, and
    // take the shape THAT explorer actually serves: a single NFT is /nft/a/id
    // on etherscan and /token/a/instance/id on blockscout, and the wrong guess
    // is a 404 where the user expected their own picture
    const host = new URL(CHAINS[id].explorerAddress).host;
    const tok = explorerTokenUrl(id, BAYC);
    const nft = explorerNftUrl(id, BAYC, '7');
    assert.equal(new URL(tok).host, host, `${CHAINS[id].name} token link is the same explorer`);
    assert.equal(new URL(nft).host, host, `${CHAINS[id].name} nft link is the same explorer`);
    assert.equal(new URL(tok).pathname, `/token/${BAYC}`, 'both families agree on /token/');
    assert.equal(
      new URL(nft).pathname,
      CHAINS[id].explorerKind === 'blockscout' ? `/token/${BAYC}/instance/7` : `/nft/${BAYC}/7`,
      `${CHAINS[id].name} uses its own family's NFT path`,
    );
  }
  assert.throws(() => chainInfo(1337));
});

test('chains: a user-owned local network is registered without an explorer or an automatic sweep', () => {
  const id = 31337;
  try {
    const added = registerCustomChain({
      id,
      name: 'Local Anvil',
      nativeSymbol: 'eth',
      endpoint: 'http://127.0.0.1:8545',
      testnet: true,
    });
    assert.deepEqual(added, {
      id, name: 'Local Anvil', nativeSymbol: 'ETH',
      endpoint: 'http://127.0.0.1:8545', testnet: true,
    });
    assert.equal(chainInfo(id).chain.id, id);
    assert.deepEqual(chainInfo(id).defaultEndpoints, ['http://127.0.0.1:8545']);
    assert.ok(CHAIN_IDS.includes(id));
    assert.ok(TESTNET_CHAIN_IDS.includes(id));
    assert.ok(isTestnet(id));
    assert.ok(!SCAN_CHAIN_IDS.includes(id));
    assert.equal(explorerTxUrl(id, '0xabc'), null);
    assert.equal(explorerAddressUrl(id, TEST_ADDR0), null);
    assert.equal(registerCustomChain({ ...added, name: 'duplicate' }), null);
    assert.equal(registerCustomChain({ ...added, id: 1 }), null);
  } finally {
    assert.ok(unregisterCustomChain(id));
  }
  assert.ok(!CHAIN_IDS.includes(id));
  assert.ok(!TESTNET_CHAIN_IDS.includes(id));
});

test('chains: a custom network without Multicall3 reads tracked contracts directly', async () => {
  const id = 31338;
  const calls: string[] = [];
  const client = {
    async multicall() { throw new Error('a bare local node has no Multicall3'); },
    async readContract(call: { functionName: string }) {
      calls.push(call.functionName);
      return call.functionName === 'balanceOf' ? 7n : 'LOCAL';
    },
  };
  try {
    assert.ok(registerCustomChain({
      id, name: 'Bare Anvil', nativeSymbol: 'ETH', endpoint: 'http://127.0.0.1:8545', testnet: true,
    }));
    const reads = await readContracts(client as never, id, [
      { address: TEST_ADDR0, abi: [], functionName: 'symbol' },
      { address: TEST_ADDR0, abi: [], functionName: 'balanceOf', args: [TEST_ADDR0] },
    ]);
    assert.deepEqual(reads, [
      { status: 'success', result: 'LOCAL' },
      { status: 'success', result: 7n },
    ]);
    assert.deepEqual(calls, ['symbol', 'balanceOf']);
  } finally {
    unregisterCustomChain(id);
  }
});

test('chain clients: CCIP-read is off, so contracts cannot choose fetch gateways', async () => {
  const oldFetch = globalThis.fetch;
  const rpc = 'https://rpc.example';
  const target = '0x1111111111111111111111111111111111111111';
  const gateway = 'https://evil.example/steal/{data}';
  const calls: string[] = [];
  const revertData = encodeErrorResult({
    abi: [offchainLookupAbiItem],
    errorName: 'OffchainLookup',
    args: [target, [gateway], '0xabcdef', '0x12345678', '0xdeadbeef'],
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    calls.push(url);
    if (new URL(url).host !== new URL(rpc).host) throw new Error(`unexpected fetch to ${url}`);
    const raw = init?.body ?? (typeof input === 'string' || input instanceof URL ? '' : await input.clone().text());
    const body = JSON.parse(String(raw || '{}')) as { id?: unknown };
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id ?? 1,
      error: { code: 3, message: 'execution reverted', data: revertData },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => mainnetClient(rpc).readContract({
        address: target,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [TEST_ADDR0],
      }),
      /OffchainLookup|execution reverted|reverted/i,
    );
    await assert.rejects(
      () => chainClient(rpc, 8453).readContract({
        address: target,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [TEST_ADDR0],
      }),
      /OffchainLookup|execution reverted|reverted/i,
    );
    assert.deepEqual(calls.map((url) => new URL(url).host), ['rpc.example', 'rpc.example']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('chains: every scanned chain can be swept in one multicall', () => {
  // an unswept chain is a chain whose assets we would silently never show
  for (const id of SCAN_CHAIN_IDS) {
    assert.ok(CHAINS[id], `scan list references a registered chain (${id})`);
    assert.equal(
      CHAINS[id].chain.contracts?.multicall3?.address?.toLowerCase(),
      MULTICALL3.toLowerCase(),
      `${CHAINS[id].name} carries multicall3, or the sweep degrades to N round-trips`,
    );
  }
  // sweeping is opt-in per chain: every extra chain is an endpoint that learns
  // one more address, so the list must stay deliberate
  assert.ok(SCAN_CHAIN_IDS.length < CHAIN_IDS.length || SCAN_CHAIN_IDS.length === CHAIN_IDS.length);
  assert.ok(SCAN_CHAIN_IDS.includes(1) && SCAN_CHAIN_IDS.includes(8453) && SCAN_CHAIN_IDS.includes(4663));
  // testnets are switchable but never swept unasked: play money in a portfolio
  // total is a worse answer than no answer
  for (const id of SCAN_CHAIN_IDS) assert.ok(!CHAINS[id].testnet, `${id} is not a testnet`);
  // the testnet list is derived, not hand-maintained, so it cannot drift out of
  // step with the flag the totals and the sweep both read
  assert.deepEqual(
    TESTNET_CHAIN_IDS.slice().sort((a, b) => a - b),
    CHAIN_IDS.filter((id) => CHAINS[id].testnet).sort((a, b) => a - b),
  );
  for (const id of TESTNET_CHAIN_IDS) {
    assert.ok(isTestnet(id), `${CHAINS[id].name} reports itself as a testnet`);
    // turning testnets on must not cost N round-trips per chain
    assert.equal(
      CHAINS[id].chain.contracts?.multicall3?.address?.toLowerCase(),
      MULTICALL3.toLowerCase(),
      `${CHAINS[id].name} carries multicall3`,
    );
  }
});

test('chains: bundled NFT collections are well-formed', () => {
  for (const id of CHAIN_IDS) {
    for (const c of COLLECTIONS[id] ?? []) {
      assert.match(c.address, /^0x[0-9a-fA-F]{40}$/);
      assert.ok(c.name.length > 0 && c.symbol.length > 0);
    }
  }
  // no duplicate contracts within a chain — a doubled row is a doubled balance
  for (const id of CHAIN_IDS) {
    const seen = (COLLECTIONS[id] ?? []).map((c) => c.address.toLowerCase());
    assert.equal(new Set(seen).size, seen.length, `chain ${id} lists each collection once`);
  }
});

test('chains: token lists are well-formed and $RAD is mainnet-only', () => {
  for (const id of CHAIN_IDS) {
    const seen = new Set<string>();
    for (const t of TOKENS[id] ?? []) {
      assert.match(t.address, /^0x[0-9a-fA-F]{40}$/);
      assert.ok(t.decimals >= 0 && t.decimals <= 18);
      // the same contract listed twice is a wasted call and a duplicate row
      const key = t.address.toLowerCase();
      assert.ok(!seen.has(key), `chain ${id} lists ${t.symbol} (${t.address}) once`);
      seen.add(key);
      // A symbol is a label, not a payload. Tokens that declare symbol() as
      // bytes32 (MKR is the famous one) decode to 64 hex characters if read as
      // a string, and the generator has to catch that — "4d4b5200…" on a row
      // is a wallet that cannot read its own list.
      assert.ok(t.symbol.length > 0 && t.symbol.length <= 20, `${t.symbol} on ${id} is short`);
      assert.match(t.symbol, /^[\x20-\x7E]+$/, `${t.symbol} on ${id} is printable`);
      assert.ok(!/^[0-9a-f]{40,}$/i.test(t.symbol), `${t.symbol} on ${id} is not raw hex`);
    }
  }
  // the curated entry keeps its place at the top of its chain
  assert.equal(TOKENS[1][0].symbol, '$RAD', 'the house token leads mainnet');
  assert.ok(!TOKENS[8453].some((t) => t.symbol === '$RAD'));
});

test('balances: canonical $RAD stays visible at zero without trusting its symbol', async () => {
  const { withRadBalance } = await import('../src/tokens.js');
  const { RAD_TOKEN } = await import('../src/chain.js');
  const eth = {
    symbol: 'ETH', name: 'Ether', amount: '0', raw: 0n, decimals: 18, chainId: 1,
  };
  const impostor = {
    symbol: '$RAD', name: 'Not Radcoin', amount: '0', raw: 0n, decimals: 18,
    address: '0x1111111111111111111111111111111111111111' as const, chainId: 1,
  };

  const missing = withRadBalance([eth, impostor]);
  assert.equal(missing.length, 3, 'a symbol impostor does not suppress canonical Radcoin');
  assert.deepEqual(missing[1], {
    ...RAD_TOKEN, amount: '0', raw: 0n, chainId: 1,
  });

  const actual = { ...RAD_TOKEN, amount: '42', raw: 42n, chainId: 1 };
  const present = withRadBalance([eth, actual]);
  assert.equal(present.length, 2, 'the canonical contract is never duplicated');
  assert.equal(present[1].raw, 42n, 'a real balance always wins over the zero fallback');
});

test('chains: every swept chain ships a token list worth sweeping', () => {
  // the lists are generated and verified against the chain (scripts/gen-tokens.mjs).
  // A chain that quietly drops to a handful of entries means the generator
  // failed and nobody noticed — you would just stop seeing your own tokens.
  for (const id of SCAN_CHAIN_IDS) {
    assert.ok((TOKENS[id] ?? []).length >= 50,
      `chain ${id} has ${(TOKENS[id] ?? []).length} tokens — the generated list is missing`);
  }
});

// ---- v0.7: native, fungible-token and NFT transfers ----
import { decodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { buildTransferTx, transferLabel } from '../src/transfers.js';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

test('transfers: native send stays a value transfer', () => {
  const tx = buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'native', symbol: 'ETH', decimals: 18, amount: '1.25',
  });
  assert.equal(tx.to, RECIPIENT);
  assert.equal(BigInt(tx.value!), 1_250_000_000_000_000_000n);
  assert.equal(tx.data, undefined);
});

test('transfers: ERC-20 send encodes exact token units', () => {
  const tx = buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'erc20', contract: TOKEN, symbol: '$RAD', decimals: 18, amount: '42.5',
  });
  assert.equal(tx.to, TOKEN);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  assert.equal(decoded.functionName, 'transfer');
  assert.deepEqual(decoded.args, [RECIPIENT, 42_500_000_000_000_000_000n]);
  assert.equal(tx.value, undefined);
});

test('transfers: ERC-721 send uses safeTransferFrom with the owning account', () => {
  const nft = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' as const;
  const tx = buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'erc721', contract: nft, symbol: 'BAYC', tokenId: '874',
  });
  const abi = parseAbi(['function safeTransferFrom(address from, address to, uint256 tokenId)']);
  const decoded = decodeFunctionData({ abi, data: tx.data! });
  assert.equal(tx.to, nft);
  assert.equal(decoded.functionName, 'safeTransferFrom');
  assert.deepEqual(decoded.args, [TEST_ADDR0, RECIPIENT, 874n]);
  assert.deepEqual(
    transferLabel({ kind: 'erc721', contract: nft, symbol: 'BAYC', tokenId: '874' }),
    { asset: 'BAYC #874', amount: '1 NFT' },
  );
});

test('transfers: ERC-1155 send carries id, quantity and empty receiver data', () => {
  const multi = '0x1111111111111111111111111111111111111111' as const;
  const tx = buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'erc1155', contract: multi, symbol: 'ITEM', tokenId: '7', amount: '3',
  });
  const abi = parseAbi([
    'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  ]);
  const decoded = decodeFunctionData({ abi, data: tx.data! });
  assert.deepEqual(decoded.args, [TEST_ADDR0, RECIPIENT, 7n, 3n, '0x']);
});

test('transfers: malformed or zero-value sends are refused before signing', () => {
  assert.throws(() => buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'native', symbol: 'ETH', decimals: 18, amount: '0',
  }), /greater than zero/);
  assert.throws(() => buildTransferTx(TEST_ADDR0, RECIPIENT, {
    kind: 'erc721', contract: TOKEN, symbol: 'NFT', tokenId: '-1',
  }), /whole number/);
  assert.throws(() => buildTransferTx(TEST_ADDR0, 'not-an-address', {
    kind: 'native', symbol: 'ETH', decimals: 18, amount: '1',
  }), /recipient/);
});

// ---- v0.6: ERC-5564 stealth addresses ----
import {
  deriveStealthKeys, parseMetaAddress, generateStealthAddress, checkAnnouncement,
  announceCalldata, ANNOUNCER, broadcastStealthPlan, newStealthSendPlan,
  scanStealthPaymentRange, verifyStealthAnnouncement, confirmStealthAnnouncementWithClient,
  ANNOUNCEMENT_EVENT, ANNOUNCER_DEPLOY_BLOCK,
} from '../src/stealth.js';
import { privateKeyToAccount } from 'viem/accounts';

test('stealth: meta-address derivation is deterministic and parseable', () => {
  const k1 = deriveStealthKeys(TEST_MNEMONIC);
  const k2 = deriveStealthKeys(TEST_MNEMONIC);
  assert.equal(k1.metaAddress, k2.metaAddress);
  assert.match(k1.metaAddress, /^st:eth:0x[0-9a-f]{132}$/);
  const parsed = parseMetaAddress(k1.metaAddress);
  assert.ok(parsed);
  assert.deepEqual([...parsed!.spendPub], [...k1.spendPub]);
  // stealth keys must differ from the transaction account keys
  assert.notEqual(k1.metaAddress.includes(TEST_ADDR0.slice(2).toLowerCase()), true);
  assert.equal(parseMetaAddress('st:eth:0xdeadbeef'), null);
});

test('stealth: sender->recipient roundtrip recovers a spendable key', () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const { stealthAddress, ephemeralPubKey, viewTag } = generateStealthAddress(keys.metaAddress);
  assert.match(stealthAddress, /^0x[0-9a-fA-F]{40}$/);
  // recipient detects the payment (with view-tag metadata prefilter)
  const tagHex = '0x' + viewTag.toString(16).padStart(2, '0');
  const priv = checkAnnouncement(keys, stealthAddress, ephemeralPubKey, tagHex);
  assert.ok(priv, 'announcement recognized as ours');
  // and the recovered private key controls exactly that address
  assert.equal(privateKeyToAccount(priv!).address.toLowerCase(), stealthAddress.toLowerCase());
});

test('stealth: foreign announcements are rejected', () => {
  const ours = deriveStealthKeys(TEST_MNEMONIC);
  const theirs = deriveStealthKeys('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const p = generateStealthAddress(theirs.metaAddress);
  assert.equal(checkAnnouncement(ours, p.stealthAddress, p.ephemeralPubKey), null);
});

test('stealth: announce calldata targets the canonical singleton scheme', () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const p = generateStealthAddress(keys.metaAddress);
  const data = announceCalldata(p.stealthAddress, p.ephemeralPubKey, p.viewTag);
  assert.ok(data.length > 10);
  assert.equal(ANNOUNCER, '0x55649E01B5Df198D18D95b5cc5051630cfD45564');
});

function preparedStealthPlan(meta: string, valueWei: bigint) {
  const from = TEST_ADDR0;
  const plan = newStealthSendPlan(meta, valueWei);
  return {
    ...plan,
    from,
    announceGas: 60_000n,
    transferGas: 21_000n,
    gasPriceWei: 100n,
    totalMaxWei: valueWei + 8_100_000n,
    announce: {
      ...plan.announce,
      from,
      nonce: 42,
      gas: '0xea60' as const,
      maxFeePerGas: '0x64' as const,
      maxPriorityFeePerGas: '0x2' as const,
    },
    transfer: {
      ...plan.transfer,
      from,
      nonce: 43,
      gas: '0x5208' as const,
      maxFeePerGas: '0x64' as const,
      maxPriorityFeePerGas: '0x2' as const,
    },
  };
}

test('stealth: transfer broadcast failure preserves the exact announced recovery plan', async () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const plan = preparedStealthPlan(keys.metaAddress, 123n);
  const sent: unknown[] = [];
  const confirmations: `0x${string}`[] = [];
  const result = await broadcastStealthPlan(plan, async (tx) => {
    sent.push(tx);
    if (sent.length === 2) throw new Error('transfer down');
    return '0x1111111111111111111111111111111111111111111111111111111111111111';
  }, async (hash) => {
    confirmations.push(hash);
  });

  assert.equal(result.status, 'transfer_failed');
  assert.equal(result.announceHash, '0x1111111111111111111111111111111111111111111111111111111111111111');
  assert.equal(result.stealthAddress, plan.stealthAddress);
  assert.equal(result.plan.ephemeralPubKey, plan.ephemeralPubKey);
  assert.equal(result.plan.viewTag, plan.viewTag);
  assert.deepEqual(sent, [plan.announce, plan.transfer]);
  assert.deepEqual(confirmations, [result.announceHash]);
});

test('stealth: an unconfirmed announcement never releases the ETH transfer', async () => {
  const plan = preparedStealthPlan(deriveStealthKeys(TEST_MNEMONIC).metaAddress, 123n);
  const sent: unknown[] = [];
  const result = await broadcastStealthPlan(plan, async (tx) => {
    sent.push(tx);
    return '0x1111111111111111111111111111111111111111111111111111111111111111';
  }, async () => {
    throw new Error('announcement replaced');
  });

  assert.equal(result.status, 'announcement_unconfirmed');
  assert.equal(result.confirmationError, 'announcement replaced');
  assert.deepEqual(sent, [plan.announce]);
});

test('stealth: retrying a persisted plan reuses identical nonce-bound txs', async () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const plan = preparedStealthPlan(keys.metaAddress, 456n);
  const sent: unknown[] = [];
  const hashes = new Map<string, `0x${string}`>();
  const hashOf = (tx: unknown): `0x${string}` => {
    const key = JSON.stringify(tx, (_key, value) => (
      typeof value === 'bigint' ? value.toString() : value
    ));
    if (!hashes.has(key)) {
      hashes.set(key, `0x${String(hashes.size + 1).padStart(64, '0')}` as `0x${string}`);
    }
    return hashes.get(key)!;
  };

  const confirmed: `0x${string}`[] = [];
  const confirm = async (hash: `0x${string}`) => { confirmed.push(hash); };
  const first = await broadcastStealthPlan(plan, async (tx) => {
    sent.push(tx);
    return hashOf(tx);
  }, confirm);
  const retry = await broadcastStealthPlan(plan, async (tx) => {
    sent.push(tx);
    return hashOf(tx);
  }, confirm);

  assert.equal(first.status, 'sent');
  assert.equal(retry.status, 'sent');
  assert.equal(first.announceHash, retry.announceHash);
  assert.equal(first.transferHash, retry.transferHash);
  assert.deepEqual(sent, [plan.announce, plan.transfer, plan.announce, plan.transfer]);
  assert.deepEqual(confirmed, [first.announceHash, retry.announceHash]);
  assert.equal(plan.announce.nonce, 42);
  assert.equal(plan.transfer.nonce, 43);
});

test('stealth: unpreflighted plans refuse before any broadcast', async () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const plan = newStealthSendPlan(keys.metaAddress, 123n);
  let broadcasts = 0;
  await assert.rejects(
    () => broadcastStealthPlan(plan, async () => {
      broadcasts++;
      return '0x1111111111111111111111111111111111111111111111111111111111111111';
    }, async () => {}),
    /not preflighted|missing reserved nonce/,
  );
  assert.equal(broadcasts, 0);
});

function announcementProof(plan: ReturnType<typeof preparedStealthPlan>, hash: `0x${string}`) {
  const topics = encodeEventTopics({
    abi: [ANNOUNCEMENT_EVENT],
    eventName: 'Announcement',
    args: {
      schemeId: 1n,
      stealthAddress: plan.stealthAddress,
      caller: plan.from,
    },
  });
  const data = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    [plan.ephemeralPubKey, toHex(new Uint8Array([plan.viewTag]))],
  );
  return {
    tx: {
      hash,
      from: plan.from,
      to: ANNOUNCER,
      input: plan.announce.data!,
      nonce: plan.announce.nonce!,
    },
    receipt: {
      transactionHash: hash,
      status: 'success' as const,
      blockNumber: 123n,
      blockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      from: plan.from,
      to: ANNOUNCER,
      logs: [{ address: ANNOUNCER, data, topics }],
    },
  };
}

test('stealth: exact successful announcement receipt and discovery log are accepted', () => {
  const plan = preparedStealthPlan(deriveStealthKeys(TEST_MNEMONIC).metaAddress, 123n);
  const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const proof = announcementProof(plan, hash);
  assert.doesNotThrow(() => verifyStealthAnnouncement(plan, hash, proof.tx, proof.receipt));
});

test('stealth: replacement or missing discovery log refuses before transfer', () => {
  const plan = preparedStealthPlan(deriveStealthKeys(TEST_MNEMONIC).metaAddress, 123n);
  const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const proof = announcementProof(plan, hash);
  assert.throws(
    () => verifyStealthAnnouncement(plan, hash, { ...proof.tx, nonce: proof.tx.nonce + 1 }, proof.receipt),
    /nonce changed/,
  );
  assert.throws(
    () => verifyStealthAnnouncement(plan, hash, proof.tx, { ...proof.receipt, logs: [] }),
    /missing the exact discovery log/,
  );
});

test('stealth: finality re-reads the receipt instead of trusting stale pre-reorg evidence', async () => {
  const plan = preparedStealthPlan(deriveStealthKeys(TEST_MNEMONIC).metaAddress, 123n);
  const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const proof = announcementProof(plan, hash);
  const fake = {
    waitForTransactionReceipt: async () => proof.receipt,
    getTransaction: async () => proof.tx,
    getTransactionReceipt: async () => ({ ...proof.receipt, logs: [] }),
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => (
      args.blockTag === 'finalized'
        ? { number: proof.receipt.blockNumber, hash: proof.receipt.blockHash }
        : { number: args.blockNumber!, hash: proof.receipt.blockHash }
    ),
  };
  await assert.rejects(
    () => confirmStealthAnnouncementWithClient(fake as never, hash, plan),
    /missing the exact discovery log/,
  );
});

test('stealth: only a post-finality receipt in the canonical block releases the gate', async () => {
  const plan = preparedStealthPlan(deriveStealthKeys(TEST_MNEMONIC).metaAddress, 123n);
  const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const proof = announcementProof(plan, hash);
  let receiptReads = 0;
  const fake = {
    waitForTransactionReceipt: async () => proof.receipt,
    getTransaction: async () => proof.tx,
    getTransactionReceipt: async () => { receiptReads++; return proof.receipt; },
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => (
      args.blockTag === 'finalized'
        ? { number: proof.receipt.blockNumber, hash: proof.receipt.blockHash }
        : { number: args.blockNumber!, hash: proof.receipt.blockHash }
    ),
  };
  await assert.doesNotReject(() => confirmStealthAnnouncementWithClient(fake as never, hash, plan));
  assert.equal(receiptReads, 1, 'receipt must be re-read after finality advances');
});

test('stealth: full-range scan finds announcements older than the old lookback window', async () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  const p = generateStealthAddress(keys.metaAddress);
  const metadata = `0x${p.viewTag.toString(16).padStart(2, '0')}` as const;
  const oldBlock = 12_345n;
  const fake = {
    getBlockNumber: async () => 100_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => (
      fromBlock <= oldBlock && oldBlock <= toBlock
        ? [{ blockNumber: oldBlock, args: { stealthAddress: p.stealthAddress, ephemeralPubKey: p.ephemeralPubKey, metadata } }]
        : []
    ),
    getBalance: async () => 987n,
  };

  const result = await scanStealthPaymentRange(fake as never, keys, { fromBlock: 0n, chunkBlocks: 10_000n });
  assert.equal(result.complete, true);
  assert.equal(result.fromBlock, 0n);
  assert.equal(result.payments.length, 1);
  assert.equal(result.payments[0].stealthAddress, p.stealthAddress);
  assert.equal(result.payments[0].balanceWei, 987n);
});

test('stealth: default scan starts at the measured announcer deployment floor', async () => {
  const keys = deriveStealthKeys(TEST_MNEMONIC);
  let firstFrom: bigint | null = null;
  const fake = {
    getBlockNumber: async () => ANNOUNCER_DEPLOY_BLOCK + 2n,
    getLogs: async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      firstFrom ??= fromBlock;
      return [];
    },
    getBalance: async () => 0n,
  };
  const result = await scanStealthPaymentRange(fake as never, keys);
  assert.equal(result.fromBlock, ANNOUNCER_DEPLOY_BLOCK);
  assert.equal(firstFrom, ANNOUNCER_DEPLOY_BLOCK);
});

test('send sheet: stealth preview signs through the stealth broadcaster', () => {
  const source = readFileSync(new URL('../../../apps/wallet/src/screens/send.tsx', import.meta.url), 'utf8');
  assert.match(source, /onClick=\{\(\) => void \(isStealth \? fireStealth\(\) : fireIt\(\)\)\}/);
  assert.doesNotMatch(source, /prev\?\.ok[\s\S]{0,240}onClick=\{\(\) => void fireIt\(\)\}/);
  const confirmAt = source.indexOf('session.confirmStealthAnnouncement');
  const transferAt = source.indexOf('session.transferStealthPlan');
  assert.ok(confirmAt >= 0 && confirmAt < transferAt, 'confirmation must precede the transfer call');
  const activity = readFileSync(new URL('../../../apps/wallet/src/screens/activity.tsx', import.meta.url), 'utf8');
  assert.ok(
    activity.indexOf('session.confirmStealthAnnouncement') < activity.indexOf('session.transferStealthPlan'),
    'recovery must confirm the announcement before retrying the transfer',
  );
});

test('tokens: dust never renders as a flat zero', async () => {
  // a row reading "0" for something you actually hold is indistinguishable
  // from a scam airdrop, and it hides real (if tiny) balances. Caught live:
  // Base cbETH/cbBTC dust was rendering as a flat "0".
  const { formatAmount } = await import('../src/tokens.js');
  const { formatUnits } = await import('viem');
  const shown = (raw: bigint, dec = 18) => formatAmount(formatUnits(raw, dec));
  assert.equal(shown(0n), '0', 'a true zero still reads as zero');
  assert.equal(shown(1n), '<0.0001', 'one wei is not zero');
  assert.equal(shown(10n ** 13n), '<0.0001');
  assert.equal(shown(10n ** 14n), '0.0001', 'representable at four decimals');
  assert.equal(shown(4206900000000000000n), '4.2069');
  assert.equal(shown(1234567n, 6), '1.2345', 'six-decimal tokens truncate too');
  assert.equal(shown(42000690000000000000000n), '42000.69');
});

test('chains: every bundled address is a real checksummed address', async () => {
  // viem rejects an ENTIRE multicall batch if one address fails checksum, so a
  // single typo in these lists silently turns "no assets" into the answer for
  // every chain. This test exists because a made-up address did exactly that.
  const { isAddress, getAddress } = await import('viem');
  for (const id of CHAIN_IDS) {
    for (const t of TOKENS[id] ?? []) {
      assert.ok(isAddress(t.address, { strict: false }), `${t.symbol} on ${id} is an address`);
      assert.equal(t.address, getAddress(t.address), `${t.symbol} on ${id} is checksummed`);
    }
    for (const c of COLLECTIONS[id] ?? []) {
      assert.ok(isAddress(c.address, { strict: false }), `${c.symbol} on ${id} is an address`);
      assert.equal(c.address, getAddress(c.address), `${c.symbol} on ${id} is checksummed`);
    }
  }
});

test('chains: Robinhood WETH is bundled ahead of stale tracked metadata', async () => {
  const { usableTokens } = await import('../src/tokens.js');
  const weth = CHAINS[4663].wrappedNative!;
  const bundled = (TOKENS[4663] ?? []).find(
    (token) => token.address.toLowerCase() === weth.toLowerCase(),
  );
  assert.ok(bundled, 'the wrapped native token is always swept without relying on tracked metadata');
  assert.equal(bundled.symbol, 'WETH');
  assert.equal(bundled.decimals, 18);
  const stale = { ...bundled, name: '18', decimals: 0 };
  const selected = usableTokens([...(TOKENS[4663] ?? []), stale]).find(
    (token) => token.address.toLowerCase() === weth.toLowerCase(),
  );
  assert.equal(selected?.name, 'WETH');
  assert.equal(selected?.decimals, 18, 'bundled chain facts outrank old custom storage');
});

test('scan lists: one bad entry cannot blank the whole batch', async () => {
  const { usableCollections } = await import('../src/nfts.js');
  const { usableTokens } = await import('../src/tokens.js');
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

  const cols = usableCollections([
    { address: '0xnonsense' as `0x${string}`, name: 'junk', symbol: 'JUNK' },
    { address: '0x5d5F088F9d0Ee8F0a0F0b1B0a5d5D5e0f0a0B0c0' as `0x${string}`, name: 'bad checksum', symbol: 'BAD' },
    { address: BAYC as `0x${string}`, name: 'Bored Ape Yacht Club', symbol: 'BAYC' },
    { address: BAYC.toLowerCase() as `0x${string}`, name: 'dupe', symbol: 'DUPE' },
  ]);
  assert.deepEqual(cols.map((c) => c.symbol), ['BAYC'], 'junk dropped, survivor kept, dupe collapsed');
  assert.equal(cols[0].address, BAYC, 'and it comes back checksummed');

  const toks = usableTokens([
    { address: '0xdeadbeef' as `0x${string}`, symbol: 'X', name: 'x', decimals: 18 },
    { address: BAYC as `0x${string}`, symbol: 'OK', name: 'ok', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, symbol: 'NAN', name: 'n', decimals: NaN },
  ]);
  assert.deepEqual(toks.map((t) => t.symbol), ['OK'], 'bad address and bad decimals both dropped');
});

test('addresses: lowercase is fine, a mistyped checksum is not', async () => {
  const { normalizeContract } = await import('../src/chains.js');
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
  // how people actually paste addresses
  assert.equal(normalizeContract(BAYC.toLowerCase()), BAYC, 'lowercase gets checksummed');
  assert.equal(normalizeContract(`  ${BAYC}  `), BAYC, 'whitespace trimmed');
  assert.equal(normalizeContract(BAYC), BAYC);
  // a typo inside a checksummed address points at a DIFFERENT contract, so it
  // must be refused rather than silently rewritten
  const typo = BAYC.slice(0, -1) + (BAYC.endsWith('D') ? 'e' : 'D');
  assert.equal(normalizeContract(typo), null, 'mixed-case with a broken checksum is refused');
  assert.equal(normalizeContract('0xnope'), null);
  assert.equal(normalizeContract(''), null);
  assert.equal(normalizeContract(BAYC.slice(0, 41)), null, 'too short');
});

// ---- the opt-in indexer: off unless asked, and never trusted ----
test('indexer: does nothing at all unless switched on', async () => {
  const { INDEXER_OFF, discoverAssets, discoverCollections } = await import('../src/indexer.js');
  const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`;
  // if either of these ever hits the network with enabled:false, the whole
  // privacy claim of this wallet is void — so they must not even build a URL
  assert.deepEqual(await discoverAssets(INDEXER_OFF, 1, owner), { tokens: [], collections: [] });
  assert.deepEqual(await discoverCollections(INDEXER_OFF, 1, owner), []);
  assert.equal(INDEXER_OFF.enabled, false, 'the shipped default is off');
  assert.deepEqual(INDEXER_OFF.entries, [], 'and we ship no provider and no key');
  // enabled but nothing configured is still silence, not a default provider
  assert.deepEqual(
    await discoverAssets({ enabled: true, entries: [] }, 1, owner),
    { tokens: [], collections: [] },
  );
  // a provider that needs a key and has none never runs
  assert.deepEqual(
    await discoverAssets({ enabled: true, entries: [{ provider: 'alchemy', key: '' }] }, 1, owner),
    { tokens: [], collections: [] },
  );
});

test('indexer: refuses to build a request without the user\'s own key', async () => {
  const {
    alchemyNftUrl, alchemyRpcUrl, blockscoutUrl, moralisUrl, indexerSupports, entryUsable,
    INDEXER_PROVIDERS,
  } = await import('../src/indexer.js');
  assert.throws(() => alchemyNftUrl('', 1, '0x0'), /API key/);
  assert.throws(() => alchemyNftUrl('k', 999, '0x0'), /no route/);
  const url = alchemyNftUrl('secret key/with?chars', 1, '0xabc');
  assert.ok(url.startsWith('https://eth-mainnet.g.alchemy.com/'), url);
  assert.ok(!url.includes('secret key/with?chars'), 'the key is URL-encoded, not pasted raw');
  // the token list has to go to ALCHEMY's endpoint, not to whatever public node
  // the pool handed over — that bug made a good key silently find nothing
  assert.ok(alchemyRpcUrl('k', 1).startsWith('https://eth-mainnet.g.alchemy.com/v2/'));
  // every provider must name the host it contacts, and the URL must be on it
  for (const p of INDEXER_PROVIDERS) {
    assert.ok(p.chains.length, `${p.name} declares the chains it covers`);
    assert.equal(p.needsKey ? p.keyFrom.length > 0 : true, true, `${p.name} says where to get a key`);
  }
  assert.ok(new URL(blockscoutUrl(1, '0xabc')).host.endsWith('blockscout.com'));
  assert.ok(new URL(moralisUrl(1, '0xabc', 'erc20')).host === 'deep-index.moralis.io');
  // a keyless provider is usable with no key; a chain it has no instance for is
  // refused rather than guessed at
  assert.ok(entryUsable({ provider: 'blockscout', key: '' }, 1));
  assert.ok(!entryUsable({ provider: 'blockscout', key: '' }, 999));
  const cfg = { enabled: true, entries: [{ provider: 'blockscout' as const, key: '' }] };
  assert.ok(indexerSupports(cfg, 1), 'a configured provider covers mainnet');
  assert.ok(!indexerSupports(cfg, 999), 'chains with no route stay on the private path');
  // the keyless provider must reach every chain we ship, or "turn the indexer
  // on" silently means "except over there"
  const { CHAIN_IDS: ids } = await import('../src/chains.js');
  for (const id of ids) {
    assert.ok(indexerSupports(cfg, id), `blockscout covers ${id} — no chain is left uncoverable`);
  }
});

test('indexer: rotates across providers and fails over, like the RPC pool', async () => {
  const { discoverAssets } = await import('../src/indexer.js');
  const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`;
  const seen: string[] = [];
  const real = globalThis.fetch;
  // every provider host answers 500 except blockscout, so a config holding all
  // three must still come back with an answer — and must have TRIED more than
  // one of them to get there
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(new URL(url).host);
    if (url.includes('blockscout.com')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  }) as typeof fetch;
  try {
    const cfg = {
      enabled: true,
      entries: [
        { provider: 'alchemy' as const, key: 'k' },
        { provider: 'moralis' as const, key: 'k' },
        { provider: 'blockscout' as const, key: '' },
      ],
    };
    assert.deepEqual(await discoverAssets(cfg, 1, owner), { tokens: [], collections: [] });
    assert.ok(seen.some((h) => h.endsWith('blockscout.com')), 'failed over to the one that works');
    // and the starting provider moves, so one company does not see every refresh
    const first: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.length = 0;
      await discoverAssets(cfg, 1, owner).catch(() => {});
      first.push(seen[0]);
    }
    assert.ok(new Set(first).size > 1, `rotates the starting provider, saw ${JSON.stringify(first)}`);
  } finally {
    globalThis.fetch = real;
  }
});

test('indexer: blockscout answers with both kinds of asset, and junk is dropped', async () => {
  const { parseBlockscout } = await import('../src/indexer.js');
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const got = parseBlockscout([
    { value: '1000', token: { address_hash: USDC.toLowerCase(), type: 'ERC-20', symbol: 'USDC' } },
    { value: '0', token: { address_hash: USDC.toLowerCase(), type: 'ERC-20', symbol: 'USDC' } },
    { value: '1', token: { address_hash: BAYC, type: 'ERC-721', name: 'Bored Ape Yacht Club', symbol: 'BAYC' } },
    { value: '1', token: { address_hash: '0xgarbage', type: 'ERC-20', symbol: 'J' } },
    { value: '1', token: { address_hash: BAYC, type: 'ERC-1155', symbol: 'M' } },
  ]);
  assert.deepEqual(got.tokens, [USDC], 'zero balances and bad addresses dropped');
  assert.deepEqual(got.collections.map((c) => c.symbol), ['BAYC'], '1155 dropped');
  assert.deepEqual(parseBlockscout({ not: 'an array' }), { tokens: [], collections: [] });
});

test('indexer: its answers are addresses to check, never balances to believe', async () => {
  const { parseContracts, parseTokenBalances } = await import('../src/indexer.js');
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
  const cols = parseContracts({
    contracts: [
      { address: BAYC.toLowerCase(), name: 'Bored Ape Yacht Club', symbol: 'BAYC', tokenType: 'ERC721' },
      { address: '0xgarbage', name: 'junk', symbol: 'J', tokenType: 'ERC721' },
      { address: BAYC, name: '1155 thing', symbol: 'X', tokenType: 'ERC1155' },
      { name: 'no address at all' },
    ],
  });
  assert.deepEqual(cols.map((c) => c.symbol), ['BAYC'], 'junk and non-721 dropped');
  assert.equal(cols[0].address, BAYC, 'and checksummed on the way in');
  assert.deepEqual(parseContracts({}), [], 'a malformed response is not a crash');
  assert.deepEqual(parseContracts({ contracts: 'nope' }), []);

  const toks = parseTokenBalances({ result: { tokenBalances: [
    { contractAddress: BAYC.toLowerCase(), tokenBalance: '0x64' },
    { contractAddress: BAYC.toLowerCase(), tokenBalance: '0x0' },
    { contractAddress: '0xnope', tokenBalance: '0x64' },
  ] } });
  assert.deepEqual(toks, [BAYC], 'zero balances and bad addresses both dropped');
  assert.deepEqual(parseTokenBalances({}), []);
});

test('rpc: the pool is the retry', async () => {
  const { withFailover } = await import('../src/tokens.js');
  const tried: string[] = [];
  // accounts are pinned to one endpoint by address hash; when that one is slow
  // the wallet used to report the whole chain as unreachable, and switching
  // accounts appeared to "fix" it because it re-pinned you elsewhere
  const out = await withFailover(['dead-1', 'dead-2', 'alive'], async (ep) => {
    tried.push(ep);
    if (ep !== 'alive') throw new Error('The request took too long to respond.');
    return 'balances';
  });
  assert.equal(out, 'balances');
  assert.deepEqual(tried, ['dead-1', 'dead-2', 'alive'], 'tried in order, stopped at the first win');

  // the pinned endpoint is tried first and alone when it works
  const once: string[] = [];
  await withFailover(['pinned', 'other'], async (ep) => { once.push(ep); return 1; });
  assert.deepEqual(once, ['pinned'], 'a healthy pin costs no extra requests');

  await assert.rejects(
    withFailover(['a', 'b'], async () => { throw new Error('nope'); }),
    /all 2 endpoints failed — last said: nope/,
  );
});

test('router: the ETH/$RAD house route fails over and keeps the winning endpoint', async () => {
  const { bestEthToRadRouteAcross } = await import('../src/router.js');
  const tried: string[] = [];
  const v3 = {
    amountInEth: '0.001', amountOut: 37n, amountOutFormatted: '37',
    feeTier: 10_000, feeTierPct: '1.00%', minOut: 36n,
    minOutFormatted: '36', slippagePct: 1,
  };
  const found = await bestEthToRadRouteAcross(
    ['pinned-no-calls', 'healthy', 'unused'],
    '0.001',
    1,
    async (endpoint) => {
      tried.push(endpoint);
      return endpoint === 'healthy'
        ? { v3, v4: null, best: 'v3' as const }
        : { v3: null, v4: null, best: null };
    },
  );
  assert.equal(found.endpoint, 'healthy');
  assert.equal(found.best, 'v3');
  assert.deepEqual(tried, ['pinned-no-calls', 'healthy']);

  await assert.rejects(
    bestEthToRadRouteAcross(
      ['dead-a', 'dead-b'], '0.001', 1,
      async () => ({ v3: null, v4: null, best: null }),
    ),
    /all 2 endpoints failed — last said: no ETH\/\$RAD route from this endpoint/,
  );
});

// ---- NFT artwork: two hops, and a gate on both ----
test('media: tokenURI is a document, not a picture', async () => {
  const { imageFromMetadata, toLoadableUrl } = await import('../src/media.js');
  // pointing an <img> at the tokenURI renders nothing — the image is INSIDE
  const radbro = { name: 'Radbro #874', image: 'https://host/da11.png' };
  assert.equal(imageFromMetadata(radbro), 'https://host/da11.png');
  // the wild has other spellings
  assert.equal(imageFromMetadata({ image_url: 'ipfs://cid/x.png' }), 'https://ipfs.io/ipfs/cid/x.png');
  assert.equal(imageFromMetadata({ imageUrl: 'https://h/y.png' }), 'https://h/y.png');
  // and plenty of junk
  assert.equal(imageFromMetadata({}), null);
  assert.equal(imageFromMetadata(null), null);
  assert.equal(imageFromMetadata('not an object'), null);
  assert.equal(imageFromMetadata({ image: '   ' }), null);

  assert.equal(toLoadableUrl('ipfs://bafy1/pic.png'), 'https://ipfs.io/ipfs/bafy1/pic.png');
  assert.equal(toLoadableUrl('ipfs://ipfs/bafy1/pic.png'), 'https://ipfs.io/ipfs/bafy1/pic.png');
  assert.equal(toLoadableUrl('https://h/a.png'), 'https://h/a.png');
  assert.equal(toLoadableUrl('data:image/svg+xml;base64,AAA'), 'data:image/svg+xml;base64,AAA');
  // schemes a browser cannot load are refused, not guessed at
  assert.equal(toLoadableUrl('ar://tx'), null);
  assert.equal(toLoadableUrl(''), null);
  // the gateway is swappable, because ipfs.io is someone else's server
  assert.equal(toLoadableUrl('ipfs://cid/x', 'https://my.gw/'), 'https://my.gw/cid/x');
});

test('media: nothing is fetched until the user asks', async () => {
  const { resolveArt } = await import('../src/media.js');
  // if this ever hits the network with allowed:false, an <img> tag has become
  // a tracker — the whole reason art is a button and not a default
  assert.equal(await resolveArt('https://example.invalid/meta/1', { allowed: false }), null);
  assert.equal(await resolveArt('ipfs://cid/1', { allowed: false }), null);
  // and a URI it cannot even turn into a URL never reaches fetch
  assert.equal(await resolveArt('ar://tx', { allowed: true }), null);
});

// ---- prices: on-chain by default, third-party only on request ----
test('pricefeed: builds an auditable URL and stays off until asked', async () => {
  const { chartUrl, parseChart, fetchChart, priceFeedSupports, PRICEFEED_OFF } =
    await import('../src/pricefeed.js');
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  const url = chartUrl(1, USDC, 7);
  assert.ok(url.startsWith('https://api.coingecko.com/api/v3/coins/ethereum/contract/'), url);
  assert.ok(url.includes(USDC.toLowerCase()), 'contract is lowercased for the path');
  assert.ok(url.includes('days=7') && url.includes('vs_currency=usd'));
  assert.equal(chartUrl(8453, USDC, 1).includes('/coins/base/'), true);
  assert.throws(() => chartUrl(4663, USDC, 7), /no price feed/);
  assert.ok(priceFeedSupports(1) && !priceFeedSupports(4663));

  // the gate: nothing is fetched, on any chain, while this is off
  assert.deepEqual(await fetchChart(PRICEFEED_OFF, 1, USDC, 7), []);
  assert.equal(PRICEFEED_OFF.enabled, false, 'shipped default is off');

  // and a hostile/garbled response is data, not a crash
  assert.deepEqual(parseChart({ prices: [[1, 2], [3, 4]] }), [{ t: 1, p: 2 }, { t: 3, p: 4 }]);
  assert.deepEqual(parseChart({ prices: [[1, 0], [2, -5], ['x', 'y'], [7]] }), [],
    'zero, negative and malformed points dropped');
  assert.deepEqual(parseChart({}), []);
  assert.deepEqual(parseChart(null), []);
});

test('price: WETH is the unit, unknown chains have no on-chain price', async () => {
  const { spotPriceInEth, WETH_FOR } = await import('../src/price.js');
  // quoting WETH against itself is 1 by definition and must not hit the network
  const one = await spotPriceInEth('http://unreachable.invalid', 1, WETH_FOR[1], 18);
  assert.equal(one?.ethPerToken, '1');
  // Robinhood has no Uniswap deployment, so there is nothing to ask
  assert.equal(await spotPriceInEth('http://unreachable.invalid', 4663, WETH_FOR[1], 18), null);
});

// ---- swapping any pair ----
test('swapany: builds the right shape for each direction', async () => {
  const { buildSwapTx, buildApproveTx, canSwapOn, routerFor } = await import('../src/swapany.js');
  const { parseUnits } = await import('viem');
  const ME = '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B' as `0x${string}`;
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as `0x${string}`;
  const native = { address: null, symbol: 'ETH', decimals: 18 };
  const usdc = { address: USDC, symbol: 'USDC', decimals: 6 };
  const wbtc = { address: WBTC, symbol: 'WBTC', decimals: 8 };
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`;
  const q = { amountOut: 1000n, feeTier: 500, minOut: 990n, hops: [WETH, USDC], fees: [500] };

  // native in: the ETH rides along as value
  const a = buildSwapTx(1, ME, native, usdc, parseUnits('0.1', 18), q);
  assert.equal(a.to, routerFor(1));
  assert.equal(BigInt(a.value!), parseUnits('0.1', 18));
  assert.equal(a.data?.slice(0, 10), '0x04e45aaf', 'exactInputSingle');

  // erc20 -> erc20: no value at all
  const b = buildSwapTx(1, ME, usdc, wbtc, parseUnits('100', 6), q);
  assert.equal(b.value, undefined, 'an ERC-20 input must not send ETH');
  assert.equal(b.data?.slice(0, 10), '0x04e45aaf');

  // native out has to unwrap, or you silently end up holding WETH
  const c = buildSwapTx(1, ME, usdc, native, parseUnits('100', 6), q);
  assert.equal(c.data?.slice(0, 10), '0xac9650d8', 'multicall(swap, unwrapWETH9)');

  // approval is for the exact amount, never unlimited
  const ap = buildApproveTx(1, USDC, parseUnits('250', 6));
  assert.equal(ap.to, USDC);
  assert.equal(ap.data?.slice(0, 10), '0x095ea7b3');
  assert.equal(BigInt('0x' + ap.data!.slice(74)), 250000000n);
  const MAX = (1n << 256n) - 1n;
  assert.notEqual(BigInt('0x' + ap.data!.slice(74)), MAX, 'never an unlimited approval');

  // Robinhood Chain HAS a Uniswap v3 deployment — its own, not the mainnet
  // addresses — so it swaps like any other chain. Every chain we can quote on
  // must also be able to build the tx, or the UI offers a swap it cannot sign.
  assert.equal(canSwapOn(4663), true);
  assert.equal(routerFor(4663), '0xCaf681a66D020601342297493863E78C959E5cb2');
  // a chain with no deployment still says so instead of building a broken tx
  assert.equal(canSwapOn(46630), false);
  assert.throws(() => routerFor(46630), /no Uniswap router/);

  // ---- multi-hop ----
  // a two-hop quote must build exactInput with a packed path, not
  // exactInputSingle with the first fee tier and the wrong destination
  const q2 = {
    amountOut: 1000n, feeTier: 3000, minOut: 990n,
    hops: [USDC, WETH, WBTC], fees: [500, 3000],
  };
  const m = buildSwapTx(1, ME, usdc, wbtc, parseUnits('100', 6), q2);
  assert.equal(m.data?.slice(0, 10), '0xb858183f', 'exactInput, not exactInputSingle');
  // the packed path has to appear verbatim in the calldata: 20+3+20+3+20 bytes
  const packed = (USDC + '0001f4' + WETH.slice(2) + '000bb8' + WBTC.slice(2)).toLowerCase();
  assert.ok(m.data!.toLowerCase().includes(packed.slice(2)), 'token,fee,token,fee,token');
  // and a two-hop route out to native still unwraps
  const mn = buildSwapTx(1, ME, usdc, native, parseUnits('100', 6), {
    ...q2, hops: [USDC, WETH, WETH], fees: [500, 3000],
  });
  assert.equal(mn.data?.slice(0, 10), '0xac9650d8', 'multicall(exactInput, unwrapWETH9)');
});

test('swapany: the route search covers direct and two-hop, and stays one call', async () => {
  const { routeCandidates, hopCandidates, encodePath } = await import('../src/swapany.js');
  const { WETH_FOR } = await import('../src/price.js');
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as `0x${string}`;

  // a path is one fee per hop, packed tight, in swap order
  assert.equal(
    encodePath([USDC, WBTC], [500]).toLowerCase(),
    (USDC + '0001f4' + WBTC.slice(2)).toLowerCase(),
  );
  assert.throws(() => encodePath([USDC, WBTC], [500, 3000]), /one fee per hop/);

  // the pair itself is never an intermediate — routing USDC->WBTC through USDC
  // is not a route, and quoting it wastes a slot in the batch
  const mids = hopCandidates(1, USDC, WBTC);
  assert.ok(mids.length > 0 && mids.length <= 4);
  assert.equal(mids[0], WETH_FOR[1], 'wrapped native is tried first');
  for (const m of mids) {
    assert.notEqual(m.toLowerCase(), USDC.toLowerCase());
    assert.notEqual(m.toLowerCase(), WBTC.toLowerCase());
  }
  // and WETH is not offered twice when it IS the pair
  assert.ok(!hopCandidates(1, WETH_FOR[1], USDC).some((m) => m === WETH_FOR[1]));

  const cands = routeCandidates(1, USDC, WBTC);
  const direct = cands.filter((c) => c.fees.length === 1);
  const two = cands.filter((c) => c.fees.length === 2);
  assert.equal(direct.length, 4, 'every fee tier, directly');
  assert.equal(two.length, mids.length * 9, '3x3 fee combinations per intermediate');
  // the whole search has to fit one multicall, or it stops being one round trip
  assert.ok(cands.length <= 64, `${cands.length} candidates is still one call`);
  for (const c of cands) assert.equal(c.hops.length, c.fees.length + 1);
  // a chain with only its wrapped native to route through still tries it
  assert.ok(routeCandidates(4663, USDC, WBTC).some((c) => c.fees.length === 2));
});

test('swapany: a route says what it routes through', async () => {
  const { describeRoute } = await import('../src/swapany.js');
  const { WETH_FOR } = await import('../src/price.js');
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as `0x${string}`;
  const RAD = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB' as `0x${string}`;
  const base = { amountOut: 1n, minOut: 1n, feeTier: 500 };

  // one pool: the fee tier is the whole story
  assert.equal(
    describeRoute({ ...base, hops: [USDC, WBTC], fees: [500] }),
    'uniswap v3 · 0.05%',
  );
  // two pools: name the token in the middle, and both fees
  assert.equal(
    describeRoute({ ...base, hops: [RAD, WETH_FOR[1], USDC], fees: [10_000, 500] }),
    'uniswap v3 · via WETH · 1.00% + 0.05%',
  );
  // a token we route through but do not ship a name for is shown as an address
  // rather than invented
  const UNKNOWN = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  assert.equal(
    describeRoute({ ...base, hops: [RAD, UNKNOWN, USDC], fees: [3000, 3000] }),
    'uniswap v3 · via 0x1111… · 0.30% + 0.30%',
  );
});

test('swapany: refuses pairs it cannot quote', async () => {
  const { quoteSwap } = await import('../src/swapany.js');
  const usdc = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, symbol: 'USDC', decimals: 6 };
  // no router on this chain, so nothing is asked of the network
  assert.equal(await quoteSwap('http://unreachable.invalid', 4663, usdc, usdc, 1n), null);
  // a token against itself is not a trade
  assert.equal(await quoteSwap('http://unreachable.invalid', 1, usdc, usdc, 1n), null);
  // zero in, nothing out
  assert.equal(await quoteSwap('http://unreachable.invalid', 1, usdc, { address: null, symbol: 'ETH', decimals: 18 }, 0n), null);
});

// ---- replacing a stuck transaction ----
test('replace: a speed-up keeps the payload, a cancel destroys it', async () => {
  const { buildSpeedUp, buildCancel, replacementFees, isReplaceable, MIN_BUMP_PCT } =
    await import('../src/replace.js');
  const stuck = {
    hash: '0xabc' as `0x${string}`,
    nonce: 42,
    from: '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B' as `0x${string}`,
    to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`,
    value: 10n ** 18n,
    data: '0xa9059cbb0000' as `0x${string}`,
    blockNumber: null,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 10n,
    gasPrice: null,
  };

  const up = buildSpeedUp(stuck);
  assert.equal(up.nonce, 42, 'same nonce, or it is not a replacement');
  assert.equal(up.to, stuck.to, 'same destination');
  assert.equal(up.data, stuck.data, 'same calldata — changing it would send something else');
  assert.equal(BigInt(up.value as string), stuck.value, 'same value');
  assert.ok(BigInt(up.maxFeePerGas!) > stuck.maxFeePerGas, 'and it must actually cost more');

  const kill = buildCancel(stuck);
  assert.equal(kill.nonce, 42, 'the whole point: it races the original');
  assert.equal(kill.to, stuck.from, 'a cancel pays yourself');
  assert.equal(BigInt(kill.value as string), 0n);
  assert.equal(kill.data, '0x', 'and does nothing');

  // geth rejects a replacement that does not beat the original by 10%
  const fees = replacementFees(stuck, 0);
  assert.ok(fees.maxFeePerGas >= (stuck.maxFeePerGas * BigInt(100 + MIN_BUMP_PCT)) / 100n,
    'the floor is enforced even when asked for less');
  // the tip may never exceed the cap or the node refuses it outright
  const skewed = replacementFees({ ...stuck, maxFeePerGas: 5n, maxPriorityFeePerGas: 500n });
  assert.ok(skewed.maxFeePerGas >= skewed.maxPriorityFeePerGas, 'cap >= tip, always');
  // a legacy transaction has only gasPrice, and still has to be replaceable
  const legacy = replacementFees({ ...stuck, maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 80n });
  assert.ok(legacy.maxFeePerGas > 80n && legacy.maxPriorityFeePerGas > 0n);
  // the network's current price wins if it has moved above our bump
  const hot = replacementFees(stuck, 25, { maxFeePerGas: 10_000n, maxPriorityFeePerGas: 900n });
  assert.equal(hot.maxFeePerGas, 10_000n);
  assert.equal(hot.maxPriorityFeePerGas, 900n);

  // and something already mined is not a candidate at all
  assert.equal(isReplaceable(stuck), true);
  assert.equal(isReplaceable({ ...stuck, blockNumber: 12345n }), false);
});

test('dapp transactions cannot pick their own nonce', async () => {
  const { sanitizeDappTx } = await import('../src/chain.js');
  // a site that could choose a nonce could replace a transaction you already
  // signed, swapping a send for something else entirely at the same slot
  const hostile = {
    to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`,
    value: '0x1' as `0x${string}`,
    data: '0xdeadbeef' as `0x${string}`,
    nonce: 7,
    maxFeePerGas: '0x1' as `0x${string}`,
    maxPriorityFeePerGas: '0x1' as `0x${string}`,
  };
  const safe = sanitizeDappTx(hostile);
  assert.equal(safe.nonce, undefined);
  assert.equal(safe.maxFeePerGas, undefined);
  assert.equal(safe.maxPriorityFeePerGas, undefined);
  assert.equal(safe.to, hostile.to, 'the parts a dapp legitimately sets survive');
  assert.equal(safe.data, hostile.data);
});

async function withNonceTooLowRpc(
  exactHashKnown: boolean,
  run: (endpoint: string, methods: string[]) => Promise<void>,
): Promise<void> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      methods.push(call.method);
      const reply = call.method === 'eth_chainId'
        ? { jsonrpc: '2.0', id: call.id, result: '0x1' }
        : call.method === 'eth_sendRawTransaction'
          ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'nonce too low' } }
          : call.method === 'eth_getTransactionByHash'
          ? {
            jsonrpc: '2.0', id: call.id,
            result: exactHashKnown ? { hash: call.params?.[0] } : null,
          }
          : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unexpected ${call.method}` } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`, methods);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
}

const PINNED_TX = {
  to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  value: '0x1' as `0x${string}`,
  nonce: 42,
  gas: '0x5208' as `0x${string}`,
  maxFeePerGas: '0x77359400' as `0x${string}`,
  maxPriorityFeePerGas: '0x3b9aca00' as `0x${string}`,
};

test('broadcast: nonce-too-low succeeds only when the node knows these exact signed bytes', async () => {
  await withNonceTooLowRpc(true, async (endpoint, methods) => {
    const hash = await sendDappTx(endpoint, deriveAccount(TEST_MNEMONIC, 0), PINNED_TX, 1);
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(methods.slice(-3), ['eth_chainId', 'eth_sendRawTransaction', 'eth_getTransactionByHash']);
  });
});

test('broadcast: a reused nonce refuses when another transaction consumed it', async () => {
  await withNonceTooLowRpc(false, async (endpoint, methods) => {
    await assert.rejects(
      () => sendDappTx(endpoint, deriveAccount(TEST_MNEMONIC, 0), PINNED_TX, 1),
      /nonce too low/i,
    );
    assert.deepEqual(methods.slice(-3), ['eth_chainId', 'eth_sendRawTransaction', 'eth_getTransactionByHash']);
  });
});

test('price: a fiat total without a price API', async () => {
  const { usd, valueInEth } = await import('../src/price.js');
  // formatting: a wallet should never show "$0.00" for dust it actually holds
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(0.004), '<$0.01');
  assert.equal(usd(1881.4582), '$1,881');
  assert.equal(usd(12.5), '$12.50');
  assert.equal(usd(NaN), '—');

  // a zero balance is worth zero at any price, so it costs no quote at all
  const valued = await valueInEth('http://unreachable.invalid', 1, [
    { symbol: 'ZERO', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '0', decimals: 6 },
    { symbol: 'ETH', amount: '1.5', decimals: 18 },
  ]);
  assert.deepEqual(valued.map((v) => v.ethValue), [0, 1.5],
    'zero priced for free, and native needs no quote either');
});

// ---- the embedded DEX chart: opt-in, and it names its host ----
test('dex chart: builds a URL for the chains it covers, refuses the rest', async () => {
  const {
    dexChartUrl, dexChartSupports, DEXCHART_HOST, DEXCHART_OFF,
  } = await import('../src/dexchart.js');
  const { CHAINS, CHAIN_IDS } = await import('../src/chains.js');
  const RAD = '0xdDc6625FEcA10438857DD8660C021Cd1088806FB';

  assert.equal(DEXCHART_OFF.enabled, false, 'the shipped default never embeds anyone');
  // measured against their own /api/v2/networks. Robinhood was absent when
  // this shipped and has since been added, which is why the list is re-read
  // rather than trusted; the TESTNET is still not on it.
  assert.ok(dexChartSupports(1) && dexChartSupports(8453) && dexChartSupports(42161));
  assert.ok(dexChartSupports(4663), 'geckoterminal added Robinhood');
  assert.ok(!dexChartSupports(46630));
  assert.throws(() => dexChartUrl(46630, RAD), /no DEX chart/);
  // a chain with no slug must refuse rather than guess: a wrong slug is a 404
  // inside the frame, which reads as a broken wallet
  assert.throws(() => dexChartUrl(999, RAD), /no DEX chart/);
  assert.throws(() => dexChartUrl(1, 'not-an-address'), /token address/);

  const url = new URL(dexChartUrl(1, RAD));
  assert.equal(url.host, DEXCHART_HOST, 'exactly one host, and the UI names it');
  assert.equal(url.pathname, `/eth/tokens/${RAD}`);
  assert.equal(url.searchParams.get('embed'), '1');
  // their header and trade feed are off: we want a chart, not a second wallet
  assert.equal(url.searchParams.get('info'), '0');
  assert.equal(url.searchParams.get('swaps'), '0');
  // the address never leaks into the URL — only the token being looked at
  assert.ok(!url.search.includes('0x2Bc7'), 'no owner address in a chart URL');

  // every chart-capable chain can chart NATIVE eth too, or the most-viewed
  // asset in the wallet is the one with no chart
  for (const id of CHAIN_IDS) {
    if (!dexChartSupports(id)) continue;
    const weth = CHAINS[id].wrappedNative;
    assert.ok(weth, `${CHAINS[id].name} knows its wrapped native, for charting ETH`);
    assert.equal(new URL(dexChartUrl(id, weth)).host, DEXCHART_HOST);
  }
});

// ---- Uniswap v4: a different exchange, not a newer one ----
test('swapv4: pools are discovered, not guessed, and a v4 quote is never signed as v3', async () => {
  const { v4Deployment, sortCurrencies, UNISWAP_V4, PERMIT2 } = await import('../src/swapv4.js');
  const { buildSwapTx } = await import('../src/swapany.js');
  const { parseUnits, zeroAddress } = await import('viem');
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const ME = '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B' as `0x${string}`;

  // v4 sorts by address and native sorts first, which decides zeroForOne
  assert.deepEqual(sortCurrencies(URU, zeroAddress), [zeroAddress, URU]);
  assert.deepEqual(sortCurrencies(zeroAddress, URU), [zeroAddress, URU]);

  // every registered deployment must be complete: a half-configured chain
  // would quote and then fail to build
  for (const [id, dep] of Object.entries(UNISWAP_V4)) {
    for (const k of ['poolManager', 'quoter', 'universalRouter'] as const) {
      assert.match(dep[k], /^0x[0-9a-fA-F]{40}$/, `chain ${id} ${k}`);
    }
  }
  assert.ok(v4Deployment(4663), 'Robinhood has v4 — its URU markets live there');
  assert.equal(v4Deployment(46630), undefined, 'and its testnet does not');
  assert.match(PERMIT2, /^0x[0-9a-fA-F]{40}$/);

  // THE IMPORTANT ONE. A v4 quote carries a real price off a real pool, and
  // this module builds SwapRouter02 calldata. Signing one with the other would
  // send a transaction to a contract that knows nothing about the pool.
  const v4quote = {
    amountOut: 1000n, minOut: 990n, feeTier: 3000, protocol: 'v4' as const,
    hops: [URU, zeroAddress] as `0x${string}`[], fees: [3000],
    poolKey: {
      currency0: zeroAddress as `0x${string}`, currency1: URU,
      fee: 3000, tickSpacing: 60, hooks: zeroAddress as `0x${string}`,
    },
    zeroForOne: false,
  };
  assert.throws(
    () => buildSwapTx(4663, ME, { address: URU, symbol: 'URU', decimals: 18 },
      { address: null, symbol: 'ETH', decimals: 18 }, parseUnits('1', 18), v4quote),
    /v4/,
    'a v4 quote must never be built as a v3 transaction',
  );
});

test('swapv4: a v4 route says which exchange, pool and hook it came from', async () => {
  const { describeRoute } = await import('../src/swapany.js');
  const { zeroAddress } = await import('viem');
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const HOOK = '0x8933d28E68d02FaA02436aeF42E6ba9674698044' as `0x${string}`;
  const base = {
    amountOut: 1n, minOut: 1n, feeTier: 3000, protocol: 'v4' as const,
    hops: [URU, zeroAddress] as `0x${string}`[], fees: [3000], zeroForOne: false,
  };
  const key = (hooks: `0x${string}`) => ({
    currency0: zeroAddress as `0x${string}`, currency1: URU, fee: 3000, tickSpacing: 60, hooks,
  });
  assert.equal(describeRoute({ ...base, poolKey: key(zeroAddress) }), 'uniswap v4 · 0.30%');
  // the two things that change what the trade IS get named: a wrapped-ether
  // pool needs an unwrap, and a hook can do anything a hook likes
  assert.equal(
    describeRoute({ ...base, poolKey: key(HOOK), wrapped: true }),
    'uniswap v4 · 0.30% · wrapped-ether pool · hooked',
  );
  // launch-curve pools really do charge this much, and it must be legible
  assert.equal(
    describeRoute({ ...base, fees: [880000], poolKey: { ...key(zeroAddress), fee: 880000 } }),
    'uniswap v4 · 88.00%',
  );
});

test('swapv4: the router struct differs per chain, and the wrong one reverts empty', async () => {
  const { encodeV4SwapInput, usesLegacyV4Struct, buildV4SwapTx, v4Deployment } =
    await import('../src/swapv4.js');
  const { parseUnits } = await import('viem');
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as `0x${string}`;
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const HOOK = '0x8933d28E68d02FaA02436aeF42E6ba9674698044' as `0x${string}`;
  const key = { currency0: WETH, currency1: URU, fee: 3000, tickSpacing: 60, hooks: HOOK };
  const amt = parseUnits('1000', 18);

  // v4-periphery added minHopPriceX36 between amountOutMinimum and hookData.
  // Encode the wrong shape and the calldata misaligns, and the router reverts
  // with EMPTY data — which reads like a dead RPC, not a bug in the tx.
  assert.ok(usesLegacyV4Struct(8453) && usesLegacyV4Struct(1));
  assert.ok(!usesLegacyV4Struct(4663), 'Robinhood takes the newer struct');
  const legacy = encodeV4SwapInput(key, false, amt, 1n, 8453);
  const modern = encodeV4SwapInput(key, false, amt, 1n, 4663);
  assert.notEqual(legacy, modern, 'the two shapes must not encode the same');
  assert.equal(modern.length - legacy.length, 64, 'exactly one extra 32-byte word');

  // the actions are SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, in that order
  assert.ok(legacy.includes('060c0f'), 'actions header');

  // an ERC-20 input is pulled through Permit2, so it must NOT also send value
  const tx = buildV4SwapTx(4663, key, false, amt, 1n, 0n);
  assert.equal(tx.to, v4Deployment(4663)!.universalRouter);
  assert.equal(tx.value, undefined, 'an ERC-20 input must not send ETH');
  assert.equal(tx.data.slice(0, 10), '0x3593564c', 'UniversalRouter.execute');
});

test('swapany: a plan says every signature a swap will cost', async () => {
  const { planSwap } = await import('../src/swapany.js');
  const { parseUnits, zeroAddress } = await import('viem');
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as `0x${string}`;
  const ME = '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B' as `0x${string}`;
  const amt = parseUnits('1000', 18);
  // an unreachable endpoint makes the allowance reads fail closed, which is
  // the safe direction: it proposes approvals rather than skipping them
  const EP = 'http://unreachable.invalid';

  // selling a token for NATIVE through a wrapped-ether pool has to unwrap, or
  // you asked for ETH and are handed WETH you never mentioned
  const plan = await planSwap(EP, 4663, ME,
    { address: URU, symbol: 'URU', decimals: 18 },
    { address: null, symbol: 'ETH', decimals: 18 }, amt, {
      amountOut: 10n, minOut: 9n, feeTier: 3000, protocol: 'v4',
      hops: [URU, zeroAddress], fees: [3000], wrapped: true, zeroForOne: false,
      poolKey: { currency0: WETH, currency1: URU, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    }, 1000n);
  assert.ok(plan.unwrap, 'a wrapped-pool route back to ETH unwraps');
  assert.equal(plan.wrap, undefined, 'and does not also wrap');
  assert.equal(plan.approvals.length, 2, 'Permit2 is two approvals, not one');
  assert.deepEqual(plan.approvals.map((a) => a.tx.to), [URU, '0x000000000022D473030F116dDEE9F6B43aC78BA3']);

  // and buying a token WITH native through the same pool wraps first
  const buy = await planSwap(EP, 4663, ME,
    { address: null, symbol: 'ETH', decimals: 18 },
    { address: URU, symbol: 'URU', decimals: 18 }, amt, {
      amountOut: 10n, minOut: 9n, feeTier: 3000, protocol: 'v4',
      hops: [zeroAddress, URU], fees: [3000], wrapped: true, zeroForOne: true,
      poolKey: { currency0: WETH, currency1: URU, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    }, 1000n);
  assert.ok(buy.wrap, 'native in through a wrapped pool wraps first');
  assert.equal(buy.unwrap, undefined);
});

test('swapv4: a pool fee is hundredths of a bip, and the UI must not misread it', async () => {
  const { describeRoute } = await import('../src/swapany.js');
  const { zeroAddress } = await import('viem');
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const q = (fee: number) => ({
    amountOut: 1n, minOut: 1n, feeTier: fee, protocol: 'v4' as const,
    hops: [URU, zeroAddress] as `0x${string}`[], fees: [fee], zeroForOne: false,
    poolKey: {
      currency0: zeroAddress as `0x${string}`, currency1: URU,
      fee, tickSpacing: 60, hooks: zeroAddress as `0x${string}`,
    },
  });
  // v4 and v3 share the unit: 1_000_000 is 100%, so a fee is fee/10_000 percent.
  // Every one of these was read back off Robinhood's PoolManager, including the
  // launch-curve pools that really do charge most of the trade.
  assert.equal(describeRoute(q(100)), 'uniswap v4 · 0.01%');
  assert.equal(describeRoute(q(3000)), 'uniswap v4 · 0.30%');
  assert.equal(describeRoute(q(10_000)), 'uniswap v4 · 1.00%');
  assert.equal(describeRoute(q(500_000)), 'uniswap v4 · 50.00%');
  assert.equal(describeRoute(q(973_690)), 'uniswap v4 · 97.37%');
});

test('swapany: a v4 plan takes its deadline from the CHAIN, not this machine', async () => {
  const { planSwap } = await import('../src/swapany.js');
  const { parseUnits, zeroAddress } = await import('viem');
  const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as `0x${string}`;
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as `0x${string}`;
  const ME = '0x2Bc7ac8C41F86f4c27F06F090eC2F42e9aA4f29B' as `0x${string}`;
  const quote = {
    amountOut: 1000n, minOut: 990n, feeTier: 3000, protocol: 'v4' as const,
    hops: [URU, zeroAddress] as `0x${string}`[], fees: [3000], wrapped: true, zeroForOne: false,
    poolKey: { currency0: WETH, currency1: URU, fee: 3000, tickSpacing: 60, hooks: zeroAddress as `0x${string}` },
  };
  // the router checks the deadline against block.timestamp. A laptop twenty
  // minutes slow would expire every swap, with nothing on screen to explain
  // it, so the caller passes chain time — and when it does, that is what ends
  // up in the calldata rather than Date.now().
  const chainNow = 1_000_000n;
  const plan = await planSwap('http://unreachable.invalid', 4663, ME,
    { address: URU, symbol: 'URU', decimals: 18 },
    { address: null, symbol: 'ETH', decimals: 18 },
    parseUnits('1', 18), quote, chainNow);
  // execute(bytes commands, bytes[] inputs, uint256 deadline): the first two
  // are dynamic, so the head is [offset, offset, deadline] and the deadline is
  // the THIRD word after the selector — not the last word, which is tail data
  const data = plan.swap.tx.data!;
  const deadline = BigInt('0x' + data.slice(10 + 128, 10 + 192));
  assert.equal(deadline, chainNow + 1200n, 'twenty minutes from CHAIN time');

  // and the unwrap must be able to size itself to what actually arrived:
  // minOut is only the floor, so unwrapping that strands the difference
  assert.ok(plan.unwrap, 'a wrapped route back to ETH unwraps');
  assert.equal(typeof plan.unwrapAll, 'function', 'and can re-size to the real balance');
  const floor = BigInt('0x' + plan.unwrap!.tx.data!.slice(10));
  assert.equal(floor, quote.minOut, 'the fallback unwrap is the guaranteed floor');
});

test('price: one lookup for a whole chain, and zero balances cost nothing', async () => {
  const { spotPricesInEth, valueInEth } = await import('../src/price.js');
  const { WETH_FOR } = await import('../src/price.js');
  const DEAD = 'http://unreachable.invalid';

  // wrapped native is the unit, answered without asking anyone
  const m = await spotPricesInEth(DEAD, 1, [{ address: WETH_FOR[1], decimals: 18 }]);
  assert.equal(m.get(WETH_FOR[1].toLowerCase())?.ethPerToken, '1');
  // nothing to price is not a request
  assert.equal((await spotPricesInEth(DEAD, 1, [])).size, 0);
  // a chain with no Uniswap at all returns nothing rather than throwing
  assert.equal((await spotPricesInEth(DEAD, 46630, [{ address: WETH_FOR[1], decimals: 18 }])).size, 0);

  // valuing must not ask about balances that are zero — that used to be a
  // request per holding on every refresh — and native ETH is its own value
  const valued = await valueInEth(DEAD, 1, [
    { symbol: 'ETH', amount: '2.5', decimals: 18 },
    { symbol: 'ZERO', address: WETH_FOR[1], amount: '0', decimals: 18 },
    { symbol: 'DUST', address: WETH_FOR[1], amount: '<0.0001', decimals: 18 },
  ]);
  assert.equal(valued[0].ethValue, 2.5, 'native ETH is worth its own amount');
  assert.equal(valued[1].ethValue, 0, 'a zero balance is worth zero at any price');
  // "<0.0001" is a display string; it must still parse to a number, not NaN
  assert.equal(typeof valued[2].ethValue, 'number');
  assert.equal(valued.length, 3, 'every holding gets a row back, in order');
});

test('price: every chain is priced once across every wallet', async () => {
  const { valueWalletSnapshots } = await import('../src/price.js');
  const TOKEN_A = '0x000000000000000000000000000000000000000A' as `0x${string}`;
  const TOKEN_B = '0x000000000000000000000000000000000000000b' as `0x${string}`;
  const calls: Array<{ chainId: number; tokens: string[] }> = [];

  const result = await valueWalletSnapshots([
    {
      address: 'wallet-a',
      chains: [
        {
          chainId: 1,
          holdings: [
            { symbol: 'ETH', amount: '1', decimals: 18 },
            { symbol: 'A', address: TOKEN_A, amount: '2', decimals: 18 },
          ],
        },
        {
          chainId: 8453,
          holdings: [
            { symbol: 'ETH', amount: '0.25', decimals: 18 },
            { symbol: 'A', address: TOKEN_A, amount: '1', decimals: 18 },
          ],
        },
      ],
    },
    {
      address: 'wallet-b',
      chains: [{
        chainId: 1,
        holdings: [
          { symbol: 'ETH', amount: '0.5', decimals: 18 },
          { symbol: 'A', address: TOKEN_A, amount: '4', decimals: 18 },
          { symbol: 'B', address: TOKEN_B, amount: '1', decimals: 18 },
        ],
      }],
    },
  ], async (chainId, tokens) => {
    calls.push({ chainId, tokens: tokens.map((t) => t.address.toLowerCase()).sort() });
    const prices = new Map();
    for (const token of tokens) {
      const rate = chainId === 8453 ? 1 : token.address.toLowerCase() === TOKEN_A.toLowerCase() ? 0.5 : 2;
      prices.set(token.address.toLowerCase(), {
        ethPerToken: String(rate), feeTier: 3000, quotedFor: '1',
      });
    }
    return prices;
  });

  assert.deepEqual(calls, [
    { chainId: 1, tokens: [TOKEN_A.toLowerCase(), TOKEN_B.toLowerCase()].sort() },
    { chainId: 8453, tokens: [TOKEN_A.toLowerCase()] },
  ], 'duplicate holdings share one lookup and prices stay chain-scoped');
  assert.equal(result.totals['wallet-a'], 3.25);
  assert.equal(result.totals['wallet-b'], 4.5);
});

test('v4 discovery does not retry one unresponsive RPC behind the pool', async () => {
  const { discoverV4Pools } = await import('../src/swapv4.js');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('not today');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const pools = await discoverV4Pools(
      `http://127.0.0.1:${address.port}`,
      1,
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    );
    assert.equal(pools.length, 3, 'an unavailable log query still uses the standard-key fallback');
    assert.equal(requests, 1, 'the RPC pool is the retry; one endpoint gets one attempt');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test('price: transport failure escapes when the caller owns endpoint failover', async () => {
  const { spotPricesInEth } = await import('../src/price.js');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('rotate me');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(() => spotPricesInEth(
      `http://127.0.0.1:${address.port}`,
      1,
      [{ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }],
      { throwOnRpcError: true },
    ));
    assert.equal(requests, 1, 'pricing gives the pool control after one failed endpoint attempt');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

// ---- Transfer netting for transaction previews --------------------------
// Canned logs prove each wallet receives its own transfer summary.
import {
  mergeTrackedTokens, netTransfers, swapOutputTokens, type AssetMove, type SimLog,
} from '../src/simulate.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicOf = (addr: string): string => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIM_POOL = '0x1111111111111111111111111111111111111111';
const SIM_TOKEN = '0x2222222222222222222222222222222222222222';
const SIM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const xfer = (asset: string, from: string, to: string, amount: bigint): SimLog => ({
  address: asset,
  topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
  data: '0x' + amount.toString(16).padStart(64, '0'),
});

test('transfer netting: a swap debits and credits the sender', () => {
  // B pays 1 ETH to the pool. The pool pays B tokens.
  const logs = [
    xfer(SIM_NATIVE, WALLET_B, SIM_POOL, 10n ** 18n),
    xfer(SIM_TOKEN, SIM_POOL, WALLET_B, 40_000n * 10n ** 18n),
  ];
  const mine = netTransfers(logs, WALLET_B);
  assert.equal(mine.get(SIM_NATIVE)?.raw, -(10n ** 18n), 'the sender pays the ETH');
  assert.equal(mine.get(SIM_TOKEN)?.raw, 40_000n * 10n ** 18n, 'the sender receives the tokens');
  // The other wallet has no transfer.
  assert.equal(netTransfers(logs, WALLET_A).size, 0, 'nothing lands on the other wallet');
});

test('transfer netting: separate sender and recipient have separate totals', () => {
  // B pays for a transfer to A.
  const logs = [
    xfer(SIM_NATIVE, WALLET_B, SIM_POOL, 10n ** 18n),
    xfer(SIM_TOKEN, SIM_POOL, WALLET_A, 40_000n * 10n ** 18n),
  ];
  const leaked = [...netTransfers(logs, WALLET_A).values()].filter((s) => s.raw > 0n);
  assert.equal(leaked.length, 1, 'the recipient receives tokens');
  const mine = netTransfers(logs, WALLET_B);
  assert.equal(mine.get(SIM_NATIVE)?.raw, -(10n ** 18n), 'the sender only pays');
  assert.equal(mine.get(SIM_TOKEN), undefined);
});

test('transfer netting: ERC-721s, self-sends and exact cancels behave', () => {
  const nft = (from: string, to: string, id: bigint): SimLog => ({
    address: SIM_TOKEN,
    topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to), '0x' + id.toString(16).padStart(64, '0')],
    data: '0x',
  });
  // a 4-topic log is an NFT: ids are tracked, not amounts
  const got = netTransfers([nft(SIM_POOL, WALLET_B, 874n)], WALLET_B);
  assert.equal(got.get(SIM_TOKEN)?.erc721, true);
  assert.deepEqual([...got.get(SIM_TOKEN)!.ids.keys()], ['874']);
  // to yourself: nothing changes hands
  assert.equal(netTransfers([xfer(SIM_TOKEN, WALLET_B, WALLET_B, 5n)], WALLET_B).size, 0);
  // in and out that cancel exactly still net to zero raw
  const flat = netTransfers([
    xfer(SIM_TOKEN, SIM_POOL, WALLET_B, 7n),
    xfer(SIM_TOKEN, WALLET_B, SIM_POOL, 7n),
  ], WALLET_B);
  assert.equal(flat.get(SIM_TOKEN)?.raw, 0n);
  // a non-Transfer topic is ignored entirely
  assert.equal(netTransfers([{ address: SIM_TOKEN, topics: ['0x00'], data: '0x01' }], WALLET_B).size, 0);
});

test('swap tracking: only positive ERC-20 outputs from a trade are adopted', () => {
  const moves: AssetMove[] = [
    {
      kind: 'native', address: null, symbol: 'ETH', name: 'Ether', decimals: 18,
      raw: -(10n ** 18n), amount: '1', tokenIds: [],
    },
    {
      kind: 'erc20', address: SIM_TOKEN, symbol: 'NEW', name: 'New Token', decimals: 9,
      raw: 42_000_000_000n, amount: '42', tokenIds: [],
    },
  ];
  assert.deepEqual(swapOutputTokens(moves), [{
    address: '0x2222222222222222222222222222222222222222',
    symbol: 'NEW', name: 'New Token', decimals: 9,
  }]);
});

test('swap tracking: unknown ERC-20 metadata keeps its onchain name and decimals', async () => {
  const owner = WALLET_B as `0x${string}`;
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const token = SIM_TOKEN as `0x${string}`;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body) as {
        id: number;
        method: string;
        params?: Array<{ data?: `0x${string}` }>;
      };
      let result: unknown;
      if (rpc.method === 'eth_simulateV1') {
        result = [{ calls: [{
          status: '0x1',
          gasUsed: '0x5208',
          logs: [
            xfer(native, owner, SIM_POOL, 10n ** 18n),
            xfer(token, SIM_POOL, owner, 10n ** 15n),
          ],
        }] }];
      } else if (rpc.method === 'eth_call') {
        const aggregate = decodeFunctionData({
          abi: multicall3Abi,
          data: rpc.params?.[0]?.data ?? '0x',
        });
        assert.equal(aggregate.functionName, 'aggregate3');
        const calls = aggregate.args[0];
        result = encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: calls.map((call) => {
            const decoded = decodeFunctionData({ abi: erc20Abi, data: call.callData });
            let returnData: `0x${string}`;
            if (decoded.functionName === 'symbol') {
              returnData = encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'WETH' });
            } else if (decoded.functionName === 'name') {
              returnData = encodeFunctionResult({ abi: erc20Abi, functionName: 'name', result: 'Wrapped Ether' });
            } else if (decoded.functionName === 'decimals') {
              returnData = encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 18 });
            } else {
              throw new Error(`unexpected token metadata call ${decoded.functionName}`);
            }
            return {
              success: true,
              returnData,
            };
          }),
        });
      } else {
        throw new Error(`unexpected RPC method ${rpc.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { simulateTx } = await import('../src/simulate.js');
    const simulated = await simulateTx(
      `http://127.0.0.1:${address.port}`,
      4663,
      owner,
      { from: owner, to: SIM_POOL as `0x${string}`, value: 10n ** 18n },
    );
    const received = simulated?.moves.find((move) => move.address?.toLowerCase() === token.toLowerCase());
    assert.equal(received?.symbol, 'WETH');
    assert.equal(received?.name, 'Wrapped Ether');
    assert.equal(received?.decimals, 18);
    assert.equal(received?.amount, '0.001');
    assert.deepEqual(swapOutputTokens(simulated?.moves ?? []), [{
      address: '0x2222222222222222222222222222222222222222',
      symbol: 'WETH', name: 'Wrapped Ether', decimals: 18,
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});

test('swap tracking: claims, NFTs and malformed metadata do not become tracked tokens', () => {
  const incoming = (patch: Partial<AssetMove> = {}): AssetMove => ({
    kind: 'erc20', address: SIM_TOKEN, symbol: 'NEW', name: 'New Token', decimals: 18,
    raw: 10n, amount: '0.00000000000000001', tokenIds: [], ...patch,
  });
  assert.deepEqual(swapOutputTokens([incoming()]), [], 'an incoming-only claim is not a swap');
  assert.deepEqual(swapOutputTokens([
    incoming({ raw: -1n }),
    incoming({ kind: 'erc721', raw: 1n, decimals: 0, tokenIds: ['874'] }),
  ]), [], 'NFT output is not an ERC-20 to track');
  assert.deepEqual(swapOutputTokens([
    incoming({ raw: -1n }),
    incoming({ address: '0xnot-an-address' as `0x${string}` }),
    incoming({ address: '0x3333333333333333333333333333333333333333', symbol: '???' }),
  ]), [], 'untrusted token metadata is refused');
});

test('swap tracking: persisted targets merge by chain address without duplicating bundled tokens', () => {
  const existing = [{
    address: SIM_TOKEN as `0x${string}`, symbol: 'NEW', name: 'New Token', decimals: 9,
  }];
  const bundled = [{
    address: '0x4444444444444444444444444444444444444444' as `0x${string}`,
    symbol: 'OLD', name: 'Bundled Token', decimals: 18,
  }];
  assert.deepEqual(mergeTrackedTokens(existing, [
    { ...existing[0], symbol: 'DUPLICATE' },
    bundled[0],
    {
      address: '0x3333333333333333333333333333333333333333',
      symbol: 'TWO', name: 'Second Token', decimals: 6,
    },
  ], bundled), [
    existing[0],
    {
      address: '0x3333333333333333333333333333333333333333',
      symbol: 'TWO', name: 'Second Token', decimals: 6,
    },
  ]);
});
