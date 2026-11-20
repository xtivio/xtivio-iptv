#!/usr/bin/env python3
# css-paired-invariants-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude477):
# Several elements in this UI sit SIDE BY SIDE and must render identically, or a
# few pixels of difference show up as a visible misalignment. Until now those
# invariants were recorded only in PROSE COMMENTS ("MUST match .panel-cat-head's
# line-height", "keep in lockstep with .panel-search"). A comment cannot fail a
# build, and one of them silently broke:
#
#   .panel-cat-head had line-height 1.15 (added in 465) while .panel-ch-title
#   had 1.25. Both render at 28px on Movies/Series, so their line boxes were
#   28x1.15=32.2px and 28x1.25=35px. That 2.8px made the two headers compute to
#   118.2px and 121px, and every layer below inherited the offset - which is what
#   was seen as the filter/search box misalignment.
#
# It took three patches to find (472 equalised the boxes, 473 removed a dead span
# that was a second real cause, 476 found this) because reading CSS shows you
# plausible causes, not the actual one. This gate makes the invariant executable:
# declare the pairs, assert the properties resolve identically across all five
# stylesheets in load order honouring !important.
#
# Adding a pair costs one line. If two things must look the same, put them here
# INSTEAD of writing a comment saying so.
#
# Usage:  python3 tools/css-paired-invariants-check.py
# Exit 0 = clean, exit 1 = a declared pair has diverged.

import re, sys, os

FILES = ['assets/css/main.css', 'assets/css/components.css',
         'assets/css/screens.css', 'assets/css/player.css',
         'assets/css/tv-scale.css', 'assets/css/tv-720.css']   # load order matters: later wins

# (selector A, selector B, property, why they must match)
PAIRS = [
    # Catch-up: the day-tab rows on the right marry up with Filter and Sort on the left
    # (row 1 = Filter, row 2 = Sort), so heights and the row gap must be identical.
    ('.cu-filter', '.cu-sort', 'height',
     'Catch-up Filter and Sort are stacked; the two day-tab rows beside them only line up if both are the same height.'),
    ('.cu-filter', '.cu-daytabs > .btn', 'height',
     'Catch-up day-tab rows must be as tall as the Filter box so row 1 lines up with it.'),
    ('.cu-sort', '.cu-daytabs > .btn', 'height',
     'Catch-up day-tab row 2 must be as tall as the Sort button.'),
    ('.cu-sort', '.cu-daytabs > .btn', 'min-height',
     'Neither may grow past the shared height (min-height 0 on both).'),
    ('.cu-sort', '.cu-daytabs > .btn', 'box-sizing',
     'Same box model so equal heights are equal on screen.'),
    ('.panel-cat-head', '.panel-ch-title', 'line-height',
     'Movies/Series headers sit side by side; both render at 28px, so a different '
     'line-height makes one header taller and pushes its search box down.'),

    # Header TEXT size must match across all three 3-column screens: the
    # Categories header (.panel-cat-head, left column on Live/Movies/Series), the
    # Movies/Series content header (.panel-ch-title), and the Live TV channels
    # header (.live-channels-label). 573 raised .live-channels-label 26->28 to end
    # a long-standing mismatch where Live's "Channels" header was visibly smaller
    # than the "Categories" header beside it and than the Movies/Series content
    # header. These pin the font-size equal so it can't silently drift again.
    ('.panel-cat-head', '.live-channels-label', 'font-size',
     'Categories header (left) and Live TV Channels header (middle) are side by '
     'side on the Live screen; different sizes read as an inconsistent header row.'),
    ('.panel-ch-title', '.live-channels-label', 'font-size',
     'Movies/Series content header and Live TV Channels header are the middle-'
     'column header on their respective screens; they must match across screens.'),
    ('.panel-cat-head', '.panel-ch-title', 'font-size',
     'Categories header and Movies/Series content header sit side by side; equal '
     'size keeps the header row uniform.'),

    # Live TV: the channels header (.live-channels-label) sits directly above the
    # channel column (.live-epg-ch); their right borders must line up, so their
    # widths must be equal (both calc(480px * --ui-scale) since 576). Kept in sync
    # by comments before — now enforced, since widening one and not the other
    # misaligns the header divider from the column edge.
    ('.live-channels-label', '.live-epg-ch', 'width',
     'The channels header sits above the channel column; equal width keeps the '
     "header's right border aligned with the column edge below."),
    ('.live-channels-label', '.live-epg-ch', 'min-width',
     'Same header/column pair; min-width must match so neither can shrink out of '
     'alignment.'),
    ('.live-channels-label', '.live-epg-ch', 'max-width',
     'Same header/column pair; max-width must match so neither can grow out of '
     'alignment.'),

    ('.panel-search', '.panel-cat-search', 'height',
     'The two search/filter container rows are side by side.'),
    ('.panel-search', '.panel-cat-search', 'padding',
     'Same rows - padding difference shifts the input inside them.'),

    ('.panel-search .field', '.panel-cat-search .cat-filter', 'height',
     'The two input boxes are side by side; any height difference is visible.'),
    ('.panel-search .field', '.panel-cat-search .cat-filter', 'padding',
     'Same inputs - padding affects the text baseline.'),
    ('.panel-search .field', '.panel-cat-search .cat-filter', 'font-size',
     'Same inputs - font-size affects both the text and the line box.'),
    ('.panel-search .field', '.panel-cat-search .cat-filter', 'border',
     'Same inputs - border width changes the border-box height.'),

    # NOTE these compare the tv-scale [data-section-content] selectors, not the
    # bare base rules. On Movies/Series BOTH headers are raised to the same
    # scaled 96px floor by that override, so comparing '.panel-cat-head' (base
    # 72px) against '.panel-ch-head' (base 96px) is a false positive - the base
    # 72px never applies on these screens. Compare what actually wins.
    ('[data-section-content="movies"] .panel-cat-head',
     '[data-section-content="movies"] .panel-ch-head', 'min-height',
     'The two Movies headers must share a floor, or the shorter one lets its '
     'column start higher.'),
    ('[data-section-content="series"] .panel-cat-head',
     '[data-section-content="series"] .panel-ch-head', 'min-height',
     'The two Series headers must share a floor, or the shorter one lets its '
     'column start higher.'),
    ('.panel-cat-head', '.panel-ch-head', 'padding',
     'Same headers - padding contributes directly to computed height.'),

    # Category-manager ORDER column and the filter-bar's order SPACER must be the
    # same width, or the VISIBLE/LOCKED filter buttons in the header row drift out
    # of alignment with the checkbox columns in the data rows below. This drifted
    # in 693 (order column widened to 240 but the spacer left at 172) and was fixed
    # in 694; pinned here so widening one without the other fails the build.
    ('.cat-mgr-row .cat-mgr-order-box', '.cat-mgr-filterbar .cat-mgr-filter-order-spacer', 'width',
     'The reorder column (data rows) sits below the order spacer (filter bar); '
     'equal width keeps the VISIBLE/LOCKED filter buttons over their columns.'),
    ('.cat-mgr-row .cat-mgr-order-box', '.cat-mgr-filterbar .cat-mgr-filter-order-spacer', 'min-width',
     'Same column/spacer pair; min-width must match so neither can shrink out of '
     'alignment.'),
    ('.cat-mgr-row .cat-mgr-order-box', '.cat-mgr-filterbar .cat-mgr-filter-order-spacer', 'flex',
     'Same column/spacer pair; the flex basis must match so both reserve the same '
     'track width in their row.'),
]


def rules(path):
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


# Cache parsed stylesheets once.
PARSED = [(f, rules(f)) for f in FILES]


def _resolve_one(form, prop):
    best, best_imp, where = None, False, None
    for f, rs in PARSED:
        for s, body in rs:
            if form not in [x.strip() for x in s.split(',')]:
                continue
            for d in body.split(';'):
                if ':' not in d:
                    continue
                p, v = d.split(':', 1)
                if p.strip().lower() != prop:
                    continue
                imp = '!important' in v
                if imp or not best_imp:
                    best = re.sub(r'\s+', ' ', v.replace('!important', '').strip())
                    best_imp = best_imp or imp
                    where = os.path.basename(f)
    return best, where


def resolve(sel, prop):
    """Resolve a property for a pair selector, honoring a bare last-class rule.

    For a compound selector like '.panel-cat-search .cat-filter', a standalone
    '.cat-filter { font-size }' cascades onto the same element and is a common
    desync source (a bare font rule collected separately from the compound
    TEXT_CONTROL partner). We compute the EFFECTIVE value: the bare last-class
    rule sets a baseline; the exact compound selector overrides it when present
    AND when it's at least as specific. Since compound (2 classes) > bare (1
    class) in specificity, the compound wins when it sets the property; the bare
    value only shows through when the compound is silent on that property -
    which is exactly the desync case (compound sets height/box, bare sets font).
    """
    exact, wx = _resolve_one(sel, prop)
    parts = sel.split()
    if len(parts) > 1:
        last = parts[-1]
        bare_form = ('html[data-vp="720"] ' + last
                     if sel.startswith('html[data-vp="720"] ') else last)
        bare, wb = _resolve_one(bare_form, prop)
        if exact is not None:
            return exact, wx
        if bare is not None:
            return bare, wb
        return None, None
    return exact, wx


status = 0
for a, b, prop, why in PAIRS:
    va, wa = resolve(a, prop)
    vb, wb = resolve(b, prop)
    if va is None and vb is None:
        pass                          # neither sets it: consistent by omission
    elif va == vb:
        pass
    else:
        status = 1
        print('PAIR DIVERGED: %s  vs  %s   [%s]' % (a, b, prop))
        print('    %-34s %s   (%s)' % (a, va if va is not None else '(unset -> initial)', wa or '-'))
        print('    %-34s %s   (%s)' % (b, vb if vb is not None else '(unset -> initial)', wb or '-'))
        print('    why they must match: %s' % why)
    # Also compare the 720-prefixed forms: the pair must stay in lockstep on the
    # 720 canvas too, where a generated override can desync them even when the
    # base is identical (the recurring live-filter/search height regression).
    pa = 'html[data-vp="720"] ' + a
    pb = 'html[data-vp="720"] ' + b
    va7, wa7 = resolve(pa, prop)
    vb7, wb7 = resolve(pb, prop)
    # Fall back to the base value for whichever side has no 720 override, since
    # that's what actually renders at 720.
    ea = va7 if va7 is not None else va
    eb = vb7 if vb7 is not None else vb
    if ea is None and eb is None:
        continue
    if ea == eb:
        continue
    status = 1
    print('PAIR DIVERGED @720: %s  vs  %s   [%s]' % (a, b, prop))
    print('    %-34s %s   (%s)' % (pa, ea if ea is not None else '(unset)', wa7 or wa or '-'))
    print('    %-34s %s   (%s)' % (pb, eb if eb is not None else '(unset)', wb7 or wb or '-'))
    print('    why they must match: %s' % why)
    print('')

if status == 0:
    print('css-paired-invariants-check: clean (%d declared pairs consistent)' % len(PAIRS))
else:
    print('css-paired-invariants-check: FAILED - see above. These elements sit '
          'side by side; a difference here is a visible misalignment.')
sys.exit(status)
