#!/usr/bin/env python3
# css-dup-fontsource-check.py - MANDATORY pre-package gate.
#
# Catches the ROOT CAUSE of the recurring 720 desync regressions: a class that
# declares font-size in TWO places - once as a bare single-class rule
# (".cat-filter { font-size }") and again inside a compound selector
# (".panel-cat-search .cat-filter { font-size }" or via a shared container).
#
# Why this keeps biting: the 720 generator collects the BARE rule into its font
# pass and scales it by --txt-scale, while the compound partner is unit-scaled as
# a TEXT_CONTROL. The two then render at different sizes on the 720 canvas even
# though the base CSS looked consistent - so the height/parity gate (which reads
# declared base values) stays green while the screen is visibly broken. This has
# recurred on .cat-filter (live filter vs search) and .cat-mgr-col-head (manager
# headers). The fix each time is the same: delete the redundant bare font rule and
# let the element inherit / take its size from the single compound/container rule.
#
# This gate makes that rule executable: a bare "SINGLE-CLASS { font-size }" rule
# is flagged if that same class ALSO appears as the last class of a compound
# selector anywhere. Allowlist the genuine standalone controls (a class that is
# ONLY ever used bare, e.g. a true utility).
#
# Usage:  python3 tools/css-dup-fontsource-check.py
import glob
import re
import sys

# Classes allowed to carry a bare font-size even though they're text-controls.
# These are BASE component classes whose bare rule IS their definition, and the
# generator lists the bare class itself as the text-control, so it unit-scales the
# same element - one source, no desync. (The risk is only when the text-control is
# a COMPOUND selector but the font-size is declared on the BARE class, so the two
# forms scale differently - e.g. .cat-filter.)
ALLOW = set([
    'btn', 'chip', 'field', 'tab',
])

FILES = sorted(glob.glob('assets/css/*.css'))
# Never scan the generated sheet itself - it legitimately re-emits both forms.
FILES = [f for f in FILES if not f.endswith('tv-720.css')]


def rules(path):
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


ALL = []
for f in FILES:
    ALL.extend(rules(f))

# The desync only happens for classes that are 720 TEXT_CONTROLS: those are
# unit-scaled (box+font together) via gen-tv720.py, so a SEPARATE bare font-size
# rule on the same class gets collected into the --txt-scale font pass and fights
# the unit-scaling, desyncing it from its partner. A bare font-size on an ordinary
# component (.btn, .field, .toast) is fine - it's only a risk when the class is a
# text-control. Read the text-control class set from the generator so this gate
# and the generator can never drift apart.
def load_text_control_classes():
    classes = set()
    try:
        src = open('tools/gen-tv720.py', encoding='utf-8').read()
    except Exception:
        return classes
    m = re.search(r'TEXT_CONTROLS\s*=\s*\[(.*?)\]', src, re.S)
    if not m:
        return classes
    for lit in re.findall(r"'([^']+)'", m.group(1)):
        toks = lit.split()
        last = toks[-1] if toks else lit
        cm = re.match(r'^\.([A-Za-z0-9_-]+)', last)
        if cm:
            classes.add(cm.group(1))
    return classes


compound_last = load_text_control_classes()

# Find bare single-class rules that set font-size.
offenders = []
for sel, body in ALL:
    for member in sel.split(','):
        member = member.strip()
        m = re.match(r'^\.([A-Za-z0-9_-]+)$', member)
        if not m:
            continue
        cls = m.group(1)
        if cls in ALLOW:
            continue
        if not re.search(r'(^|;)\s*font-size\s*:', body):
            continue
        if cls in compound_last:
            offenders.append(cls)

offenders = sorted(set(offenders))
if offenders:
    print('css-dup-fontsource: FAILED - bare font-size rule on a class that is')
    print('also styled via a compound selector (720 desync risk):')
    for c in offenders:
        print('    .%s' % c)
    print('')
    print('Fix: delete the bare ".%s { font-size }" rule and let the element take'
          % offenders[0])
    print('its size from the compound/container rule (single source), so the 720')
    print('generator can\'t scale the two forms differently. If genuinely safe,')
    print('add the class to ALLOW with a note.')
    sys.exit(1)

print('css-dup-fontsource: clean (no duplicate font-size sources)')
sys.exit(0)
