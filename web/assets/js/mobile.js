/* mobile.js — mobile/tablet detection and the viewport-profile plumbing.
 *
 * WHY A SEPARATE MODULE
 * The app runs on five smart-TV platforms, Android TV, and (this) mobile. TV
 * behaviour must NEVER change when we add mobile, so every mobile divergence is
 * gated behind a single, well-defined predicate — isMobile() — rather than
 * scattered UA sniffs. This module is that single source of truth. If it returns
 * false (all TV builds), the app behaves exactly as it does today.
 *
 * HOW MOBILE IS DETECTED (in priority order)
 *   1. The native Android shell is authoritative. For the mobile build,
 *      AndroidBridge.platform() returns 'android-mobile' (the TV build returns
 *      'android-tv'). This is the reliable signal — it does not depend on UA
 *      strings, which are ambiguous (both Android TV and Android phones carry
 *      'android'). This is the ONLY thing that distinguishes the two Android
 *      builds, so it is checked first and trusted absolutely.
 *   2. Fallback for plain mobile browsers (no native shell): a coarse UA + touch
 *      + viewport heuristic, deliberately conservative so it can't misfire on a
 *      TV. Used only when there is no AndroidBridge at all.
 *
 * VIEWPORT PROFILE
 * The app already switches layout via an html[data-vp="..."] attribute
 * (data-vp="720" loads tv-720.css; no attribute = 1080). Mobile was a THIRD
 * profile, html[data-vp="mobile"], which activated mobile.css — removed (the
 * TV-UI-everywhere decision below means isMobile() is always false here, so
 * that attribute was never actually set; the file was 100% dead weight).
 * isMobile()/data-vp stay in place as the plumbing for if that decision is
 * ever revisited, but there is currently no mobile-specific stylesheet for
 * them to gate.
 *
 * FORM FACTOR + ORIENTATION
 * Within mobile we further classify phone vs tablet and portrait vs landscape,
 * exposed as html[data-mobile-ff="phone|tablet"] and via CSS @media
 * (orientation). The device matrix (phone/tablet x portrait/landscape) is thus
 * addressable from CSS without more JS.
 *
 * ES5 only (no let/const/arrow) to match the tree and clear the es5-check gate.
 */
window.Mobile = (function () {
    'use strict';

    var _cached = null;      // memoised isMobile() result (device doesn't change)
    var _ffCached = null;    // 'phone' | 'tablet'

    /* Ask the native shell what it is. Returns '' if there is no shell or the
     * call fails — never throws. */
    function shellPlatform() {
        try {
            if (window.AndroidBridge && typeof window.AndroidBridge.platform === 'function') {
                return String(window.AndroidBridge.platform() || '');
            }
        } catch (e) {}
        return '';
    }

    /* Is this a mobile (phone or tablet) context? Authoritative when a native
     * shell is present; conservative heuristic otherwise. Memoised. */
    function isMobile() {
        if (_cached !== null) return _cached;
        var result = false;

        var plat = shellPlatform();
        if (plat) {
            // A native shell is present: trust it completely. Only the explicit
            // mobile token counts as mobile; anything else (android-tv) is NOT.
            result = (plat === 'android-mobile');
            _cached = result;
            return result;
        }

        // No native shell: plain browser. Use a conservative heuristic. This
        // branch never runs inside the Android TV or mobile app (they always
        // expose AndroidBridge), so it only affects browser testing / a future
        // mobile-web deployment.
        var ua = (navigator.userAgent || '').toLowerCase();
        var uaMobile = /android|iphone|ipad|ipod|iemobile|blackberry|windows phone/.test(ua);
        // iPadOS 13+ reports as desktop Safari; catch it via touch + platform.
        var iPadOS = (navigator.platform === 'MacIntel' &&
                      typeof navigator.maxTouchPoints === 'number' &&
                      navigator.maxTouchPoints > 1);
        var hasTouch = ('ontouchstart' in window) ||
                       (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0);
        // Guard against smart-TV UAs that also carry 'android': if the TV
        // detector (from player.js, loaded first) says TV, this is not mobile.
        var looksLikeTv = false;
        try {
            if (typeof window.PlayerIsTvPlatform === 'function') looksLikeTv = window.PlayerIsTvPlatform();
        } catch (e) {}

        result = !looksLikeTv && (uaMobile || iPadOS) && hasTouch;
        _cached = result;
        return result;
    }

    /* Phone vs tablet. Based on the shorter viewport edge in CSS px: tablets
     * have a short edge >= 600 (the long-standing Android "sw600dp" tablet
     * breakpoint). Only meaningful when isMobile() is true. */
    function formFactor() {
        if (_ffCached) return _ffCached;
        if (!isMobile()) { _ffCached = 'phone'; return _ffCached; }
        var w = window.innerWidth || document.documentElement.clientWidth || 360;
        var h = window.innerHeight || document.documentElement.clientHeight || 640;
        var shortEdge = Math.min(w, h);
        _ffCached = (shortEdge >= 600) ? 'tablet' : 'phone';
        return _ffCached;
    }

    function isTablet() { return isMobile() && formFactor() === 'tablet'; }
    function isPhone() { return isMobile() && formFactor() === 'phone'; }

    /* Apply the mobile viewport profile to <html>. Called from app boot BEFORE
     * the existing data-vp="720" logic, and short-circuits it (a phone must not
     * also be tagged 720, which would pull in TV-720 layout). Safe to call once.
     *
     * Returns true if the mobile profile was applied (so the caller can skip the
     * 720/1080 branch), false otherwise (all TV builds -> caller proceeds as
     * today, unchanged). */
    function applyProfile() {
        try {
            if (!isMobile()) return false;
            var root = document.documentElement;
            root.setAttribute('data-vp', 'mobile');
            root.setAttribute('data-mobile-ff', formFactor());
            // Re-evaluate form factor on resize/rotate (tablet split-screen can
            // cross the phone/tablet threshold; orientation flips w/h).
            var relabel = function () {
                _ffCached = null;
                try { root.setAttribute('data-mobile-ff', formFactor()); } catch (e) {}
            };
            if (window.addEventListener) {
                window.addEventListener('resize', relabel, false);
                window.addEventListener('orientationchange', relabel, false);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    /* Touch capability — INDEPENDENT of isMobile(). True on any device that can
     * tap (phones/tablets, even when running the TV UI). Use this to gate touch
     * INTERACTIONS (tap-to-open overlay, QR->tappable link, donate/mailto, pinch)
     * that make sense whenever the device has touch, regardless of whether the
     * full mobile LAYOUT (isMobile) is active. Cached. */
    var _touch = null;
    function isTouch() {
        if (_touch !== null) return _touch;
        // Manual override first: some generic/whitelabel Android TV boxes ship
        // a repurposed phone/tablet firmware build rather than a proper
        // Android TV image — PackageManager's touchscreen feature flag (what
        // hasTouchscreen() below checks) is DECLARED by that firmware, not
        // probed from real hardware, so a box with zero actual touch capability
        // can still report true if whoever built the firmware didn't strip the
        // flag. isTelevision()'s own UI-mode check doesn't save this either,
        // since a box genuinely running mobile-flavored Android also won't
        // report UI_MODE_TYPE_TELEVISION correctly. No available signal is
        // reliably more correct than another for a misconfigured box like
        // this — the only real fix is letting the person say so directly, via
        // Settings' Touch/Remote Mode control (Store.getSettings().touchMode:
        // 'auto' | 'touch' | 'remote').
        try {
            if (window.Store && Store.getSettings) {
                var tm = (Store.getSettings() || {}).touchMode;
                if (tm === 'touch') { _touch = true; return _touch; }
                if (tm === 'remote') { _touch = false; return _touch; }
            }
        } catch (eOv) {}
        // WebView/Chromium exposes touch-EVENT support ('ontouchstart' in
        // window, navigator.maxTouchPoints) as part of the ENGINE's own
        // capabilities, independent of whether the actual hardware has a
        // touchscreen — a known Android WebView quirk that once caused a real
        // Android TV box (no touchscreen) to be treated as touch. platform()
        // itself can't be used to fix this either: it reports the app's
        // chosen UI MODE (which may be deliberately pinned to "android-tv" for
        // every device, TV or phone, as a shipping decision — see its own doc
        // comment), not physical hardware, so trusting it here would silently
        // disable touch on a real phone whenever that pin is in effect.
        //
        // hasTouchscreen() is the one signal that answers the actual hardware
        // question (PackageManager's touchscreen feature flag) independent of
        // that app-mode pin — checked first because it's the most reliable
        // source when a native shell is present. Older shells without this
        // method fall back to trusting platform() (its previous behaviour);
        // a plain browser with no shell at all falls back to DOM feature-
        // detection.
        try {
            if (window.AndroidBridge && typeof window.AndroidBridge.hasTouchscreen === 'function') {
                _touch = !!window.AndroidBridge.hasTouchscreen();
                return _touch;
            }
        } catch (e) {}
        var plat = shellPlatform();
        if (plat) {
            _touch = (plat === 'android-mobile');
            return _touch;
        }
        try {
            _touch = ('ontouchstart' in window) ||
                     (navigator.maxTouchPoints > 0) ||
                     (navigator.msMaxTouchPoints > 0);
        } catch (e) { _touch = false; }
        return _touch;
    }

    return {
        isMobile: isMobile,
        isTouch: isTouch,
        isPhone: isPhone,
        isTablet: isTablet,
        formFactor: formFactor,
        applyProfile: applyProfile
    };
})();
