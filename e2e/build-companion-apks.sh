#!/usr/bin/env bash
#
# Builds the Companion's debug QA and secure APKs for one Flutter target platform into the given directory, as
# app-qa-debug.apk and app-secure-debug.apk. The build runs in a copy of companion/ kept outside the repository, in
# ${XDG_CACHE_HOME:-$HOME/.cache}/accrawl/e2e-companion-source, so Flutter and Gradle rebuild only what changed since
# the previous build.
#
# Usage: build-companion-apks.sh <flutter-target-platform> <output-directory>
set -euo pipefail
target="${1:?usage: build-companion-apks.sh <flutter-target-platform> <output-directory>}"
out="${2:?usage: build-companion-apks.sh <flutter-target-platform> <output-directory>}"
script="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
source_copy="${XDG_CACHE_HOME:-$HOME/.cache}/accrawl/e2e-companion-source"
lock="$source_copy.lock"
mkdir -p "$(dirname "$source_copy")"

if [ -z "${ACCRAWL_COMPANION_BUILD_LOCK_HELD:-}" ]; then
  if command -v lockf >/dev/null 2>&1; then
    exec lockf -k "$lock" env ACCRAWL_COMPANION_BUILD_LOCK_HELD=1 "$script" "$@"
  elif command -v flock >/dev/null 2>&1; then
    exec flock "$lock" env ACCRAWL_COMPANION_BUILD_LOCK_HELD=1 "$script" "$@"
  fi
  echo "building the Companion requires lockf or flock to serialize its shared build copy" >&2
  exit 2
fi

companion="$(cd "$(dirname "$script")/../companion" && pwd -P)"
out="$(cd "$out" && pwd -P)"
mkdir -p "$source_copy"
# The copy is kept between runs, so files are compared by content (--checksum) and every file copied gets the current
# time (--no-times): Flutter decides what to recompile by timestamp, and a changed file carrying its source's older
# time would leave the previous build in place. --delete removes what was deleted from companion/ but leaves excluded
# paths alone, so the build's own record of what is up to date survives: build/, .dart_tool/ and android/.gradle/.
rsync -a --no-times --checksum --delete --exclude=.dart_tool --exclude=build --exclude=.gradle "$companion/" "$source_copy/"
cd "$source_copy"
flutter pub get
flutter build apk --flavor qa --debug --target-platform "$target"
cp build/app/outputs/flutter-apk/app-qa-debug.apk "$out/app-qa-debug.apk"
flutter build apk --flavor secure --debug --target-platform "$target"
cp build/app/outputs/flutter-apk/app-secure-debug.apk "$out/app-secure-debug.apk"
