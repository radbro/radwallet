# RADWALLET engineering notes

These notes describe boundaries in the current wallet. Verify mutable chain
and third-party behavior before changing an integration.

## Wallet and session

- The vault uses AES-256-GCM with PBKDF2 at 600,000 iterations.
- Wallet labels and names belong inside the encrypted vault.
- Imported keys cannot be restored from a seed phrase.
- A screen must not derive keys or re-seal a vault.
- Secret reveal requires a fresh password check.
- Extension worker recovery uses an authenticated encrypted session envelope.
- Browser restart clears memory-only session storage.
- A recovered session can sign while vault mutation requires a fresh unlock.
- A locked session response must return the UI to unlock.
- Every page starts on the loading screen. Preact paints the first render
  before `boot` reads storage. A WELCOME first render tells a vault owner to
  create a wallet.
- A boot failure stays on the loading screen with its reason. Never fall
  through to WELCOME, which offers a new wallet over an existing vault.

## Browser behavior

- Use wallet extension APIs only through `src/ext.ts`.
- Callback-style APIs preserve Firefox compatibility.
- Start sidebar opening inside the initiating user gesture.
- Filter account events by the receiving content script's origin.
- Preserve numeric EIP-1193 error codes across message boundaries.
- JSON runtime messages cannot carry bigint values.
- Playwright's bundled Chromium loads the extension test target.
- A stale E2E server can hold the test port after a failed run.
- Size Firefox test pages with `setContentViewport`, never by outer window
  size. A sidebar takes window width without notice. An outer 390 px window
  once left a 179 px page beside a 280 px sidebar.
- Firefox will not size a browser window below 500 px. The suite opens the
  bookmarks sidebar as a spacer to fit a 372 px popup page. Do not rely on
  the wallet's own sidebar for that space.

## Chain reads and signing

- Probe the chain ID before accepting a new RPC endpoint.
- Token decimals must come from chain reads.
- Reject excess decimal precision before preview and encoding.
- Use integer values for quantities and accepted swap minimums.
- Bind asynchronous previews to the current request and asset metadata.
- Preserve `batchSize: 16_384` in token balance multicalls.
- An NFT scan failure must not appear as an empty ownership result.
- Hosted swap calldata is untrusted until decoded and checked.
- A successful receipt must confirm a positive transfer before tracking a
  newly purchased token.
- Gas is not deducted from route-output comparisons.
- A failed ETH/USD rate read keeps the last good rate. A superseded refresh
  still publishes a good rate, because the rate does not depend on the
  wallet. `readUsdRate` falls back to Base's ETH/USDC pool.
- Name a failed endpoint by host and status code only. A full RPC URL can
  carry an API key.
- A node failure inside the balance multicall must throw, so the pool moves
  on. Some nodes answer `eth_getBalance` and refuse `eth_call`. A token that
  reverts is the token answering: drop it, do not rotate.

## Privacy and evidence

Optional external services require consent and disclose their shared data.
RPC rotation does not make queries anonymous. On-device history does not hide
blockchain history. Automatic clipboard cleanup is best effort. Explicit
cleanup must report the browser's result.

Keep unit, fixture, local-fork, live-read, funded-transaction, emulator, and
physical-device evidence separate. Keep build output and source aligned.
Reproducible hashes prove package correspondence, not a security audit.

The source inventory checks tracked and unignored paths and SHA-256 hashes.
It catches added files and changed content without an inventory update.
The inventory file cannot hash itself. Review it directly. Review content
and generated screenshots before updating any inventory entry.
