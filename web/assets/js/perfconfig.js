/* perfconfig.js - Centralized runtime performance policy (Normal / Lite)
 *
 * One source of truth for every performance lever. Other modules never
 * hard-code a chunk size, page size, EPG horizon, etc.; they read the current
 * value from PerfConfig at the point of use (e.g. PerfConfig.get('pageSize')).
 * That keeps Normal and Lite behaviour defined in exactly one place.
 *
 * Two effective modes:
 *   - normal : today's unrestricted behaviour. Every 'normal' value below is
 *              the value the code used before this module existed, so turning
 *              the module on changes nothing until the effective mode is Lite.
 *   - lite   : reduced footprint for weak TVs (WebOS/Tizen 4-series engines).
 *              Smaller import chunks with more yielding, fewer parallel images,
 *              a shorter EPG horizon, no boot EPG/VOD preload, and a narrower
 *              search scope for very large catalogs.
 *
 * Mode selection (precedence, highest first):
 *   1. Explicit user choice (settings.perfMode = 'normal' | 'lite'). Always wins.
 *   2. mode === 'auto' -> AutoLite.resolve() decides, using:
 *        - Strong  : a genuinely tiny JS heap limit (<128MB), OR live heap
 *                    pressure at startup (used/limit >= 80%). A static heap
 *                    limit near 300-400MB is NOT used — it doesn't predict real
 *                    behaviour (a healthy 6.5 reports ~347MB and runs the full
 *                    load at ~8%), so real strain is what counts.
 *        - Medium  : a prior crash-recovery marker, or a recorded history of
 *                    import/search/EPG slowness.
 *        - Weak    : hardwareConcurrency <= 2. A tie-breaker only: it never
 *                    forces Lite on its own.
 *   3. Default 'normal' when nothing signals a constrained device (the common
 *      case, including capable TVs with roomy headroom).
 *
 * ES5 / IIFE-safe. No Promises, arrow functions, const/let, or template
 * literals. Never throws to callers: every public method degrades to a safe
 * default rather than raising.
 */
var PerfConfig = (function () {
    'use strict';

    /* Per-mode lever values. 'normal' mirrors the pre-existing constants:
     *   importChunkSize/importChunkDelayMs -> parser IMPORT_CHUNK_SIZE / _DELAY_MS
     *   imageConcurrency                   -> image-load queue (wired later)
     *   searchLimit                        -> search MAX_RESULTS
     *   pageSize                           -> VOD/series/live list PAGE_SIZE
     *   epgMaxDays                         -> EPG parse retention horizon (days)
     *   epgMaxChars                        -> size cap on one EPG file once unpacked (characters), used only when
     *                                         the guide cannot be read as a stream (it must then fit in one string);
     *                                         a bigger guide is cut at the cap and only its first part is used
     *   epgMaxPastDays                     -> how far back (days) past programmes are kept for channels with a
     *                                         catch-up archive (within a budget sized from the heap limit)
     *   epgBootPreload                     -> boot-time EPG preload timer
     *   disablePosterPreload               -> poster <img> prefetch in lists
     *   disableVodPreload                  -> preloadVodForSearch at boot
     *   globalSearchVodEnabled             -> index VOD/series into global search
     *   maxParseObjects                    -> hard ceiling on objects parsed from
     *                                         one VOD/series JSON payload (memory
     *                                         guard against pathologically large
     *                                         catalogs on a small heap)
     */
    var PROFILES = {
        normal: {
            importChunkSize: 500,
            importChunkDelayMs: 8,
            imageConcurrency: 6,
            searchLimit: 80,
            pageSize: 50,
            epgMaxDays: 3,
            epgMaxProgrammes: 0,
            epgMaxChars: 250000000,
            epgMaxPastDays: 7,
            epgBootPreload: true,
            disablePosterPreload: false,
            disableVodPreload: false,
            globalSearchVodEnabled: true,
            maxParseObjects: 250000,
            // Grid poster preload: how many rows/cols around the focused card to
            // warm in each direction (Phase 5B grid-aware warming). Larger = more
            // posters ready before you scroll into them, at more image load.
            warmRadius: 2
        },
        lite: {
            importChunkSize: 250,
            importChunkDelayMs: 16,
            imageConcurrency: 2,
            searchLimit: 30,
            pageSize: 25,
            epgMaxDays: 1,
            epgMaxProgrammes: 100000,
            epgMaxChars: 120000000,
            epgMaxPastDays: 1,
            epgBootPreload: false,
            disablePosterPreload: true,
            disableVodPreload: true,
            globalSearchVodEnabled: false,
            maxParseObjects: 60000,
            // Tighter neighborhood on constrained devices (Phase 5B).
            warmRadius: 1
        }
    };

    // Requested mode: 'auto' | 'normal' | 'lite'. What the user/settings asked
    // for (auto means "decide for me").
    var requestedMode = 'auto';
    // Resolved mode actually in effect this session: 'normal' | 'lite'.
    var effectiveMode = 'normal';
    // Why effectiveMode was chosen: 'user' | 'auto-strong' | 'auto-medium' |
    // 'auto-weak' | 'default'. Surfaced in the Settings UI later.
    var reason = 'default';
    // Live pointer to the active profile; swapped by resolve().
    var active = PROFILES.normal;

    /* ----- settings persistence (safe whether or not Store is ready) ----- */
    function readSettings() {
        try {
            if (typeof Store !== 'undefined' && Store.getSettings) {
                return Store.getSettings() || {};
            }
        } catch (e) {}
        return {};
    }
    function writeSetting(key, value) {
        try {
            if (typeof Store === 'undefined' || !Store.getSettings || !Store.setSettings) return;
            var st = Store.getSettings() || {};
            st[key] = value;
            Store.setSettings(st);
        } catch (e) {}
    }

    /* ----- auto-detection ----- */
    var AutoLite = {
        // Strong signal: a genuinely tiny addressable JS heap. Only meaningful
        // when the (Chromium-only) performance.memory API is present.
        //
        // Threshold history. It was originally 384MB, which was too aggressive:
        // a healthy WebOS 6.5 reports a ~347MB heap limit yet runs the heaviest
        // realistic load (a 58MB / 146k-programme EPG plus 21k channels) at ~8%
        // of that limit, so 384MB needlessly degraded a capable TV. It was then
        // dropped to 128MB, which proved too permissive at the other end: older
        // hardware (WebOS 4 era) can pass a 128MB floor yet still exhaust its
        // heap once the VOD/series search index is resident. LG's own
        // pre-certification guidance holds apps to roughly 150MB at idle on
        // low-end WebOS 3.x/4.x devices, and a large catalog's resident index
        // alone can approach or exceed that.
        //
        // 192MB sits deliberately between the two: comfortably above LG's ~150MB
        // low-end budget (so a device that can only just meet it is treated as
        // constrained), and far enough below the ~347MB a healthy 6.5 reports
        // that a capable TV is never degraded.
        //
        // NOTE this is a STATIC limit check and so is inherently a blunt
        // instrument — it says nothing about what the app actually goes on to
        // allocate. The mid-index pressure check in the VOD/series streaming
        // preload (see maxIndexEntries) is what catches a device that boots
        // fine and only runs out of headroom once indexing is under way.
        heapIsTiny: function () {
            try {
                var mem = (typeof performance !== 'undefined') ? performance.memory : null;
                var limit = mem && mem.jsHeapSizeLimit ? mem.jsHeapSizeLimit : 0;
                return !!limit && limit < 192 * 1024 * 1024;
            } catch (e) { return false; }
        },
        // Medium signal: a prior crash-recovery marker or a recorded history of
        // repeated slowness (set elsewhere via PerfConfig.noteSlowness / the
        // crash marker). Persisted in settings so it survives a reload.
        hasMediumSignal: function () {
            try {
                var st = readSettings();
                if (st.perfCrashMarker) return true;
                if (st.perfSlowCount && st.perfSlowCount >= 3) return true;
            } catch (e) {}
            return false;
        },
        // Weak signal: very low core count. Tie-breaker ONLY — never decisive
        // on its own (see resolve()).
        lowCores: function () {
            try {
                var cores = navigator.hardwareConcurrency || 0;
                return !!cores && cores <= 2;
            } catch (e) { return false; }
        },
        // Live heap-pressure check. True when used heap is near the limit. This
        // is the honest strong signal: it measures the device actually running
        // close to its ceiling right now, rather than guessing from a static
        // limit. Used both at boot (a device already under pressure at startup)
        // and by the runtime monitor.
        underHeapPressure: function () {
            try {
                var mem = (typeof performance !== 'undefined') ? performance.memory : null;
                if (!mem || !mem.usedJSHeapSize || !mem.jsHeapSizeLimit) return false;
                return (mem.usedJSHeapSize / mem.jsHeapSizeLimit) >= 0.80;
            } catch (e) { return false; }
        },
        /* Resolve an auto decision. Returns { mode: 'normal'|'lite',
         * reason: 'auto-strong'|'auto-medium'|'default' }.
         *
         * Basis (see comments above): don't degrade a device from a static heap
         * ceiling that doesn't predict real behaviour. Lite is chosen only when
         * the device is genuinely tiny (<128MB heap), already under live heap
         * pressure at startup, or has a medium signal (a prior crash marker or
         * recorded slowness). A capable TV with roomy headroom and no slowness
         * therefore defaults to Normal. Cores alone never force Lite. */
        resolve: function () {
            if (this.heapIsTiny()) return { mode: 'lite', reason: 'auto-strong' };
            if (this.underHeapPressure()) return { mode: 'lite', reason: 'auto-strong' };
            if (this.hasMediumSignal()) return { mode: 'lite', reason: 'auto-medium' };
            // Weak signal (lowCores) is intentionally not enough on its own.
            return { mode: 'normal', reason: 'default' };
        }
    };

    function applyProfile(mode, why) {
        effectiveMode = (mode === 'lite') ? 'lite' : 'normal';
        reason = why || 'default';
        active = PROFILES[effectiveMode];
        return effectiveMode;
    }

    // Crash-recovery state, resolved at boot from the persisted marker/count.
    // recoveryLevel: 0 = normal operation; 1 = last boot crashed (load light —
    // skip VOD preload this boot); 2+ = repeated crashes (force full Lite).
    var recoveryLevel = 0;

    /* Resolve the effective mode from the requested mode, with a crash-recovery
     * override. Call at boot (after Store is available) and again whenever the
     * user changes the setting.
     *
     * Crash recovery takes precedence even over an explicit user mode, because
     * an app that won't start is worse than one that ignores a preference to
     * stay alive. If the previous boot armed the crash marker and never cleared
     * it (i.e. it crashed), the marker is still set now:
     *   - 1 crash  -> keep the requested mode but force the VOD preload off this
     *                 boot (the usual OOM source on huge catalogs), so the app
     *                 can at least start with live + EPG.
     *   - 2+ crashes -> force full Lite.
     * A successful boot clears the marker and resets the count, so this
     * self-heals the moment a boot survives. */
    // Set once at boot when IDB init resolves. When IndexedDB is unavailable
    // (missing, private mode, or the open()-stall some WebOS builds hit) the app
    // has no spill/cache layer, so the full live+EPG+VOD+series dataset would have
    // to stay resident — historically the ~330k-entry in-memory ceiling that
    // OOM-crashed weak devices. Treated like a level-2 crash: force Lite, which
    // skips VOD/series indexing and tightens the parse caps, keeping the resident
    // set well under that ceiling. Dormant when IDB works (stays false), so the
    // common path is unchanged.
    var idbUnavailable = false;
    function setIdbUnavailable(v) { idbUnavailable = !!v; }

    // EPG crash guard. The guide download + parse is its own risky phase (it can
    // run a small TV heap out before the movie/series guard above is ever armed).
    // armEpgGuard() persists a marker when the guide load starts and
    // clearEpgGuard() removes it once the guide has settled. If the app dies in
    // between, the marker survives and the NEXT boot reads it as a guide crash:
    //   - Auto mode: that boot comes up in Lite (shorter horizon, programme cap,
    //     no boot guide load). The boot after retries Normal; if that crashes too
    //     (2 in a row) Lite becomes sticky (perfEpgLite) until the user picks a
    //     Performance Mode. A Normal boot whose guide finishes resets the count.
    //   - Manual Normal / Lite: the user's choice always wins, nothing is forced.
    // Hard reasons (no IndexedDB, repeated movie-preload crashes) still force Lite.
    var epgGuardActive = false;
    var epgLiteThisSession = false;   // this boot is the one-off Lite boot after a guide crash
    function armEpgGuard() {
        epgGuardActive = true;
        try { writeSetting('perfEpgMarker', true); } catch (e) {}
    }
    function clearEpgGuard() {
        epgGuardActive = false;
        try {
            var st = readSettings();
            if (st.perfEpgMarker) writeSetting('perfEpgMarker', false);
            // A guide that ran to the end in Normal proves Normal copes: forget earlier crashes.
            if (effectiveMode !== 'lite' && st.perfEpgCrashes) writeSetting('perfEpgCrashes', 0);
        } catch (e) {}
    }

    function resolve() {
        var st = readSettings();
        // A marker left by a PREVIOUS boot that never cleared it means the guide
        // load died. (Not when this session armed it itself.)
        if (st.perfEpgMarker && !epgGuardActive) {
            writeSetting('perfEpgMarker', false);
            var savedMode = st.perfMode;
            var isAuto = !(savedMode === 'lite' || savedMode === 'normal');
            if (isAuto) {
                var crashes = (st.perfEpgCrashes || 0) + 1;
                writeSetting('perfEpgCrashes', crashes);
                writeSetting('epgLiteNoticeSeen', false);
                if (crashes >= 2) writeSetting('perfEpgLite', true);   // sticky
                else epgLiteThisSession = true;                          // this boot only
            }
            st = readSettings();
        }
        var saved = st.perfMode;
        requestedMode = (saved === 'lite' || saved === 'normal' || saved === 'auto')
            ? saved : 'auto';

        // Determine crash-recovery level from the persisted marker/count. The
        // marker is armed before the risky work each boot and cleared on success
        // (see armCrashGuard / clearCrashGuard).
        recoveryLevel = 0;
        if (st.perfCrashMarker) {
            recoveryLevel = (st.perfCrashCount && st.perfCrashCount >= 2) ? 2 : 1;
        }

        // No IDB spill layer -> force Lite regardless of requested mode. Same
        // precedence as a level-2 crash: staying alive beats honouring a mode.
        if (idbUnavailable) {
            return applyProfile('lite', 'idb-unavailable');
        }
        // The guide load crashed on an earlier boot: stay in Lite until the user
        // chooses a Performance Mode.
        if (epgLiteThisSession || (st.perfEpgLite && requestedMode === 'auto')) {
            return applyProfile('lite', 'epg-crash');
        }
        // 2+ crashes: force Lite regardless of requested mode.
        if (recoveryLevel >= 2) {
            return applyProfile('lite', 'crash-recovery');
        }
        // Explicit user mode (honoured except under the overrides above).
        if (requestedMode === 'lite' || requestedMode === 'normal') {
            return applyProfile(requestedMode, 'user');
        }
        // Auto.
        var decision = AutoLite.resolve();
        return applyProfile(decision.mode, decision.reason);
    }

    /* Set the requested mode from the Settings/onboarding UI and re-resolve.
     * 'auto' | 'normal' | 'lite'. Persists so the choice is stable. */
    function setMode(next) {
        var m = (next === 'lite' || next === 'normal' || next === 'auto') ? next : 'auto';
        writeSetting('perfMode', m);
        try {
            var stM = readSettings();
            if (stM.perfEpgLite || stM.perfEpgCrashes) { writeSetting('perfEpgLite', false); writeSetting('perfEpgCrashes', 0); writeSetting('epgLiteNoticeSeen', false); }
            epgLiteThisSession = false;
        } catch (eEl) {}
        return resolve();
    }

    /* Arm the crash guard before the risky startup work (the VOD/series
     * preload+parse+index, which is what OOMs on huge catalogs). Writes the
     * persisted marker and bumps the consecutive-crash count synchronously, so
     * if the app dies during that work the marker survives to the next boot. If
     * the work completes, clearCrashGuard() removes it. */
    // True from armCrashGuard() until clearCrashGuard(): the risky work is in
    // progress. Lets suspend/resumeCrashGuard() below tell "work still running,
    // app just left the screen" from "work finished".
    var guardActive = false;
    function armCrashGuard() {
        guardActive = true;
        try {
            var st = readSettings();
            st.perfCrashMarker = true;
            st.perfCrashCount = (st.perfCrashCount || 0) + 1;
            if (Store.setSettings) Store.setSettings(st);
        } catch (e) {}
    }

    /* Clear the crash guard after the risky work has completed successfully.
     * Resets the consecutive-crash count — the app started fine, so the next
     * boot begins clean. */
    function clearCrashGuard() {
        guardActive = false;
        try {
            var st = readSettings();
            if (st.perfCrashMarker || st.perfCrashCount) {
                st.perfCrashMarker = false;
                st.perfCrashCount = 0;
                if (Store.setSettings) Store.setSettings(st);
            }
        } catch (e) {}
    }

    /* The app left the screen (home, recents, swiped away, another app on top)
     * while the risky work is still running. On a phone that is the user closing
     * the app, not an out-of-memory crash, but a killed process looks identical to
     * a crash on the next boot (marker still set), and two such closes in a row
     * forced full Lite. So drop the marker while the app is not on screen, and put
     * it back (resumeCrashGuard) if the app returns while the work is still going:
     * a real out-of-memory death happens in the foreground and is still caught.
     * No-op unless the guard is armed. */
    function suspendCrashGuard() {
        if (epgGuardActive) {
            try { if (readSettings().perfEpgMarker) writeSetting('perfEpgMarker', false); } catch (eSe) {}
        }
        if (!guardActive) return;
        try {
            var st = readSettings();
            if (st.perfCrashMarker || st.perfCrashCount) {
                st.perfCrashMarker = false;
                st.perfCrashCount = 0;
                if (Store.setSettings) Store.setSettings(st);
            }
        } catch (e) {}
    }
    function resumeCrashGuard() {
        if (epgGuardActive) {
            try { if (!readSettings().perfEpgMarker) writeSetting('perfEpgMarker', true); } catch (eRe) {}
        }
        if (!guardActive) return;
        try {
            var st = readSettings();
            if (!st.perfCrashMarker) {
                st.perfCrashMarker = true;
                st.perfCrashCount = (st.perfCrashCount || 0) + 1;
                if (Store.setSettings) Store.setSettings(st);
            }
        } catch (e) {}
    }

    /* True when the boot-time VOD/series preload should be skipped entirely —
     * either the active profile disables it (Lite) or crash recovery is forcing
     * a light boot (level >= 1). This is the single check the app uses. */
    function shouldSkipVodPreload() {
        if (recoveryLevel >= 1) return true;
        return get('disableVodPreload') === true;
    }

    /* Record a slowness observation (import/search/EPG took too long). Bumps a
     * persisted counter that becomes a medium auto-detect signal at >= 3. Safe
     * no-op if Store is unavailable. */
    function noteSlowness() {
        try {
            var st = readSettings();
            var n = (st.perfSlowCount || 0) + 1;
            writeSetting('perfSlowCount', n);
            return n;
        } catch (e) { return 0; }
    }

    // Set when a VOD/series payload was too large to fully index this session.
    // capKinds records which kinds were affected ('movie'/'series') so the user
    // notice can name them accurately rather than always saying "movies and
    // series". Read by the app to notify the user and (in Auto) lean Lite next boot.
    var capHit = false;
    var capKinds = { movie: false, series: false };
    // Live truncation is tracked SEPARATELY, not folded into capKinds.
    //
    // The consequence is materially different. A truncated movie/series catalog
    // costs SEARCH COVERAGE only — the content screens fetch per category on
    // demand, so everything is still browsable. A truncated LIVE list means the
    // channels are genuinely GONE from the app: the channel list IS the data.
    // Telling the user "some content is missing from search, you can still browse
    // everything" would therefore be a lie when live was the thing that was cut.
    var liveCapHit = false;
    var liveCapCounts = { loaded: 0, bytes: 0 };
    function noteLiveCapHit(loaded, bytes) {
        liveCapHit = true;
        if (loaded) liveCapCounts.loaded = loaded;
        if (bytes) liveCapCounts.bytes = bytes;
        // Same medium-signal + pending-notice handling as the catalog cap: a
        // channel list this large is strong evidence the device should run reduced.
        try {
            var stL = readSettings();
            if (!stL.perfCrashMarker) {
                writeSetting('perfSlowCount', (stL.perfSlowCount || 0) + 3);
            }
            if (!stL.liveCapNoticePending) writeSetting('liveCapNoticePending', true);
        } catch (eL) {}
    }
    function liveCapNoticePending() {
        try { return !!readSettings().liveCapNoticePending; } catch (e) { return false; }
    }
    function clearLiveCapNoticePending() {
        try { if (readSettings().liveCapNoticePending) writeSetting('liveCapNoticePending', false); } catch (e) {}
    }
    function noteCapHit(kind) {
        if (kind === 'movie' || kind === 'series') capKinds[kind] = true;
        var first = !capHit;
        capHit = true;
        // A catalog large enough to hit the cap is a strong indication this
        // device/playlist combination should run reduced; record the medium
        // signal (once) so Auto leans Lite on the next launch.
        if (first) {
            try {
                var st = readSettings();
                if (!st.perfCrashMarker) {
                    writeSetting('perfSlowCount', (st.perfSlowCount || 0) + 3);
                }
            } catch (e) {}
        }
        // Persist a pending-notice flag. If a huge catalog crashes the app before
        // the in-session notice can show (and the next boot comes up in Lite,
        // which skips the preload so capHit wouldn't be set again), this lets the
        // notice still appear on that next boot. Cleared once shown.
        try {
            var st2 = readSettings();
            if (!st2.capNoticePending) writeSetting('capNoticePending', true);
        } catch (e2) {}
    }
    /* Whether a cap notice is pending from a previous (possibly crashed) session.
     * The app shows the notice at boot if so, then calls clearCapNoticePending. */
    function capNoticePending() {
        try { return !!readSettings().capNoticePending; } catch (e) { return false; }
    }
    function clearCapNoticePending() {
        try { if (readSettings().capNoticePending) writeSetting('capNoticePending', false); } catch (e) {}
    }
    /* Reset the per-session cap flags. Called when a playlist is (re)loaded — e.g.
     * cleared and re-added within a session — so a fresh cap is detected and the
     * notice can show again rather than being suppressed by the prior session's
     * state. Does not touch the persisted pending flag. */
    function resetCapState() {
        capHit = false;
        capKinds = { movie: false, series: false };
    }
    /* Which kinds were capped: returns 'movies', 'series', 'movies and series',
     * or '' if none. Lets the notice name exactly what was left out. */
    /* Which kinds the cap affected: 'both' | 'movies' | 'series' | '' (unknown).
     * Returns a KEY, never display text. This used to return English words that
     * app.js inserted into the translated notice, so every language showed
     * "movies and series" in English mid-sentence (and a noun swapped into a
     * fixed sentence cannot agree in gender/number in all languages). The caller
     * picks one of three complete translated sentences instead. */
    function capKindsKey() {
        if (capKinds.movie && capKinds.series) return 'both';
        if (capKinds.movie) return 'movies';
        if (capKinds.series) return 'series';
        return '';
    }

    /* Read a single lever for the current effective mode. Falls back to the
     * Normal profile, then to undefined, so a missing key never throws. */
    function get(key) {
        if (active && active.hasOwnProperty(key)) return active[key];
        if (PROFILES.normal.hasOwnProperty(key)) return PROFILES.normal[key];
        return undefined;
    }

    return {
        suspendCrashGuard: suspendCrashGuard,
        resumeCrashGuard: resumeCrashGuard,
        resolve: resolve,
        setMode: setMode,
        setIdbUnavailable: setIdbUnavailable,
        get: get,
        noteSlowness: noteSlowness,
        noteCapHit: noteCapHit,
        capWasHit: function () { return capHit; },
        noteLiveCapHit: noteLiveCapHit,
        liveCapWasHit: function () { return liveCapHit; },
        liveCapCounts: function () { return liveCapCounts; },
        liveCapNoticePending: liveCapNoticePending,
        clearLiveCapNoticePending: clearLiveCapNoticePending,
        capKindsKey: capKindsKey,
        capNoticePending: capNoticePending,
        clearCapNoticePending: clearCapNoticePending,
        resetCapState: resetCapState,
        armCrashGuard: armCrashGuard,
        armEpgGuard: armEpgGuard,
        clearEpgGuard: clearEpgGuard,
        clearCrashGuard: clearCrashGuard,
        shouldSkipVodPreload: shouldSkipVodPreload,
        getRecoveryLevel: function () { return recoveryLevel; },
        isLite: function () { return effectiveMode === 'lite'; },
        getMode: function () { return effectiveMode; },
        getRequestedMode: function () { return requestedMode; },
        getReason: function () { return reason; },
        // Exposed for the runtime monitor wired in a later patch.
        underHeapPressure: function () { return AutoLite.underHeapPressure(); },
        /* Mid-index heap pressure check. Sampled DURING the VOD/series streaming
         * index build, not at startup.
         *
         * Why a separate check: underHeapPressure() is read at boot, before the
         * search index exists, so a device with a modest heap boots looking
         * healthy, passes every startup gate, and only runs out of headroom once
         * ~200k VOD/series entries are resident. The startup gate is positioned
         * before the thing it is meant to guard against. This one samples while
         * the index is actually growing, so it can stop before the heap is gone.
         *
         * Threshold is 70%, deliberately lower than the 80% startup gate: by the
         * time this fires the index is still growing, so we need headroom left to
         * stop cleanly, finish the run, and keep the app usable. Waiting for 80%
         * mid-build risks dying before the next sample.
         *
         * Returns false when performance.memory is absent (non-Chromium, or the
         * API withheld) — an unknown heap must never trigger a degrade. */
        /* Maximum number of search-index entries this device should hold.
         *
         * WHY NOT A used/limit RATIO: the previous form of this check divided
         * usedJSHeapSize by jsHeapSizeLimit and tripped at 70%. On real WebOS
         * hardware that does not work — usedJSHeapSize is not reported honestly.
         * A device measured with 274,047 entries resident reported used=9.5MB
         * both BEFORE and AFTER indexing (delta exactly 0), i.e. the value is
         * stubbed/quantised and never moves. The ratio sat frozen at ~2.7% and
         * the guard could never fire. jsHeapSizeLimit, by contrast, IS reported
         * truthfully and consistently (347.1MB on that device across runs).
         *
         * So the budget is derived from the limit and enforced by COUNTING
         * entries, which we can measure ourselves and do not have to trust the
         * platform for.
         *
         * CALIBRATION (empirical, revised after a device run on the reference hardware).
         *
         * A 347MB WebOS 6.5 device holds **355,547 entries** (77k live + 209k
         * movies + 70k series) with NO crash — while ALSO fetching a 122MB EPG and
         * parsing 321,199 programmes in the same load. The entry cap (381,810 at
         * the time) was NEVER REACHED: series completed in full. So the device was
         * not the limit, and neither was the cap.
         *
         * 355,547 is therefore a FLOOR, not a ceiling. The budget is raised again
         * to keep probing: the cap must not be what stops the run, or we learn
         * nothing about the hardware.
         *
         * Raised to 1300/MB => ~451,230 entries on the reference device.
         *
         * History of this probe (all on the same 347MB device):
         *   908/MB  -> 315,200 cap; HIT it (halted series at 30k of 69,978)
         *   1100/MB -> 381,810 cap; NOT reached (355,547 indexed, series complete)
         *   1300/MB -> 451,230 cap; probing
         *
         * NOTE the obsolete "~380k ceiling" is NOT a target and never was: it
         * predates EPG moving to IndexedDB and counted programmes, so it was never
         * an index-entry count. The device has already exceeded it (355,547 entries
         * PLUS a 321k-programme EPG) without complaint.
         *
         * This is the ENTRY budget — a separate knob from the BYTE budget
         * (catalogByteBudget, api.js). Movies are pinned by the byte cap (truncated
         * at 66MB of a ~92MB payload), so extra entry headroom goes to series and
         * live, NOT movies. To index more MOVIES, raise the byte budget. Move one
         * knob at a time so a crash identifies which one broke it.
         *
         * If a device crashes below this budget, lower the factor — but only on
         * evidence of an ACTUAL crash, never on speculation.
         *
         * Returns 0 (= no cap) when jsHeapSizeLimit is unavailable: an unknown
         * heap must never trigger a degrade. */
        maxIndexEntries: function () {
            try {
                var mem = (typeof performance !== 'undefined') ? performance.memory : null;
                var limit = mem && mem.jsHeapSizeLimit ? mem.jsHeapSizeLimit : 0;
                if (!limit) return 0;
                var limitMb = limit / (1024 * 1024);
                return Math.floor(limitMb * 1300);
            } catch (e) { return 0; }
        },
        // Whole active profile (read-only use).
        getProfile: function () { return active; },
        /* ----- diagnostics -----
         * Lightweight heap + timing logging to pin down where large-catalog
         * loads stall or OOM on weak TVs. Gated by the app's Debug flag, so all
         * debugging is controlled from one place: it fires when the packaged
         * APP_CONFIG.DEBUG is on, OR window.PERF_DEBUG is set true at runtime
         * from the TV/browser console (window.PERF_DEBUG = true) — matching the
         * player's PLAYER_DEBUG convention, so a packaged build can be inspected
         * without a rebuild. Zero cost when off. Output is prefixed [PERFDIAG]. */
        diagEnabled: function () {
            try {
                if (typeof window !== 'undefined' && window.PERF_DEBUG) return true;
                if (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG) return true;
            } catch (e) {}
            return false;
        },
        // Return current heap use as a compact string, or '' if unavailable.
        heapStr: function () {
            try {
                var mem = (typeof performance !== 'undefined') ? performance.memory : null;
                if (!mem || !mem.usedJSHeapSize) return '';
                var used = Math.round(mem.usedJSHeapSize / 1048576);
                var lim = mem.jsHeapSizeLimit ? Math.round(mem.jsHeapSizeLimit / 1048576) : 0;
                var pct = lim ? Math.round(100 * mem.usedJSHeapSize / mem.jsHeapSizeLimit) : 0;
                return used + 'MB' + (lim ? ('/' + lim + 'MB (' + pct + '%)') : '');
            } catch (e) { return ''; }
        },
        /* Log a labelled diagnostic checkpoint with heap + a timestamp relative
         * to the first mark. No-op unless diagEnabled(). */
        mark: function (label) {
            try {
                if (!this.diagEnabled()) return;
                var now = (typeof Date !== 'undefined') ? Date.now() : 0;
                if (!this._t0) this._t0 = now;
                var dt = now - this._t0;
                var h = this.heapStr();
                if (typeof console !== 'undefined' && console.log) {
                    Log.log('[PERFDIAG] +' + dt + 'ms ' + label + (h ? ' | heap ' + h : ''));
                }
            } catch (e) {}
        },
        /* Crash-surviving breadcrumb: writes a labelled checkpoint (with heap and
         * a relative timestamp) straight to localStorage, synchronously, so it
         * survives an OOM crash/restart. Use to trace how far a boot got before
         * dying when the console isn't available (the debugger masks the crash).
         * Keeps a rolling trail of the last ~20 checkpoints under one key. Gated
         * on diagEnabled() (APP_CONFIG.DEBUG or window.PERF_DEBUG) so it's inert
         * in normal/store use — enable it only when diagnosing a device. Kept
         * cheap: one JSON string write per checkpoint. */
        breadcrumb: function (label) {
            if (!this.diagEnabled()) return;
            try {
                var now = (typeof Date !== 'undefined') ? Date.now() : 0;
                if (!this._bcT0) this._bcT0 = now;
                var dt = now - this._bcT0;
                var entry = '+' + dt + 'ms ' + label;
                var h = this.heapStr();
                if (h) entry += ' | ' + h;
                var trail = [];
                try {
                    if (typeof localStorage !== 'undefined') {
                        var raw = localStorage.getItem('xtivio.perfBreadcrumbs');
                        if (raw) trail = JSON.parse(raw);
                    }
                } catch (eRead) { trail = []; }
                if (!trail || !trail.length) {
                    // Mark the start of a fresh boot's trail so we can tell runs apart.
                    trail = [];
                }
                trail.push(entry);
                // Keep only the last 40 so it can't grow unbounded (enough to
                // span the full movies run AND the series handoff in one trail).
                if (trail.length > 40) trail = trail.slice(trail.length - 40);
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('xtivio.perfBreadcrumbs', JSON.stringify(trail));
                    }
                } catch (eWrite) {}
            } catch (e) {}
        },
        /* Read the breadcrumb trail from the PREVIOUS run (array of strings), or
         * an empty array. */
        readBreadcrumbs: function () {
            try {
                if (typeof localStorage === 'undefined') return [];
                var raw = localStorage.getItem('xtivio.perfBreadcrumbs');
                return raw ? JSON.parse(raw) : [];
            } catch (e) { return []; }
        },
        /* Start a fresh breadcrumb trail (call at the very start of a boot's VOD
         * work so the previous run's trail is preserved for reading first). */
        resetBreadcrumbs: function () {
            try {
                this._bcT0 = 0;
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('xtivio.perfBreadcrumbs', JSON.stringify([]));
                }
            } catch (e) {}
        },
        _bcT0: 0,
        _t0: 0
    };
})();
