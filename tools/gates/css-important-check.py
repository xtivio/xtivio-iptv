#!/usr/bin/env python3
# css-important-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude479):
# "Grep before adding a rule; if something is not applying, find out WHY instead
# of adding !important" has been a written rule in PROCESS.md for a long time.
# It kept being broken anyway - including by the very session that was cleaning
# up !important sprawl, which added a 9-declaration all-!important block to
# override another all-!important block that did not need to be !important
# either. A rule nobody can accidentally violate beats a rule everybody agrees
# with, so this makes it mechanical.
#
# The check is a RATCHET, not a ban. It counts !important declarations per file
# and fails if any file exceeds its recorded baseline. Existing debt is
# tolerated; NEW debt is not. Fix something and lower the number, and the gate
# holds the new lower line - the counts can only go down.
#
# WHEN THIS GATE FAILS, the fix is almost never "raise the baseline". Work
# through this first:
#   1. What exactly is your rule losing to? Find it: grep the selector AND the
#      property across assets/css/*.css.
#   2. Does your selector have LOWER specificity than the winner? Then make it
#      more specific - that is what specificity is for. `.pin-keypad .btn`
#      (0,2,0) beats `.btn` (0,1,0) with no !important at all.
#   3. Same specificity? Later in the load order wins (reset -> fonts -> main ->
#      components -> screens -> player -> tv-scale -> rtl). Moving the rule, or
#      putting it later in the same file, is enough.
#   4. Is the rule you are fighting itself a needless !important? Remove THAT
#      one instead - one chain in 479 was six !importants deep for no reason.
#   5. Only if a UA stylesheet or an external engine quirk is the opponent is
#      !important the right tool (see `.player-stage video` in player.css, which
#      documents exactly that case).
#
# Usage:  python3 tools/css-important-check.py
#         python3 tools/css-important-check.py --update   (re-baseline DOWNWARD
#                                                          after a cleanup)
# Exit 0 = clean, exit 1 = a file gained !important declarations.

import re, sys, os, json

CSS_DIR = 'assets/css'
BASELINE = 'tools/css-important-baseline.json'


def count(path):
    """Count !important declarations, ignoring commented-out code."""
    s = re.sub(r'/\*.*?\*/', '', open(path, encoding='utf-8').read(), flags=re.S)
    return s.count('!important')


counts = {}
for f in sorted(os.listdir(CSS_DIR)):
    if f.endswith('.css'):
        counts[f] = count(os.path.join(CSS_DIR, f))

if '--update' in sys.argv:
    old = {}
    if os.path.exists(BASELINE):
        old = json.load(open(BASELINE))
    raised = [f for f in counts if f in old and counts[f] > old[f]]
    if raised:
        print('REFUSING to update: these files would go UP, which is what the')
        print('gate exists to prevent. Fix the rule instead of re-baselining:')
        for f in raised:
            print('    %-16s %d -> %d' % (f, old[f], counts[f]))
        sys.exit(1)
    json.dump(counts, open(BASELINE, 'w'), indent=2, sort_keys=True)
    print('css-important-check: baseline updated (total %d)' % sum(counts.values()))
    sys.exit(0)

if not os.path.exists(BASELINE):
    print('css-important-check: no baseline yet — run with --update to create it.')
    sys.exit(1)

base = json.load(open(BASELINE))
status = 0
for f in sorted(counts):
    now = counts[f]
    was = base.get(f)
    if was is None:
        if now > 0:
            status = 1
            print('NEW FILE with !important: %s has %d' % (f, now))
            print('    Add it to the baseline only if every one is justified.')
            print('')
        continue
    if now > was:
        status = 1
        print('!important INCREASED: %s   %d -> %d  (+%d)' % (f, was, now, now - was))
        print('    Read the checklist at the top of this script before')
        print('    considering a re-baseline. Specificity or load order almost')
        print('    always solves it.')
        print('')

lowered = [(f, base[f], counts[f]) for f in counts
           if f in base and counts[f] < base[f]]
if lowered and status == 0:
    print('Reduced since the baseline (run --update to lock the new lower line):')
    for f, was, now in lowered:
        print('    %-16s %d -> %d' % (f, was, now))
    print('')

if status == 0:
    print('css-important-check: clean (total %d, baseline %d)'
          % (sum(counts.values()), sum(base.values())))
else:
    print('css-important-check: FAILED - see above.')
sys.exit(status)
