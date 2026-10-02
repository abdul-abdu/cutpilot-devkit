#!/bin/sh
# Build the face helper as a universal macOS binary (arm64 + x86_64) at bin/face-helper.
#
#   plugins/follow-speaker/helper/build.sh
#
# Needs the Xcode command line tools (swiftc, lipo, codesign) on a Mac. The binary is signed
# ad hoc, which is what runs locally; a release build is signed and notarized separately.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out="$here/../bin"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build.sh: the face helper uses Apple Vision and builds on macOS only" >&2
  exit 1
fi

for arch in arm64 x86_64; do
  swiftc -O -whole-module-optimization \
    -target "$arch-apple-macos12" \
    -o "$work/face-helper-$arch" \
    "$here/main.swift"
done

mkdir -p "$out"
lipo -create -output "$out/face-helper" "$work/face-helper-arm64" "$work/face-helper-x86_64"
codesign --force --sign - "$out/face-helper"
lipo -info "$out/face-helper"
