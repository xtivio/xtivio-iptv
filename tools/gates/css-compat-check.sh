#!/bin/sh
# CSS compatibility gate for the 4-series engine floor.
#
# Engine versions (verified against Samsung/Tizen release notes, not assumed):
#   webOS 4   -> Chromium ~53   <-- THE REAL FLOOR
#   Tizen 4.0 -> Chromium  56   (Tizen 3.0 is the M47 one, 2017 models)
# So the binding constraint is webOS 4 at ~53, and anything needing >53 must not
# be used. These features PARSE but silently do nothing there, so a layout looks
# correct in dev (Chromium 79+) and is broken on the oldest supported TVs with no
# error anywhere. rtl.css documents the same list in prose; this enforces it.
status=0

flag() {   # flag <pattern> <description>
    # Strip comments before matching, so the prose rules in rtl.css that NAME
    # these features don't trigger the gate that enforces them.
    #
    # EXCLUDE mobile.css: it is loaded ONLY on the mobile Android WebView (gated
    # behind html[data-vp="mobile"], set exclusively by the mobile build). It
    # NEVER applies on webOS/Tizen — those TVs never set that attribute — so the
    # 4-series Chromium floor does not constrain it. Android's WebView is modern
    # Chromium where grid/gap/inset are fully supported. Enforcing the TV floor
    # on mobile-only CSS would be a false positive.
    hits=$(for f in assets/css/*.css; do
        case "$f" in
            assets/css/mobile.css) continue ;;
        esac
        sed 's|/\*|\n&|g' "$f" | sed '/\/\*/,/\*\//d' | grep -n "$1" | sed "s|^|$f:|"
    done)
    if [ -n "$hits" ]; then
        echo "css-compat: $2"
        echo "$hits" | sed 's/^/    /'
        status=1
    fi
}

flag 'gap:'                 'flex/grid `gap` needs Chromium 84 — use margins on the children instead'
flag 'aspect-ratio:'        '`aspect-ratio` needs Chromium 88 — use the padding-top percentage hack'
flag 'overflow-wrap: *anywhere' '`overflow-wrap: anywhere` needs Chromium 80 — use break-word'
flag ':is('                 '`:is()` needs Chromium 88 — write the selectors out longhand'
flag ':where('              '`:where()` needs Chromium 88 — write the selectors out longhand'
flag 'display: *grid'       'CSS grid is not safe on the 4-series floor — use flexbox'
flag 'inset:'               'the `inset` shorthand needs Chromium 87 — use top/right/bottom/left'

# Added after a mutation test showed the list above was the ONLY thing enforced:
# these were all silently accepted. None were in use when added (0 hits), so this
# widens the net without changing today's result. Versions = first Chromium that
# supports the feature; the floor is 53.
flag ':focus-visible'              '`:focus-visible` needs Chromium 86 — style the existing .focused class instead'
flag ':focus-within'               '`:focus-within` needs Chromium 60'
flag '[^A-Za-z-]clamp('            '`clamp()` needs Chromium 79 — use calc() or fixed steps'
flag '[^A-Za-z-]min('              '`min()` needs Chromium 79'
flag '[^A-Za-z-]max('              '`max()` needs Chromium 79'
flag '[^A-Za-z-]env('              '`env()` needs Chromium 69 (fine in the mobile-only stylesheet, not here)'
flag 'backdrop-filter'             '`backdrop-filter` needs Chromium 76'
flag 'scroll-behavior'             '`scroll-behavior` needs Chromium 61'
flag 'overscroll-behavior'         '`overscroll-behavior` needs Chromium 63'
flag 'prefers-color-scheme'        '`prefers-color-scheme` needs Chromium 76'
flag 'accent-color'                '`accent-color` needs Chromium 93'
flag '\(margin\|padding\|inset\)-\(inline\|block\)' 'logical margin/padding/inset (-inline/-block) need Chromium 87 — use left/right/top/bottom'
flag 'rgba\?([^)]*/'              'space-separated rgb()/rgba() with a "/ alpha" needs Chromium 65 — use rgba(r,g,b,a)'
flag '#[0-9a-fA-F]\{8\}\b'         '8-digit #rrggbbaa hex needs Chromium 62 — use rgba()'
flag ':not([^)]*,'                 'a selector LIST inside :not() needs Chromium 88 — chain :not(a):not(b)'

if [ "$status" -eq 0 ]; then
    echo "css-compat: clean (no post-Chromium-53 CSS features)"
else
    echo ""
    echo "css-compat: FAILED — these silently do nothing on Tizen 4 / webOS 4."
fi
exit $status
