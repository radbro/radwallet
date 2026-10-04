package xyz.radbro.radwallet;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FLAG_SECURE, on demand.
 *
 * A window with this flag set cannot be screenshotted, screen-recorded, or
 * shown in the recent-apps thumbnail — the compositor hands back black. That is
 * what a seed phrase and an exported private key need, because the ways a
 * secret leaves a phone are mostly not attacks: a screen recorder left running,
 * a screenshot that syncs to a photo library, a thumbnail in the app switcher.
 *
 * Deliberately NOT global. Blanket FLAG_SECURE would also stop someone
 * screenshotting a receive address to send to a friend, which is a normal thing
 * to do with a public address. The wallet turns it on for the two screens that
 * show a secret and off again when they close.
 */
@CapacitorPlugin(name = "ScreenGuard")
public class ScreenGuardPlugin extends Plugin {

    @PluginMethod
    public void setSecure(PluginCall call) {
        final boolean secure = Boolean.TRUE.equals(call.getBoolean("secure", true));
        // window flags are UI-thread only; the bridge calls in from its own
        getActivity().runOnUiThread(() -> {
            if (secure) {
                getActivity().getWindow().setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
                );
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            call.resolve();
        });
    }
}
