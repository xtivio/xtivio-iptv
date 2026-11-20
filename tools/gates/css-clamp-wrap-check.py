#!/usr/bin/env python3
# css-clamp-wrap-check.py - MANDATORY pre-package gate.
#
# WHY THIS EXISTS (iptv-claude697):
# A multi-line clamp (-webkit-line-clamp: N with display:-webkit-box) only wraps to
# the second line if the text HAS a break opportunity. Provider/EPG names are often
# one long token with NO spaces (for example "Animation;Classic;Entertainment" or a
# space-less Arabic name), so without overflow-wrap/word-break the clamp has nothing
# to break on: the name stays on ONE line and truncates, defeating the point of the
# clamp. This was found by a pathological-name stress test across playlists - the app
# ships to app stores and must handle every provider's naming, not the one test
# playlist whose names happened to contain spaces or fit on one line.
#
# Six real surfaces had the bug at once (.ch-card .ch-name, .media-name,
# .panel-ch-title, .live-epg-ch-name, .live-now-side-title, .live-next-side-title).
# This gate makes the requirement executable: any rule that sets -webkit-line-clamp
# on a text element MUST also set overflow-wrap or word-break (or word-wrap), so
# space-less strings can reach the later lines instead of truncating at line 1.
#
# Fix when it fires: add `overflow-wrap: break-word;` (with `word-wrap: break-word;`
# as the legacy alias) to the flagged rule. break-word breaks cleanly at spaces first
# and only mid-word when a token is too long; it is compat-safe on the Chromium 53
# floor (overflow-wrap:anywhere is NOT - it needs Chromium 80).
#
# A rule is EXEMPT if it is a layout container rather than a text cell: the clamp is
# only meaningful on the element that actually holds the text. Container selectors
# whose text lives in a child are listed in EXEMPT below.
#
# Usage:  python3 tools/css-clamp-wrap-check.py
# Exit 0 = clean, exit 1 = a clamped text rule is missing wrap handling.

import re, sys, os

FILES = ['assets/css/main.css', 'assets/css/components.css',
         'assets/css/screens.css', 'assets/css/player.css']

# Selectors that carry -webkit-line-clamp for layout reasons but whose actual text
# is rendered by a CHILD element (which has its own clamp+wrap). The clamp on the
# container is incidental; do not require wrap handling on it.
EXEMPT = {
    '.live-epg-row',   # flex row; the name cell .live-epg-ch-name holds the text
}


def rules(path):
    if not os.path.exists(path):
        return []
    raw = open(path, encoding='utf-8').read()
    # strip comments so a "line-clamp" mention inside a comment is not parsed as a rule
    s = re.sub(r'/\*.*?\*/', '', raw, flags=re.S)
    out, pos, n = [], 0, len(s)
    while pos < n:
        m = re.compile(r'([^{}]+)\{').match(s, pos)
        if not m:
            pos += 1
            continue
        sel = re.sub(r'\s+', ' ', m.group(1).strip())
        st = m.end()
        depth, j = 1, st
        while j < n and depth > 0:
            if s[j] == '{':
                depth += 1
            elif s[j] == '}':
                depth -= 1
            j += 1
        body = s[st:j-1]
        out.append((sel, body))
        pos = j
    return out


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    problems = []
    for path in FILES:
        for sel, body in rules(path):
            if '-webkit-line-clamp' not in body:
                continue
            first = sel.split(',')[0].strip()
            if first in EXEMPT:
                continue
            has_wrap = ('overflow-wrap' in body
                        or 'word-break' in body
                        or 'word-wrap' in body)
            if not has_wrap:
                problems.append((path, first))
    if problems:
        print('css-clamp-wrap-check: FAILED')
        for path, sel in problems:
            print('  %s  (%s)' % (sel, path))
            print('    has -webkit-line-clamp but no overflow-wrap/word-break: a')
            print('    space-less name will truncate at line 1 instead of wrapping.')
            print('    Add: overflow-wrap: break-word; (and word-wrap: break-word;)')
        sys.exit(1)
    print('css-clamp-wrap-check: clean (all clamped text rules wrap space-less strings)')
    sys.exit(0)


if __name__ == '__main__':
    main()
