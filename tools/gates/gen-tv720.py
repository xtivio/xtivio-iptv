#!/usr/bin/env python3
# gen-tv720.py - generate assets/css/tv-720.css, the 1280x720 viewport overrides.
#
# STRATEGY (Option A): a SINGLE uniform scale of 0.667 (the true 1080->720 ratio)
# applied to EVERYTHING - layout and text alike. This keeps the 1080 design's exact
# proportions on the 1280x720 canvas: every element occupies the same fraction of
# the screen as it does at 1080, so nothing can overflow or crowd an edge that was
# fine at 1080. Text lands at 26px*0.667 = ~17px.
#
# Because the whole app already sizes via calc(Npx * var(--ui-scale)), setting
# --ui-scale to 0.667 on the 720 scope rescales ~157 fonts AND ~90 layout dims at
# once. We then only need to handle things that DON'T use --ui-scale:
#   - the handful of fixed-px font-sizes (scaled 0.667);
#   - fixed-px layout boxes (mini-player, QR, panels, columns, sidebar, etc);
#   - --content-pad, scaled a touch harder so the (intentional) side indent isn't
#     disproportionately wide on the smaller canvas.
#
# NOTE: an earlier version split layout (0.667) from text (0.769). That broke the
# box/text proportion the base design relies on and risked clipping wherever the
# 1080 layout ran tight to an edge, so it was replaced by this single-scale model.
#
# GENERATED FILE - do not hand-edit tv-720.css; edit this and re-run.
import re

SCALE = 0.667
# The intentional content side-padding (--content-pad, 60px at 1080) looked too
# wide at 720 because everything else got smaller around it. Pull it in a bit more
# than the uniform scale.
PAD_SCALE = 0.55
# Text-size tiers (the Text Size setting) as multipliers.
TIERS = [("xsmall", 0.80), ("small", 0.90), ("large", 1.10), ("xlarge", 1.20)]

# --- Scale model (dual-scale) -----------------------------------------------
# LAYOUT is pinned: --ui-scale = 0.667 always, regardless of Text Size, so the
# structural layout stays fitted to the 720 canvas and never overflows when the
# user picks a larger Text Size. TEXT scales: --txt-scale starts at the 0.667 base
# and moves with the Text Size tiers (real multipliers, no damping), driving fonts
# and text-controls so text/buttons/sidebar labels grow and shrink as the setting
# intends. This is the split the single-scale model lost.
#
# TEXT_CONTROLS: elements whose BOX is height-locked to their own text (buttons,
# chips, fields, tabs, keypad word-keys, ...). We set --ui-scale = var(--txt-scale)
# ON these elements so their height, padding AND font scale together as a unit -
# the box grows with its label, so long German/Greek text never clips inside a
# box that stayed layout-fixed.
TEXT_CONTROLS = [
    '.btn', '.chip', '.field', '.field.big', '.tab',
    '.setting-ctl .btn', '.setting-ctl .field', '.setting-ctl .btn.danger',
    '.panel-search', '.panel-search .field', '.panel-cat-search',
    '.panel-cat-search .cat-filter', '#searchField',
    '.live-top-mini-actions .btn', '.live-top-mini-actions .btn svg',
    '#setEpgManage',
    # Status glyphs whose SIZE is a box (width/height), not a font: remap --ui-scale
    # to --txt-scale on 720 so the box grows with Text Size. .media-fav is font-only
    # and is handled by the font auto-collector below (kept out here to avoid the
    # dup-fontsource desync with its compound .live-epg-ch/.has-lock siblings). The
    # large centred poster-card lock badge (.vod-card .lock-glyph) is NOT included.
    '.lock-glyph', '.ch-card .fav-mark', '.vod-card .fav-mark',
]
# SEALED grids: a fixed set of cells whose columns-per-row depends on cell width vs
# container width. Keep the cells on the SAME (layout) scale as their container so
# the grid doesn't reflow (the PIN keypad dropped 3->2 columns when its buttons
# scaled by a different factor than the keypad).
SEALED_GRID_CELLS = ['.pin-keypad .btn', '.pin-keypad .btn.pin-key-word', '.modal-actions .btn.pin-key-word']

# --- Overscan safe area (on by default) -------------------------------------
# Many TVs overscan (crop ~5% of every edge) and the user never changes the "Just
# Scan"/"Screen Fit" setting, so content pinned to the true 1280x720 edges can land
# in the cropped zone. Inset the whole app by SAFE_INSET on every edge so nothing
# important is lost. This ships ON for the store build (unknown hardware); it costs
# a little usable space on TVs that don't overscan, in exchange for never clipping
# on the ones that do.
SAFE_INSET = "3.5%"

# Fixed-px layout boxes that don't use --ui-scale. Scaled by SCALE. Mini player
# keeps 16:9. QR codes scale proportionally. Tall panels come down. The
# movies/series columns, sidebar rail + logo, manager tool-row min-heights, the
# manager checkbox height, the onboarding left column and the QR-frame padding are
# all fixed-px too and would otherwise stay 1080-size on the smaller canvas.
LAYOUT_FIXED = [
    ('.live-top-mini-frame', [('width', 711), ('height', 400)]),
    ('#qrCanvas', [('width', 320), ('height', 320)]),
    ('.coffee-qr', [('width', 160), ('height', 160)]),
    ('.livetv-fixed-top', [('height', 437)]),
    ('[data-section-content="movies"] .panel-cats, [data-section-content="series"] .panel-cats', [('width', 488)]),  # 730: =~325px@720. Sized for the Greek filter placeholder (270px in real bundled Noto Sans Greek at Extra Large; needs ~321px column). Earlier 300/310 were measured against a substitute font and clipped.
    # livetv category column. 566 forced this to 240 (=160px at 720) to make live
    # categories narrower / channels wider, but 160px is far below the non-720 base
    # (380px) and left the two Live columns visibly disproportionate at 720 — the
    # category column much narrower than the 420px channel column beside it. 574
    # sets it to the real base 380 (=253px at 720), so the 720 widths scale in the
    # same 380:420 proportion the non-720 layout uses and the columns look alike.
    ('[data-section-content="livetv"] .panel-cats', [('width', 488)]),  # 730: =~325px@720. Real Noto Sans Greek filter placeholder (270px) clipped by 13px at 300px; sized to match movies/series.
    # movies/series poster (info) column. 440 -> 382 in 577: at 720 the content
    # header title (.panel-ch-title) needed +39px to fit "Филмови во тековната
    # категорија" (mk) on one line at X-Large (probe575 titleWidthNeed:
    # extraWidthNeeded 39). The content column is flex:1, so trimming the poster
    # column by 58 base (=39px at 720) hands that width to the title column and it
    # stops wrapping. The poster frame is width:100% + padding-top:150% (a true 2:3
    # frame), so a narrower column keeps the 2:3 aspect and 2:3 posters still fill
    # it with NO letterbox — only the absolute size drops. 720-only (LAYOUT_FIXED).
    ('[data-section-content="movies"] .panel-info, [data-section-content="series"] .panel-info', [('width', 382)]),
    ('.sidebar:not(.expanded)', [('width', 80)]),
    ('.sidebar.expanded .side-logo', [('width', 200)]),
    ('.side-logo', [('width', 58)]),
    # Episode picker cards were full-size (340px wide, 190px thumb = ~329px tall) inside
    # a 60vh modal-body that IS scaled on 720 — so one card nearly filled the scroll
    # viewport and down-nav landed with a card part-hidden. Scale card+thumb to match.
    ('.series-ep-card', [('width', 340)]),
    ('.series-ep-thumb', [('height', 190)]),
    ('.qr-frame', [('padding', 32)]),
    # onboarding left column: fixed max-width that cramped the QR column on the
    # narrower canvas when left unscaled.

]

BASE_FILES = ['main', 'components', 'screens', 'player']


def blocks(path):
    s = re.sub(r'/\*.*?\*/', '', open(path).read(), flags=re.S)
    out = []; pos = 0; n = len(s)
    while pos < n:
        m = re.compile(r'([^{}]+)\{').match(s, pos)
        if not m:
            pos += 1; continue
        sel = re.sub(r'\s+', ' ', m.group(1).strip()); st = m.end(); d, j = 1, st
        while j < n and d > 0:
            if s[j] == '{': d += 1
            elif s[j] == '}': d -= 1
            j += 1
        if not sel.startswith('@'):
            out.append((sel, s[st:j - 1]))
        pos = j
    return out


def scope(sel):
    # For a source selector that already starts with "html[...]"
    # (currently the touch-only donate/bug-report styling in screens.css —
    # html[data-touch="1"] .coffee-link and its two variants), naively
    # prepending 'html[data-vp="720"] ' as an ancestor produced
    # 'html[data-vp="720"] html[data-touch="1"] .coffee-link' — two <html>
    # elements nested inside each other, which never happens in a real DOM,
    # so the generated rule could never match anything. Merge the data-vp
    # attribute onto the SAME leading html instead of nesting a second one;
    # everything else (selectors not starting with "html") is unaffected.
    out = []
    for m in sel.split(','):
        m = m.strip()
        if re.match(r'^html\b', m):
            out.append(re.sub(r'^html', 'html[data-vp="720"]', m, count=1))
        else:
            out.append('html[data-vp="720"] ' + m)
    return ', '.join(out)


# Collect EVERY font-size selector (both calc(Npx*var(--ui-scale)) and fixed Npx),
# except those that live on a text-control or sealed grid cell (handled as units).
# Layout --ui-scale is pinned at 0.667, so calc fonts would otherwise not scale with
# Text Size; we re-emit them under --txt-scale so text scales while layout stays put.
# Selectors excluded from text-font auto-collection:
#  - onboard-title / pair-code: emitted with a dedicated capped override later.
# Selectors excluded from text-font auto-collection:
#  - onboard/pair: fixed sizes that are their own thing (splash / pairing screens).
#  - ch-card num/name: uses the standard 26px text base (same as body text) but is
#    kept explicit so it can bind to --txt-scale. On 1080, card text already scales
#    with Text Size because everything uses --ui-scale (see tv-scale.css: --ui-scale
#    goes 0.80 to 1.20 by Text Size). On 720, layout is pinned to --ui-scale 0.667 so
#    body text does NOT follow Text Size; binding card text to --txt-scale opts it back
#    into Text-Size scaling so the channel grid stays adjustable. It was previously
#    24px, which rendered channel names smaller than adjacent 26px-base text; 26px
#    brings it in line so cards no longer look out of place.
#  - mgr-check: emitted as ONE combined block below (layout-fixed box height + a
#    Text-Size-scaled glyph font-size) so the checkmark grows with Text Size while
#    the box tracks the column. Kept out of the auto group to avoid a duplicate
#    .mgr-check selector (dupcheck forbids one selector heading two blocks).
FONT_CAP = 52
EXPLICIT_FONT_SELECTORS = ['.onboard-title', '.pair-code', '.mgr-check', '.onboard-sub', '.pair-label', '.ch-card .ch-num', '.ch-card .ch-name']
control_set = set()
for c in TEXT_CONTROLS + SEALED_GRID_CELLS:
    for m in c.split(','):
        control_set.add(m.strip())
for c in EXPLICIT_FONT_SELECTORS:
    control_set.add(c.strip())

txt_fonts = {}   # base_px -> [selectors]  (scaled via --txt-scale)
seen = set()
for f in BASE_FILES:
    for sel, body in blocks('assets/css/%s.css' % f):
        base = None
        for d in body.split(';'):
            ds = d.strip()
            # Resolve the shared --glyph-size token (main.css :root) to its px value
            # so glyph font-sizes are collected and get a --txt-scale 720 override.
            ds = ds.replace('var(--glyph-size)', '30px')
            m = re.match(r'font-size:\s*calc\((\d+)px \* var\(--ui-scale', ds)
            if m:
                base = int(m.group(1)); break
            m2 = re.match(r'font-size:\s*(\d+)px\s*$', ds)
            if m2:
                base = int(m2.group(1)); break
        if base is None:
            continue
        if base > FONT_CAP:
            base = FONT_CAP
        members = [x.strip() for x in sel.split(',')]
        keep = [mm for mm in members if mm not in control_set]
        if not keep:
            continue
        key = tuple(keep)
        if key in seen:
            continue
        seen.add(key)
        txt_fonts.setdefault(base, []).append(', '.join(keep))

out = []
out.append("/* tv-720.css - 1280x720 viewport overrides.")
out.append(" * Active only under <html data-vp=\"720\"> (set in app.js boot() when the")
out.append(" * viewport is <=1366 wide). Inert on 1920 panels. Loaded LAST.")
out.append(" *")
out.append(" * DUAL SCALE: layout is pinned at %.3f (--ui-scale, the true 1080->720" % SCALE)
out.append(" * ratio) and never changes with Text Size, so the structure always fits the")
out.append(" * canvas. Text scales via --txt-scale, which starts at the same %.3f base and" % SCALE)
out.append(" * moves with the Text Size tiers, so text and text-controls grow/shrink with")
out.append(" * the setting while the layout holds. GENERATED by tools/gen-tv720.py -")
out.append(" * do not hand-edit. */")
out.append("")
out.append("/* Overscan safe area: inset the whole app so nothing lands in the ~5% edge")
out.append(" * zone many TVs crop. On by default for the store build (unknown hardware). */")
out.append('html[data-vp="720"] #app { box-sizing: border-box; padding: %s; }' % SAFE_INSET)
out.append("")
out.append("/* --ui-scale = LAYOUT (pinned 0.667, no Text-Size change). --txt-scale = TEXT")
out.append(" * (0.667 base x the Text Size tier). --content-pad pulled in harder (%.2f). */" % PAD_SCALE)
out.append('html[data-vp="720"] { --ui-scale: %.4f; --layout-scale: %.4f; --txt-scale: %.4f; --content-pad: %dpx; }' % (SCALE, SCALE, SCALE, round(60 * PAD_SCALE)))
for tier, mult in TIERS:
    out.append('html[data-vp="720"][data-text-size="%s"] { --txt-scale: %.4f; }' % (tier, SCALE * mult))
out.append("")
out.append("/* Text controls: box height/padding AND font follow the text scale together")
out.append(" * (as a unit), so a control grows with its own label and long localised text")
out.append(" * never clips inside a layout-fixed box. */")
out.append(',\n'.join(scope(c) for c in TEXT_CONTROLS))
out.append("{ --ui-scale: var(--txt-scale); }")
out.append("")
out.append("/* Sealed grid cells: these are .btn (so the rule above just gave them the")
out.append(" * text scale), but their column count depends on cell width vs container,")
out.append(" * so they must stay on the LAYOUT scale or the grid reflows (the PIN keypad")
out.append(" * dropped 3 columns to 2 at larger Text Sizes). Re-pin them to layout. */")
out.append(',\n'.join(scope(c) for c in SEALED_GRID_CELLS))
out.append("{ --ui-scale: %.4f; }" % SCALE)
out.append("")
out.append("/* Standalone text (titles, body, labels) not inside a control: scale the")
out.append(" * font via --txt-scale so it tracks the Text Size setting. */")
for base in sorted(txt_fonts):
    out.append(',\n'.join(scope(s) for s in txt_fonts[base]))
    out.append("{ font-size: calc(%dpx * var(--txt-scale)); }" % base)
    out.append("")
out.append("/* Fixed-px layout boxes that don't use --ui-scale. Mini player keeps 16:9")
out.append(" * (711x400 -> %dx%d). */" % (round(711 * SCALE), round(400 * SCALE)))
for sel, props in LAYOUT_FIXED:
    decls = ' '.join('%s: %dpx;' % (p, round(px * SCALE)) for p, px in props)
    out.append('%s { %s }' % (scope(sel), decls))
out.append("")
# Manager checkbox: ONE block so dupcheck stays happy. The BOX height is layout-fixed
# (tracks the column/row, 44*SCALE), but the CHECK GLYPH font-size scales with Text
# Size (--txt-scale) so the tick grows along with the header/filter/search text at
# larger Text Sizes on the 720 canvas (base 22px, matching screens.css).
out.append('html[data-vp="720"] .mgr-check { height: %dpx; font-size: calc(22px * var(--txt-scale, 1)); }' % round(44 * SCALE))
out.append("/* Modals must fit the 720-tall viewport: cap the card and scale its padding")
out.append(" * (40px is large on 720). The manager list panel then fills the available")
out.append(" * height so it shows many rows instead of the ~2 a fixed 374 left room for. */")
out.append('html[data-vp="720"] .modal-card { max-height: 92vh; padding: 24px; box-sizing: border-box; }')
# .lock-panel-wrap / .content-lock-wrap deliberately get NO 720 height override: the base
# rule (screens.css) is flex:1 1 auto so the list fills the space left by the 90vh-bounded
# .lock-mgr-modal-card and scrolls within, on 720 exactly as on the normal canvas. A fixed
# 720 height here would fight that base rule — the kind of override the CSS rules forbid.
# cat-mgr/content-lock data rows at 720: the fixed min-height:48px and 10px vertical
# padding (screens.css) left too much space around the scaled-down ~17px row text (rows
# looked over-spaced on-device). Scale the height (48->32) and trim vertical padding
# (10->6), keeping the 16px sides. One block to satisfy css-dupcheck.
out.append('html[data-vp="720"] .cat-mgr-list .cat-mgr-row, html[data-vp="720"] .content-lock-list .content-lock-row { min-height: 52px; padding-top: 6px; padding-bottom: 6px; }')
out.append('/* Header-to-rows gap scales with Text Size on 720 (base 7px on the shared list). */')
out.append('html[data-vp="720"] .lock-panel-list, html[data-vp="720"] .content-lock-list { padding-top: calc(7px * var(--txt-scale, 1)); }')
# Episode modal at 720: the series-level synopsis header was removed (issue 4), so there's
# no .series-info-plot to clamp here anymore; the modal is just season chips + episode grid.
out.append("")
out.append("/* Category/lock manager on 720: the modal width now comes straight from the")
out.append(" * base .lock-mgr-modal-card rule (1600px * --ui-scale), which resolves to about")
out.append(" * 1067px here on the pinned 0.667 layout scale - the same width the old explicit")
out.append(" * 720 override produced, so that override was redundant once the base became 1600")
out.append(" * and has been dropped. The content-lock manager still needs its own width (below)")
out.append(" * because it is narrower than the category manager. */")
out.append('/* Content-lock manager is narrower than the category manager (Content + Locked')
out.append(' * only, no order column) but must still be wide enough for its 4-up tools row')
out.append(' * (capped at 1168px*--txt-scale) to fit on one line at X-Large + long labels.')
out.append(' * 1520*0.667 = ~1014px card -> ~966px body, clears the ~944px the 4 Greek')
out.append(' * buttons need. Its own owner on 720. */')
out.append('html[data-vp="720"] .content-lock-modal-card { width: calc(1520px * var(--ui-scale, 1)); }')
out.append('/* Order-arrow column, buttons, and chevron glyph scale with Text Size on 720 via')
out.append(' * --txt-scale (base rules use --ui-scale, which is pinned on 720). Mirrors the base px.')
out.append(' * The filter bar\'s order-column SPACER is included so it grows in lockstep with the')
out.append(' * ORDER header/column above it - otherwise the spacer stayed layout-scaled (narrower')
out.append(' * at larger Text Size), which shifted the two filter buttons out from under their')
out.append(' * VISIBLE/LOCKED headers on the 720 canvas. */')
out.append('html[data-vp="720"] .lock-panel-header .cat-mgr-order-head,')
out.append('html[data-vp="720"] .cat-mgr-filterbar .cat-mgr-filter-order-spacer,')
out.append('html[data-vp="720"] .cat-mgr-row .cat-mgr-order-box { width: calc(200px * var(--txt-scale, 1)); min-width: calc(200px * var(--txt-scale, 1)); max-width: calc(200px * var(--txt-scale, 1)); flex: 0 0 calc(200px * var(--txt-scale, 1)); }')
out.append('html[data-vp="720"] .cat-mgr-row .cat-mgr-order-btn { width: calc(44px * var(--txt-scale, 1)); height: calc(44px * var(--txt-scale, 1)); min-width: calc(44px * var(--txt-scale, 1)); }')
out.append('html[data-vp="720"] .cat-mgr-row .cat-mgr-order-btn svg { width: calc(24px * var(--txt-scale, 1)); height: calc(24px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* Live channel column: 720-ONLY widen from 480 to 560 (base). On 720 the")
out.append(" * column width is --ui-scale-pinned (0.667) while the Manage Locks button")
out.append(" * text grows with --txt-scale, so at X-Large in the longest languages")
out.append(" * (Serbian 'Управљање закључавањима', Bulgarian, Macedonian) the button")
out.append(" * overflowed the column into the EPG timeline. 560*0.667 gives the column")
out.append(" * ~373px vs the widest button ~336px (measured, real font), clearing it with")
out.append(" * margin. 1080 already had room (button ~511 vs column 540) so it is left at")
out.append(" * the 480 base. Both paired members move together (they must stay equal -")
out.append(" * .live-channels-label header width == .live-epg-ch column width). */")
out.append('html[data-vp="720"] .live-epg-ch,')
out.append('html[data-vp="720"] .live-channels-label { width: calc(560px * var(--ui-scale, 1)); min-width: calc(560px * var(--ui-scale, 1)); max-width: calc(560px * var(--ui-scale, 1)); }')
out.append("")
out.append("/* M3U auth checkbox: grow with Text Size on 720 too. --ui-scale is layout-")
out.append(" * pinned on 720, so use --txt-scale (which tracks Text Size on 720). Matches")
out.append(" * the EPG-override checkbox size (40px*scale). 1080 keeps the base rule. */")
out.append('html[data-vp="720"] .auth-toggle-row.ct-check input[type="checkbox"] { width: calc(40px * var(--txt-scale, 1)); height: calc(40px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* Tools row height reservation on 720: old WebKit/Blink cannot size a wrapped flex row, so its height is reserved by hand (see the base rule for the")
out.append(" * wrap-flex container's height). The buttons are text-controls that grow with")
out.append(" * Text Size and wrap into more rows in long languages, so this reservation")
out.append(" * must scale with --txt-scale too - a layout-pinned height left the buttons")
out.append(" * overflowing onto the header at X-Large. Buttons are 4-up now, so the base")
out.append(" * heights are 126 (category = 8 btns / 2 rows) and 70 (content = 4 btns / 1 row).")
out.append(" * Tools row uses full width (no cap) so content-sized buttons wrap into as")
out.append(" * few rows as possible; min-height reserves the worst-case rows, scaled by")
out.append(" * --txt-scale (category up to 3 rows, content up to 2). */")
out.append('html[data-vp="720"] .cat-mgr-tools.lock-panel-tools { min-height: calc(126px * var(--txt-scale, 1)); max-width: calc(1200px * var(--txt-scale, 1)); }')
out.append('html[data-vp="720"] .content-lock-tools.lock-panel-tools { min-height: calc(70px * var(--txt-scale, 1)); max-width: calc(1200px * var(--txt-scale, 1)); }')
out.append('/* 4-buttons-per-row cap (max-width above, merged into the min-height block to keep')
out.append(' * one rule per selector for dupcheck). The base rule caps .cat-mgr-tools at')
out.append(' * calc(1168px * --ui-scale) so the row always wraps 4-up (280px basis + 12px margin')
out.append(' * = 292px footprint x 4 = 1168px). On 720 --ui-scale is layout-pinned, so the cap is')
out.append(' * re-emitted on --txt-scale to track the buttons, which scale with Text Size here.')
out.append(' * Without it the row fit 5 across at Normal but 4 at Extra-Large on 720. */')
out.append('/* Uniform button width scales with Text Size on 720 (base uses --ui-scale, pinned here).')
out.append(' * Scoped to the manager tools containers so it does not collide with the generic')
out.append(' * .lock-panel-tools .btn font-size group above (font-size is set there). */')
out.append('html[data-vp="720"] .cat-mgr-tools .btn, html[data-vp="720"] .content-lock-tools .btn { flex: 0 0 calc(280px * var(--txt-scale, 1)); height: calc(46px * var(--txt-scale, 1)); }')
out.append('/* Filter bar (search + two-line filter buttons) scales with Text Size on 720.')
out.append(' * l1/l2 font-size is handled by the generic font group above; only heights here. */')
out.append('html[data-vp="720"] .lock-mgr-filterbar .lock-mgr-search.field { height: calc(76px * var(--txt-scale, 1)); }')
out.append('/* Filter column: height scales with Text Size (--txt-scale). WIDTH must match the')
out.append(' * header cell + checkbox column, which are calc(165px * --ui-scale) = layout-pinned')
out.append(' * (0.667) on 720. The filter button is a .btn, so the text-controls rule above set')
out.append(' * --ui-scale = var(--txt-scale) on it - which made its 165px width resolve on the')
out.append(' * TEXT scale (wider than the header column at larger Text Sizes, so the two filter')
out.append(' * buttons drifted out from under their VISIBLE/LOCKED headers). Re-pin --ui-scale to')
out.append(' * the layout scale here so the width tracks the header/rows. One block per selector. */')
out.append('html[data-vp="720"] .lock-mgr-filterbar .cat-mgr-filter-col { height: calc(76px * var(--txt-scale, 1)); --ui-scale: %.4f; }' % SCALE)
# NOTE: l1/l2 font is intentionally NOT pinned here — the filter label lines scale
# with Text Size (--txt-scale, via the generic font group) so they track the search
# box beside them. The filter column is widened (shared column 165 -> 210px, see
# screens.css) so the largest text-scaled value still fits without ellipsis.
out.append("")
out.append("/* Expanded sidebar on 720: 300*0.667=200px is too narrow for long labels at")
out.append(" * larger Text Sizes (German \"Kindersicherung\" clipped and escaped the focus")
out.append(" * highlight, since the label scales with text but the width was layout-pinned).")
out.append(" * Widen to 250px so the label fits/wraps inside the highlight box. */")
out.append('html[data-vp="720"] .sidebar.expanded { width: 250px; }')
out.append('html[data-vp="720"] .sidebar.expanded .nav-btn { min-height: calc(68px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* Channel cards are uniform SQUARE grid tiles (all one size so rows aren't")
out.append(" * ragged), with overflow:hidden — so at larger Text Size the name/number")
out.append(" * would clip against the tile edge. Hold the card's internal text near the")
out.append(" * LAYOUT scale (not the text scale) so it stays inside the tile. CRITICAL:")
out.append(" * override BOTH width and height here on the SAME variable (--txt-scale) so")
out.append(" * the tile stays SQUARE and grows uniformly with Text Size. Earlier only the")
out.append(" * height was overridden (on --txt-scale) while the width fell through to the")
out.append(" * base rule (on --ui-scale, layout-pinned 0.667) — so the two axes scaled by")
out.append(" * different variables and the card rendered TALLER THAN WIDE at larger Text")
out.append(" * Size. The tile does NOT grow to fit content; a longer label is clipped,")
out.append(" * never re-sized. NB: these lines live in the generator (not a post-gen")
out.append(" * hand-edit) so they survive regeneration. */")
out.append('html[data-vp="720"] .ch-card .ch-num, html[data-vp="720"] .ch-card .ch-name { font-size: calc(26px * var(--txt-scale, 1)); }')
out.append('html[data-vp="720"] .ch-card { width: calc(300px * var(--txt-scale, 1)); height: calc(300px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* VOD poster card on 720: same dual-scale as .ch-card above — the tile")
out.append(" * dimensions follow --txt-scale (Text Size), not the pinned --ui-scale, so the")
out.append(" * poster grid grows with Text Size. The poster fills the tile (absolute inset)")
out.append(" * so no wrap-height override is needed, and the fallback title font-size is")
out.append(" * emitted automatically by the --txt-scale font pass above. 2:3 tile. */")
out.append('html[data-vp="720"] .vod-card { width: calc(220px * var(--txt-scale, 1)); height: calc(330px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* External-EPG modal: the Clear button (.epg-source-remove, a .btn) has its")
out.append(" * width rebound to --txt-scale via the .btn group above, so it grows with Text")
out.append(" * Size. The row reserves space for it with padding-right; that reservation must")
out.append(" * track the SAME --txt-scale, otherwise on 720 at large Text Size the growing")
out.append(" * button overlaps the input (the base rule uses --ui-scale, which is pinned on")
out.append(" * 720). Match the base 200px reservation under --txt-scale. */")
out.append('html[data-vp="720"] .epg-source-row { padding-right: calc(200px * var(--txt-scale, 1)); }')
out.append("")
out.append("/* Splash: the logo image AND its reserved container height must both scale")
out.append(" * for 720 (the container min-height is what reserves space up-front to avoid")
out.append(" * the decode reflow, so scaling only the image left the box over-tall). Keep")
out.append(" * the 640/606 source aspect: 260 / (640/606) = 246. */")
out.append('html[data-vp="720"] .splash-logo-img { width: 240px; height: 227px; }')
out.append('html[data-vp="720"] .splash-logo { min-height: 227px; margin-bottom: 24px; }')
out.append('html[data-vp="720"] .splash-bar { width: 187px; }')
out.append("")
out.append("/* Collapsed sidebar (53px) centres the icon close to the active-tab accent")
out.append(" * bar at left:0; pad it so the icon clears the bar. */")
out.append('html[data-vp="720"] .sidebar:not(.expanded) .nav-btn { padding-left: 6px; }')
out.append("")
out.append("/* Onboarding on 720. The hero fonts (title 104px, pair-code 96px) are sized")
out.append(" * for a 1080 hero; even at the 720 base scale the stacked left column")
out.append(" * (title+sub+code+4 buttons) exceeds 720px (839px in Greek at Normal), so")
out.append(" * center-align clipped the top and pushed buttons low. Give the hero elements")
out.append(" * explicit fit-for-720 sizes and tighten stacking so the column fits and can")
out.append(" * centre properly across languages and Text Sizes. */")
out.append('html[data-vp="720"] .onboarding-wrap { padding: 36px 60px; }')
out.append('html[data-vp="720"] .onboard-title { font-size: calc(70px * var(--txt-scale, 1)); margin-bottom: 12px; }')
out.append('html[data-vp="720"] .onboard-sub { font-size: calc(26px * var(--txt-scale, 1)); line-height: 1.35; margin-bottom: 18px; }')
out.append('html[data-vp="720"] .pair-code-box { padding: 16px 22px; margin-bottom: 18px; }')
out.append('html[data-vp="720"] .pair-label { margin-bottom: 6px; }')
out.append('html[data-vp="720"] .pair-code { font-size: calc(60px * var(--txt-scale, 1)); letter-spacing: 10px; }')
out.append('html[data-vp="720"] .onboard-actions { margin-top: 12px; }')

open('assets/css/tv-720.css', 'w').write("\n".join(out) + "\n")
print("generated tv-720.css (dual scale: layout %.3f, text %.3f base)" % (SCALE, SCALE))
print("  text-scaled font selectors:", sum(len(v) for v in txt_fonts.values()))
print("  text controls (unit-scaled):", len(TEXT_CONTROLS))
print("  fixed-px layout boxes:", len(LAYOUT_FIXED))
print("  mini-player: %dx%d (ratio %.3f)" % (round(711 * SCALE), round(400 * SCALE), 711 / 400))
