# Distribution and store checklist

This repository prepares a public source alpha. It provides two extension
packages, a PWA, a demo, and Android source. A source release does not approve
store submission.

## Source release

1. Enable GitHub private vulnerability reporting.
2. Use the pinned Node 22 build environment.
3. Run `npm ci` and `npm test`.
4. Run `npx tsc -p apps/wallet/tsconfig.json`.
5. Run `npm run build` and `npm run lint:firefox`.
6. Run the PWA, Chrome extension, and real Firefox suites.
7. Run `npm run package`.
8. Rebuild and package again.
9. Compare both sets of hashes.
10. Publish the two ZIPs and `SHASUMS` with a prerelease tag.

The packages are `radwallet-<version>.zip` for Chrome and
`radwallet-<version>-firefox.zip` for Firefox. Chrome supports **Load unpacked**.
Firefox supports **Load Temporary Add-on**. Temporary Firefox installation
does not provide a signed XPI or persistent store installation.

GitHub Pages can host the committed `docs/` PWA and demo. Hosting requires a
separate repository setting. Android is distributed as source with manual
build instructions. Automated APK publication is not prepared.

## Store gate

Complete an independent security review before either store upload. The review
must cover the vault, session keyring, approval flows, and stealth module.
Record the reviewed source commit and resolved findings.

Keep `version` in the root `package.json` and
`apps/extension/static/manifest.json` aligned. The build derives the Firefox
manifest. Tag the exact reviewed commit.

Chrome requires these permission explanations:

| Permission | Purpose |
|---|---|
| `storage` | Encrypted vault and local settings |
| `alarms` | Auto-lock and transaction confirmation checks |
| `notifications` | Confirmed or failed transaction alerts |
| `proxy` | User-selected Tor routing |
| `sidePanel` | Docked wallet interface |

Firefox uses the corresponding permissions without `sidePanel`. Its manifest
uses add-on ID `radwallet@radbro.xyz` and declares no data collection.
Desktop Firefox has a 140 minimum. Firefox for Android has not been tested.

List every optional integration and its shared data. Indexers use Blockscout,
Alchemy, or Moralis. Alchemy and Moralis require the user's key. NFT media,
price history, and GeckoTerminal charts have separate disclosures.
KyberSwap receives the pair, amount, wallet address, and IP when enabled.
The wallet requests no platform or referral fee.

Store copy must state no telemetry, no wallet server, and 0% added wallet swap
fee. State that gas and venue fees still apply. Link the GPL-3.0 source and
published reproducible-build hashes. Validate the actual upload package with
the current store tools before submission.
