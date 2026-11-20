/* mobile-player.js — Tier 2: touch controls for the player on mobile.
 *
 * WHY
 * The TV player overlay is driven by the D-pad: you navigate to a transport
 * button and press OK, or click the seek track once (Magic Remote pointer). On a
 * phone none of that is natural. This module adds the touch interactions people
 * expect from a mobile video player, WITHOUT replacing the overlay or the
 * playback logic:
 *
 *   - TAP the video            -> toggle the controls overlay (show/auto-hide).
 *   - TAP a transport button   -> already works (the buttons' existing click
 *                                 handlers fire on tap). (mobile.css used to
 *                                 also enlarge them for touch; removed as dead
 *                                 weight — see mobile.js's top comment — so
 *                                 they're currently TV-sized here, same as
 *                                 before removal since that CSS never actually
 *                                 activated on a shipped build either way.)
 *   - DRAG the seek scrubber   -> scrub through VOD/live via Player.seekTo().
 *   - DOUBLE-TAP left / right  -> jump back / forward via Player.seekRelative().
 *
 * All playback goes through the PUBLIC Player API (togglePause, seekTo,
 * seekRelative, showOverlay, hideOverlay, armOverlayHideTimer, isVod). No new
 * playback code, so behaviour matches the TV path exactly.
 *
 * SAFETY
 * Everything is gated on Mobile.isMobile(); on TV builds this module attaches no
 * listeners and does nothing. Touch listeners are passive where they don't
 * preventDefault. ES5-only.
 */
(function () {
    'use strict';

    function isMobile() {
        try { return !!(window.Mobile && (window.Mobile.isTouch ? window.Mobile.isTouch() : window.Mobile.isMobile())); } catch (e) { return false; }
    }
    function P() { return window.Player || null; }
    function $(id) { return document.getElementById(id); }

    var DOUBLE_TAP_MS = 300;      // max gap for a double-tap
    var DOUBLE_TAP_SLOP = 40;     // px; taps farther apart aren't a double-tap
    var SEEK_JUMP_SEC = 10;       // double-tap jump distance

    var lastTapTime = 0;
    var lastTapX = 0;
    var dragging = false;

    /* ---- overlay toggle on video tap ---------------------------------- */

    function overlayVisible() {
        var ov = $('infoOverlay');
        return !!(ov && ov.classList && ov.classList.contains('show'));
    }

    function showControls() {
        var p = P();
        if (!p) return;
        try { p.showOverlay(); } catch (e) {}
        // Auto-hide after the usual idle period (reuses the player's own timer).
        try { if (p.armOverlayHideTimer) p.armOverlayHideTimer(); } catch (e2) {}
    }
    function hideControls() {
        var p = P();
        if (!p) return;
        try { p.hideOverlay(); } catch (e) {}
    }
    function toggleControls() {
        if (overlayVisible()) hideControls();
        else showControls();
    }

    /* ---- double-tap-to-seek ------------------------------------------- */

    function handleVideoTap(x, viewportW) {
        var now = Date.now();
        var isDouble = (now - lastTapTime) <= DOUBLE_TAP_MS &&
                       Math.abs(x - lastTapX) <= (viewportW * 0.5);
        if (isDouble) {
            var p = P();
            if (p && p.seekRelative) {
                // Left third = back, right third = forward. Middle double-tap
                // just toggles play/pause (a common convention).
                if (x < viewportW * 0.35) {
                    try { p.seekRelative(-SEEK_JUMP_SEC); } catch (e) {}
                    showControls();
                } else if (x > viewportW * 0.65) {
                    try { p.seekRelative(SEEK_JUMP_SEC); } catch (e2) {}
                    showControls();
                } else {
                    try { p.togglePause(); } catch (e3) {}
                    showControls();
                }
            }
            lastTapTime = 0; // consume, so a 3rd tap starts fresh
            return true;
        }
        lastTapTime = now;
        lastTapX = x;
        return false;
    }

    function wireVideoTap() {
        var stage = document.querySelector('.player-stage');
        if (!stage) return;
        var tapStartX = 0, tapStartY = 0;
        // Swipe-up-to-reveal-overlay showed it then hid it again
        // ~300ms later; swipe-down-from-the-top showed it unexpectedly:
        // this handler used to treat EVERY touchend here as a tap candidate
        // regardless of how far the finger moved — no distance check at
        // all, only a time-based double-tap check. .player-stage sits
        // inside #player, so the SAME touchend that reaches the swipe-
        // gesture handler on #player (app.js — channel change, swipe-to-
        // reveal-overlay) bubbles through HERE first (closer ancestor),
        // with no coordination between the two. A genuine swipe got
        // double-handled: this module's own deferred single-tap-toggle
        // fired ~300ms after the swipe handler had already shown the
        // overlay, and toggled it straight back off. Bailing out early on
        // real movement leaves gesture classification entirely to the
        // #player-level handler instead of both reacting to the same
        // touchend. 20px is deliberately much smaller than that handler's
        // own 60px swipe threshold — this only needs to rule out "clearly
        // not a stationary tap", not classify what kind of swipe it was.
        var TAP_MOVE_TOLERANCE = 20;

        stage.addEventListener('touchstart', function (ev) {
            var t = ev.touches && ev.touches[0];
            if (t) { tapStartX = t.clientX; tapStartY = t.clientY; }
        }, { passive: true });

        // Use touchend for tap (click on video can be swallowed by controls).
        stage.addEventListener('touchend', function (ev) {
            // Ignore taps that land on the overlay controls themselves — those
            // have their own handlers (buttons, scrubber).
            var t = ev.target;
            if (t && t.closest && (t.closest('.info-transport') || t.closest('.info-seekbar') || t.closest('.info-bottom'))) {
                return;
            }
            if (dragging) { dragging = false; return; }
            var touch = (ev.changedTouches && ev.changedTouches[0]) || null;
            var x = touch ? touch.clientX : 0;
            var y = touch ? touch.clientY : 0;
            var moved = Math.abs(x - tapStartX) > TAP_MOVE_TOLERANCE || Math.abs(y - tapStartY) > TAP_MOVE_TOLERANCE;
            if (moved) return;
            var vw = window.innerWidth || document.documentElement.clientWidth || 1;
            var wasDouble = handleVideoTap(x, vw);
            if (!wasDouble) {
                // Single tap: toggle controls (deferred slightly so a following
                // second tap can upgrade it to a double-tap without flicker).
                setTimeout(function () {
                    if (Date.now() - lastTapTime >= DOUBLE_TAP_MS - 20) {
                        toggleControls();
                    }
                }, DOUBLE_TAP_MS);
            }
        }, false);
    }

    /* ---- draggable seek scrubber -------------------------------------- */
    /* The TV seek track (#seekTrack) already click-seeks via a click handler
     * that maps clientX across its width. On mobile we add touch DRAG: on
     * touchmove we compute the fraction the same way and call Player.seekTo, so
     * scrubbing reuses the exact same seek path as a click. */

    function fractionFromTouch(track, clientX) {
        var rect = track.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        var f = (clientX - rect.left) / rect.width;
        if (f < 0) f = 0;
        if (f > 1) f = 1;
        return f;
    }

    function wireScrubber() {
        var track = $('seekTrack');
        if (!track) return;

        function onMove(clientX) {
            var p = P();
            if (!p || !p.seekTo) return;
            // Only VOD (and live with a DVR window) is seekable; Player.seekTo
            // already clamps/handles that, so we just forward the fraction.
            var f = fractionFromTouch(track, clientX);
            // Live preview of the fill as the finger drags.
            var fill = $('seekFill');
            if (fill) fill.style.width = (f * 100) + '%';
            try { p.seekTo(f); } catch (e) {}
            showControls(); // keep controls up while scrubbing
        }

        track.addEventListener('touchstart', function (ev) {
            dragging = true;
            var t = ev.touches && ev.touches[0];
            if (t) onMove(t.clientX);
            // prevent the tap-toggle and page scroll while scrubbing
            if (ev.cancelable) ev.preventDefault();
        }, { passive: false });

        track.addEventListener('touchmove', function (ev) {
            if (!dragging) return;
            var t = ev.touches && ev.touches[0];
            if (t) onMove(t.clientX);
            if (ev.cancelable) ev.preventDefault();
        }, { passive: false });

        track.addEventListener('touchend', function () {
            dragging = false;
        }, false);
    }

    /* ---- boot --------------------------------------------------------- */

    function install() {
        if (!isMobile()) return;
        wireVideoTap();
        wireScrubber();
    }

    window.MobilePlayer = { install: install };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(install, 0); });
    } else {
        setTimeout(install, 0);
    }
})();
