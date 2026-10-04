# Android shell

The Capacitor shell in `apps/mobile` uses the shared wallet UI. It is public
source with manual build instructions. No automated APK release is provided.
The browser-store audit gate also applies before a mobile release.

## Storage and locking

The vault stays encrypted. Android persistence uses app-private storage through
the platform adapter. Disable Android backup for wallet data. Do not place a
seed phrase or private key in plaintext storage.

The native shell uses `FLAG_SECURE` to restrict captures. It locks when the app
moves to the background. A biometric unlock path uses Android Keystore.
Physical-device and biometric acceptance remain open. Keep password unlock
available. Never describe emulator coverage as physical-device proof.

The PWA uses browser-origin storage. Clearing site data can remove that vault.
Users must retain seed phrase and imported-key backups. An imported key cannot
be restored from a seed phrase.

## Build and test

Use the Android SDK and the repository's documented Capacitor toolchain.

```bash
npm ci
npm run build:android
npm run lint:android
npm run e2e:android
```

The emulator suite needs an available Android emulator. Manual APK signing and
physical-device acceptance require separate evidence. Do not publish signing
keys or use production wallet secrets in test fixtures.

## Release checks

- Complete the independent wallet security review.
- Verify password and biometric unlock on supported physical devices.
- Verify app background locking and process recovery.
- Verify backup exclusion and secure-window behavior.
- Record the source commit and package hash.
- Prepare signing, store listing, and update procedures.

Mobile dapp connections through WalletConnect are not implemented. iOS is not
implemented. Desktop extension Tor routing does not imply Android support.
