package com.cedarfalls.tvhome;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;

import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Finds the installed apps on a background thread and keeps them in memory, so the home
 * screen shows instantly. Banners and icons are only loaded again for apps that changed.
 */
final class AppStore {

    interface Listener {
        void onAppsChanged();
    }

    static final class App {
        final String packageName;
        final String label;
        final ComponentName component;
        final boolean tv;
        final boolean system;
        final Drawable banner;
        final Drawable icon;
        final String sourceDir;

        App(String packageName, String label, ComponentName component, boolean tv, boolean system,
                Drawable banner, Drawable icon, String sourceDir) {
            this.packageName = packageName;
            this.label = label;
            this.component = component;
            this.tv = tv;
            this.system = system;
            this.banner = banner;
            this.icon = icon;
            this.sourceDir = sourceDir;
        }

        Intent launchIntent() {
            return new Intent(Intent.ACTION_MAIN)
                    .addCategory(tv ? Intent.CATEGORY_LEANBACK_LAUNCHER : Intent.CATEGORY_LAUNCHER)
                    .setComponent(component)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        }
    }

    private static AppStore instance;

    static synchronized AppStore get(Context context) {
        if (instance == null) {
            instance = new AppStore(context.getApplicationContext());
        }
        return instance;
    }

    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Sorted by label; null until the first load finishes. */
    private volatile List<App> apps;
    /** Worker thread only. */
    private String signature = "";
    /** Main thread only. */
    private Listener listener;

    private AppStore(Context context) {
        this.context = context;
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    List<App> apps() {
        return apps;
    }

    /** Looks for installed, removed or updated apps; tells the listener only if something changed. */
    void refresh() {
        worker.execute(new Runnable() {
            @Override
            public void run() {
                if (load()) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (listener != null) {
                                listener.onAppsChanged();
                            }
                        }
                    });
                }
            }
        });
    }

    private boolean load() {
        PackageManager pm = context.getPackageManager();
        Map<String, ResolveInfo> found = new LinkedHashMap<>();
        Set<String> tvPackages = new HashSet<>();
        collect(pm, Intent.CATEGORY_LEANBACK_LAUNCHER, found);
        tvPackages.addAll(found.keySet());
        collect(pm, Intent.CATEGORY_LAUNCHER, found);

        // An app update moves its APK to a new folder, so sourceDir changes too.
        StringBuilder sig = new StringBuilder();
        for (ResolveInfo ri : found.values()) {
            sig.append(ri.activityInfo.packageName).append('/').append(ri.activityInfo.name)
                    .append('@').append(ri.activityInfo.applicationInfo.sourceDir).append('\n');
        }
        String newSignature = sig.toString();
        if (apps != null && newSignature.equals(signature)) {
            return false;
        }

        Map<String, App> previous = new HashMap<>();
        if (apps != null) {
            for (App app : apps) {
                previous.put(app.packageName, app);
            }
        }
        List<App> list = new ArrayList<>(found.size());
        for (ResolveInfo ri : found.values()) {
            ActivityInfo info = ri.activityInfo;
            ComponentName component = new ComponentName(info.packageName, info.name);
            String sourceDir = String.valueOf(info.applicationInfo.sourceDir);
            boolean tv = tvPackages.contains(info.packageName);
            App old = previous.get(info.packageName);
            if (old != null && old.component.equals(component) && old.sourceDir.equals(sourceDir) && old.tv == tv) {
                list.add(old);
            } else {
                list.add(build(pm, ri, component, tv, sourceDir));
            }
        }

        final Collator collator = Collator.getInstance();
        collator.setStrength(Collator.PRIMARY);
        Collections.sort(list, new Comparator<App>() {
            @Override
            public int compare(App a, App b) {
                return collator.compare(a.label, b.label);
            }
        });
        apps = Collections.unmodifiableList(list);
        signature = newSignature;
        return true;
    }

    private void collect(PackageManager pm, String category, Map<String, ResolveInfo> into) {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(category);
        for (ResolveInfo ri : pm.queryIntentActivities(intent, 0)) {
            String pkg = ri.activityInfo.packageName;
            if (!pkg.equals(context.getPackageName()) && !into.containsKey(pkg)) {
                into.put(pkg, ri);
            }
        }
    }

    private static App build(PackageManager pm, ResolveInfo ri, ComponentName component, boolean tv,
            String sourceDir) {
        ActivityInfo info = ri.activityInfo;
        String label = String.valueOf(ri.loadLabel(pm)).trim();
        if (label.isEmpty()) {
            label = info.packageName;
        }
        Drawable banner = null;
        Drawable icon = null;
        try {
            banner = info.loadBanner(pm);
            icon = ri.loadIcon(pm);
        } catch (RuntimeException e) {
            // A broken app resource only costs that tile its picture.
        }
        boolean system = (info.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
        return new App(info.packageName, label, component, tv, system, banner, icon, sourceDir);
    }
}
