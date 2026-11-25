/* player-exo.js — Android native ExoPlayer (Media3) backend.
 *
 * WHY THIS EXISTS
 * The Android WebView's <video> element and MSE (hls.js) cannot demux MKV and
 * cannot reliably decode HEVC / AC3 / EAC3 / DTS — exactly the formats common in
 * IPTV VOD and some live streams. Unlike the smart-TV webviews (Tizen/webOS)
 * there is no hardware <video> backdoor in Chromium-on-Android. So for those
 * containers/codecs we hand the URL to a NATIVE ExoPlayer surface that the shell
 * (MainActivity) renders behind the transparent WebView, and hand control back
 * on stop/error.
 *
 * This is the Android analogue of player-avplay.js. It mirrors that module's
 * public API so player.js can drive it with the same branch shape:
 *     PlayerExo.shouldHandle(channel)     -> route this content natively?
 *     PlayerExo.takesOverPlayback()       -> is the native player usable now?
 *     PlayerExo.play(url, opts, cb)       -> start native playback (returns bool)
 *     PlayerExo.stop() / pause() / resume() / seekRelative(sec)
 *
 * The bridge to native is window.AndroidBridge (added by MainActivity). When it
 * is absent (desktop, TV webviews, plain browser) isAvailable() is false and
 * player.js keeps its existing <video>/hls.js path unchanged. Every native call
 * is wrapped so a throw degrades to "not available" rather than breaking
 * playback.
 *
 * Native callbacks arrive via window.PlayerExo._onNative(evt, detailJson),
 * which MainActivity invokes through evaluateJavascript.
 *
 * ES5 only (no let/const/arrow/template-literals) to match the rest of the tree
 * and clear the es5-check gate.
 */
window.PlayerExo = (function () {
    'use strict';

    var TAG = '[exo]';
    function log() {
        try {
            if (window.Log && Log.log) {
                var a = ['[player]'].concat(Array.prototype.slice.call(arguments));
                Log.log.apply(Log, a);
            }
        } catch (e) {}
    }

    /* ---- availability ---------------------------------------------------- */

    function bridge() {
        try {
            if (window.AndroidBridge && typeof window.AndroidBridge.exoPlay === 'function') {
                return window.AndroidBridge;
            }
        } catch (e) {}
        return null;
    }

    function isAvailable() {
        return bridge() !== null;
    }

    /* Android shell (isAvailable() is false everywhere else): EVERY stream plays in
     * native ExoPlayer. The WebView <video> / hls.js path remains only as the
     * emergency fallback when Exo reports an error (player.js onError -> startStream
     * with the WebView forced). There is no per-format routing any more. */
    function shouldHandle(channel) {
        if (!isAvailable()) return false;
        return !!channel;
    }

    /* player.js calls this to confirm the backend is actually going to take over
     * (mirrors PlayerAVPlay.takesOverPlayback()). */
    function takesOverPlayback() {
        return isAvailable();
    }

    /* ---- native surface visibility --------------------------------------- */
    /* ExoPlayer renders to a native SurfaceView the shell places BEHIND the
     * WebView. For it to show through, the player stage + body must be made
     * transparent (same trick the AVPlay path uses). player.js already applies
     * this for the 'avplay' engine; we reuse the same data-attribute contract so
     * the overlays (loading, subtitles, info) keep painting above the video. */

    var activeCb = null;
    /* Updated whenever a native "audioTracks" event arrives (see _onNative
     * below); read synchronously by getAudioTracks(). Native pushes this
     * proactively rather than JS pulling it on demand, because a
     * JavascriptInterface call runs on a background thread and ExoPlayer
     * itself is only safe to touch from the UI thread — a synchronous
     * "ask and block for the answer" bridge call would risk deadlocking the
     * WebView's JS thread against the UI thread, so this reads a cache kept
     * fresh by push instead. */
    var lastAudioTracks = [];
    var lastVideoSize = null;

    function play(url, opts, cb) {
        var b = bridge();
        if (!b) { if (cb && cb.onError) cb.onError('exo-missing'); return false; }
        opts = opts || {};
        cb = cb || {};
        activeCb = cb;
        // Cleared immediately on every new play() attempt, belt-and-suspenders
        // alongside ExoController.kt's own trackSelectionParameters reset:
        // without this, the window between calling play() and the native
        // side's next "audioTracks" event could briefly show the PREVIOUS
        // stream's tracks to anything that asks in the meantime.
        lastAudioTracks = [];
        lastVideoSize = null;
        lastVideoFps = null;
        var startMs = 0;
        try { if (opts.startTimeMs && opts.startTimeMs > 0) startMs = Math.round(opts.startTimeMs); } catch (e) {}
        try {
            // Live TV and VOD use different native buffering profiles. Older shells
            // without exoPlayEx get the plain call (live profile, as before).
            var isLiveContent = (opts.live !== false);
            // Playback buffer setting (Android only; 0 = standard). Lite mode caps it at 45 s.
            try {
                if (typeof b.exoSetBufferReserve === 'function') {
                    var br = (window.Store && Store.getSettings) ? String((Store.getSettings() || {}).bufferReserve || 'off') : 'off';
                    var brSec = (br === 'off') ? 0 : (parseInt(br, 10) || 0);
                    if (brSec > 45 && window.PerfConfig && PerfConfig.isLite && PerfConfig.isLite()) brSec = 45;
                    b.exoSetBufferReserve(brSec);
                }
            } catch (eBr) {}
            // Match frame rate setting (Android only): 0 off, 1 seamless only (the default), 2 always.
            try {
                if (typeof b.exoSetFrameRateMatching === 'function') {
                    var afr = (window.Store && Store.getSettings) ? String((Store.getSettings() || {}).afr || 'seamless') : 'seamless';
                    b.exoSetFrameRateMatching(afr === 'off' ? 0 : (afr === 'always' ? 2 : 1));
                }
            } catch (eAfr) {}
            log(TAG, 'play startMs=' + startMs + ' live=' + isLiveContent);
            if (typeof b.exoPlayEx === 'function') {
                b.exoPlayEx(String(url), startMs, isLiveContent);
            } else {
                b.exoPlay(String(url), startMs);
            }
            return true;
        } catch (e) {
            log(TAG, 'play threw', e && e.message);
            activeCb = null;
            if (cb.onError) cb.onError('exo-throw');
            return false;
        }
    }

    function stop() {
        var b = bridge();
        activeCb = null;
        if (!b) return;
        try { b.exoStop(); } catch (e) {}
    }

    function pause() {
        var b = bridge();
        if (!b) return;
        try { b.exoPause(); } catch (e) {}
    }

    /* Playback speed for the native player. Returns false when this build has no native speed control. */
    function setSpeed(v) {
        var b = bridge();
        if (!b || typeof b.exoSetSpeed !== 'function') return false;
        try { b.exoSetSpeed(v); return true; } catch (e) { return false; }
    }

    function resume() {
        var b = bridge();
        if (!b) return;
        try { b.exoResume(); } catch (e) {}
    }

    /* Relative seek in seconds (negative = rewind). player.js maps the
     * left/right transport keys onto this when the native engine is active. */
    function seekRelative(sec) {
        var b = bridge();
        if (!b || typeof b.exoSeekRelative !== 'function') return;
        try { b.exoSeekRelative(Math.round(sec * 1000)); } catch (e) {}
    }

    /* Absolute seek in milliseconds — used for scrub-bar drag/click-to-seek,
     * where player.js knows exactly where it wants to land and shouldn't have
     * to fake it via a relative delta computed from a once-a-second-stale
     * position (see the matching comment in AndroidBridge.kt's exoSeekTo). */
    function seekTo(ms) {
        var b = bridge();
        if (!b || typeof b.exoSeekTo !== 'function') return;
        try { b.exoSeekTo(Math.max(0, Math.round(ms))); } catch (e) {}
    }

    /* Confine the native surface to a specific on-screen rect (device px) —
     * used by the live-TV mini player so exo playback isn't stuck fullscreen.
     * See AndroidBridge.exoSetBounds's doc for the full explanation. */
    function setBounds(leftPx, topPx, widthPx, heightPx) {
        var b = bridge();
        if (!b || typeof b.exoSetBounds !== 'function') return false;
        try {
            b.exoSetBounds(Math.round(leftPx), Math.round(topPx), Math.round(widthPx), Math.round(heightPx));
            return true;
        } catch (e) { return false; }
    }

    /* Video scaling for the native surface. App.applyVideoScale already works out
     * the on-screen rect for each scaling mode (it only ever styled the hidden
     * <video>, which is not what is shown on this engine). It hands that rect
     * here in CSS px of the 1920 canvas; the shell converts to device px and moves
     * the surface. Unlike setBounds this is the fullscreen player: the mini
     * player's backdrop machinery is not involved. A no-op on shells without the
     * method. */
    function setVideoRect(leftPx, topPx, widthPx, heightPx) {
        var b = bridge();
        if (!b || typeof b.exoSetVideoRect !== 'function') return false;
        try {
            b.exoSetVideoRect(Math.round(leftPx), Math.round(topPx), Math.round(widthPx), Math.round(heightPx));
            return true;
        } catch (e) { return false; }
    }

    /* Picture size of the current stream as {w,h} (square-pixel width/height), or
     * null until native reports it. Pushed by the native "videosize" event. */
    function getVideoSize() { return lastVideoSize; }
    /* Frame rate native reported (declared by the stream, or measured), or null. Pushed by the "videofps" event. */
    var lastVideoFps = null;
    function getVideoFps() { return lastVideoFps; }

    function clearBounds() {
        var b = bridge();
        if (!b || typeof b.exoClearBounds !== 'function') return;
        try { b.exoClearBounds(); } catch (e) {}
    }

    /* MKV/AVI/HEVC — content
     * ExoController plays natively behind the WebView, which the <video>
     * element never sees at all — previously had no audio-track picker
     * support. Mirrors PlayerAVPlay's getAudioTracks()/setAudioTrack() shape
     * exactly (same {index,label,language,active} fields player.js already
     * expects from every engine) so player.js needs no engine-specific
     * logic beyond knowing which one to call. Reads the CACHE (see
     * lastAudioTracks above) rather than asking natively and waiting — the
     * cache is kept fresh by native pushing "audioTracks" events, not by
     * this function pulling them. */
    function getAudioTracks() {
        return lastAudioTracks.map(function (t) {
            return { index: t.index, label: t.label || '', language: t.language || '', active: !!t.selected };
        });
    }
    function setAudioTrack(index) {
        var b = bridge();
        if (!b || typeof b.exoSetAudioTrack !== 'function') return false;
        try { b.exoSetAudioTrack(index); return true; } catch (e) { return false; }
    }

    /* Native -> web callback sink. MainActivity calls:
     *   PlayerExo._onNative('ready'|'buffering'|'time'|'ended'|'error', detail)
     * where detail is a JSON string (may be empty). */
    function _onNative(evt, detail) {
        try {
            if (window.XtivioDiag) {
                // Scrub the detail before logging — native error details can echo
                // the stream URL (with mac=/token=). Never log raw.
                var safe = detail || '';
                try { if (window.Crypto && Crypto.scrubUrl) safe = Crypto.scrubUrl(String(safe)); } catch (eSc) {}
                window.XtivioDiag.log('EXO native: ' + evt + ' ' + safe);
            }
        } catch (eD) {}
        var d = null;
        try { d = detail ? JSON.parse(detail) : null; } catch (e) { d = detail || null; }
        // Updates the cache unconditionally — this is state, not a callback-
        // routed playback event, so it must land even if activeCb is null
        // (e.g. arriving just after stop() cleared it) or wasn't asking.
        if (evt === 'audioTracks') {
            lastAudioTracks = Array.isArray(d) ? d : [];
            // The button that depends on this is gated on the overlay's OWN
            // periodic refresh, which is VOD-only (seekRefreshTimer) or tied
            // to onTime ticks that may not fire while paused — this event can
            // genuinely arrive after either has already run once, so it must
            // trigger a refresh itself rather than assume one is coming.
            if (activeCb && activeCb.onAudioTracksChanged) activeCb.onAudioTracksChanged();
            return;
        }
        // Picture size (for video scaling): state, like audioTracks, so it lands
        // even without an active callback. Re-applies the saved scaling because
        // the rect depends on the aspect ratio, which is unknown until now.
        if (evt === 'videofps') {
            lastVideoFps = (d && d.fps > 0) ? d.fps : null;
            try { if (window.Player && Player.refreshResolution) Player.refreshResolution(); } catch (eFr) {}
            return;
        }
        if (evt === 'videosize') {
            if (d && d.width > 0 && d.height > 0) lastVideoSize = { w: d.width, h: d.height };
            else lastVideoSize = null;
            try { if (window.Player && Player.refreshResolution) Player.refreshResolution(); } catch (eRs) {}
            try {
                if (window.App && App.applyVideoScale) {
                    var stVs = (window.Store && Store.getSettings) ? Store.getSettings() : null;
                    App.applyVideoScale((stVs && stVs.videoScale) || 'contain');
                }
            } catch (eVs) {}
            return;
        }
        if (!activeCb) return;
        try {
            if (evt === 'ready' && activeCb.onReady) activeCb.onReady(d);
            else if (evt === 'buffering' && activeCb.onBuffering) activeCb.onBuffering(!!(d && d.buffering));
            else if (evt === 'playstate' && activeCb.onPlayState) activeCb.onPlayState(!!(d && d.paused));
            else if (evt === 'time' && activeCb.onTime) activeCb.onTime((d && d.positionMs) || 0, (d && d.durationMs) || 0, (d && d.bufferedAheadMs) || 0);
            else if (evt === 'ended' && activeCb.onEnded) activeCb.onEnded();
            else if (evt === 'error' && activeCb.onError) activeCb.onError((d && d.detail) || 'exo-error');
        } catch (e) {
            log(TAG, '_onNative handler threw', e && e.message);
        }
    }

    return {
        isAvailable: isAvailable,
        shouldHandle: shouldHandle,
        takesOverPlayback: takesOverPlayback,
        play: play,
        stop: stop,
        pause: pause,
        setSpeed: setSpeed,
        resume: resume,
        seekRelative: seekRelative,
        seekTo: seekTo,
        setBounds: setBounds,
        clearBounds: clearBounds,
        setVideoRect: setVideoRect,
        getVideoSize: getVideoSize,
        getVideoFps: getVideoFps,
        getAudioTracks: getAudioTracks,
        setAudioTrack: setAudioTrack,
        _onNative: _onNative
    };
})();
