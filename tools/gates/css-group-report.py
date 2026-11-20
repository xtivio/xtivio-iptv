#!/usr/bin/env python3
# css-group-report.py - REPORT (not a gate). Flags grouped selectors whose members
# are DIFFERENT element types sharing a block only because they currently have the
# same values. Those are a maintenance hazard: changing the style of ONE member
# means splitting it out first, and editing the block in place silently changes
# the others.
#
# SIBLING groups (all members share a class root, e.g. .cat-mgr-visible-check +
# .cat-mgr-lock-check) are fine — they are meant to stay identical.
# MIXED groups (e.g. .vod-name + .panel-info .panel-ch-title) are the hazard.
#
# This does not fail the build. It is a map for whoever next edits a grouped rule:
# if your target is in a MIXED group, split it out before changing it.
import re, os

FILES = ['reset', 'main', 'components', 'screens', 'player', 'tv-scale', 'rtl']


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


def root(sel):
    last = re.split(r'\s|>|\+|~', sel.strip())[-1]
    cls = re.findall(r'\.([\w-]+)', last)
    if not cls:
        return sel.strip()[:16]
    # first two hyphen segments of the rightmost class = the "family"
    return '-'.join(cls[-1].split('-')[:2])


mixed = []
for f in FILES:
    if f in ('reset',):
        continue  # normalize/reset boilerplate is intentionally broad, not a hazard
    for sel, body in rules(f):
        parts = [x.strip() for x in sel.split(',')]
        if len(parts) < 2:
            continue
        # only class-based members are interesting (component styling, not tag resets)
        if not all('.' in p for p in parts):
            continue
        # strip pseudo-elements/classes and the shared-parent prefix: compare the
        # DISTINCT component the rule ultimately targets
        def target(p):
            last = re.split(r'\s|>|\+|~', p.strip())[-1]
            last = re.sub(r'::?[\w-]+', '', last)          # drop pseudos
            cls = re.findall(r'\.([\w-]+)', last)
            return cls[-1] if cls else last
        # shared ancestor? if every member has the SAME parent chain, a differing
        # final child (svg vs img, title vs time) is a fallback pair, not a hazard
        def parent(p):
            toks = re.split(r'\s|>|\+|~', p.strip())
            return ' '.join(toks[:-1])
        targets = set(target(p) for p in parts)
        parents = set(parent(p) for p in parts)
        if len(targets) > 1 and len(parents) > 1:
            # families = the two-hyphen root of each distinct target
            fams = sorted(set('-'.join(t.split('-')[:2]) for t in targets))
            if len(fams) > 1:
                mixed.append((f, sel, fams))

print('Grouped selectors whose members are DIFFERENT families (edit hazard): %d\n' % len(mixed))
for f, sel, roots in mixed:
    print('  [%s] %s' % (f, sel[:76]))
    print('        families: %s' % ', '.join(roots))
print('\nThese are NOT errors. But before changing the style of ONE member, split it')
print('into its own rule first, or you will silently restyle the others. Sibling')
print('groups (same family) are omitted — they are meant to move together.')
print('')

# ---- RATCHET GATE (added iptv-claude537) --------------------------------------
# Now also a gate. Freezes the count of grouped selectors that bundle DIFFERENT
# element families into one rule (the .check-toggle "two designs, one class" class
# of hazard). FAILS if the count rises. The fix when it fails: give the new member
# its own rule instead of grouping it, or re-baseline with --update if the grouping
# is genuinely safe (identical elements).
import json, sys, os
BASELINE = 'tools/css-group-baseline.json'
now = len(mixed)
if '--update' in sys.argv:
    json.dump({'count': now}, open(BASELINE, 'w'), indent=2)
    print('css-group-check: baseline updated (count %d)' % now)
    sys.exit(0)
if not os.path.exists(BASELINE):
    print('css-group-check: no baseline yet — run with --update to create it.')
    sys.exit(0)
was = json.load(open(BASELINE)).get('count', 0)
if now > was:
    print('css-group-check: FAILED — mixed-family grouped selectors %d -> %d (+%d)'
          % (was, now, now - was))
    print('    A rule now groups different element families. Give the new member')
    print('    its own rule, or re-baseline with --update if the grouping is safe.')
    sys.exit(1)
if now < was:
    print('css-group-check: reduced %d -> %d (run --update to lock the lower line)'
          % (was, now))
else:
    print('css-group-check: clean (count %d, baseline %d)' % (now, was))
sys.exit(0)
