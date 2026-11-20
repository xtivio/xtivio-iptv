/* focus.js - TV Focus Engine v5
 * PURE sibling navigation within containers. NO geometric scanning.
 * All cross-container transitions handled by app.js handleArrow.
 */
var Focus = (function () {
    'use strict';

    var CURRENT = null;
    var SCOPE_STACK = [];

    /* ===== Focus chain (what Back walks) =====
     * A history of WHERE FOCUS HAS BEEN, kept by focus() itself so it works the
     * same for every screen, modal, input method (D-pad, tap, pointer) and
     * platform, with nothing per-screen or per-control to wire up.
     *
     * The UI is a set of REGIONS: the side menu, a modal, the on-screen
     * keyboard, a block inside a two-column panel (a column's header, its
     * list...), or otherwise the whole section/screen. Moving focus from one
     * region to another pushes the element you LEFT onto the chain. Moving
     * within a region (D-pad through a list, through settings rows) pushes
     * nothing, so Back never replays every step you scrolled past.
     *
     * back() pops to the most recent place you came from that is still there.
     * Returning to a region already on the chain by any route (arrow key, tap,
     * a modal restoring its opener) unwinds the chain to that point. Reaching
     * the side menu clears it: the side menu is the root, where Back is the
     * app's exit prompt rather than another step.
     */
    var CHAIN = [];
    var CHAIN_MAX = 60;
    var CHAIN_NAVIGATING = false; // true while back() itself moves focus (never recorded)
    var REGION_SEL = '#sidebar, #modalLayer, #vkeyboard, #exitDialog, .panel-col > *, .content-section, .screen';

    function regionOf(el) {
        try { return el && el.closest ? el.closest(REGION_SEL) : null; } catch (e) { return null; }
    }

    /* Only focus the USER puts somewhere belongs in the chain. The app also moves
     * focus by itself (a mini player claiming its button, a modal restoring its
     * opener, a section focusing its first item); recording those would put
     * places the user never chose into Back's path. A focus change counts as the
     * user's when it happens within a few ms of a real input event, i.e. inside
     * the handler for that key press / tap / click / pointer move. Focus set
     * later by a timer or a network response does not. The listeners are added
     * at load, in the capture phase on window, so they run before any handler
     * that reacts to the same input. */
    var LAST_INPUT_TS = 0;
    var USER_LAST = null; // the element the user most recently acted on / moved focus to
    function userInitiated() { return (Date.now() - LAST_INPUT_TS) < 60; }

    // The user is now "at" next. If that is a different region from where they
    // last were, remember where they came from.
    //
    // Two different questions, deliberately answered differently:
    //  - UNWINDING: is next in a region already on the chain? Then the user is
    //    back where they came from and everything after that point is stale. This
    //    applies to focus set BY THE APP too (a modal restoring its opener, a mini
    //    player handing focus back to the row), because that is exactly how a
    //    return happens when Back closes something. Skipping it left the chain
    //    holding places the user had already come back from, and Back then walked
    //    forward into them again.
    //  - PUSHING: only focus the user actually chose is recorded (see above), so
    //    app-driven focus never adds a place to Back's path.
    function userMove(next) {
        if (!next) return;
        if (CHAIN_NAVIGATING) { USER_LAST = next; return; }
        var rn = regionOf(next);
        if (rn && rn.id !== 'sidebar') {
            for (var u = CHAIN.length - 1; u >= 0; u--) {
                if (CHAIN[u].region === rn) { CHAIN.length = u; USER_LAST = next; return; }
            }
        }
        if (!userInitiated()) return;
        var from = (USER_LAST && document.body.contains(USER_LAST)) ? USER_LAST : null;
        USER_LAST = next;
        if (!from || from === next) return;
        var rp = regionOf(from);
        if (!rp || !rn || rp === rn) return;
        if (rn.id === 'sidebar') { CHAIN.length = 0; return; }
        CHAIN.push({ el: from, key: from.getAttribute ? from.getAttribute('data-focus-key') : null, region: rp });
        if (CHAIN.length > CHAIN_MAX) CHAIN.shift();
    }

    function noteInput(ev) {
        LAST_INPUT_TS = Date.now();
        // A key press while something is focused is the user acting at that element,
        // even if the app (not the user) is what put focus there.
        // Back keys are excluded: pressing Back is not "acting at" the focused
        // element, it is asking to leave it.
        if (ev && ev.type === 'keydown' && CURRENT && !isBackKey(ev)) userMove(CURRENT);
    }
    function isBackKey(ev) {
        var c = ev.keyCode || ev.which;
        var k = ev.key;
        return c === 27 || c === 8 || c === 4 || c === 461 || c === 10009 ||
            k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack' || k === 'XF86Back';
    }
    (function () {
        var evs = ['keydown', 'mousedown', 'mouseover', 'touchstart', 'pointerdown', 'click'];
        for (var i = 0; i < evs.length; i++) {
            try { window.addEventListener(evs[i], noteInput, true); } catch (e) {}
        }
    })();

    /* Move focus to the most recent place still on the chain. Returns false when
     * there is nowhere to go, so the caller can fall back to its own handling. */
    function back() {
        var cur = CURRENT;
        var rc = regionOf(cur);
        while (CHAIN.length) {
            var e = CHAIN.pop();
            var el = e.el;
            if (!el || !document.body.contains(el) || !isVisible(el)) {
                // The element was re-rendered since; find its replacement by key.
                el = e.key ? document.querySelector('.focusable[data-focus-key="' + e.key + '"]') : null;
                if (!el || !isVisible(el)) continue;
            }
            if (el === cur || regionOf(el) === rc) continue;
            var landing = regionOf(el);
            CHAIN_NAVIGATING = true;
            try { focus(el); } finally { CHAIN_NAVIGATING = false; }
            if (landing && landing.id === 'sidebar') CHAIN.length = 0;
            return true;
        }
        return false;
    }
    var CHANGE_CBS = [];

    function root() {
        return SCOPE_STACK.length ? SCOPE_STACK[SCOPE_STACK.length - 1] : document.body;
    }

    function isVisible(el) {
        if (!el || el.disabled) return false;
        if (!el.offsetParent && el.tagName !== 'BODY') return false;
        if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return false;
        var p = el.parentNode;
        while (p && p.nodeType === 1 && p !== document.body) {
            if (p.classList) {
                if (p.classList.contains('hidden')) return false;
                if (p.classList.contains('screen') && !p.classList.contains('active')) return false;
                if (p.classList.contains('content-section') && !p.classList.contains('active')) return false;
            }
            p = p.parentNode;
        }
        return true;
    }

    /* Find next/prev visible .focusable sibling */
    function nextSibling(el) {
        var n = el.nextElementSibling;
        while (n) {
            if (n.classList && n.classList.contains('focusable') && isVisible(n)) return n;
            n = n.nextElementSibling;
        }
        return null;
    }
    function prevSibling(el) {
        var n = el.previousElementSibling;
        while (n) {
            if (n.classList && n.classList.contains('focusable') && isVisible(n)) return n;
            n = n.previousElementSibling;
        }
        return null;
    }

    /* Move within the immediate sibling list.
     * dir = 'next' or 'prev'
     * Returns true if moved, false if at edge. */
    function moveSibling(dir) {
        if (!CURRENT) return false;
        var target = (dir === 'next') ? nextSibling(CURRENT) : prevSibling(CURRENT);
        if (target) { focus(target); return true; }
        return false;
    }

    /* Move to the Nth next/prev sibling (for grid column jumping) */
    function moveSiblingBy(dir, count) {
        if (!CURRENT) return false;
        var el = CURRENT;
        for (var i = 0; i < count; i++) {
            var next = (dir === 'next') ? nextSibling(el) : prevSibling(el);
            if (!next) return false; // not enough siblings
            el = next;
        }
        focus(el);
        return true;
    }

    /* Focus a specific element */
    /* Remove the .focused class from every focusable except keep. Guards
     * against more than one element being highlighted at once, which can happen
     * across scope pushes / focus-restore timing. Cheap; runs only on focus
     * changes. */
    function clearStaleFocus(keep) {
        var lit = document.querySelectorAll('.focusable.focused');
        for (var i = 0; i < lit.length; i++) {
            if (lit[i] !== keep) lit[i].classList.remove('focused');
        }
    }

    function focus(el) {
        if (el && el === CURRENT) userMove(el); // a tap on the already-focused element still counts
        if (!el || el === CURRENT) {
            // Even on a no-op (re-focusing CURRENT), make sure no OTHER element
            // is left with a stale .focused class — focus restore paths
            // (pushScope auto-focus, player open/close) can leave a second
            // element highlighted while CURRENT points elsewhere.
            if (el && el === CURRENT) clearStaleFocus(el);
            return false;
        }
        var prev = CURRENT;
        if (prev) {
            prev.classList.remove('focused');
            try { prev.blur(); } catch (e) {}
        }
        // Sweep up any other element still carrying .focused (defensive: there
        // should only ever be one, but restore/scope transitions can leave a
        // straggler that prev/CURRENT no longer points at).
        clearStaleFocus(el);
        CURRENT = el;
        CURRENT.classList.add('focused');
        userMove(el);
        // Don't give native browser focus to readonly inputs — prevents system IME/keyboard
        var isReadonly = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.hasAttribute('readonly');
        if (!isReadonly) {
            try { el.focus({ preventScroll: true }); } catch (e) {
                try { el.focus(); } catch (e2) {}
            }
        }
        // Scroll: center the focused element
        // Skip for EPG section (uses its own scroll) and for the PLAYER screen.
        //
        // The player is a fixed, full-bleed stage: the video fills it and the
        // controls sit on top. Centering a focused element there makes the browser
        // scroll the whole screen to bring the seek bar / overlay buttons to the
        // middle, which visibly pushes the video up the moment you press D-pad
        // down. Nothing on the player needs scrolling into view — every control is
        // already on screen — so the scroll is pure damage. focus({preventScroll})
        // above stops the FOCUS from scrolling, but this explicit call would undo
        // that, which is why the guard has to cover both.
        var inSelfScroll = false;
        var inPlayer = false;
        try {
            var ps = el.closest ? el.closest('#player, .player-stage') : null;
            if (ps) {
                inPlayer = true;
            } else {
                var pn = el.parentNode;
                while (pn && pn !== document.body) {
                    if (pn.id === 'player' ||
                        (pn.classList && pn.classList.contains('player-stage'))) {
                        inPlayer = true; break;
                    }
                    pn = pn.parentNode;
                }
            }
        } catch (ep0) {}
        try {
            // EPG and Live TV both manage their own internal scroll (.livetv-scroll
            // for Live TV; the EPG grid for the guide), and both have a mini
            // player / fixed region pinned at the top. Centring a focused element
            // there makes the browser scroll the section — or an ancestor — to
            // bring e.g. a channel row or the expand/stop button to the middle,
            // which drags the pinned mini player UP off the top (measured as
            // rect.top -113 while section.scrollTop stayed 0: an ancestor scrolled,
            // not the section). Neither section needs anything scrolled into view,
            // so exempt both. Match on the section-content attribute so it covers
            // every focusable inside, not just the ones we remembered to tag.
            var selfScrollSection = el.closest
                ? el.closest('[data-section-content="livetv"]')
                : null;
            if (selfScrollSection) {
                inSelfScroll = true;
            } else {
                var pp = el.parentNode;
                while (pp && pp !== document.body) {
                    if (pp.getAttribute) {
                        var sc = pp.getAttribute('data-section-content');
                        if (sc === 'livetv') { inSelfScroll = true; break; }
                    }
                    pp = pp.parentNode;
                }
            }
        } catch (e3) {}

        if (inPlayer) {
            // Player: as a rule, never scroll — focusing a transport button must not
            // drag the video stage around. EXCEPTION: the mini channel list
            // (.mini-list) is a scrollable list living inside the player, and its
            // rows below the fold must be brought into view or D-pad down walks focus
            // onto an off-screen row and it visually "disappears". So if the focused
            // element is inside a .mini-list, scroll ONLY that container (same
            // centering used for the Live TV self-scroll case); everything else in
            // the player still scrolls nothing.
            try {
                var miniScroll = el.closest ? el.closest('.mini-list') : null;
                if (miniScroll && miniScroll.scrollHeight > miniScroll.clientHeight + 5) {
                    var mr = el.getBoundingClientRect();
                    var mcr = miniScroll.getBoundingClientRect();
                    if (mr.top < mcr.top || mr.bottom > mcr.bottom) {
                        var moff = miniScroll.scrollTop + (mr.top - mcr.top)
                            - Math.floor(miniScroll.clientHeight / 2)
                            + Math.floor(mr.height / 2);
                        miniScroll.scrollTop = Math.max(0, moff);
                    }
                }
            } catch (eMini) {}
            fireChange(prev, CURRENT);
            return true;
        }

        if (inSelfScroll) {
            // EPG / Live TV manage their own scroll and have a pinned region at the
            // top (the mini player). We must STILL scroll the focused row into view
            // — otherwise D-pad down cannot reach rows below the fold — but we must
            // scroll ONLY the inner scroll container (.panel-ch-list / .livetv-scroll
            // / the cat list), never the section or an ancestor. A plain
            // scrollIntoView bubbles up and scrolls whichever ancestor is
            // scrollable, which on Live TV dragged the pinned mini player off the
            // top (measured rect.top -113 with section.scrollTop 0). So find the
            // nearest scrollable ancestor, and only scroll it if it is INSIDE the
            // self-managed section (i.e. not the section itself and not something
            // above it). This keeps row navigation working while the mini player
            // stays pinned.
            try {
                var sec = el.closest
                    ? el.closest('[data-section-content="livetv"]')
                    : null;
                var sp = el.parentNode;
                while (sp && sp !== document.body && sp !== sec) {
                    if (sp.scrollHeight > sp.clientHeight + 5) {
                        var r = el.getBoundingClientRect();
                        var cr = sp.getBoundingClientRect();
                        // Only move if the element is outside the container's visible
                        // band; centre it within the container when it is.
                        if (r.top < cr.top || r.bottom > cr.bottom) {
                            var offset = sp.scrollTop + (r.top - cr.top)
                                - Math.floor(sp.clientHeight / 2)
                                + Math.floor(r.height / 2);
                            sp.scrollTop = Math.max(0, offset);
                        }
                        break;
                    }
                    sp = sp.parentNode;
                }
            } catch (eScroll) {}
            fireChange(prev, CURRENT);
            return true;
        }

        if (!inSelfScroll && !inPlayer) {
            scrollElemIntoView(el);
        }
        fireChange(prev, CURRENT);
        return true;
    }

    /* General scroll-into-view: the ONE implementation, used by focus() and by
     * anything that needs to reveal an element in its scroll container (e.g. the
     * settings Text-Size-change handler, which can't go through focus() because
     * the element is already CURRENT). Finds the nearest scrollable ancestor,
     * and: does nothing if the element is already fully visible EXCEPT when it is
     * the last focusable with trailing content still below the fold (then reveals
     * that); snaps to top when near the container top; bottom-aligns instead of
     * centring when centring would clip the bottom; else centres. Everything is
     * rect-based so it is correct at any --ui-scale (Text Size) — this is what used
     * to "just work" before scaling and now does again generally, rather than via
     * per-screen handlers. */
    function scrollElemIntoView(el) {
        if (!el) return;
        try {
            var already = false;
            var tooTall = false;
            var vp = el.parentNode;
            while (vp && vp !== document.body) {
                if (vp.scrollHeight > vp.clientHeight + 5) {
                    var er = el.getBoundingClientRect();
                    var vr = vp.getBoundingClientRect();
                    already = (er.top >= vr.top && er.bottom <= vr.bottom);
                    // An element TALLER than its container cannot be centred without
                    // pushing its own top off the top of the view (home hero at large
                    // Text Size). Align such elements to their TOP instead.
                    tooTall = (er.height > vr.height);
                    break;
                }
                vp = vp.parentNode;
            }
            if (already) {
                // Already fully visible — but two SYMMETRIC cases still need a
                // scroll, so leading/trailing non-focusable content is revealed:
                // (a) FIRST focusable with content ABOVE it off the top (home hero's
                //     "totals" chips above the hero; a section header above the first
                //     row). Scroll UP to reveal it, capped so the element stays on
                //     screen. Mirror of (b).
                // (b) LAST focusable with content BELOW it under the fold (settings
                //     coffee card). Scroll DOWN to reveal it, capped so the element
                //     stays on screen.
                // Both rect-based, so correct at any --ui-scale, and symmetric:
                // reaching the first item shows everything above it, reaching the
                // last item shows everything below it.
                try {
                    if (vp && vp !== document.body) {
                        var focusablesA = vp.querySelectorAll('.focusable');
                        var firstFocusable = focusablesA.length ? focusablesA[0] : null;
                        var lastFocusable = focusablesA.length
                            ? focusablesA[focusablesA.length - 1] : null;
                        var maxA = vp.scrollHeight - vp.clientHeight;
                        var erA = el.getBoundingClientRect();
                        var vrA = vp.getBoundingClientRect();
                        if (firstFocusable === el && vp.scrollTop > 0 && !tooTall
                            && erA.height < vp.clientHeight) {
                            // (a) UP: element is the first focusable and fits in the
                            // viewport, so scrolling to the top reveals everything
                            // above it while keeping it visible. Mirror of (b).
                            vp.scrollTop = 0;
                        } else if (lastFocusable === el && vp.scrollTop < maxA - 1) {
                            // (b) DOWN: reveal content below. Scroll to the bottom, but
                            // keep the element's own height on screen.
                            var elTopInView = erA.top - vrA.top;
                            var maxKeepVisible = elTopInView + erA.height - 1;
                            var extra = Math.min(maxA - vp.scrollTop, Math.max(0, maxKeepVisible));
                            if (extra > 1) vp.scrollTop = vp.scrollTop + extra;
                        }
                    }
                } catch (eTrail) {}
            }
            if (!already) {
                // Near the top of the container's CONTENT: snap to top so anything
                // above the first row (home hero above the first card row) is shown
                // in full instead of centring the row and half-cutting the hero.
                // BUT only if the focused element itself stays FULLY visible after
                // snapping — when the hero is tall (X-Large), scrollTop:0 pushes the
                // first card row to/below the fold and only half the focused card
                // shows. In that case don't snap; fall through to normal positioning
                // so the card the user navigated to is fully visible.
                var snapTop = false;
                try {
                    if (vp && vp !== document.body) {
                        var eTop = 0, node = el;
                        while (node && node !== vp) { eTop += node.offsetTop || 0; node = node.offsetParent; }
                        // After snapping to 0, the element's top is at eTop and its
                        // bottom at eTop+height (in content coords). It stays fully
                        // visible iff that bottom fits within the viewport height.
                        var elH = el.getBoundingClientRect().height;
                        snapTop = (eTop < vp.clientHeight) && !tooTall
                            && (eTop + elH <= vp.clientHeight);
                    }
                } catch (eSt) {}
                if (snapTop) {
                    vp.scrollTop = 0;
                } else if (vp && vp !== document.body) {
                    // If NOTHING focusable sits below this element (it's in the last
                    // focusable row — e.g. Save or Cancel, which share a row), scroll to
                    // the absolute bottom (scrollHeight). Bottom-aligning to the viewport
                    // edge stops as soon as the element's bottom touches the wrap bottom,
                    // leaving trailing non-focusable content (the manual-entry spacer, the
                    // wrap's bottom padding) unrevealed — so the button sat at the clip
                    // edge and D-pad appeared not to scroll all the way (mouse scroll did,
                    // because it goes to scrollHeight). Checking "nothing focusable below"
                    // (not "is the last focusable") covers every button in the last row.
                    var focusableBelow = false;
                    try {
                        var fl = vp.querySelectorAll('.focusable');
                        var elBottom = el.getBoundingClientRect().bottom;
                        for (var fi = 0; fi < fl.length; fi++) {
                            if (fl[fi] === el) continue;
                            if (fl[fi].getBoundingClientRect().top >= elBottom - 1) { focusableBelow = true; break; }
                        }
                    } catch (eLf) {}
                    var maxScroll = vp.scrollHeight - vp.clientHeight;
                    if (!focusableBelow) {
                        vp.scrollTop = maxScroll;
                    } else {
                        // Compute the centre target so we can detect when centring would
                        // want a scrollTop past the container max (near the bottom): the
                        // browser would clamp and leave the element's bottom below the
                        // fold. Bottom-align in that case; else centre.
                        var er2 = el.getBoundingClientRect();
                        var vr2 = vp.getBoundingClientRect();
                        var wantCenter = vp.scrollTop + (er2.top - vr2.top)
                            - Math.floor(vp.clientHeight / 2) + Math.floor(er2.height / 2);
                        if (wantCenter > maxScroll) {
                            var wantBottom = vp.scrollTop + (er2.bottom - vr2.bottom);
                            vp.scrollTop = Math.max(0, Math.min(wantBottom, maxScroll));
                        } else {
                            vp.scrollTop = Math.max(0, wantCenter);
                        }
                    }
                } else {
                    el.scrollIntoView({
                        behavior: 'auto',
                        block: tooTall ? 'start' : 'center',
                        inline: 'nearest'
                    });
                }
            }
        } catch (e) {
            try {
                var sp = el.parentNode;
                while (sp && sp !== document.body) {
                    if (sp.scrollHeight > sp.clientHeight + 5) {
                        var offset = (el.offsetHeight > sp.offsetHeight)
                            ? el.offsetTop
                            : el.offsetTop - Math.floor(sp.offsetHeight / 2) + Math.floor(el.offsetHeight / 2);
                        sp.scrollTop = Math.max(0, offset);
                        break;
                    }
                    sp = sp.parentNode;
                }
            } catch (e2) {}
        }
    }

    /* Focus first visible .focusable in a container */
    function focusFirstIn(rootEl) {
        rootEl = rootEl || root();
        var nodes = rootEl.querySelectorAll('.focusable');
        for (var i = 0; i < nodes.length; i++) {
            if (isVisible(nodes[i])) { focus(nodes[i]); return true; }
        }
        return false;
    }

    /* Focus last visible .focusable in a container */
    function focusLastIn(rootEl) {
        rootEl = rootEl || root();
        var nodes = rootEl.querySelectorAll('.focusable');
        for (var i = nodes.length - 1; i >= 0; i--) {
            if (isVisible(nodes[i])) { focus(nodes[i]); return true; }
        }
        return false;
    }

    /* Focus by data-focus-key */
    function focusKey(key) {
        if (!key) return false;
        var r = root();
        var el = r.querySelector('.focusable[data-focus-key="' + key + '"]');
        if (el && isVisible(el)) { focus(el); return true; }
        return false;
    }

    /* Find the nearest .focusable in a container that is roughly in the same column */
    function focusNearestInContainer(container, dir) {
        if (!CURRENT || !container) return false;
        /* Explicit override. If the current element has
         * data-focus-{up|down|left|right}, jump to that focus-key
         * directly (bypassing spatial nav). Falls back to spatial nav
         * if the attribute isn't set or the target isn't visible. */
        var overrideAttr = 'data-focus-' + dir;
        var overrideKey = CURRENT.getAttribute && CURRENT.getAttribute(overrideAttr);
        if (overrideKey) {
            // Sentinel: make this direction a dead-end (block movement) so focus
            // can't escape to a neighbouring column/list.
            if (overrideKey === '__none__') return true;
            var r0 = root();
            var target = r0.querySelector('.focusable[data-focus-key="' + overrideKey + '"]');
            if (target && isVisible(target)) {
                focus(target);
                return true;
            }
        }
        var srcRect = CURRENT.getBoundingClientRect();
        var srcCx = srcRect.left + srcRect.width / 2;
        var srcCy = srcRect.top + srcRect.height / 2;
        var items = container.querySelectorAll('.focusable');
        var best = null, bestScore = Infinity;
        /* Cost guard for very large containers (the category manager builds ~6
         * focusable buttons per row and can have 350+ rows = 2000+ elements).
         * The loop below calls getBoundingClientRect() AND isVisible() on every
         * candidate, and both force layout — so a single D-pad press was doing
         * thousands of layout reads, which is what made focus feel slow there and
         * nowhere else. Elements far from the source in DOM order are also far on
         * screen in these uniform grid/list layouts, so we can skip most of them
         * without measuring: only consider a window of candidates around the
         * source's own index. The window is generous (400 elements ~ 66 manager
         * rows) so real neighbours are never missed, and the guard only engages
         * when the container is big enough for it to matter. */
        var scanFrom = 0, scanTo = items.length;
        if (items.length > 600) {
            var srcIdx = -1;
            for (var si = 0; si < items.length; si++) {
                if (items[si] === CURRENT) { srcIdx = si; break; }
            }
            if (srcIdx !== -1) {
                scanFrom = Math.max(0, srcIdx - 400);
                scanTo = Math.min(items.length, srcIdx + 400);
            }
        }

        /* Directional-projection scoring (the model used by Chrome/TV
         * spatial navigation). Instead of center-to-center distance,
         * we measure:
         *   dist    — gap from the source's leading edge in the travel
         *             direction to the candidate's near edge. Edge-based
         *             so element size doesn't distort adjacency.
         *   overlap — how much the candidate's perpendicular extent
         *             overlaps the source's. Positive => candidate sits
         *             "in the beam" projected forward; <= 0 => off-axis.
         * A candidate in the beam is always preferred over one outside
         * it. Within each group we rank by dist (plus a tiny perpendicular
         * tie-break). Off-axis candidates carry a penalty proportional to
         * how far off-axis they are, so they're only chosen when nothing
         * is aligned. No hand-tuned weighting constant. */
        for (var i = scanFrom; i < scanTo; i++) {
            if (items[i] === CURRENT || !isVisible(items[i])) continue;
            var r = items[i].getBoundingClientRect();

            var dist, overlap, offAxis, inBeam, score;
            if (dir === 'down' || dir === 'up') {
                // Require the candidate to clear the source's vertical midpoint in
                // the travel direction. This makes pure side-by-side siblings (same
                // row, ~equal tops) a true no-op for up/down instead of being picked
                // as an off-axis candidate — up/down between two horizontal buttons
                // should not move focus sideways.
                var srcMidY = srcRect.top + srcRect.height / 2;
                if (dir === 'down') {
                    if (r.top < srcMidY) continue; // must be clearly below
                    dist = r.top - srcRect.bottom;
                } else {
                    if (r.bottom > srcMidY) continue; // must be clearly above
                    dist = srcRect.top - r.bottom;
                }
                if (dist < 0) dist = 0;
                // Horizontal overlap of the two boxes.
                var oL = Math.max(srcRect.left, r.left);
                var oR = Math.min(srcRect.right, r.right);
                overlap = oR - oL;
                inBeam = overlap > 0;
                // Perpendicular gap between nearest horizontal edges.
                offAxis = inBeam ? 0 :
                    (r.left > srcRect.right ? r.left - srcRect.right : srcRect.left - r.right);
            } else {
                var srcMidX = srcRect.left + srcRect.width / 2;
                if (dir === 'right') {
                    if (r.left < srcMidX) continue; // must be clearly right
                    dist = r.left - srcRect.right;
                } else {
                    if (r.right > srcMidX) continue; // must be clearly left
                    dist = srcRect.left - r.right;
                }
                if (dist < 0) dist = 0;
                // Vertical overlap of the two boxes.
                var oT = Math.max(srcRect.top, r.top);
                var oB = Math.min(srcRect.bottom, r.bottom);
                overlap = oB - oT;
                inBeam = overlap > 0;
                offAxis = inBeam ? 0 :
                    (r.top > srcRect.bottom ? r.top - srcRect.bottom : srcRect.top - r.bottom);
            }

            /* In-beam candidates score on travel distance plus a tiny
             * perpendicular center delta as a stable tie-break. Off-axis
             * candidates add a large penalty (the off-axis gap, weighted
             * so any in-beam candidate wins) — derived from geometry, not
             * a magic constant. */
            var rCx = r.left + r.width / 2;
            var rCy = r.top + r.height / 2;
            var perpDelta = (dir === 'up' || dir === 'down')
                ? Math.abs(rCx - srcCx) : Math.abs(rCy - srcCy);
            if (inBeam) {
                score = dist + perpDelta * 0.05;
            } else {
                // Off-axis: heavily penalised. The base (100000) guarantees
                // every in-beam candidate ranks ahead; among off-axis ones
                // we still prefer the closest by combined gap.
                score = 100000 + offAxis * 2 + dist;
            }

            if (score < bestScore) { bestScore = score; best = items[i]; }
        }
        if (best) { focus(best); return true; }
        return false;
    }

    /* General-purpose spatial navigation. A thin wrapper over
     * focusNearestInContainer that resolves a sensible default scope so
     * callers don't have to hand-wire which container to search. This is
     * the root-cause fix for "element not explicitly mapped has no
     * navigation": any .focusable placed anywhere inside the active
     * scope becomes reachable by geometry alone.
     *
     *   dir   — 'up' | 'down' | 'left' | 'right'
     *   scope — optional Element or selector string. If omitted, resolves
     *           to the active section/screen containing CURRENT, falling
     *           back to the current focus root.
     *
     * Returns true if focus moved. Override attributes (data-focus-*)
     * are still honoured because the scoring function checks them first. */
    function resolveScope(scope) {
        if (scope) {
            if (typeof scope === 'string') {
                return document.querySelector(scope) || root();
            }
            if (scope.nodeType === 1) return scope;
        }
        // A filter/list PICKER opened with overlay:true stacks inside #modalLayer on
        // top of an underlying modal (e.g. a parental manager). Its rows and the
        // manager's rows are all .focusable in the same section, so without scoping
        // here, spatial D-pad nav could score a manager row BEHIND the overlay and
        // move focus there (focus "goes behind" the picker). While a pick overlay is
        // present, confine navigation to it. Walk up from CURRENT so a stray CURRENT
        // outside the overlay still resolves correctly if the overlay exists.
        var ov = CURRENT;
        while (ov && ov.nodeType === 1 && ov !== document.body) {
            if (ov.classList && ov.classList.contains('modal-pick-overlay')) return ov;
            ov = ov.parentNode;
        }
        var anyOverlay = document.querySelector('.modal-pick-overlay');
        if (anyOverlay) return anyOverlay;
        // Walk up from CURRENT to the nearest active section/screen.
        var p = CURRENT;
        while (p && p.nodeType === 1 && p !== document.body) {
            if (p.classList &&
                (p.classList.contains('content-section') || p.classList.contains('screen')) &&
                p.classList.contains('active')) {
                return p;
            }
            p = p.parentNode;
        }
        return root();
    }

    function spatial(dir, scope) {
        if (!CURRENT) return false;
        var container = resolveScope(scope);
        if (!container) return false;
        return focusNearestInContainer(container, dir);
    }
    function pushScope(rootEl) { if (!rootEl) return; SCOPE_STACK.push(rootEl); focusFirstIn(rootEl); }
    function popScope() { if (!SCOPE_STACK.length) return; SCOPE_STACK.pop(); }
    function refresh() {
        if (!CURRENT) return;
        if (!document.body.contains(CURRENT)) { CURRENT = null; return; }
        // If focus is inside an open modal layer and still attached, keep it even
        // if a transient visibility check fails (overflow-auto columns or mid-
        // render can briefly report offsetParent null), which otherwise made the
        // highlight vanish on its own.
        var ml = document.getElementById('modalLayer');
        if (ml && !ml.classList.contains('hidden') && ml.contains(CURRENT)) {
            return;
        }
        if (!isVisible(CURRENT)) { CURRENT = null; }
    }

    /* Returns the currently-focused element (or null). This accessor was
     * referenced by the public export (current: current) and called as
     * Focus.current() throughout app.js, but its definition was missing
     * from the module. Older WebOS engines left the export value as
     * undefined rather than throwing; Tizen's stricter engine throws a
     * ReferenceError at module-evaluation time, which prevented Focus
     * from being defined at all and cascaded into the ui.js/app.js
     * 'onChange' of undefined errors. Defining it fixes the whole chain. */
    function current() { return CURRENT; }

    function onChange(cb) { if (typeof cb === 'function') CHANGE_CBS.push(cb); }
    function offChange(cb) {
        for (var i = 0; i < CHANGE_CBS.length; i++) {
            if (CHANGE_CBS[i] === cb) { CHANGE_CBS.splice(i, 1); return; }
        }
    }
    function fireChange(prev, curr) {
        for (var i = 0; i < CHANGE_CBS.length; i++) {
            try { CHANGE_CBS[i](prev, curr); } catch (e) {}
        }
    }

    function init() {
        // Click handler for all focusable elements
        document.addEventListener('click', function (e) {
            var t = e.target;
            while (t && t !== document.body) {
                if (t.classList && t.classList.contains('focusable')) { focus(t); return; }
                t = t.parentNode;
            }
        }, true);

        // Track whether the user is currently driving
        // with the D-pad/keyboard or with the Magic Remote pointer.
        // When a parked pointer's hidden cursor sits over the DOM and a
        // D-pad press scrolls content beneath it, the browser fires
        // synthetic mouseover events that yank focus away from the
        // D-pad target. We suppress hover-focus while the last input
        // was a key. body.mouse-hidden also hides the cursor via CSS.
        var lastInputType = 'mouse';
        document.addEventListener('keydown', function () {
            lastInputType = 'key';
            document.body.classList.add('mouse-hidden');
        }, true);
        // Real pointer movement clears the key state. Ignore 0-pixel
        // synthetic moves (which some webOS builds emit alongside the
        // bogus mouseover).
        document.addEventListener('mousemove', function (e) {
            if (e.movementX === 0 && e.movementY === 0) return;
            lastInputType = 'mouse';
            document.body.classList.remove('mouse-hidden');
        }, true);

        // A finger tap makes the browser fire compatibility mouse events (mouseover,
        // mousedown, click) AFTER touchend. Hover-focus on that mouseover scrolls
        // the focused row to the centre of its list when it was partly clipped, so
        // the content moves under the finger before mousedown/click are hit-tested
        // and the tap lands on a different row (the middle one) or on nothing.
        // Touch has no hover, so mouseover that follows a touch is ignored; the
        // click handler above still focuses the tapped element. Touch times are
        // recorded on touchstart and touchend (capture) so a long press counts too.
        var lastTouchAt = 0;
        var markTouch = function () { lastTouchAt = Date.now(); };
        document.addEventListener('touchstart', markTouch, { capture: true, passive: true });
        document.addEventListener('touchend', markTouch, { capture: true, passive: true });

        // Magic remote / mouse pointer support — hover focuses elements
        document.addEventListener('mouseover', function (e) {
            if (Date.now() - lastTouchAt < 1000) return;
            var ml = document.getElementById('modalLayer');
            var modalOpen = ml && !ml.classList.contains('hidden');
            // The on-screen keyboard is a sibling of the modal layer (its own focus
            // scope), so it is NOT inside #modalLayer. Track it separately so the
            // modal-scoping guard below doesn't reject hover onto its keys.
            var vk = document.getElementById('vkeyboard');
            var vkOpen = vk && !vk.classList.contains('hidden');
            // Normally ignore hover while on the D-pad (parked cursor mustn't steal
            // focus). But WebOS's magic-remote pointer can fire mouseover WITHOUT a
            // preceding non-zero mousemove, leaving lastInputType stuck on 'key'. If
            // the mouse cursor is currently visible (pointer in use), or we're in a
            // modal / keyboard where pointer interaction is intentional, treat as mouse.
            if (lastInputType === 'key') {
                var cursorVisible = !document.body.classList.contains('mouse-hidden');
                if (!cursorVisible && !modalOpen && !vkOpen) return;
                lastInputType = 'mouse';
            }
            var t = e.target;
            while (t && t !== document.body) {
                if (t.classList && t.classList.contains('focusable') && isVisible(t)) {
                    // When the keyboard is open it owns focus — allow hover onto its
                    // keys (which live outside the modal layer) and reject elsewhere.
                    if (vkOpen) {
                        if (vk.contains(t)) { focus(t); return; }
                        return;
                    }
                    if (modalOpen && !ml.contains(t)) return; // outside the modal — ignore
                    focus(t);
                    return;
                }
                t = t.parentNode;
            }
        }, false);

        setTimeout(function () { focusFirstIn(root()); }, 50);
    }

    function blur() {
        if (CURRENT) {
            CURRENT.classList.remove('focused');
            try { CURRENT.blur(); } catch (e) {}
            CURRENT = null;
        }
    }

    return {
        init: init,
        focus: focus,
        blur: blur,
        scrollIntoView: scrollElemIntoView,
        focusKey: focusKey,
        focusFirstIn: focusFirstIn,
        focusLastIn: focusLastIn,
        focusNearestInContainer: focusNearestInContainer,
        spatial: spatial,
        moveSibling: moveSibling,
        moveSiblingBy: moveSiblingBy,
        nextVisibleSibling: nextSibling,
        prevVisibleSibling: prevSibling,
        current: current,
        back: back,
        _dbg: function () { return { chain: CHAIN.map(function (e) { return (e.key || (e.el && e.el.id) || '?') + '@' + (e.region && (e.region.id || e.region.className.split(' ').slice(0,2).join('.'))); }), userLast: USER_LAST ? (USER_LAST.getAttribute('data-focus-key') || USER_LAST.id) : null }; },
        isVisible: isVisible,
        pushScope: pushScope,
        popScope: popScope,
        refresh: refresh,
        onChange: onChange,
        offChange: offChange
    };
})();
