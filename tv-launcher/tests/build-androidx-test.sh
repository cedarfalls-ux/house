#!/usr/bin/env bash
# Robolectric needs androidx.test "monitor" classes at run time. They are only published as
# Android .aar files on Google's Maven repository, which plain Maven cannot use (and which may
# be unreachable), so this builds them from the open-source android-test repository instead.
# Output: lib/androidx-test-monitor.jar (not committed).
set -euo pipefail
cd "$(dirname "$0")"
COMMIT=56f9439198ec34dba7f23aabc6319b719784e886
ANDROID_ALL=$HOME/.m2/repository/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar
ERRORPRONE=$HOME/.m2/repository/com/google/errorprone/error_prone_annotations/2.28.0/error_prone_annotations-2.28.0.jar
[ -f lib/androidx-test-monitor.jar ] && exit 0

mvn -q dependency:get -Dartifact=org.robolectric:android-all:14-robolectric-10818077
mvn -q dependency:get -Dartifact=com.google.errorprone:error_prone_annotations:2.28.0

rm -rf lib/android-test lib/stubs lib/classes
mkdir -p lib/stubs/androidx/annotation lib/stubs/androidx/tracing lib/classes
git clone -q --filter=blob:none --no-checkout https://github.com/android/android-test lib/android-test
git -C lib/android-test sparse-checkout set runner/monitor/java espresso/idling_resource/java
git -C lib/android-test checkout -q "$COMMIT"

# Compile-time-only annotations and a no-op tracer used by the monitor sources.
for a in NonNull Nullable VisibleForTesting; do
    echo "package androidx.annotation; public @interface $a { int otherwise() default 0; }" \
        > "lib/stubs/androidx/annotation/$a.java"
done
echo 'package androidx.annotation; public @interface RestrictTo { Scope[] value(); enum Scope { LIBRARY, LIBRARY_GROUP, LIBRARY_GROUP_PREFIX, GROUP_ID, TESTS, SUBCLASSES } }' \
    > lib/stubs/androidx/annotation/RestrictTo.java
echo 'package androidx.tracing; public final class Trace { public static void beginSection(String s) {} public static void endSection() {} public static void forceEnableAppTracing() {} public static boolean isEnabled() { return false; } }' \
    > lib/stubs/androidx/tracing/Trace.java

# Kotlin files are left out, and so is every Java file that (indirectly) needs them:
# compile, drop the files javac complains about, repeat. Robolectric uses none of them.
SOURCES=$(find lib/android-test/runner/monitor/java lib/android-test/espresso/idling_resource/java/androidx/test/espresso \
    -maxdepth 20 -name '*.java' -not -path '*/idling/*')
for attempt in $(seq 1 15); do
    if javac -nowarn -proc:none -d lib/classes -cp "$ANDROID_ALL:$ERRORPRONE" \
        $(find lib/stubs -name '*.java') $SOURCES 2> lib/javac.log; then
        break
    fi
    BAD=$(grep -oE '^lib/android-test/[^:]+\.java' lib/javac.log | sort -u)
    if [ -z "$BAD" ] || [ "$attempt" = 15 ]; then
        cat lib/javac.log
        exit 1
    fi
    SOURCES=$(printf '%s\n' $SOURCES | grep -vxF "$BAD")
done
rm -rf lib/classes/androidx/annotation lib/classes/androidx/tracing
jar cf lib/androidx-test-monitor.jar -C lib/classes .
echo "Built $(pwd)/lib/androidx-test-monitor.jar"
