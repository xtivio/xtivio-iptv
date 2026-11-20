/* idb.js - IndexedDB cache layer for large parsed catalogs
 *
 * Moves the biggest parsed payloads (live channels, VOD/movies, series) off of
 * localStorage, which can't hold lists of tens of thousands of items (the JSON
 * string blows the quota). Everything small (playlists, settings, favorites,
 * EPG) stays in localStorage.
 *
 * Design rules:
 *   - Never throw to callers. Every method returns a Promise that resolves
 *     (often to null) rather than rejecting on environment problems.
 *   - Degrade gracefully: if IndexedDB is missing or init fails, isReady()
 *     stays false and callers fall back to the localStorage cache in Store.
 *   - One object store per content kind ('channels', 'vod', 'series'), each
 *     keyed by playlistId and holding a single record
 *     { playlistId, items, savedAt }. The whole array is stored per playlist
 *     rather than per-item rows: callers only need bulk get/put.
 *
 * ES5 / IIFE-safe. Uses Promise, which is native on newer engines (Chromium 79 /
 * webOS 6.5+) and supplied by polyfills.js on the webOS 4 / ~Chromium 53 floor,
 * where it is not native. Do not assume Promise is always native here.
 */
var IDB = (function () {
    'use strict';

    var DB_NAME = 'xtivio-iptv';
    // Bumped when the set of object stores changes so onupgradeneeded runs and
    // creates any missing stores on existing installs.
    var DB_VERSION = 4;
    var STORE_CHANNELS = 'channels';
    var STORE_VOD = 'vod';
    var STORE_SERIES = 'series';
    var STORE_EPG = 'epg';
    // EPG freshness/lookup-map store: one record per playlist holding the light
    // lookup maps (channels/nameToId/etc.) plus a freshness stamp, the resolved
    // source-URL set, a payload fingerprint and a completeness flag. Lets a boot
    // reuse a recent parse (programmes already live in STORE_EPG) and skip the
    // fetch+parse entirely.
    var STORE_EPG_META = 'epgMeta';
    // Kind -> object store name. Callers pass a kind string; unknown kinds are
    // rejected by resolving to the safe fallback rather than throwing.
    var STORE_BY_KIND = { live: STORE_CHANNELS, vod: STORE_VOD, series: STORE_SERIES };

    var db = null;
    var ready = false;
    var recoverCbs = [];
    var initPromise = null;
    // True once a full wipe (Reset) has begun: every other write is refused so no
    // background save (guide, movies, series, channels) can start a transaction
    // that is still running when the page reloads and the next boot opens the DB.
    var wiping = false;
    // True once Reset has emptied the stores and closed our connection: init() then
    // answers false and never opens the database again, so nothing re-opens it in the
    // moments before the page reloads (an open still pending at reload leaves it busy).
    var closedForReset = false;

    /* Gated diagnostic log for the IDB open path. Silent unless APP_CONFIG.DEBUG
     * is true (config.js) OR window.__idbDebug is set at runtime from the console
     * (localStorage-independent, useful to flip on live without a rebuild). The
     * open path was previously near-silent — only the timeout case logged — so a
     * forced-Lite boot gave no clue WHICH branch fired (engine has no IDB vs
     * onblocked vs onerror vs open() threw vs timed out). Each branch now emits a
     * distinct tag. TEMPORARY: intended for diagnosing the intermittent
     * "IDB unavailable -> forced Lite" state; gate keeps it inert in real builds. */
    function idbLog() {
        try {
            var on = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG) ||
                     (typeof window !== 'undefined' && window.__idbDebug);
            if (on && window.console && console.log) {
                console.log.apply(console, arguments);
            }
        } catch (e) {}
    }

    /* The browser can refuse an open for a while right after a big wipe (its
     * storage engine is still tidying the emptied stores) and then accept it.
     * After a failed open, try again a few times with growing gaps; the first
     * success flips ready and tells the recovery listeners, same as a late open. */
    var reopenTries = 0;
    var REOPEN_GAPS = [2000, 5000, 10000, 20000];
    function scheduleReopen() {
        if (reopenTries >= REOPEN_GAPS.length) return;
        var gap = REOPEN_GAPS[reopenTries++];
        setTimeout(function () {
            if (ready || db || wiping || closedForReset) return;
            initPromise = null;
            init().then(function (ok) {
                if (!ok) return;
                reopenTries = 0;
                for (var ri = 0; ri < recoverCbs.length; ri++) {
                    try { recoverCbs[ri](); } catch (eCbr) {}
                }
            });
        }, gap);
    }

    function hasIndexedDB() {
        try {
            // TEST hook: force the IDB-unavailable path even when IndexedDB works,
            // to exercise the reduced-mode guard. Two ways to enable:
            //  - APP_CONFIG.FORCE_NO_IDB = true (edit config.js, rebuild) — deterministic.
            //  - From the console: localStorage.setItem('__forceNoIdb','1'); then
            //    reload. localStorage persists across the reload, so the flag is in
            //    place before boot calls IDB.init() (a plain window var would be
            //    wiped by the reload). Clear with localStorage.removeItem('__forceNoIdb').
            if (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.FORCE_NO_IDB) return false;
            try {
                if (typeof localStorage !== 'undefined' && localStorage.getItem('__forceNoIdb')) return false;
            } catch (eLs) {}
            return typeof indexedDB !== 'undefined' && indexedDB !== null;
        } catch (e) {
            return false;
        }
    }

    /* Open (and if needed upgrade) the database. Idempotent: repeated calls
     * return the same in-flight or settled promise. Resolves to true on a
     * usable DB, false otherwise — it never rejects. */
    function init() {
        if (closedForReset) return Promise.resolve(false);
        if (initPromise) return initPromise;

        initPromise = new Promise(function (resolve) {
            if (!hasIndexedDB()) {
                // Distinguish the reasons so a forced-Lite boot is explainable:
                // a test/force flag vs the engine genuinely lacking IndexedDB.
                var forced = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.FORCE_NO_IDB) ? 'APP_CONFIG.FORCE_NO_IDB' : '';
                var lsForced = '';
                try { lsForced = (typeof localStorage !== 'undefined' && localStorage.getItem('__forceNoIdb')) ? '__forceNoIdb(localStorage)' : ''; } catch (e) {}
                var reason = forced || lsForced || (typeof indexedDB === 'undefined' || indexedDB === null ? 'indexedDB absent in engine' : 'unknown');
                idbLog('[IDB] init: unavailable -> forced Lite. reason:', reason);
                ready = false;
                resolve(false);
                return;
            }
            idbLog('[IDB] init: opening "' + DB_NAME + '" v' + DB_VERSION + '…');
            // Guard against double-resolve and, crucially, against a hung open.
            // On some WebOS/WebKit builds indexedDB.open() can stall without ever
            // firing onsuccess/onerror/onblocked (a locked DB from a connection
            // that didn't close cleanly on the previous run). Without this, the
            // init promise would never settle and every caller awaiting IDB —
            // including the playlist load path — would hang until a full device
            // power-cycle. If the open doesn't settle quickly we give up on IDB
            // for this session and let the app proceed WITHOUT the cache (it
            // already handles a missing cache by re-fetching).
            var settled = false;
            function finish(ok) {
                if (settled) return;
                settled = true;
                ready = !!ok;
                resolve(!!ok);
            }
            var openTimer = setTimeout(function () {
                // Stall case: open() hasn't fired success/error/blocked yet. This
                // is classically a post-wipe / post-upgrade first open (onupgrade-
                // needed can legitimately take several seconds) or a DB briefly
                // locked by a prior connection. We must UNBLOCK the load path now
                // (callers awaiting IDB.init() must not hang), so we settle the
                // init promise false and let the app proceed re-fetching.
                //
                // Crucially we do NOT detach the handlers: the open usually DOES
                // complete a moment later (IDB.diagnose shows
                // "OPEN OK" right after this fires). When it does, onsuccess below
                // adopts the handle and flips ready true — and because withStore
                // re-checks ready on every call, the cache quietly comes alive
                // mid-session instead of staying dead until the next relaunch.
                // (Previously this nulled onsuccess/onerror/onblocked, which is why
                // a post-wipe launch latched cacheless for the whole session.)
                Log.log('[IDB] open slow (>8s) — proceeding without cache for now; will adopt the handle if the open still completes');
                finish(false);
            }, 8000);
            var req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                clearTimeout(openTimer);
                idbLog('[IDB] open() THREW synchronously:', (e && e.name) || '', (e && e.message) || e);
                finish(false);
                return;
            }

            req.onupgradeneeded = function (e) {
                idbLog('[IDB] onupgradeneeded — creating/upgrading stores (an upgrade is what onblocked would wait on)');
                try {
                    var d = e.target.result;
                    // Create each content-kind store if absent. Runs on fresh
                    // installs and when DB_VERSION bumps add a new store to an
                    // existing database.
                    var names = [STORE_CHANNELS, STORE_VOD, STORE_SERIES];
                    for (var i = 0; i < names.length; i++) {
                        if (!d.objectStoreNames.contains(names[i])) {
                            d.createObjectStore(names[i], { keyPath: 'playlistId' });
                        }
                    }
                    // EPG store: keyed by a composite 'playlistId\u0000channelId'
                    // string ('key' property) so each channel's programme list is
                    // a separate record, loadable on demand without holding the
                    // whole guide in memory.
                    if (!d.objectStoreNames.contains(STORE_EPG)) {
                        d.createObjectStore(STORE_EPG, { keyPath: 'key' });
                    }
                    // EPG meta store: one record per playlist (keyed by playlistId)
                    // holding the light lookup maps + freshness stamp.
                    if (!d.objectStoreNames.contains(STORE_EPG_META)) {
                        d.createObjectStore(STORE_EPG_META, { keyPath: 'playlistId' });
                    }
                } catch (upErr) {
                    // If store creation fails the open will usually error out
                    // and we resolve(false) below.
                }
            };
            req.onsuccess = function () {
                clearTimeout(openTimer);
                db = req.result;
                // If the connection is later closed by the browser (e.g.
                // version change from another tab), mark not-ready so callers
                // fall back instead of using a dead handle.
                try {
                    db.onclose = function () { ready = false; };
                    db.onversionchange = function () {
                        try { db.close(); } catch (e) {}
                        ready = false;
                    };
                } catch (e) {}
                // Adopt the handle unconditionally. If the timeout already settled
                // the init promise false (slow post-wipe open), finish(true) is a
                // no-op, so set ready here directly — otherwise db would be live
                // but ready would stay false and withStore would keep falling back.
                // This is what lets the cache come alive mid-session after a slow
                // open instead of staying dead until relaunch.
                ready = true;
                if (settled) {
                    // Timeout already unblocked the load path (slow post-wipe open);
                    // we adopted the handle late. Gated via Log like all passive logging
                    // (enable APP_CONFIG.DEBUG / window.APP_DEBUG to see this rare-race
                    // recovery).
                    Log.log('[IDB] open completed late — handle adopted, cache now active (recovered from slow open)');
                    // Notify any registered recovery listener (the app clears the
                    // idb-unavailable reduced-mode state + retracts its notice).
                    try {
                        for (var ri = 0; ri < recoverCbs.length; ri++) {
                            try { recoverCbs[ri](); } catch (eCbi) {}
                        }
                    } catch (eCb) {}
                } else {
                    idbLog('[IDB] onsuccess — DB open, cache active');
                }
                finish(true);
            };
            req.onerror = function () {
                clearTimeout(openTimer);
                var err = req && req.error;
                idbLog('[IDB] onerror — open failed:', (err && err.name) || '', (err && err.message) || '');
                finish(false);
                scheduleReopen();
            };
            req.onblocked = function () {
                // Another connection is blocking the upgrade; don't hang — proceed
                // without the cache rather than waiting on a lock that may need a
                // power-cycle to clear. If this fires repeatedly, something is
                // holding a second open connection to the same DB during boot
                // (e.g. an auto-push/sync path) — that's the smoking gun to chase.
                clearTimeout(openTimer);
                idbLog('[IDB] onBLOCKED — another open connection is blocking the upgrade (suspect a concurrent opener, e.g. sync/push, holding the DB during boot)');
                finish(false);
            };
        });

        return initPromise;
    }

    /* Internal: run a transaction op against the store for kind, resolving to
     * fallbackValue on any problem rather than rejecting. An unknown kind
     * resolves to the fallback. */
    function withStore(kind, mode, fn, fallbackValue, bypassWipe) {
        return new Promise(function (resolve) {
            var storeName = STORE_BY_KIND[kind];
            if (!ready || !db || !storeName) { resolve(fallbackValue); return; }
            if (wiping && !bypassWipe && mode === 'readwrite') { resolve(fallbackValue); return; }
            var tx, store;
            try {
                tx = db.transaction(storeName, mode);
                store = tx.objectStore(storeName);
            } catch (e) {
                resolve(fallbackValue);
                return;
            }
            var settled = false;
            var capturedVal;
            var haveVal = false;
            function settle(val) {
                if (settled) return;
                settled = true;
                clearTimeout(txTimer);
                resolve(val);
            }
            // Safety timeout: if a transaction neither completes nor errors (a
            // WebOS/WebKit stall), don't leave the promise — and every caller
            // awaiting it — pending forever. Give up and try to abort so the
            // connection isn't left with a wedged transaction.
            var txTimer = setTimeout(function () {
                try { tx.abort(); } catch (eAb) {}
                settle(haveVal ? capturedVal : fallbackValue);
            }, bypassWipe ? 60000 : 15000);
            // Resolve on transaction COMPLETION (commit), not merely when the
            // request callback fires. Resolving early and starting the next
            // transaction before this one commits can pile up overlapping
            // transactions on WebOS and wedge the connection (the "won't load
            // until power-cycle" bug). For reads we still capture the value from
            // the request callback and hand it back once the tx completes.
            tx.oncomplete = function () {
                settle(haveVal ? capturedVal : fallbackValue);
            };
            tx.onerror = function () {
                settle(haveVal ? capturedVal : fallbackValue);
            };
            tx.onabort = function () {
                settle(haveVal ? capturedVal : fallbackValue);
            };
            try {
                fn(store, function (val) {
                    capturedVal = val;
                    haveVal = true;
                    // Do NOT resolve here — wait for tx.oncomplete so the write is
                    // durable and transactions don't overlap. (For reads the value
                    // is captured and returned on completion, which is effectively
                    // immediate once the request's onsuccess has fired.)
                });
            } catch (e) {
                settle(fallbackValue);
            }
        });
    }

    /* Store the full item array for a playlist under the given content kind
     * ('live' | 'vod' | 'series'). Resolves true on success, false otherwise.
     * The record field is named items for all kinds; getItems reads either
     * items or the legacy channels field so records written by the earlier
     * channel-only layout still load. */
    // Items are stored in chunk records so a large catalog isn't written as one
    // giant structured-clone (a ~150k-object put blocked ~18s and was the real
    // OOM spike). Layout per (kind, playlistId):
    //   key "<pid>"        -> manifest { playlistId, chunkCount, total, savedAt }
    //   key "<pid>#0..N-1" -> { playlistId, items: <slice> }
    // Writes happen one chunk per transaction with a yield between them, so the
    // clone cost is spread out and the event loop breathes. Small lists still
    // write in a single chunk. Reads reassemble; deletes clear all chunks.
    /* Items per IDB chunk write. Each store.put() structure-clones the whole slice
     * synchronously on the main thread — an uninterruptible freeze. On-device
     * profiling (bg-pause probe log) showed 10000-item chunks clone in ~450-480ms
     * each, which is felt as D-pad lag even with the background-work pause gate
     * active (the gate defers the NEXT chunk, but a clone already underway cannot be
     * paused). 2500 keeps each clone around ~110-120ms on that hardware — still one
     * frame-budget-buster but a quarter of the stall, and it quadruples the yield
     * points where the pause gate and input handling can run. The read side keys off
     * the manifest's recorded chunkCount, so changing this is safe and needs no
     * migration. */
    var WRITE_CHUNK = 2500;

    function manifestKey(playlistId) { return playlistId; }
    function chunkKey(playlistId, i) { return playlistId + '#' + i; }


    function putItems(kind, playlistId, items, meta) {
        if (!playlistId || !items) return Promise.resolve(false);
        var list = items;
        var chunkCount = Math.max(1, Math.ceil(list.length / WRITE_CHUNK));
        var srcKey = (meta && meta.sourceKey) || '';
        var partial = !!(meta && meta.partial);

        // Clear any prior records, write all the CHUNKS, and only then write the
        // MANIFEST. The manifest is the commit marker: getItemsMeta/getItems key
        // off it, so writing it LAST makes the cache all-or-nothing. If the write
        // is interrupted (e.g. a language-change reload mid-parse), the chunks may
        // be partial but there's no manifest, so the read treats it as no cache and
        // refetches fresh - instead of trusting a manifest that promised N items
        // when only some chunks landed (which surfaced as "0 items" next launch).
        return deleteItems(kind, playlistId).then(function () {
            var i = 0;
            function writeNext() {
                if (i >= chunkCount) return Promise.resolve(true);
                var slice = list.slice(i * WRITE_CHUNK, (i + 1) * WRITE_CHUNK);
                var idx = i;
                return withStore(kind, 'readwrite', function (store, done) {
                    var req = store.put({ playlistId: chunkKey(playlistId, idx), items: slice });
                    req.onsuccess = function () {
                        done(true);
                    };
                    req.onerror = function () { done(false); };
                }, false).then(function () {
                    i++;
                    // Yield between chunk writes so the clone spikes stay small
                    // and the UI/other work can run between them. This boundary is
                    // AFTER the withStore transaction above has fully resolved and
                    // BEFORE the next writeNext — no IDB transaction is open here, so
                    // it is safe to pause for an arbitrary time (IDB transactions
                    // auto-commit on idle and must never be held across a pause).
                    // While a parental manager is open we defer the next chunk (and
                    // therefore the heavy structured-clone) entirely, re-checking
                    // every 150ms, then resume. The manifest is only written once all
                    // chunks land, and a chunk set without a manifest is treated as
                    // absent/partial by the reader, so a mid-way pause can't corrupt.
                    return new Promise(function (r) {
                        function nextOrWait() {
                            if (Util.shouldPauseBgWork && Util.shouldPauseBgWork()) {
                                setTimeout(nextOrWait, 150);
                            } else {
                                r(writeNext());
                            }
                        }
                        setTimeout(nextOrWait, 0);
                    });
                });
            }
            return writeNext();
        }).then(function () {
            // All chunks are in - commit the manifest.
            return withStore(kind, 'readwrite', function (store, done) {
                var req = store.put({ playlistId: manifestKey(playlistId), chunkCount: chunkCount, total: list.length, savedAt: Date.now(), sourceKey: srcKey, partial: partial });
                req.onsuccess = function () { done(true); };
                req.onerror = function () { done(false); };
            }, false);
        })['catch'](function () { return false; });
    }

    /* Read the item array for a playlist and kind by reassembling its chunks.
     * Resolves to the array, or null if absent / unavailable. Back-compatible
     * with the old single-record layout (rec.items). */
    function getItems(kind, playlistId) {
        if (!playlistId) return Promise.resolve(null);
        return withStore(kind, 'readonly', function (store, done) {
            var req = store.get(manifestKey(playlistId));
            req.onsuccess = function () {
                var rec = req.result;
                if (!rec) { done(null); return; }
                // Old layout: a single record carried the whole array directly.
                // (The rec.channels alias was never written by any shipped
                // build — removed; there is no user-data migration to preserve.)
                if (rec.items) { done(rec.items.length ? rec.items : null); return; }
                done({ __manifest: rec });
            };
            req.onerror = function () { done(null); };
        }, null).then(function (res) {
            if (!res) return null;
            if (!res.__manifest) return res; // old-layout array already resolved
            var manifest = res.__manifest;
            var count = manifest.chunkCount || 0;
            if (!count) return null;
            var out = [];
            var i = 0;
            function readNext() {
                if (i >= count) return Promise.resolve(out.length ? out : null);
                var idx = i;
                return withStore(kind, 'readonly', function (store, done) {
                    var req = store.get(chunkKey(playlistId, idx));
                    req.onsuccess = function () { done(req.result && req.result.items ? req.result.items : []); };
                    req.onerror = function () { done([]); };
                }, []).then(function (slice) {
                    for (var j = 0; j < slice.length; j++) out.push(slice[j]);
                    i++;
                    return readNext();
                });
            }
            return readNext();
        });
    }

    /* Read ONLY the manifest record for (kind, playlistId): { total, savedAt,
     * sourceKey, chunkCount }. Cheap — no chunks loaded — so the launch freshness
     * gate can decide fresh-vs-stale from one small record before committing to
     * reading the whole slim catalog. Resolves null if absent or the old
     * single-record layout (no manifest), which the gate treats as a cache miss. */
    function getItemsMeta(kind, playlistId) {
        if (!playlistId) return Promise.resolve(null);
        return withStore(kind, 'readonly', function (store, done) {
            var req = store.get(manifestKey(playlistId));
            req.onsuccess = function () {
                var rec = req.result;
                if (!rec || rec.items) { done(null); return; } // absent or old-layout array
                done({ total: rec.total || 0, savedAt: rec.savedAt || 0, sourceKey: rec.sourceKey || '', chunkCount: rec.chunkCount || 0, partial: !!rec.partial });
            };
            req.onerror = function () { done(null); };
        }, null);
    }

    function deleteItems(kind, playlistId) {
        if (!playlistId) return Promise.resolve(false);
        // Read the manifest to learn how many chunks exist, then delete manifest
        // + all chunks. Also handles the old single-record layout (delete by pid).
        return withStore(kind, 'readonly', function (store, done) {
            var req = store.get(manifestKey(playlistId));
            req.onsuccess = function () { done(req.result || null); };
            req.onerror = function () { done(null); };
        }, null).then(function (rec) {
            var count = (rec && rec.chunkCount) ? rec.chunkCount : 0;
            return withStore(kind, 'readwrite', function (store, done) {
                try { store['delete'](manifestKey(playlistId)); } catch (e) {}
                for (var i = 0; i < count; i++) {
                    try { store['delete'](chunkKey(playlistId, i)); } catch (e2) {}
                }
                done(true);
            }, false);
        });
    }

    function clearKind(kind) {
        return withStore(kind, 'readwrite', function (store, done) {
            var req = store.clear();
            req.onsuccess = function () { done(true); };
            req.onerror = function () { done(false); };
        }, false, true);
    }

    /* Delete a playlist's records across all content kinds in one call.
     * Resolves true once all deletes settle (individual failures are ignored —
     * a best-effort clear must never reject). */
    function deleteAllKinds(playlistId) {
        return Promise.all([
            deleteItems('live', playlistId),
            deleteItems('vod', playlistId),
            deleteItems('series', playlistId)
        ]).then(function () { return true; })['catch'](function () { return true; });
    }

    // Empty the guide stores (programme lists and the freshness/maps records).
    function clearEpgStores() {
        return Promise.all([
            epgWithStore('readwrite', function (store, done) {
                var req = store.clear();
                req.onsuccess = function () { done(true); };
                req.onerror = function () { done(false); };
            }, false, true),
            epgMetaWithStore('readwrite', function (store, done) {
                var req = store.clear();
                req.onsuccess = function () { done(true); };
                req.onerror = function () { done(false); };
            }, false, true)
        ]).then(function () { return true; })['catch'](function () { return true; });
    }

    function clearAllKinds() {
        return Promise.all([
            clearKind('live'), clearKind('vod'), clearKind('series'), clearEpgStores()
        ]).then(function () { return true; })['catch'](function () { return true; });
    }

    // Live-kind convenience wrappers. The live-channel cache (store.js) calls
    // these names; keeping them avoids churn in that caller.
    function putChannels(playlistId, channels) { return putItems('live', playlistId, channels); }
    function getChannels(playlistId) { return getItems('live', playlistId); }
    function deleteChannels(playlistId) { return deleteItems('live', playlistId); }
    function clearChannels() { return clearKind('live'); }

    // ---- EPG per-channel storage ------------------------------------------
    // Programme lists are stored one record per channel so the guide can load a
    // single channel on demand instead of holding ~all programmes in memory.
    function epgKey(playlistId, channelId) { return playlistId + '\u0000' + channelId; }

    function epgWithStore(mode, fn, fallbackValue, bypassWipe) {
        return new Promise(function (resolve) {
            if (!ready || !db || !db.objectStoreNames.contains(STORE_EPG)) { resolve(fallbackValue); return; }
            if (wiping && !bypassWipe && mode === 'readwrite') { resolve(fallbackValue); return; }
            var tx, store;
            try { tx = db.transaction(STORE_EPG, mode); store = tx.objectStore(STORE_EPG); }
            catch (e) { resolve(fallbackValue); return; }
            var settled = false, capturedVal, haveVal = false;
            function settle(v) { if (settled) return; settled = true; clearTimeout(t); resolve(v); }
            var t = setTimeout(function () { try { tx.abort(); } catch (e) {} settle(haveVal ? capturedVal : fallbackValue); }, bypassWipe ? 60000 : 15000);
            tx.oncomplete = function () { settle(haveVal ? capturedVal : fallbackValue); };
            tx.onerror = function () { settle(haveVal ? capturedVal : fallbackValue); };
            tx.onabort = function () { settle(haveVal ? capturedVal : fallbackValue); };
            try { fn(store, function (v) { capturedVal = v; haveVal = true; }); }
            catch (e) { settle(fallbackValue); }
        });
    }

    // Write many channels' programme lists in chunks (one record per channel),
    // clearing this playlist's prior EPG records first. progByChannel is a plain
    // object: channelId -> array of {start,stop,title}. Resolves true/false.
    function epgPutAll(playlistId, progByChannel) {
        if (!playlistId) return Promise.resolve(false);
        return init().then(function () {
            // init() settles false once when the first open is slow and stays false even though
            // the handle is adopted a moment later; the ready flag is the live state.
            if (!ready) return false;
            return epgClearPlaylist(playlistId).then(function () {
                var keys = [];
                for (var ch in progByChannel) { if (progByChannel.hasOwnProperty(ch)) keys.push(ch); }
                var CHUNK = 400; // channels per transaction
                var i = 0;
                function writeChunk() {
                    if (i >= keys.length) return Promise.resolve(true);
                    var iBefore = i;
                    return epgWithStore('readwrite', function (store, done) {
                        var end = Math.min(i + CHUNK, keys.length);
                        for (; i < end; i++) {
                            var ch = keys[i];
                            store.put({ key: epgKey(playlistId, ch), playlistId: playlistId, channelId: ch, list: progByChannel[ch] });
                        }
                        done(true);
                    }, false).then(function () {
                        return new Promise(function (r) { setTimeout(r, 0); });
                    }).then(function () {
                        // The chunk never ran (writes refused during a wipe, or the
                        // store went away): stop instead of retrying it forever.
                        if (i === iBefore) return false;
                        return writeChunk();
                    });
                }
                return writeChunk();
            });
        })['catch'](function () { return false; });
    }

    function epgGetChannel(playlistId, channelId) {
        if (!playlistId || !channelId) return Promise.resolve(null);
        return init().then(function () {
            // init() settles false once when the first open is slow and stays false even though
            // the handle is adopted a moment later; the ready flag is the live state.
            if (!ready) return null;
            return epgWithStore('readonly', function (store, done) {
                var req = store.get(epgKey(playlistId, channelId));
                req.onsuccess = function () { done(req.result && req.result.list ? req.result.list : null); };
                req.onerror = function () { done(null); };
            }, null);
        })['catch'](function () { return null; });
    }

    // Delete all EPG records for a playlist (cursor over the key range).
    function epgClearPlaylist(playlistId) {
        if (!playlistId) return Promise.resolve(false);
        return epgWithStore('readwrite', function (store, done) {
            var lower = playlistId + '\u0000';
            var upper = playlistId + '\u0000\uffff';
            var range;
            try { range = IDBKeyRange.bound(lower, upper); } catch (e) { done(false); return; }
            var req = store.openCursor(range);
            req.onsuccess = function () {
                var cur = req.result;
                if (cur) { cur['delete'](); cur['continue'](); }
                else done(true);
            };
            req.onerror = function () { done(false); };
        }, false);
    }

    // ---- EPG meta (freshness record + light lookup maps) -------------------
    // One record per playlist in STORE_EPG_META. The record shape is opaque to
    // this layer: epg.js decides what goes in it (parsedAt, sourceUrls,
    // fingerprint, complete flag, and the light maps). Stored as plain JSON.
    function epgMetaWithStore(mode, fn, fallbackValue, bypassWipe) {
        return new Promise(function (resolve) {
            if (!ready || !db || !db.objectStoreNames.contains(STORE_EPG_META)) { resolve(fallbackValue); return; }
            if (wiping && !bypassWipe && mode === 'readwrite') { resolve(fallbackValue); return; }
            var tx, store;
            try { tx = db.transaction(STORE_EPG_META, mode); store = tx.objectStore(STORE_EPG_META); }
            catch (e) { resolve(fallbackValue); return; }
            var settled = false, capturedVal, haveVal = false;
            function settle(v) { if (settled) return; settled = true; clearTimeout(t); resolve(v); }
            var t = setTimeout(function () { try { tx.abort(); } catch (e) {} settle(haveVal ? capturedVal : fallbackValue); }, bypassWipe ? 60000 : 15000);
            tx.oncomplete = function () { settle(haveVal ? capturedVal : fallbackValue); };
            tx.onerror = function () { settle(haveVal ? capturedVal : fallbackValue); };
            tx.onabort = function () { settle(haveVal ? capturedVal : fallbackValue); };
            try { fn(store, function (v) { capturedVal = v; haveVal = true; }); }
            catch (e) { settle(fallbackValue); }
        });
    }

    // Read the meta record for a playlist. Resolves to the stored object or null.
    function epgMetaGet(playlistId) {
        if (!playlistId) return Promise.resolve(null);
        return init().then(function () {
            // init() settles false once when the first open is slow and stays false even though
            // the handle is adopted a moment later; the ready flag is the live state.
            if (!ready) return null;
            return epgMetaWithStore('readonly', function (store, done) {
                var req = store.get(playlistId);
                req.onsuccess = function () { done(req.result || null); };
                req.onerror = function () { done(null); };
            }, null);
        })['catch'](function () { return null; });
    }

    // Write (replace) the meta record for a playlist. rec must be a plain,
    // JSON-safe object; playlistId is stamped onto it as the keyPath.
    function epgMetaPut(playlistId, rec) {
        if (!playlistId || !rec) return Promise.resolve(false);
        return init().then(function () {
            // init() settles false once when the first open is slow and stays false even though
            // the handle is adopted a moment later; the ready flag is the live state.
            if (!ready) return false;
            rec.playlistId = playlistId;
            return epgMetaWithStore('readwrite', function (store, done) {
                var req = store.put(rec);
                req.onsuccess = function () { done(true); };
                req.onerror = function () { done(false); };
            }, false);
        })['catch'](function () { return false; });
    }

    // Delete the meta record for a playlist (used when its EPG is cleared).
    function epgMetaDelete(playlistId) {
        if (!playlistId) return Promise.resolve(false);
        return init().then(function () {
            // init() settles false once when the first open is slow and stays false even though
            // the handle is adopted a moment later; the ready flag is the live state.
            if (!ready) return false;
            return epgMetaWithStore('readwrite', function (store, done) {
                var req = store['delete'](playlistId);
                req.onsuccess = function () { done(true); };
                req.onerror = function () { done(false); };
            }, false);
        })['catch'](function () { return false; });
    }

    // Close the DB connection and reset state so the next init() reopens fresh.
    // Called when the app is backgrounded/hidden: WebOS keeps the webview process
    // warm, so an unclosed connection can linger and block the next open (the
    // "won't load until power-cycle" lock). Closing on hide releases it cleanly.
    /* Full wipe for Reset: refuse every other write from now on, empty all the
     * stores (transactions already running finish first, in order), then close
     * our connection so the page that reloads next finds the DB idle and opens it
     * fast. Never rejects. */
    function wipeAll() {
        wiping = true;
        return init().then(function () {
            if (!ready) return true;
            return clearAllKinds();
        }).then(function () {
            close();
            closedForReset = true;
            return true;
        })['catch'](function () { try { close(); } catch (e) {} closedForReset = true; return true; });
    }

    function close() {
        try { if (db) db.close(); } catch (e) {}
        db = null;
        ready = false;
        initPromise = null;
    }

    /* On-demand diagnostic probe. Call IDB.diagnose() from the Web Inspector
     * console WHEN THE APP IS IN THE STUCK "forced Lite" STATE to interrogate the
     * live cause without a rebuild or reinstall. It reports current module state
     * and then attempts a SEPARATE open (not touching the module's own handle) so
     * you can see, right now, whether the open succeeds, errors, is blocked, or
     * stalls. Distinguishes: engine-has-no-IDB vs force-flag vs blocked (a second
     * connection is holding the DB) vs a hard error. Always logs (ungated) since
     * it's explicitly user-invoked. Returns a Promise resolving to a summary. */
    function diagnose() {
        var out = {
            hasIndexedDB: hasIndexedDB(),
            moduleReady: ready,
            moduleHasHandle: !!db,
            forceNoIdbConfig: !!(typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.FORCE_NO_IDB),
            forceNoIdbLs: false,
            engineHasIndexedDB: !(typeof indexedDB === 'undefined' || indexedDB === null),
            probe: 'pending'
        };
        try { out.forceNoIdbLs = !!(typeof localStorage !== 'undefined' && localStorage.getItem('__forceNoIdb')); } catch (e) {}
        console.log('[IDB.diagnose] state:', JSON.stringify(out));
        return new Promise(function (resolve) {
            if (!out.engineHasIndexedDB) {
                out.probe = 'engine-has-no-indexedDB';
                console.log('[IDB.diagnose] ' + out.probe);
                resolve(out); return;
            }
            var done = false;
            function fin(r) { if (done) return; done = true; out.probe = r; console.log('[IDB.diagnose] probe result:', r); resolve(out); }
            var timer = setTimeout(function () { fin('STALLED (no event in 5s — locked DB, needs power-cycle)'); }, 5000);
            var r;
            try { r = indexedDB.open(DB_NAME, DB_VERSION); }
            catch (e) { clearTimeout(timer); fin('open() threw: ' + ((e && e.name) || e)); return; }
            r.onsuccess = function () { clearTimeout(timer); try { r.result.close(); } catch (e) {} fin('OPEN OK (no lock right now)'); };
            r.onerror = function () { clearTimeout(timer); fin('onerror: ' + ((r.error && r.error.name) || '')); };
            r.onblocked = function () { clearTimeout(timer); fin('BLOCKED (another open connection is holding the DB)'); };
        });
    }

    return {
        init: init,
        close: close,
        diagnose: diagnose,
        isReady: function () { return ready; },
        onLateRecover: function (cb) { if (typeof cb === 'function') recoverCbs.push(cb); },
        isSupported: hasIndexedDB,
        putItems: putItems,
        getItems: getItems,
        getItemsMeta: getItemsMeta,
        deleteItems: deleteItems,
        clearKind: clearKind,
        deleteAllKinds: deleteAllKinds,
        clearAllKinds: clearAllKinds,
        wipeAll: wipeAll,
        putChannels: putChannels,
        getChannels: getChannels,
        deleteChannels: deleteChannels,
        clearChannels: clearChannels,
        epgPutAll: epgPutAll,
        epgGetChannel: epgGetChannel,
        epgClearPlaylist: epgClearPlaylist,
        epgMetaGet: epgMetaGet,
        epgMetaPut: epgMetaPut,
        epgMetaDelete: epgMetaDelete
    };
})();
