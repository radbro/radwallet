package xyz.radbro.radwallet;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Unlock with a fingerprint, without weakening the vault.
 *
 * The wallet hands this plugin its unlock password once, at enable time. The
 * password is encrypted with an AES key that lives in the Android Keystore —
 * hardware-backed where the device has it — and that key is created with
 * setUserAuthenticationRequired(true), so the OS will not perform a single
 * operation with it until a biometric has been presented. The ciphertext goes
 * back to the wallet to store next to the vault; this plugin keeps nothing.
 *
 * WHAT THIS TRADES. Biometric unlock is a second credential on the same wallet,
 * so the wallet becomes as strong as the weakest face or finger enrolled on the
 * device. That is the deal every mobile wallet makes and the UI has to say so;
 * it is off until asked for.
 *
 * setInvalidatedByBiometricEnrollment(true) means enrolling a new fingerprint
 * destroys the key, and the ciphertext with it. Someone who can add a finger to
 * your phone cannot add a way into your wallet — they get a wallet that asks
 * for the password, which is the correct outcome and needs saying in the copy.
 */
@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {

    private static final String ALIAS = "radwallet.unlock.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    /** Can this device do it, and if not, why not — in words the UI can show. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject out = new JSObject();
        int status = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        out.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        out.put("reason", reasonFor(status));
        call.resolve(out);
    }

    private String reasonFor(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "no fingerprint or face is set up on this phone yet";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "this phone has no fingerprint or face reader";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "the reader is busy — try again in a moment";
            case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return "android needs a security update before it will do this";
            default:
                return "this phone will not do biometric unlock";
        }
    }

    /**
     * Seal the wallet password behind a fresh biometric-gated key.
     *
     * A new key every time: enabling twice must not leave an older ciphertext
     * that a stale key can still open.
     */
    @PluginMethod
    public void enable(PluginCall call) {
        final String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) {
            call.reject("nothing to seal");
            return;
        }
        try {
            deleteKey();
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build());
            SecretKey key = gen.generateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            prompt(call, cipher, "Turn on unlock with biometrics", (result) -> {
                try {
                    Cipher c = result.getCryptoObject().getCipher();
                    byte[] ct = c.doFinal(secret.getBytes("UTF-8"));
                    JSObject out = new JSObject();
                    out.put("sealed", Base64.encodeToString(ct, Base64.NO_WRAP));
                    out.put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP));
                    call.resolve(out);
                } catch (Exception e) {
                    call.reject("could not seal: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject("could not create a biometric key: " + e.getMessage());
        }
    }

    /** Ask for a finger, and hand back the password if it is the right one. */
    @PluginMethod
    public void unlock(PluginCall call) {
        final String sealed = call.getString("sealed");
        final String iv = call.getString("iv");
        if (sealed == null || iv == null) {
            call.reject("nothing sealed to open");
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(ALIAS, null);
            if (key == null) {
                // the key is gone: a new fingerprint was enrolled, or the app's
                // data was cleared. Say which, because "it failed" would send
                // someone looking for a wallet that is fine.
                call.reject("BIOMETRIC_KEY_GONE");
                return;
            }
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key,
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            prompt(call, cipher, "Unlock RADWALLET", (result) -> {
                try {
                    byte[] pt = result.getCryptoObject().getCipher()
                        .doFinal(Base64.decode(sealed, Base64.NO_WRAP));
                    JSObject out = new JSObject();
                    out.put("secret", new String(pt, "UTF-8"));
                    call.resolve(out);
                } catch (Exception e) {
                    call.reject("could not open: " + e.getMessage());
                }
            });
        } catch (android.security.keystore.KeyPermanentlyInvalidatedException e) {
            call.reject("BIOMETRIC_KEY_GONE");
        } catch (Exception e) {
            call.reject("could not open: " + e.getMessage());
        }
    }

    /** Forget the key. The ciphertext left behind is then unopenable by anyone. */
    @PluginMethod
    public void disable(PluginCall call) {
        try {
            deleteKey();
            call.resolve();
        } catch (Exception e) {
            call.reject("could not remove the biometric key: " + e.getMessage());
        }
    }

    private void deleteKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
    }

    private interface OnAuth {
        void run(BiometricPrompt.AuthenticationResult result);
    }

    private void prompt(PluginCall call, Cipher cipher, String title, OnAuth onAuth) {
        final FragmentActivity activity = (FragmentActivity) getActivity();
        Executor executor = androidx.core.content.ContextCompat.getMainExecutor(getContext());
        activity.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(activity, executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        onAuth.run(result);
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                        // a cancel is a decision, not a fault — the wallet says
                        // nothing and leaves the password field where it was
                        if (code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                            || code == BiometricPrompt.ERROR_CANCELED) {
                            call.reject("BIOMETRIC_CANCELLED");
                        } else {
                            call.reject(String.valueOf(message));
                        }
                    }
                });
            bp.authenticate(
                new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle("your keys never leave this phone")
                    .setNegativeButtonText("use password")
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .setConfirmationRequired(false)
                    .build(),
                new BiometricPrompt.CryptoObject(cipher));
        });
    }
}
