# RADWALLET

RADWALLET is a privacy-first EVM wallet. It uses the visual style of the
[Radbro Webring](https://radbro.xyz/). It has no telemetry, wallet server,
or added wallet swap fee. Network gas and venue fees still apply.

This is a public source alpha. An independent security audit has not been
completed. Source publication does not approve a store release. Read
[SECURITY.md](SECURITY.md) and [STORE.md](STORE.md).

## Features

- Keep multiple seed phrases and imported keys in one encrypted vault.
- Name wallets and apply labels inside the encrypted vault.
- Send and receive with ENS names and QR codes.
- Check tokens, NFTs, portfolio balances, contacts, and local history.
- Replace pending transactions to speed them up or cancel them.
- Use Ethereum, Base, Arbitrum, Robinhood, testnets, and custom networks.
- Edit RPC pools or connect to a node on your computer.
- Connect dapps through the Chrome and Firefox provider.
- Review transaction simulations and bounded token allowances before signing.
- Use the Chrome side panel or Firefox sidebar.

Public-beta features include RADSWAP, ERC-5564 stealth addresses, desktop
extension Tor routing, the PWA, and the Android shell. RADSWAP compares v3
routes, the house v4 route, and ordinary single-wallet Pons V2 curve swaps.
KyberSwap quotes are optional. Indexers, NFT artwork, price history, and
embedded charts require explicit consent.

Android has emulator coverage. Physical-device and biometric acceptance
remain open. No automated APK release is provided.

Helios, WalletConnect, hardware wallets, iOS, and encrypted vault export are
not implemented. Firefox for Android has not been tested.

## Build and install

Use Node 22.

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

In Chrome, open `chrome://extensions`. Enable Developer mode. Select
**Load unpacked**. Select `apps/extension/dist`.

In Firefox, open `about:debugging#/runtime/this-firefox`. Select
**Load Temporary Add-on**. Select
`apps/extension/dist-firefox/manifest.json`. This installation is temporary.
A signed Firefox XPI is not part of this source release.

Select **DOCK** to keep the wallet open beside a page. Select **UNDOCK** to
return to the popup. Both browsers use the same wallet logic. The build derives
the Firefox manifest from the Chrome manifest.

Use `npm run dev` for local UI work. The demo uses fixture data. The normal
wallet build uses live RPC data. To test the PWA, serve `apps/wallet/dist`
and use the browser's install action.

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

## Distribution

The source release includes Chrome and Firefox ZIPs with SHA-256 hashes.
`npm run package` creates `radwallet-<version>.zip`,
`radwallet-<version>-firefox.zip`, and `SHASUMS`. CI rebuilds the packages and
compares their hashes.

`source-files.json` lists the reviewed public files and their SHA-256 hashes.
`npm run lint:source` checks paths and content against that inventory. Review
changes before updating it. The inventory file itself requires review because
it cannot contain its own hash. Security review remains required.

GitHub Pages can host the PWA and demo. The Android shell is available as
source with manual build instructions. Browser-store submission requires the
independent security review described in [STORE.md](STORE.md).

## Repository map

| Path | Contents |
|---|---|
| `packages/core` | Pure wallet engine |
| `apps/wallet` | Preact UI, sessions, PWA, and demo |
| `apps/extension` | MV3 manifests and provider scripts |
| `apps/mobile` | Capacitor Android shell |
| `design` | Product guidance, mockup, and screenshots |
| `research` | Integration notes and visual research |

Read [CLAUDE.md](CLAUDE.md) for architecture and invariants. Read
[design/WALLET_DESIGN.md](design/WALLET_DESIGN.md) for interface guidance.

## License

Code uses GPL-3.0. Radbro assets use CC0. Third-party reference material has
separate boundaries. Read [ASSET-LICENSES.md](ASSET-LICENSES.md).
