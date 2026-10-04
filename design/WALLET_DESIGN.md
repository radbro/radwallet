# RADWALLET design guidance

The wallet uses the Radbro Webring visual style. The current product features
are listed in [README.md](../README.md). Architecture is in
[CLAUDE.md](../CLAUDE.md). Visual source material is in
[research/RADBRO_RESEARCH.md](../research/RADBRO_RESEARCH.md).

## Visual style

Use black backgrounds and `#FFE000` yellow. Use Courier New for data. Use
Times New Roman bold for navigation. Use system fonts. Keep square corners.
Do not add gradients, rounded corners, or light mode.

Preserve the starfield, rectangular controls, LCD block indicator, and webring
navigation motifs. The static mockup is visual research. It is not a current
feature list or security specification.

## Screen roles

| Surface | Purpose |
|---|---|
| Onboarding and unlock | Create, import, back up, and unlock the vault |
| Home | Wallet identity, aggregate value, asset list, and payment actions |
| Wallet drawer | Select and manage seed groups or imported keys |
| NFTs | Read collections and verify known token ownership |
| Swap | Select a route and review input, minimum output, fees, and gas |
| Activity | Show the local saved transaction list and confirmation status |
| Settings | Open security, network, privacy, site, display, or about sections |
| Dapp approval | Review request risk, asset changes, signer, and raw payload |

Home groups assets across scanned networks. Show the network on every asset
row. The network selector filters the list and changes the signing network.
Send uses the chosen asset's network. Testnet funds remain outside priced totals.

## Interaction rules

1. Keep REFUSE and SIGN equally visible.
2. Show transaction outcomes before raw request details.
3. Show exact quantities with verified token decimals.
4. Keep all privacy-service disclosures beside their controls.
5. Give every control a 44px target and visible keyboard focus.
6. Give icon controls an accessible name.
7. Keep sheets solid black.
8. Close sheets through their header, Escape, or backdrop.
9. Keep the main sheet action visible while its list scrolls.
10. Put destructive confirmation in an explicit bordered area.

Keep copy short and literal for security decisions. Explain errors where they
occur. Do not promise anonymous RPC use, invisible transfers, complete asset
discovery, or automatic clipboard cleanup. State that the wallet fee is zero.
State that venue fees and gas remain.

## Verification

Check popup and docked layouts in Chrome and Firefox. Check keyboard navigation
and large text. Inspect screenshots for clipping and secrets. Demo screenshots
use fixture data. They do not prove live balances or transaction settlement.
