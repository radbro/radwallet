# Wallet interface verification

Check the built interface at popup and docked sizes. Use disposable accounts.
Mask secrets in screenshots. Do not use fixture balances as funded-chain proof.

## Checks

- Keep the titlebar and navigation visible at 372×600.
- Check the docked view at 520×900.
- Check large text and keyboard focus.
- Keep every interactive control accessible by name.
- Keep primary sheet actions visible while the list scrolls.
- Keep REFUSE and SIGN controls equal in size.
- Show exact asset quantities and the request's signing network.
- Invalidate delayed previews after input or network changes.
- Preserve encrypted wallet names and labels across reloads.
- Verify clipboard errors and explicit secret cleanup.
- Keep settings sections and privacy disclosures reachable.
- Check NFT pagination and manual ownership checks.

## Verification commands

Run unit tests, the UI typecheck, the build, Firefox lint, and the relevant
PWA, Chrome, and real Firefox suites. Run direct E2E scripts only after a
fresh build. Record actual viewport sizes and inspect generated screenshots.

The demo uses fixture data. Browser suites can intercept network and signing
requests. Those checks do not prove funded transaction settlement.
