#!/bin/sh
# lang-check.sh — validation gate for translation tables.
#
# For every assets/lang/*.js file, verifies:
#   1. valid JS syntax (node --check)
#   2. key set is IDENTICAL to en.js (no missing keys -> no silent English
#      fallback; no extra keys -> no dead strings)
#   3. registers under the right language code (filename must match I18n.register)
#   4. placeholders {name} / {n} present in en.js are preserved per key
#   5. _lang_name is present
#
# Usage: sh tools/lang-check.sh
# Exit 0 = clean, 1 = problems found.

EN=assets/lang/en.js
status=0

grep -oE "^[[:space:]]+'[a-z0-9_]+':" "$EN" | tr -d " ':" | sort > /tmp/_en_keys

# Duplicate keys anywhere (including en.js): a repeated key means the LATER
# definition silently wins, so the value you read in the file may not be the one
# that renders. 432 found six of these left over from two tagging passes
# (ui_sign_in resolved to "Sign In & Sync" for a settings button that wanted
# "Sign In"). Same failure shape as duplicate CSS selectors.
for f in assets/lang/*.js; do
  dups=$(grep -oE "^[[:space:]]+'[a-z0-9_]+':" "$f" | tr -d " ':" | sort | uniq -d)
  if [ -n "$dups" ]; then
    echo "$(basename "$f"): DUPLICATE keys (later definition silently wins):"
    echo "$dups" | sed 's/^/    /'
    status=1
  fi
done

for f in assets/lang/*.js; do
  base=$(basename "$f" .js)
  [ "$base" = "en" ] && continue

  if ! node --check "$f" >/dev/null 2>&1; then
    echo "$base: SYNTAX ERROR"; status=1; continue
  fi

  if ! grep -q "I18n.register('$base'" "$f"; then
    echo "$base: register() code does not match filename"; status=1
  fi

  grep -oE "^[[:space:]]+'[a-z0-9_]+':" "$f" | tr -d " ':" | sort > /tmp/_x_keys
  missing=$(comm -23 /tmp/_en_keys /tmp/_x_keys)
  extra=$(comm -13 /tmp/_en_keys /tmp/_x_keys)
  if [ -n "$missing" ]; then
    echo "$base: MISSING keys:"; echo "$missing" | sed 's/^/    /'; status=1
  fi
  if [ -n "$extra" ]; then
    echo "$base: EXTRA keys:"; echo "$extra" | sed 's/^/    /'; status=1
  fi

  if ! grep -q "'_lang_name'" "$f"; then
    echo "$base: missing _lang_name"; status=1
  fi

  # Placeholder preservation: any key whose English value has {name}/{n}
  # must have the same placeholder in the translation.
  for ph in '{name}' '{n}'; do
    esc=$(printf '%s' "$ph" | sed 's/[{}]/\\&/g')
    for k in $(grep -E "^[[:space:]]+'[a-z0-9_]+':.*$esc" "$EN" | grep -oE "'[a-z0-9_]+':" | tr -d "':"); do
      if ! grep -E "^[[:space:]]+'$k':" "$f" | grep -q "$esc"; then
        echo "$base: key '$k' lost placeholder $ph"; status=1
      fi
    done
  done
done


# --- every T('key') in the JS must resolve in en.js -------------------------
# A typo'd or forgotten key renders the raw key string on screen. Catches the
# common mistake when converting hardcoded literals to T() calls (433+).
python3 - <<'PY'
import re, os, sys
en = open('assets/lang/en.js', encoding='utf-8').read()
keys = set(re.findall(r"^\s+'([a-z0-9_]+)':", en, re.M))
bad = {}
for fn in sorted(os.listdir('assets/js')):
    if not fn.endswith('.js') or fn == 'hls.min.js':
        continue
    if fn == 'i18n.js':      # defines t(key); its T(key) is a variable
        continue
    for i, line in enumerate(open('assets/js/' + fn, encoding='utf-8'), 1):
        for m in re.finditer(r"T\('([a-z0-9_]+)'\)", line):
            if m.group(1) not in keys:
                bad.setdefault(m.group(1), []).append('%s:%d' % (fn, i))
if bad:
    print("lang-check: T() keys with no en.js entry:")
    for k, v in sorted(bad.items()):
        print("    %s  (%s)" % (k, ', '.join(v[:3])))
    sys.exit(1)
PY
if [ $? -ne 0 ]; then status=1; fi

# --- delimiter balance vs en.js -------------------------------------------
# Several strings deliberately end mid-sentence because the CODE appends to
# them, e.g. 'pairing_failed_this_app_version_does' ends with "(schema " and
# app.js supplies the closing "), ." — so the English value has ONE "(" and NO
# ")". A translator who "helpfully" closes the bracket produces "(schema 3))".
# Same shape as the real Turkish bug in 453, where 'no_results_for' had its
# quote moved from the end to the start and rendered "...yokTERM"".
# Key parity and {placeholder} checks cannot see any of this, so compare the
# COUNT of each delimiter against English for every key.
python3 - <<'PY'
import re, os, sys

def unesc(v):
    v = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), v)
    return v.replace("\\'", "'").replace('\\"', '"')

def table(path):
    s = open(path, encoding='utf-8').read()
    return {k: unesc(v) for k, v in
            re.findall(r"^\s*'([a-z0-9_]+)'\s*:\s*'((?:[^'\\]|\\.)*)'", s, re.M)}

en = table('assets/lang/en.js')
DELIMS = ['(', ')', '"', '{', '}']
bad = []
for fn in sorted(os.listdir('assets/lang')):
    if not fn.endswith('.js') or fn == 'en.js':
        continue
    code = fn[:-3]
    t = table('assets/lang/' + fn)
    for k, ev in en.items():
        tv = t.get(k)
        if tv is None:
            continue          # missing keys are reported by the parity check
        for d in DELIMS:
            if ev.count(d) != tv.count(d):
                bad.append((code, k, d, ev.count(d), tv.count(d), tv[:44]))
                break
if bad:
    print("lang-check: delimiter count differs from en.js "
          "(these strings are concatenated with code — a changed bracket/quote breaks the sentence):")
    for code, k, d, en_n, tr_n, sample in bad[:40]:
        print("    %-3s %-38s '%s' en=%d translated=%d   %s"
              % (code, k, d, en_n, tr_n, sample))
    if len(bad) > 40:
        print("    ... and %d more" % (len(bad) - 40))
    sys.exit(1)

# Counting alone is not enough: moving a delimiter keeps the count identical.
# The real 453 Turkish bug was 'no_results_for' rendered as '"...yok' instead of
# '...yok: "' — one quote either way, but the code does T(key) + term + '"', so
# the quote MUST be at the end. For every English value that ends with an open
# delimiter or a trailing space (i.e. the code appends to it), require the
# translation to end the same way.
tail_keys = {}
for k, v in en.items():
    if v and (v[-1] in '(" ' or v.endswith(': ')):
        tail_keys[k] = v[-1]
shape = []
for fn in sorted(os.listdir('assets/lang')):
    if not fn.endswith('.js') or fn == 'en.js':
        continue
    code = fn[:-3]
    t = table('assets/lang/' + fn)
    for k, ch in tail_keys.items():
        tv = t.get(k)
        if tv is None:
            continue
        if not tv or tv[-1] != ch:
            shape.append((code, k, ch, tv[-24:] if tv else '(empty)'))
if shape:
    print("lang-check: string does not END the way en.js does "
          "(the app appends text straight after these — the trailing character must match):")
    for code, k, ch, sample in shape[:40]:
        print("    %-3s %-38s must end with %r   got: ...%s"
              % (code, k, ch, sample))
    if len(shape) > 40:
        print("    ... and %d more" % (len(shape) - 40))
    sys.exit(1)
PY
if [ $? -ne 0 ]; then status=1; fi

if [ "$status" -eq 0 ]; then
  echo "lang-check: clean (all tables complete and consistent with en.js)"
else
  echo ""
  echo "lang-check: FAILED"
fi
exit $status
