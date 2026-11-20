#!/usr/bin/env python3
# css-dupcheck.py - MANDATORY pre-package gate.
#
# Fails if any CSS file heads two separate rule blocks with the same selector.
# Two blocks for one selector is how a later declaration silently overrides an
# earlier one (iptv-claude421/423: a leftover width:auto beat a new fixed width;
# and iptv-claude556: .onboard-title / .pair-code / .mgr-check were each emitted
# twice in the generated tv-720.css - once by the font pass, once by an explicit
# override - which the OLD shell gate missed because it only matched selectors
# whose "{" sat on the SAME line, while the generated sheet puts the "{" on the
# next line).
#
# This rewrite is robust to:
#   - multi-line selectors (selector prelude on one or more lines, then "{"),
#   - comma-separated selector lists (each member counted individually),
#   - both "sel {" and "sel\n{" formatting.
#
# A selector that appears as a member of a grouped list AND as its own block
# counts as a duplicate (that is exactly the 556 case: .onboard-title grouped in
# the font pass and standalone in the override).
#
# Usage:  python3 tools/css-dupcheck.py     (exit 0 clean, 1 duplicates)
#
# ALLOWLIST: selectors intentionally duplicated. Keep tiny, justify each.
#   .player-stage video -> two distinct render contexts, documented DO-NOT-MERGE.
#   html[data-vp="mobile"] (mobile.css) -> deliberate split, zero property
#     overlap: the standalone block (line ~49) sets CSS custom properties
#     (--ui-scale/--m-*), which cascade to descendants automatically; the
#     comma-grouped block (line ~62, paired with html[data-vp="mobile"] body)
#     sets physical layout properties (width/height/margin/overflow/
#     background), which do NOT inherit and so need an explicit body rule
#     too. Merging would force body to redundantly restate custom properties
#     it already inherits — strictly worse than the current split, not safer.
import glob
import re
import sys

ALLOW = set([
    '.player-stage video',
    'html[data-vp="mobile"]',
])


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def rule_selectors(css):
    """Yield each individual selector that heads a rule block (top-level only)."""
    css = strip_comments(css)
    i = 0
    n = len(css)
    depth = 0
    buf = []
    while i < n:
        c = css[i]
        if c == '{':
            if depth == 0:
                prelude = ''.join(buf).strip()
                buf = []
                # skip at-rules (@media/@keyframes/@supports/@font-face)
                if prelude and not prelude.startswith('@'):
                    for member in prelude.split(','):
                        m = re.sub(r'\s+', ' ', member.strip())
                        if m:
                            yield m
                # enter block body; consume until matching close, tracking nesting
                depth = 1
                i += 1
                while i < n and depth > 0:
                    if css[i] == '{':
                        depth += 1
                    elif css[i] == '}':
                        depth -= 1
                    i += 1
                continue
            # (won't reach here with depth tracking above)
        else:
            buf.append(c)
        i += 1


def main():
    total = 0
    per_file = {}
    for path in sorted(glob.glob('assets/css/*.css')):
        seen = {}
        for sel in rule_selectors(open(path, encoding='utf-8').read()):
            if sel in ALLOW:
                continue
            seen[sel] = seen.get(sel, 0) + 1
        dups = sorted(s for s, cnt in seen.items() if cnt > 1)
        if dups:
            per_file[path] = [(d, seen[d]) for d in dups]
            total += len(dups)

    # Ratchet: many long-standing duplicates are intentional (CSS reset element
    # lists; a selector that heads its own block AND is a member of a later grouped
    # rule). Freezing the known SET catches a NEW accidental duplicate (the 556
    # case: a selector emitted twice as two standalone blocks) and reports only
    # what's new. Same convention as css-redundant / css-group.
    import json
    import os
    BASELINE = 'tools/css-dupcheck-baseline.json'
    current = sorted('%s|%s' % (path, d)
                     for path, dups in per_file.items() for d, _ in dups)
    if '--update' in sys.argv:
        json.dump({'dups': current}, open(BASELINE, 'w'), indent=2)
        print('css-dupcheck: baseline updated (%d known duplicates)' % len(current))
        sys.exit(0)
    if not os.path.exists(BASELINE):
        print('css-dupcheck: no baseline yet - run with --update to create it.')
        sys.exit(0)
    known = set(json.load(open(BASELINE)).get('dups', []))
    new = [c for c in current if c not in known]
    if new:
        print('css-dupcheck: FAILED - %d new duplicate selector(s):' % len(new))
        for c in new:
            path, sel = c.split('|', 1)
            print('    %s: %s' % (path, sel))
        print('    A selector now heads two rule blocks; the later silently')
        print('    overrides the earlier. Merge them into ONE block (or, if')
        print('    genuinely intentional, re-baseline with --update).')
        sys.exit(1)
    gone = len(known) - len([c for c in current if c in known])
    if gone > 0:
        print('css-dupcheck: %d fewer duplicate(s) (run --update to lock it in)' % gone)
    else:
        print('css-dupcheck: clean (%d known duplicates, none new)' % len(known))
    sys.exit(0)


if __name__ == '__main__':
    main()
