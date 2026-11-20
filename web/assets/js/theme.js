/* theme.js - app colour theme: 'dark' (default) | 'light' | 'system'.
 *
 * Loaded from <head>, before the first paint, so a saved Light choice never
 * flashes dark first. It reads the saved setting straight from localStorage
 * (Store is not loaded yet) and sets data-theme="dark|light" on <html>; every
 * colour in the CSS hangs off that attribute (see main.css). ES5.
 *
 * 'system' follows the device through matchMedia('(prefers-color-scheme: light)')
 * and re-applies when the device setting changes. Engines without that media
 * query (older TV browsers) cannot tell, so they stay dark. In the Android app the
 * device setting comes from AndroidBridge.isSystemDark() instead. The player screen is
 * always dark regardless (main.css re-declares the dark tokens under #player).
 */
var Theme = (function () {
    'use strict';

    var MODES = { dark: 1, light: 1, system: 1 };
    var mode = 'dark';
    var mq = null;

    function readSaved() {
        try {
            var raw = window.localStorage.getItem('xtivio.settings');
            if (!raw) return 'dark';
            var t = JSON.parse(raw).theme;
            return MODES[t] ? t : 'dark';
        } catch (e) { return 'dark'; }
    }

    function systemPrefersLight() {
        // Android app: ask the native side. The WebView's own prefers-color-scheme
        // does not reliably follow the device setting, so it is only the fallback.
        try {
            if (window.AndroidBridge && typeof window.AndroidBridge.isSystemDark === 'function') {
                return !window.AndroidBridge.isSystemDark();
            }
        } catch (eNative) {}
        try {
            if (window.matchMedia) {
                var m = window.matchMedia('(prefers-color-scheme: light)');
                return !!(m && m.matches);
            }
        } catch (e) {}
        return false;
    }

    function resolved() {
        if (mode === 'light') return 'light';
        if (mode === 'system') return systemPrefersLight() ? 'light' : 'dark';
        return 'dark';
    }

    function paint() {
        var r = resolved();
        var html = document.documentElement;
        if (html) html.setAttribute('data-theme', r);
        // Keep the browser chrome / overscroll colour in step where a theme-color
        // meta exists.
        try {
            var meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', r === 'light' ? '#f3f5fa' : '#0c1020');
        } catch (e) {}
    }

    function onSystemChange() { if (mode === 'system') paint(); }

    function watch() {
        if (mq || !window.matchMedia) return;
        try {
            mq = window.matchMedia('(prefers-color-scheme: light)');
            if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
            else if (mq.addListener) mq.addListener(onSystemChange);
        } catch (e) { mq = null; }
    }

    // Re-read the device setting (called by the native side on a system theme
    // change, and when the app returns to the foreground).
    function refresh() { if (mode === 'system') paint(); }
    try {
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
    } catch (eEv) {}

    function apply(newMode) {
        mode = MODES[newMode] ? newMode : 'dark';
        paint();
        if (mode === 'system') watch();
    }

    function get() { return mode; }

    apply(readSaved());

    return { apply: apply, get: get, resolved: resolved, refresh: refresh };
})();
