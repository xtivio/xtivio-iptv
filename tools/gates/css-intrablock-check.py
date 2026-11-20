#!/usr/bin/env python3
# css-intrablock-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude464):
# css-dupcheck.py catches the same SELECTOR appearing in two separate rule
# blocks. It greps selector lines and never looks INSIDE a block, so it cannot
# see the same PROPERTY declared twice within ONE block. That is a real blind
# spot: iptv-claude463 shipped `.cat-manage-btn { ... margin-left: 0; ...
# margin-left: auto; }` - two margin-left declarations in one block, the later
# `auto` silently beating the intended `0` and pushing every Manage button to
# the right. Same failure SHAPE as the 421/423 bug dupcheck was built for (a
# stale later declaration overriding a newer earlier one), just intra-block
# instead of inter-block. dupcheck exited 0 on it. This gate closes that hole.
#
# It flags a property declared 2+ times with DIFFERING values inside one block.
# Identical repeats (harmless) are ignored. Known-legit fallback pairs (an old
# value then a newer one the engine may not understand, e.g.
# `display:-webkit-box; display:flex`) are ignored via FALLBACK_OK. Anything
# else is a genuine "which one wins?" ambiguity and must be resolved to a single
# declaration before packaging.
#
# Usage:  python3 tools/css-intrablock-check.py
# Exit 0 = clean, exit 1 = intra-block duplicate property with differing values.

import re, sys, glob

# property -> value-substrings that make a repeat a legitimate old/new fallback.
# Keep this SMALL and justify each entry; a repeat only passes if EVERY value
# matches one of these tokens (so two arbitrary different values never slip by).
FALLBACK_OK = {
    'display':    ('-webkit-', 'box', 'flex', 'grid', 'inline-block', 'block'),
    'background': ('var(', '#', 'rgb', 'linear-', 'url(', 'transparent'),
    'color':      ('var(', '#', 'rgb', 'transparent'),
    'width':      ('-webkit-', 'calc', 'fill-available', 'max-content', 'min-content'),
    'height':     ('-webkit-', 'calc', 'fill-available'),
    'position':   ('-webkit-', 'sticky'),
    # Meyer-reset blockquote/q pattern: content:''; then content:none;
    'content':    ("''", '""', 'none'),
}

status = 0
for path in sorted(glob.glob('assets/css/*.css')):
    src = open(path, encoding='utf-8').read()
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)   # strip comments
    for m in re.finditer(r'\{([^{}]*)\}', src):        # each rule-block body
        body = m.group(1)
        start = m.start()
        sel = src[:start].split('}')[-1].split('{')[-1].strip().replace('\n', ' ')
        props = {}
        for decl in body.split(';'):
            if ':' not in decl:
                continue
            prop, val = decl.split(':', 1)
            prop = prop.strip().lower()
            val = val.strip().lower()
            if not prop or prop.startswith('--'):       # skip custom props
                continue
            props.setdefault(prop, []).append(val)
        for prop, vals in props.items():
            if len(vals) < 2 or len(set(vals)) < 2:      # 0/1 distinct -> fine
                continue
            fb = FALLBACK_OK.get(prop)
            if fb and all(any(tok in v for tok in fb) for v in vals):
                continue
            status = 1
            print("INTRA-BLOCK DUPLICATE in %s:" % path)
            print("    selector '%s' declares '%s' %dx with differing values: %s"
                  % (sel[:70], prop, len(vals), vals))

if status == 0:
    print("css-intrablock-check: clean (no intra-block duplicate properties)")
else:
    print("")
    print("css-intrablock-check: FAILED - resolve each to ONE declaration "
          "(or add a justified FALLBACK_OK entry if it is a real old/new fallback).")
sys.exit(status)
