/* player-avplay.js — platform hardware-player backend.
 *
 * WHY THIS EXISTS
 * The browser <video> element and MSE on TV webviews (Chromium) cannot demux
 * MKV, and on several sets cannot decode HEVC/AC3 fed through MSE (proven on
 * device: canPlayType('video/x-matroska')='' and MSE/native <video> both reject
 * a remuxed HEVC fMP4 with MediaError 4). But the SAME sets play HEVC live TV
 * fine — because that goes through the platform's hardware media pipeline, not
 * the browser decoder. This module hands playback to that pipeline:
 *   - Tizen (Samsung): webapis.avplay
 *   - webOS (LG):     the platform media pipeline (luna / native <video> HW path)
 *
 * These APIs only exist inside a PACKAGED app on real hardware. In a desktop
 * browser, a test page, or the TV's own web browser they are absent, so
 * isAvailable() returns false and player.js keeps using its existing
 * <video>/hls.js path. Nothing here changes behaviour where the APIs are
 * missing. Every platform call is wrapped — a throw degrades to "not available"
 * rather than breaking playback.
 *
 * ES5 only (old Chromium). No template literals, no let/const, no arrow fns.
 */
window.PlayerAVPlay = (function () {
    'use strict';

    var TAG = '[avplay]';
    function log() {
        try {
            if (window.Log && Log.log) {
                var a = ['[player]'].concat(Array.prototype.slice.call(arguments));
                Log.log.apply(Log, a);
            }
        } catch (e) {}
    }

    /* ---- platform detection ---------------------------------------------- */

    function tizenAvplay() {
        /* webapis.avplay is injected into the webview of a packaged Tizen app. */
        try {
            if (typeof window.webapis !== 'undefined' &&
                window.webapis && window.webapis.avplay &&
                typeof window.webapis.avplay.open === 'function') {
                return window.webapis.avplay;
            }
        } catch (e) {}
        return null;
    }

    /* webOS: detection is softer. The reliable signal that we're in a packaged
     * webOS app (not the TV browser) is window.webOS / window.PalmSystem, plus
     * a webOS user-agent. webOS doesn't expose an AVPlay-style object; instead
     * its <video> element, when driven inside the packaged app with the right
     * attributes, routes to the hardware pipeline and can open containers the
     * browser build rejects. We treat webOS as "native-hw" and let player.js
     * drive a <video> element that we tag for the HW path. */
    function isWebOsPackaged() {
        try {
            var ua = (navigator.userAgent || '').toLowerCase();
            var uaHit = ua.indexOf('webos') >= 0 || ua.indexOf('web0s') >= 0;
            var objHit = !!(window.webOS || window.PalmSystem || window.webOSSystem);
            /* Require BOTH a webOS UA and the injected object: the object alone
             * can be shimmed, and the UA alone appears in the plain TV browser
             * where we do NOT get the packaged HW path. */
            return uaHit && objHit;
        } catch (e) { return false; }
    }

    /* Which backend, if any, is usable right now. */
    function backend() {
        if (tizenAvplay()) return 'tizen';
        if (isWebOsPackaged()) return 'webos';
        return null;
    }

    function isAvailable() {
        return backend() !== null;
    }

    /* Should this specific content be routed through the platform player rather
     * than the browser? The platform player is the ONLY way to play MKV and is
     * the safe choice for HEVC/AC3, but for plain MP4/H.264 and HLS the existing
     * browser path already works and is better integrated (subtitles, seeking
     * UI), so we only claim content the browser path struggles with. */
    function shouldHandle(channel) {
        if (!isAvailable()) return false;
        if (!channel) return false;
        var url = String(channel.url || '').toLowerCase();
        var ext = String(channel.containerExtension || channel.container_extension || '').toLowerCase();
        /* Explicit container signal from Xtream VOD info wins. */
        if (ext) {
            if (ext.indexOf('mkv') >= 0) return true;
            if (ext.indexOf('avi') >= 0 || ext.indexOf('ts') >= 0) return true;
            return false; /* mp4 / m3u8 etc: let the browser path handle it */
        }
        /* Otherwise sniff the URL. */
        if (/\.mkv(\?|$)/.test(url)) return true;
        if (/\.avi(\?|$)/.test(url)) return true;
        return false;
    }

    /* ---- Tizen AVPlay lifecycle ------------------------------------------ */
    /* AVPlay drives its OWN rendering surface (an <object> element), not the
     * <video> element. The caller passes the id/element of that surface. */

    var tzState = { open: false, surface: null };
    // Audio track the user picked for the current stream (AVPlay's own track index),
    // or null = nothing picked yet. Reset for every new stream.
    var tzAudioSel = null;

    /* Tizen AVPlay renders video into a platform <object>, not the <video>
     * element. Create it once, sized/positioned over the player stage, and
     * return it. Without this the audio decodes but video has no surface -> the
     * "audio but no picture" symptom. */
    function tizenEnsureSurface() {
        if (tzState.surface && tzState.surface.parentNode) return tzState.surface;
        try {
            var stage = document.querySelector('.player-stage') || document.body;
            var obj = document.getElementById('avplayObject');
            if (!obj) {
                obj = document.createElement('object');
                obj.id = 'avplayObject';
                obj.type = 'application/avplayer';
                /* Sit behind the overlays (loading/subtitles) but over the page
                 * background; the actual video is a HW plane the object marks. */
                obj.style.position = 'absolute';
                obj.style.left = '0';
                obj.style.top = '0';
                obj.style.width = '100%';
                obj.style.height = '100%';
                obj.style.zIndex = '0';
                /* Insert as the first child of the stage so overlays paint above. */
                if (stage.firstChild) stage.insertBefore(obj, stage.firstChild);
                else stage.appendChild(obj);
            }
            tzState.surface = obj;
            log(TAG, 'surface ready', obj.offsetWidth + 'x' + obj.offsetHeight);
            return obj;
        } catch (e) {
            log(TAG, 'surface create failed', e && e.message);
            return null;
        }
    }

    function tizenSurfaceRect() {
        try {
            var el = tzState.surface || document.querySelector('.player-stage');
            if (el && el.getBoundingClientRect) {
                var r = el.getBoundingClientRect();
                return { x: Math.round(r.left), y: Math.round(r.top),
                         w: Math.round(r.width) || 1920, h: Math.round(r.height) || 1080 };
            }
        } catch (e) {}
        return { x: 0, y: 0, w: 1920, h: 1080 };
    }

    function tizenPlay(url, opts, cb) {
        var av = tizenAvplay();
        if (!av) { if (cb && cb.onError) cb.onError('avplay-missing'); return; }
        opts = opts || {};
        cb = cb || {};
        try { tizenStop(); } catch (e) {}
        tzAudioSel = null;
        try {
            tizenEnsureSurface();
            log(TAG, 'open', 'url-len=' + String(url).length);
            av.open(url);
            tzState.open = true;

            var r = opts.rect || tizenSurfaceRect();
            try { av.setDisplayRect(r.x, r.y, r.w, r.h); log(TAG, 'setDisplayRect', r.x + ',' + r.y + ',' + r.w + ',' + r.h); } catch (e1) { log(TAG, 'setDisplayRect failed', e1 && e1.message); }

            av.setListener({
                onbufferingstart: function () { log(TAG, 'onbufferingstart'); if (cb.onBuffering) cb.onBuffering(true); },
                onbufferingprogress: function (p) { log(TAG, 'onbufferingprogress', p); },
                onbufferingcomplete: function () { log(TAG, 'onbufferingcomplete'); if (cb.onBuffering) cb.onBuffering(false); if (cb.onReady) cb.onReady(); },
                onstreamcompleted: function () { log(TAG, 'onstreamcompleted'); if (cb.onEnded) cb.onEnded(); tizenStop(); },
                oncurrentplaytime: function (ms) { if (cb.onTime) cb.onTime(ms); },
                onerror: function (e) { log(TAG, 'onerror', e); if (cb.onError) cb.onError('avplay-error:' + e); },
                onevent: function (t, d) { log(TAG, 'onevent', t, d); },
                onsubtitlechange: function () {},
                ondrmevent: function () {}
            });

            var afterPrepare = function () {
                log(TAG, 'prepared; setting display + play');
                try {
                    /* Re-assert display rect after prepare (some firmwares reset it). */
                    var rr = opts.rect || tizenSurfaceRect();
                    /* Method first, then rect (see tizenSetScale). */
                    try { if (av.setDisplayMethod) av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (eDM) {}
                    try { av.setDisplayRect(rr.x, rr.y, rr.w, rr.h); } catch (eR) {}
                    if (opts.startTimeMs && av.seekTo) { try { av.seekTo(opts.startTimeMs); } catch (eSk) {} }
                    av.play();
                    log(TAG, 'play() called; state=' + (av.getState ? av.getState() : '?'));
                    if (cb.onReady) cb.onReady();
                } catch (ep) { log(TAG, 'play failed', ep && ep.message); if (cb.onError) cb.onError('avplay-play:' + ep.message); }
            };
            if (av.prepareAsync) {
                log(TAG, 'prepareAsync');
                av.prepareAsync(afterPrepare, function (e) { log(TAG, 'prepareAsync error', e); if (cb.onError) cb.onError('avplay-prepare:' + e); });
            } else {
                log(TAG, 'prepare (sync)');
                av.prepare();
                afterPrepare();
            }
        } catch (e) {
            log(TAG, 'open/setup threw', e && e.message);
            if (cb.onError) cb.onError('avplay-open:' + (e && e.message));
            tizenStop();
        }
    }

    /* Fullscreen video scaling (Settings > Video Scaling) for the AVPlay plane.
     * App.applyVideoScale works out the picture rect for each mode but only ever
     * styled the hidden <video>, so the setting did nothing for MKV/AVI here.
     * contain and cover use AVPlay's own display modes over the whole stage (no
     * need to know the picture size): letter box and cropped full. The other
     * modes (fill-v, fill-h, four-three) are exact rects, so the plane is
     * stretched into that rect (full screen method). rect is in CSS px of the 1920
     * canvas, the same space as tizenSurfaceRect. Some firmwares may refuse a rect
     * that runs off screen (fill modes); that falls back to the rect clamped to the
     * stage. Not verified against a real Tizen device. */
    var tzScaleSeq = 0;
    var tzNoOffscreen = false; // this firmware refused a rect that runs off the screen
    var tzNoCrop = false;      // this firmware rejected PLAYER_DISPLAY_MODE_CROPPED_FULL (remembered for the session)
    function tizenSetScale(mode, x, y, w, h) {
        var av = tizenAvplay();
        if (!av || !tzState.open || !av.setDisplayRect) return false;
        var stage = tizenSurfaceRect();
        var method = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
        var r = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        if (mode === 'contain' || mode === 'cover' || !(r.w > 0 && r.h > 0)) {
            method = (mode === 'cover' && !tzNoCrop) ? 'PLAYER_DISPLAY_MODE_CROPPED_FULL' : 'PLAYER_DISPLAY_MODE_LETTER_BOX';
            r = stage;
        }
        /* Device log (Samsung, Tizen 8, 31 Oct): a rect that runs off the screen (the zoom modes
         * Fill vertically / Fill horizontally use one) is refused with INVALID_PARAMETER, and
         * CROPPED_FULL is refused too. A refusal is remembered for the session: after the first
         * one an off-screen rect is clamped to the screen up front (no failing call), and a refused
         * CROPPED_FULL falls back to letter box. Firmwares that accept them still get the real rect.
         * A rect inside the screen, for example the 4:3 one, is honoured. */
        var cx = Math.max(stage.x, r.x), cy = Math.max(stage.y, r.y);
        var cr = Math.min(stage.x + stage.w, r.x + r.w), cb = Math.min(stage.y + stage.h, r.y + r.h);
        var offscreen = (cx !== r.x || cy !== r.y || cr !== r.x + r.w || cb !== r.y + r.h);
        var clamped = { x: cx, y: cy, w: Math.max(1, cr - cx), h: Math.max(1, cb - cy) };
        if (offscreen && tzNoOffscreen) r = clamped;
        /* Display method first, then the rect, and the rect again 150 ms later. */
        var applied = method;
        try { if (av.setDisplayMethod) av.setDisplayMethod(method); }
        catch (e3) {
            log(TAG, 'setDisplayMethod failed', method, e3 && e3.message);
            if (method === 'PLAYER_DISPLAY_MODE_CROPPED_FULL') {
                tzNoCrop = true;
                applied = 'PLAYER_DISPLAY_MODE_LETTER_BOX';
                try { av.setDisplayMethod(applied); } catch (e5) {}
            }
        }
        try {
            av.setDisplayRect(r.x, r.y, r.w, r.h);
        } catch (e1) {
            log(TAG, 'setDisplayRect refused', r.x + ',' + r.y + ',' + r.w + ',' + r.h, e1 && e1.message);
            if (!offscreen || r === clamped) return false;
            tzNoOffscreen = true;
            r = clamped;
            try { av.setDisplayRect(r.x, r.y, r.w, r.h); } catch (e2) { return false; }
        }
        var seq = ++tzScaleSeq;
        setTimeout(function () {
            if (seq !== tzScaleSeq || !tzState.open) return;
            try { av.setDisplayRect(r.x, r.y, r.w, r.h); } catch (e4) {}
        }, 150);
        log(TAG, 'scale', mode, applied, r.x + ',' + r.y + ',' + r.w + ',' + r.h);
        return true;
    }

    function tizenStop() {
        var av = tizenAvplay();
        if (av) {
            try { if (av.stop) av.stop(); } catch (e) {}
            try { if (av.close) av.close(); } catch (e2) {}
        }
        tzState.open = false;
        /* Remove the display object so it doesn't cover the UI between plays. */
        try {
            if (tzState.surface && tzState.surface.parentNode) {
                tzState.surface.parentNode.removeChild(tzState.surface);
            }
        } catch (e3) {}
        tzState.surface = null;
    }

    function tizenPause() { var av = tizenAvplay(); try { if (av && av.pause) av.pause(); } catch (e) {} }
    function tizenResume() { var av = tizenAvplay(); try { if (av && av.play) av.play(); } catch (e) {} }
    function tizenSeek(ms) {
        var av = tizenAvplay();
        if (!av || !av.seekTo) return;
        var v = Number(ms);
        if (!isFinite(v) || v < 0) { log(TAG, 'seek skipped (bad ms)', ms); return; }
        try { av.seekTo(Math.round(v)); } catch (e) { log(TAG, 'seek threw', e && e.message); }
    }
    function tizenGetTime() { var av = tizenAvplay(); try { var t = av && av.getCurrentTime ? Number(av.getCurrentTime()) : 0; return isFinite(t) ? t : 0; } catch (e) { return 0; } }
    function tizenGetDuration() { var av = tizenAvplay(); try { var d = av && av.getDuration ? Number(av.getDuration()) : 0; return isFinite(d) ? d : 0; } catch (e) { return 0; } }

    /* Audio track enumeration/switching (Tizen only).
     * getTotalTrackInfo() returns every track (AUDIO/VIDEO/TEXT); extra_info is
     * itself a JSON STRING (a documented AVPlay quirk, not a typo here) holding
     * per-track fields like language — needs its own JSON.parse. Every field
     * access is defensive since this has not been run against a real Tizen
     * device/emulator (none available to test against); a malformed or
     * unexpected extra_info shape degrades to an empty label, never a throw.
     * setSelectTrack's index must be the SAME index getTotalTrackInfo reported
     * for that track (not a 0-based position within just the audio subset). */
    function tizenGetAudioTracks() {
        var av = tizenAvplay();
        var out = [];
        if (!av || !av.getTotalTrackInfo) return out;
        try {
            var all = av.getTotalTrackInfo() || [];
            // Which audio track is playing: the one the user picked, else what AVPlay
            // reports as current (getCurrentStreamInfo), else the first audio track.
            var activeIdx = tzAudioSel;
            if (activeIdx === null && av.getCurrentStreamInfo) {
                try {
                    var cur = av.getCurrentStreamInfo() || [];
                    for (var c = 0; c < cur.length; c++) {
                        if (cur[c] && cur[c].type === 'AUDIO') { activeIdx = cur[c].index; break; }
                    }
                } catch (eCur) {}
            }
            var firstAudio = null;
            for (var i = 0; i < all.length; i++) {
                var t = all[i];
                if (!t || t.type !== 'AUDIO') continue;
                var lang = '';
                try {
                    var extra = t.extra_info ? JSON.parse(t.extra_info) : null;
                    lang = (extra && extra.language) || '';
                } catch (eParse) {}
                if (firstAudio === null) firstAudio = t.index;
                out.push({ index: t.index, label: '', language: lang, active: false });
            }
            if (activeIdx === null) activeIdx = firstAudio;
            for (var o = 0; o < out.length; o++) out[o].active = (out[o].index === activeIdx);
        } catch (e) { log(TAG, 'getTotalTrackInfo failed', e && e.message); }
        return out;
    }
    function tizenSetAudioTrack(index) {
        var av = tizenAvplay();
        if (!av || !av.setSelectTrack) return false;
        try { av.setSelectTrack('AUDIO', index); tzAudioSel = index; return true; } catch (e) { log(TAG, 'setSelectTrack failed', e && e.message); return false; }
    }

    /* ---- webOS path ------------------------------------------------------ */
    /* webOS doesn't need a separate API object for the common case: inside the
     * packaged app, a <video> element with the proper source type routes to the
     * HW pipeline. player.js already owns the <video> element and its
     * play()-punch-through, so for webOS we don't take over playback here — we
     * only report that the platform CAN handle it and let player.js use its
     * native <video> path with an extra hint (the media type). The dedicated
     * webOS media-pipeline hooks (mediaOption / luna) can be layered in later if
     * a set needs more than the tagged <video> path. */
    function webosHint(channel) {
        /* Returns a MIME/type hint player.js can set on the <video> source so
         * webOS routes MKV to the HW demuxer. Empty string if none. */
        var url = String(channel && channel.url || '').toLowerCase();
        var ext = String(channel && (channel.containerExtension || channel.container_extension) || '').toLowerCase();
        if (ext.indexOf('mkv') >= 0 || /\.mkv(\?|$)/.test(url)) return 'video/mp4'; /* webOS opens MKV under a generic type */
        return '';
    }

    /* webOS media-pipeline source setup.
     *
     * On webOS, containers the Chromium build won't open (MKV) can still play if
     * we hand the <video> element a <source> whose "type" carries a base64
     * "mediaOption". webOS parses that and routes to the HW demuxer/decoder.
     * Reference shape:
     *   <source src="URL" type="video/mp4;mediaOption=BASE64(JSON)">
     * where JSON = { mediaTransportType:"URI", option:{ adaptiveStreaming:{...},
     *                mediaFormat:{ type:"MKV" } } }
     *
     * Returns true if it attached a webOS source (caller then calls load()),
     * false if not applicable (caller uses the plain videoEl.src path). */
    function webosApplySource(videoEl, url, opts) {
        if (backend() !== 'webos') return false;
        if (!videoEl) return false;
        opts = opts || {};
        try {
            var fmt = opts.mediaFormat || 'MKV';
            var mediaOption = {
                mediaTransportType: 'URI',
                option: {
                    mediaFormat: { type: fmt },
                    /* Let webOS pick decoders; hint HW where possible. */
                    adaptiveStreaming: { maxWidth: 3840, maxHeight: 2160 }
                }
            };
            var json = JSON.stringify(mediaOption);
            var b64;
            try { b64 = window.btoa(json); }
            catch (eB) { b64 = _b64(json); }
            var typeStr = 'video/mp4;mediaOption=' + b64;

            /* Clear any existing sources/src. */
            try { videoEl.removeAttribute('src'); } catch (e1) {}
            while (videoEl.firstChild) { try { videoEl.removeChild(videoEl.firstChild); } catch (e2) { break; } }

            var srcEl = document.createElement('source');
            srcEl.setAttribute('src', url);
            srcEl.setAttribute('type', typeStr);
            videoEl.appendChild(srcEl);
            log(TAG, 'webos source attached', 'fmt=' + fmt, 'typeLen=' + typeStr.length);
            return true;
        } catch (e) {
            log(TAG, 'webos source setup failed', e && e.message);
            return false;
        }
    }

    /* Minimal base64 for environments where btoa is unavailable (rare). */
    function _b64(s) {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var out = '', i = 0;
        while (i < s.length) {
            var c1 = s.charCodeAt(i++), c2 = s.charCodeAt(i++), c3 = s.charCodeAt(i++);
            var e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4);
            var e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | (c3 >> 6));
            var e4 = isNaN(c3) ? 64 : (c3 & 63);
            out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + chars.charAt(e4);
        }
        return out;
    }

    /* On webOS, audio kept playing after backing out of
     * the player, with no way to stop it short of closing the whole app.
     * webosApplySource() attaches the URL via a CHILD <source> element (the
     * only way to pass the mediaOption MIME hint webOS's native pipeline
     * needs — see its own comment), never via the videoEl.src attribute.
     * player.js's general stop() only ever did videoEl.removeAttribute('src')
     * — a no-op here, since the URL was never in that attribute for webOS
     * content — followed by videoEl.load(), which per the HTML5 spec
     * RE-EVALUATES any <source> children when there's no src attribute set,
     * meaning that call was actively re-feeding the still-attached source
     * back to webOS's native decoder instead of releasing it. This removes
     * the <source> child the same way webosApplySource's own "clear any
     * existing source" step already does, exposed standalone so stop() can
     * call it before load() ever runs. Safe to call on any backend/at any
     * time — a no-op off webOS, and a no-op if nothing was ever attached. */
    function webosClearSource(videoEl) {
        if (backend() !== 'webos' || !videoEl) return false;
        try {
            videoEl.removeAttribute('src');
            while (videoEl.firstChild) { try { videoEl.removeChild(videoEl.firstChild); } catch (e2) { break; } }
            return true;
        } catch (e) { return false; }
    }

    /* Does THIS content need the webOS mediaOption source (vs plain src)? */
    function webosShouldApply(channel) {
        if (backend() !== 'webos') return false;
        var url = String(channel && channel.url || '').toLowerCase();
        var ext = String(channel && (channel.containerExtension || channel.container_extension) || '').toLowerCase();
        if (ext.indexOf('mkv') >= 0 || /\.mkv(\?|$)/.test(url)) return true;
        return false;
    }

    /* ---- unified interface ----------------------------------------------- */

    return {
        /* Is any platform HW player usable in this runtime? */
        isAvailable: isAvailable,
        /* Which one ('tizen' | 'webos' | null). */
        backend: backend,
        /* Should THIS content be routed to the platform player? */
        shouldHandle: shouldHandle,
        /* True only for backends that fully take over playback here (Tizen). For
         * webOS we hand back to player.js's <video> path, so this is false and
         * player.js should use engine 'native' with the webosHint() type. */
        takesOverPlayback: function () { return backend() === 'tizen'; },
        webosHint: webosHint,
        /* webOS: apply the mediaOption <source> for MKV; returns true if applied. */
        webosShouldApply: webosShouldApply,
        webosApplySource: webosApplySource,
        webosClearSource: webosClearSource,

        /* Tizen playback controls (no-ops on other backends). */
        play: function (url, opts, cb) {
            if (backend() === 'tizen') { tizenPlay(url, opts, cb); return true; }
            return false;
        },
        stop: function () { if (backend() === 'tizen') tizenStop(); },
        pause: function () { if (backend() === 'tizen') tizenPause(); },
        resume: function () { if (backend() === 'tizen') tizenResume(); },
        seek: function (ms) { if (backend() === 'tizen') tizenSeek(ms); },
        /* Fullscreen video scaling; Tizen only (no-op elsewhere). */
        setScale: function (mode, x, y, w, h) { return backend() === 'tizen' ? tizenSetScale(mode, x, y, w, h) : false; },
        getTime: function () { return backend() === 'tizen' ? tizenGetTime() : 0; },
        getDuration: function () { return backend() === 'tizen' ? tizenGetDuration() : 0; },
        /* Audio track enumeration/switching — Tizen only (no-op elsewhere, same
         * as every other Tizen-only control above). Not verified against a real
         * device; see the functions' own comment. */
        getAudioTracks: function () { return backend() === 'tizen' ? tizenGetAudioTracks() : []; },
        setAudioTrack: function (index) { return backend() === 'tizen' ? tizenSetAudioTrack(index) : false; }
    };
})();
