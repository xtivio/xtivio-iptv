#!/usr/bin/env python3
# css-scale-fontsize-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude467):
# tv-scale.css loads LAST with !important, so whatever font-size it declares is
# what ships. That created two failure modes, both of which cost real debugging
# time before anyone noticed the second file existed:
#
#   1. CONFLICT - tv-scale declares a DIFFERENT size from the base rule. The base
#      stylesheet then lies about what ships. Ten of these existed at 467:
#      .panel-ch-title read 28px in screens.css but rendered at 26px, while two
#      patches were spent debugging that very header.
#   2. POINTLESS DUPLICATE - tv-scale restates the SAME px value the base rule
#      already has, purely to multiply it by --ui-scale. 104 of these existed at
#      467. Individually harmless, but they are why nobody can tell at a glance
#      which file owns a size, which is what lets (1) hide.
#
# The permanent fix for both is the same: a rule declares its own size ONCE, in
# its own stylesheet, expressed as calc(Npx * var(--ui-scale, 1)). --ui-scale is
# defined at :root and custom properties resolve at USE time, so a base sheet can
# reference it even though tv-scale loads later. 27 base rules already did this
# before 467; the migration makes it the norm.
#
# This gate therefore fails on ANY font-size in tv-scale.css that also has a
# top-level base rule - whether the values agree or not. Media-query rules are
# excluded on BOTH sides: a responsive override at 720p is legitimate and is not
# a duplicate (an earlier version of this analysis wrongly flagged six of those
# and would have broken the 720p layout).
#
# Selectors whose ONLY font-size lives in tv-scale are allowed - deleting those
# would leave the element with no size at all. They are listed in SCALE_OWNED so
# the set stays visible and cannot grow silently.
#
# Usage:  python3 tools/css-scale-fontsize-check.py
# Exit 0 = clean, exit 1 = a font-size is declared in two places.

import re, sys, os

BASE_FILES = ['assets/css/reset.css', 'assets/css/main.css',
              'assets/css/components.css', 'assets/css/screens.css',
              'assets/css/player.css']
SCALE_FILE = 'assets/css/tv-scale.css'

# Selectors with no base font-size rule: tv-scale is the sole owner, so its
# declaration must stay. Shrink this list by moving each into its own stylesheet;
# do NOT add to it without a reason.
SCALE_OWNED = {
    '.btn.danger', '.btn.ghost', '.cat-filter', '.cat-mgr-col-head',
    '.content-lock-btn', '.content-lock-row', '.epg-page-info',
    '.manual-ct-label', '.nav-btn', '.nav-btn .nav-ic', '.nav-btn .nav-lbl',
    '.pass-reveal-toggle', '.setting-ctl .btn.danger', '.setting-ctl .mono',
    '.sub4-syncintro',
}


# The 467 cleanup fixed all 10 CONFLICTS immediately. The ~107 DUPLICATES are
# being migrated over several patches (one screen-area at a time, per the
# don't-do-a-big-bang-CSS-sweep rule). So the gate must fail on NEW duplication
# while tolerating the known backlog - otherwise it cannot be mandatory until
# the cleanup finishes, which is exactly when it stops being useful.
#
# tools/css-scale-fontsize-baseline.txt lists the selectors still awaiting
# migration. The gate fails if a selector appears that is NOT in the baseline,
# and also fails if the baseline lists something already fixed (so it shrinks
# and cannot rot). Delete lines from it as each area is migrated.
BASELINE = 'tools/css-scale-fontsize-baseline.txt'


def load_baseline():
    if not os.path.exists(BASELINE):
        return set()
    out = set()
    for line in open(BASELINE, encoding='utf-8'):
        line = line.split('#')[0].strip()
        if line:
            out.add(line)
    return out


def toplevel_rules(path):
    """Yield (selector, body) for rules NOT nested inside an @media/@supports.

    Rules inside at-rules are deliberate responsive overrides and are excluded
    from this check on both sides.
    """
    if not os.path.exists(path):
        return []
    s = re.sub(r'/\*.*?\*/', '', open(path, encoding='utf-8').read(), flags=re.S)
    out, pos, n = [], 0, len(s)
    while pos < n:
        m = re.compile(r'([^{}]+)\{').match(s, pos)
        if not m:
            pos += 1
            continue
        sel = re.sub(r'\s+', ' ', m.group(1).strip())
        start = m.end()
        depth, j = 1, start
        while j < n and depth > 0:
            if s[j] == '{':
                depth += 1
            elif s[j] == '}':
                depth -= 1
            j += 1
        if not sel.startswith('@'):
            out.append((sel, s[start:j - 1]))
        pos = j
    return out


def font_size(body):
    v = None
    for d in body.split(';'):
        if ':' in d:
            p, val = d.split(':', 1)
            if p.strip().lower() == 'font-size':
                v = val.strip()
    return v


def px(v):
    v = v.replace('!important', '').strip()
    m = re.match(r'calc\((\d+)px\s*\*\s*var\(--ui-scale[,\s]*1?\)\)', v)
    if m:
        return m.group(1)
    return v[:-2] if v.endswith('px') else None


base = {}
for f in BASE_FILES:
    for sel, body in toplevel_rules(f):
        v = font_size(body)
        if v:
            for part in [x.strip() for x in sel.split(',')]:
                base[part] = (px(v), f)

baseline = load_baseline()
status = 0
seen = set()
backlog = 0
for sel, body in toplevel_rules(SCALE_FILE):
    v = font_size(body)
    if not v:
        continue
    sv = px(v)
    for part in [x.strip() for x in sel.split(',')]:
        if part in SCALE_OWNED or part not in base:
            continue
        bv, bf = base[part]
        seen.add(part)
        kind = 'CONFLICT' if (bv and sv and bv != sv) else 'DUPLICATE'
        # A CONFLICT is never tolerated - the base sheet is actively wrong.
        # A DUPLICATE already on the baseline is known migration backlog.
        if kind == 'DUPLICATE' and part in baseline:
            backlog += 1
            continue
        status = 1
        print('%s: %s' % (kind, part))
        print('    %s declares font-size %spx' % (os.path.basename(bf), bv))
        print('    %s declares font-size %spx (this one ships: loads last, !important)'
              % (os.path.basename(SCALE_FILE), sv))
        if kind == 'CONFLICT':
            print('    -> the base stylesheet is lying about what renders.')
        print('    -> declare it ONCE in %s as calc(%spx * var(--ui-scale, 1))'
              ' and delete the tv-scale line.'
              % (os.path.basename(bf), sv or bv))
        print('')

stale = sorted(baseline - seen)
if stale:
    status = 1
    print('STALE BASELINE ENTRIES (already fixed - delete these lines from %s):'
          % BASELINE)
    for s in stale:
        print('    ' + s)
    print('')

if status == 0:
    print('css-scale-fontsize-check: clean (no new font-size duplication; %d '
          'known duplicates still awaiting migration)' % backlog)
else:
    print('css-scale-fontsize-check: FAILED - see above.')
sys.exit(status)
