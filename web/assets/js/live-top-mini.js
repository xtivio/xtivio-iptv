/* LiveTopMiniPlayer — moves #videoEl into mini frame, delegates playback to main Player */
var LiveTopMiniPlayer = (function () {
    'use strict';
    var frame, ph, spinner, loadingText, current;
    var active = false, suspended = false;
    var loadingBoundVideo = null;
    var loadingStartedAt = 0;
    var loadingReadyTimer = null;
    var loadingFailTimer = null;
    var MINI_LOAD_TIMEOUT_MS = 15000;
    var videoEl = null;
    var originalParent = null;
    // See onPlayerStateEvent below — true once player.js has actually
    // confirmed this session is exo-routed, so the (irrelevant-to-exo)
    // <video>-DOM watchdog can be suppressed instead of racing it to a false
    // "Stream unavailable".
    var exoStateActive = false;

    function $(v) { return document.getElementById(v); }

    function init() {
        frame = $('liveTopMiniFrame');
        ph = $('liveTopMiniPlaceholder');
        spinner = $('liveTopMiniSpinner');
        loadingText = $('liveTopMiniLoadingText');
        var expand = $('liveTopMiniExpand');
        var close = $('liveTopMiniClose');
        
        if (expand) expand.addEventListener('click', function () { expandToFull(); });
        if (close) close.addEventListener('click', function () {
            stop(false);
            var chList = $('liveChList');
            if (chList && chList.querySelector('.focusable')) Focus.focusFirstIn(chList);
        });
    }

    function setPlaceholder(s) { 
        if (ph) ph.style.display = s ? '' : 'none'; 
    }

    function setLoading(s) {
        if (!spinner) spinner = $('liveTopMiniSpinner');
        loadingText = $('liveTopMiniLoadingText');
        if (loadingReadyTimer) { clearTimeout(loadingReadyTimer); loadingReadyTimer = null; }
        if (s) loadingStartedAt = Date.now();
        if (frame) {
            if (s) frame.classList.add('is-loading');
            else frame.classList.remove('is-loading');
        }
        if (spinner) {
            if (s) spinner.classList.remove('hidden');
            else spinner.classList.add('hidden');
        }
        if (loadingText) {
            loadingText.textContent = T('loading_stream');
            if (s) loadingText.classList.remove('hidden');
            else loadingText.classList.add('hidden');
        }
    }

    function unbindLoadingEvents() {
        var vid = loadingBoundVideo;
        if (loadingFailTimer) { clearTimeout(loadingFailTimer); loadingFailTimer = null; }
        if (!vid) return;
        try {
            vid.removeEventListener('loadstart', onMiniVideoLoading);
            vid.removeEventListener('waiting', onMiniVideoLoading);
            vid.removeEventListener('stalled', onMiniVideoLoading);
            vid.removeEventListener('canplay', onMiniVideoCanPlay);
            vid.removeEventListener('playing', onMiniVideoReady);
            vid.removeEventListener('error', onMiniVideoError);
        } catch (e) {}
        loadingBoundVideo = null;
    }

    function onMiniVideoLoading() {
        if (frame) frame.classList.remove('is-error');
        // Once we're playing, ignore transient waiting/stalled events — HLS fires
        // these routinely while re-buffering and the spinner shouldn't flash back
        // over a video that's still running. Only show loading before first play.
        if (frame && frame.classList.contains('is-playing')) return;
        if (active || suspended) setLoading(true);
    }

    function onMiniVideoCanPlay() {
        // Keep the visible loading state until actual playback starts.
        setPlaceholder(false);
        if (active || suspended) setLoading(true);
    }

    function onMiniVideoReady() {
        if (loadingFailTimer) { clearTimeout(loadingFailTimer); loadingFailTimer = null; }
        if (frame) { frame.classList.add('is-playing'); frame.classList.remove('is-error'); }
        setPlaceholder(false);
        var wait = 650 - (Date.now() - loadingStartedAt);
        if (wait < 0) wait = 0;
        loadingReadyTimer = setTimeout(function () { setLoading(false); }, wait);
        keepExpandFocusIfSafe();
    }

    /* Mini-player error/timeout state. Previously the 'error' event was wired to
     * onMiniVideoReady, so a failed stream hid the spinner and marked the frame
     * "playing" with no video — a blank box — or, if no event fired, span
     * forever. Surface a clear, contained error state instead. This targets ONLY
     * the mini player; the fullscreen player has its own error handling. */
    function onMiniVideoError() {
        if (loadingFailTimer) { clearTimeout(loadingFailTimer); loadingFailTimer = null; }
        if (loadingReadyTimer) { clearTimeout(loadingReadyTimer); loadingReadyTimer = null; }
        if (frame) { frame.classList.remove('is-loading', 'is-playing'); frame.classList.add('is-error'); }
        if (spinner) spinner.classList.add('hidden');
        if (!loadingText) loadingText = $('liveTopMiniLoadingText');
        if (loadingText) {
            loadingText.textContent = T('stream_unavailable');
            loadingText.classList.remove('hidden');
        }
        // Error message shows on its own — no placeholder text behind it.
        setPlaceholder(false);
    }

    function startLoadWatchdog() {
        if (loadingFailTimer) clearTimeout(loadingFailTimer);
        // If playback hasn't started within the window, treat as a failure so
        // the spinner doesn't spin indefinitely on a dead stream.
        loadingFailTimer = setTimeout(function () {
            if ((active || suspended) && frame && !frame.classList.contains('is-playing')) {
                onMiniVideoError();
            }
        }, MINI_LOAD_TIMEOUT_MS);
    }

    function keepExpandFocusIfSafe() {
        if (!window.Focus || !Focus.current || !Focus.focusKey) return;
        var curF = Focus.current();
        var curKey = curF && curF.getAttribute ? curF.getAttribute('data-focus-key') : null;
        // Safe to advance focus to the expand button if focus is nowhere, on the
        // remembered origin, already on expand, OR still on a live channel row
        // (gch-*). The channel row is the launch origin: when a parental unlock
        // runs first, Focus.current() at play()-time can be null (the PIN modal
        // just closed), so _lastFocusBeforeMini is never set and the row key
        // wouldn't otherwise match — yet focus is sitting right on the gch-* row.
        // Treating gch-* as safe makes this robust to that capture race.
        if (!curKey || curKey === _lastFocusBeforeMini || curKey === 'live-top-mini-expand' || curKey.indexOf('gch-') === 0 || curKey.indexOf('ch-') === 0) {
            Focus.focusKey('live-top-mini-expand');
        }
    }

    function bindLoadingEvents(vid) {
        if (!vid) return;
        unbindLoadingEvents();
        loadingBoundVideo = vid;
        try {
            vid.addEventListener('loadstart', onMiniVideoLoading);
            vid.addEventListener('waiting', onMiniVideoLoading);
            vid.addEventListener('stalled', onMiniVideoLoading);
            vid.addEventListener('canplay', onMiniVideoCanPlay);
            vid.addEventListener('playing', onMiniVideoReady);
            vid.addEventListener('error', onMiniVideoError);
        } catch (e) {}
        startLoadWatchdog();
    }

    function updateMeta(ch) {
        var nm = $('liveTopMiniName');
        var nowTxt = $('liveTopMiniNow');
        
        if (nm) nm.textContent = ch && ch.name ? Util.cleanseDisplayName(ch.name) : 'No channel selected';
        
        if (nowTxt) {
            if (ch && typeof Epg !== 'undefined') {
                var nn = Epg.getNowNext(ch.playlistId, ch.tvgId || ch.epgId);
                nowTxt.textContent = nn && nn.now ? Util.cleanseDisplayName(nn.now.title) : Util.cleanseDisplayName(ch.category || 'Live TV');
            } else {
                nowTxt.textContent = ch ? 'Live TV' : 'Press OK on a channel to preview';
            }
        }
    }

    function getVideoEl() {
        if (!videoEl) videoEl = $('videoEl');
        return videoEl;
    }

    function moveToMini() {
        var vid = getVideoEl();
        if (!vid || !frame) return false;
        
        if (!originalParent) {
            originalParent = vid.parentNode;
        }

        // Apply the mini-frame fill styles via individual style properties
        // (CSP-exempt) rather than cssText, which a strict CSP blocks. moveBack
        // clears these same properties to restore the original (unstyled) video.
        vid.style.width = '100%';
        vid.style.height = '100%';
        vid.style.position = 'absolute';
        vid.style.top = '0';
        vid.style.left = '0';
        vid.style.right = '0';
        vid.style.bottom = '0';
        vid.style.objectFit = 'contain';
        vid.style.zIndex = '1';
        vid.style.background = '#12151d';
        frame.insertBefore(vid, frame.firstChild);
        return true;
    }

    function moveBack() {
        var vid = getVideoEl();
        if (!vid) return;
        
        if (originalParent && vid.parentNode !== originalParent) {
            // Clear the properties moveToMini set, returning the video to its
            // original (unstyled) state without touching the style attribute.
            vid.style.width = '';
            vid.style.height = '';
            vid.style.position = '';
            vid.style.top = '';
            vid.style.left = '';
            vid.style.right = '';
            vid.style.bottom = '';
            vid.style.objectFit = '';
            vid.style.zIndex = '';
            vid.style.background = '';
            originalParent.appendChild(vid);
        }
    }

    var _lastFocusBeforeMini = null;
    var exoMiniTrackingRAF = null;
    var exoMiniLastRectKey = null;

    /* Mini player with ExoPlayer — two compounding problems:
     *
     * 1. False "Stream unavailable": the DOM-video watchdog below
     *    (startLoadWatchdog/onMiniVideoError) only ever hears from the
     *    <video> element's own events, which NEVER fire for exo playback —
     *    it bypasses that element entirely. So the 15s watchdog ALWAYS
     *    eventually declared failure for exo-routed content, real success or
     *    not, with no way to ever clear itself again afterward.
     *
     * 2. Video leaking fullscreen instead of staying in the mini frame: the
     *    original bounds-tracking start was a blind requestAnimationFrame
     *    guess at Player.activeEngine() — it could run its first check
     *    before the async Stalker/Xtream resolve had even set the engine
     *    yet, see something other than 'exo', and give up PERMANENTLY (the
     *    old code never retried once stopped). Meanwhile exo went on to
     *    actually start and play successfully — just at its fullscreen
     *    default bounds, since nothing ever confined it.
     *
     * Fix: subscribe to Player.onStateEvent() — real 'engine'/'ready'/
     * 'error'/'buffering' signals fired directly from player.js's own exo
     * callbacks — instead of guessing from unrelated DOM state or timing.
     * Bounds tracking now only STARTS once 'engine' actually confirms exo
     * (no more racing the resolve), and the mini frame's ready/error display
     * is driven by the real signal instead of the blind DOM watchdog, which
     * is suppressed the moment exo is confirmed.
     *
     * Known limitation, unchanged: the native surface can't pick up the mini
     * frame's rounded corners (border-radius) — it sits behind the WebView
     * entirely, outside CSS's reach. Square corners on the exo mini preview
     * only. Needs the html[data-exo-mini-active] CSS punch-through (see
     * screens.css) alongside this tracking, same as before.
     */
    function onPlayerStateEvent(type, detail) {
        if (!active) return;
        if (type === 'engine') {
            if (detail === 'exo') {
                exoStateActive = true;
                // The DOM-video watchdog can never hear a real signal for
                // exo — stop it before it fires a false failure.
                if (loadingFailTimer) { clearTimeout(loadingFailTimer); loadingFailTimer = null; }
                startExoBoundsTracking();
            } else if (exoStateActive) {
                // Engine moved away from exo (e.g. player.js's own error ->
                // native-retry cascade) — release the surface back to
                // fullscreen default and hand off to the normal <video>-DOM
                // path, which handles native/hlsjs playback fine already.
                exoStateActive = false;
                stopExoBoundsTracking();
            }
            return;
        }
        if (!exoStateActive) return; // everything below is exo-only; native/hlsjs already has its own DOM-event path
        if (type === 'ready') {
            onMiniVideoReady();
        } else if (type === 'error') {
            onMiniVideoError();
            stopExoBoundsTracking();
        } else if (type === 'buffering') {
            onMiniVideoLoading();
        }
    }

    function startExoBoundsTracking() {
        if (exoMiniTrackingRAF) return; // already running
        document.documentElement.setAttribute('data-exo-mini-active', '1');
        function tick() {
            // exoStateActive (set/cleared by onPlayerStateEvent's real
            // 'engine' signal above) is the authoritative gate now, not a
            // fresh activeEngine() poll — kept here only as a light extra
            // safety net.
            if (!active || !frame || !exoStateActive) {
                stopExoBoundsTracking();
                return;
            }
            try {
                var r = frame.getBoundingClientRect();
                // Sound but no picture: this used to multiply by
                // window.devicePixelRatio here — wrong factor for this app's
                // viewport setup (see AndroidBridge.exoSetBounds's doc for the
                // full explanation: this app pins the WebView so 1920 CSS px
                // == the full physical panel width, unrelated to
                // devicePixelRatio). Send raw CSS pixels now; the one correct
                // conversion happens natively, reusing MainActivity's own
                // setInitialScale formula instead of a second, wrong guess.
                // Pinch-zoom (Android UI zoom is deliberately enabled outside the
                // full player): the DOM mini frame scales and pans with the page, but
                // the native surface is positioned from these numbers alone, and the
                // native side assumes an UNZOOMED 1920-wide viewport. Without a
                // correction the video stays put while the overlay buttons zoom away
                // from it. The visual viewport says which part of the layout viewport
                // is actually on screen (offsetLeft/Top) and how many CSS px of it fit
                // (width): re-express the rect relative to that, in the same 1920-wide
                // units the native conversion expects. Unzoomed this is the identity
                // (offset 0, width 1920 -> k = 1), so nothing changes there. Browsers
                // without visualViewport (older TV engines, which never pinch-zoom
                // anyway) fall through to the raw rect.
                var k = 1, offL = 0, offT = 0;
                try {
                    var vv = window.visualViewport;
                    if (vv && vv.width > 0) {
                        k = 1920 / vv.width;
                        offL = vv.offsetLeft || 0;
                        offT = vv.offsetTop || 0;
                    }
                } catch (eVV) {}
                var left = Math.round((r.left - offL) * k);
                var top = Math.round((r.top - offT) * k);
                var w = Math.round(r.width * k);
                var h = Math.round(r.height * k);
                if (w > 0 && h > 0) {
                    var key = left + ',' + top + ',' + w + ',' + h;
                    if (key !== exoMiniLastRectKey && window.PlayerExo && PlayerExo.setBounds) {
                        exoMiniLastRectKey = key;
                        PlayerExo.setBounds(left, top, w, h);
                    }
                }
            } catch (e) {}
            exoMiniTrackingRAF = window.requestAnimationFrame(tick);
        }
        exoMiniTrackingRAF = window.requestAnimationFrame(tick);
    }

    function stopExoBoundsTracking() {
        if (exoMiniTrackingRAF) {
            try { window.cancelAnimationFrame(exoMiniTrackingRAF); } catch (e) {}
            exoMiniTrackingRAF = null;
        }
        exoMiniLastRectKey = null;
        try { document.documentElement.removeAttribute('data-exo-mini-active'); } catch (e) {}
        try { if (window.PlayerExo && PlayerExo.clearBounds) PlayerExo.clearBounds(); } catch (e) {}
    }

    function play(ch, preserveFocusMemory) {
        // Stalker/MAG channels carry no direct url (resolved per-play downstream by
        // Player.play); allow them through. Everything else needs a url.
        if (!ch) return;
        if (!ch.url && ch.type !== 'stalker') return;
        // Save focus for return from full player. Resume should not overwrite the original channel row.
        var fc = typeof Focus !== 'undefined' && Focus.current ? Focus.current() : null;
        if (!preserveFocusMemory && fc && fc.getAttribute && fc.getAttribute('data-focus-key')) _lastFocusBeforeMini = fc.getAttribute('data-focus-key');
        current = ch;
        active = true;
        suspended = false;
        if (frame) {
            frame.classList.remove('is-playing');
            frame.classList.add('has-channel');
        }

        updateMeta(ch);

        // Show the side "Now Playing" panel as soon as a channel is chosen so it tracks
        // what's actually in the mini player, not what the cursor is hovering over. Single
        // entry point (forcePlaying=true) — it fills NOW + NEXT, sets the NOW PLAYING label,
        // and handles the no-EPG case, so the box can't drift out of sync with the guide.
        try {
            if (window.UI && UI.updateLiveNowBar) UI.updateLiveNowBar(null, true);
        } catch (npErr) {}

        // Move the DOM element BEFORE initializing the player
        if (!moveToMini()) return;

        // Once a channel is chosen, hide the idle placeholder immediately and show buffering status.
        setPlaceholder(false);
        setLoading(true);

        var vid = getVideoEl();
        bindLoadingEvents(vid);

        // Subscribe BEFORE calling Player.play() so the earliest possible
        // 'engine' event (fired synchronously inside startStream(), which
        // itself may run synchronously or after an async Stalker/Xtream
        // resolve) is never missed.
        exoStateActive = false;
        if (window.Player && Player.offStateEvent) Player.offStateEvent(onPlayerStateEvent); // idempotent guard against a stray double-subscribe
        if (window.Player && Player.onStateEvent) Player.onStateEvent(onPlayerStateEvent);

        if (window.Player && Player.play) {
            Player.play(ch);
        }

        keepExpandFocusIfSafe();
        setTimeout(keepExpandFocusIfSafe, 250);
        setTimeout(keepExpandFocusIfSafe, 750);
        setTimeout(keepExpandFocusIfSafe, 1400);
    }

    function stop(isExpanding) {
        active = false;
        suspended = false;
        exoStateActive = false;

        // Video leaked into the UI for ~1s on mini close: this used
        // to call stopExoBoundsTracking() — which resets the native surface
        // straight to fullscreen bounds — BEFORE Player.stop() ever told the
        // native side to actually halt playback and re-arm its shutter. For
        // whatever gap the WebView's own CSS repaint took to catch up
        // (removing data-exo-mini-active, restoring opaque html/body/#app
        // backgrounds — not instant, especially across three elements at
        // once), the surface sat fullscreen-sized, STILL actively rendering
        // the last live frame, with nothing reliable covering it. Calling
        // Player.stop() FIRST re-arms the native shutter (a native opaque
        // view — no dependency on WebView repaint timing at all) while the
        // surface is still confined to the small mini rect; clearBounds()
        // then safely grows the already-opaque shutter and the surface to
        // fullscreen together, with nothing ever visible in between. Only
        // applies when actually stopping — isExpanding deliberately skips
        // Player.stop() to keep playback running uninterrupted into the
        // fullscreen player, so this reordering doesn't apply there.
        if (!isExpanding && window.Player && Player.stop) {
            Player.stop();
        }

        stopExoBoundsTracking();
        try { if (window.Player && Player.offStateEvent) Player.offStateEvent(onPlayerStateEvent); } catch (e) {}

        unbindLoadingEvents();
        if (loadingReadyTimer) { clearTimeout(loadingReadyTimer); loadingReadyTimer = null; }
        setLoading(false);
        if (frame) {
            frame.classList.remove('is-playing');
            frame.classList.remove('is-loading');
            frame.classList.remove('has-channel');
        }

        moveBack();
        
        if (!isExpanding) {
            current = null;
            updateMeta(null);
        }
        
        setPlaceholder(true);

        // Refresh the side panel whenever the mini player is fully stopped (close button
        // or programmatic stop): with nothing playing, updateLiveNowBar reverts to the
        // focused guide row if there is one, or hides the box otherwise. Single entry point
        // so NOW + NEXT + label all clear together. When EXPANDING to full-screen we leave
        // the panel as-is so the guide stays useful in the background.
        if (!isExpanding) {
            try {
                if (window.UI && UI.updateLiveNowBar) UI.updateLiveNowBar();
            } catch (clearErr) {}
        }
    }

    function suspend() {
        if (!active) return;
        // Tapping a live channel a second time while
        // already playing in the mini preview opened the full player with
        // audio but no video: isActive() just returns active, and
        // player.js's punch-through code checks it to decide whether the
        // FULLSCREEN player should set html[data-exo-active] (skipping it
        // when the mini player is "still driving", so the mini's own
        // narrower punch-through isn't doubled up with the fullscreen one).
        // suspend() — called by doPlay() right before the fullscreen player
        // takes over — only ever set suspended, never active, unlike every
        // sibling teardown here (stop(), prepareAfterFullReturn(),
        // expandToFull() all correctly clear active too). So isActive() kept
        // reporting true through the fullscreen transition, the punch-
        // through code concluded the mini player was still the one driving,
        // and never made the fullscreen player's own layers transparent —
        // its video stayed hidden behind the opaque WebView chain while
        // audio played normally regardless (audio doesn't depend on the
        // punch-through at all).
        active = false;
        suspended = true;
        exoStateActive = false;
        // Same reordering fix as stop() above, same reason: Player.stop()
        // (re-arms the native shutter) has to run before stopExoBoundsTracking()
        // (resets the surface to fullscreen) or the surface briefly plays
        // fullscreen uncovered while the WebView's own CSS repaint catches up.
        if (window.Player && Player.stop) Player.stop();
        stopExoBoundsTracking();
        try { if (window.Player && Player.offStateEvent) Player.offStateEvent(onPlayerStateEvent); } catch (e) {}
        unbindLoadingEvents();
        if (loadingReadyTimer) { clearTimeout(loadingReadyTimer); loadingReadyTimer = null; }
        setLoading(false);
        moveBack();
    }

    function resume() {
        if (!suspended || !current) return;
        suspended = false;
        play(current, true);
    }

    function prepareAfterFullReturn() {
        if (frame) {
            frame.classList.remove('is-playing');
            frame.classList.remove('is-loading');
        }
        active = false;
        suspended = false;
        exoStateActive = false;
        stopExoBoundsTracking();
        try { if (window.Player && Player.offStateEvent) Player.offStateEvent(onPlayerStateEvent); } catch (e) {}
        unbindLoadingEvents();
        setLoading(false);
        moveBack();
        updateMeta(current);
        setPlaceholder(true);
    }

    function expandToFull() {
        if (!current) return;
        var ch = current;
        
        // 1. Snapshot focus memory before heading to player
        window._liveTvReturnFocusKey = _lastFocusBeforeMini;
        var activeS = document.querySelector('.content-section.active');
        if (activeS) {
            var sName = activeS.getAttribute('data-section-content');
            window._lastSectionBeforePlayer = sName;
            
            var curFocused = window.Focus ? Focus.current() : null;
            if (curFocused && curFocused.getAttribute && curFocused.getAttribute('data-focus-key')) {
                if (typeof SECTION_FOCUS_MEMORY !== 'undefined') {
                    SECTION_FOCUS_MEMORY[sName] = curFocused.getAttribute('data-focus-key');
                }
            }
        }

        // 2. Completely kill playback and move the video surface back,
        // but keep current channel metadata so Live TV can resume after fullscreen.
        if (window.Player && Player.stop) Player.stop();
        exoStateActive = false;
        stopExoBoundsTracking();
        try { if (window.Player && Player.offStateEvent) Player.offStateEvent(onPlayerStateEvent); } catch (e) {}
        unbindLoadingEvents();
        setLoading(false);
        if (frame) {
            frame.classList.remove('is-playing');
            frame.classList.remove('is-loading');
        }
        active = false;
        suspended = true;
        moveBack();
        setPlaceholder(false);

        // 3. Trigger a fresh playback instance in the main player
        if (window.UI && UI.doPlay) {
            UI.doPlay(ch, false);
        }
    }

    return {
        init: init, 
        play: play, 
        stop: function() { stop(false); },
        suspend: suspend, 
        resume: resume,
        expandToFull: expandToFull,
        currentChannel: function () { return current; },
        prepareAfterFullReturn: prepareAfterFullReturn,
        isActive: function () { return active; },
        lastFocusKey: function () { return _lastFocusBeforeMini; }
    };
})();