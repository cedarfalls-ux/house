#!/usr/bin/env bash
# Builds the APK (for R.java and the compiled resources) and the androidx.test classes,
# then runs the Robolectric tests.
set -euo pipefail
cd "$(dirname "$0")"
../build.sh
./build-androidx-test.sh
mvn -q clean test "$@"
