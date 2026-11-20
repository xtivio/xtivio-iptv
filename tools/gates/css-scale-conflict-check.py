#!/usr/bin/env python3
# css-scale-conflict-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude466):
# tv-scale.css loads LAST and uses !important on nearly every declaration, so it
# beats the base stylesheets unconditionally. That is fine for font-size (its
# actual job: --ui-scale is the user's Text Size setting). It is NOT fine when it
# pins a fixed `height`/`width` on an element whose BASE rule deliberately chose
# to grow with its content (min-height, or height:auto).
#
# That exact conflict has now shipped three separate bugs:
#   - .panel-ch-head        base min-height:96px  <- tv-scale height:96px*scale
#                           => Movies/Series content header clipped at the top
#   - .sidebar.expanded     base min-height:50px + height:auto
#     .nav-btn              <- tv-scale height:68px*scale
#                           => Greek 2-line label spilled past the focus
#                              highlight; German at XL ran past it horizontally
# In BOTH cases the base rule carried a comment explaining the wrap problem it
# was written to prevent, and tv-scale silently undid it.
#
# The check is deliberately NARROW. It does NOT flag every fixed height in
# tv-scale: plenty are legitimate (.btn/.field/.tab/.chip are fixed-height,
# white-space:nowrap components by design, and scaling their height is correct).
# It flags only the CONFLICT: tv-scale pinning `height`/`width` on a selector
# whose base rule opted into content-sizing. That keeps the signal high and the
# allowlist near-empty.
#
# Usage:  python3 tools/css-scale-conflict-check.py
# Exit 0 = clean, exit 1 = a scale override contradicts a base content-sizing rule.

import re, sys, os

BASE_FILES = ['assets/css/reset.css', 'assets/css/main.css',
              'assets/css/components.css', 'assets/css/screens.css',
              'assets/css/player.css']
SCALE_FILE = 'assets/css/tv-scale.css'

# Selectors where a fixed scaled dimension is intentional despite a
# content-sizing base rule. Keep this EMPTY if possible; each entry needs a
# written reason.
ALLOW = {
    # Empty. '.ch-card' lived here because its base rule said min-height +
    # height:auto while its own comment deferred to tv-scale's fixed height —
    # the two files disagreed in writing. The 481 flattening brought both into
    # one rule in screens.css and the contradiction was resolved there (fixed
    # scaled height, deliberate for uniform grid tiles), so the exception is no
    # longer needed. Keep this empty if at all possible.
}


def key_sel(sel):
    """Reduce a compound selector to the element it actually targets.

    The conflicts this gate looks for live on selectors that are written
    DIFFERENTLY in the two files but resolve to the same element:
        base  '.sidebar.expanded .nav-btn'   vs  scale '.nav-btn'
        base  '.panel-ch-head'               vs  scale '[data-section-content="movies"] .panel-ch-head'
    Matching whole selector strings misses both (verified: it ran clean on the
    shipped 464 tree that contained both bugs). So compare on the rightmost
    simple selector - the key selector - and drop pseudo-classes/elements.
    """
    part = sel.strip().split()[-1] if sel.strip() else sel
    part = part.split('::')[0]
    part = re.sub(r':(hover|focus|active|visited|first-child|last-child|nth-child\([^)]*\))', '', part)
    return part.strip()


def rules(path):
    """Yield (selector, body) for each rule block in a stylesheet."""
    if not os.path.exists(path):
        return
    src = open(path, encoding='utf-8').read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', src):
        sel = m.group(1).strip().replace('\n', ' ')
        sel = re.sub(r'\s+', ' ', sel)
        if sel.startswith('@'):
            continue
        yield sel, m.group(2)


def decls(body):
    out = {}
    for d in body.split(';'):
        if ':' not in d:
            continue
        p, v = d.split(':', 1)
        out.setdefault(p.strip().lower(), []).append(v.strip().lower())
    return out


# 1. Collect selectors whose BASE rule opts into content sizing.
content_sized = {}   # selector -> reason string
for f in BASE_FILES:
    for sel, body in rules(f):
        d = decls(body)
        why = []
        if 'min-height' in d:
            why.append('min-height:' + d['min-height'][-1])
        if 'height' in d and any(v == 'auto' for v in d['height']):
            why.append('height:auto')
        if 'min-width' in d:
            why.append('min-width:' + d['min-width'][-1])
        if why:
            # Index by KEY selector so a base rule written as a compound
            # ('.sidebar.expanded .nav-btn') still matches a scale rule written
            # bare ('.nav-btn'). Split on commas: a grouped selector opts in for
            # each of its parts.
            for part in [p.strip() for p in sel.split(',')]:
                k = key_sel(part)
                if k:
                    content_sized[k] = f + ' (' + part + ': ' + ', '.join(why) + ')'

# 2. Flag tv-scale rules that pin a fixed dimension on those selectors.
status = 0
for sel, body in rules(SCALE_FILE):
    d = decls(body)
    for prop in ('height', 'width'):
        if prop not in d:
            continue
        vals = [v for v in d[prop] if v.replace('!important', '').strip() != 'auto']
        if not vals:
            continue
        for part in [s.strip() for s in sel.split(',')]:
            k = key_sel(part)
            if k in ALLOW or part in ALLOW:
                continue
            if k in content_sized:
                status = 1
                print('SCALE CONFLICT in %s:' % SCALE_FILE)
                print("    '%s' pins %s: %s" % (part, prop, vals[-1]))
                print('    but the base rule opts into content sizing: %s'
                      % content_sized[k])
                print('    -> use min-%s here, or the base rule cannot grow and'
                      ' localised / wrapped text will be clipped.' % prop)
                print('')

if status == 0:
    print('css-scale-conflict-check: clean (no scale override contradicts a '
          'content-sizing base rule)')
else:
    print('css-scale-conflict-check: FAILED - see above. tv-scale.css loads last '
          'with !important, so a fixed height/width there silently defeats a base '
          'min-height/height:auto.')
sys.exit(status)
