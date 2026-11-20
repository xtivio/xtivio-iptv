#!/bin/bash
# Run the quality gates. Needs node and python3, and the acorn and css-tree npm packages (NM = their node_modules).
#   NM=/path/to/node_modules bash tools/run-gates.sh
R=$(cd "$(dirname "$0")/.." && pwd); G=$R/tools/gates; W=$R/web
export NODE_PATH=${NM:-$R/node_modules}
T=$(mktemp -d); mkdir -p "$T/app/src/main/assets"; ln -s "$W" "$T/app/src/main/assets/web"
cd "$W" && ln -sfn "$G" tools
fail=0
run(){ n=$1; shift; out=$("$@" 2>&1); rc=$?; [ $rc -ne 0 ] && fail=1; echo "[$rc] $n :: $(echo "$out" | tail -1 | cut -c1-200)"; }
run patch-marker python3 $G/patch-marker-check.py "$T"
for g in css-comment-balance-check css-clamp-wrap-check css-dup-fontsource-check css-dupcheck css-flex-shrink-growth-check css-important-check css-intrablock-check css-paired-invariants-check css-runtime-class-check css-scale-conflict-check css-scale-fontsize-check; do run $g python3 tools/$g.py; done
run es5-check sh tools/es5-check.sh; run css-compat sh tools/css-compat-check.sh; run lang sh tools/lang-check.sh; run i18n python3 tools/i18n-check.py
run invisible node tools/css-invisible-text.js; run es5-parse node tools/es5-parse-check.js; run boot-smoke node tools/boot-smoke-check.js
cp assets/css/tv-720.css /tmp/tv720.b; python3 tools/gen-tv720.py >/dev/null 2>&1
if diff -q /tmp/tv720.b assets/css/tv-720.css >/dev/null; then echo "[0] tv720 regen unchanged"; else echo "[1] tv720 regen CHANGED (regenerated now; review diff)"; fail=1; fi
rm -f tools; rm -rf "$T"; echo "overall fail=$fail"
