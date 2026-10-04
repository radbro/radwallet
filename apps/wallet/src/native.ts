/**
 * The native shell, and the two things the wallet asks of it.
 *
 * This is to Capacitor what ext.ts is to the browser extension APIs: the only
 * file that talks to the platform, so a screen never has to know which of the
 * five builds it is running in. Everything here is a no-op off Android, which
 * is what lets the same components render in the popup, the PWA and the app.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

/** true only inside the Capacitor shell — false in the extension and the PWA */
export const IS_NATIVE = (() => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
})();

interface ScreenGuardPlugin {
  setSecure(options: { secure: boolean }): Promise<void>;
}
const ScreenGuard = registerPlugin<ScreenGuardPlugin>('ScreenGuard');

/**
 * Stop the OS capturing this screen (FLAG_SECURE) while a secret is on it.
 *
 * Scoped to the seed phrase and the export sheets rather than the whole app:
 * screenshotting a receive address is a normal thing to do with a public
 * address, and a wallet that refuses is just broken.
 */
export async function guardScreen(secure: boolean): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await ScreenGuard.setSecure({ secure });
  } catch {
    // an older shell without the plugin must not take the seed screen down
  }
}

/**
 * Run `onBackground` when the app leaves the foreground.
 *
 * Mobile has no background worker to hold keys, and Android kills a
 * backgrounded app whenever it feels like it — so the honest thing is to drop
 * the keys ourselves on the way out, rather than let it depend on whether the
 * OS got round to killing us. Returns a function that stops listening.
 */
export function onBackground(handler: () => void): () => void {
  if (!IS_NATIVE) return () => {};
  const pending = App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) handler();
  });
  return () => { void pending.then((h) => h.remove()); };
}


// ------------------------------------------------------------- biometrics --
export interface SealedSecret { sealed: string; iv: string }

interface BiometricPlugin {
  available(): Promise<{ available: boolean; reason: string }>;
  enable(options: { secret: string }): Promise<SealedSecret>;
  unlock(options: SealedSecret): Promise<{ secret: string }>;
  disable(): Promise<void>;
}
const Biometric = registerPlugin<BiometricPlugin>('Biometric');

/** what this phone will do, and in words the UI can put on screen if it won't */
export async function biometricAvailable(): Promise<{ available: boolean; reason: string }> {
  if (!IS_NATIVE) return { available: false, reason: 'only in the android app' };
  try {
    return await Biometric.available();
  } catch {
    return { available: false, reason: 'this build has no biometric support' };
  }
}

/**
 * Hand the wallet password to the Keystore, sealed behind a finger.
 *
 * The password rather than a separate key on purpose. A second vault copy under
 * its own secret sounds stronger and is not: the moment a wallet is renamed or
 * a key imported, the copy the password opens and the copy the finger opens
 * disagree, and the one you reach for later is a wallet missing whatever you
 * did last. One vault, one truth, and the finger is a second way to the same
 * door. What it costs is stated in the UI: the wallet becomes as strong as the
 * weakest face or finger enrolled on the phone.
 */
export function biometricEnable(password: string): Promise<SealedSecret> {
  return Biometric.enable({ secret: password });
}

export async function biometricUnlock(sealed: SealedSecret): Promise<string> {
  return (await Biometric.unlock(sealed)).secret;
}

export function biometricDisable(): Promise<void> {
  return Biometric.disable().catch(() => {});
}
