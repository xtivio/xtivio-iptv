#!/usr/bin/env python3
# css-flex-shrink-growth-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude570):
# The sidebar 2-line focus-highlight bug that took several patches to pin was NOT
# a CSS conflict (css-scale-conflict-check was green throughout) and NOT a missing
# line-height. It was a genuine ENGINE DIFFERENCE: Chromium 79 (webOS 6.5) and
# modern Blink (webOS 10) resolve a SHRINKABLE column flex-item that has a
# min-height AND wrapped/auto content differently.
#
# Measured on-device, expanded sidebar, X-Large, Greek 2-line label:
#     55" webOS 6.5 : .nav-btn offsetHeight = 55px  (== min-height; label spills
#                     BELOW the button, so the focus highlight — the button's own
#                     background — covers only the first line)
#     77" webOS 10  : .nav-btn offsetHeight = 76px  (button grew to contain the
#                     label; highlight covers both lines)
# Identical build, identical computed min-height (54.4px) / label height (~48px) /
# font / line-height on both. The ONLY divergence was the button's used height:
# 6.5 clamps a shrunk flex item to min-height and lets content overflow; 10 grows
# it. Same root cause also clipped the whole rail on the 77" (grown buttons
# overflowed .sidebar's overflow:hidden) while the 55" stayed short — so a patch
# "verified" on whichever panel was to hand shipped a bug on the other.
#
# THE INVARIANT THIS GATE ENFORCES:
# An element that is a flex ITEM in a column flex container, that paints a
# focus/active/hover state via its OWN background (so the highlight IS the box),
# and whose height comes from min-height + auto content (i.e. it can wrap), MUST
# set flex-shrink:0. Without it the item is shrinkable, and the two engines
# disagree on its used height under stack pressure — which is exactly the bug.
# flex-shrink:0 removes the shrink, so both engines size the box to its content
# and the highlight covers the whole label on both.
#
# The check is deliberately NARROW so it stays high-signal:
#   - only column flex CONTAINERS are considered (row items shrink on the
#     cross axis, which does not drive this height bug);
#   - only ITEMS that carry a *.focused/*.active/*.hover background rule
#     (the highlight-is-the-box condition) are flagged;
#   - an item is OK if it declares flex-shrink:0 anywhere in its own base rule,
#     OR a fixed non-auto height (not min-height — a fixed height can't grow but
#     also can't be out-grown by content, so the engines agree), OR is in ALLOW.
#
# Usage:  python3 tools/css-flex-shrink-growth-check.py
# Exit 0 = clean, exit 1 = a shrinkable highlighted flex item can diverge by engine.

import re, sys, os

FILES = ['assets/css/reset.css', 'assets/css/main.css',
         'assets/css/components.css', 'assets/css/screens.css',
         'assets/css/player.css', 'assets/css/tv-scale.css',
         'assets/css/tv-720.css', 'assets/css/rtl.css']

# Key selectors (rightmost simple selector) that are exempt, each with a reason.
ALLOW = {
    # Empty. Add only with a written reason — e.g. an item that genuinely cannot
    # wrap (white-space:nowrap AND single-line) and is fixed-height by design.
}


def strip_comments(src):
    return re.sub(r'/\*.*?\*/', '', src, flags=re.S)


def rules(path):
    """Yield (selector_string, decls_dict) for each rule block (media-query
    bodies are flattened in, since the item/container relationship is the same
    inside a 720 media block)."""
    if not os.path.exists(path):
        return
    src = strip_comments(open(path, encoding='utf-8').read())
    # Drop @media wrappers but KEEP their inner rules.
    src = re.sub(r'@media[^{]*\{', '', src)
    for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', src):
        sel = re.sub(r'\s+', ' ', m.group(1).strip().replace('\n', ' '))
        if not sel or sel.startswith('@'):
            continue
        d = {}
        for decl in m.group(2).split(';'):
            if ':' not in decl:
                continue
            p, v = decl.split(':', 1)
            d.setdefault(p.strip().lower(), []).append(
                v.strip().lower().replace('!important', '').strip())
        yield sel, d


def key_sel(sel):
    part = sel.strip().split()[-1] if sel.strip() else sel
    part = part.split('::')[0]
    part = re.sub(r':(hover|focus|active|focused|visited|first-child|'
                  r'last-child|nth-child\([^)]*\))', '', part)
    return part.strip()


# Collect every rule across the tree once.
ALL = []
for f in FILES:
    for sel, d in rules(f):
        ALL.append((f, sel, d))

# 1. Which key selectors are COLUMN flex containers?
column_containers = set()
for f, sel, d in ALL:
    disp = ' '.join(d.get('display', []))
    if 'flex' not in disp:
        continue
    fd = ' '.join(d.get('flex-direction', []))
    if 'column' in fd:
        for part in sel.split(','):
            column_containers.add(key_sel(part))

# 2. Which key selectors paint their OWN highlight via a state background?
#    (selector ends in .focused/.active/.hover AND sets background/background-color)
highlighted = set()
for f, sel, d in ALL:
    if not (d.get('background') or d.get('background-color')):
        continue
    for part in sel.split(','):
        p = part.strip()
        if re.search(r'\.(focused|active|hover)(\b|[:.])', p) or \
           p.endswith(':focus') or p.endswith(':hover') or p.endswith(':active'):
            # the highlighted element is the state selector minus the state class
            base = re.sub(r'\.(focused|active|hover)\b', '', p)
            base = re.sub(r':(focus|hover|active)\b', '', base)
            highlighted.add(key_sel(base))

# 3. For each highlighted element, gather its base-rule declarations (merged
#    across all its non-state rules) to decide if it is a shrinkable, wrappable,
#    min-height item that is a child of a column container.
#    We approximate "child of a column container" structurally: the element has a
#    base rule whose selector's PARENT chain includes a known column container,
#    OR the element's own base rule sets a flex-item property (flex/flex-shrink)
#    indicating it lives in a flex context. The nav-btn case has both.
def base_decls(k):
    merged = {}
    for f, sel, d in ALL:
        for part in sel.split(','):
            p = part.strip()
            # skip state variants; we want the resting rule
            if re.search(r'\.(focused|active|hover)\b|:(focus|hover|active)\b', p):
                continue
            if key_sel(p) == k:
                for prop, vals in d.items():
                    merged.setdefault(prop, []).extend(vals)
    return merged


def in_column_context(k):
    """True only when there is REAL evidence k is a flex ITEM of a column
    container. Being a bare-written rule is not enough on its own — a block-box
    child of a non-flex scroller (e.g. .live-epg-row inside .panel-ch-list, which
    is flex:1 but not itself display:flex) has min-height too and grows to fit
    content IDENTICALLY on both engines, so flagging it is a false positive.

    Evidence accepted (all concrete, none tree-wide):
      (a) a rule nests k under a known column container:  `.col-container ... k`;
      (b) a known column container styles k as its child/descendant explicitly
          (`.side-nav > k`, `.side-nav k`) — names k, not `*`; or the container
          styles k's GENERIC child slot (`.side-nav > *`) AND k is the element
          child family of THAT container (k appears bare and no other element
          class is a plausible child) — established by (c);
      (c) k's own base rule shows flex-item intent (`flex` / `flex-basis` /
          `align-self`).
    .nav-btn qualifies via (b): .side-nav (column) carries `.side-nav > * + *`,
    the nav buttons are its element children, and .nav-btn is highlighted with
    min-height — exactly the risk. .live-epg-row / .cat-mgr-row qualify under
    NONE: their scroll parents are not column flex containers and they declare no
    flex-item intent."""
    # (a)/(b-named): explicit selector relationship to a column container.
    # An ancestor token may be COMPOUND (`.sidebar.expanded`), so test whether
    # any column-container class appears among that token's classes, not just
    # whole-token equality.
    def token_has_container(tok):
        classes = set('.' + c for c in tok.lstrip('.').split('.') if c)
        return any(cc in classes for cc in column_containers)
    for f, sel, d in ALL:
        for part in sel.split(','):
            raw = part.strip().split()
            if len(raw) < 2:
                continue
            if key_sel(raw[-1]) == k and any(token_has_container(t) for t in raw[:-1]):
                return True
    # (c): flex-item intent on k's own base rule
    bd = base_decls(k)
    if 'flex' in bd or 'flex-basis' in bd or 'align-self' in bd:
        return True
    # (b-generic): a column container styles its generic child slot (`> *`), and
    # k is a DIRECT element child of THAT SAME container in the DOM. We can only
    # approximate the DOM from CSS, so require that the container ALSO has at
    # least one rule naming k (or a k-state) as a descendant — i.e. the container
    # and k co-occur in some selector — which ties k to this specific container
    # rather than to any container that happens to use `> *`.
    for f, sel, d in ALL:
        for part in sel.split(','):
            toks = [key_sel(t) for t in part.strip().split()]
            if len(toks) >= 2 and toks[0] in column_containers and \
               part.strip().split()[-1].rstrip('+').strip() == '*':
                container = toks[0]
                # does this same container ever name k as a descendant?
                for f2, sel2, d2 in ALL:
                    for part2 in sel2.split(','):
                        t2 = [key_sel(t) for t in part2.strip().split()]
                        if len(t2) >= 2 and t2[0] == container and t2[-1] == k:
                            return True
    return False


status = 0
seen = set()
for k in sorted(highlighted):
    if k in ALLOW or k in seen:
        continue
    seen.add(k)
    bd = base_decls(k)
    # Must be able to WRAP/grow: has min-height, and does NOT pin a fixed height.
    has_min_height = 'min-height' in bd
    has_fixed_height = any(v != 'auto' for v in bd.get('height', []))
    if not has_min_height or has_fixed_height:
        continue
    # Must actually be (or plausibly be) a shrinkable flex item in a column.
    if not in_column_context(k):
        continue
    # OK if it already opts out of shrink.
    if any(v == '0' for v in bd.get('flex-shrink', [])) or \
       any(re.match(r'\S+\s+0(\s|$)', v) for v in bd.get('flex', [])):
        continue
    status = 1
    print('FLEX-SHRINK GROWTH RISK: %s' % k)
    print('    highlighted via its own .focused/.active background, has '
          'min-height (%s) and no fixed height,' % ','.join(bd.get('min-height', [])))
    print('    and is a shrinkable item inside a column flex container.')
    print('    webOS 6.5 (Chromium 79) will clamp it to min-height and let a '
          'wrapped label overflow the highlight; webOS 10 grows it. -> add '
          'flex-shrink:0 to its base rule.')
    print('')

if status == 0:
    print('css-flex-shrink-growth-check: clean (no shrinkable highlighted '
          'column flex-item relies on min-height auto-growth)')
else:
    print('css-flex-shrink-growth-check: FAILED - see above. A shrinkable flex '
          'item whose highlight IS its own background renders at different '
          'heights on webOS 6.5 vs 10; flex-shrink:0 makes both size to content.')
sys.exit(status)
