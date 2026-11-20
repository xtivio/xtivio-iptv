/**
 * CloudSync — Firebase Auth + Realtime Database sync
 * Syncs favorites, playlists, settings, and watch history across devices.
 * Uses Firebase Email/Password Auth. An account (email + password) is required
 * to enable cloud sync.
 * 
 * Usage:
 *   CloudSync.init()           — initialize Firebase
 *   CloudSync.signInEmail(e,p) — sign in with email/password
 *   CloudSync.signUp(e,p)      — create account
 *   CloudSync.signOut()        — sign out
 *   CloudSync.push()           — push local data to cloud
 *   CloudSync.pull()           — pull cloud data to local
 *   CloudSync.isSignedIn()     — check auth state
 *   CloudSync.getUserId()      — get current user ID
 */
var CloudSync = (function () {
    'use strict';

    var firebase = null;
    var db = null;
    var auth = null;
    var currentUser = null;
    var initialized = false;
    /* Set true during init when the packaged INSTALL_TOKEN doesn't match the
     * token stored on this device — i.e. a fresh install or an app update. In
     * that case any auth session the Firebase SDK restores from the (possibly
     * surviving) web storage partition must NOT be honoured: we sign out before
     * treating the user as signed in, so a fresh install starts clean. */
    var freshInstall = false;
    /* Pending callbacks waiting for late init. When
     * CloudSync.init is called before the Firebase SDK chain has
     * finished loading, init defers (returns without setting
     * initialized=true) and registers a one-shot retry on the
     * 'firebase-ready' event. Methods that need an initialized state
     * (signInWithCustomToken, signInEmail, etc.) check initialized
     * and reject if it's still false after the retry window. */
    var initDeferred = false;

    function _doInit() {
        if (initialized) return true;
        if (!APP_CONFIG.FIREBASE || !APP_CONFIG.FIREBASE.enabled) return false;
        try {
            if (typeof window.firebase === 'undefined' || typeof window.firebase.database !== 'function') {
                // Firebase SDK not fully loaded yet — caller should retry.
                return false;
            }
            firebase = window.firebase;
            if (!firebase.apps || !firebase.apps.length) {
                firebase.initializeApp(APP_CONFIG.FIREBASE);
            }
            auth = firebase.auth();
            db = firebase.database();
            initialized = true;

            /* Fresh-install detection + auth-store reset.
             *
             * Root cause of "reinstall comes up already signed in": Firebase
             * Auth (compat) persists the session in an IndexedDB database
             * (firebaseLocalStorageDb). On this platform a reinstall clears
             * localStorage but NOT IndexedDB, so the session survives even
             * though nothing else does — older builds stored auth in
             * localStorage and therefore started signed out after a reinstall.
             *
             * We restore the old behaviour by using a localStorage marker as
             * the install discriminator (localStorage is what the platform
             * wipes on reinstall): if our marker is absent, this is a fresh
             * install (or first run), so we delete Firebase's auth IndexedDB
             * BEFORE the SDK restores a session from it, then write the marker.
             * A normal restart keeps both the marker and the session untouched.
             *
             * The INSTALL_TOKEN (baked per build) is written into the same
             * marker so an app update also resets — but absence of the marker
             * is the primary, platform-backed signal and is what fixes the
             * same-build reinstall case. */
            try {
                var bundleTok = (APP_CONFIG && APP_CONFIG.INSTALL_TOKEN) || 'x';
                var storedTok = '';
                try { storedTok = window.localStorage.getItem('xtivioInstallToken') || ''; } catch (eLs) {}
                if (bundleTok !== storedTok) {
                    freshInstall = true;
                    Util.log('CloudSync: fresh install/update — clearing any auth session persisted from a previous install');
                    // Best-effort delete of Firebase's auth IndexedDB so a
                    // session from a previous install can't be restored. If the
                    // DB doesn't exist this is a harmless no-op.
                    try {
                        if (typeof window.indexedDB !== 'undefined' && window.indexedDB && window.indexedDB.deleteDatabase) {
                            window.indexedDB.deleteDatabase('firebaseLocalStorageDb');
                        }
                    } catch (eIdb) {}
                    try { window.localStorage.setItem('xtivioInstallToken', bundleTok); } catch (eLs2) {}
                }
            } catch (eTok) {}

            auth.onAuthStateChanged(function (user) {
                /* Belt-and-suspenders: if the IDB delete above raced with the
                 * SDK and a session was still restored on a fresh install,
                 * sign it out through the supported path. One-shot. */
                if (freshInstall && user) {
                    freshInstall = false;
                    currentUser = null;
                    Util.log('CloudSync: dropping restored session from previous install');
                    try {
                        auth.signOut()['catch'](function (eSo) {
                            Util.logErr('CloudSync: fresh-install signOut failed', eSo);
                        });
                    } catch (eSo2) {}
                    try {
                        document.dispatchEvent(new CustomEvent('cloudsync-auth-changed', { detail: { signedIn: false, email: null } }));
                    } catch (eEv) {
                        var ev0 = document.createEvent('Event');
                        ev0.initEvent('cloudsync-auth-changed', true, true);
                        document.dispatchEvent(ev0);
                    }
                    return;
                }
                freshInstall = false;
                currentUser = user;
                if (user) {
                    Util.log('CloudSync: signed in as ' + (user.email || 'unknown') + ' uid=' + user.uid);
                    /* Credential encryption is ZKSync's job (see push()). The old
                     * Crypto.init()/isReady() obfuscation layer has been removed;
                     * nothing to derive here. */
                } else {
                    Util.log('CloudSync: signed out');
                }
                /* Dispatch a document-level event so
                 * UI surfaces outside the Settings screen (e.g. corner
                 * badges, sidebar indicators) can refresh in response
                 * to any sign-in / sign-out, regardless of which flow
                 * triggered it. */
                try {
                    document.dispatchEvent(new CustomEvent('cloudsync-auth-changed', { detail: { signedIn: !!user, email: user ? user.email : null } }));
                } catch (e) {
                    var ev = document.createEvent('Event');
                    ev.initEvent('cloudsync-auth-changed', true, true);
                    document.dispatchEvent(ev);
                }
            });

            Util.log('CloudSync: initialized');
            return true;
        } catch (e) {
            Util.logErr('CloudSync init failed', e);
            return false;
        }
    }

    function init() {
        if (initialized) return;
        if (!APP_CONFIG.FIREBASE || !APP_CONFIG.FIREBASE.enabled) return;
        // First attempt — synchronous. Most of the time the SDK is
        // already loaded by the time this runs and we're done.
        if (_doInit()) return;
        // Deferred path: wait for the loader chain to signal completion.
        if (initDeferred) return; // already waiting
        initDeferred = true;
        Util.log('CloudSync: Firebase SDK not ready, deferring init');

        // Check if the flag is already true (loader finished AFTER we
        // checked window.firebase but BEFORE we got to add the listener).
        if (window.__firebaseReady) {
            _doInit();
            return;
        }
        // Listen for the loader's completion event.
        document.addEventListener('firebase-ready', function onReady() {
            document.removeEventListener('firebase-ready', onReady);
            _doInit();
        });
        // Safety net: also poll for up to 10 seconds in case the event
        // missed for some reason (very old engine, script-cache quirks).
        var pollCount = 0;
        var pollTimer = setInterval(function () {
            if (initialized) { clearInterval(pollTimer); return; }
            if (window.__firebaseReady || (typeof window.firebase !== 'undefined' && typeof window.firebase.database === 'function')) {
                clearInterval(pollTimer);
                _doInit();
                return;
            }
            pollCount++;
            if (pollCount > 50) { // 50 * 200ms = 10s
                clearInterval(pollTimer);
                Util.logErr('CloudSync: Firebase SDK never loaded after 10s');
            }
        }, 200);
    }

    /* Merge cloud favorites into local, honouring per-key add/remove timestamps and
     * tombstones so removals sync too (not just adds). For each favorite key, the
     * newest ADD (addedAt) competes with the newest REMOVE (removedAt) from either
     * side's tombstones; later wins. Tombstones are unioned (newest per key) and
     * pruned (drop any older than 90 days, then cap 200) so they can't grow forever. */
    /* Merge cloud playlists into local with newest-wins per playlist. For each id,
     * keep whichever copy (local vs cloud) has the newer updatedAt. A deletion
     * tombstone (from either side) removes the playlist if its deletedAt is newer
     * than that playlist's updatedAt — so an edit made after a delete still wins, and
     * a delete made after the last edit still removes it. Tombstones are unioned,
     * pruned (>90 days) and capped (200). The cloud playlist objects passed in have
     * already had their secret fields (creds) reconstructed by the caller. */
    function mergePlaylists(cloudPls, cloudTombs) {
        var localPls = Store.getPlaylists();
        var localTombs = Store.getPlaylistTombstones ? Store.getPlaylistTombstones() : [];
        var TOMB_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
        var now = Date.now();

        // Newest deletion time per id (union of both tombstone lists).
        var deletedAt = {};
        function collectTomb(list) {
            for (var i = 0; i < list.length; i++) {
                var t = list[i]; if (!t || t.id == null) continue;
                var d = t.deletedAt || 0;
                if (!deletedAt[t.id] || d > deletedAt[t.id]) deletedAt[t.id] = d;
            }
        }
        collectTomb(localTombs); collectTomb(cloudTombs);

        // Newest playlist record per id from both sides (by updatedAt).
        var byId = {};
        function collect(list) {
            for (var i = 0; i < list.length; i++) {
                var p = list[i]; if (!p || p.id == null) continue;
                var u = p.updatedAt || 0;
                var prev = byId[p.id];
                if (!prev || u > (prev.updatedAt || 0)) byId[p.id] = p;
            }
        }
        collect(localPls); collect(cloudPls);

        // Keep a playlist iff it exists and its newest edit is at least as new as its
        // newest deletion.
        var merged = [];
        var id;
        for (id in byId) {
            if (!byId.hasOwnProperty(id)) continue;
            var uT = byId[id].updatedAt || 0;
            var dT = deletedAt[id] || 0;
            if (uT >= dT) merged.push(byId[id]);
        }

        // Rebuild tombstones: keep deletions still in effect (newer than the surviving
        // record's updatedAt), drop aged-out, cap.
        var mergedTombs = [];
        for (id in deletedAt) {
            if (!deletedAt.hasOwnProperty(id)) continue;
            var dt = deletedAt[id];
            var ut = byId[id] ? (byId[id].updatedAt || 0) : 0;
            if (dt > ut && (now - dt) < TOMB_MAX_AGE) {
                mergedTombs.push({ id: id, deletedAt: dt });
            }
        }
        mergedTombs.sort(function (a, b) { return b.deletedAt - a.deletedAt; });
        if (mergedTombs.length > 200) mergedTombs = mergedTombs.slice(0, 200);

        Store.setPlaylists(merged);
        if (Store.setPlaylistTombstones) Store.setPlaylistTombstones(mergedTombs);
    }

    /* ---- Credential-free synced copies of favorites / history / recents ----
     * These entries carry the full stream URL, which for Xtream embeds the playlist login.
     * The cloud copy swaps the login for placeholders (Util.redactStreamCreds) and a
     * device that pulls swaps in its OWN playlist's login, so a card plays without anything
     * being re-entered once the playlist itself has its credentials. Merging happens in the
     * placeholder ("canonical") form so the same item matches across devices whatever
     * login each one holds. */
    var FAV_KEY_SEP = '::';
    function playlistById(id) {
        if (id == null || id === '') return null;
        var l = Store.getPlaylists() || [];
        for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i];
        return null;
    }
    function mapUrlFields(e, pl, fn) {
        if (!e || typeof e !== 'object') return e;
        var c = JSON.parse(JSON.stringify(e));
        var fields = ['url', 'fallbackUrl', 'key'];
        for (var i = 0; i < fields.length; i++) {
            if (typeof c[fields[i]] === 'string' && c[fields[i]]) c[fields[i]] = fn(c[fields[i]], pl);
        }
        return c;
    }
    function redactEntry(e) { return mapUrlFields(e, playlistById(e && e.playlistId), Util.redactStreamCreds); }
    function expandEntry(e) { return mapUrlFields(e, playlistById(e && e.playlistId), Util.expandStreamCreds); }
    function tombPlaylist(t) {
        var k = t && typeof t.key === 'string' ? t.key : '', ix = k.indexOf(FAV_KEY_SEP);
        return ix > 0 ? playlistById(k.substring(0, ix)) : null;
    }
    function redactTomb(t) { var c = { key: t.key, removedAt: t.removedAt }; c.key = Util.redactStreamCreds(String(t.key), tombPlaylist(t)); return c; }
    function expandTomb(t) { return { key: Util.expandStreamCreds(String(t.key), tombPlaylist(t)), removedAt: t.removedAt }; }
    function mapList(list, fn) { var out = []; for (var i = 0; list && i < list.length; i++) if (list[i]) out.push(fn(list[i])); return out; }

    /* Newest-wins merge of two history-style lists (vod history / recent channels) keyed by
     * playlist + id (or url), newest by timestamp field; returns newest-first, capped. */
    function mergeRecentLists(cloudList, localList, tsField, max) {
        var best = {}, order = [];
        function take(list) {
            for (var i = 0; list && i < list.length; i++) {
                var e = list[i]; if (!e) continue;
                var k = (e.playlistId || '') + '\u0001' + (e.id != null && e.id !== '' ? e.id : (e.url || ''));
                var t = e[tsField] || 0;
                if (!best[k]) { best[k] = e; order.push(k); }
                else if (t > (best[k][tsField] || 0)) best[k] = e;
            }
        }
        take(mapList(localList, redactEntry)); take(mapList(cloudList, redactEntry));
        var out = [];
        for (var j = 0; j < order.length; j++) out.push(best[order[j]]);
        out.sort(function (a, b) { return (b[tsField] || 0) - (a[tsField] || 0); });
        if (out.length > max) out = out.slice(0, max);
        return mapList(out, expandEntry);
    }

    /* Fill in placeholders that could not be filled when they arrived (the playlist had no
     * credentials yet). Runs after every pull and whenever the playlists change. */
    function refreshCreds() {
        var changed = false;
        function fixList(list, getter, setter, fn) {
            var arr = getter() || [], out = [], any = false;
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i], needs = false;
                if (e && typeof e === 'object') {
                    needs = Util.hasCredPlaceholder(e.url) || Util.hasCredPlaceholder(e.key) || Util.hasCredPlaceholder(e.fallbackUrl);
                }
                if (needs) { var f = fn(e); if (JSON.stringify(f) !== JSON.stringify(e)) { any = true; e = f; } }
                out.push(e);
            }
            if (any) { setter(out); changed = true; }
        }
        try {
            fixList(null, function () { return Store.getFavorites(); }, function (v) { Store.setFavorites(v); }, expandEntry);
            fixList(null, function () { return Store.getFavTombstones(); }, function (v) { Store.setFavTombstones(v); }, expandTomb);
            fixList(null, function () { return Store.getVodHistory(); }, function (v) { Store.raw.set('vodHistory', v); }, expandEntry);
            fixList(null, function () { return Store.getRecentChannels(); }, function (v) { Store.raw.set('recentChannels', v); }, expandEntry);
        } catch (e) { Util.logErr('CloudSync refreshCreds', e); }
        return changed;
    }

    function mergeFavorites(cloudFavs, cloudTombs) {
        // Cloud data from a device still on an older build has bare keys; scope them
        // by their playlistId so they line up with this device's per-playlist keys.
        if (Store.migrateFavorites) Store.migrateFavorites(cloudFavs);
        // Work in the credential-free (placeholder) form so a favorite matches across
        // devices whatever login each holds; expanded back to this device's login on save.
        cloudFavs = mapList(cloudFavs, redactEntry);
        cloudTombs = mapList(cloudTombs, redactTomb);
        var localFavs = mapList(Store.getFavorites(), redactEntry);
        var localTombs = mapList(Store.getFavTombstones(), redactTomb);
        var TOMB_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days
        var now = Date.now();

        // Newest removal time per key (union of both tombstone lists).
        var removedAt = {};
        function collectTomb(list) {
            for (var i = 0; i < list.length; i++) {
                var t = list[i]; if (!t || t.key == null) continue;
                var r = t.removedAt || 0;
                if (!removedAt[t.key] || r > removedAt[t.key]) removedAt[t.key] = r;
            }
        }
        collectTomb(localTombs); collectTomb(cloudTombs);

        // Newest add (full record) per key from both sides.
        var addByKey = {};
        function collectAdd(list) {
            for (var i = 0; i < list.length; i++) {
                var f = list[i]; if (!f || f.key == null) continue;
                var a = f.addedAt || 0;
                var prev = addByKey[f.key];
                if (!prev || a > (prev.addedAt || 0)) addByKey[f.key] = f;
            }
        }
        collectAdd(localFavs); collectAdd(cloudFavs);

        // A key is favorited iff its newest add is newer than its newest removal.
        var mergedFavs = [];
        var key;
        for (key in addByKey) {
            if (!addByKey.hasOwnProperty(key)) continue;
            var addT = addByKey[key].addedAt || 0;
            var remT = removedAt[key] || 0;
            // Favorited iff the newest add is at least as new as the newest removal.
            if (addT >= remT) mergedFavs.push(addByKey[key]);
        }
        // Preserve a stable order: sort by addedAt ascending (oldest first), like a
        // list built up over time.
        mergedFavs.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });

        // Rebuild the tombstone list: keep only removals still in effect (newer than
        // that key's newest add), drop the aged-out ones, cap the count.
        var mergedTombs = [];
        for (key in removedAt) {
            if (!removedAt.hasOwnProperty(key)) continue;
            var rt = removedAt[key];
            var at = addByKey[key] ? (addByKey[key].addedAt || 0) : 0;
            if (rt > at && (now - rt) < TOMB_MAX_AGE) {
                mergedTombs.push({ key: key, removedAt: rt });
            }
        }
        mergedTombs.sort(function (a, b) { return b.removedAt - a.removedAt; });
        if (mergedTombs.length > 200) mergedTombs = mergedTombs.slice(0, 200);

        Store.setFavorites(mapList(mergedFavs, expandEntry));
        Store.setFavTombstones(mapList(mergedTombs, expandTomb));
    }

    function isSignedIn() { return !!currentUser; }
    function getUserId() { return currentUser ? currentUser.uid : null; }
    function getUserEmail() { return currentUser ? (currentUser.email || null) : null; }

    function signInEmail(email, password) {
        if (!auth) return Promise.reject('Not initialized');
        return auth.signInWithEmailAndPassword(email, password);
    }

    function signUp(email, password) {
        if (!auth) return Promise.reject('Not initialized');
        /* Previously the TV signup just called
         * createUserWithEmailAndPassword and stopped. The pairing
         * server's signup flow also calls sendEmailVerification on
         * the new account. Parity: do the same here so a user who
         * creates their account on the TV gets the verification
         * email just like one who creates it via the web pairing
         * page.
         *
         * If the verification email send fails (network, quota, etc)
         * we still return success for the account creation itself —
         * the user can retry verification later or sign in without
         * verifying. Logged but not surfaced. */
        return auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
            if (cred && cred.user && cred.user.sendEmailVerification) {
                cred.user.sendEmailVerification()['catch'](function (e) {
                    if (window.console) {
                        Log.warn('sendEmailVerification failed (account still created):', e && e.message);
                    }
                });
            }
            return cred;
        });
    }

    // Sign in with a custom token minted by the pairing
    // server. The token is short-lived (1 hour by default) and consumed
    // once — the resulting Firebase session lasts as long as a normal
    // email/password sign-in. Used by the pairing flow when the user has
    // signed into Firebase from their phone/PC and wants to hand the
    // session to the TV.
    /* whenReady() returns a Promise that resolves once
     * CloudSync.initialized is true. Used by code paths that may arrive
     * before the Firebase SDK has finished loading — most notably the
     * pairing sign-in flow, where the TV polls the pairing server and
     * receives a custom token within the first few seconds of app
     * startup. Without this, signInWithCustomToken used to reject with
     * "Not initialized" if it ran during the SDK-load window. */
    function whenReady() {
        return new Promise(function (resolve, reject) {
            if (initialized) return resolve();
            init(); // make sure the deferred-init path is engaged
            var attempts = 0;
            var poll = setInterval(function () {
                if (initialized) {
                    clearInterval(poll);
                    resolve();
                    return;
                }
                attempts++;
                if (attempts > 50) { // 50 * 200ms = 10s
                    clearInterval(poll);
                    reject(new Error('CloudSync did not initialize within 10s'));
                }
            }, 200);
        });
    }

    function signInWithCustomToken(token) {
        if (!token || typeof token !== 'string') return Promise.reject('token required');
        // Wait for CloudSync to finish initializing
        // before attempting sign-in. The pairing flow can call this
        // within the first few seconds of app startup, before Firebase
        // SDK has finished loading from gstatic.
        return whenReady().then(function () {
            return auth.signInWithCustomToken(token);
        });
    }

    function signOut() {
        if (!auth) return Promise.reject('Not initialized');
        currentUser = null;
        return auth.signOut();
    }

    // Push local data to Firebase
    function push() {
        if (!db || !currentUser) return Promise.reject('Not signed in');
        var uid = currentUser.uid;

        /* Force a Firebase ID token refresh before push,
         * AND surface the real Firebase error message in console if the
         * write is rejected.
         *
         * Why the refresh:
         * Firebase ID tokens expire after 1 hour. After expiration, the
         * SDK's local session object still exists (so isSignedIn() and
         * getUserId() return truthy), but writes get rejected by the
         * server because the token presented is stale. From the user's
         * perspective this looks like "signed in but push silently fails"
         * — exactly the symptom we're chasing. The Firebase Rules
         * Playground simulation succeeded with this UID + payload, so
         * the rules ARE correct; the only remaining client-side cause
         * is auth state staleness.
         *
         * getIdToken(true) forces a refresh against Firebase Auth's
         * REST endpoint. If the refresh itself fails (network, account
         * disabled, password changed elsewhere) we reject with the
         * actual reason instead of silently proceeding with a known-bad
         * token. */
        return currentUser.getIdToken(true).then(function (token) {
            if (window.console) {
                Log.log('[cloudsync] push: token refreshed, len=' + (token && token.length));
            }
            var parental = Store.getParental ? Store.getParental() : Store.raw.get('parental', {});
            /* Previously this was if (parental && parental.pin)
             * which only strips when pin is truthy. If pin exists with a falsy
             * value (empty string, null, 0, false), the sanitization was
             * skipped — but Firebase's hasChild('pin') returns true for ANY
             * value at that key including empty string. The rule
             *   ".validate": "newData.val() == null || !newData.hasChild('pin')"
             * would then reject the push.
             *
             * Now: if the parental object exists at all, clone it and delete
             * the pin key unconditionally. Belt-and-braces — also strip any
             * other raw-secret keys that might creep in. */
            if (parental && typeof parental === 'object') {
                parental = JSON.parse(JSON.stringify(parental));
                // Strip raw secrets regardless of value. The hashed/salted
                // variants (pinHash, pinSalt) are fine to sync.
                if ('pin' in parental) delete parental.pin;
                if ('rawPin' in parental) delete parental.rawPin;
            }
            /* Settings are per-user preferences EXCEPT for a handful of
             * device-local fields that must never sync: crash-recovery
             * bookkeeping (perfCrashMarker / perfCrashCount) is per-device — a
             * crash on one TV must not push a "crashed" flag that another TV
             * pulls and reacts to; perfMode / player are device-capability
             * choices (a weak WebOS 6.5 TV wants Lite / a specific decoder, a
             * strong TV doesn't); and sync (whether THIS device has sync on) is
             * meaningless to propagate. Clone and strip them so only genuine
             * cross-device prefs (overlayMs, autoResume, ...) travel. */
            var syncSettings = Store.getSettings();
            if (syncSettings && typeof syncSettings === 'object') {
                syncSettings = JSON.parse(JSON.stringify(syncSettings));
                /* Device-local settings — stripped from the cloud payload.
                 *
                 *   perfCrashMarker / perfCrashCount : crash-recovery bookkeeping.
                 *       Per-device by nature — a crash on one TV must not push a
                 *       "crashed" flag that another TV pulls and reacts to.
                 *   perfMode / player : device-capability choices. A weak WebOS 6.5
                 *       TV wants Lite and a specific decoder; a strong TV does not.
                 *   sync : whether THIS device has sync on. Meaningless to propagate.
                 *   textSize : an ERGONOMIC choice, not an account preference. It
                 *       depends on panel size and viewing distance — a 55" viewed at
                 *       2m and a 77" viewed at 4m legitimately want different text
                 *       sizes, so syncing it would make adjusting one TV silently
                 *       change the other. Same rationale as perfMode/player.
                 *
                 * NOTE videoScale and viewMode are deliberately NOT in this list.
                 * videoScale is a CONTENT preference (how the picture is framed) and
                 * viewMode (list vs card per section) is a personal browsing
                 * preference — both are properties of the PERSON, not the panel, so
                 * they sync like language. Someone who prefers the poster grid prefers
                 * it on all their TVs. Both are defaulted in Store.getSettings so they
                 * always exist in the payload rather than only appearing once the
                 * Settings screen has been saved. */
                var DEVICE_LOCAL_SETTINGS = ['perfCrashMarker', 'perfCrashCount', 'perfMode', 'player', 'sync', 'textSize', 'theme', 'screenMargin', 'bufferReserve', 'playerClock', 'liveCatsCollapsed', 'afr'];
                for (var dls = 0; dls < DEVICE_LOCAL_SETTINGS.length; dls++) {
                    if (syncSettings.hasOwnProperty(DEVICE_LOCAL_SETTINGS[dls])) delete syncSettings[DEVICE_LOCAL_SETTINGS[dls]];
                }
            }
            var data = {
                favorites: mapList(Store.getFavorites(), redactEntry),
                favTombstones: mapList(Store.getFavTombstones ? Store.getFavTombstones() : [], redactTomb),
                playlists: Store.getPlaylists(),
                playlistTombstones: Store.getPlaylistTombstones ? Store.getPlaylistTombstones() : [],
                activePlaylist: Store.getActivePlaylistId(),
                settings: syncSettings,
                vodHistory: mapList(Store.getVodHistory(), redactEntry),
                recentChannels: mapList(Store.getRecentChannels ? Store.getRecentChannels() : [], redactEntry),
                hiddenCats: Store.raw.get('hiddenCats', {}),
                parentalLocks: Store.raw.get('parentalLocks', {}),
                parentalItemLocks: Store.raw.get('parentalItemLocks', {}),
                parental: parental || {},
                customCatOrder: Store.raw.get('customCatOrder', {}),
                preferredSubLang: Store.getPreferredSubLang ? (Store.getPreferredSubLang() || '') : '',
                lastUpdated: firebase.database.ServerValue.TIMESTAMP
            };

            /* Credential handling on push. The secret playlist fields
             * (user/pass for xtream, url/epgUrl for m3u, mac/serial/deviceId for
             * stalker, and an uploaded m3u's content body) are NOT synced in the
             * default mode: they are stripped from the cloud copy entirely, so
             * Firebase only ever holds a "shell" (name, type, host, content-type
             * prefs, EPG toggle). On another device the playlist appears marked
             * "credentials needed" and the user re-enters them. Plaintext creds
             * stay in localStorage on THIS device — only the cloud copy is
             * stripped.
             *
             * The old UID+email-derived AES obfuscation was removed: the key was
             * derived from server-known data (uid/email), so anyone with Firebase
             * access could decrypt it — obfuscation, not zero-knowledge. The
             * shell-strip default gives a real guarantee (the secret simply isn't
             * there), and the opt-in zero-knowledge mode (separate patch) encrypts
             * under a passphrase the server never sees.
             *
             * A syncMode marker travels with the payload so pull() knows how to
             * interpret the playlists: 'shell' = creds stripped.
             *
             * Field coverage: user/pass (xtream), url/epgUrl (m3u/xtream), mac +
             * serial + deviceId (stalker — the MAC is the portal's auth credential,
             * equivalent to a password), and content (an uploaded/pasted M3U body,
             * which routinely embeds per-stream credentials in its URLs). All are
             * stripped in shell mode and encrypted in ZK mode. This list MUST stay
             * identical to ZK_SECRET_FIELDS (push, ZK branch) and SECRET_FIELDS_PULL
             * (pull) below, or a field encrypted on push won't be decrypted on pull. */
            var SECRET_FIELDS = ['user', 'pass', 'url', 'epgUrl', 'mac', 'serial', 'deviceId', 'content', 'authUser', 'authPass', 'epgAuthUser', 'epgAuthPass'];
            var encryptPlaylistsPromise = Promise.resolve();
            // When true, this push must NOT write the playlists node (ZK-locked:
            // preserve the encrypted cloud copy). Drives a per-child write below.
            var preservePlaylists = false;

            // Determine credential-sync mode. Zero-knowledge is ON when the user
            // has set up a passphrase (zkEnabled + a stored salt/verifier live in
            // settings, written by the ZK setup flow). Three outcomes:
            //   - ZK on AND unlocked this session -> encrypt the secret fields
            //     under the passphrase key, syncMode 'zk', carry salt+verifier.
            //   - ZK on but LOCKED (passphrase not entered this session) -> DEFER:
            //     shell-strip and DON'T touch the stored salt/verifier. Never
            //     downgrade encrypted creds to plaintext. (Also covers a push
            //     triggered by pairing while locked.)
            //   - ZK off -> shell-strip (creds simply not synced).
            var zkSettings = (Store.getSettings && Store.getSettings()) || {};
            var zkOn = !!(zkSettings.zkEnabled && zkSettings.zkSalt && zkSettings.zkVerifier &&
                          typeof ZKSync !== 'undefined' && ZKSync.hasWebCrypto && ZKSync.hasWebCrypto());
            var zkUnlocked = zkOn && ZKSync.isUnlocked && ZKSync.isUnlocked();

            // External EPG URLs live in settings and CAN embed provider creds
            // (e.g. xmltv.php?username=&password=). In ZK mode we encrypt them so
            // they never sit in the cloud in the clear; in shell mode they're left
            // as-is (a wanted cross-device "use this guide everywhere" preference,
            // and usually a public XMLTV link). Runs regardless of whether any
            // playlists exist. Encrypted values carry the same zk1: prefix and are
            // decrypted on pull. externalEpgOverride is a plain 'on'/'off' flag —
            // not sensitive, left untouched.
            var encryptEpgPromise = Promise.resolve();
            if (zkOn && zkUnlocked && data.settings && typeof data.settings === 'object' &&
                typeof ZKSync !== 'undefined' && ZKSync.encryptFields) {
                var s = data.settings;
                encryptEpgPromise = (function () {
                    var chain = Promise.resolve();
                    // Encrypt the array entries (up to 3) and the single-URL mirror.
                    if (Object.prototype.toString.call(s.externalEpgUrls) === '[object Array]') {
                        s.externalEpgUrls.forEach(function (u, idx) {
                            if (typeof u === 'string' && u && u.indexOf('zk1:') !== 0) {
                                chain = chain.then(function () {
                                    var box = { v: u };
                                    return ZKSync.encryptFields(box, ['v']).then(function (enc) { s.externalEpgUrls[idx] = enc.v; });
                                });
                            }
                        });
                    }
                    if (typeof s.externalEpgUrl === 'string' && s.externalEpgUrl && s.externalEpgUrl.indexOf('zk1:') !== 0) {
                        chain = chain.then(function () {
                            var box2 = { v: s.externalEpgUrl };
                            return ZKSync.encryptFields(box2, ['v']).then(function (enc) { s.externalEpgUrl = enc.v; });
                        });
                    }
                    // Encrypt the per-URL EPG auth (user + pass) so protected-EPG
                    // logins sync end-to-end-encrypted, like the URLs above. Each
                    // entry is {user,pass}|null; a zk1: value marks an already-
                    // encrypted field (idempotent across re-pushes).
                    if (Object.prototype.toString.call(s.externalEpgAuth) === '[object Array]') {
                        s.externalEpgAuth.forEach(function (a, aidx) {
                            if (a && typeof a === 'object') {
                                if (typeof a.user === 'string' && a.user && a.user.indexOf('zk1:') !== 0) {
                                    chain = chain.then(function () {
                                        var bu = { v: a.user };
                                        return ZKSync.encryptFields(bu, ['v']).then(function (enc) { s.externalEpgAuth[aidx].user = enc.v; });
                                    });
                                }
                                if (typeof a.pass === 'string' && a.pass && a.pass.indexOf('zk1:') !== 0) {
                                    chain = chain.then(function () {
                                        var bp = { v: a.pass };
                                        return ZKSync.encryptFields(bp, ['v']).then(function (enc) { s.externalEpgAuth[aidx].pass = enc.v; });
                                    });
                                }
                            }
                        });
                    }
                    return chain;
                })();
            }

            if (zkOn && zkUnlocked && data.playlists && data.playlists.length) {
                // Encrypt secret fields per playlist under the ZK key.
                var zkClones = [];
                for (var zpi = 0; zpi < data.playlists.length; zpi++) {
                    zkClones.push(JSON.parse(JSON.stringify(data.playlists[zpi])));
                }
                encryptPlaylistsPromise = (function () {
                    var chain = Promise.resolve();
                    var encrypted = [];
                    zkClones.forEach(function (plClone) {
                        chain = chain.then(function () {
                            return ZKSync.encryptFields(plClone, SECRET_FIELDS).then(function (enc) {
                                // Mark that creds are present-but-encrypted, not stripped.
                                if (enc.hasOwnProperty('credsStripped')) delete enc.credsStripped;
                                // encryptFields leaves an EMPTY secret field as ''. The Firebase rule
                                // requires every present secret field to start with zk1:, so a blank
                                // optional field (a Stalker serial / deviceId, an Xtream epgUrl) got the
                                // whole push rejected. A blank carries no secret: send it as absent.
                                for (var esf = 0; esf < SECRET_FIELDS.length; esf++) {
                                    var ev = enc[SECRET_FIELDS[esf]];
                                    if (enc.hasOwnProperty(SECRET_FIELDS[esf]) && (ev === '' || ev === null || ev === undefined)) delete enc[SECRET_FIELDS[esf]];
                                }
                                encrypted.push(enc);
                            });
                        });
                    });
                    return chain.then(function () {
                        data.playlists = encrypted;
                        data.syncMode = 'zk';
                        data.zkSalt = zkSettings.zkSalt;
                        data.zkVerifier = zkSettings.zkVerifier;
                    });
                })();
            } else if (zkOn) {
                // ZK on but LOCKED this session. We must not touch the encrypted
                // playlists already in the cloud: overwriting them with shells
                // would silently destroy the synced ciphertext, so a second
                // device could never unlock (it'd fall back to per-playlist
                // credsNeeded). Rather than shell-stripping and writing, we omit
                // the playlists node from this push entirely so the cloud copy
                // is preserved untouched. preservePlaylists drives a per-child
                // write below instead of a full-node set().
                preservePlaylists = true;
                delete data.playlists;
                data.syncMode = 'zk';
                data.zkSalt = zkSettings.zkSalt;
                data.zkVerifier = zkSettings.zkVerifier;
            } else {
                // ZK off -> shell-strip (creds simply not synced).
                if (data.playlists && data.playlists.length) {
                    var shelled = [];
                    for (var pi = 0; pi < data.playlists.length; pi++) {
                        var clone = JSON.parse(JSON.stringify(data.playlists[pi]));
                        for (var sfi = 0; sfi < SECRET_FIELDS.length; sfi++) {
                            if (clone.hasOwnProperty(SECRET_FIELDS[sfi])) delete clone[SECRET_FIELDS[sfi]];
                        }
                        // Mark the shell so the receiving device can show a
                        // "credentials needed" state rather than trying to load it.
                        clone.credsStripped = true;
                        shelled.push(clone);
                    }
                    data.playlists = shelled;
                }
                data.syncMode = 'shell';
            }

            // Normal (shell) mode: external EPG URLs are NOT encrypted, so any
            // that carry provider credentials (e.g. a pasted xmltv.php?username=
            // &password= link, even though it lives in the "external" slot) must
            // be stripped before the settings node is synced — otherwise the
            // creds would sit in the cloud in the clear. Credential-free
            // .xml/.xml.gz links are kept (a wanted "use this guide everywhere"
            // preference). Only runs when we're NOT ZK-encrypting the EPG URLs
            // (ZK off, or ZK locked this session); the ZK-unlocked path above
            // encrypts them instead, so nothing needs stripping there.
            var stripSensitiveEpg = !(zkOn && zkUnlocked);
            if (stripSensitiveEpg && data.settings && typeof data.settings === 'object' &&
                typeof Crypto !== 'undefined' && Crypto.isSensitiveEpgUrl) {
                var ds = data.settings;
                if (Object.prototype.toString.call(ds.externalEpgUrls) === '[object Array]') {
                    var kept = [];
                    for (var eei = 0; eei < ds.externalEpgUrls.length; eei++) {
                        var eu = ds.externalEpgUrls[eei];
                        // Keep already-encrypted (zk1:) values and non-sensitive links.
                        if (typeof eu === 'string' && eu.indexOf('zk1:') !== 0 && Crypto.isSensitiveEpgUrl(eu)) continue;
                        kept.push(eu);
                    }
                    ds.externalEpgUrls = kept;
                }
                if (typeof ds.externalEpgUrl === 'string' && ds.externalEpgUrl &&
                    ds.externalEpgUrl.indexOf('zk1:') !== 0 && Crypto.isSensitiveEpgUrl(ds.externalEpgUrl)) {
                    ds.externalEpgUrl = '';
                }
                // EPG auth is a credential: in non-ZK mode it must never be pushed
                // in plaintext. Drop it entirely here (ZK mode encrypts it above and
                // never reaches this branch). The URLs still sync; the login is
                // re-entered on the other device.
                if (ds.hasOwnProperty('externalEpgAuth')) delete ds.externalEpgAuth;
            }

            return Promise.all([encryptPlaylistsPromise, encryptEpgPromise]).then(function () {
            if (window.console) {
                Log.log('[cloudsync] push: writing to /users/' + uid + '/data, fields=' + Object.keys(data).join(','));
                /* Pre-flight client-side rule check. Logs
                 * warnings for anything we know the rules would reject.
                 * Doesn't block the push — Firebase is the source of truth
                 * — but if push then fails, console already shows the most
                 * likely cause without needing more devtools digging. */
                if (data.parental && typeof data.parental === 'object' && 'pin' in data.parental) {
                    Log.warn('[cloudsync] PRE-FLIGHT: parental still contains "pin" key — rule rejection likely');
                }
                if (typeof data.activePlaylist === 'string' && data.activePlaylist.length > 256) {
                    Log.warn('[cloudsync] PRE-FLIGHT: activePlaylist >256 chars — rule rejection likely');
                }
                if (typeof data.preferredSubLang === 'string' && data.preferredSubLang.length > 16) {
                    Log.warn('[cloudsync] PRE-FLIGHT: preferredSubLang >16 chars — rule rejection likely');
                }
                // Watch for unexpected top-level fields (would trip $other:false).
                // NB: favTombstones must ALSO be permitted in the Firebase security
                // rules (the /data node's field list) or the push is rejected server-
                // side — see the rules-update note in the changelog/KNOWN-ITEMS.
                var allowed = {favorites:1, favTombstones:1, recentChannels:1, playlists:1, playlistTombstones:1, activePlaylist:1, settings:1,
                    vodHistory:1, hiddenCats:1, parentalLocks:1, parentalItemLocks:1,
                    parental:1, customCatOrder:1, preferredSubLang:1, contentTypes:1,
                    syncMode:1, zkSalt:1, zkVerifier:1, lastUpdated:1};
                for (var k in data) {
                    if (data.hasOwnProperty(k) && !allowed[k]) {
                        Log.warn('[cloudsync] PRE-FLIGHT: unexpected field "' + k + '" not in rules whitelist');
                    }
                }
            }
            /* Write. Normally a full-node set() replaces /data wholesale. But
             * when preservePlaylists is set (ZK on + locked) we deliberately
             * left playlists out of data, and a set() would DELETE the
             * cloud's encrypted playlists node. Use update() in that case so
             * the other fields are written while the existing playlists node
             * is left intact. */
            var writeRef = db.ref('users/' + uid + '/data');
            function doWrite() { return preservePlaylists ? writeRef.update(data) : writeRef.set(data); }
            var writePromise = doWrite()['catch'](function (err0) {
                /* Live recents are a newer field. If the Firebase rules do not list it yet the
                 * whole push is refused, so retry once without it rather than losing sync. */
                if (err0 && (err0.code === 'PERMISSION_DENIED' || /permission_denied/i.test(String(err0.message || ''))) &&
                    data.hasOwnProperty('recentChannels')) {
                    Log.warn('[cloudsync] push refused with recentChannels - retrying without it (add "recentChannels" to the Firebase rules)');
                    delete data.recentChannels;
                    return doWrite();
                }
                throw err0;
            });
            return writePromise['catch'](function (err) {
                /* Verbose log of the Firebase error so the user sees the
                 * actual server-side cause in console instead of just
                 * generic permission_denied. */
                if (window.console) {
                    Log.error('[cloudsync] push REJECTED at /users/' + uid + '/data:',
                        'code=' + (err && err.code),
                        'message=' + (err && err.message));
                }
                throw err;
            });
            }); // close encryptPlaylistsPromise.then
        })['catch'](function (err) {
            /* Also catch failures of the token refresh itself. */
            if (window.console && err && err.code) {
                Log.error('[cloudsync] push token-refresh failed:',
                    'code=' + err.code, 'message=' + err.message);
            }
            throw err;
        });
    }

    // Pull cloud data to local
    function pull() {
        if (!db || !currentUser) return Promise.reject('Not signed in');
        var uid = currentUser.uid;
        return db.ref('users/' + uid + '/data').once('value').then(function (snapshot) {
            var data = snapshot.val();
            if (!data) return null;

            /* Shell-merge playlists. The cloud copy is a "shell" with the secret
             * fields (user/pass/url/epgUrl/mac/serial/deviceId/content) stripped
             * (see push). Merging must NOT
             * clobber creds this device already holds locally: for each cloud
             * shell, if a local playlist with the same id still has its creds,
             * carry those local creds over; otherwise mark the playlist
             * credsNeeded so the UI prompts for entry rather than trying to load a
             * credential-less playlist.
             *
             * (The old path decrypted AES-obfuscated fields; that's gone with the
             * shell-strip model. The zero-knowledge opt-in — separate patch —
             * slots its passphrase-decrypt in here for syncMode === 'zk'.) */
            var playlistMergePromise = Promise.resolve();
            var epgDecryptPromise = Promise.resolve();

            // Zero-knowledge decrypt step. When the cloud copy is syncMode 'zk',
            // the playlist secret fields are 'zk1:'-encrypted under the user's
            // passphrase key. Persist the salt/verifier locally so the Settings
            // unlock flow and the next push can find them. If the key is unlocked
            // this session, decrypt the secret fields in place so the shell-merge
            // below sees normal creds. If it's LOCKED, leave them encrypted — the
            // merge will treat a 'zk1:'-prefixed user/pass as unusable and mark the
            // playlist credsNeeded, which is the correct fallback until the user
            // unlocks (the Settings unlock flow and its re-pull). A wrong
            // passphrase can't reach here: unlock() only holds the key on a correct
            // verifier match.
            if (data.syncMode === 'zk') {
                if (data.zkSalt || data.zkVerifier) {
                    var stForZk = (Store.getSettings && Store.getSettings()) || {};
                    stForZk.zkEnabled = true;
                    if (data.zkSalt) stForZk.zkSalt = data.zkSalt;
                    if (data.zkVerifier) stForZk.zkVerifier = data.zkVerifier;
                    if (Store.setSettings) Store.setSettings(stForZk);
                }
                var zkReady = (typeof ZKSync !== 'undefined' && ZKSync.isUnlocked && ZKSync.isUnlocked());
                // When the cloud copy is ZK but the session key is locked, the
                // secret fields stay 'zk1:'-encrypted and the shell-merge would
                // wrongly flag them as playlist credsNeeded (prompting for the
                // provider login). Flag zkLocked so pull callers can route to the
                // passphrase unlock flow instead. Only flag when there is actually
                // encrypted material to unlock.
                if (!zkReady && data.playlists && data.playlists.length) {
                    var hasEnc = false;
                    for (var zci = 0; zci < data.playlists.length; zci++) {
                        var zcp = data.playlists[zci];
                        if (zcp && (('' + (zcp.user || '')).indexOf('zk1:') === 0 ||
                                    ('' + (zcp.pass || '')).indexOf('zk1:') === 0 ||
                                    ('' + (zcp.url || '')).indexOf('zk1:') === 0 ||
                                    ('' + (zcp.epgUrl || '')).indexOf('zk1:') === 0 ||
                                    ('' + (zcp.mac || '')).indexOf('zk1:') === 0 ||
                                    ('' + (zcp.content || '')).indexOf('zk1:') === 0)) {
                            hasEnc = true;
                            break;
                        }
                    }
                    if (hasEnc) data.zkLocked = true;
                }
                if (zkReady && data.playlists && data.playlists.length) {
                    // MUST match SECRET_FIELDS in push() — see the note there.
                    var ZK_SECRET_FIELDS = ['user', 'pass', 'url', 'epgUrl', 'mac', 'serial', 'deviceId', 'content', 'authUser', 'authPass', 'epgAuthUser', 'epgAuthPass'];
                    playlistMergePromise = (function () {
                        var chain = Promise.resolve();
                        var decoded = [];
                        data.playlists.forEach(function (plEnc) {
                            chain = chain.then(function () {
                                return ZKSync.decryptFields(plEnc, ZK_SECRET_FIELDS).then(function (dec) {
                                    decoded.push(dec);
                                })['catch'](function () {
                                    // A field failed to decrypt (corrupt/tampered) —
                                    // keep the shell as-is; merge will flag credsNeeded.
                                    decoded.push(plEnc);
                                });
                            });
                        });
                        return chain.then(function () { data.playlists = decoded; });
                    })();
                }
                // Decrypt ZK-encrypted external EPG URLs in the pulled settings
                // (mirror of the push-side encryptEpgPromise). Only runs when the ZK
                // key is available; if locked, the zk1: values are left in place and
                // the EPG loader simply won't use a ciphertext URL. A field that
                // fails to decrypt is dropped so a corrupt value can't poison EPG.
                if (data.settings && typeof data.settings === 'object' && ZKSync.decryptFields) {
                    var es = data.settings;
                    epgDecryptPromise = (function () {
                        var chain = Promise.resolve();
                        if (Object.prototype.toString.call(es.externalEpgUrls) === '[object Array]') {
                            es.externalEpgUrls.forEach(function (u, idx) {
                                if (typeof u === 'string' && u.indexOf('zk1:') === 0) {
                                    chain = chain.then(function () {
                                        return ZKSync.decryptFields({ v: u }, ['v']).then(function (dec) { es.externalEpgUrls[idx] = dec.v; })['catch'](function () { es.externalEpgUrls[idx] = ''; });
                                    });
                                }
                            });
                        }
                        if (typeof es.externalEpgUrl === 'string' && es.externalEpgUrl.indexOf('zk1:') === 0) {
                            chain = chain.then(function () {
                                return ZKSync.decryptFields({ v: es.externalEpgUrl }, ['v']).then(function (dec) { es.externalEpgUrl = dec.v; })['catch'](function () { es.externalEpgUrl = ''; });
                            });
                        }
                        // Decrypt the per-URL EPG auth (user + pass) pushed under ZK.
                        if (Object.prototype.toString.call(es.externalEpgAuth) === '[object Array]') {
                            es.externalEpgAuth.forEach(function (a, aidx) {
                                if (a && typeof a === 'object') {
                                    if (typeof a.user === 'string' && a.user.indexOf('zk1:') === 0) {
                                        chain = chain.then(function () {
                                            return ZKSync.decryptFields({ v: a.user }, ['v']).then(function (dec) { es.externalEpgAuth[aidx].user = dec.v; })['catch'](function () { es.externalEpgAuth[aidx].user = ''; });
                                        });
                                    }
                                    if (typeof a.pass === 'string' && a.pass.indexOf('zk1:') === 0) {
                                        chain = chain.then(function () {
                                            return ZKSync.decryptFields({ v: a.pass }, ['v']).then(function (dec) { es.externalEpgAuth[aidx].pass = dec.v; })['catch'](function () { es.externalEpgAuth[aidx].pass = ''; });
                                        });
                                    }
                                }
                            });
                        }
                        return chain;
                    })();
                }
            }

            playlistMergePromise = playlistMergePromise.then(function () {
            if (data.playlists && data.playlists.length) {
                var localPls = (Store.getPlaylists && Store.getPlaylists()) || [];
                var localById = {};
                for (var lp = 0; lp < localPls.length; lp++) {
                    if (localPls[lp] && localPls[lp].id != null) localById[localPls[lp].id] = localPls[lp];
                }
                // MUST match SECRET_FIELDS in push() — see the note there.
                var SECRET_FIELDS_PULL = ['user', 'pass', 'url', 'epgUrl', 'mac', 'serial', 'deviceId', 'content', 'authUser', 'authPass', 'epgAuthUser', 'epgAuthPass'];
                for (var mi = 0; mi < data.playlists.length; mi++) {
                    var cloudPl = data.playlists[mi];
                    if (!cloudPl) continue;
                    var local = (cloudPl.id != null) ? localById[cloudPl.id] : null;
                    // A still-encrypted secret field (zk locked) is NOT usable
                    // creds — treat it as absent so the playlist is flagged
                    // credsNeeded rather than loaded with ciphertext.
                    var ZK_PREFIX = 'zk1:';
                    var sfp;
                    for (sfp = 0; sfp < SECRET_FIELDS_PULL.length; sfp++) {
                        var ef = SECRET_FIELDS_PULL[sfp];
                        if (typeof cloudPl[ef] === 'string' && cloudPl[ef].indexOf(ZK_PREFIX) === 0) {
                            delete cloudPl[ef];
                        }
                    }
                    if (local) {
                        // Restore any secret fields we hold locally onto the shell.
                        for (var sf = 0; sf < SECRET_FIELDS_PULL.length; sf++) {
                            var f = SECRET_FIELDS_PULL[sf];
                            if (local[f] != null && local[f] !== '') { cloudPl[f] = local[f]; }
                        }
                    }
                    // Determine whether the merged playlist actually has what it
                    // needs to load. xtream needs user+pass; stalker needs mac;
                    // m3u needs url OR an embedded content body (uploaded file).
                    // (These secret fields are stripped in shell mode and only
                    // present here if restored from the local copy above or synced
                    // via ZK, so this correctly flags credsNeeded when they're gone.)
                    var hasCreds = (cloudPl.type === 'xtream')
                        ? (cloudPl.user && cloudPl.pass)
                        : (cloudPl.type === 'stalker')
                            ? (cloudPl.mac)
                            : (cloudPl.url || cloudPl.content);
                    if (hasCreds) {
                        cloudPl.credsNeeded = false;
                        if (cloudPl.hasOwnProperty('credsStripped')) delete cloudPl.credsStripped;
                    } else {
                        cloudPl.credsNeeded = true;
                    }
                }
            }
            });

            return Promise.all([playlistMergePromise, epgDecryptPromise]).then(function () {
                // Favorites: union merge honouring per-key timestamps and tombstones,
                // so add and REMOVE both sync across TVs (option 1). For each key we
                // compare the newest add (addedAt) against the newest removal
                // (removedAt, from either side's tombstones); the later action wins.
                if (data.favorites) {
                    mergeFavorites(data.favorites, data.favTombstones || []);
                }
                if (data.playlists) {
                    mergePlaylists(data.playlists, data.playlistTombstones || []);
                }
                if (data.activePlaylist) Store.setActivePlaylistId(data.activePlaylist);
            if (data.settings) {
                // Merge, don't overwrite: the pushed settings intentionally
                // exclude device-local fields (crash markers, perfMode, player,
                // sync — see push), so a wholesale setSettings would WIPE this
                // device's own values for them. Keep this device's device-local
                // fields and layer the synced preferences on top.
                var localSettings = (Store.getSettings && Store.getSettings()) || {};
                var mergedSettings = {};
                var lk;
                for (lk in localSettings) { if (localSettings.hasOwnProperty(lk)) mergedSettings[lk] = localSettings[lk]; }
                /* Keep this device's device-local fields; layer synced prefs on top.
                 *
                 * textSize is included here as well as in the push-side strip. The
                 * push side means new payloads will not CONTAIN textSize — but a
                 * cloud node written by an earlier build may still hold one, and
                 * without this guard that legacy value would be pulled down and
                 * overwrite the per-device text size. Guarding both directions makes
                 * the field genuinely device-local rather than merely "no longer
                 * uploaded". */
                var DEVICE_LOCAL_PULL = { perfCrashMarker: 1, perfCrashCount: 1, perfMode: 1, player: 1, sync: 1, textSize: 1, theme: 1, screenMargin: 1, bufferReserve: 1, playerClock: 1, liveCatsCollapsed: 1, afr: 1 };
                for (lk in data.settings) {
                    if (data.settings.hasOwnProperty(lk) && !DEVICE_LOCAL_PULL[lk]) {
                        mergedSettings[lk] = data.settings[lk];
                    }
                }
                // Preserve local SENSITIVE external EPG URLs. They're intentionally
                // never synced in normal mode (they carry provider creds), so the
                // cloud copy lacks them; without this, the merged cloud list would
                // wipe a credentialed external guide the user set on THIS device.
                // Keep the value local-only, like a playlist's stripped creds.
                if (typeof Crypto !== 'undefined' && Crypto.isSensitiveEpgUrl) {
                    var localS = (Store.getSettings && Store.getSettings()) || {};
                    if (Object.prototype.toString.call(localS.externalEpgUrls) === '[object Array]') {
                        var mergedArr = (Object.prototype.toString.call(mergedSettings.externalEpgUrls) === '[object Array]')
                            ? mergedSettings.externalEpgUrls : [];
                        for (var lsi = 0; lsi < localS.externalEpgUrls.length; lsi++) {
                            var lsu = localS.externalEpgUrls[lsi];
                            if (typeof lsu === 'string' && lsu && Crypto.isSensitiveEpgUrl(lsu) && mergedArr.indexOf(lsu) < 0) {
                                mergedArr.push(lsu);
                            }
                        }
                        mergedSettings.externalEpgUrls = mergedArr;
                    }
                    // Single-URL mirror: if local holds a sensitive one and the merged
                    // value is empty/absent, keep the local value.
                    if (typeof localS.externalEpgUrl === 'string' && localS.externalEpgUrl &&
                        Crypto.isSensitiveEpgUrl(localS.externalEpgUrl) && !mergedSettings.externalEpgUrl) {
                        mergedSettings.externalEpgUrl = localS.externalEpgUrl;
                    }
                }
                Store.setSettings(mergedSettings);
            }
            if (data.hiddenCats) Store.raw.set('hiddenCats', data.hiddenCats);
            if (data.parentalLocks) Store.raw.set('parentalLocks', data.parentalLocks);
            if (data.parentalItemLocks) Store.raw.set('parentalItemLocks', data.parentalItemLocks);
            // Pull custom category order + preferred
            // subtitle language (mirrors the push payload above).
            if (data.customCatOrder) Store.raw.set('customCatOrder', data.customCatOrder);
            if (typeof data.preferredSubLang === 'string' && Store.setPreferredSubLang) {
                Store.setPreferredSubLang(data.preferredSubLang);
            }
            if (data.parental) {
                // Do NOT blindly overwrite the local parental config: if the local device
                // has a NEWER PIN (just set, before a reload), a stale cloud copy would
                // clobber it and the correct PIN would read as "incorrect". Only apply the
                // cloud copy when it is newer than local, or when local has no PIN set.
                var localPar = (Store.getParental ? Store.getParental() : Store.raw.get('parental', {})) || {};
                var localT = (localPar && localPar.pinUpdatedAt) || 0;
                var cloudT = (data.parental && data.parental.pinUpdatedAt) || 0;
                var localHasPin = !!(localPar && (localPar.pinHash || localPar.pin));
                if (!localHasPin || cloudT >= localT) {
                    if (Store.setParental) Store.setParental(data.parental);
                    else Store.raw.set('parental', data.parental);
                }
            }
            if (data.vodHistory) {
                // Newest entry wins per playlist + item; cloud copies arrive without the login
                // and are completed from this device's own playlist.
                Store.raw.set('vodHistory', mergeRecentLists(data.vodHistory, Store.getVodHistory(), 'timestamp', 50));
            }
            if (data.recentChannels) {
                // Live Continue Watching. Entries carry a timestamp ('at'); older ones without
                // one sort last.
                Store.raw.set('recentChannels', mergeRecentLists(data.recentChannels, Store.getRecentChannels(), 'at', 10));
            }
            // Anything that still holds a placeholder (playlist had no login yet) is retried here
            // and again whenever the playlists change.
            refreshCreds();
            return data;
            }); // close playlistDecryptPromise.then
        });
    }

    // Auto-sync: push after any change (debounced)
    var syncTimer = null;
    function schedulePush() {
        if (!isSignedIn()) return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(function () {
            push()['catch'](function (e) { Util.logErr('CloudSync push failed', e); });
        }, 3000);
    }

    function wipeCloud() {
        if (!db || !currentUser) return Promise.reject(new Error('Not signed in'));
        return db.ref('users/' + currentUser.uid).remove();
    }

    // Delete the entire cloud account. Removes the
    // user's data node first, then deletes the Firebase Auth user.
    /* Firebase requires a recent login to delete an account; if the
     * session is stale it throws 'auth/requires-recent-login'. We
     * surface that as a distinct error code so the UI can prompt the
     * user to sign in again before retrying, rather than showing a
     * generic failure.
     *
     * Reordered so user.delete() runs FIRST, data
     * removal SECOND. Previously we removed data first, then tried
     * to delete the auth account — if auth-delete failed with
     * requires-recent-login, the user was in a half-deleted state
     * (cloud data gone, account still exists). Retrying after a
     * fresh sign-in would re-push local data, then succeed at auth
     * delete — but for that window the user has stale local data
     * pushed back to the cloud.
     *
     * Order now:
     *   1. Force a token refresh to catch staleness early
     *   2. user.delete() — if this fails, nothing else changed
     *   3. Remove the data node — fire-and-forget; if it fails the
     *      auth account is gone and the orphaned data can't be
     *      accessed by anyone (rules require auth.uid == $uid). */
    /* Delete the account and its cloud data.
     *
     * Order (v678+): refresh token -> REMOVE DATA NODE (while still
     * authenticated) -> user.delete() -> verify. The data removal MUST happen
     * before user.delete(), because the security rule requires
     * auth.uid == $uid for the write: once user.delete() succeeds the session is
     * gone, auth.uid is null, and any cleanup write is denied — which used to
     * orphan the user's data node in the database forever (unreadable, but never
     * actually deleted; a privacy/GDPR problem). Deleting data first, while
     * authenticated, means "delete account" genuinely removes the data.
     *
     * Failure handling: if data removal succeeds but user.delete() then fails
     * (e.g. requires-recent-login), the account remains but its data is already
     * gone — the safe direction. A retry after re-auth is idempotent (the node is
     * already empty) and completes the auth delete. We do NOT push during this
     * window, so no stale local data is re-uploaded. */
    function deleteAccount() {
        if (!auth || !currentUser) return Promise.reject(new Error('Not signed in'));
        var user = currentUser;
        var uid = user.uid;
        var email = user.email;
        // 1. Force token refresh first — surfaces stale-session early, and gives
        //    user.delete() a fresh token so it's less likely to need re-login.
        return user.getIdToken(true).then(function () {
            // 2. Remove the cloud data node WHILE STILL AUTHENTICATED so the
            //    auth.uid == $uid rule permits it. If this fails, abort before
            //    touching the auth account so we don't half-delete.
            if (!db) return true;
            return db.ref('users/' + uid).remove();
        }).then(function () {
            // 3. Delete the auth account.
            return user['delete']();
        }).then(function () {
            /* Verify the deletion actually happened.
             * Firebase compat SDK can sometimes resolve user.delete()
             * locally while the server-side delete request fails or
             * is rejected. Symptom: TV shows "Account deleted" but
             * the user can sign in again with the same credentials.
             *
             * If currentUser is still populated after delete() resolved,
             * something didn't actually delete the account. Reject so
             * the UI doesn't lie.
             *
             * We also wait a moment and re-check, because Firebase's
             * SDK may take a tick to update its currentUser reference. */
            return new Promise(function (resolve, reject) {
                setTimeout(function () {
                    if (auth.currentUser != null) {
                        // Account still exists in SDK state — that's wrong. The
                        // data node is already gone (removed above); the user can
                        // retry the auth delete after re-auth. Idempotent.
                        var e = new Error('Account deletion did not complete. The Firebase server may have rejected the request — try signing out and back in, then retry.');
                        e.code = 'delete-incomplete';
                        reject(e);
                    } else {
                        resolve(true);
                    }
                }, 500);
            });
        }).then(function () {
            return true;
        })['catch'](function (err) {
            var code = (err && err.code) ? err.code : '';
            if (code === 'auth/requires-recent-login' || code === 'auth/user-token-expired') {
                var e = new Error('Please sign in again before deleting your account.');
                e.code = 'requires-recent-login';
                throw e;
            }
            throw err;
        });
    }

    function resetPassword(email) {
        init();
        if (!firebase) return Promise.reject(new Error('Firebase not initialized'));
        var url = 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + APP_CONFIG.FIREBASE.apiKey;
        return Util.xhr({
            method: 'POST',
            url: url,
            body: { requestType: 'PASSWORD_RESET', email: email },
            json: true
        }).then(function (r) {
            if (r.body && r.body.error) throw new Error(r.body.error.message);
            return r;
        });
    }

    /* Non-blocking sanity check of the deployed Firebase config/rules. Reads a
     * known /config/version node. The app can't read its own security rules, so
     * this is an indirect signal: if the read is DENIED, the rules likely aren't
     * the ones we expect (a misdeploy can leave the DB wide open or fully
     * locked); if the value doesn't match EXPECTED_CONFIG_VERSION, the deployed
     * config has drifted from what this app build expects. Either way we only
     * warn — never block startup or sync. Resolves to a small status object. */
    var EXPECTED_CONFIG_VERSION = 1;
    function healthCheck() {
        if (!db) return Promise.resolve({ ok: false, reason: 'db-not-ready' });
        return db.ref('config/version').once('value').then(function (snap) {
            var v = snap.val();
            if (v == null) {
                Util.log('CloudSync.healthCheck: /config/version missing (config not deployed?)');
                return { ok: false, reason: 'missing', value: null };
            }
            if (v !== EXPECTED_CONFIG_VERSION) {
                Util.logErr('CloudSync.healthCheck: config version mismatch', 'got ' + v + ', expected ' + EXPECTED_CONFIG_VERSION);
                return { ok: false, reason: 'mismatch', value: v, expected: EXPECTED_CONFIG_VERSION };
            }
            Util.log('CloudSync.healthCheck: config version ' + v + ' OK');
            return { ok: true, value: v };
        })['catch'](function (err) {
            // A permission-denied here is the meaningful signal: the rules aren't
            // letting us read a node we expect to be readable.
            Util.logErr('CloudSync.healthCheck: read failed (rules misdeployed?)', err);
            return { ok: false, reason: 'denied', error: ('' + (err && (err.code || err.message || err))) };
        });
    }

    try { if (window.Store && Store.onPlaylistsChanged) Store.onPlaylistsChanged(refreshCreds); } catch (eHook) {}

    return {
        init: init,
        refreshCreds: refreshCreds,
        _test: { redactEntry: redactEntry, expandEntry: expandEntry, mergeFavorites: mergeFavorites, mergeRecentLists: mergeRecentLists },
        isSignedIn: isSignedIn,
        getUserId: getUserId,
        getUserEmail: getUserEmail,
        signInEmail: signInEmail,
        signUp: signUp,
        signInWithCustomToken: signInWithCustomToken,
        whenReady: whenReady,
        signOut: signOut,
        push: push,
        pull: pull,
        schedulePush: schedulePush,
        resetPassword: resetPassword,
        wipeCloud: wipeCloud,
        deleteAccount: deleteAccount,
        healthCheck: healthCheck
    };
})();
