package com.cedarfalls.tvhome;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.robolectric.Shadows.shadowOf;

import android.content.ComponentName;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowSystemClock;

import java.time.Duration;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class HomeButtonServiceTest {

    private static final String GOOGLE_TV = "com.google.android.apps.tv.launcherx";

    private HomeButtonService service;
    private ShadowApplication app;
    private ComponentName googleTvHome;

    @Before
    public void setUp() {
        googleTvHome = FakeApps.install(GOOGLE_TV, "Google TV Home", Intent.CATEGORY_HOME, true);
        FakeApps.install("com.netflix.ninja", "Netflix", Intent.CATEGORY_LEANBACK_LAUNCHER, false);
        service = Robolectric.setupService(HomeButtonService.class);
        app = shadowOf(RuntimeEnvironment.getApplication());
    }

    private void windowChanged(String pkg, String cls) {
        AccessibilityEvent event = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED);
        event.setPackageName(pkg);
        event.setClassName(cls);
        service.onAccessibilityEvent(event);
    }

    @Test
    public void bringsTvHomeBackWhenTheStockHomeScreenOpens() {
        windowChanged(GOOGLE_TV, googleTvHome.getClassName());
        Intent started = app.getNextStartedActivity();
        assertEquals(new ComponentName(RuntimeEnvironment.getApplication(), HomeActivity.class), started.getComponent());
        assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK, started.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    @Test
    public void leavesOtherAppsAlone() {
        windowChanged("com.netflix.ninja", "com.netflix.ninja.MainActivity");
        assertNull(app.getNextStartedActivity());
    }

    @Test
    public void leavesTheStockLaunchersPopUpsAlone() {
        windowChanged(GOOGLE_TV, "android.widget.FrameLayout");
        assertNull(app.getNextStartedActivity());
    }

    @Test
    public void doesNothingWhenTurnedOff() {
        Prefs.setHomeButtonEnabled(RuntimeEnvironment.getApplication(), false);
        windowChanged(GOOGLE_TV, googleTvHome.getClassName());
        assertNull(app.getNextStartedActivity());
    }

    @Test
    public void opensTvHomeOncePerHomePress() {
        windowChanged(GOOGLE_TV, googleTvHome.getClassName());
        windowChanged(GOOGLE_TV, googleTvHome.getClassName());
        app.getNextStartedActivity();
        assertNull(app.getNextStartedActivity());

        ShadowSystemClock.advanceBy(Duration.ofSeconds(1));
        windowChanged(GOOGLE_TV, googleTvHome.getClassName());
        assertEquals(HomeActivity.class.getName(), app.getNextStartedActivity().getComponent().getClassName());
    }
}
