# RADWALLET architecture

This is a public source alpha. The independent security audit remains open.
Store submission requires the gate in `STORE.md`.

## Commands

Use Node 22.

```bash
npm ci
npm test
npx tsc -p apps/wallet/tsconfig.json
npm run build
npm run lint:firefox
npm run e2e
npm run e2e:ext
npm run e2e:firefox
npm run package
```

Use `npm run lint:android` and `npm run e2e:android` for Android work.
`npm run e2e:anvil` needs Foundry and a reachable fork RPC.
`npm run tokens` needs network access. Normal builds use the bundled list.

## Modules

`packages/core` is a pure TypeScript engine. It has no UI imports. It owns
vault encryption, key derivation, RPC pools, chain metadata, token reads,
NFT reads, allowances, swaps, and stealth addresses.

One vault can hold several seed phrases and imported keys. The flat wallet
index comes from `accountAt` and `listAccounts` in `keyring.ts`. Names and
labels remain inside the encrypted vault. Testnet balances do not contribute
to priced portfolio totals.

`apps/wallet` contains the Preact UI. Signals in `src/state.ts` hold public
state. The build injects `__APP_VERSION__` from the root `package.json`.
The UI, demo, Pages, and background modes have different outputs.

`apps/extension/assemble.mjs` assembles Chrome and Firefox targets. The
Chrome manifest is the source of truth. Firefox uses an event page instead
of a service worker. Both targets use the same signing logic.

## Session boundary

`apps/wallet/src/session.ts` defines the session interface. The extension
background owns decrypted keys. Screens send JSON-safe session messages.
The PWA uses the corresponding session in page memory. Never derive a key
in a screen component.

An authenticated AES-GCM envelope in `storage.session` supports extension
worker recovery. It does not store a plaintext mnemonic or private key.
The non-extractable wrapping key uses extension-origin IndexedDB. Explicit
lock removes the envelope and key. Browser restart clears the envelope.
The authenticated deadline rejects expired recovery.

The session owns vault mutations and re-seals the vault. Screens persist
returned ciphertext. Screens must not cache a password to modify the vault.
After worker recovery, a vault mutation can require a fresh unlock because
the password-derived vault key is not cached across recovery.

Secret reveal opens the sealed vault with the password supplied for that
operation. An existing unlocked session does not grant secret reveal.
The UI discards a revealed secret when its view closes.

## Browser and provider boundaries

Wallet source uses extension APIs only through `src/ext.ts`. Use callback
style. Put browser differences in that file. Docking must start during the
user gesture. Both sidebars load `index.html?panel=1`.

Site connections use the session API. The content script reports its own
origin. The wallet does not need tab or host permissions to read page URLs.
Each content script filters connection events by its own origin.

Messages use primitives and hex strings. Never pass bigint through extension
runtime messages. Preserve EIP-1193 error codes: 4001 for user rejection,
4902 for unknown chains, and 4200 for unsupported methods.

A site's `wallet_addEthereumChain` request does not supply trusted RPC URLs.
Only wallet-approved chain configuration can supply endpoints. Probe
`eth_chainId` before adding an RPC endpoint to a pool. Allow remote HTTPS.
Allow HTTP only for loopback endpoints.

## Signing and routing

Preview transactions before signing. Keep REFUSE as large as SIGN. Rewrite
unlimited ERC-20 allowances to bounded amounts by default. Show exact amounts
with the token's verified decimals. Reject unsupported decimal precision.

RADSWAP compares v3 paths and the supported house v4 path. On Robinhood, it
also resolves ordinary single-wallet Pons V2 curve routes through the factory
and reverse links. Show venue fees and creator or recipient taxes. Curve
sells require an exact allowance.

KyberSwap is an explicit opt-in for Ethereum and Robinhood. Treat its
calldata as untrusted. Bind router, pair, input, recipient, value, and minimum
output. Reject extra fees, permits, partial fills, and unknown flags. Refresh
and simulate before signing. Direct routes remain available on API failure.
Gas is shown during review but is not deducted from route comparisons.

## Privacy invariants

- Add no telemetry, wallet server, or wallet swap fee receiver.
- Keep network access within approved boundaries.
- Keep optional services off until the user requests them.
- Keep disclosures for the indexer, NFT media, price history, embedded chart,
  and hosted quote API.
- Keep the sole chart iframe sandboxed with a no-referrer policy.
- Keep normal token discovery on RPC and bundled or user-added contracts.
- Re-read indexer results on chain before displaying them.
- Preserve the vault encryption and session authorization checks.

RPC providers see the addresses queried. Endpoint rotation is not anonymity.
The wallet's saved history stays on the device. Blockchain history is public.
A disconnect cannot erase an address already shared with a site.

The bundled token list is generated and verified on chain. Edit `CURATED` in
`chains.ts`. Do not hand-edit generated `tokenlist.ts`. Preserve multicall
`batchSize: 16_384` to avoid unnecessary RPC fragmentation.

## Interface invariants

Use black backgrounds and `#FFE000` yellow. Use Courier for data and Times
for navigation. Keep square corners. Do not add gradients or light mode.

Sheets close through their header, Escape, or backdrop. Keep the primary
control visible while lists scroll. Give controls 44px targets and visible
keyboard focus. Give icon controls accessible names. Keep destructive actions
explicit. Red alone does not identify a destructive action.

Keep wallet management in the wallet drawer. Home lists assets across scanned
networks. The network selector filters the list and selects a signing network.
Send takes its network from the selected asset. Settings opens a section index.
Approval review starts with risks and asset changes before raw payload details.

## Verification

Run tests, the UI typecheck, the full build, Firefox lint, and the relevant
browser suites. Extension changes require Chrome and real Firefox coverage.
Keep mock, fork, emulator, physical-device, and funded-chain evidence distinct.
Never claim a check passed without reading its current output.

`docs/` and `design/app-shots/` are committed outputs. Never hand-edit Pages
artifacts. Rebuild after UI changes. Review screenshots for exposed secrets.
The E2E wrappers rebuild. Direct suite invocation requires fresh artifacts.

## Open limits

Independent security review remains required before store upload. Physical
Android and biometric acceptance remain open. Firefox for Android is untested.
Helios, WalletConnect, hardware wallets, iOS, and encrypted vault export are
not implemented. Automated APK publication is not prepared.
