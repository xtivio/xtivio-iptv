/* config.js - app configuration
 * EDIT THIS FILE to match your deployment.
 */
var APP_CONFIG = {
    APP_NAME: 'Xtivio',
    // Matches app/build.gradle's xtivioVersion and the webOS/Tizen manifests
    // exactly (x.y.z only, no internal build digit — see build.gradle's own
    // versioning comment for the full scheme). Previously frozen at 1.0.0
    // from before the three platforms were unified onto one shared version;
    // now kept in sync by version-bump-check.py same as INSTALL_TOKEN below.
    APP_VERSION: '1.0.12',

    // Optional per-build token. The reinstall fix does NOT depend on this:
    // it keys off a localStorage marker (which this platform wipes on
    // reinstall) to clear Firebase's auth IndexedDB. Injecting a unique token
    // per build additionally makes an app UPDATE start signed out. If left as
    // 'DEV-UNPACKAGED', reinstall still starts signed out; only update-reset
    // is skipped. The packager may overwrite this; see PACKAGING.md.
    // Format: xtivio-<version>.<internal build 0-9>, matching
    // app/build.gradle's xtivioBuildId exactly (that file's own comment has
    // the full cross-platform versioning scheme) — NOT platform-prefixed
    // ("xtivio-androidNN") any more, since this config.js is the shared web
    // layer used by Android, webOS, and Tizen alike; the old name implied
    // otherwise.
    INSTALL_TOKEN: 'xtivio-1.0.12.9',

    // Direct (sideload) build only. '' = store build: no updater, nothing shown. Set to
    // 'direct' at staging for the APK hosted on your own server; Settings then shows
    // "Check for Updates", which reads UPDATE_URL (latest.json) and opens the APK link.
    UPDATE_CHANNEL: '',
    UPDATE_URL: '',

    // Your self-hosted pairing server. Must serve /api/pair and /api/pair/:code (see the server folder).
    // Used by the QR/code pairing flow.
    PAIR_SERVER: '',

    // Firebase config (optional; only used for cloud sync). Create your own Firebase project,
    // set enabled to true and paste its web app config here.
    FIREBASE: {
        enabled: false,
        apiKey: 'YOUR_FIREBASE_API_KEY',
        authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
        databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
        projectId: 'YOUR_PROJECT_ID',
        storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
        messagingSenderId: 'YOUR_SENDER_ID',
        appId: 'YOUR_APP_ID'
    },

    // Default overlay duration (ms). Can be overridden in Settings.
    OVERLAY_MS: 5000,

    // EPG refresh interval (ms)
    EPG_REFRESH_MS: 30 * 60 * 1000,

    // How long a pairing code is valid (ms) — matches the server default
    PAIR_CODE_TTL_MS: 2 * 60 * 1000,

    // Poll interval while waiting for the user to submit pair data (ms)
    PAIR_POLL_MS: 3000,

    // Android: an HLS stream that ExoPlayer has not made ready after this many ms is handed to the WebView player (hls.js).
    EXO_STUCK_MS: 4000,

    // Debug mode - extra logging when true. OFF for this build. Flip back to
    // true for any future dev/diagnostic round; nothing else needs to change
    // either way — "is this a final build?" is just "is DEBUG false?",
    // nothing more to track separately (a short-lived redundant BUILD_FINAL
    // flag briefly existed for this, restating the same value; removed —
    // see CHANGELOG-ANDROID.md for which build).
    DEBUG: false,

    // TEST ONLY: force the app to behave as if IndexedDB is unavailable, to
    // exercise the reduced-mode guard (forces Lite, skips the VOD/series preload,
    // shows the storage-unavailable notice) without needing a device that
    // actually lacks IDB. Leave false for real builds.
    FORCE_NO_IDB: false
};


/* Central logger. ALL console output goes through this so a production/store build is
 * silent: it only reaches the real console when APP_CONFIG.DEBUG is true (or the runtime
 * override window.APP_DEBUG is set). Guards for console existence too (older TV webviews).
 * Use Log.log / Log.warn / Log.error in place of console.* everywhere. */
var Log = (function () {
    function on() {
        try {
            if (typeof window !== 'undefined' && window.APP_DEBUG) return true;
            return !!(typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG);
        } catch (e) { return false; }
    }
    function emit(method, args) {
        if (!on()) return;
        if (typeof console === 'undefined' || !console[method]) return;
        try { console[method].apply(console, args); } catch (e) {}
    }
    return {
        log:   function () { emit('log', arguments); },
        warn:  function () { emit('warn', arguments); },
        error: function () { emit('error', arguments); },
        enabled: on
    };
})();

