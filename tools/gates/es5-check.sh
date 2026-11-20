#!/bin/sh
# es5-check.sh — MANDATORY pre-package gate.
#
# Chromium 53 (WebOS 4) has no template literals, so a stray backtick is either a
# template literal (breaks the TV) or comment noise that reads as one. The tree was
# deliberately cleaned of backticks, so ANY new one is a regression — 431
# reintroduced three in comments.
#
# The ONLY legitimate backtick is the vkeyboard symbol key in ui-modal.js, which is
# a real character the user types.
#
# Also checks for the other ES5 violations that would break Chromium 53.
#
# Usage: sh tools/es5-check.sh   (exit 0 clean, 1 problems)

status=0

# --- backticks -------------------------------------------------------------
# Allow exactly the vkeyboard symbol-row line.
hits=$(grep -rn '`' assets/js/*.js \
       | grep -v 'hls.min.js' \
       | grep -v "VK_LAYOUT_SYM\|';',':'")
if [ -n "$hits" ]; then
  echo "es5-check: stray backticks (template literals break Chromium 53; comments"
  echo "           should not use them either — the tree is deliberately backtick-free):"
  echo "$hits" | sed 's/^/    /'
  status=1
fi

# --- patch-version markers in comments -------------------------------------
# PROCESS.md forbids these: comments should explain what the code does and why,
# not which patch added them. They also go stale silently (a "340px base" note
# outlived two width changes). Delegated to the hardened detector, which catches
# the many phrasings the old inline grep missed ("since 462", "(481)", "576:",
# "in 579", ...) while guarding against pixel dims / keycodes / years / durations.
if [ -f tools/patch-marker-check.py ]; then
  if ! python3 tools/patch-marker-check.py; then
    status=1
  fi
fi

# --- other ES5 violations --------------------------------------------------
# Strip // and /* */ comment bodies before matching so prose like
# "// let the keystroke type" isn't flagged as a `let` declaration.
tmp=$(mktemp)
for f in assets/js/*.js; do
  case "$f" in *hls.min.js) continue;; esac
  # Drop block-comment continuation lines (" * ...") and strip // and /* */ bodies,
  # so prose like "// let the keystroke type" or "Xtream => normalized" isn't flagged.
  grep -vE '^[[:space:]]*\*' "$f" \
    | sed 's://.*::; s:/\*.*\*/::; s:/\*.*::' \
    | grep -nE '=>|(^|[^A-Za-z0-9_$])(const|let)[[:space:]]+[A-Za-z_$]' \
    | sed "s|^|$f:|" >> "$tmp"
done
if [ -s "$tmp" ]; then
  echo "es5-check: ES5 violation (arrow fn / const / let):"
  sed 's/^/    /' "$tmp" | head -20
  status=1
fi
rm -f "$tmp"

if [ "$status" -eq 0 ]; then
  echo "es5-check: clean"
else
  echo ""
  echo "es5-check: FAILED"
fi
exit $status
