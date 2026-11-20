#!/usr/bin/env python3
# css-redundant-report.py - REPORT (not a gate). Lists declarations where a
# more-specific selector repeats the SAME value the base rule already gives that
# element for that property. e.g. .live-epg-ch .media-fav sets color:var(--warn)
# which .media-fav already sets.
#
# UNLIKE the !important sweep, removing these is NOT mechanically safe:
#   - Some are pure duplicates (safe to delete).
#   - Some are INTENTIONAL restatements that pin a value against future base
#     changes, e.g. .sidebar.expanded .nav-btn min-height, which MUST equal the
#     collapsed .nav-btn floor (that equality is the 491 sidebar fix). Deleting it
#     because "it matches the base today" reintroduces the bug the moment the base
#     changes.
# So this is a REVIEW aid, not an auto-fix. A declaration here is worth removing
# ONLY if the match is coincidental, not a deliberate "keep these equal" link.
# When unsure, leave it — the cost is a duplicate line; the cost of wrongly
# removing an intentional pin is a regression.
import re, os

FILES = ['reset', 'main', 'components', 'screens', 'player', 'tv-scale', 'rtl']


def spec(sel):
    s = re.sub(r'\[[^\]]*\]', '[]', sel)
    return (s.count('#'),
            len(re.findall(r'\.[\w-]+|\[\]|:(?!:)', s)),
            len(re.findall(r'(?:^|[\s>+~])[a-z]+', s)))


def rules(f):
    s = re.sub(r'/\*.*?\*/', '', open('assets/css/%s.css' % f, encoding='utf-8').read(), flags=re.S)
    out, pos, n = [], 0, len(s)
    while pos < n:
        m = re.compile(r'([^{}]+)\{').match(s, pos)
        if not m:
            pos += 1
            continue
        sel = re.sub(r'\s+', ' ', m.group(1).strip())
        st = m.end()
        d, j = 1, st
        while j < n and d > 0:
            if s[j] == '{':
                d += 1
            elif s[j] == '}':
                d -= 1
            j += 1
        if not sel.startswith('@'):
            out.append((sel, s[st:j - 1]))
        pos = j
    return out


base = {}
alld = []
for f in FILES:
    for sel, body in rules(f):
        for part in [x.strip() for x in sel.split(',')]:
            last = re.split(r'\s|>|\+|~', part.strip())[-1]
            classes = frozenset(re.findall(r'\.([\w-]+)', last))
            hasnon = bool(re.sub(r'\.[\w-]+', '', last).strip())
            if hasnon or not classes:
                continue
            for d in body.split(';'):
                if ':' not in d:
                    continue
                p, v = d.split(':', 1)
                p = p.strip().lower()
                if not p or p.startswith('--'):
                    continue
                val = re.sub(r'\s+', ' ', v.replace('!important', '').strip())
                sp = spec(part)
                alld.append((part, classes, p, val, sp))
                k = (classes, p)
                if k not in base or sp < base[k][0]:
                    base[k] = (sp, val)

seen = set()
rows = []
for part, classes, p, val, sp in alld:
    b = base[(classes, p)]
    if sp > b[0] and val == b[1]:
        key = (part, p)
        if key in seen:
            continue
        seen.add(key)
        rows.append((part, p, val))

from collections import defaultdict
bysel = defaultdict(list)
for part, p, val in rows:
    bysel[part].append(p)

print('Declarations repeating the base value at higher specificity: %d across %d selectors\n'
      % (len(rows), len(bysel)))
for part, props in sorted(bysel.items(), key=lambda x: -len(x[1])):
    print('  %-46s %s' % (part[:46], ', '.join(props)))
print('\nNOT auto-removable. Each is either a pure duplicate (safe to delete) or an')
print('INTENTIONAL restatement pinning a value equal to the base (deleting it')
print('reintroduces a bug when the base later changes — e.g.')
print('.sidebar.expanded .nav-btn min-height, the 491 sidebar fix). Review case by')
print('case; when unsure, leave it.')
print('')

# ---- RATCHET GATE (added iptv-claude537) --------------------------------------
# This started as a report; it is now also a gate. It freezes the count of
# higher-specificity declarations that merely restate the base value, and FAILS
# if the count rises — i.e. a new redundant specificity override was introduced.
# Existing entries are grandfathered (some are intentional value-pins). The fix
# when this fails is almost never "raise the baseline": either fold the value into
# the base and delete the override, or if it is a deliberate pin, re-baseline with
#   python3 tools/css-redundant-report.py --update
import json, sys
BASELINE = 'tools/css-redundant-baseline.json'
now = len(rows)
if '--update' in sys.argv:
    json.dump({'count': now}, open(BASELINE, 'w'), indent=2)
    print('css-redundant-check: baseline updated (count %d)' % now)
    sys.exit(0)
if not os.path.exists(BASELINE):
    print('css-redundant-check: no baseline yet — run with --update to create it.')
    sys.exit(0)
was = json.load(open(BASELINE)).get('count', 0)
if now > was:
    print('css-redundant-check: FAILED — redundant specificity overrides %d -> %d (+%d)'
          % (was, now, now - was))
    print('    A more-specific rule now restates a value the base already provides.')
    print('    Fold it into the base and delete the override, or (if a deliberate')
    print('    pin) re-baseline with --update.')
    sys.exit(1)
if now < was:
    print('css-redundant-check: reduced %d -> %d (run --update to lock the lower line)'
          % (was, now))
else:
    print('css-redundant-check: clean (count %d, baseline %d)' % (now, was))
sys.exit(0)
