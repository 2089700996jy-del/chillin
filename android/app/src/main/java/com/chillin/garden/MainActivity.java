package com.chillin.garden;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int IOS_BG = Color.parseColor("#F2F2F7");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(IOS_BG);
        window.setNavigationBarColor(IOS_BG);
        WindowCompat.setDecorFitsSystemWindows(window, true);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        }
    }
}
