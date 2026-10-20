package com.cedarfalls.tvhome;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Looper;
import android.view.FocusFinder;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, qualifiers = "w960dp-h540dp-land-television-xhdpi")
public class HomeActivityTest {

    private ComponentName netflix;
    private ComponentName phoneApp;
    private ActivityController<HomeActivity> controller;
    private HomeActivity activity;

    @Before
    public void setUp() throws Exception {
        // A TV remote has no touchscreen, so the screen is never in touch mode.
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false);
        FakeApps.resetStore();
        netflix = FakeApps.install("com.netflix.ninja", "Netflix", Intent.CATEGORY_LEANBACK_LAUNCHER, false);
        ComponentName youtube = FakeApps.install("com.google.android.youtube.tv", "YouTube",
                Intent.CATEGORY_LEANBACK_LAUNCHER, true);
        FakeApps.addCategory(youtube, Intent.CATEGORY_LAUNCHER); // listed once, as a TV app
        FakeApps.install("com.walmart.extras", "Walmart Extras", Intent.CATEGORY_LEANBACK_LAUNCHER, true);
        phoneApp = FakeApps.install("com.example.phone", "Phone App", Intent.CATEGORY_LAUNCHER, false);
    }

    private void launch() throws Exception {
        controller = Robolectric.buildActivity(HomeActivity.class).setup();
        activity = controller.get();
        FakeApps.finishLoading();
    }

    @Test
    public void showsEveryAppAlphabeticallyAndFocusesTheFirst() throws Exception {
        launch();
        assertEquals(Arrays.asList("Netflix", "Phone App", "Walmart Extras", "YouTube"), labels(R.id.apps_grid));
        assertEquals(Collections.emptyList(), labels(R.id.favourites_grid));
        assertEquals(View.VISIBLE, activity.findViewById(R.id.favourites_empty).getVisibility());
        assertEquals(View.GONE, activity.findViewById(R.id.loading).getVisibility());
        assertEquals("com.netflix.ninja", focusedTag());
        // 960dp wide TV: five tiles per row.
        assertEquals(1, ((ViewGroup) activity.findViewById(R.id.apps_grid)).getChildCount());
    }

    @Test
    public void remoteArrowsMoveBetweenTilesAndUpReachesTheButtons() throws Exception {
        launch();
        ViewGroup root = (ViewGroup) activity.getWindow().getDecorView();
        View netflixTile = tile("com.netflix.ninja");
        View right = FocusFinder.getInstance().findNextFocus(root, netflixTile, View.FOCUS_RIGHT);
        assertEquals("com.example.phone", right.getTag());
        View up = FocusFinder.getInstance().findNextFocus(root, netflixTile, View.FOCUS_UP);
        assertTrue(up.getId() == R.id.btn_customize || up.getId() == R.id.btn_settings);
        View down = FocusFinder.getInstance().findNextFocus(root, up, View.FOCUS_DOWN);
        assertTrue(down.getTag() instanceof String);
    }

    @Test
    public void holdingOkOnATileOpensItsMenu() throws Exception {
        launch();
        View netflixTile = tile("com.netflix.ninja");
        netflixTile.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        netflixTile.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER));
        shadowOf(Looper.getMainLooper()).idle();
        AlertDialog menu = ShadowAlertDialog.getLatestAlertDialog();
        assertNotNull(menu);
        assertTrue(menu.isShowing());
        assertEquals("Netflix", shadowOf(menu).getTitle().toString());
        assertNull("holding OK must not also open the app", shadowOf(activity).getNextStartedActivity());
    }

    @Test
    public void wrapsIntoRowsOfFive() throws Exception {
        for (int i = 0; i < 7; i++) {
            FakeApps.install("com.example.extra" + i, "Extra " + i, Intent.CATEGORY_LEANBACK_LAUNCHER, false);
        }
        launch();
        ViewGroup grid = (ViewGroup) activity.findViewById(R.id.apps_grid);
        assertEquals(3, grid.getChildCount());
        assertEquals(5, ((ViewGroup) grid.getChildAt(0)).getChildCount());
        assertEquals(1, ((ViewGroup) grid.getChildAt(2)).getChildCount());
    }

    @Test
    public void clickingATileOpensTheApp() throws Exception {
        launch();
        tile("com.netflix.ninja").performClick();
        Intent started = shadowOf(activity).getNextStartedActivity();
        assertEquals(netflix, started.getComponent());
        assertTrue(started.hasCategory(Intent.CATEGORY_LEANBACK_LAUNCHER));

        tile("com.example.phone").performClick();
        started = shadowOf(activity).getNextStartedActivity();
        assertEquals(phoneApp, started.getComponent());
        assertTrue(started.hasCategory(Intent.CATEGORY_LAUNCHER));
    }

    @Test
    public void addToFavouritesMovesTheAppUp() throws Exception {
        launch();
        chooseFromAppMenu("com.netflix.ninja", R.string.add_favourite);
        assertEquals(Collections.singletonList("Netflix"), labels(R.id.favourites_grid));
        assertEquals(Arrays.asList("Phone App", "Walmart Extras", "YouTube"), labels(R.id.apps_grid));
        assertEquals(View.GONE, activity.findViewById(R.id.favourites_empty).getVisibility());
        assertEquals("com.netflix.ninja", focusedTag());
        assertEquals(Collections.singletonList("com.netflix.ninja"), Prefs.favourites(activity));
    }

    @Test
    public void favouritesCanBeReorderedAndRemoved() throws Exception {
        launch();
        chooseFromAppMenu("com.netflix.ninja", R.string.add_favourite);
        chooseFromAppMenu("com.google.android.youtube.tv", R.string.add_favourite);
        assertEquals(Arrays.asList("Netflix", "YouTube"), labels(R.id.favourites_grid));

        assertEquals(Arrays.asList(R.string.open, R.string.move_left, R.string.remove_favourite,
                R.string.hide_app, R.string.app_info), appMenu("com.google.android.youtube.tv"));
        chooseFromAppMenu("com.google.android.youtube.tv", R.string.move_left);
        assertEquals(Arrays.asList("YouTube", "Netflix"), labels(R.id.favourites_grid));

        chooseFromAppMenu("com.google.android.youtube.tv", R.string.remove_favourite);
        assertEquals(Collections.singletonList("Netflix"), labels(R.id.favourites_grid));
        assertTrue(labels(R.id.apps_grid).contains("YouTube"));
    }

    @Test
    public void favouritesSurviveARestart() throws Exception {
        launch();
        chooseFromAppMenu("com.example.phone", R.string.add_favourite);
        controller.pause().stop().destroy();
        FakeApps.resetStore();
        launch();
        assertEquals(Collections.singletonList("Phone App"), labels(R.id.favourites_grid));
    }

    @Test
    public void hiddenAppsCanBeBroughtBack() throws Exception {
        launch();
        chooseFromAppMenu("com.netflix.ninja", R.string.add_favourite);
        chooseFromAppMenu("com.walmart.extras", R.string.hide_app);
        chooseFromAppMenu("com.netflix.ninja", R.string.hide_app);
        assertEquals(Collections.emptyList(), labels(R.id.favourites_grid));
        assertEquals(Arrays.asList("Phone App", "YouTube"), labels(R.id.apps_grid));

        // Customize > Choose apps: hidden apps are the unticked ones.
        activity.findViewById(R.id.btn_customize).performClick();
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(R.string.choose_apps));
        AlertDialog choose = ShadowAlertDialog.getLatestAlertDialog();
        assertEquals(activity.getString(R.string.choose_apps), shadowOf(choose).getTitle().toString());
        clickItem(choose, "Netflix");
        choose.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        shadowOf(Looper.getMainLooper()).idle();

        assertEquals(Arrays.asList("Netflix", "Phone App", "YouTube"), labels(R.id.apps_grid));
        assertEquals(Collections.singleton("com.walmart.extras"), Prefs.hidden(activity));
    }

    @Test
    public void uninstallIsOnlyOfferedForAppsThatCanBeRemoved() throws Exception {
        launch();
        assertTrue(appMenu("com.netflix.ninja").contains(R.string.uninstall));
        assertFalse(appMenu("com.walmart.extras").contains(R.string.uninstall));

        chooseFromAppMenu("com.netflix.ninja", R.string.uninstall);
        Intent started = shadowOf(activity).getNextStartedActivity();
        assertEquals(Intent.ACTION_DELETE, started.getAction());
        assertEquals("package:com.netflix.ninja", started.getDataString());
    }

    @Test
    public void newlyInstalledAppsShowUpWhenComingBackHome() throws Exception {
        launch();
        controller.pause();
        FakeApps.install("com.hulu.livingroomplus", "Hulu", Intent.CATEGORY_LEANBACK_LAUNCHER, false);
        controller.resume();
        FakeApps.finishLoading();
        assertEquals(Arrays.asList("Hulu", "Netflix", "Phone App", "Walmart Extras", "YouTube"),
                labels(R.id.apps_grid));
    }

    @Test
    public void backAndHomeKeepYouOnTheHomeScreen() throws Exception {
        launch();
        activity.findViewById(R.id.btn_settings).requestFocus();
        activity.onBackPressed();
        assertFalse(activity.isFinishing());
        assertEquals("com.netflix.ninja", focusedTag());

        controller.newIntent(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME));
        assertFalse(activity.isFinishing());
    }

    @Test
    public void settingsButtonOpensAndroidSettings() throws Exception {
        launch();
        activity.findViewById(R.id.btn_settings).performClick();
        assertEquals(android.provider.Settings.ACTION_SETTINGS, shadowOf(activity).getNextStartedActivity().getAction());
    }

    @Test
    public void backgroundChoiceIsRemembered() throws Exception {
        launch();
        activity.findViewById(R.id.btn_customize).performClick();
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(R.string.background));
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(R.string.bg_forest));
        assertEquals(3, Prefs.background(activity));
        assertEquals(R.drawable.bg_forest, HomeActivity.BACKGROUNDS[Prefs.background(activity)]);
    }

    @Test
    public void homeButtonDialogSendsYouToAccessibilitySettings() throws Exception {
        launch();
        activity.findViewById(R.id.btn_customize).performClick();
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(R.string.home_button));
        AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
        assertEquals(activity.getString(R.string.home_button_off), shadowOf(dialog).getMessage().toString());
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS,
                shadowOf(activity).getNextStartedActivity().getAction());
    }

    @Test
    public void homeButtonCanBePausedOnceAllowed() throws Exception {
        android.provider.Settings.Secure.putString(RuntimeEnvironment.getApplication().getContentResolver(),
                android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                "com.other/.Service:com.cedarfalls.tvhome/.HomeButtonService");
        launch();
        activity.findViewById(R.id.btn_customize).performClick();
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(R.string.home_button));
        AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
        assertEquals(activity.getString(R.string.home_button_on), shadowOf(dialog).getMessage().toString());
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        shadowOf(Looper.getMainLooper()).idle();
        assertFalse(Prefs.homeButtonEnabled(activity));
    }

    // ---------------------------------------------------------------- helpers

    private Object focusedTag() {
        View focused = activity.getWindow().getDecorView().findFocus();
        return focused == null ? null : focused.getTag();
    }

    private View tile(String pkg) {
        View tile = activity.findViewById(R.id.scroll).findViewWithTag(pkg);
        assertNotNull("no tile for " + pkg, tile);
        return tile;
    }

    private List<String> labels(int gridId) {
        List<String> labels = new ArrayList<>();
        ViewGroup grid = (ViewGroup) activity.findViewById(gridId);
        for (int r = 0; r < grid.getChildCount(); r++) {
            ViewGroup row = (ViewGroup) grid.getChildAt(r);
            for (int c = 0; c < row.getChildCount(); c++) {
                labels.add(((TextView) row.getChildAt(c).findViewById(R.id.label)).getText().toString());
            }
        }
        return labels;
    }

    /** The app menu's items, as string resource ids. */
    private List<Integer> appMenu(String pkg) {
        tile(pkg).performLongClick();
        AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
        int[] all = {R.string.open, R.string.add_favourite, R.string.move_left, R.string.move_right,
                R.string.remove_favourite, R.string.hide_app, R.string.app_info, R.string.uninstall};
        List<Integer> ids = new ArrayList<>();
        for (CharSequence item : shadowOf(dialog).getItems()) {
            Integer id = null;
            for (int candidate : all) {
                if (activity.getString(candidate).contentEquals(item)) {
                    id = candidate;
                }
            }
            assertNotNull("unknown menu item " + item, id);
            ids.add(id);
        }
        dialog.dismiss();
        return ids;
    }

    private void chooseFromAppMenu(String pkg, int item) {
        tile(pkg).performLongClick();
        clickItem(ShadowAlertDialog.getLatestAlertDialog(), activity.getString(item));
    }

    private static void clickItem(AlertDialog dialog, String label) {
        CharSequence[] items = shadowOf(dialog).getItems();
        for (int i = 0; i < items.length; i++) {
            if (label.contentEquals(items[i])) {
                shadowOf(dialog).clickOnItem(i);
                shadowOf(Looper.getMainLooper()).idle();
                return;
            }
        }
        fail("menu has no item " + label + " in " + Arrays.toString(items));
    }
}
