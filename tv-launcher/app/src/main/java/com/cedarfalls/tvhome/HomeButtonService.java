package com.cedarfalls.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Google TV does not let you pick another home app, so the remote's Home button always opens
 * the TV's own launcher. When that launcher's screen appears, this brings TV Home back on top.
 */
public class HomeButtonService extends AccessibilityService {

    /** Same list as android:packageNames in res/xml/home_button_service.xml. */
    private static final Set<String> STOCK_LAUNCHERS = new HashSet<>(Arrays.asList(
            "com.google.android.apps.tv.launcherx", // Google TV
            "com.google.android.tvlauncher", // Android TV
            "com.google.android.leanbacklauncher", // older Android TV
            "com.amazon.tv.launcher")); // Fire TV

    /** The launcher sends several events per Home press; one is enough. */
    private static final long DEBOUNCE_MS = 400;

    private final Map<String, Boolean> isActivityCache = new HashMap<>();
    private long lastLaunch = -DEBOUNCE_MS;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            return;
        }
        CharSequence pkg = event.getPackageName();
        CharSequence cls = event.getClassName();
        if (pkg == null || cls == null || !STOCK_LAUNCHERS.contains(pkg.toString())
                || !Prefs.homeButtonEnabled(this) || !isActivity(pkg.toString(), cls.toString())) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastLaunch < DEBOUNCE_MS) {
            return;
        }
        lastLaunch = now;
        try {
            startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException e) {
            // Then the TV's own home screen simply stays.
        }
    }

    /** Full-screen launcher pages are activities; its pop-up panels and dialogs are not. */
    private boolean isActivity(String pkg, String cls) {
        String key = pkg + '/' + cls;
        Boolean cached = isActivityCache.get(key);
        if (cached == null) {
            try {
                getPackageManager().getActivityInfo(new ComponentName(pkg, cls), 0);
                cached = true;
            } catch (PackageManager.NameNotFoundException e) {
                cached = false;
            }
            isActivityCache.put(key, cached);
        }
        return cached;
    }

    @Override
    public void onInterrupt() {
    }
}
