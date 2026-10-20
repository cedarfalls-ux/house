package com.cedarfalls.tvhome;

import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.view.View;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

import java.io.File;
import java.io.FileOutputStream;
import java.time.Duration;
import java.util.Arrays;

/** Draws the home screen at TV size into target/home-screen.png, to see the layout without a TV. */
@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = 34, qualifiers = "w960dp-h540dp-land-television-xhdpi")
public class ScreenshotTest {

    @Test
    public void drawHomeScreen() throws Exception {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false);
        FakeApps.resetStore();
        String[][] apps = {
                {"com.netflix.ninja", "Netflix"}, {"com.google.android.youtube.tv", "YouTube"},
                {"com.amazon.amazonvideo.livingroom", "Prime Video"}, {"com.hulu.livingroomplus", "Hulu"},
                {"com.google.android.youtube.tvunplugged", "YouTube TV"}, {"tv.pluto.android", "Pluto TV"},
                {"com.tubitv", "Tubi"}, {"com.graymatrix.did", "ZEE5"}, {"com.sonyliv", "SonyLIV"},
                {"com.sling", "Sling TV"}, {"com.plexapp.android", "Plex"}, {"com.spotify.tv.android", "Spotify"},
        };
        for (String[] app : apps) {
            FakeApps.install(app[0], app[1], Intent.CATEGORY_LEANBACK_LAUNCHER, false);
        }
        Prefs.setFavourites(InstrumentationRegistry.getInstrumentation().getTargetContext(),
                Arrays.asList("com.netflix.ninja", "com.google.android.youtube.tv", "com.amazon.amazonvideo.livingroom",
                        "com.google.android.youtube.tvunplugged", "com.graymatrix.did"));

        HomeActivity activity = Robolectric.buildActivity(HomeActivity.class).setup().get();
        FakeApps.finishLoading();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1)); // focus zoom animation

        View root = activity.getWindow().getDecorView();
        Bitmap bitmap = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(bitmap));
        File out = new File("target/home-screen.png");
        try (FileOutputStream stream = new FileOutputStream(out)) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
        }
        assertTrue(out.length() > 0);
    }
}
