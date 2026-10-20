package com.cedarfalls.tvhome;

import static org.robolectric.Shadows.shadowOf;

import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Looper;

import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowPackageManager;

import java.lang.reflect.Field;
import java.util.concurrent.ExecutorService;

/** Installs pretend apps and controls the AppStore's background thread. */
final class FakeApps {
    private FakeApps() {
    }

    static ComponentName install(String pkg, String label, String category, boolean system) {
        ComponentName component = new ComponentName(pkg, pkg + ".MainActivity");
        ShadowPackageManager pm = shadowOf(RuntimeEnvironment.getApplication().getPackageManager());

        ApplicationInfo app = new ApplicationInfo();
        app.packageName = pkg;
        app.nonLocalizedLabel = label;
        app.sourceDir = "/data/app/" + pkg + "/base.apk";
        app.flags = system ? ApplicationInfo.FLAG_SYSTEM : 0;

        ActivityInfo activity = new ActivityInfo();
        activity.packageName = pkg;
        activity.name = component.getClassName();
        activity.applicationInfo = app;
        activity.nonLocalizedLabel = label;
        activity.exported = true;

        PackageInfo info = new PackageInfo();
        info.packageName = pkg;
        info.applicationInfo = app;
        pm.installPackage(info);
        pm.addOrUpdateActivity(activity);

        IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN);
        filter.addCategory(category);
        pm.addIntentFilterForActivity(component, filter);
        return component;
    }

    /** Gives an installed app's activity one more launcher category. */
    static void addCategory(ComponentName component, String category) {
        IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN);
        filter.addCategory(category);
        shadowOf(RuntimeEnvironment.getApplication().getPackageManager()).addIntentFilterForActivity(component, filter);
    }

    /** AppStore is a process-wide singleton; each test gets a fresh one. */
    static void resetStore() throws Exception {
        Field instance = AppStore.class.getDeclaredField("instance");
        instance.setAccessible(true);
        instance.set(null, null);
    }

    /** Waits for the background app scan, then runs what it posted to the main thread. */
    static void finishLoading() throws Exception {
        Field worker = AppStore.class.getDeclaredField("worker");
        worker.setAccessible(true);
        ExecutorService executor = (ExecutorService) worker.get(AppStore.get(RuntimeEnvironment.getApplication()));
        executor.submit(new Runnable() {
            @Override
            public void run() {
            }
        }).get();
        shadowOf(Looper.getMainLooper()).idle();
    }
}
