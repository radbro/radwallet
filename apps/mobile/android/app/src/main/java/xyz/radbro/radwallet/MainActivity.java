package xyz.radbro.radwallet;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registered before super.onCreate so the bridge sees it on first load —
        // the seed screen can appear seconds into a first run
        registerPlugin(ScreenGuardPlugin.class);
        registerPlugin(BiometricPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
