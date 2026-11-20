#!/usr/bin/env python3
"""Every stylesheet must have balanced comments. A comment whose opening line is lost leaves a stray
terminator; the browser then drops the NEXT real rule without any error (tv-720.css lost the
.cat-mgr-tools height/cap rule this way until 1.0.8.5). Usage: run from the web dir (assets/css/*.css)."""
import glob, re, sys
bad = 0
for f in sorted(glob.glob('assets/css/*.css')):
    s = open(f, encoding='utf-8').read()
    inside = False; start = 0
    for m in re.finditer(r'/\*|\*/', s):
        if m.group() == '/*':
            if inside: pass
            else: inside = True; start = m.start()
        else:
            if not inside:
                print('%s: stray comment terminator at line %d' % (f, s.count('\n', 0, m.start()) + 1)); bad += 1
            inside = False
    if inside:
        print('%s: unterminated comment from line %d' % (f, s.count('\n', 0, start) + 1)); bad += 1
print('css-comment-balance-check: ' + ('FAILED (%d)' % bad if bad else 'clean (all comments balanced)'))
sys.exit(1 if bad else 0)
