import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android shell around the wallet.
 *
 * `webDir` is the `--mode android` vite build, NOT `dist/`: that mode drops the
 * service worker, which is pointless in front of files the WebView already
 * reads off local disk and is one more place a stale app can come from.
 *
 * No `server.url`. Pointing the shell at a hosted copy would mean the wallet's
 * code arrives over the network at every launch — the one property an installed
 * app has over a web page is that it does not.
 */
const config: CapacitorConfig = {
  appId: 'xyz.radbro.radwallet',
  appName: 'RADWALLET',
  webDir: '../wallet/dist-mobile',
  android: {
    // the wallet is black; a white flash on every cold start is not the skin
    backgroundColor: '#000000',
  },
};

export default config;
