/* player.js - Video playback (HLS.js when supported, native otherwise)
 *
 * - Reads Store.getSettings().player to choose engine ('auto'|'native'|'hlsjs')
 * - HLS.js error recovery: media-error -> recoverMediaError; network-error -> startLoad
 * - On Xtream channels with a fallbackUrl, retries that URL once on fatal error
 * - Drives the info-overlay timer using Store.getSettings().overlayMs
 *
 * Public API:
 *   Player.init()
 *   Player.play(channel)           -> plays a normalized channel object
 *   Player.stop()
 *   Player.togglePause()
 *   Player.showOverlay()
 *   Player.hideOverlay()
 *   Player.currentChannel()
 */
var Player = (function () {
    'use strict';

    var videoEl = null;
    var hls = null;
    var activeEngine = 'native';
    var current = null;
    var triedFallback = false;
    var triedExoRescue = false;
    // ExoPlayer did not become ready in time on an HLS stream, so the WebView (hls.js) took over. Some
    // broadcast-style streams (I-frame starts, interlaced) sit on "loading" in ExoPlayer or play corrupted,
    // while hls.js plays them. The channel is remembered once the WebView really plays it.
    var triedExoStuck = false;
    var webFirstPending = '';
    var exoStuckTimer = null;
    /* TV HLS rescue. Smart-TV <video> plays .m3u8 natively, but some TVs' own HLS demuxer stalls on a playlist
     * behind a redirect to a tokenised proxy (seen on Samsung Tizen 5.5: endless loading). When the native
     * attempt has not started after HLS_RESCUE_MS, or it errors, the same stream is tried once through the
     * bundled hls.js, and remembered once it really plays so the next start goes straight there. */
    var HLS_RESCUE_MS = 8000;
    var HLSFIRST_LS = 'xtivio.hlsFirst';
    var triedHlsRescue = false;
    var hlsFirstPending = '';
    var hlsRescueTimer = null;
    /* Start-up deadline. A stream that never reports a first sign of life (a provider that holds the
     * connection open, or answers with something no engine reports back, such as a 407 from a provider that
     * blocks the stream) used to leave the spinner up for as long as the engines kept retrying. play() arms
     * this; any showLoading(false) (first picture, manifest parsed, an error) disarms it. When it fires, the
     * engines are stopped and the error screen shows the "no answer in time" sentence with code E-TIME.
     * Live gets less time than movies and series, which can need longer to open. Both values are in config.js. */
    var startWd = null;
    var startWdGen = 0;
    var WEBFIRST_LS = 'xtivio.webfirst';
    var WEBFIRST_TTL = 14 * 86400000;
    var exoOfferable = false;      // the last Exo failure was a decoder/format one another app may handle
    var externalOffered = false;   // the hand-off prompt was already shown for this play
    /* Hand-off to another player app: 0 none, 1 handed off (still in front), 2 the app really went to the
     * background. Only a return after state 2 closes the player screen (a chooser that never opened must
     * not turn a later lock/unlock into a close). */
    var extHandoff = 0;
    function markExternalHandoff() { extHandoff = 1; }
    function noteBackgrounded() { if (extHandoff === 1) extHandoff = 2; }
    function consumeExternalReturn() { var r = extHandoff === 2; if (r) extHandoff = 0; return r; }
    var stalkerRefreshed = false;  // a failed Stalker stream already got one fresh link for this play

    /* The mini player showed a false "Stream unavailable" while exo video
     * actually played fine fullscreen behind it: the mini player's own
     * ready/error detection (live-top-mini.js) was built entirely around the
     * <video> DOM element's events — loadstart/playing/error — which NEVER
     * fire for exo playback (it bypasses that element completely). Its 15s
     * watchdog therefore ALWAYS eventually declared failure for any
     * exo-routed mini stream, real success or not. Separately, its bounds-
     * tracking start was a blind RAF-loop guess at Player.activeEngine()
     * that could race ahead of the async Stalker/Xtream resolve and give up
     * (permanently — it never retries once stopped) before the engine was
     * even known, leaving the native surface at its fullscreen default while
     * exo went on playing successfully behind everything.
     * This tiny pub/sub lets any module — currently just live-top-mini.js —
     * subscribe to real engine-selection/ready/error/buffering signals
     * instead of guessing from unrelated DOM state. Fired below, additively,
     * alongside the existing internal handling; changes nothing for the
     * fullscreen player. */
    var stateListeners = [];
    function onStateEvent(cb) { if (typeof cb === 'function') stateListeners.push(cb); }
    function offStateEvent(cb) {
        var i = stateListeners.indexOf(cb);
        if (i >= 0) stateListeners.splice(i, 1);
    }
    function fireStateEvent(type, detail) {
        for (var i = 0; i < stateListeners.length; i++) {
            try { stateListeners[i](type, detail); } catch (e) {}
        }
    }

    /* Track HLS network retries so we don't loop
     * forever on a 5xx that doesn't recover. Reset per stream. */
    var networkRetryCount = 0;
    var overlayTimer = null;
    var activeSubTrack = null;   // the TextTrack we added, for offset adjustment
    var progSubTrack = false;    // true when activeSubTrack was injected via addCue
    var subOffsetMs = 0;         // current applied offset (ms); base times stored on cues
    var subCueBase = null;       // WeakMap-like: cue -> {start,end} base times
    // Custom subtitle renderer (WebOS 6.5 won't paint script TextTracks).
    var subCues = null;          // array of {start,end,text} in seconds (base times)
    var subOverlayEl = null;     // the #subOverlay div
    var subTickHandler = null;   // timeupdate listener
    var subTickInterval = null;  // 100ms poll for snappy cue changes
    var subActiveIdx = -1;       // currently displayed cue index (-1 none)
    var curSubLang = null;       // language of the active custom-rendered track
    var loadingEl = null;
    var errorEl = null;
    var errorSubEl = null;
    var errorCodeEl = null;
    var infoOverlayEl = null;
    var epgRefreshTimer = null;

    /* Player diagnostic log. Fires when EITHER the packaged APP_CONFIG.DEBUG is
     * on OR window.PLAYER_DEBUG is set true at runtime (from the TV/browser
     * console: window.PLAYER_DEBUG = true). This lets us see engine choice,
     * the (scrubbed) stream URL, and HLS/native errors during video debugging
     * without rebuilding with global DEBUG on (which would flood the console
     * with logs from every module). Never logs raw credentials — URLs are
     * scrubbed at the call site. */
    function plog() {
        var on = (typeof window !== 'undefined' && window.PLAYER_DEBUG) ||
                 (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG);
        if (on && window.console && console.log) {
            // Defence-in-depth: scrub credentials (Xtream user/pass, Stalker
            // mac/token/serial/device-id) from EVERY string arg before logging,
            // so no call site can accidentally leak them into the console — which
            // is also mirrored to logcat by the native shell. Non-strings pass
            // through untouched.
            var args = arguments;
            try {
                if (window.Crypto && Crypto.scrubUrl) {
                    args = [];
                    for (var i = 0; i < arguments.length; i++) {
                        var a = arguments[i];
                        args.push(typeof a === 'string' ? Crypto.scrubUrl(a) : a);
                    }
                }
            } catch (eScrubAll) { args = arguments; }
            console.log.apply(console, args);
        }
    }

    /* Detect TV platforms (WebOS / Tizen / VIDAA / Titan OS / Whale OS) so
     * pickEngine() can default to the native pipeline in auto mode.
     * The HTML5 <video> element on these TVs is a wrapper around a
     * hardware decoder that handles HLS, MPEG-TS, and HEVC natively.
     * hls.js routes through MSE which on Chromium 79 has no HEVC
     * decoder — auto-picking hls.js for HEVC streams (most modern
     * IPTV) means a silent failure with no error event. Native is the
     * safe TV default; users can still force hls.js explicitly. */
    function isTvPlatform() {
        var ua = (navigator.userAgent || '').toLowerCase();
        if (ua.indexOf('webos') >= 0 || ua.indexOf('web0s') >= 0) return true;
        if (ua.indexOf('tizen') >= 0 || ua.indexOf('smart-tv') >= 0 || ua.indexOf('smarttv') >= 0) return true;
        if (ua.indexOf('vidaa') >= 0 || ua.indexOf('hisense') >= 0) return true;
        // Titan OS (Philips / AOC / JVC). Its UA carries the Titan token; the
        // sets are also identifiable as Philips/AOC but 'titan' is the stable one.
        if (ua.indexOf('titan') >= 0) return true;
        // Whale OS / ZEASN (AOC and 400+ white-label brands). Its UA carries
        // 'whaletv' (the UI_profile) and usually the NetRange 'nettv' stack token.
        // Match those specific tokens (not a bare 'whale', which would also hit the
        // unrelated Naver Whale desktop browser).
        if (ua.indexOf('whaletv') >= 0 || ua.indexOf('nettv') >= 0) return true;
        // webOS sometimes exposes itself via window.webOS / window.PalmSystem
        if (typeof window !== 'undefined' && (window.webOS || window.PalmSystem)) return true;
        return false;
    }
    // Expose the TV test so the Mobile detection module (mobile.js) can use it
    // as a negative guard in its browser-fallback path (a smart-TV UA that also
    // carries 'android' must never be classified as mobile). This is a read-only
    // export of existing logic; it changes no TV behaviour.
    try { if (typeof window !== 'undefined') window.PlayerIsTvPlatform = isTvPlatform; } catch (eExpose) {}

    /* Android TV / Google TV (WebView shell).
     * IMPORTANT: this is NOT one of the isTvPlatform() cases above. Those TVs
     * (Tizen/webOS/VIDAA/Titan/Whale) wrap a hardware decoder behind <video>
     * that plays HLS/TS/HEVC natively, so 'native' is their safe default.
     * Android's Chromium WebView does NOT natively play HLS the way Safari does
     * — a raw .m3u8 handed to <video> just stalls with no error. So on Android
     * we must route HLS through hls.js (MSE), which the app already bundles.
     * Detected two ways: the native shell injects window.AndroidBridge, and the
     * WebView UA carries 'android'. Either is sufficient. */
    function isAndroidWebView() {
        try {
            if (typeof window !== 'undefined' && window.AndroidBridge) return true;
        } catch (e) {}
        var ua = (navigator.userAgent || '').toLowerCase();
        // Exclude the smart-TV UAs already handled by isTvPlatform (some carry
        // 'android' as a base, e.g. certain Titan/Whale sets) so their native
        // pipeline is not overridden.
        if (ua.indexOf('android') >= 0 && !isTvPlatform()) return true;
        return false;
    }

    function pickEngine(channel) {
        var s = Store.getSettings();
        var pref = s.player || 'auto';
        // Preferred Player is a DEBUG-only control. In normal production the
        // stored value is ignored and routing always behaves as 'auto', so a
        // stray/synced 'hlsjs' (which can't play MKV/HEVC on webOS) can never
        // take effect on a shipped device. Only honour the pref when debug is on.
        var debugOn = (typeof window !== 'undefined' && window.APP_DEBUG) ||
                      (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG);
        if (!debugOn) pref = 'auto';
        var url = channel.url || '';
        var isHls = /\.m3u8(\?|$)/i.test(url);

        // EXPLICIT FORCED PREF WINS (debug only). If a specific engine is forced
        // (not 'auto'), honour it before the AVPlay/Exo auto-overrides below —
        // otherwise forcing 'hlsjs' or 'native' would be silently ignored for any
        // container that exo/avplay's shouldHandle() claims (e.g. MKV), which is
        // exactly the "forced HLS but exo still took over" bug. 'auto' falls
        // through to the normal shouldHandle-based routing.
        if (pref === 'hlsjs') {
            if (typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported()) return 'hlsjs';
            return 'native';
        }
        if (pref === 'exo') {
            if (window.PlayerExo && PlayerExo.takesOverPlayback && PlayerExo.takesOverPlayback()) return 'exo';
            return 'native';
        }
        if (pref === 'avplay') {
            if (window.PlayerAVPlay && PlayerAVPlay.takesOverPlayback && PlayerAVPlay.takesOverPlayback()) return 'avplay';
            return 'native';
        }
        if (pref === 'native') return 'native';

        // Platform hardware player (Tizen AVPlay) for containers the browser
        // cannot decode (MKV, and HEVC/AC3 that MSE rejects). Only engages when
        // the packaged-app API is actually present AND the content needs it;
        // otherwise this is a no-op and the usual engines run. webOS is handled
        // via the 'native' path below (its <video> reaches the HW pipeline in the
        // packaged app), so only Tizen returns the dedicated 'avplay' engine.
        try {
            if (window.PlayerAVPlay && PlayerAVPlay.shouldHandle(channel) &&
                PlayerAVPlay.takesOverPlayback()) {
                return 'avplay';
            }
        } catch (ePA) {}
        // Android native ExoPlayer (Media3) for containers/codecs the Android
        // WebView cannot handle: MKV/AVI, and HEVC/AC3/EAC3/DTS. Only engages
        // when the native shell bridge (window.AndroidBridge.exoPlay) is present
        // AND the content actually needs it; plain H.264 MP4 / HLS keep using
        // the better-integrated WebView (hls.js/native) path below. Mirrors the
        // AVPlay branch above.
        try {
            if (window.PlayerExo && PlayerExo.shouldHandle(channel) &&
                PlayerExo.takesOverPlayback()) {
                return 'exo';
            }
        } catch (ePE) {}
        if (pref === 'native') return 'native';
        if (pref === 'hlsjs') return (typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported()) ? 'hlsjs' : 'native';
        // auto (Android): decide HLS engine by ACTUAL capability, not assumption.
        // webOS/Tizen play .m3u8 directly in <video> (native HLS); the question
        // is whether THIS Android WebView can too. Modern Android TV WebViews
        // often DO support native HLS — and native playback avoids hls.js's
        // failure fetching the manifest from the file:// origin (the
        // "manifestLoadTimeOut" we saw). So: if <video> claims it can play HLS,
        // use native (like the TVs). Only fall back to hls.js when native HLS is
        // genuinely unsupported. Non-HLS still uses native.
        if (isAndroidWebView()) {
            if (isHls) {
                var nh = nativeHlsSupported();
                plog('[player] Android HLS routing: nativeHlsSupported=' + nh);
                if (nh) return 'native';
                if (typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported()) return 'hlsjs';
            }
            return 'native';
        }
        // auto: prefer native on TVs (hardware decoder, supports HEVC);
        // prefer hls.js on desktop browsers for .m3u8 URLs (no native HLS
        // outside Safari).
        if (isTvPlatform()) return 'native';
        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported()) return 'hlsjs';
        return 'native';
    }

    /* Does this WebView's <video> play HLS (.m3u8) natively, like the smart-TV
     * WebViews do? Tested via canPlayType on the HLS MIME types. Cached. If yes,
     * we hand .m3u8 straight to <video> and skip hls.js entirely (which avoids
     * hls.js's file://-origin manifest-fetch failure on Android). */
    var _nativeHls = null;
    function nativeHlsSupported() {
        if (_nativeHls !== null) return _nativeHls;
        try {
            var v = document.createElement('video');
            var a = v.canPlayType('application/vnd.apple.mpegurl');
            var b = v.canPlayType('application/x-mpegurl');
            var c = v.canPlayType('audio/mpegurl');
            _nativeHls = !!(a || b || c);
        } catch (e) { _nativeHls = false; }
        return _nativeHls;
    }

    function destroyHls() {
        if (hls) {
            try { hls.destroy(); } catch (e) {}
            hls = null;
        }
    }

    /* Bring the native shell's WebView forward over the video (or hide it) while
     * ExoPlayer is driving playback, so web UI (controls, buffering spinner) is
     * visible over the video and then gets out of the way. No-op unless the exo
     * engine is active and the Android bridge is present — so TV and WebView
     * playback are completely unaffected. */
    function exoUi(visible) {
        try {
            if (activeEngine === 'exo' && window.AndroidBridge && window.AndroidBridge.exoShowUi) {
                window.AndroidBridge.exoShowUi(!!visible);
            }
        } catch (e) {}
    }

    /* True once an Exo picture has been up. A direct channel switch then keeps the
     * last frame behind a see-through loading overlay instead of a black one. */
    var exoPictureUp = false;
    function showLoading(on) {
        if (!loadingEl) return;
        if (!on) clearStartWd();
        if (!on && activeEngine === 'exo') exoPictureUp = true;
        if (on) loadingEl.classList.remove('hidden');
        else loadingEl.classList.add('hidden');
        // On the exo path, the loading spinner lives in the WebView which is
        // hidden during playback. Bring it forward while loading. When loading
        // ends, only send the WebView back if the info overlay isn't also showing
        // (which needs the UI forward too).
        if (on) {
            exoUi(true);
        } else {
            var overlayShowing = infoOverlayEl && infoOverlayEl.classList.contains('show');
            if (!overlayShowing) exoUi(false);
        }
    }
    /* Turn a technical error detail (MediaError code, HLS type/detail, ExoPlayer error name and message,
     * HTTP status) into a plain sentence plus a short code for the on-screen error panel. End users should
     * see what it means and what they can do; the short code (E403, E-NET ...) lets support tell what failed
     * from a screenshot. Codes: E<status> = the provider answered with that HTTP status (E401 login refused,
     * E403 access refused, E404 not found, E429 too many requests, E5xx provider server problem),
     * E-NET no connection, E-TIME no answer in time, E-DEC the device cannot decode it, E-FMT unsupported or
     * broken stream, E-LIVE live window passed, E-STOP playback stopped, E-STK the portal's own message,
     * E-UNK anything else. */
    var lastErrCode = '';
    function playbackErrorInfo(details) {
        var raw = String(details || '');
        var d = raw.toLowerCase();
        var m = /(?:response code:?|http[= ]?|status[= ]?)\s*([45]\d\d)\b/i.exec(raw);
        var st = m ? parseInt(m[1], 10) : 0;
        if (!st && d.indexOf('file_not_found') >= 0) st = 404;
        if (st >= 400) {
            var key = 'err_http_4xx';
            if (st === 401) key = 'err_http_401';
            else if (st === 403) key = 'err_http_403';
            else if (st === 404 || st === 410) key = 'err_http_404';
            else if (st === 429) key = 'err_http_429';
            else if (st >= 500) key = 'err_http_5xx';
            return { text: T(key), code: 'E' + st };
        }
        if (d.indexOf('behind_live_window') >= 0) return { text: T('err_live_window'), code: 'E-LIVE' };
        if (d.indexOf('timeout') >= 0 || d.indexOf('timed out') >= 0) return { text: T('err_timeout'), code: 'E-TIME' };
        if (d.indexOf('code-1') >= 0) return { text: T('err_playback_stopped'), code: 'E-STOP' };
        if (d.indexOf('code-2') >= 0 || d.indexOf('network') >= 0 || d.indexOf('unknownhost') >= 0 ||
            d.indexOf('unable to connect') >= 0) return { text: T('err_network'), code: 'E-NET' };
        if (d.indexOf('code-3') >= 0 || d.indexOf('decod') >= 0) return { text: T('err_decode_failed'), code: 'E-DEC' };
        if (d.indexOf('code-4') >= 0 || d.indexOf('src') >= 0 || d.indexOf('manifest') >= 0 ||
            d.indexOf('parsing') >= 0 || d.indexOf('container') >= 0 || d.indexOf('unsupported') >= 0 ||
            d.indexOf('format') >= 0) return { text: T('err_offline_format'), code: 'E-FMT' };
        return { text: T('err_maybe_offline'), code: 'E-UNK' };
    }
    function friendlyErrorSub(details) {
        var info = playbackErrorInfo(details);
        lastErrCode = info.code;
        return info.text;
    }

    /* After a decoder/format failure, offer to hand the stream to another player app
     * (VLC, MX Player...) through the system chooser, once per play. Android shell only.
     * With no player app installed the system chooser says so itself. */
    function offerExternalPlayer() {
        try {
            if (externalOffered) return;
            if (!(window.AndroidBridge && typeof AndroidBridge.openExternalPlayer === 'function')) return;
            if (!(window.UI && UI.openModal && UI.closeModal)) return;
            externalOffered = true;
            var body = document.createElement('div');
            body.className = 'resume-modal-body';
            var msg = document.createElement('div');
            msg.className = 'modal-body';
            msg.textContent = T('err_decode_offer_external');
            var actions = document.createElement('div');
            actions.className = 'resume-modal-actions';
            var yes = document.createElement('button');
            yes.className = 'btn focusable'; yes.setAttribute('tabindex', '-1'); yes.setAttribute('data-focus-key', 'extoffer-yes');
            yes.textContent = T('ui_open_external');
            var no = document.createElement('button');
            no.className = 'btn focusable'; no.setAttribute('tabindex', '-1'); no.setAttribute('data-focus-key', 'extoffer-no');
            no.textContent = T('cancel');
            yes.addEventListener('click', function () {
                UI.closeModal();
                getExternalPlayableUrl(function (u) {
                    if (!u) { showError(T('err_could_not_play'), T('could_not_load_stream')); return; }
                    try { stop(); } catch (eSt) {}
                    markExternalHandoff();
                    try { AndroidBridge.openExternalPlayer(u); } catch (eOp) {}
                });
            });
            no.addEventListener('click', function () { UI.closeModal(); });
            actions.appendChild(yes);
            actions.appendChild(no);
            body.appendChild(msg);
            body.appendChild(actions);
            UI.openModal({ title: T('err_could_not_play'), bodyEl: body, cancelText: false });
            var card = document.querySelector('#modalLayer .modal-card');
            if (card) card.classList.add('resume-modal-card');
            var ok = document.getElementById('modalOk');
            if (ok && ok.parentNode) ok.parentNode.removeChild(ok);
            setTimeout(function () { try { Focus.focusKey('extoffer-yes'); } catch (eF) {} }, 100);
        } catch (eOffer) {}
    }

    function showError(msg, sub) {
        if (!errorEl) return;
        errorEl.classList.remove('hidden');
        if (errorSubEl) errorSubEl.textContent = sub || '';
        if (errorCodeEl) errorCodeEl.textContent = lastErrCode ? String(T('err_code_label')).replace('{code}', lastErrCode) : '';
        lastErrCode = '';
        showLoading(false);
        exoPictureUp = false;
    }
    function hideError() {
        if (errorEl) errorEl.classList.add('hidden');
        if (errorCodeEl) errorCodeEl.textContent = '';
        lastErrCode = '';
    }

    function attachHls(url) {
        destroyHls();
        // hls.js worker + file:// origin: on Android WebView, hls.js's web worker
        // cannot fetch from a file:// origin (the app loads from
        // file:///android_asset/web/), so the manifest request times out —
        // "manifestLoadTimeOut" — and HLS never starts (constant loading). This
        // is the file:// limitation this WebView has (webOS/Tizen are permissive,
        // so it worked there). Disabling the worker makes hls.js fetch on the
        // main thread, which succeeds. Detected via the AndroidBridge (only the
        // Android shell exposes it); on TVs the worker stays enabled.
        var onAndroid = false;
        try { onAndroid = !!(window.AndroidBridge); } catch (eAB) {}

        hls = new Hls({
            // Conservative settings for TV CPUs
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            enableWorker: !onAndroid,   // OFF on Android (file:// worker fetch fails)
            lowLatencyMode: false,
            /* Retry budget. On Android the file:// path is slower to first byte,
             * so give the manifest a more forgiving window than the aggressive
             * TV defaults — otherwise a slow-but-working fetch gets killed as a
             * false timeout (the "manifestLoadTimeOut" we saw). TVs keep the
             * tight budget so a genuinely dead stream surfaces fast. */
            manifestLoadingMaxRetry: onAndroid ? 3 : 1,
            manifestLoadingRetryDelay: onAndroid ? 1000 : 500,
            manifestLoadingMaxRetryTimeout: onAndroid ? 20000 : 2000,
            levelLoadingMaxRetry: onAndroid ? 3 : 1,
            levelLoadingRetryDelay: onAndroid ? 1000 : 500,
            fragLoadingMaxRetry: onAndroid ? 4 : 2,
            fragLoadingRetryDelay: 1000
        });
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.MEDIA_ATTACHED, function () {
            hls.loadSource(url);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, function (ev, data) {
            // Log codec + level info so we can see when
            // hls.js gives up on HEVC streams.
            try {
                var levels = (data && data.levels) || hls.levels || [];
                var summary = [];
                for (var li = 0; li < levels.length && li < 6; li++) {
                    var lv = levels[li];
                    summary.push((lv.width || '?') + 'x' + (lv.height || '?') +
                                 '@' + (lv.bitrate || '?') +
                                 ' codecs=' + (lv.attrs && lv.attrs.CODECS || lv.codecSet || '?'));
                }
                plog('[player] HLS manifest parsed', levels.length + ' levels:', summary.join(' | '));
            } catch (logErr) {}
            try { videoEl.play(); } catch (e) {}
            showLoading(false);
        });
        // Same class of bug as the exo engine's onAudioTracksChanged, fixed
        // alongside it: hls.js reports alternate audio renditions via this
        // event, which can genuinely fire after the overlay's own refresh
        // already ran once — without this, getEmbeddedAudioTracks() already
        // has the right data (verified separately) but nothing re-ran
        // refreshOverlayContent() to show the button reflecting it.
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function () {
            try {
                var ov = Util.$('#infoOverlay');
                if (ov && !ov.classList.contains('hidden')) refreshOverlayContent();
            } catch (e) {}
        });
        hls.on(Hls.Events.ERROR, function (ev, data) {
            if (!data) return;
            plog('HLS error', data.type, data.details, data.fatal,
                data.response ? ('http=' + data.response.code) : '');
            /* Check 4xx even on non-fatal
             * errors. HLS.js fires non-fatal error events while it's
             * internally retrying. With the tight retry config above,
             * the first non-fatal error with a 4xx code is the strongest
             * signal we have that this stream is unrecoverable — escalate
             * to handleFatal immediately rather than waiting for HLS.js
             * to declare it fatal after its retry budget is exhausted. */
            var httpCode = data.response && data.response.code;
            if (httpCode && httpCode >= 400 && httpCode < 500) {
                plog('HLS terminal HTTP ' + httpCode + ' — giving up immediately (was fatal=' + data.fatal + ')');
                handleFatal(data);
                return;
            }
            if (!data.fatal) return;
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    if (networkRetryCount >= 1) {
                        plog('HLS network retry limit reached — giving up');
                        handleFatal(data);
                        break;
                    }
                    networkRetryCount++;
                    plog('HLS network error - retry startLoad (' + networkRetryCount + '/1)');
                    try { hls.startLoad(); } catch (e) { handleFatal(data); }
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    plog('HLS media error - recoverMediaError');
                    try { hls.recoverMediaError(); } catch (e) { handleFatal(data); }
                    break;
                default:
                    handleFatal(data);
            }
        });
    }

    function handleFatal(data) {
        // A stream remembered as "plays through hls.js" that now fails there: forget it, so native is tried first again.
        try { if (activeEngine === 'hlsjs' && lastStreamUrl && hlsFirstHas(lastStreamUrl)) hlsFirstDel(lastStreamUrl); } catch (eHd) {}
        // A TV's own HLS player failed on an .m3u8: one retry through hls.js before anything else.
        if (current && activeEngine === 'native' && hlsRescuable(lastStreamUrl || current.url)) {
            startHlsRescue(lastStreamUrl || current.url, 'failed');
            return;
        }
        // Try fallback URL once (Xtream TS fallback)
        if (current && current.fallbackUrl && !triedFallback) {
            triedFallback = true;
            plog('Trying fallback URL', (window.Crypto && Crypto.scrubUrl) ? Crypto.scrubUrl(current.fallbackUrl) : '[url]');
            // This fallback is Xtream's raw ".ts" URL (MPEG-TS). It
            // used to always force 'native' (the WebView <video> element) —
            // fine on webOS/Tizen, whose <video> wraps a hardware decoder that
            // plays TS directly, but Android's Chromium WebView has NO MPEG-TS
            // demuxer at all, so this silently failed there ("live ok .m3u8,
            // live not ok .ts"). It used to limp back to working only via the
            // slower error->ExoPlayer-rescue path below, and only when the
            // MediaError code happened to match looksLikeDecodeFail. Route
            // straight to ExoPlayer on Android when it's available, which
            // demuxes TS reliably; everywhere else keep forcing native,
            // unchanged.
            var tsEngine = true; // true == 'native' (webOS/Tizen/desktop, unchanged)
            try {
                if (window.PlayerExo && PlayerExo.isAvailable && PlayerExo.isAvailable()) {
                    tsEngine = 'exo';
                }
            } catch (eTsEng) {}
            startStream(current.fallbackUrl, tsEngine);
            return;
        }

        var sub = '';
        if (data) sub = (data.details || data.type || '') + ((data.response && data.response.code) ? (' http=' + data.response.code) : '');

        /* ExoPlayer RESCUE (Android): if the WebView <video>/hls.js path just
         * failed with a format/decode/source error, the most common real-world
         * cause is a codec the WebView can't decode — above all HEVC/H.265, which
         * is extremely common on live IPTV ("H265"/"4K"/"FHD HEVC" channels) and
         * on VOD. Crucially, neither Xtream nor Stalker nor plain M3U reliably
         * declares the codec up front, so we cannot always route to ExoPlayer in
         * advance (shouldHandle). This is the safety net: on a decode/format
         * failure, retry the SAME url once through native ExoPlayer, which has the
         * device's hardware HEVC/AC3 decoders. If ExoPlayer also fails, we fall
         * through to the real error below. H.264 is unaffected — it plays on the
         * WebView first and never reaches here. Fires for ANY source type, so it
         * fixes HEVC live/VOD on Stalker, Xtream and M3U alike. */
        var looksLikeDecodeFail = false;
        try {
            var d = String(sub || '').toLowerCase();
            // MediaError code 4 = MEDIA_ELEMENT_ERROR (unsupported/format);
            // code 3 = decode error. hls.js media errors also land here.
            looksLikeDecodeFail =
                d.indexOf('code-4') >= 0 || d.indexOf('code-3') >= 0 ||
                d.indexOf('format') >= 0 || d.indexOf('support') >= 0 ||
                d.indexOf('decode') >= 0 || d.indexOf('media') >= 0 ||
                d.indexOf('src') >= 0 || d === 'native-error';
        } catch (eLd) {}

        if ((looksLikeDecodeFail || triedExoStuck) && !triedExoRescue &&
            window.PlayerExo && PlayerExo.isAvailable && PlayerExo.isAvailable()) {
            triedExoRescue = true;
            if (triedExoStuck) { webFirstPending = ''; webFirstDel(lastStreamUrl || (current && current.url)); }
            plog('[player] native decode failure -> ExoPlayer rescue retry');
            try { if (window.XtivioDiag) window.XtivioDiag.log('EXO RESCUE: native failed (' + sub + ') -> retry via ExoPlayer'); } catch (eDg) {}
            // Restart the same channel forcing the exo engine.
            startStream(lastStreamUrl || (current && current.url), 'exo');
            return;
        }

        if (stalkerRefreshRetry()) return;
        showError(T('err_could_not_play'), friendlyErrorSub(sub));
        if (exoOfferable) offerExternalPlayer();
    }

    var nativePlaySeq = 0;

    // Native play() nudge. WebOS often needs play() called a few times before the
    // decoder latches, so startStream fires this at 0/150/600/1200ms. The early
    // attempts routinely reject ("no supported source" / format error) and then a
    // later one succeeds — i.e. a rejection here is usually benign noise, not a
    // failure. To avoid logging alarming errors on a successful play (which has
    // misled past debugging), a rejection is only surfaced as an error if, shortly
    // after, playback still has not started AND this attempt is still current.
    // Otherwise it is downgraded to a debug-gated log. seq ties the attempt to
    // its play sequence; startedRef is the per-sequence flag set in onReady.
    function safePlayVideo(vid, seq, startedRef) {
        if (!vid) return;
        function rejectionIsBenign() {
            // Superseded by a newer stream, or playback is underway / has started.
            if (typeof seq === 'number' && seq !== nativePlaySeq) return true;
            if (startedRef && startedRef.started) return true;
            // readyState >= 3 (HAVE_FUTURE_DATA) or actively progressing = playing.
            if (vid.readyState >= 3 || (!vid.paused && !vid.ended && vid.currentTime > 0)) return true;
            return false;
        }
        function handleReject(e) {
            // Defer the verdict: give the nudge sequence time to land before
            // deciding this was a real failure.
            setTimeout(function () {
                if (rejectionIsBenign()) {
                    plog('[player] native play() retry rejected (benign, playback proceeding/superseded)');
                } else {
                    Util.logErr('native play() error', e);
                }
            }, 1400);
        }
        try {
            var p = vid.play();
            if (p && typeof p['catch'] === 'function') {
                p['catch'](handleReject);
            }
        } catch (e) {
            handleReject(e);
        }
    }

    var lastStreamUrl = null;

    /* Restore the DOM after native (Exo/AVPlay) playback so the next WebView
     * (<video>/hls.js) stream is visible. Removes the exo punch-through attribute
     * and un-hides #videoEl. Module-scoped + idempotent so it can be called
     * defensively at every startStream and from stop() — the previous version was
     * a local closure only called on error, so after a SUCCESSFUL exo play the
     * page stayed transparent + #videoEl hidden and the next MP4 played invisibly
     * (audio only). Safe no-op when exo was never active. */
    function isHlsStream(u) { return /\.m3u8(\?|$)/i.test(String(u || '')); }
    function hlsAvailable() {
        try { return typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported(); } catch (e) { return false; }
    }
    /* Preferred Player is honoured only with DEBUG on (see pickEngine): outside it routing is always automatic. */
    function autoRouting() {
        try {
            var debugOn = (typeof window !== 'undefined' && window.APP_DEBUG) ||
                          (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG);
            var st = Store.getSettings ? Store.getSettings() : null;
            return !debugOn || !st || !st.player || st.player === 'auto';
        } catch (e) { return true; }
    }
    function streamKey(u) { return String(u || '').replace(/^[a-z]+:\/\//i, '').split('?')[0]; }
    function webFirstLoad() {
        try { var o = JSON.parse(localStorage.getItem(WEBFIRST_LS) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
    }
    function webFirstHas(u) { var t = webFirstLoad()[streamKey(u)]; return !!t && (Date.now() - t) < WEBFIRST_TTL; }
    function webFirstAdd(k) {
        try {
            var o = webFirstLoad(), n = Date.now(), keys = Object.keys(o);
            keys.forEach(function (x) { if (n - o[x] >= WEBFIRST_TTL) delete o[x]; });
            o[k] = n; keys = Object.keys(o);
            if (keys.length > 100) { keys.sort(function (a, b) { return o[a] - o[b]; }); while (keys.length > 100) delete o[keys.shift()]; }
            localStorage.setItem(WEBFIRST_LS, JSON.stringify(o));
        } catch (e) {}
    }
    function webFirstDel(u) {
        try { var o = webFirstLoad(); delete o[streamKey(u)]; localStorage.setItem(WEBFIRST_LS, JSON.stringify(o)); } catch (e) {}
    }
    function clearStartWd() { if (startWd) { clearTimeout(startWd); startWd = null; } }
    function clearHlsRescue() { if (hlsRescueTimer) { clearTimeout(hlsRescueTimer); hlsRescueTimer = null; } }
    function hlsFirstLoad() {
        try { var o = JSON.parse(localStorage.getItem(HLSFIRST_LS) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
    }
    function hlsFirstHas(u) { var t = hlsFirstLoad()[streamKey(u)]; return !!t && (Date.now() - t) < WEBFIRST_TTL; }
    function hlsFirstAdd(k) {
        try {
            var o = hlsFirstLoad(), n = Date.now(), keys = Object.keys(o);
            keys.forEach(function (x) { if (n - o[x] >= WEBFIRST_TTL) delete o[x]; });
            o[k] = n; keys = Object.keys(o);
            if (keys.length > 100) { keys.sort(function (a, b) { return o[a] - o[b]; }); while (keys.length > 100) delete o[keys.shift()]; }
            localStorage.setItem(HLSFIRST_LS, JSON.stringify(o));
        } catch (e) {}
    }
    function hlsFirstDel(u) {
        try { var o = hlsFirstLoad(); delete o[streamKey(u)]; localStorage.setItem(HLSFIRST_LS, JSON.stringify(o)); } catch (e) {}
    }
    /* True when a native <video> attempt on a TV for an .m3u8 URL may still be rescued through hls.js. */
    function hlsRescuable(url) {
        return !triedHlsRescue && isTvPlatform() && isHlsStream(url) && hlsAvailable() && autoRouting() &&
            !(window.AndroidBridge);
    }
    function startHlsRescue(url, why) {
        triedHlsRescue = true;
        hlsFirstPending = streamKey(url);
        clearHlsRescue();
        plog('[player] native HLS ' + why + ' -> retry through hls.js');
        try { if (window.XtivioDiag) window.XtivioDiag.log('HLS RESCUE: native ' + why + ' -> hls.js'); } catch (eDg) {}
        try { if (videoEl) { videoEl.pause(); } } catch (eP) {}
        armStartWd(current);   // the hls.js attempt gets its own full deadline
        startStream(url, 'hlsjs');
    }
    function armStartWd(channel) {
        clearStartWd();
        var vodLike = !!(channel && /^(movies?|vod|series)$/.test(String(channel.type || '')));
        var cfg = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG) || {};
        var ms = vodLike ? (cfg.START_DEADLINE_VOD_MS || 25000) : (cfg.START_DEADLINE_LIVE_MS || 12000);
        var gen = ++startWdGen;
        startWd = setTimeout(function () {
            startWd = null;
            if (gen !== startWdGen) return;
            try { if (window.PlayerAVPlay) PlayerAVPlay.stop(); } catch (eA) {}
            try { if (window.PlayerExo) PlayerExo.stop(); } catch (eE) {}
            clearExoStuck();
            destroyHls();
            restoreExoSurface();
            try { if (videoEl) videoEl.pause(); } catch (eV) {}
            lastErrCode = 'E-TIME';
            fireStateEvent('error', 'timeout');
            showError(T('err_could_not_play'), T('err_timeout'));
        }, ms);
    }
    function clearExoStuck() { if (exoStuckTimer) { clearTimeout(exoStuckTimer); exoStuckTimer = null; } }

    function restoreExoSurface() {
        try {
            document.documentElement.removeAttribute('data-exo-active');
            if (videoEl) {
                videoEl.style.visibility = '';
                var st = videoEl.parentNode;
                if (st) { st.removeAttribute('data-avplay-active'); }
            }
        } catch (e) {}
    }

    function startStream(url, forceEngine) {
        // A new stream always starts playing. The native-engine paused flags are
        // tracked in JS (the hidden <video> can't report them), and were never
        // reset, so pausing one video and then playing another left the flag
        // stuck on "paused": the overlay showed Play while the video was playing
        // and the first press only flipped the flag (it looked like nothing
        // happened).
        _exoPaused = false;
        _exoBuffering = false;
        _exoPosAt = 0;
        _avPaused = false;
        clearExoStuck();
        hideError();
        if (loadingEl) {
            if (exoPictureUp && activeEngine === 'exo' && !forceEngine) loadingEl.classList.add('zap');
            else loadingEl.classList.remove('zap');
        }
        showLoading(true);
        lastStreamUrl = url;
        // forceEngine: 'native' | 'exo' | true (legacy = native) | falsy (auto).
        var engine;
        if (forceEngine === 'exo') {
            engine = 'exo';
        } else if (forceEngine === 'native' || forceEngine === true) {
            engine = 'native';
        } else if (forceEngine === 'hlsjs') {
            engine = hlsAvailable() ? 'hlsjs' : 'native';
        } else {
            engine = pickEngine(current);
            // This stream already sat on "loading" in ExoPlayer and played in the WebView: go there directly.
            if (engine === 'exo' && !triedExoRescue && isHlsStream(url) && hlsAvailable() && autoRouting() && webFirstHas(url)) {
                engine = 'hlsjs';
                triedExoStuck = true;
                plog('[player] remembered: this stream plays in the WebView, ExoPlayer skipped');
            }
        }
        // A TV stream whose native HLS attempt stalled before and played through hls.js: go there directly.
        if (!forceEngine && engine === 'native' && !triedHlsRescue && isTvPlatform() && isHlsStream(url) && hlsAvailable() && autoRouting() && hlsFirstHas(url)) {
            engine = 'hlsjs';
            triedHlsRescue = true;
            plog('[player] remembered: this stream plays through hls.js on this TV');
        }
        clearHlsRescue();
        activeEngine = engine;
        currentSpeedIdx = 2; // every new video starts at 1x (the engines reset their own speed)
        lunaGen++;
        if (engine === 'native' && hlsRescuable(url)) {
            var rescueGen = startWdGen, rescueUrl = url;
            hlsRescueTimer = setTimeout(function () {
                hlsRescueTimer = null;
                // Still waiting for the first picture: the deadline watchdog is armed and not yet cleared.
                if (rescueGen === startWdGen && startWd && !triedHlsRescue && activeEngine === 'native') startHlsRescue(rescueUrl, 'did not start');
            }, HLS_RESCUE_MS);
        }
        if (engine !== 'exo' && loadingEl) loadingEl.classList.remove('zap');
        fireStateEvent('engine', engine);

        // Restore the DOM surface whenever we're NOT taking the exo path, so a
        // previous exo playback's transparency/#videoEl-hidden state can't leak
        // into a WebView (<video>/hls.js) stream and make it play invisibly.
        if (engine !== 'exo') restoreExoSurface();

        // If asked to force exo but ExoPlayer isn't actually available, fall back
        // to native so we never dead-end.
        if (engine === 'exo' && !(window.PlayerExo && PlayerExo.isAvailable && PlayerExo.isAvailable())) {
            engine = 'native';
            activeEngine = 'native';
            fireStateEvent('engine', 'native');
        }

        // On-screen diagnostic (temporary): report engine choice + container +
        // the actual channel fields, so we can see what Stalker/Xtream provide
        // to route on. Stalker streams often have no extension/codec + a
        // tokenized URL, which is why MKV falls through to the WebView.
        try {
            if (window.XtivioDiag) {
                var ext = current ? (current.containerExtension || current.container_extension || '') : '';
                var codec = current ? (current.videoCodec || current.video_codec || '') : '';
                var src = (current && current.sourceType) || (current && current.source_type) || (current && current.type) || '?';
                // Scrub the URL: keep the shape (path/extension) but strip
                // credentials/host so it's safe to show on screen. If scrubUrl is
                // somehow unavailable, fall back to showing ONLY the path's file
                // part (never the query string, which carries mac/token/etc).
                var scrubbed = '';
                try {
                    var u = String(url || '');
                    if (window.Crypto && Crypto.scrubUrl) {
                        scrubbed = Crypto.scrubUrl(u);
                    } else {
                        // Safe fallback: drop host AND the entire query string
                        // (where mac=, play_token=, sn= live), keep only the path.
                        scrubbed = u.replace(/\?[\s\S]*$/, '?[REDACTED]').replace(/\/\/[^/]+/, '//<host>');
                    }
                    // Shorten by trimming the MIDDLE of the path only (never
                    // re-expose the query); keep the tail so the extension shows.
                    if (scrubbed.length > 90) scrubbed = scrubbed.slice(0, 45) + '...' + scrubbed.slice(-42);
                } catch (eScrub) { scrubbed = '[url]'; }
                window.XtivioDiag.log('PLAY engine=' + engine + ' src=' + src + ' ext=' + (ext || '?') + ' codec=' + (codec || '?'));
                window.XtivioDiag.log('  url=' + scrubbed);
                // Dump which channel keys exist (names only, no values) so we can
                // see if Stalker exposes a container hint under a different key.
                try {
                    if (current) {
                        var keys = [];
                        for (var k in current) { if (current.hasOwnProperty(k)) keys.push(k); }
                        window.XtivioDiag.log('  keys=' + keys.join(','));
                    }
                } catch (eKeys) {}
            }
        } catch (eDiag) {}

        // Log engine + source for diagnostics. Xtream
        // URLs are opaque (no obvious codec) so we capture container
        // hints and engine choice. Later, on loadedmetadata, we also
        // dump the actual codec the browser ended up using.
        try {
            plog('[player] startStream',
                'engine=' + engine,
                'pref=' + (Store.getSettings().player || 'auto'),
                'forceEngine=' + (forceEngine || 'auto'),
                'url=' + ((window.Crypto && Crypto.scrubUrl) ? Crypto.scrubUrl(url) : '[url]'));
        } catch (logErr) {}

        if (engine === 'avplay') {
            destroyHls();
            try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (eV) {}
            // Reveal the AVPlay HW video plane: hide the <video> element and make
            // the stage transparent so the plane behind the webview shows through.
            try {
                videoEl.style.visibility = 'hidden';
                var stageEl = videoEl.parentNode;
                if (stageEl) { stageEl.style.background = 'transparent'; stageEl.setAttribute('data-avplay-active', '1'); }
                if (document.body) document.body.style.background = 'transparent';
            } catch (eBg) {}
            var avSeq = ++nativePlaySeq;
            var avStartMs = 0;
            try {
                if (current && current.currentTime && current.currentTime > 1) {
                    avStartMs = Math.round(current.currentTime * 1000);
                }
            } catch (eT) {}
            var restoreVideoSurface = function () {
                try {
                    videoEl.style.visibility = '';
                    var st = videoEl.parentNode;
                    if (st) { st.style.background = ''; st.removeAttribute('data-avplay-active'); }
                    if (document.body) document.body.style.background = '';
                } catch (eRs) {}
            };
            var handedOff = false;
            try {
                handedOff = PlayerAVPlay.play(url, { startTimeMs: avStartMs }, {
                    onReady: function () {
                        if (avSeq !== nativePlaySeq) return;
                        showLoading(false);
                        plog('[player] avplay ready');
                        // Apply the saved video scaling to the AVPlay plane (the
                        // hidden <video> App.applyVideoScale styles is not what is
                        // on screen on this engine).
                        try {
                            if (window.App && App.applyVideoScale) {
                                var stAv = Store.getSettings ? Store.getSettings() : null;
                                App.applyVideoScale((stAv && stAv.videoScale) || 'contain');
                            }
                        } catch (eAvSc) {}
                    },
                    onBuffering: function (on) { showLoading(!!on); },
                    onTime: function (ms) {
                        // AVPlay has no timeupdate event; refresh the overlay clock
                        // from its play-time callback while the overlay is showing.
                        try {
                            var ov = Util.$('#infoOverlay');
                            if (ov && !ov.classList.contains('hidden')) refreshOverlayContent();
                        } catch (e) {}
                    },
                    onEnded: function () { plog('[player] avplay ended'); },
                    onError: function (detail) {
                        if (avSeq !== nativePlaySeq) return;
                        plog('[player] avplay error -> native fallback', detail);
                        // Platform player failed: restore the surface and fall back
                        // to the browser path once, so a bad AVPlay call doesn't
                        // dead-end the stream.
                        try { PlayerAVPlay.stop(); } catch (eS) {}
                        restoreVideoSurface();
                        startStream(url, true);
                    }
                });
            } catch (eAV) {
                plog('[player] avplay threw -> native fallback', eAV && eAV.message);
                handedOff = false;
            }
            if (!handedOff) {
                // AVPlay wasn't actually available/usable — use the native path.
                startStream(url, true);
            }
            return;
        }

        if (engine === 'exo') {
            // Android native ExoPlayer. Same surface contract as AVPlay: hide the
            // <video> element and make the stage/body transparent so the native
            // SurfaceView (rendered by the shell behind the WebView) shows
            // through, while the loading/subtitle/info overlays keep painting on
            // top. On any native error, restore the surface and fall back to the
            // WebView path once so a bad ExoPlayer call never dead-ends a stream.
            destroyHls();
            try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (eV) {}
            try {
                // COMPLETE PUNCH-THROUGH for Android ExoPlayer: the native video
                // is a SurfaceView BEHIND the (natively transparent) WebView. For
                // it to show through, EVERY layer between must be transparent —
                // html, body, #app, .player-stage, and #videoEl. The old code
                // only cleared body + stage and left html (#06070a) and #app
                // (gradient) opaque, so the video was hidden behind them (the
                // "LOADING STREAM" background you saw). We set a single attribute
                // on <html> and let mobile/exo CSS punch the whole chain, plus
                // hide the <video> element. This mirrors what the AVPlay path
                // needs but Android needs MORE layers cleared (Tizen's WebView is
                // transparent by default; Android's is not, and its DOM chain is
                // opaque top-to-bottom).
                //
                // The mini player showed video across the whole screen:
                // this used to run unconditionally for ANY exo playback,
                // fullscreen player or mini player — this function has no
                // concept of which one is driving. Its CSS
                // (html[data-exo-active] .screen) matches ANY .screen element,
                // not just #player specifically — so it was ALSO clearing the
                // currently-active screen's background (Live TV, whatever it
                // is) whenever the mini player played via exo, on top of the
                // mini-specific punch-through (data-exo-mini-active) that's
                // actually meant for this case. Skip it entirely when the mini
                // player is the one driving — its own narrower punch-through
                // (live-top-mini.js) is the only one that should apply then.
                var miniIsDriving = !!(window.LiveTopMiniPlayer && LiveTopMiniPlayer.isActive && LiveTopMiniPlayer.isActive());
                if (!miniIsDriving) {
                    document.documentElement.setAttribute('data-exo-active', '1');
                }
                videoEl.style.visibility = 'hidden';
                var exStage = videoEl.parentNode;
                if (exStage) { exStage.setAttribute('data-avplay-active', '1'); }
            } catch (eBg2) {}
            var exSeq = ++nativePlaySeq;
            var exStartMs = 0;
            try {
                if (current && current.currentTime && current.currentTime > 1) {
                    exStartMs = Math.round(current.currentTime * 1000);
                }
            } catch (eT2) {}
            var exoHandedOff = false;
            try {
                exoHandedOff = PlayerExo.play(url, { startTimeMs: exStartMs, live: !isVod() }, {
                    onReady: function () {
                        if (exSeq !== nativePlaySeq) return;
                        clearExoStuck();
                        showLoading(false);
                        plog('[player] exo ready');
                        // Push the saved video scaling to the native surface (the
                        // hidden <video> that applyVideoScale styles is not what
                        // is on screen on this engine).
                        try {
                            if (window.App && App.applyVideoScale) {
                                var stSc = Store.getSettings ? Store.getSettings() : null;
                                App.applyVideoScale((stSc && stSc.videoScale) || 'contain');
                            }
                        } catch (eSc) {}
                        fireStateEvent('ready', {});
                    },
                    onBuffering: function (on) {
                        _exoBuffering = !!on;
                        if (!on) _exoPosAt = Date.now();   // resume the subtitle clock from the last report
                        showLoading(!!on);
                        fireStateEvent('buffering', !!on);
                    },
                    // Native play/pause truth (also fires when Android pauses
                    // playback itself, e.g. audio focus taken by another app).
                    onPlayState: function (paused) {
                        if (exSeq !== nativePlaySeq) return;
                        _exoPaused = !!paused;
                        if (!paused) _exoPosAt = Date.now();
                        try {
                            var ovp = Util.$('#infoOverlay');
                            if (ovp && !ovp.classList.contains('hidden')) refreshOverlayContent();
                        } catch (e) {}
                    },
                    onTime: function (ms, dur, aheadMs) {
                        // Remember the latest native position/duration so the
                        // seekbar + overlay can read it (the hidden <video> has no
                        // time on the exo path).
                        _exoPosMs = ms || 0;
                        _exoPosAt = Date.now();
                        _exoDurMs = dur || 0;
                        _exoAheadMs = aheadMs || 0;
                        try {
                            var ov = Util.$('#infoOverlay');
                            if (ov && !ov.classList.contains('hidden')) refreshOverlayContent();
                        } catch (e) {}
                    },
                    onEnded: function () { plog('[player] exo ended'); },
                    // The audio-track button
                    // was absent, even with 2 real tracks and the
                    // overlay open and paused: getEmbeddedAudioTracks()
                    // already returned the right data (fixed separately), but
                    // nothing re-ran refreshOverlayContent() once the native
                    // "audioTracks" event actually arrived — the overlay's own
                    // refresh is VOD-only (seekRefreshTimer, gated on isVod(),
                    // and this MKV test was played as a LIVE entry, matching
                    // exactly the LIVE label) or tied to
                    // onTime ticks, which may not continue firing once paused.
                    // Triggers a refresh directly instead of depending on
                    // either.
                    onAudioTracksChanged: function () {
                        try {
                            var ov = Util.$('#infoOverlay');
                            if (ov && !ov.classList.contains('hidden')) refreshOverlayContent();
                        } catch (e) {}
                    },
                    onError: function (detail) {
                        if (exSeq !== nativePlaySeq) return;
                        clearExoStuck();
                        plog('[player] exo error', detail, 'rescue=' + triedExoRescue);
                        fireStateEvent('error', detail);
                        try {
                            if (window.XtivioDiag) {
                                var safeDetail = detail || '';
                                try { if (window.Crypto && Crypto.scrubUrl) safeDetail = Crypto.scrubUrl(String(safeDetail)); } catch (eSc) {}
                                window.XtivioDiag.log('EXO ERROR: ' + safeDetail + (triedExoRescue ? ' (was rescue -> give up)' : ' -> webview fallback'));
                            }
                        } catch (eD) {}
                        try { PlayerExo.stop(); } catch (eS2) {}
                        restoreExoSurface();
                        // The WebView cannot open containers like MKV or AVI at all, so for those a
                        // fallback only gave sound with no picture (an MKV with MPEG-4 video and MP2
                        // audio did exactly that). Show the real error instead. A plain mp4/HLS
                        // stream still gets the WebView as the last resort: it has software
                        // decoders (VP9, AV1) that the device's hardware codecs may lack.
                        var exoDecodeFail = /ERROR_CODE_(DECODER_|DECODING_)/i.test(String(detail || ''));
                        var exoNoWebview = /\.(mkv|avi|wmv|flv|mpe?g|mov|m2ts|divx|xvid)(\?|$)/i.test(String(url || ''));
                        exoOfferable = /ERROR_CODE_(DECODER_|DECODING_|PARSING_)/i.test(String(detail || ''));
                        if (stalkerRefreshRetry()) return;
                        // Xtream live: the .m3u8 failed in Exo, so try the raw .ts in Exo too
                        // BEFORE handing anything to the WebView (which has no MPEG-TS demuxer).
                        // Decode failures skip this: a different container will not fix a codec.
                        if (current && current.fallbackUrl && !triedFallback && !triedExoRescue &&
                            !exoDecodeFail && url !== current.fallbackUrl) {
                            triedFallback = true;
                            plog('[player] exo error -> exo fallback url');
                            startStream(current.fallbackUrl, 'exo');
                            return;
                        }
                        if (!triedExoRescue && exoNoWebview) {
                            showError(T('err_could_not_play'), friendlyErrorSub(detail || 'exo-error'));
                            if (exoOfferable) offerExternalPlayer();
                            return;
                        }
                        if (triedExoRescue) {
                            // ExoPlayer was already the rescue for a native decode
                            // failure and it ALSO failed — the stream is genuinely
                            // unplayable. Don't bounce back to native (that just
                            // fails again); show the real error now.
                            showError(T('err_could_not_play'), friendlyErrorSub(detail || 'exo-error'));
                        } else {
                            // Exo was tried first and failed: the WebView is the last
                            // resort. Mark Exo as already tried so a WebView decode error
                            // goes straight to the error screen instead of bouncing back
                            // to Exo for a pointless second attempt.
                            triedExoRescue = true;
                            // If the failed URL was the raw .ts fallback, the WebView gets the
                            // original (HLS) address, not the .ts it cannot demux.
                            startStream((current && current.fallbackUrl && url === current.fallbackUrl && current.url) ? current.url : url, true);
                        }
                    }
                });
            } catch (eEX) {
                plog('[player] exo threw -> webview fallback', eEX && eEX.message);
                exoHandedOff = false;
            }
            if (!exoHandedOff) {
                restoreExoSurface();
                startStream(url, true);
            } else if (!triedExoRescue && !triedExoStuck && isHlsStream(url) && hlsAvailable() && autoRouting()) {
                // Watchdog: an HLS stream that is not ready after a few seconds goes to the WebView (hls.js).
                var stuckMs = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.EXO_STUCK_MS) || 5000;
                exoStuckTimer = setTimeout(function () {
                    exoStuckTimer = null;
                    if (exSeq !== nativePlaySeq) return;
                    plog('[player] exo not ready after ' + stuckMs + ' ms -> WebView (hls.js)');
                    triedExoStuck = true;
                    webFirstPending = streamKey(url);
                    try { PlayerExo.stop(); } catch (eSt) {}
                    restoreExoSurface();
                    startStream(url, 'hlsjs');
                }, stuckMs);
            }
            return;
        }

        // Hand the URL to hls.js whenever the engine
        // resolved to 'hlsjs', regardless of whether the URL ends in
        // .m3u8. Many Xtream providers serve HLS playlists at URLs like
        // host/live/USER/PASS/12345 (no extension) or .../12345.ts —
        // the previous /\.m3u8/ check rejected those and the code fell
        // through to the native branch, which then tried to play a
        // bare HLS playlist as a media file. Result: nothing played.
        // hls.js can detect the manifest itself and will report a
        // clean error if it really isn't HLS, which we'll surface.
        if (engine === 'hlsjs') {
            attachHls(url);
        } else {
            destroyHls();
            
            var seq = ++nativePlaySeq;
            var startedRef = { started: false };
            var onReady;
            
            onReady = function () {
                if (seq !== nativePlaySeq) return;
                try { videoEl.removeEventListener('loadedmetadata', onReady); } catch (e) {}
                try { videoEl.removeEventListener('canplay', onReady); } catch (e2) {}
                try { videoEl.removeEventListener('canplaythrough', onReady); } catch (e3) {}
                // Dump what the browser actually parsed.
                // Helps diagnose HEVC vs H.264 routing — on WebOS, HEVC
                // goes through the hardware path which can't be driven
                // by hls.js MSE. videoWidth/Height confirm media loaded.
                try {
                    var vt = videoEl.videoTracks && videoEl.videoTracks[0];
                    var at = videoEl.audioTracks && videoEl.audioTracks[0];
                    plog('[player] native ready',
                        videoEl.videoWidth + 'x' + videoEl.videoHeight,
                        vt ? ('vt-label=' + vt.label) : 'no-videoTracks',
                        at ? ('at-label=' + at.label) : 'no-audioTracks',
                        'duration=' + videoEl.duration);
                } catch (logErr2) {}
                startedRef.started = true;
                safePlayVideo(videoEl, seq, startedRef);
            };

            try {
                // CORRECTED: Pause and strip old src, but DO NOT call .load() while empty
                videoEl.pause();
                videoEl.removeAttribute('src');

                videoEl.autoplay = true;
                videoEl.setAttribute('autoplay', 'autoplay');
                videoEl.setAttribute('playsinline', 'playsinline');
                videoEl.setAttribute('webkit-playsinline', 'webkit-playsinline');
                videoEl.removeAttribute('muted'); 

                videoEl.addEventListener('loadedmetadata', onReady);
                videoEl.addEventListener('canplay', onReady);
                videoEl.addEventListener('canplaythrough', onReady);

                // Now assign the new source. On webOS, MKV needs a mediaOption
                // <source> to reach the HW demuxer; everywhere else (and for
                // non-MKV on webOS) the plain src path is used, unchanged.
                var usedWebosSource = false;
                try {
                    if (window.PlayerAVPlay && PlayerAVPlay.webosShouldApply && PlayerAVPlay.webosShouldApply(current)) {
                        usedWebosSource = PlayerAVPlay.webosApplySource(videoEl, url, {});
                    }
                } catch (eWos) { usedWebosSource = false; }
                if (!usedWebosSource) {
                    videoEl.src = url;
                }
                videoEl.load();
                
                safePlayVideo(videoEl, seq, startedRef);

                setTimeout(function () {
                    if (seq !== nativePlaySeq) return;
                    safePlayVideo(videoEl, seq, startedRef);
                }, 150);

                setTimeout(function () {
                    if (seq !== nativePlaySeq) return;
                    safePlayVideo(videoEl, seq, startedRef);
                }, 600);

                setTimeout(function () {
                    if (seq !== nativePlaySeq) return;
                    safePlayVideo(videoEl, seq, startedRef);
                }, 1200);

            } catch (e) {
                Util.logErr('native attach error', e);
                handleFatal({ details: 'native-attach-failed' });
            }
        }
    }

    /* Xtream live channels cached or saved before 1.0.4.1 carry the old bare URL
     * (host/USER/PASS/ID.m3u8) with no /live/ segment. Some panels only redirect
     * the standard /live/ form to their token host, so rewrite the stored URLs
     * before playing. Only type 'xtream' channels whose URL starts with exactly
     * this playlist's bare prefix are touched; M3U and VOD URLs are left alone. */
    function upgradeLegacyXtreamUrl(channel) {
        try {
            if (!channel || channel.type !== 'xtream' || channel.streamId == null || !channel.url) return;
            var pls = Store.getPlaylists ? Store.getPlaylists() : [];
            var pl = null;
            for (var i = 0; i < pls.length; i++) {
                if (pls[i].id === channel.playlistId) { pl = pls[i]; break; }
            }
            if (!pl || !pl.host || !pl.user) return;
            var base = String(pl.host).replace(/\/$/, '');
            var creds = encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/';
            var bare = base + '/' + creds;
            var live = base + '/live/' + creds;
            if (channel.url.indexOf(bare) === 0) channel.url = live + channel.url.slice(bare.length);
            if (channel.fallbackUrl && channel.fallbackUrl.indexOf(bare) === 0) {
                channel.fallbackUrl = live + channel.fallbackUrl.slice(bare.length);
            }
        } catch (eUp) {}
    }

    function play(channel) {
        if (!channel) return;
        armStartWd(channel);
        extHandoff = 0;
        upgradeLegacyXtreamUrl(channel);
        // Stalker channels carry no direct URL — resolve one per-play (tokens
        // are ephemeral) via our server, then play. Live and VOD use different
        // resolve endpoints.
        if (channel.type === 'stalker' && !channel.url) {
            current = channel;
            if (!channel.catchup) { try { Store.setLastChannel(channel); } catch (e) {} }
            // The link is resolved by a server call that can take seconds. Clear the previous stream's error
            // screen NOW: it used to stay up until the link arrived (startStream clears it), so a new play
            // after a failed one showed the old failure first and only then started loading.
            hideError();
            showLoading(true);
            var spl = null;
            try {
                var pls = Store.getPlaylists ? Store.getPlaylists() : [];
                for (var pi = 0; pi < pls.length; pi++) {
                    if (pls[pi].id === channel.playlistId) { spl = pls[pi]; break; }
                }
            } catch (e) {}
            if (!spl) { showLoading(false); if (window.UI && UI.toast) UI.toast(T('portal_not_found'), 'err'); return; }
            var resolver = stalkerResolverFor(spl, channel, false);
            resolver.then(function (res) {
                    var url = res && res.url;
                    if (current !== channel) return; // user moved on while resolving
                    if (!url) { showLoading(false); if (window.UI && UI.toast) UI.toast(T('could_not_load_stream'), 'err'); return; }
                    channel.url = url;
                    playResolved(channel);
                })['catch'](function (e) {
                    if (current !== channel) return;
                    showLoading(false);
                    if (window.UI && UI.toast) UI.toast(T('stream_error') + ' ' + ((e && e.body && e.body.error) || 'failed'), 'err')
                });
            return;
        }
        if (!channel.url) return;
        playResolved(channel);
    }

    /* The server call that turns a Stalker channel/movie/episode into a stream URL. fresh = the
     * saved link failed to play, so live channels ask the portal for a new link instead of the saved one
     * (movies and episodes always get a new link from create_link anyway). */
    function stalkerResolverFor(spl, ch, fresh) {
        if (ch.stalkerKind === 'archive') return Api.stalkerArchiveResolve(spl, ch.stalkerProgId);   // catch-up programme: always a new link
        if (ch.stalkerKind === 'vod') return Api.stalkerVodResolve(spl, ch.stalkerCmd, ch.stalkerOpenId);
        // Series episodes resolve from the SEASON cmd plus the episode number (no per-episode cmd).
        if (ch.stalkerKind === 'series') return Api.stalkerSeriesResolve(spl, ch.stalkerCmd, ch.stalkerEpisode);
        return Api.stalkerResolve(spl, ch.stalkerCmd, ch.stalkerId, ch.stalkerGenreId, fresh);
    }

    /* A Stalker stream failed to play (not a decoder problem): ask the server for a fresh link and start
     * once more. Links go stale (play tokens expire, a portal replaces the token). Returns true when a
     * retry was started, so the caller stops there; false leaves the normal fallback/error path to run. */
    function stalkerRefreshRetry() {
        try {
            var ch = current;
            if (!ch || ch.type !== 'stalker' || stalkerRefreshed || exoOfferable) return false;
            var spl = null;
            var pls = Store.getPlaylists ? Store.getPlaylists() : [];
            for (var pi = 0; pi < pls.length; pi++) { if (pls[pi].id === ch.playlistId) { spl = pls[pi]; break; } }
            if (!spl) return false;
            stalkerRefreshed = true;
            showLoading(true);
            plog('[player] stalker stream failed -> asking for a fresh link');
            stalkerResolverFor(spl, ch, true).then(function (res) {
                if (current !== ch) return;
                var url = res && res.url;
                if (!url) { showError(T('err_could_not_play'), friendlyErrorSub('')); return; }
                ch.url = url;
                startStream(url, false);
            })['catch'](function (e) {
                if (current !== ch) return;
                var why = (e && e.body && e.body.error) ? String(e.body.error) : '';
                if (why) lastErrCode = 'E-STK';
                showError(T('err_could_not_play'), why || friendlyErrorSub(''));
            });
            return true;
        } catch (eRr) { return false; }
    }

    function playResolved(channel) {
        current = channel;
        triedFallback = false;
        triedExoRescue = false;
        triedExoStuck = false;
        webFirstPending = '';
        triedHlsRescue = false;
        hlsFirstPending = '';
        exoOfferable = false;
        externalOffered = false;
        stalkerRefreshed = false;
        networkRetryCount = 0;
        // Save as last played channel (a catch-up programme is not a channel to return to)
        if (!channel.catchup) { try { Store.setLastChannel(channel); } catch (e) {} }
        startStream(channel.url, false);
        // Live TV and VOD start with the fullscreen overlay closed.
        // Users can open it with OK/Info/navigation, matching VOD behaviour.
        hideOverlay();
        refreshOverlayContent();
        startEpgRefresh();
        // Auto-load subtitles for VOD items per the
        // user's saved language preference. The auto-loader handles
        // all the conditions (isVod, has preference, has matching
        // language for this item) and is silent on failure. Tiny delay
        // lets the video element finish attaching its source so the
        // <track> element we add actually applies on first play.
        setTimeout(function () {
            if (window.UI && UI.autoLoadSubtitlesForItem) {
                try { UI.autoLoadSubtitlesForItem(channel); } catch (e) {}
            }
        }, 250);
    }

    function stop() {
        clearStartWd();
        clearHlsRescue();
        startWdGen++;
        clearExoStuck();
        exoPictureUp = false;
        // Clear any subtitle tracks first so the old VTT
        // doesn't briefly attach to whatever video plays next.
        try { clearSubtitles(); } catch (e) {}
        try { if (window.PlayerAVPlay) PlayerAVPlay.stop(); } catch (eAV) {}
        try { if (window.PlayerExo) PlayerExo.stop(); } catch (eEX) {}
        // Restore the exo/native surface state (removes data-exo-active + un-hides
        // #videoEl) so the next WebView stream is visible. Was previously missing
        // from stop(), so exo state leaked into the next play.
        restoreExoSurface();
        // Restore any surface transparency the AVPlay path applied.
        try {
            if (videoEl) {
                videoEl.style.visibility = '';
                var st = videoEl.parentNode;
                if (st) { st.style.background = ''; st.removeAttribute('data-avplay-active'); }
            }
            if (document.body) document.body.style.background = '';
        } catch (eRs) {}
        destroyHls();
        // webOS content is attached via a CHILD <source> element, not
        // videoEl.src (see PlayerAVPlay.webosApplySource's own comment) —
        // removeAttribute('src') below does nothing for it, and without this
        // the subsequent load() call re-evaluates that still-attached source
        // instead of releasing it, which is exactly why audio kept playing
        // after backing out of the player on webOS. No-op on every other
        // backend/platform.
        try { if (window.PlayerAVPlay && PlayerAVPlay.webosClearSource) PlayerAVPlay.webosClearSource(videoEl); } catch (eWC) {}
        try {
            videoEl.pause();
            videoEl.removeAttribute('src');
            videoEl.load();
        } catch (e) {}
        stopEpgRefresh();
        hideOverlay();
        current = null;
    }

    function togglePause() {
        if (activeEngine === 'avplay' && window.PlayerAVPlay) {
            try {
                if (_avPaused) { PlayerAVPlay.resume(); _avPaused = false; }
                else { PlayerAVPlay.pause(); _avPaused = true; }
                // Refresh the overlay so the play/pause icon reflects the new
                // state immediately. The AVPlay path (Tizen) drives a native
                // hardware player, not the <video> element, so nothing else
                // triggers the icon update — same gap as the exo path below.
                refreshOverlayContent();
            } catch (e) {}
            return;
        }
        if (activeEngine === 'exo' && window.PlayerExo) {
            try {
                if (_exoPaused) { PlayerExo.resume(); _exoPaused = false; }
                else { PlayerExo.pause(); _exoPaused = true; }
                // Refresh the overlay so the play/pause icon reflects the new
                // state immediately (the hidden <video> can't drive it).
                refreshOverlayContent();
            } catch (e) {}
            return;
        }
        if (!videoEl) return;
        try {
            if (videoEl.paused) videoEl.play();
            else videoEl.pause();
        } catch (e) {}
    }
    var _avPaused = false;
    var _exoPaused = false;
    var _exoPosMs = 0;
    var _exoDurMs = 0;
    var _exoAheadMs = 0;   // media buffered ahead of the playhead (native, 1 s ticks)
    var _exoPosAt = 0;          // Date.now() when _exoPosMs was last set (subtitle clock)
    var _exoBuffering = false;  // native engine is stalled: the subtitle clock holds

    /* ---- Overlay ---- */
    function clearOverlayTimer() {
        if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    }

    var seekRefreshTimer = null;
    function showOverlay() {
        if (!infoOverlayEl) return;
        infoOverlayEl.classList.add('show');
        refreshClock();
        exoUi(true);   // bring web UI forward over the exo video (no-op off exo)
        refreshOverlayContent();
        clearOverlayTimer();

        if (isVod()) {
            if (seekRefreshTimer) clearInterval(seekRefreshTimer);
            seekRefreshTimer = setInterval(refreshOverlayContent, 1000);
            // Paused → stay open (so the user can read info / use controls). Playing
            // → auto-hide after the idle timeout even with a button focused (focus
            // is just a highlight). Re-armed on each interaction.
            if (videoEl && videoEl.paused) {
                // No timer — stay open while paused
            } else {
                armOverlayHideTimer();
            }
            setTimeout(function () {
                // Preserve last focused transport button, default to play
                var lastKey = window._lastOverlayFocusKey;
                var restored = false;
                if (lastKey) restored = Focus.focusKey(lastKey);
                if (!restored) {
                    var playBtn = Util.$('#infoPlayBtn');
                    if (playBtn && playBtn.style.display !== 'none') Focus.focus(playBtn);
                }
            }, 50);
        } else {
            // Live TV: focus the play/pause transport button on open so the
            // overlay has an initial focus (previously it blurred and the first
            // key press was "wasted" just entering the overlay). Prefer the last
            // overlay focus if we have one.
            setTimeout(function () {
                var lastKey = window._lastOverlayFocusKey;
                var restored = false;
                if (lastKey) restored = Focus.focusKey(lastKey);
                if (!restored) {
                    var playBtnLive = Util.$('#infoPlayBtn');
                    if (playBtnLive && playBtnLive.offsetParent !== null) Focus.focus(playBtnLive);
                }
            }, 50);
            armOverlayHideTimer();
        }
    }

    /* Arm (or re-arm) the overlay auto-hide timer. Fires after the idle timeout
     * regardless of focus position or play/pause state — focus is just a
     * highlight. Stays open only while the mini channel list is showing. Call on
     * overlay show and on each interaction to reset the idle countdown. */
    function armOverlayHideTimer() {
        clearOverlayTimer();
        var ms = (Store.getSettings && Store.getSettings().overlayMs);
        if (ms == null) ms = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.OVERLAY_MS) || 5000;
        ms = parseInt(ms, 10);
        if (!(ms > 0)) return;
        overlayTimer = setTimeout(function () {
            if (videoEl && videoEl.paused) return; // paused → stay open
            var mini = document.getElementById('miniChannels');
            if (mini && mini.classList.contains('show')) return; // mini list open
            // A modal (e.g. the subtitle picker) is open over the player — don't
            // hide the overlay or blur focus out from under it. Re-arm so it hides
            // once the modal closes.
            var ml = document.getElementById('modalLayer');
            if (ml && !ml.classList.contains('hidden')) { armOverlayHideTimer(); return; }
            hideOverlay();
        }, ms);
    }
    function hideOverlay() {
        if (!infoOverlayEl) return;
        infoOverlayEl.classList.remove('show');
        refreshClock();
        clearOverlayTimer();
        if (seekRefreshTimer) { clearInterval(seekRefreshTimer); seekRefreshTimer = null; }
        window._lastOverlayFocusKey = null; // Reset on close
        // On the exo path, send the WebView back so the video is visible again —
        // but ONLY if we're not currently showing the loading spinner (which also
        // needs the WebView forward). If loading is visible, keep UI forward.
        var loadingVisible = loadingEl && !loadingEl.classList.contains('hidden');
        if (!loadingVisible) exoUi(false);
        // Don't steal focus if a modal is open and owns it.
        var ml = document.getElementById('modalLayer');
        if (ml && !ml.classList.contains('hidden')) return;
        Focus.blur();
    }

    /* The picture height in the info line ("720p"). hls.js knows it for an HLS level, the video element for a plain
     * stream played by the WebView; when ExoPlayer or AVPlay draws the picture natively the element has no size, so the
     * size the native player reported is used. Also called when native reports a size after the overlay is already up. */
    function refreshResolution() {
        var resEl = Util.$('#infoRes');
        var resSep = Util.$('#infoResSep');
        if (!resEl) return;
        var res = '';
        if (hls && hls.currentLevel >= 0 && hls.levels) {
            var lvl = hls.levels[hls.currentLevel];
            if (lvl && lvl.height) res = lvl.height + 'p';
        }
        if (!res && videoEl && videoEl.videoWidth > 0) {
            res = videoEl.videoHeight + 'p';
        }
        if (!res && activeEngine === 'exo' && window.PlayerExo && PlayerExo.getVideoSize) {
            var sz = null;
            try { sz = PlayerExo.getVideoSize(); } catch (eSz) {}
            if (sz && sz.h > 0) res = sz.h + 'p';
        }
        // frame rate, when ExoPlayer reported one ("720p · 25 fps")
        var fpsTxt = '';
        if (activeEngine === 'exo' && window.PlayerExo && PlayerExo.getVideoFps) {
            var fv = null;
            try { fv = PlayerExo.getVideoFps(); } catch (eFp) {}
            if (fv > 0) fpsTxt = Util.formatFps(fv) + ' fps';
        }
        if (fpsTxt) res = res ? res + ' \u00b7 ' + fpsTxt : fpsTxt;
        resEl.textContent = res || '';
        if (resSep) resSep.style.display = res ? 'inline' : 'none';
    }

    /* Clock in the corner of the picture, for people who want the time on screen without opening the info overlay.
     * Setting playerClock: 'off' (the clock is in the info overlay only) or 'always'. The overlay has its own clock,
     * so this one steps aside while the overlay is up. Works over ExoPlayer too (the page is see-through there). */
    var clockEl = null;
    function playerClockOn() {
        var st = null;
        try { st = (window.Store && Store.getSettings) ? Store.getSettings() : null; } catch (e) {}
        return !!(st && st.playerClock === 'always');
    }
    function refreshClock() {
        if (!clockEl) return;
        var scr = Util.$('#player');
        var up = !!(scr && scr.classList.contains('active'));
        var ov = !!(infoOverlayEl && infoOverlayEl.classList.contains('show'));
        var on = up && !ov && playerClockOn();
        clockEl.style.display = on ? '' : 'none';
        if (on) clockEl.textContent = Util.formatTime();
    }

    function refreshOverlayContent() {
        if (!current) return;
        var $ = Util.$;
        var isVodNow = isVod();

        // Top bar — common to both modes
        var n = $('#infoNum');
        if (n) {
            if (isVodNow) { n.textContent = ''; n.style.display = 'none'; }
            else { n.textContent = Util.pad(current.number || 0, 3); n.style.display = ''; }
        }
        var nm = $('#infoName'); if (nm) nm.textContent = Util.cleanseDisplayName(current.name || '');
        var ct = $('#infoCat'); if (ct) ct.textContent = Util.cleanseDisplayName(current.category || '');
        var pl = $('#infoPl'); if (pl) pl.textContent = current.playlistName || '';
        var tm = $('#infoTime'); if (tm) tm.textContent = Util.formatTime();

        refreshResolution();

        // Show/hide mode-specific blocks
        var epgBlock = $('#infoEpgBlock');
        var seekBlock = $('#infoSeekBlock');
        var transportDiv = $('#infoTransport');
        var speedBtn = $('#infoSpeedBtn');

        if (isVodNow) {
            if (epgBlock) epgBlock.style.display = 'none';
            if (seekBlock) seekBlock.style.display = 'block';
            if (transportDiv) transportDiv.style.display = 'flex';
            if (speedBtn) speedBtn.style.display = 'flex';
            var miniBtnVod = $('#infoMiniBtn');
            if (miniBtnVod) miniBtnVod.style.display = 'none';
            var infoBtnVod = $('#infoInfoBtn');
            if (infoBtnVod) infoBtnVod.style.display = 'none';
            // Prev/next-channel buttons (mobile touch only, see wirePlayerOverlay)
            // only make sense for Live TV — no "channel" concept for Movies/Series.
            var prevChBtnVod = $('#infoPrevChBtn');
            if (prevChBtnVod) prevChBtnVod.style.display = 'none';
            var nextChBtnVod = $('#infoNextChBtn');
            if (nextChBtnVod) nextChBtnVod.style.display = 'none';

            // Update seekbar
            var avActive = (activeEngine === 'avplay' && window.PlayerAVPlay);
            var exoActive = (activeEngine === 'exo' && window.PlayerExo);
            if (exoActive) {
                var curE = _exoPosMs / 1000;
                var durE = _exoDurMs / 1000;
                var pctE = durE > 0 ? (curE / durE) * 100 : 0;
                var elapsedE = $('#seekElapsed'); if (elapsedE) elapsedE.textContent = formatDuration(curE);
                var totalE = $('#seekTotal'); if (totalE) totalE.textContent = formatDuration(durE);
                var fillE = $('#seekFill'); if (fillE) fillE.style.width = pctE + '%';
                var bufE = $('#seekBuf');
                if (bufE) {
                    var bufPctE = durE > 0 ? ((_exoPosMs + _exoAheadMs) / _exoDurMs) * 100 : 0;
                    bufE.style.width = Math.max(pctE, Math.min(100, bufPctE)) + '%';
                }
                var thumbE = $('#seekThumb'); if (thumbE) thumbE.style.left = pctE + '%';
            } else if (avActive) {
                var curA = (PlayerAVPlay.getTime() || 0) / 1000;
                var durA = (PlayerAVPlay.getDuration() || 0) / 1000;
                var pctA = durA > 0 ? (curA / durA) * 100 : 0;
                var elapsedA = $('#seekElapsed'); if (elapsedA) elapsedA.textContent = formatDuration(curA);
                var totalA = $('#seekTotal'); if (totalA) totalA.textContent = formatDuration(durA);
                var fillA = $('#seekFill'); if (fillA) fillA.style.width = pctA + '%';
                var bufA = $('#seekBuf'); if (bufA) bufA.style.width = '0%';
                var thumbA = $('#seekThumb'); if (thumbA) thumbA.style.left = pctA + '%';
            } else if (videoEl) {
                var cur = videoEl.currentTime || 0;
                var dur = (videoEl.duration && isFinite(videoEl.duration)) ? videoEl.duration : 0;
                var pct = dur > 0 ? (cur / dur) * 100 : 0;
                var elapsed = $('#seekElapsed'); if (elapsed) elapsed.textContent = formatDuration(cur);
                var total = $('#seekTotal'); if (total) total.textContent = formatDuration(dur);
                var fill = $('#seekFill'); if (fill) fill.style.width = pct + '%';
                var bufV = $('#seekBuf');
                if (bufV) {
                    var bufRangeEnd = 0;
                    if (videoEl.buffered && videoEl.buffered.length > 0) bufRangeEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
                    var bufPctV = dur > 0 ? (bufRangeEnd / dur) * 100 : 0;
                    bufV.style.width = Math.max(pct, Math.min(100, bufPctV)) + '%';
                }
                var thumb = $('#seekThumb'); if (thumb) thumb.style.left = pct + '%';
            }

            // Play/pause icon + label
            var playLbl = $('#infoPlayLbl');
            var playIc = $('#infoPlayIc');
            if (avActive) {
                var pausedA = _avPaused;
                if (playLbl) playLbl.textContent = pausedA ? T('pl_play') : T('pl_pause');
                if (playIc) playIc.innerHTML = pausedA ?
                    '<polygon points="5,3 19,12 5,21"/>' :
                    '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
            } else if (activeEngine === 'exo') {
                // Exo (Stalker/native) path: the hidden <video> has no meaningful
                // paused state, so read our tracked _exoPaused flag — otherwise
                // the button icon never changes when you play/pause a Stalker item.
                if (playLbl) playLbl.textContent = _exoPaused ? T('pl_play') : T('pl_pause');
                if (playIc) playIc.innerHTML = _exoPaused ?
                    '<polygon points="5,3 19,12 5,21"/>' :
                    '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
            } else if (videoEl) {
                var paused = videoEl.paused;
                if (playLbl) playLbl.textContent = paused ? T('pl_play') : T('pl_pause');
                if (playIc) playIc.innerHTML = paused ?
                    '<polygon points="5,3 19,12 5,21"/>' :
                    '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
            }
        } else {
            // Live TV mode: EPG now/next + transport + mini channel + buffer bar
            if (epgBlock) epgBlock.style.display = '';
            if (seekBlock) seekBlock.style.display = 'block';
            if (transportDiv) transportDiv.style.display = 'flex';
            if (speedBtn) speedBtn.style.display = 'none';
            var miniBtn = $('#infoMiniBtn');
            if (miniBtn) miniBtn.style.display = 'flex';
            var infoBtnLive = $('#infoInfoBtn');
            if (infoBtnLive) infoBtnLive.style.display = 'none';
            // Prev/next-channel buttons: Live TV only, and only ever for touch
            // devices (replaces the old swipe gesture — see wirePlayerOverlay
            // in app.js). style.display is set explicitly every refresh rather
            // than relying solely on the init-hidden class removal, since an
            // inline style here would otherwise override that class on a
            // non-touch device the moment this (live) branch runs.
            var touchForCh = false;
            try { touchForCh = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eTfc) {}
            var prevChBtn = $('#infoPrevChBtn');
            if (prevChBtn) prevChBtn.style.display = touchForCh ? 'flex' : 'none';
            var nextChBtn = $('#infoNextChBtn');
            if (nextChBtn) nextChBtn.style.display = touchForCh ? 'flex' : 'none';

            // Live TV buffer progress
            if (activeEngine === 'exo') {
                // Native player: the bar shows how full the playback buffer is (seconds buffered
                // ahead against the Playback Buffer setting; Standard keeps about 15 s on live).
                var brSt = (window.Store && Store.getSettings) ? String((Store.getSettings() || {}).bufferReserve || 'off') : 'off';
                var brTarget = (brSt === 'off') ? 15 : (parseInt(brSt, 10) || 15);
                try { if (brSt !== 'off' && brTarget > 45 && window.PerfConfig && PerfConfig.isLite && PerfConfig.isLite()) brTarget = 45; } catch (eLt) {}
                var liveBuf = $('#seekBuf');
                if (liveBuf) liveBuf.style.width = Math.min(100, (_exoAheadMs / 1000) / brTarget * 100) + '%';
                var liveFill = $('#seekFill'); if (liveFill) liveFill.style.width = '0%';
                var liveThumb = $('#seekThumb'); if (liveThumb) liveThumb.style.left = '0%';
                var liveEl = $('#seekElapsed'); if (liveEl) liveEl.textContent = 'LIVE';
                var liveTot = $('#seekTotal'); if (liveTot) liveTot.textContent = T('live');
            } else if (videoEl) {
                var bufEnd = 0, bufStart = 0;
                if (videoEl.buffered && videoEl.buffered.length > 0) {
                    bufStart = videoEl.buffered.start(0);
                    bufEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
                }
                var bufDur = bufEnd - bufStart;
                var curPos = videoEl.currentTime - bufStart;
                var bufPct = bufDur > 0 ? (curPos / bufDur) * 100 : 0;
                if (bufPct < 0) bufPct = 0; if (bufPct > 100) bufPct = 100;

                var elapsed = $('#seekElapsed'); if (elapsed) elapsed.textContent = bufDur > 0 ? '-' + formatDuration(bufEnd - videoEl.currentTime) : 'LIVE';
                var total = $('#seekTotal'); if (total) total.textContent = T('live');
                var fill = $('#seekFill'); if (fill) fill.style.width = bufPct + '%';
                var thumb = $('#seekThumb'); if (thumb) thumb.style.left = bufPct + '%';
            }

            // Play/pause icon for Live TV too
            var playLblLive = $('#infoPlayLbl');
            var playIcLive = $('#infoPlayIc');
            var pausedLive;
            if (activeEngine === 'exo') pausedLive = _exoPaused;
            else if (activeEngine === 'avplay') pausedLive = _avPaused;
            else if (videoEl) pausedLive = videoEl.paused;
            else pausedLive = null;
            if (pausedLive !== null) {
                if (playLblLive) playLblLive.textContent = pausedLive ? T('pl_play') : T('pl_pause');
                if (playIcLive) playIcLive.innerHTML = pausedLive ?
                    '<polygon points="5,3 19,12 5,21"/>' :
                    '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
            }

            // EPG now/next
            var nn = Epg.getNowNext(current.playlistId, current.tvgId || current.epgId);
            var nowT = $('#epgNowTitle'), nowTime = $('#epgNowTime'), nowProg = $('#epgNowProg');
            var nextT = $('#epgNextTitle'), nextTime = $('#epgNextTime');
            if (nn.now) {
                if (nowT) nowT.textContent = nn.now.title || '';
                if (nowTime) nowTime.textContent = Util.formatTimeRange(new Date(nn.now.start), new Date(nn.now.stop));
                if (nowProg) {
                    var epgDur = nn.now.stop - nn.now.start;
                    var epgPct = epgDur > 0 ? Math.round(((Date.now() - nn.now.start) / epgDur) * 100) : 0;
                    if (epgPct < 0) epgPct = 0; if (epgPct > 100) epgPct = 100;
                    nowProg.style.width = epgPct + '%';
                }
            } else {
                if (nowT) nowT.textContent = T('no_program_info');
                if (nowTime) nowTime.textContent = '';
                if (nowProg) nowProg.style.width = '0%';
            }
            if (nn.next) {
                if (nextT) nextT.textContent = nn.next.title || '';
                if (nextTime) nextTime.textContent = Util.formatTimeRange(new Date(nn.next.start), new Date(nn.next.stop));
            } else {
                if (nextT) nextT.textContent = '-';
                if (nextTime) nextTime.textContent = '';
            }
        }

        // Favorite status
        var favLbl = $('#infoFavLbl');
        var favIcon = $('#infoFavIcon');
        if (favLbl || favIcon) {
            var isFav = Store.isFavorite(current);
            // Star icon: filled when favorited, outline when not — matches the app
            // and the favorites side menu.
            if (favIcon) {
                favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
                favIcon.setAttribute('stroke', 'currentColor');
            }
            if (favLbl) { favLbl.textContent = T('pl_favorites'); }
        }

        // Audio-track button: only show it when there is actually a choice to
        // make. IPTV streams are overwhelmingly single-audio (providers tend to
        // publish language variants as SEPARATE entries rather than as multiple
        // tracks in one stream), so the button was almost always a dead control
        // that answered with "No audio tracks available". Hiding it below two
        // tracks means it appears only when it can do something.
        //
        // Re-evaluated on every overlay refresh rather than once at load: tracks
        // are not known until the stream's manifest has been parsed, so a check
        // at play() time would usually run too early and hide a button that
        // should have been shown.
        //
        // The button was simply
        // absent from the overlay on a genuinely multi-audio MKV played
        // through the exo engine: this read videoEl.audioTracks directly, the SAME native
        // API confirmed elsewhere in this codebase to not exist in this
        // Chromium engine at all for hls.js content, and which is simply
        // irrelevant for exo/avplay — MKV plays on a native SurfaceView
        // behind the WebView (see MainActivity.kt's own class doc comment),
        // so videoEl has no real media attached to it whatsoever there. This
        // hid the button unconditionally for every engine except plain
        // progressive/native HLS playback, regardless of how many tracks
        // actually existed — including in every one of the automated tests
        // that verified the CLICK handler's own engine-aware logic (already
        // fixed, separately, before this), since a script calling .click()
        // on a display:none element still fires its listener; a real user
        // tapping the screen cannot do that. Now calls the same
        // getEmbeddedAudioTracks() the click handler itself already uses,
        // so the two can never disagree about whether a choice exists.
        var audioBtnEl = $('#infoAudioBtn');
        if (audioBtnEl) {
            var trackCount = 0;
            try { trackCount = getEmbeddedAudioTracks().length; } catch (eAT) { trackCount = 0; }
            audioBtnEl.style.display = (trackCount > 1) ? 'flex' : 'none';
        }

        // Subtitles button: same reasoning as the audio-track button above,
        // the same dead-control pattern — the subtitle
        // picker is VOD-only (Wyzie has no standard live-TV subtitle source),
        // so for live content every tap of this button did nothing but show
        // "subtitles available for movies and series". Hidden instead,
        // exactly matching the audio button's own precedent: a control that
        // can never do anything for the current content shouldn't be shown
        // at all, not shown-then-explained-away with a toast.
        var subBtnEl = $('#infoSubBtn');
        if (subBtnEl) {
            // NOT "var isVod = ..." here: isVod is already a function declared
            // elsewhere in this same module (used a few lines up in this very
            // function, as isVodNow = isVod()) — var hoisting would shadow
            // that function reference across the WHOLE function body, turning
            // its real, earlier call into "isVod is not a function". Caught by
            // actually running this rather than assuming the rename was safe.
            var subShouldShow = false;
            try { subShouldShow = !!isVod(); } catch (eSV) { subShouldShow = false; }
            subBtnEl.style.display = subShouldShow ? 'flex' : 'none';
        }
    }


    function showCurrentInfo() {
        if (!current) return;
        var txt = current.plot || current.description || current.synopsis || '';
        if (!txt) {
            try { if (window.UI && UI.toast) UI.toast(T('no_synopsis_available'), 'err'); } catch (e) {}
            return;
        }
        var body = document.createElement('div');
        body.className = 'modal-body';
        body.style.maxHeight = '520px';
        body.style.overflowY = 'auto';
        body.style.whiteSpace = 'normal';
        body.textContent = txt;
        if (window.UI && UI.openModal) UI.openModal({ title: Util.cleanseDisplayName(current.name || '') || T('pl_info'), bodyEl: body, cancelText: T('close') });
    }

    function formatDuration(secs) {
        if (!secs || !isFinite(secs) || secs < 0) return '0:00';
        var h = Math.floor(secs / 3600);
        var m = Math.floor((secs % 3600) / 60);
        var s = Math.floor(secs % 60);
        if (h > 0) return h + ':' + Util.pad(m, 2) + ':' + Util.pad(s, 2);
        return m + ':' + Util.pad(s, 2);
    }

    function startEpgRefresh() {
        stopEpgRefresh();
        epgRefreshTimer = setInterval(refreshOverlayContent, 30000);
    }
    function stopEpgRefresh() {
        if (epgRefreshTimer) { clearInterval(epgRefreshTimer); epgRefreshTimer = null; }
    }

    function currentChannel() { return current; }

    function init() {
        videoEl = Util.$('#videoEl');
        loadingEl = Util.$('#playerLoading');
        errorEl = Util.$('#playerError');
        errorSubEl = Util.$('#perrSub');
        errorCodeEl = Util.$('#perrCode');
        infoOverlayEl = Util.$('#infoOverlay');
        clockEl = Util.$('#playerClock');
        setInterval(refreshClock, 15000);

        if (!videoEl) { Util.logErr('Player.init: #videoEl missing'); return; }

        // Loading state on waiting events
        videoEl.addEventListener('waiting', function () { showLoading(true); });
        videoEl.addEventListener('playing', function () {
            showLoading(false); hideError();
            if (webFirstPending) { webFirstAdd(webFirstPending); webFirstPending = ''; }
            if (hlsFirstPending) { hlsFirstAdd(hlsFirstPending); hlsFirstPending = ''; }
        });
        videoEl.addEventListener('canplay', function () { showLoading(false); });
        // After a seek completes, re-pin the rate to the user's selected speed.
        // Some engines bump playbackRate to catch up to the live edge after a
        // backward seek, which makes playback race; this restores normal speed
        // without overriding an intentional Speed selection.
        videoEl.addEventListener('seeked', function () {
            try {
                var want = playbackSpeeds[currentSpeedIdx];
                if (lunaRateOk()) { if (currentSpeedIdx !== 2) lunaRate(want, 0, lunaGen); }
                else if (videoEl.playbackRate !== want) videoEl.playbackRate = want;
            } catch (e) {}
        });
        // webOS: the TV assigns the media id when the video loads, so a speed chosen earlier is re-sent then.
        videoEl.addEventListener('loadedmetadata', function () { if (lunaRateOk() && currentSpeedIdx !== 2) lunaRate(playbackSpeeds[currentSpeedIdx], 0, lunaGen); });
        videoEl.addEventListener('playing', function () { if (lunaRateOk() && currentSpeedIdx !== 2) lunaRate(playbackSpeeds[currentSpeedIdx], 0, lunaGen); });
        videoEl.addEventListener('error', function () {
            Util.logErr('Native video error', videoEl.error);
            try { if (window.XtivioDiag) window.XtivioDiag.log('NATIVE <video> ERROR: ' + (videoEl.error ? ('code-' + videoEl.error.code) : 'unknown')); } catch (eD) {}
            handleFatal({ details: videoEl.error ? ('code-' + videoEl.error.code) : 'native-error' });
        });

        // Pointer/click seeking on the seek track. Maps the clicked position to
        // a fraction of the track width and seeks there. seekTo() decides what's
        // seekable: VOD by duration, live by its DVR/seekable window (matching
        // the D-pad seek). On a non-seekable live stream it's a harmless no-op.
        var seekTrack = Util.$('#seekTrack');
        if (seekTrack) {
            seekTrack.addEventListener('click', function (ev) {
                if (!videoEl) return;
                var rect = seekTrack.getBoundingClientRect();
                if (!rect || !rect.width) return;
                var x = (ev.clientX != null ? ev.clientX : 0) - rect.left;
                var frac = x / rect.width;
                if (frac < 0) frac = 0;
                if (frac > 1) frac = 1;
                seekTo(frac);
                // Keep the overlay up briefly after an interaction.
                showOverlay();
            });
        }
    }

    function getPosition() {
        // No progress was saved and no
        // progress bar showed for Stalker (the earlier stale-URL fix was real but
        // not sufficient on its own). This function unconditionally read
        // videoEl.currentTime/duration, but on the exo and avplay engines
        // the hidden <video> element is just a shell for overlay positioning
        // — the actual playback happens natively, and its properties are
        // never kept in sync (same reason _exoPaused exists as a tracked
        // workaround for .paused, a few hundred lines up). Stalker VOD is
        // disproportionately MKV/HEVC, which routes through exo on Android —
        // so Player.getPosition() was returning {0, 0} for most Stalker VOD
        // sessions, exitPlayer()'s "currentTime > 10 && duration > 0" gate
        // then never passed, and Store.addVodHistory() was simply never
        // called at all. Xtream VOD is far more commonly plain H.264 MP4,
        // which stays on the native WebView path and never hit this —
        // exactly why only Stalker was broken, and why the
        // previous (correct, but incomplete) stale-URL fix wasn't enough by
        // itself. Mirrors the exact engine-branch pattern the seekbar UI
        // already uses a few hundred lines up (_exoPosMs/_exoDurMs pushed
        // from native via onTime; PlayerAVPlay.getTime()/getDuration()
        // pulled synchronously) rather than inventing a new one.
        if (activeEngine === 'exo' && window.PlayerExo) {
            return { currentTime: _exoPosMs / 1000, duration: _exoDurMs / 1000 };
        }
        if (activeEngine === 'avplay' && window.PlayerAVPlay) {
            var avCur = 0, avDur = 0;
            try { avCur = (PlayerAVPlay.getTime() || 0) / 1000; } catch (eAC) {}
            try { avDur = (PlayerAVPlay.getDuration() || 0) / 1000; } catch (eAD) {}
            return { currentTime: avCur, duration: avDur };
        }
        if (!videoEl) return { currentTime: 0, duration: 0 };
        return {
            currentTime: videoEl.currentTime || 0,
            duration: (videoEl.duration && isFinite(videoEl.duration)) ? videoEl.duration : 0
        };
    }

    function toggleSubtitles() {
        if (!videoEl) return;
        // Toggle text tracks visibility
        var tracks = videoEl.textTracks;
        if (!tracks || !tracks.length) {
            if (window.UI) UI.toast(T('no_subtitles_available'), null);
            return;
        }
        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') {
                tracks[i].mode = 'hidden';
                if (window.UI) UI.toast(T('subtitles_off'), null);
                return;
            }
        }
        // None showing — enable the first one
        tracks[0].mode = 'showing';
        if (window.UI) UI.toast(T('subtitles_2') + (tracks[0].label || tracks[0].language || T('pl_on')), 'ok')
    }

    /* Subtitle track management.
     *
     * setSubtitleTrack(blobUrl, label, lang)
     *   Add a new <track> to the video element and show it. Any prior
     *   tracks added by this function are removed first so there's
     *   only ever one subtitle visible at a time. Returns true on
     *   success, false if the video element isn't ready.
     *
     * clearSubtitles()
     *   Remove all tracks added by setSubtitleTrack. Also asks the Subs
     *   module to revoke its Blob URLs so we don't leak memory.
     *
     * getActiveSubtitleLanguage()
     *   Returns the language code of the currently-showing track, or
     *   null if no subtitles are active. Used by UI to highlight the
     *   "active" radio entry in the picker modal.
     *
     * The <track> elements get a data-subs-added attribute so we can
     * distinguish ones WE added from any that might be authored into
     * the HTML directly (none today, but defensive). */
    function setSubtitleTrack(blobUrl, label, lang, vttText) {
        if (!videoEl) return false;
        clearSubtitles();
        if (!vttText) return false;
        // Custom renderer: parse cues to plain objects and paint the active one in
        // our own overlay div on timeupdate. WebOS 6.5 will not render script-added
        // TextTracks (cues land with mode=showing but never paint), so we bypass the
        // engine's text-track renderer entirely. This is just DOM, so it always shows.
        subCues = parseVttPlain(vttText);
        if (!subCues || !subCues.length) { subCues = null; return false; }
        curSubLang = lang || null;
        subOffsetMs = 0;
        subActiveIdx = -1;
        // Trace cue enter/exit only when player debug is enabled (PLAYER_DEBUG
        // or APP_CONFIG.DEBUG). Previously this was forced true on every
        // subtitle activation, so verbose per-cue logging ran for the rest of
        // the session once the user opened subtitles once.
        window._subDiag = !!((typeof window !== 'undefined' && window.PLAYER_DEBUG) ||
                             (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG));
        if (window.console && console.log) {
            // Log the first several parsed cue windows so we can confirm the data
            // matches the file (e.g. cues 5 and 7) and compare against what renders.
            var sample = [];
            for (var si = 0; si < subCues.length && si < 8; si++) {
                sample.push((si + 1) + ':[' + subCues[si].start.toFixed(2) + '-' + subCues[si].end.toFixed(2) + ']');
            }
            Log.log('[subs] parsed ' + subCues.length + ' cues; first: ' + sample.join(' '));
        }
        if (!subOverlayEl) subOverlayEl = Util.$('#subOverlay');
        // Display the overlay (empty) now and keep it displayed; renderActiveCue
        // toggles only the text content, not display, to preserve the GPU layer.
        if (subOverlayEl) { clearChildren(subOverlayEl); subOverlayEl.style.display = 'block'; }
        attachSubTick();
        renderActiveCue(true);
        Log.log('[subs] custom renderer cues=' + subCues.length);
        return true;
    }

    function attachSubTick() {
        if (!videoEl) return;
        detachSubTick();
        subTickHandler = function () { renderActiveCue(false); };
        try {
            videoEl.addEventListener('timeupdate', subTickHandler, false);
            videoEl.addEventListener('seeked', subTickHandler, false);
        } catch (e) {}
        // timeupdate fires only ~4x/sec, which lags short cues in fast dialogue.
        // A light 100ms poll keeps cue changes snappy; it only reads currentTime
        // and updates the DOM when the active cue actually changes.
        if (subTickInterval) clearInterval(subTickInterval);
        subTickInterval = setInterval(function () { renderActiveCue(false); }, 100);
    }
    function detachSubTick() {
        if (videoEl && subTickHandler) {
            try {
                videoEl.removeEventListener('timeupdate', subTickHandler, false);
                videoEl.removeEventListener('seeked', subTickHandler, false);
            } catch (e) {}
        }
        subTickHandler = null;
        if (subTickInterval) { clearInterval(subTickInterval); subTickInterval = null; }
    }

    /* Playback time for the subtitle renderer, in seconds. On the exo and avplay
     * engines the hidden <video> element never advances (playback is native), so
     * its currentTime sat at 0 and the first cue stayed up for the whole video.
     * Same engine split getPosition() uses. Exo reports its position once a
     * second, so between reports it is advanced by the local clock (held while
     * paused or stalled, and capped in case reports stop) to keep cue changes
     * accurate; AVPlay's getTime() is read synchronously. */
    function subtitleNowSec() {
        if (activeEngine === 'exo' && window.PlayerExo) {
            var ms = _exoPosMs;
            if (!_exoPaused && !_exoBuffering && _exoPosAt) {
                var gap = Date.now() - _exoPosAt;
                if (gap > 0) ms += (gap > 1500 ? 1500 : gap);
            }
            return ms / 1000;
        }
        if (activeEngine === 'avplay' && window.PlayerAVPlay) {
            try { return (PlayerAVPlay.getTime() || 0) / 1000; } catch (eSt) { return 0; }
        }
        return (videoEl && videoEl.currentTime) || 0;
    }

    /* Show the cue active at the current playback time (plus the offset) in the
     * overlay div. Linear scan from a remembered index; cue lists are modest and
     * playback is monotonic so this is cheap. force=true re-renders even if the
     * active index hasn't changed (used after load/offset change). */
    function renderActiveCue(force) {
        if (!subCues || !subOverlayEl || !videoEl) return;
        var t = subtitleNowSec() - (subOffsetMs / 1000);
        var idx = -1;
        // Pick the last cue whose window contains t. Playback is monotonic, so
        // resume the scan from just before the last active cue rather than from
        // 0 every tick — a feature-length SRT can carry 2000+ cues and this runs
        // ~10x/sec on a weak SoC. Seeks reset subActiveIdx (via the seeked
        // listener), and starting one cue back absorbs brief non-monotonic
        // currentTime jitter on the device. If t sits before the resume point
        // (an unflagged backward jump), fall back to a full scan from 0.
        var startI = 0;
        if (subActiveIdx > 0) {
            startI = subActiveIdx - 1;
            if (subCues[startI] && subCues[startI].start > t) startI = 0;
        }
        for (var i = startI; i < subCues.length; i++) {
            if (t >= subCues[i].start && t <= subCues[i].end) idx = i;
            else if (subCues[i].start > t) break;
        }
        if (!force && idx === subActiveIdx) return;
        if (window._subDiag && window.console && console.log && idx !== subActiveIdx) {
            console.log('[subs] cue idx ' + subActiveIdx + '->' + idx + ' t=' + t.toFixed(2) +
                (idx >= 0 ? (' [' + subCues[idx].start.toFixed(2) + '-' + subCues[idx].end.toFixed(2) + '] ' + JSON.stringify((subCues[idx].text || '').slice(0, 24))) : ' (none)'));
        }
        subActiveIdx = idx;
        if (idx === -1) {
            // Clear the text but keep the element displayed. Toggling display:none
            // would destroy the overlay's GPU-composited layer; on WebOS 6.5 the
            // recreated layer may then fail to paint the next cue over the hardware
            // video. Emptying innerHTML leaves nothing visible while the layer
            // persists.
            if (subOverlayEl.firstChild) clearChildren(subOverlayEl);
            return;
        }
        // Render the cue text; split on newlines into stacked lines. Strip simple
        // VTT/HTML tags (<i>, <b>, <c.xxx>, etc.) to plain text for safety.
        //
        // Built with DOM nodes + textContent rather than innerHTML. The previous
        // version stripped tags then entity-escaped &<> before assigning innerHTML,
        // which was verified safe against the usual payloads — but it relied on two
        // string transforms staying correct and in the right order forever. Subtitle
        // text is untrusted third-party input (provider VTT/SRT), so the parsing is
        // now structural: textContent cannot execute markup no matter what arrives.
        var raw = subCues[idx].text || '';
        var clean = raw.replace(/<[^>]*>/g, '');
        var parts = clean.split('\n');
        var frag = document.createDocumentFragment();
        var wrote = 0;
        for (var p = 0; p < parts.length; p++) {
            var lineText = parts[p];
            if (!lineText.length) continue;
            if (wrote) frag.appendChild(document.createElement('br'));
            var lineEl = document.createElement('span');
            lineEl.className = 'sub-cue-line';
            lineEl.textContent = lineText;
            frag.appendChild(lineEl);
            wrote++;
        }
        if (!wrote) { if (subOverlayEl.firstChild) clearChildren(subOverlayEl); return; }
        clearChildren(subOverlayEl);
        subOverlayEl.appendChild(frag);
    }

    /* Remove all children without innerHTML (Chromium 53 safe, no reflow surprises). */
    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    /* Parse WEBVTT text into plain {start,end,text} objects (seconds). Used by the
     * custom DOM renderer. Tolerates SRT-style comma decimals and short MM:SS.mmm
     * timestamps; skips header/NOTE/cue identifiers. */
    function parseVttPlain(vtt) {
        var out = [];
        var body = String(vtt).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // Strip a leading WEBVTT header line (and any header metadata lines up to
        // the first blank line) so it can't swallow the first cue when the file
        // lacks a clean blank line after the header.
        if (body.substring(0, 6) === 'WEBVTT') {
            var nl = body.indexOf('\n\n');
            if (nl !== -1) body = body.substring(nl + 2);
            else {
                var firstNl = body.indexOf('\n');
                body = (firstNl !== -1) ? body.substring(firstNl + 1) : '';
            }
        }
        // Split into blocks on any run of one-or-more blank/whitespace-only lines.
        var blocks = body.split(/\n[ \t]*\n+/);
        for (var bi = 0; bi < blocks.length; bi++) {
            var block = blocks[bi];
            if (!block) continue;
            var blines = block.split('\n');
            // Skip stray header/NOTE blocks.
            if (blines[0].indexOf('WEBVTT') === 0) continue;
            if (blines[0].indexOf('NOTE') === 0) continue;
            // Find the timing line.
            var tIdx = -1;
            for (var li = 0; li < blines.length; li++) {
                if (blines[li].indexOf('-->') !== -1) { tIdx = li; break; }
            }
            if (tIdx === -1) continue;
            var m = blines[tIdx].split('-->');
            if (m.length < 2) continue;
            var start = parseVttTime(m[0]);
            var endRaw = m[1].replace(/^\s+/, '').split(/\s+/)[0];
            var end = parseVttTime(endRaw);
            if (start == null || end == null) continue;
            var text = blines.slice(tIdx + 1).join('\n').replace(/^\s+|\s+$/g, '');
            if (!text) continue;
            out.push({ start: start, end: end, text: text });
        }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }


    function parseVttTime(s) {
        s = String(s).replace(/^\s+|\s+$/g, '').replace(',', '.');
        var parts = s.split(':');
        var h = 0, mn = 0, sec = 0;
        if (parts.length === 3) { h = parseInt(parts[0], 10); mn = parseInt(parts[1], 10); sec = parseFloat(parts[2]); }
        else if (parts.length === 2) { mn = parseInt(parts[0], 10); sec = parseFloat(parts[1]); }
        else return null;
        if (isNaN(h) || isNaN(mn) || isNaN(sec)) return null;
        return h * 3600 + mn * 60 + sec;
    }

    function clearSubtitles() {
        removeAddedTracks();
        activeSubTrack = null;
        subOffsetMs = 0;
        subCueBase = null;
        // Tear down the custom DOM renderer.
        detachSubTick();
        subCues = null;
        subActiveIdx = -1;
        curSubLang = null;
        if (!subOverlayEl) subOverlayEl = Util.$('#subOverlay');
        if (subOverlayEl) { clearChildren(subOverlayEl); subOverlayEl.style.display = 'none'; }
        // Also hide any tracks the browser might have picked up
        // automatically (HLS in-band captions).
        if (videoEl && videoEl.textTracks) {
            for (var i = 0; i < videoEl.textTracks.length; i++) {
                videoEl.textTracks[i].mode = 'disabled';
            }
        }
        if (window.Subs && Subs.clearActive) {
            try { Subs.clearActive(); } catch (e) {}
        }
    }

    function removeAddedTracks() {
        if (!videoEl) return;
        var existing = videoEl.querySelectorAll('track[data-subs-added="1"]');
        for (var i = 0; i < existing.length; i++) {
            videoEl.removeChild(existing[i]);
        }
        // A programmatically-injected track (addTextTrack) has no DOM node and
        // can't be removed from textTracks — disable it and clear its cues so it
        // stops showing and doesn't linger behind a newly selected subtitle.
        if (progSubTrack && activeSubTrack) {
            try {
                activeSubTrack.mode = 'disabled';
                if (activeSubTrack.cues) {
                    // removeCue from the end to avoid index shifting.
                    for (var c = activeSubTrack.cues.length - 1; c >= 0; c--) {
                        try { activeSubTrack.removeCue(activeSubTrack.cues[c]); } catch (eR) {}
                    }
                }
            } catch (eD) {}
            progSubTrack = false;
        }
    }

    /* Apply an ABSOLUTE subtitle offset in milliseconds to the active track by
     * shifting each cue's start/end relative to its ORIGINAL time. We record each
     * cue's base time the first time we touch it (offsets are absolute, so calling
     * with 500 then 600 yields +0.6s, not +1.1s). Positive offset = text appears
     * later. Never pauses. NOTE (WebOS): mutating cue.startTime in place works on
     * most builds; if a device ignores it, the fallback is to rebuild the VTT with
     * shifted timestamps — to be verified on the 6.5 panel. */
    function setSubtitleOffset(ms) {
        subOffsetMs = ms || 0;
        // Custom renderer path: the offset is applied live in renderActiveCue
        // (it subtracts subOffsetMs from currentTime), so just re-render now.
        if (subCues) {
            subActiveIdx = -1; // force a recompute
            renderActiveCue(true);
            return true;
        }
        // Legacy native-track path (kept for engines that render script tracks).
        if (!activeSubTrack || !activeSubTrack.cues) return false;
        if (!subCueBase) subCueBase = [];
        var secs = subOffsetMs / 1000;
        var cues = activeSubTrack.cues;
        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            // Find/record base times. Linear array keyed by cue identity; cue lists
            // are modest so this is fine and avoids needing a real WeakMap.
            var base = null;
            for (var b = 0; b < subCueBase.length; b++) {
                if (subCueBase[b].cue === cue) { base = subCueBase[b]; break; }
            }
            if (!base) {
                base = { cue: cue, start: cue.startTime, end: cue.endTime };
                subCueBase.push(base);
            }
            var ns = base.start + secs;
            var ne = base.end + secs;
            if (ns < 0) ns = 0;
            if (ne < ns) ne = ns;
            try { cue.startTime = ns; cue.endTime = ne; } catch (e) {}
        }
        // Nudge the track mode so the renderer re-evaluates active cues at the new
        // times without needing a seek.
        try {
            var m = activeSubTrack.mode;
            activeSubTrack.mode = 'hidden';
            activeSubTrack.mode = (m === 'disabled') ? 'showing' : m;
        } catch (e) {}
        return true;
    }

    function getActiveSubtitleLanguage() {
        // Custom renderer: the active language is whatever we last loaded.
        if (subCues && curSubLang) return curSubLang;
        if (!videoEl || !videoEl.textTracks) return null;
        for (var i = 0; i < videoEl.textTracks.length; i++) {
            if (videoEl.textTracks[i].mode === 'showing') {
                return videoEl.textTracks[i].language || null;
            }
        }
        return null;
    }

    /* List EMBEDDED subtitle tracks — captions carried
     * inside the stream itself (HLS in-band CEA-608/708, or tracks the
     * manifest exposes). These are distinct from EXTERNAL subtitles
     * fetched from Wyzie. We exclude any <track> WE added (they carry
     * data-subs-added) so the picker doesn't double-count an external
     * track as embedded. Returns [{index, label, language}]. */
    function getEmbeddedSubtitleTracks() {
        var out = [];
        if (!videoEl || !videoEl.textTracks) return out;
        var addedTracks = videoEl.querySelectorAll('track[data-subs-added="1"]');
        // Build a set of TextTrack objects that belong to our added
        // <track> elements so we can skip them.
        var addedTT = [];
        for (var a = 0; a < addedTracks.length; a++) {
            if (addedTracks[a].track) addedTT.push(addedTracks[a].track);
        }
        for (var i = 0; i < videoEl.textTracks.length; i++) {
            var tt = videoEl.textTracks[i];
            // Only subtitle/caption kinds
            if (tt.kind && tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;
            var isOurs = false;
            for (var j = 0; j < addedTT.length; j++) { if (addedTT[j] === tt) { isOurs = true; break; } }
            if (isOurs) continue;
            out.push({
                index: i,
                label: tt.label || tt.language || (T('pl_track') + ' ' + (i + 1)),
                language: tt.language || ''
            });
        }
        return out;
    }

    /* Audio tracks looked like they worked but did not: built a genuine two-audio-track HLS asset (real
     * ffmpeg-muxed English/Spanish renditions, not simulated) and drove the
     * real player: the audio button always reported "no audio tracks", live,
     * movie and series alike, every time. Root cause: it read
     * videoEl.audioTracks directly, and that native AudioTrackList API does
     * not exist at all in this Chromium engine — confirmed separately (typeof
     * videoEl.audioTracks was 'undefined', not just an empty list) — while
     * hls.js's OWN track list (hls.audioTracks) correctly reported both real
     * tracks throughout. hls.js does not mirror alternate-audio renditions
     * into the native AudioTrackList; it manages them internally and expects
     * callers to use its own API.
     *
     * These two functions are the single place that knows which engine is
     * active and normalize BOTH shapes to the same {index,label,language} the
     * subtitle functions above already return, so app.js's audio-track picker
     * needs no engine-specific logic, same separation as subtitles.
     * Native videoEl.audioTracks is the fallback for native HLS on webOS and
     * plain progressive MP4/TS — nothing here has verified those populate it
     * either; if they don't, this degrades to the same "no audio tracks
     * available" toast as before, not a crash. Tizen (avplay engine) has its
     * own real branch via PlayerAVPlay.getAudioTracks()/setAudioTrack(), which
     * uses webapis.avplay's native track API instead of the browser's. exo
     * (Android MKV/AVI/HEVC) has its own real branch too, via
     * PlayerExo.getAudioTracks()/setAudioTrack() (ExoController.kt, Media3's
     * Tracks/TrackSelectionOverride API) — unlike the other two engines,
     * this one has NOT been compiled or run anywhere (no Android toolchain
     * available where it was written); see ExoController.kt's own risk note
     * on onTracksChanged for exactly what to check first if it doesn't work
     * as expected on a real device. */
    function getEmbeddedAudioTracks() {
        var out = [];
        if (activeEngine === 'hlsjs' && hls && hls.audioTracks) {
            var hTracks = hls.audioTracks;
            var activeIdx = hls.audioTrack;
            for (var h = 0; h < hTracks.length; h++) {
                var ht = hTracks[h];
                out.push({ index: h, label: ht.name || ht.lang || '', language: ht.lang || '', active: (h === activeIdx) });
            }
            return out;
        }
        if (activeEngine === 'avplay' && window.PlayerAVPlay && PlayerAVPlay.getAudioTracks) {
            return PlayerAVPlay.getAudioTracks();
        }
        if (activeEngine === 'exo' && window.PlayerExo && PlayerExo.getAudioTracks) {
            return PlayerExo.getAudioTracks();
        }
        if (!videoEl || !videoEl.audioTracks) return out;
        for (var i = 0; i < videoEl.audioTracks.length; i++) {
            var at = videoEl.audioTracks[i];
            out.push({ index: i, label: at.label || '', language: at.language || '', active: !!at.enabled });
        }
        return out;
    }

    function setAudioTrack(index) {
        if (activeEngine === 'hlsjs' && hls && hls.audioTracks) {
            hls.audioTrack = index;
            return true;
        }
        if (activeEngine === 'avplay' && window.PlayerAVPlay && PlayerAVPlay.setAudioTrack) {
            return PlayerAVPlay.setAudioTrack(index);
        }
        if (activeEngine === 'exo' && window.PlayerExo && PlayerExo.setAudioTrack) {
            return PlayerExo.setAudioTrack(index);
        }
        if (!videoEl || !videoEl.audioTracks) return false;
        for (var i = 0; i < videoEl.audioTracks.length; i++) videoEl.audioTracks[i].enabled = (i === index);
        return true;
    }

    /* Enable a specific embedded track by its index in
     * videoEl.textTracks, hiding all others. */
    function showEmbeddedTrack(index) {
        if (!videoEl || !videoEl.textTracks) return false;
        var found = false;
        for (var i = 0; i < videoEl.textTracks.length; i++) {
            if (i === index) { videoEl.textTracks[i].mode = 'showing'; found = true; }
            else videoEl.textTracks[i].mode = 'disabled';
        }
        return found;
    }

    var playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    var currentSpeedIdx = 2; // default 1x

    /* LG webOS mutes the sound whenever <video>.playbackRate is not 1, and ignores it on the MSE path. The same
     * speeds work with sound through the platform media service (luna com.webos.media setPlayRate), which is what
     * Stremio uses, so on webOS the rate is sent there and playbackRate is never touched (except as a last resort). */
    var lunaGen = 0; // bumped for every new video so late retries for an old one are dropped
    function lunaRateOk() {
        try { return !!(window.webOS || window.PalmSystem) && typeof window.PalmServiceBridge !== 'undefined' && activeEngine !== 'exo' && activeEngine !== 'avplay'; } catch (e) { return false; }
    }
    function lunaRate(value, attempt, gen) {
        if (gen !== lunaGen || !videoEl) return;
        var id = videoEl.mediaId;
        if (!id) {
            // The id appears once the video has loaded: retry for about 10 s.
            if (attempt < 20) setTimeout(function () { lunaRate(value, attempt + 1, gen); }, 500);
            return;
        }
        try {
            var b = new window.PalmServiceBridge();
            b.onservicecallback = function (m) {
                var ok = false;
                try { var r = JSON.parse(m); ok = (r.returnValue !== false && !r.errorCode); } catch (eP) {}
                if (!ok && gen === lunaGen && videoEl) {
                    // Service refused: fall back to the plain property (this TV may then mute at other speeds).
                    try { videoEl.playbackRate = value; } catch (eR) {}
                }
            };
            b.call('luna://com.webos.media/setPlayRate', JSON.stringify({ mediaId: id, playRate: value, audioOutput: true }));
        } catch (e) {
            try { videoEl.playbackRate = value; } catch (e2) {}
        }
    }

    /* Applies a speed on whichever engine is playing. Android plays through ExoPlayer and Tizen AVPlay through the
     * platform player, so setting <video>.playbackRate does nothing there. Returns false when the engine cannot. */
    function applySpeed(value) {
        if (activeEngine === 'exo' && window.PlayerExo) return PlayerExo.setSpeed ? PlayerExo.setSpeed(value) : false;
        if (activeEngine === 'avplay' && window.PlayerAVPlay) return PlayerAVPlay.setSpeed ? PlayerAVPlay.setSpeed(value) : false;
        if (!videoEl) return false;
        if (lunaRateOk()) { lunaRate(value, 0, lunaGen); return true; }
        try { videoEl.playbackRate = value; } catch (e) {}
        return true;
    }
    function speedValues() { return playbackSpeeds.slice(); }
    function currentSpeed() { return playbackSpeeds[currentSpeedIdx]; }

    function cycleSpeed() {
        if (!videoEl) return;
        var nextIdx = (currentSpeedIdx + 1) % playbackSpeeds.length;
        var speed = playbackSpeeds[nextIdx];
        if (!applySpeed(speed)) { if (window.UI) UI.toast(T('speed_unavailable'), 'err'); return; }
        currentSpeedIdx = nextIdx;
        var lbl = Util.$('#infoSpeedLbl');
        if (lbl) lbl.textContent = T('speed_2');
        if (window.UI) UI.toast(T('speed') + ' ' + speed + 'x', 'ok')
    }

    /* Set playback speed to an explicit value. Updates the canonical
     * currentSpeedIdx so the seek/seeked re-pin logic doesn't revert the user's
     * choice (the old bug: the picker set videoEl.playbackRate directly, leaving
     * currentSpeedIdx stale, so the next re-pin restored the old rate — the speed
     * "didn't take unless paused and replayed"). Some WebOS builds ignore a
     * playbackRate change applied while playing, so we re-apply once shortly
     * after to make it stick without a pause/play cycle. */
    function setSpeed(value) {
        if (!videoEl) return false;
        var idx = -1;
        for (var i = 0; i < playbackSpeeds.length; i++) {
            if (Math.abs(playbackSpeeds[i] - value) < 0.001) { idx = i; break; }
        }
        if (idx < 0) return false;
        if (!applySpeed(value)) { if (window.UI) UI.toast(T('speed_unavailable'), 'err'); return false; }
        currentSpeedIdx = idx;
        // Re-apply shortly after in case the engine dropped the change mid-play (HTML5 video only).
        if (activeEngine !== 'exo' && activeEngine !== 'avplay' && !lunaRateOk()) {
            setTimeout(function () {
                if (videoEl) { try { if (videoEl.playbackRate !== value) videoEl.playbackRate = value; } catch (e2) {} }
            }, 120);
        }
        return true;
    }

    function seekRelative(delta) {
        if (activeEngine === 'avplay' && window.PlayerAVPlay) {
            try {
                var curMs = PlayerAVPlay.getTime() || 0;
                if (!isFinite(curMs)) curMs = 0;
                var durMs = PlayerAVPlay.getDuration() || 0;
                var tMs = curMs + (delta * 1000);
                if (!isFinite(tMs) || tMs < 0) tMs = 0;
                if (durMs > 0 && tMs > durMs) tMs = durMs;
                PlayerAVPlay.seek(tMs);
                refreshOverlayContent();
            } catch (e) {}
            return;
        }
        if (activeEngine === 'exo' && window.PlayerExo) {
            // ExoPlayer owns its own clock/position natively; hand it a relative
            // seek in seconds and let the native side clamp to the media bounds.
            // _exoPosMs is updated here too: the native 1 s ticker only reports
            // while playing, so a seek made while PAUSED otherwise left the
            // elapsed time on the old value until play was pressed.
            try {
                PlayerExo.seekRelative(delta);
                var relTarget = _exoPosMs + Math.round(delta * 1000);
                if (relTarget < 0) relTarget = 0;
                if (_exoDurMs > 0 && relTarget > _exoDurMs) relTarget = _exoDurMs;
                _exoPosMs = relTarget;
                _exoPosAt = Date.now();
                refreshOverlayContent();
            } catch (e) {}
            return;
        }
        if (!videoEl) return;
        var t = videoEl.currentTime + delta;
        // Clamp to seekable range (works for both VOD and live buffer)
        if (videoEl.seekable && videoEl.seekable.length > 0) {
            var start = videoEl.seekable.start(0);
            var end = videoEl.seekable.end(videoEl.seekable.length - 1);
            if (t < start) t = start;
            if (t > end) t = end;
        } else {
            if (t < 0) t = 0;
            if (videoEl.duration && isFinite(videoEl.duration) && t > videoEl.duration) t = videoEl.duration;
        }
        videoEl.currentTime = t;
        refreshOverlayContent();
    }

    function seekTo(fraction) {
        if (activeEngine === 'exo' && window.PlayerExo) {
            try {
                if (fraction < 0) fraction = 0;
                if (fraction > 1) fraction = 1;
                if (_exoDurMs > 0) {
                    // This used to compute "targetMs - _exoPosMs" and
                    // send THAT as a relative seek, because PlayerExo only
                    // exposed a relative primitive. _exoPosMs only refreshes
                    // once a second (the native time ticker), so during active
                    // playback it could be stale by up to ~1s — the computed
                    // delta would then land up to a second off from where the
                    // user actually dragged to, and since this function
                    // doesn't get a fresh position back, the overlay kept
                    // showing the old (pre-seek) position until the next
                    // tick — looked exactly like "scrubbing doesn't work" on
                    // Stalker/Xtream VOD routed through exo (MKV/HEVC), even
                    // though the underlying ExoPlayer seek was fine. Now uses
                    // a real absolute seek (PlayerExo.seekTo), and optimistically
                    // updates _exoPosMs immediately so the seekbar reflects the
                    // new position right away instead of waiting up to 1s.
                    var targetMs = Math.round(fraction * _exoDurMs);
                    if (PlayerExo.seekTo) {
                        PlayerExo.seekTo(targetMs);
                    } else if (PlayerExo.seekRelative) {
                        // Fallback for an older native shell without exoSeekTo.
                        PlayerExo.seekRelative((targetMs - _exoPosMs) / 1000);
                    }
                    _exoPosMs = targetMs;
                    _exoPosAt = Date.now();
                    refreshOverlayContent();
                }
            } catch (e) {}
            return;
        }
        if (activeEngine === 'avplay' && window.PlayerAVPlay) {
            try {
                if (fraction < 0) fraction = 0;
                if (fraction > 1) fraction = 1;
                var durMs = PlayerAVPlay.getDuration() || 0;
                if (durMs > 0) { PlayerAVPlay.seek(Math.round(fraction * durMs)); refreshOverlayContent(); }
            } catch (e) {}
            return;
        }
        if (!videoEl) return;
        if (fraction < 0) fraction = 0;
        if (fraction > 1) fraction = 1;
        // Normalise playback rate on seek. After seeking back into a live buffer
        // the engine (or hls.js live-sync) can leave an elevated rate so playback
        // races to the live edge before settling — pin it to the user's selected
        // speed (1x unless they changed it) so a click-seek plays at normal speed.
        try { if (lunaRateOk()) { if (currentSpeedIdx !== 2) lunaRate(playbackSpeeds[currentSpeedIdx], 0, lunaGen); } else videoEl.playbackRate = playbackSpeeds[currentSpeedIdx]; } catch (e) {}
        // Prefer the seekable range so this works the same as the D-pad seek for
        // BOTH VOD and live: a live stream with a DVR window exposes a seekable
        // range, and the live seek bar already draws position across that window.
        // Map the clicked fraction across [seekable.start .. seekable.end].
        if (videoEl.seekable && videoEl.seekable.length > 0) {
            var start = videoEl.seekable.start(0);
            var end = videoEl.seekable.end(videoEl.seekable.length - 1);
            var span = end - start;
            if (span > 0) {
                videoEl.currentTime = start + fraction * span;
                refreshOverlayContent();
                return;
            }
        }
        // Fallback: finite-duration media without a seekable range.
        if (videoEl.duration && isFinite(videoEl.duration)) {
            videoEl.currentTime = fraction * videoEl.duration;
            refreshOverlayContent();
        }
    }

    function isVod() {
        if (!current) return false;
        if (current.type === 'vod' || current.type === 'series' || current.type === 'movies' || current.type === 'movie') return true;
        // Xtream catch-up programme: a finished recording (seek/pause), although its type stays 'xtream'.
        if (current.catchup) return true;
        // Stalker/MAG content carries type 'stalker'; its kind says vod/series/live.
        if (current.type === 'stalker' && (current.stalkerKind === 'vod' || current.stalkerKind === 'series')) return true;
        return false;
    }

    /* Used by the mobile "open in external player" button. Xtream/M3U channels
     * carry a stable URL — current.url is fine as-is. Stalker/MAG tokens are
     * short-lived, though, and current.url is only whatever was resolved when
     * playback STARTED — potentially long stale by the time someone taps
     * "open externally" mid-session. Mirrors play()'s own resolver selection
     * (live/vod/series) to fetch a fresh one instead of risking handing an
     * external app a dead link. cb(url) — url is null on failure. */
    function getExternalPlayableUrl(cb) {
        if (!current) { cb(null); return; }
        if (current.type !== 'stalker') { cb(current.url || null); return; }
        var spl = null;
        try {
            var pls = Store.getPlaylists ? Store.getPlaylists() : [];
            for (var pi = 0; pi < pls.length; pi++) {
                if (pls[pi].id === current.playlistId) { spl = pls[pi]; break; }
            }
        } catch (e) {}
        if (!spl) { cb(null); return; }
        var resolver = stalkerResolverFor(spl, current, false);
        resolver.then(function (res) {
            cb((res && res.url) || null);
        })['catch'](function () { cb(null); });
    }


    return {
        init: init,
        play: play,
        stop: stop,
        errorInfo: playbackErrorInfo,
        togglePause: togglePause,
        showOverlay: showOverlay,
        armOverlayHideTimer: armOverlayHideTimer,
        hideOverlay: hideOverlay,
        refreshOverlayContent: refreshOverlayContent,
        refreshResolution: refreshResolution,
        refreshClock: refreshClock,
        currentChannel: currentChannel,
        showBusy: function () { showLoading(true); },
        getPosition: getPosition,
        toggleSubtitles: toggleSubtitles,
        // Subtitle management used by the picker modal
        setSubtitleTrack: setSubtitleTrack,
        setSubtitleOffset: setSubtitleOffset,
        clearSubtitles: clearSubtitles,
        getActiveSubtitleLanguage: getActiveSubtitleLanguage,
        getEmbeddedSubtitleTracks: getEmbeddedSubtitleTracks,
        showEmbeddedTrack: showEmbeddedTrack,
        getEmbeddedAudioTracks: getEmbeddedAudioTracks,
        setAudioTrack: setAudioTrack,
        seekRelative: seekRelative,
        seekTo: seekTo,
        isVod: isVod,
        cycleSpeed: cycleSpeed,
        setSpeed: setSpeed,
        speedValues: speedValues,
        currentSpeed: currentSpeed,
        getExternalPlayableUrl: getExternalPlayableUrl,
        markExternalHandoff: markExternalHandoff,
        noteBackgrounded: noteBackgrounded,
        consumeExternalReturn: consumeExternalReturn,
        // Exposed so the mini player (live-top-mini.js) can tell whether the
        // native exo surface — not the DOM <video> it otherwise just
        // repositions — needs bounds-tracking instead.
        activeEngine: function () { return activeEngine; },
        onStateEvent: onStateEvent,
        offStateEvent: offStateEvent,
        // Exposed for the onboarding/Settings Touch-Remote-Mode override
        // (app.js) — that control exists specifically for generic Android
        // TV boxes that misreport their own touchscreen capability, a
        // problem that's structurally Android-only (AndroidBridge's
        // PackageManager check). Tizen/webOS have no such ambiguity — a
        // Tizen/webOS TV is never going to be misdetected as touch, so the
        // control has nothing to fix there and would just look like a
        // stray, out-of-place setting. Reusing this existing, already-
        // battle-tested detection rather than duplicating its logic.
        isAndroidWebView: isAndroidWebView
    };
})();
