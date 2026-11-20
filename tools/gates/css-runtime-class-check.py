#!/usr/bin/env python3
# css-runtime-class-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (497):
# The !important cleanup (494/495) stripped !important from `.hidden`
# (display:none) because a per-selector "inert" check saw only one rule setting
# display on `.hidden` and concluded nothing competed. WRONG: `.hidden` is a
# utility class ADDED to other elements at runtime — `.modal-layer.hidden`,
# `.vkeyboard.hidden` — and each of those elements has its OWN display (flex/
# block) from its element class. `.hidden` and `.modal-layer` are both (0,1,0),
# `.hidden` is earlier in load order, so without !important the element stays
# VISIBLE. Symptom: a blank Confirm/Message modal (the static #modalLayer
# placeholder) showed on launch. A static per-selector check cannot see this
# because the colliding selector `.modal-layer.hidden` exists only at runtime,
# never as a written rule.
#
# This gate reads the HTML and JS for elements that carry MULTIPLE classes, and
# flags any case where two of those classes each set the same
# display/visibility/position property to DIFFERENT values without !important
# breaking the tie. Those are the rules that must keep !important (or be made
# more specific), because their winner depends on load order alone.
#
# Usage:  python3 tools/css-runtime-class-check.py
# Exit 0 = clean, exit 1 = an unguarded runtime class collision exists.

import re, os, sys, glob

CSS_FILES = ['reset', 'main', 'components', 'screens', 'player', 'tv-scale', 'rtl']
TOGGLE_PROPS = ('display', 'visibility', 'position')


def css_rules():
    rules = {}
    order = {}
    idx = 0
    for f in CSS_FILES:
        p = os.path.join('assets/css', f + '.css')
        if not os.path.exists(p):
            continue
        s = re.sub(r'/\*.*?\*/', '', open(p, encoding='utf-8').read(), flags=re.S)
        pos, n = 0, len(s)
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
            body = s[st:j - 1]
            for part in [x.strip() for x in sel.split(',')]:
                # single-class selectors only (that is what a runtime class is)
                if re.match(r'^\.[\w-]+$', part):
                    cls = part[1:]
                    for dcl in body.split(';'):
                        if ':' not in dcl:
                            continue
                        prop, val = dcl.split(':', 1)
                        prop = prop.strip().lower()
                        if prop in TOGGLE_PROPS:
                            rules.setdefault((cls, prop), []).append(
                                ('!important' in val,
                                 val.replace('!important', '').strip(), idx))
                    idx += 1
            pos = j
    return rules


def class_combos():
    """Every set of classes that appears together on one element, from HTML
    class="..." attributes and JS className/classList assignments."""
    combos = []
    # index.html
    for m in re.finditer(r'class="([^"]+)"', open('index.html', encoding='utf-8').read()):
        combos.append(set(m.group(1).split()))
    # JS: className = 'a b c'  and  'a b' string literals used as class lists
    for jf in glob.glob('assets/js/*.js'):
        txt = open(jf, encoding='utf-8').read()
        for m in re.finditer(r"className\s*=\s*'([^']+)'", txt):
            combos.append(set(m.group(1).split()))
        for m in re.finditer(r'className\s*=\s*"([^"]+)"', txt):
            combos.append(set(m.group(1).split()))
        # el('div', { 'class': 'a b' })
        for m in re.finditer(r"'class'\s*:\s*'([^']+)'", txt):
            combos.append(set(m.group(1).split()))
    return combos


rules = css_rules()
combos = class_combos()

# Classes that JS reveals by setting an INLINE style.display (not by adding or
# removing the class). For these the class MUST stay plain: an inline style beats
# a plain class rule, so !important on the class would DEFEAT the reveal — which
# is exactly what broke the player transport/seek controls in 497. A plain rule
# here is correct, so this is NOT a collision to flag.
def inline_revealed_classes():
    revealed = set()
    html = open('index.html', encoding='utf-8').read()
    id_classes = {}
    for m in re.finditer(r'<[^>]*\bid="([\w-]+)"[^>]*\bclass="([^"]+)"', html):
        id_classes[m.group(1)] = set(m.group(2).split())
    for m in re.finditer(r'<[^>]*\bclass="([^"]+)"[^>]*\bid="([\w-]+)"', html):
        id_classes[m.group(2)] = set(m.group(1).split())
    for jf in glob.glob('assets/js/*.js'):
        txt = open(jf, encoding='utf-8').read()
        # direct: $('#id') ... .style.display
        for m in re.finditer(r"#([\w-]+)'\)[^;\n]{0,80}\.style\.display", txt):
            revealed |= id_classes.get(m.group(1), set())
        for m in re.finditer(r"getElementById\('([\w-]+)'\)[^;\n]{0,80}\.style\.display", txt):
            revealed |= id_classes.get(m.group(1), set())
        # var form:  foo = $('#id');  ... later ... foo.style.display = ...
        var_to_id = {}
        for m in re.finditer(r"(\w+)\s*=\s*\$\('#([\w-]+)'\)", txt):
            var_to_id[m.group(1)] = m.group(2)
        for m in re.finditer(r"(\w+)\s*=\s*(?:document\.)?getElementById\('([\w-]+)'\)", txt):
            var_to_id[m.group(1)] = m.group(2)
        for m in re.finditer(r"(\w+)\.style\.display\s*=", txt):
            vid = var_to_id.get(m.group(1))
            if vid:
                revealed |= id_classes.get(vid, set())
    return revealed

INLINE_REVEALED = inline_revealed_classes()

status = 0
seen = set()
for combo in combos:
    if len(combo) < 2:
        continue
    for prop in TOGGLE_PROPS:
        setters = [(c, rules[(c, prop)]) for c in combo if (c, prop) in rules]
        if len(setters) < 2:
            continue
        # distinct values across the colliding classes
        vals = set()
        any_important = False
        for c, decls in setters:
            for imp, val, idx in decls:
                vals.add(val)
                if imp:
                    any_important = True
        if len(vals) > 1 and not any_important:
            # If any colliding class is revealed by an inline style.display, the
            # plain rule is correct — an inline style beats it, and !important
            # would break the reveal (the 497 player-controls bug). Not a fault.
            if any(c in INLINE_REVEALED for c, _ in setters):
                continue
            key = (tuple(sorted(c for c, _ in setters)), prop)
            if key in seen:
                continue
            seen.add(key)
            status = 1
            classes = ' + '.join('.' + c for c, _ in setters)
            print('UNGUARDED runtime class collision: %s' % classes)
            print('    property "%s" set to different values by classes that share'
                  ' an element,' % prop)
            print('    with NO !important to settle it — winner depends on load order.')
            for c, decls in setters:
                for imp, val, idx in decls:
                    print('        .%-24s %s: %s' % (c, prop, val))
            print('    Fix: !important on the one that must win, or make it more specific.')
            print('')

if status == 0:
    print('css-runtime-class-check: clean (no unguarded runtime class collisions)')
else:
    print('css-runtime-class-check: FAILED - see above. This is the class of bug '
          'that put a blank modal on screen in 497.')
sys.exit(status)
