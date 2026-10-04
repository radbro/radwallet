# RADWALLET

**FINALLY A RAD WALLET.**

A privacy-first EVM wallet from the [Radbro Webring](https://radbro.xyz/).
Your keys. Your RPC. Your business.

No telemetry. No wallet server. No added wallet swap fee.
Network gas and venue fees still apply.

> [!WARNING]
> **No independent security audit has been completed. Use RADWALLET at your own risk.**
>
> **Do not use RADWALLET to hold a significant amount of funds until an independent
> security audit has passed and its findings have been resolved.**
>
> This is a public source alpha. Defects can expose keys or cause permanent loss
> of funds. Use test wallets and small amounts while evaluating it.

Read [SECURITY.md](SECURITY.md) for reporting and security limits.
Browser-store submission requires the review in [STORE.md](STORE.md).

[Features](#features) · [Install](#install) · [Build from source](#build-from-source) ·
[Privacy](#privacy-and-signing) · [Limits](#current-limits) · [Development](#development)

## Features

### Wallets and assets

- Keep multiple seed phrases and imported keys in one encrypted vault.
- Save wallet names and labels inside the encrypted vault.
- View tokens, NFTs, portfolio balances, contacts, and local history.

### Transactions and dapps

- Send and receive with ENS names and QR codes.
- Speed up or cancel pending transactions through replacement.
- Connect dapps through the Chrome and Firefox provider.
- Review simulations before signing transactions.
- Bound unlimited token allowances by default.

### Networks and browser support

- Use Ethereum, Base, Arbitrum, Robinhood, testnets, and custom networks.
- Edit RPC pools or connect to a node on your computer.
- Use the Chrome side panel or Firefox sidebar.

### Public-beta features

| Feature | Scope |
|---|---|
| RADSWAP | Compares v3 routes, the house v4 route, and single-wallet Pons V2 curve swaps. KyberSwap quotes are optional. |
| Stealth addresses | ERC-5564 receiving with fresh addresses. Transactions and announcements remain public. |
| Tor routing | Desktop extensions can use a local SOCKS5 service for approved RPC hosts. |
| Optional data services | Indexers, NFT artwork, price history, and embedded charts require explicit consent. |
| PWA and Android | Web wallet and Android source. See the limits below. |

## Install

Get the Chrome or Firefox ZIP from the
[alpha release](https://github.com/radbro/radwallet/releases/tag/v0.10.0-alpha.1).
Compare its SHA-256 hash with the published `SHASUMS`. Extract the ZIP.

| Browser | Installation |
|---|---|
| Chrome | Open `chrome://extensions`. Enable **Developer mode**. Select **Load unpacked**. Select the extracted folder. |
| Firefox | Open `about:debugging#/runtime/this-firefox`. Select **Load Temporary Add-on**. Select the extracted `manifest.json`. |

Firefox installation is temporary. The release does not include a signed XPI.
Neither package is an approved browser-store release.

Select **DOCK** to keep the wallet beside a page.
Select **UNDOCK** to return to the popup.

## Build from source

Use Node 22. Clone this repository and open its directory.

```bash
npm ci
npm test
npx tsc -p apps/wallet/tsconfig.json
npm run build
npm run lint:firefox
npm run lint:source
npm run package
```

| Output | Purpose |
|---|---|
| `apps/wallet/dist/` | Wallet UI and installable PWA |
| `apps/wallet/dist-demo/` | Demo with fixture chain data |
| `apps/wallet/dist-bg/` | Extension background script |
| `apps/extension/dist/` | Unpacked Chrome extension |
| `apps/extension/dist-firefox/` | Unpacked Firefox extension |
| `docs/` and `docs/demo/` | Committed GitHub Pages artifacts |
| `release/` | Two deterministic extension ZIPs and `SHASUMS` |

Follow the browser instructions above with the matching extension output.
For the PWA, serve `apps/wallet/dist` and use the browser's install action.
The demo uses fixture chain data. The normal wallet uses live RPC data.

## Privacy and signing

The encrypted vault uses AES-256-GCM and PBKDF2 with 600,000 iterations.
Unlocked keys remain within the session boundary. Extension screens send
requests to the background session. PWA keys remain in page memory.
Revealing a seed phrase or imported key requires the password again.

The wallet saves its history on the device. Blockchain activity remains
public. RPC providers see the addresses and requests sent to them. Endpoint
assignment and rotation do not make those requests anonymous.

Optional services disclose the data they receive before use. Desktop Tor
routing needs a local SOCKS5 service. It routes approved RPC hosts through
that service. Stealth receiving uses fresh addresses. Transactions and
announcements remain public.

Transactions require a preview before signing. Unlimited ERC-20 allowances
are rewritten to a bounded amount by default. Users can inspect and change
the limit. A signer refuses a request for an address outside its authority.

## Current limits

- The independent security audit remains open.
- Android has emulator coverage. Physical-device and biometric acceptance remain open.
- Firefox for Android has not been tested.
- Helios, WalletConnect, hardware wallets, iOS, and encrypted vault export are not implemented.
- No signed Firefox XPI or automated APK release is provided.

## Development

Use `npm run dev` for local UI work. Read [CLAUDE.md](CLAUDE.md) for architecture
and invariants. Read [design/WALLET_DESIGN.md](design/WALLET_DESIGN.md) for
interface guidance.

`source-files.json` lists the reviewed public files and their SHA-256 hashes.
`npm run lint:source` checks paths and content against that inventory. Review
changes before updating it. The inventory file itself requires review because
it cannot contain its own hash.

### Distribution

`npm run package` creates the Chrome ZIP, Firefox ZIP, and `SHASUMS`.
The CI workflow rebuilds the packages and compares their hashes.
Reproducible hashes establish package correspondence. They do not establish safety.

GitHub Pages can host the PWA and demo. The Android shell is available as
source with manual build instructions. Browser-store submission requires the
independent security review described in [STORE.md](STORE.md).

### Repository map

| Path | Contents |
|---|---|
| `packages/core` | Pure wallet engine |
| `apps/wallet` | Preact UI, sessions, PWA, and demo |
| `apps/extension` | MV3 manifests and provider scripts |
| `apps/mobile` | Capacitor Android shell |
| `design` | Product guidance, mockup, and screenshots |
| `research` | Integration notes and visual research |

## License

Code uses GPL-3.0. Radbro assets use CC0. Third-party reference material has
separate boundaries. Read [ASSET-LICENSES.md](ASSET-LICENSES.md).
