package com.cedarfalls.tvhome;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The home screen: clock, Favourites row(s) and every other app the user has not hidden. */
public class HomeActivity extends Activity implements AppStore.Listener {

    static final int[] BACKGROUNDS = {
            R.drawable.bg_midnight, R.drawable.bg_charcoal, R.drawable.bg_purple,
            R.drawable.bg_forest, R.drawable.bg_sunset,
    };
    private static final int[] BACKGROUND_NAMES = {
            R.string.bg_midnight, R.string.bg_charcoal, R.string.bg_purple,
            R.string.bg_forest, R.string.bg_sunset,
    };
    /** Tile colours for apps that have no TV banner. */
    private static final int[] PLACEHOLDER_COLORS = {
            0xFF3949AB, 0xFF00897B, 0xFF8E24AA, 0xFFD84315,
            0xFF546E7A, 0xFF2E7D32, 0xFFC62828, 0xFF6D4C41,
    };

    private AppStore store;
    private LayoutInflater inflater;
    private ScrollView scroll;
    private LinearLayout favouritesGrid;
    private LinearLayout appsGrid;
    private TextView favouritesEmpty;
    private TextView loading;
    private View customizeButton;
    private View settingsButton;
    /** Favourites as currently shown, in order: installed and not hidden. */
    private List<String> shownFavourites = new ArrayList<>();

    private final BroadcastReceiver packageReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            store.refresh();
        }
    };

    private final View.OnFocusChangeListener focusZoom = new View.OnFocusChangeListener() {
        @Override
        public void onFocusChange(View tile, boolean hasFocus) {
            float scale = hasFocus ? 1.1f : 1f;
            tile.animate().scaleX(scale).scaleY(scale)
                    .translationZ(hasFocus ? 8 * getResources().getDisplayMetrics().density : 0)
                    .setDuration(120).start();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_home);
        inflater = LayoutInflater.from(this);
        scroll = (ScrollView) findViewById(R.id.scroll);
        favouritesGrid = (LinearLayout) findViewById(R.id.favourites_grid);
        appsGrid = (LinearLayout) findViewById(R.id.apps_grid);
        favouritesEmpty = (TextView) findViewById(R.id.favourites_empty);
        loading = (TextView) findViewById(R.id.loading);
        customizeButton = findViewById(R.id.btn_customize);
        settingsButton = findViewById(R.id.btn_settings);

        customizeButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showCustomizeMenu();
            }
        });
        settingsButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                open(new Intent(Settings.ACTION_SETTINGS));
            }
        });
        applyBackground();

        store = AppStore.get(this);
        store.setListener(this);
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REMOVED);
        filter.addAction(Intent.ACTION_PACKAGE_CHANGED);
        filter.addAction(Intent.ACTION_PACKAGE_REPLACED);
        filter.addDataScheme("package");
        registerReceiver(packageReceiver, filter);
        render(); // Instant if the apps were already loaded once.
    }

    @Override
    protected void onResume() {
        super.onResume();
        store.refresh();
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(packageReceiver);
        store.setListener(null);
        super.onDestroy();
    }

    /** Home pressed while TV Home is already open. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        goToTop();
    }

    /** Back on the home screen never leaves it; it just jumps to the top. */
    @Override
    public void onBackPressed() {
        goToTop();
    }

    @Override
    public void onAppsChanged() {
        render();
    }

    // ---------------------------------------------------------------- home screen

    private void render() {
        List<AppStore.App> all = store.apps();
        loading.setVisibility(all == null ? View.VISIBLE : View.GONE);
        if (all == null) {
            return;
        }
        View before = getWindow().getDecorView().findFocus();
        boolean onHeader = before == customizeButton || before == settingsButton;
        String focusedPackage = before != null && before.getTag() instanceof String ? (String) before.getTag() : null;

        Set<String> hidden = Prefs.hidden(this);
        Map<String, AppStore.App> byPackage = new HashMap<>();
        for (AppStore.App app : all) {
            byPackage.put(app.packageName, app);
        }
        List<AppStore.App> favourites = new ArrayList<>();
        shownFavourites = new ArrayList<>();
        for (String pkg : Prefs.favourites(this)) {
            AppStore.App app = byPackage.get(pkg);
            if (app != null && !hidden.contains(pkg) && !shownFavourites.contains(pkg)) {
                favourites.add(app);
                shownFavourites.add(pkg);
            }
        }
        List<AppStore.App> others = new ArrayList<>();
        for (AppStore.App app : all) {
            if (!hidden.contains(app.packageName) && !shownFavourites.contains(app.packageName)) {
                others.add(app);
            }
        }

        fillGrid(favouritesGrid, favourites);
        fillGrid(appsGrid, others);
        favouritesEmpty.setVisibility(favourites.isEmpty() ? View.VISIBLE : View.GONE);

        if (onHeader) {
            before.requestFocus();
            return;
        }
        View target = focusedPackage != null ? scroll.findViewWithTag(focusedPackage) : null;
        if (target == null) {
            target = firstTile();
        }
        if (target != null) {
            target.requestFocus();
        }
    }

    private void fillGrid(LinearLayout grid, List<AppStore.App> apps) {
        grid.removeAllViews();
        int tileWidth = getResources().getDimensionPixelSize(R.dimen.tile_width);
        int minGap = getResources().getDimensionPixelSize(R.dimen.tile_gap);
        int rowGap = getResources().getDimensionPixelSize(R.dimen.row_gap);
        int available = getResources().getDisplayMetrics().widthPixels
                - 2 * getResources().getDimensionPixelSize(R.dimen.overscan_horizontal);
        int columns = Math.max(1, (available + minGap) / (tileWidth + minGap));
        // Spread the tiles over the full width.
        int gap = columns > 1 ? (available - columns * tileWidth) / (columns - 1) : 0;

        LinearLayout row = null;
        for (int i = 0; i < apps.size(); i++) {
            if (i % columns == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setClipChildren(false);
                row.setClipToPadding(false);
                LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rowParams.bottomMargin = rowGap;
                grid.addView(row, rowParams);
            }
            LinearLayout.LayoutParams tileParams = new LinearLayout.LayoutParams(
                    tileWidth, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i % columns != 0) {
                tileParams.leftMargin = gap;
            }
            row.addView(makeTile(row, apps.get(i)), tileParams);
        }
    }

    private View makeTile(ViewGroup parent, final AppStore.App app) {
        View tile = inflater.inflate(R.layout.tile, parent, false);
        tile.setTag(app.packageName);
        View frame = tile.findViewById(R.id.frame);
        ImageView banner = (ImageView) tile.findViewById(R.id.banner);
        ImageView icon = (ImageView) tile.findViewById(R.id.icon);
        frame.setClipToOutline(true);
        if (app.banner != null) {
            banner.setImageDrawable(app.banner);
            icon.setVisibility(View.GONE);
        } else {
            banner.setVisibility(View.GONE);
            icon.setImageDrawable(app.icon);
            GradientDrawable color = new GradientDrawable();
            color.setColor(PLACEHOLDER_COLORS[(app.packageName.hashCode() & 0x7fffffff) % PLACEHOLDER_COLORS.length]);
            color.setCornerRadius(8 * getResources().getDisplayMetrics().density);
            frame.setBackground(color);
        }
        ((TextView) tile.findViewById(R.id.label)).setText(app.label);

        tile.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                open(app.launchIntent());
            }
        });
        tile.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                showAppMenu(app);
                return true;
            }
        });
        tile.setOnKeyListener(new View.OnKeyListener() {
            @Override
            public boolean onKey(View v, int keyCode, KeyEvent event) {
                if (keyCode != KeyEvent.KEYCODE_MENU) {
                    return false;
                }
                if (event.getAction() == KeyEvent.ACTION_UP) {
                    showAppMenu(app);
                }
                return true;
            }
        });
        tile.setOnFocusChangeListener(focusZoom);
        return tile;
    }

    private View firstTile() {
        for (LinearLayout grid : new LinearLayout[] {favouritesGrid, appsGrid}) {
            if (grid.getChildCount() > 0) {
                return ((ViewGroup) grid.getChildAt(0)).getChildAt(0);
            }
        }
        return null;
    }

    private void goToTop() {
        View first = firstTile();
        if (first != null) {
            first.requestFocus();
        }
        scroll.smoothScrollTo(0, 0);
    }

    private void applyBackground() {
        int index = Prefs.background(this);
        if (index < 0 || index >= BACKGROUNDS.length) {
            index = 0;
        }
        getWindow().setBackgroundDrawableResource(BACKGROUNDS[index]);
    }

    private void open(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.cant_open, Toast.LENGTH_SHORT).show();
        }
    }

    // ---------------------------------------------------------------- app menu

    private void showAppMenu(final AppStore.App app) {
        final List<Integer> actions = new ArrayList<>();
        actions.add(R.string.open);
        int position = shownFavourites.indexOf(app.packageName);
        if (position < 0) {
            actions.add(R.string.add_favourite);
        } else {
            if (position > 0) {
                actions.add(R.string.move_left);
            }
            if (position < shownFavourites.size() - 1) {
                actions.add(R.string.move_right);
            }
            actions.add(R.string.remove_favourite);
        }
        actions.add(R.string.hide_app);
        actions.add(R.string.app_info);
        if (!app.system) {
            actions.add(R.string.uninstall);
        }
        CharSequence[] labels = new CharSequence[actions.size()];
        for (int i = 0; i < labels.length; i++) {
            labels[i] = getString(actions.get(i));
        }
        new AlertDialog.Builder(this)
                .setTitle(app.label)
                .setItems(labels, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        onAppAction(app, actions.get(which));
                    }
                })
                .show();
    }

    private void onAppAction(AppStore.App app, int action) {
        String pkg = app.packageName;
        List<String> favourites = new ArrayList<>(shownFavourites);
        int position = favourites.indexOf(pkg);
        if (action == R.string.open) {
            open(app.launchIntent());
        } else if (action == R.string.add_favourite) {
            favourites.add(pkg);
            saveFavourites(favourites);
        } else if (action == R.string.remove_favourite) {
            favourites.remove(pkg);
            saveFavourites(favourites);
        } else if (action == R.string.move_left) {
            Collections.swap(favourites, position, position - 1);
            saveFavourites(favourites);
        } else if (action == R.string.move_right) {
            Collections.swap(favourites, position, position + 1);
            saveFavourites(favourites);
        } else if (action == R.string.hide_app) {
            Set<String> hidden = Prefs.hidden(this);
            hidden.add(pkg);
            Prefs.setHidden(this, hidden);
            favourites.remove(pkg);
            saveFavourites(favourites);
        } else if (action == R.string.app_info) {
            open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)));
        } else if (action == R.string.uninstall) {
            open(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg)));
        }
    }

    private void saveFavourites(List<String> favourites) {
        Prefs.setFavourites(this, favourites);
        render();
    }

    // ---------------------------------------------------------------- Customize menu

    private void showCustomizeMenu() {
        final int[] items = {R.string.choose_apps, R.string.background, R.string.home_button, R.string.about};
        CharSequence[] labels = new CharSequence[items.length];
        for (int i = 0; i < items.length; i++) {
            labels[i] = getString(items[i]);
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.customize)
                .setItems(labels, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        int item = items[which];
                        if (item == R.string.choose_apps) {
                            showChooseApps();
                        } else if (item == R.string.background) {
                            showBackgrounds();
                        } else if (item == R.string.home_button) {
                            showHomeButton();
                        } else {
                            showAbout();
                        }
                    }
                })
                .show();
    }

    /** One list of every app: ticked apps are shown, unticked ones are hidden. */
    private void showChooseApps() {
        final List<AppStore.App> all = store.apps();
        if (all == null) {
            return;
        }
        Set<String> hidden = Prefs.hidden(this);
        CharSequence[] labels = new CharSequence[all.size()];
        final boolean[] shown = new boolean[all.size()];
        for (int i = 0; i < labels.length; i++) {
            labels[i] = all.get(i).label;
            shown[i] = !hidden.contains(all.get(i).packageName);
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.choose_apps)
                .setMultiChoiceItems(labels, shown, new DialogInterface.OnMultiChoiceClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which, boolean isChecked) {
                        shown[which] = isChecked;
                    }
                })
                .setPositiveButton(R.string.done, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        // Hidden apps that are not installed right now stay hidden.
                        Set<String> newHidden = Prefs.hidden(HomeActivity.this);
                        for (int i = 0; i < shown.length; i++) {
                            if (shown[i]) {
                                newHidden.remove(all.get(i).packageName);
                            } else {
                                newHidden.add(all.get(i).packageName);
                            }
                        }
                        Prefs.setHidden(HomeActivity.this, newHidden);
                        List<String> favourites = new ArrayList<>(shownFavourites);
                        favourites.removeAll(newHidden);
                        saveFavourites(favourites);
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void showBackgrounds() {
        CharSequence[] labels = new CharSequence[BACKGROUND_NAMES.length];
        for (int i = 0; i < labels.length; i++) {
            labels[i] = getString(BACKGROUND_NAMES[i]);
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.background)
                .setSingleChoiceItems(labels, Prefs.background(this), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        Prefs.setBackground(HomeActivity.this, which);
                        applyBackground();
                        dialog.dismiss();
                    }
                })
                .show();
    }

    private void showHomeButton() {
        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle(R.string.home_button);
        if (!isHomeButtonServiceAllowed()) {
            dialog.setMessage(R.string.home_button_off)
                    .setPositiveButton(R.string.open_settings, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int which) {
                            Prefs.setHomeButtonEnabled(HomeActivity.this, true);
                            open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                        }
                    })
                    .setNegativeButton(R.string.cancel, null);
        } else {
            final boolean enabled = Prefs.homeButtonEnabled(this);
            dialog.setMessage(enabled ? R.string.home_button_on : R.string.home_button_paused)
                    .setPositiveButton(enabled ? R.string.turn_off : R.string.turn_on,
                            new DialogInterface.OnClickListener() {
                                @Override
                                public void onClick(DialogInterface d, int which) {
                                    Prefs.setHomeButtonEnabled(HomeActivity.this, !enabled);
                                }
                            })
                    .setNegativeButton(R.string.cancel, null);
        }
        dialog.show();
    }

    private boolean isHomeButtonServiceAllowed() {
        String enabled = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) {
            return false;
        }
        ComponentName service = new ComponentName(this, HomeButtonService.class);
        for (String entry : enabled.split(":")) {
            if (service.equals(ComponentName.unflattenFromString(entry))) {
                return true;
            }
        }
        return false;
    }

    private void showAbout() {
        String version = "?";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            // Our own package is always there.
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.about)
                .setMessage(getString(R.string.about_text, version))
                .setPositiveButton(R.string.done, null)
                .show();
    }
}
