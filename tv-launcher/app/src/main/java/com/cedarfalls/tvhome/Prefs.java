package com.cedarfalls.tvhome;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** What the user chose: favourites (in order), hidden apps, background, Home button takeover. */
final class Prefs {
    private static final String FILE = "tvhome";
    private static final String KEY_FAVOURITES = "favourites";
    private static final String KEY_HIDDEN = "hidden";
    private static final String KEY_BACKGROUND = "background";
    private static final String KEY_HOME_BUTTON = "home_button";

    private Prefs() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** Package names, in the order they are shown. */
    static List<String> favourites(Context context) {
        String stored = prefs(context).getString(KEY_FAVOURITES, "");
        List<String> list = new ArrayList<>();
        if (!stored.isEmpty()) {
            Collections.addAll(list, stored.split("\n"));
        }
        return list;
    }

    static void setFavourites(Context context, List<String> packages) {
        prefs(context).edit().putString(KEY_FAVOURITES, TextUtils.join("\n", packages)).apply();
    }

    static Set<String> hidden(Context context) {
        return new HashSet<>(prefs(context).getStringSet(KEY_HIDDEN, Collections.<String>emptySet()));
    }

    static void setHidden(Context context, Set<String> packages) {
        prefs(context).edit().putStringSet(KEY_HIDDEN, new HashSet<>(packages)).apply();
    }

    static int background(Context context) {
        return prefs(context).getInt(KEY_BACKGROUND, 0);
    }

    static void setBackground(Context context, int index) {
        prefs(context).edit().putInt(KEY_BACKGROUND, index).apply();
    }

    /** Whether the Home button service should bring TV Home back. On by default once the service is allowed. */
    static boolean homeButtonEnabled(Context context) {
        return prefs(context).getBoolean(KEY_HOME_BUTTON, true);
    }

    static void setHomeButtonEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_HOME_BUTTON, enabled).apply();
    }
}
