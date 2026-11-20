#!/usr/bin/env python3
"""Patch-version-marker gate (hardened, multi-style).

Forbids referencing patch/build numbers in shipped code comments: they go
stale silently and mean nothing to a later reader, who cannot see that
patch/build. History belongs in CHANGELOG-ANDROID.md / changelog.md and
OPEN-THREADS.md / KNOWN-ITEMS.md only — describe WHAT changed and WHY in the
comment itself, never WHICH numbered patch/build it happened in.

Three numbering styles recognized:
  - iptv-claude / claude / patch NNN  (3-digit, 400-699 — that project's range)
  - android NN                        (1-3 digit, no space — the RETIRED
                                        single-platform "androidNN" build-tag
                                        convention; kept so any lingering old-
                                        style reference still gets caught)
  - xtivio-x.y.z[.w] / "XtivioTV/x.y.z" / versionName|APP_VERSION + number /
    bare x.y.z[.w] attributions — the CURRENT cross-
    platform version scheme (app/build.gradle's xtivioVersion +
    xtivioInternalBuild, config.js's INSTALL_TOKEN). Same reasoning as the
    other two: "fixed in 1.0.1" or "xtivio-1.0.1.3" in a comment goes stale
    the moment the next release ships, same as "fixed in android54" did —
    version history belongs in CHANGELOG-ANDROID.md only.

The android rule is DELIBERATELY narrow: lowercase-or-not "android" with the
number GLUED directly on (no space) — "android54", "android49-52". This is
chosen specifically to NOT match "Android 13" / "Android 6.0" style OS
VERSION references (space-separated, often with a decimal or a trailing
"+") — those are legitimate, meaningful, and do not go stale the way a
patch/build number does. If you ever need to reference an OS version in a
comment, keep the space; the gate will not flag it.

The xtivio-version rule is similarly scoped to avoid false positives on
legitimate dotted numbers (CSS/library version pins, IP-shaped examples,
semantic-looking but unrelated numbers in prose): it requires either the
literal "xtivio-" prefix (unambiguous — only ever a build token) or one of
the same attribution verbs used for the iptv-claude rule, immediately
before a 3-or-4-part dotted number. A bare "1.0.1" floating in a comment
with no attribution verb and no "xtivio-" prefix is NOT flagged (e.g. a
worked example of semver itself, or an unrelated measurement) — only an
actual claim that something happened AT that version.

Scope: comment text only (// lines, /* */ blocks, " * " continuation lines,
Kotlin/Gradle share the same // and /* */ syntax so no separate parser is
needed) in assets/js/*.js, assets/css/*.css, index.html (web layer) plus
app/**/*.kt, and the three .gradle files (Android layer). The vendor blob
hls.min.js is skipped. Exit 1 (and print) if any marker is found.

Usage: python3 patch-marker-check.py [project-root]
  project-root defaults to the current directory. Needs to be run from (or
  point at) the directory containing both app/src/main/assets/web/ and
  app/build.gradle — the project root, not the web root the other web-only
  gates run from — since this one has to see both layers.
"""
import re, glob, sys, os

RANGE_IPTV = r'(4\d{2}|5\d{2}|6\d{2})'   # iptv-claude's 3-digit patch range
XTIVIO_VER = r'\d+\.\d+\.\d+(?:\.\d+)?'  # the current x.y.z[.w] version scheme

# High-confidence patch-attribution shapes.
FORBID = [
    # HARD RULE (iptv-claude style) — the words "patch" / "claude" /
    # "iptv-claude" next to ANY number (1-3 digits), regardless of range.
    re.compile(r'\b(iptv-claude|claude|patch)\s*#?\s*[0-9]{1,3}\b', re.I),
    # HARD RULE (android style, RETIRED but still caught) — "android" with
    # the number GLUED directly on, no space. Deliberately excludes
    # "Android 13" / "Android 6.0" (see module docstring) by requiring zero
    # characters between the word and the digits.
    re.compile(r'\bandroid[0-9]{1,3}\b', re.I),
    # HARD RULE (current xtivio-x.y.z[.w] style) — the literal "xtivio-"
    # prefix is unambiguous on its own (only ever a build token, matching
    # config.js's INSTALL_TOKEN / build.gradle's xtivioBuildId format).
    re.compile(r'\bxtivio-' + XTIVIO_VER + r'\b', re.I),
    # HARD RULE — a literal version number attached to OUR OWN version names in a
    # comment goes stale at the next release no matter how it is phrased:
    # the user-agent ("XtivioTV/1.0.1"), or versionName / versionCode /
    # xtivioVersion / APP_VERSION followed by a number. (A bare "version 1.0.1"
    # is still allowed — it may be a library pin or an example.) Write
    # "XtivioTV/<version>" or "the current versionName" instead.
    re.compile(r'\bXtivio(?:TV)?\s*[/ ]\s*v?' + XTIVIO_VER + r'\b', re.I),
    re.compile(r'\b(?:xtivioVersion|versionName|APP_VERSION)\b[\s:=\'"`]*v?' + XTIVIO_VER + r'\b', re.I),
    # change-attribution verb/preposition immediately followed by a bare
    # x.y.z[.w] version — same attribution-verb list as the iptv-claude rule
    # below, applied to the current version scheme instead of a 3-digit
    # patch number.
    re.compile(r'\b(since|per|see|reverted(?: in)?|introduced(?: in)?|fixed in|changed in'
               r'|added in|removed in|released in|shipped in|restored in)\s*\(?v?' + XTIVIO_VER + r'\b', re.I),
    # change-attribution verb/preposition immediately followed by an
    # iptv-claude-range patch number
    re.compile(r'\b(since|per|see|reverted(?: in)?|introduced(?: in)?|flatten(?:ing|ed)?'
               r'|widened(?: in)?|narrowed(?: in)?|added in|removed in|fixed in|changed in'
               r'|split(?: in)?|merged(?: in)?|moved(?: in)?|renamed(?: in)?|dropped in'
               r'|restored in|gated in|scoped in|iptv-claude ?|patch )\s*\(?' + RANGE_IPTV + r'\b', re.I),
    # "in NNN" where NNN is an iptv-claude-range patch number (not "in the/a/this/that/...")
    re.compile(r'\bin \(?' + RANGE_IPTV + r'\b', re.I),
    # bare parenthesised iptv-claude-range patch number: (481)
    re.compile(r'\(' + RANGE_IPTV + r'\)'),
    # "NNN:" starting a NOTE (patch-attribution style), e.g. "577: widened ...".
    re.compile(r'(?:^|[.;]\s|^\s*)' + RANGE_IPTV + r':\s'),
    # arrow attributions: "573 ->" or "-> 480"
    re.compile(RANGE_IPTV + r'\s*(?:->|\u2192)'),
    re.compile(r'(?:->|\u2192)\s*' + RANGE_IPTV + r'\b'),
]

def is_false_positive(context):
    """context = a slice of comment text around the matched number."""
    if re.search(r'\d\s?(px|ms|em|rem|vh|vw|%)\b', context): return True
    if re.search(RANGE_IPTV + r'\s?x\s?\d', context): return True
    if re.search(r'\dx\s?' + RANGE_IPTV, context): return True
    if re.search(RANGE_IPTV + r',\d', context): return True
    if re.search(RANGE_IPTV + r'\s*(?:->|\u2192)\s*' + RANGE_IPTV, context): return True
    if re.search(r'\d{3}\s*(?:->|\u2192)\s*' + RANGE_IPTV, context): return True
    if re.search(RANGE_IPTV + r'\s*(?:->|\u2192)\s*\d{3}', context): return True
    return False

def comment_spans(path):
    """Yield (lineno, comment_text) for each line's comment content.

    Handles: // line comments; fully-closed inline /* ... */; block-comment
    continuation lines (" * prose"); the OPENING line of a multi-line block
    comment (`/* prose` with the closing */ on a later line); and, for .xml
    files, <!-- ... --> comments (which can themselves span multiple lines,
    tracked with a simple stateful flag since XML has no "*"-prefixed
    continuation convention to match per-line the way /* */ blocks do).
    """
    is_xml = path.endswith('.xml')
    in_xml_comment = False
    for i, line in enumerate(open(path, encoding='utf-8', errors='ignore').read().split('\n'), 1):
        c = ''
        if is_xml:
            rest = line
            while rest:
                if in_xml_comment:
                    end = rest.find('-->')
                    if end == -1:
                        c += ' ' + rest
                        rest = ''
                    else:
                        c += ' ' + rest[:end]
                        rest = rest[end + 3:]
                        in_xml_comment = False
                else:
                    start = rest.find('<!--')
                    if start == -1:
                        rest = ''
                    else:
                        rest = rest[start + 4:]
                        in_xml_comment = True
            if c.strip():
                yield i, c
            continue
        if '//' in line:
            c += ' ' + line.split('//', 1)[1]
        for bm in re.finditer(r'/\*(.*?)\*/', line):
            c += ' ' + bm.group(1)
        mo = re.search(r'/\*(?!.*\*/)(.*)$', line)
        if mo:
            c += ' ' + mo.group(1)
        mc = re.match(r'\s*\*(?!/)(.*)', line)
        if mc:
            c += ' ' + mc.group(1)
        if c.strip():
            yield i, c

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    web = os.path.join(root, 'app', 'src', 'main', 'assets', 'web')
    files = (
        glob.glob(os.path.join(web, 'assets', 'js', '*.js')) +
        glob.glob(os.path.join(web, 'assets', 'css', '*.css')) +
        [os.path.join(web, 'index.html')] +
        glob.glob(os.path.join(root, 'app', 'src', 'main', 'java', '**', '*.kt'), recursive=True) +
        [os.path.join(root, 'app', 'build.gradle'),
         os.path.join(root, 'settings.gradle'),
         os.path.join(root, 'build.gradle'),
         # Tizen's manifest can carry XML comments (<!-- -->) — comment_spans()
         # below has its own <!--..--> handling for this file. appinfo.json
         # is plain JSON (no comment syntax at all) and is intentionally not
         # listed — nothing to scan there.
         os.path.join(root, 'tizen', 'config.xml')]
    )
    hits = []
    for f in files:
        if not os.path.isfile(f) or 'hls.min.js' in f:
            continue
        for ln, c in comment_spans(f):
            for rx in FORBID:
                m = rx.search(c)
                if not m:
                    continue
                context = c[max(0, m.start() - 4): m.end() + 6]
                if is_false_positive(context):
                    continue
                hits.append('%s:%d: %s' % (f, ln, c.strip()[:90]))
                break
    if hits:
        print("patch-marker-check: patch/build-version references in code comments")
        print("  (These go stale and mean nothing to a later reader.")
        print("   Reword to describe WHAT/WHY, not which patch/build. Numbers live")
        print("   in CHANGELOG-ANDROID.md / OPEN-THREADS.md only):")
        for h in hits:
            print('    ' + h)
        return 1
    print("patch-marker-check: clean (no patch/build-version markers in comments)")
    return 0

if __name__ == '__main__':
    sys.exit(main())
