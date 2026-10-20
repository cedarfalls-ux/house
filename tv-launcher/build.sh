#!/usr/bin/env bash
# Builds TVHome.apk without Android Studio, using Ubuntu's Android packages:
#   sudo apt-get install aapt apksigner dalvik-exchange zipalign android-sdk-platform-23
#
# Signing: uses tvhome.keystore (created on the first build, never committed).
# Android only installs an update over TV Home if it is signed with the same key,
# so keep that file. A build with a new key means uninstalling TV Home first.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
KEYSTORE=${KEYSTORE:-tvhome.keystore}
KEYSTORE_PASS=${KEYSTORE_PASS:-tvhome-sideload}
SRC=app/src/main
OUT=build

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes"

echo "1/5 Resources"
aapt2 compile --dir "$SRC/res" -o "$OUT/res.zip"
aapt2 link -I "$ANDROID_JAR" --manifest "$SRC/AndroidManifest.xml" "$OUT/res.zip" \
    --java "$OUT/gen" -o "$OUT/unsigned.apk"

echo "2/5 Java"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
    -bootclasspath "$ANDROID_JAR" -d "$OUT/classes" \
    $(find "$SRC/java" "$OUT/gen" -name '*.java')

echo "3/5 Dex"
dalvik-exchange --dex --min-sdk-version=21 --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && zip -q unsigned.apk classes.dex)

echo "4/5 Align"
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "5/5 Sign"
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
        -alias tvhome -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=TV Home" 2>/dev/null
fi
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --out TVHome.apk "$OUT/aligned.apk"
apksigner verify TVHome.apk
echo "Built $(pwd)/TVHome.apk ($(du -k TVHome.apk | cut -f1) KB)"
