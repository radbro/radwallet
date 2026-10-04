# Release notes

## v0.10.0 — public source alpha

The independent third-party security audit remains open. This release provides
source for review. Browser-store submission remains gated by [STORE.md](STORE.md).

## Wallet features

The vault supports multiple seed phrases and imported keys. Wallet names and
labels remain encrypted. Secret reveal requires the password for each operation.

Users can send and receive with ENS and QR codes. The wallet shows tokens,
NFTs, portfolio balances, contacts, and local history. Pending transactions can
be replaced. Confirmation alerts remain available across worker restarts.

Supported networks include Ethereum, Base, Arbitrum, Robinhood, testnets, and
custom networks. Each network has an editable RPC pool. Loopback nodes are
supported. Testnet balances remain outside priced totals.

Chrome and Firefox provide dapp connections, chain switching, EIP-1193 and
EIP-6963 discovery, and EIP-712 signing. Transactions use simulation and preview
checks. Unlimited allowances are bounded by default. Both browsers support a
docked wallet view.

## Public-beta features

RADSWAP compares v3 paths, the supported house v4 route, and ordinary
single-wallet Pons V2 curve swaps. Hosted KyberSwap quotes require consent.
The wallet adds no swap fee. Gas and venue fees still apply.

ERC-5564 stealth addresses, desktop extension Tor routing, optional indexers,
NFT artwork, price history, embedded charts, the PWA, and the Android shell
remain public-beta features. Each optional service has a data disclosure.

Android has emulator coverage. Physical-device and biometric acceptance remain
open. Firefox for Android is untested. No automated APK release is provided.

## Packages

The release packages are `radwallet-0.10.0.zip` for Chrome and
`radwallet-0.10.0-firefox.zip` for Firefox. Publish both with `SHASUMS` as a
prerelease. Source builds support Chrome unpacked installation and Firefox
temporary installation. A signed Firefox XPI is not prepared.

The committed Pages output contains the PWA and demo. The demo uses fixture
data. The normal PWA uses live RPC data. Pages hosting needs repository setup.

## Limits

Helios, WalletConnect, hardware wallets, iOS, and encrypted vault export are
not implemented. Source publication, local test results, hosted CI, funded
transactions, and store approval are separate forms of evidence.
