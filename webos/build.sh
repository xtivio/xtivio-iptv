#!/bin/sh
# Assemble the webOS app folder (web + manifest) in dist/webos. Package it with ares-package afterwards.
# usage: sh webos/build.sh [1080|720]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$(dirname "$0")/.." && pwd); M=appinfo.json; [ "${1:-1080}" = 720 ] && M=appinfo.json720
rm -rf "$R/dist/webos"; mkdir -p "$R/dist/webos"; cp -r "$R/web/." "$R/dist/webos/"; cp "$R/webos/$M" "$R/dist/webos/appinfo.json"
echo "ready: dist/webos   then: ares-package dist/webos webos/service"
