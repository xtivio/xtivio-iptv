#!/bin/sh
# Assemble the Tizen app folder (web + config.xml) in dist/tizen. Package it with Tizen Studio or the tizen CLI.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$R/dist/tizen"; mkdir -p "$R/dist/tizen"; cp -r "$R/web/." "$R/dist/tizen/"; cp "$R/tizen/config.xml" "$R/dist/tizen/"
echo "ready: dist/tizen"
