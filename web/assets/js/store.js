/* store.js - Persistent storage (localStorage + optional Firebase sync)
 *
 * Schema:
 *   xtivio.deviceId           - unique device UUID
 *   xtivio.playlists          - array of playlist definitions
 *   xtivio.activePlaylistId   - which playlist is active
 *   xtivio.favorites          - array of channel URLs marked as favorite
 *   xtivio.settings           - UI/player settings
 *   xtivio.channelsCache.<id> - parsed channels per playlist (cache)
 *   xtivio.epgCache.<id>      - parsed EPG per playlist (cache)
 */
var Store = (function () {
    'use strict';

    var LS = null;
    try {
        if (typeof localStorage !== 'undefined') {
            // Sanity check - some TVs throw on access
            localStorage.setItem('__xtivio_test__', '1');
            localStorage.removeItem('__xtivio_test__');
            LS = localStorage;
        }
    } catch (e) {
        Util.logErr('localStorage unavailable', e);
    }

    // Fallback in-memory
    var memStore = {};

    function rawGet(k) {
        try {
            if (LS) return LS.getItem(k);
            return memStore[k] == null ? null : memStore[k];
        } catch (e) { return memStore[k] == null ? null : memStore[k]; }
    }
    function rawSet(k, v) {
        try {
            if (LS) { LS.setItem(k, v); return true; }
            memStore[k] = v;
            return true;
        } catch (e) {
            memStore[k] = v;
            Util.logErr('localStorage.setItem failed', e);
            return false;
        }
    }
    function rawRemove(k) {
        try { if (LS) LS.removeItem(k); } catch (e) {}
        if (memStore[k]) delete memStore[k];
    }

    // Evict the large, RE-FETCHABLE channel-cache blobs from localStorage. These are the
    // biggest consumers of the small localStorage quota (worst on Samsung/Tizen), and they
    // rebuild from the playlist on next load, so dropping them to make room for a critical
    // write (e.g. the parental PIN) is safe. Returns how many keys were freed.
    function evictChannelCaches() {
        var freed = 0;
        try {
            if (!LS) return 0;
            var kill = [];
            for (var i = 0; i < LS.length; i++) {
                var k = LS.key(i);
                if (k && k.indexOf('xtivio.chcache.') === 0) kill.push(k);
            }
            for (var j = 0; j < kill.length; j++) { try { LS.removeItem(kill[j]); freed++; } catch (e) {} }
        } catch (e2) {}
        return freed;
    }

    // Persist a value and CONFIRM it actually landed in localStorage (not just the in-memory
    // fallback). If the first write throws/quota-fails, free the re-fetchable channel caches
    // and retry once. Returns true only if the value is durably stored. Use for security- or
    // correctness-critical keys (the parental PIN) that must survive a reload.
    function rawSetVerified(k, v) {
        if (!LS) { memStore[k] = v; return false; } // no persistent layer at all
        try {
            LS.setItem(k, v);
            if (LS.getItem(k) === v) return true;
        } catch (e) {
            Util.logErr('localStorage.setItem failed (will retry after eviction)', e);
        }
        // Retry after making room.
        evictChannelCaches();
        try {
            LS.setItem(k, v);
            if (LS.getItem(k) === v) return true;
        } catch (e2) {
            Util.logErr('localStorage.setItem failed after eviction', e2);
        }
        memStore[k] = v; // last resort so the current session still works
        return false;
    }

    function get(key, fallback) {
        var v = rawGet('xtivio.' + key);
        if (v == null) return fallback == null ? null : fallback;
        try { return JSON.parse(v); } catch (e) { return fallback == null ? null : fallback; }
    }
    function set(key, val) {
        try { rawSet('xtivio.' + key, JSON.stringify(val)); } catch (e) { Util.logErr('Store.set', e); }
        // Auto-sync to cloud if signed in
        if (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn && CloudSync.isSignedIn()) {
            try { CloudSync.schedulePush(); } catch (e2) {}
        }
    }
    function del(key) { rawRemove('xtivio.' + key); }

    function getDeviceId() {
        var id = get('deviceId');
        if (!id) { id = Util.uuid(); set('deviceId', id); }
        return id;
    }

    function getPlaylists() { return get('playlists', []) || []; }
    var playlistsChangedHook = null;
    function setPlaylists(list) {
        set('playlists', list);
        // CloudSync registers a hook so synced entries still holding login placeholders are
        // completed as soon as a playlist gets its credentials.
        if (playlistsChangedHook) { try { playlistsChangedHook(); } catch (eH) {} }
    }
    // Stamp a playlist as modified now, for cross-device newest-wins merge. Called
    // at every real mutation (add, edit, content-type/EPG toggle).
    function stampPlaylist(pl) { if (pl) pl.updatedAt = Date.now(); return pl; }
    // Deletion tombstones: {id, deletedAt} so a delete syncs (newest-wins) instead of
    // the playlist reappearing from the cloud. Pruned in mergePlaylists.
    function getPlaylistTombstones() { return get('playlistTombstones', []) || []; }
    function setPlaylistTombstones(list) { set('playlistTombstones', list); }
    function addPlaylistTombstone(id) {
        if (id == null) return;
        var t = getPlaylistTombstones(), i;
        for (i = 0; i < t.length; i++) { if (t[i].id === id) { t.splice(i, 1); break; } }
        t.push({ id: id, deletedAt: Date.now() });
        setPlaylistTombstones(t);
    }

    /* Stable fingerprint of a playlist's SOURCE, for cache invalidation. NOT the
     * playlist.id (a random uuid that survives a source edit) — this changes when
     * the user points the playlist at a different provider/URL, so the catalog
     * cache invalidates on a source change regardless of TTL. Header-independent
     * and provider-agnostic (no reliance on etags, which Xtream lines send
     * inconsistently), mirroring EPG's sourceSetKey approach. */
    function contentSourceKey(pl) {
        if (!pl) return '';
        if (pl.type === 'xtream') {
            return 'xtream\u0001' + (pl.host || '') + '\u0001' + (pl.user || '');
        }
        return (pl.type || 'url') + '\u0001' + (pl.url || '');
    }
    function updatePlaylist(pl) {
        stampPlaylist(pl);
        var pls = getPlaylists();
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === pl.id) { pls[i] = pl; break; }
        }
        setPlaylists(pls);
    }

    function getActivePlaylistId() { return get('activePlaylistId', null); }
    function setActivePlaylistId(id) { set('activePlaylistId', id); }

    function getFavorites() { return get('favorites', []) || []; }
    function setFavorites(list) { set('favorites', list); }
    // Tombstones: {key, removedAt} for favorites removed on this device, so a
    // cross-device merge can tell "never had it" from "removed it" and honour the
    // newer of add-vs-remove per key. Pruned in mergeFavorites (cap + age).
    function getFavTombstones() { return get('favTombstones', []) || []; }
    function setFavTombstones(list) { set('favTombstones', list); }
    // Favorites are per playlist. A favorite's key is "<playlistId>::<url or id>",
    // so the same title in two playlists (a Stalker and an Xtream login from one
    // provider, or two Xtream logins) is two separate favorites, and sync merges
    // and removal tombstones can no longer cross playlists. An item with no
    // playlist (very old data) keeps its bare key and still matches everywhere.
    var FAV_SEP = '::';
    function favScope(ch) {
        return (ch && ch.playlistId) || getActivePlaylistId() || '';
    }
    function favBase(entry) {
        var k = entry && entry.key != null ? String(entry.key) : '';
        var pl = entry && entry.playlistId;
        if (pl && k.indexOf(pl + FAV_SEP) === 0) return k.substring(pl.length + FAV_SEP.length);
        return k;
    }
    function favScopedKey(scope, base) { return scope ? (scope + FAV_SEP + base) : base; }
    // Upgrade a pre-1.0.3 entry (bare key + playlistId field) to a scoped key.
    function scopeFavEntry(f) {
        if (!f || f.key == null || !f.playlistId) return false;
        var k = String(f.key);
        if (k.indexOf(f.playlistId + FAV_SEP) === 0) return false;
        f.key = f.playlistId + FAV_SEP + k;
        return true;
    }
    function migrateFavorites(list) {
        var changed = false;
        for (var i = 0; list && i < list.length; i++) { if (scopeFavEntry(list[i])) changed = true; }
        return changed;
    }
    function favMatchIndex(favs, ch) {
        var scope = favScope(ch);
        var cands = {};
        if (ch.url) cands[favScopedKey(scope, ch.url)] = 1;
        if (ch.id) cands[favScopedKey(scope, ch.id)] = 1;
        for (var i = 0; i < favs.length; i++) {
            var f = favs[i];
            if (!f) continue;
            if (cands[f.key]) return i;
            // Legacy entry with no playlist at all: bare key matches any playlist.
            if (!f.playlistId && ((ch.url && f.key === ch.url) || (ch.id && f.key === ch.id))) return i;
        }
        return -1;
    }
    function toggleFavorite(ch) {
        var scope = favScope(ch);
        var key = favScopedKey(scope, ch.url || ch.id); // URL primary (stable across playlist reloads)
        var favs = getFavorites();
        var idx = favMatchIndex(favs, ch);
        if (idx >= 0) key = favs[idx].key;
        var now = Date.now();
        var tombs = getFavTombstones();
        if (idx >= 0) {
            favs.splice(idx, 1);
            // Record a tombstone (replace any older one for this key) so the removal
            // syncs instead of being undone by a union merge from the cloud.
            var ti;
            for (ti = 0; ti < tombs.length; ti++) { if (tombs[ti].key === key) { tombs.splice(ti, 1); break; } }
            tombs.push({ key: key, removedAt: now });
            setFavTombstones(tombs);
        } else {
            // Adding: drop any tombstone for this key (re-added after a removal).
            var tj;
            for (tj = 0; tj < tombs.length; tj++) { if (tombs[tj].key === key) { tombs.splice(tj, 1); setFavTombstones(tombs); break; } }
            // Normalize content type. Xtream/m3u live channels -> 'live'. Stalker
            // items carry type 'stalker' + a stalkerKind, so resolve that to the
            // real content type (a Stalker movie must not be stored as 'live', or it
            // shows the wrong badge, no lock glyph, and mis-de-dupes).
            var contentType = ch.type || 'live';
            if (contentType === 'stalker') {
                contentType = (ch.stalkerKind === 'series') ? 'series'
                            : (ch.stalkerKind === 'vod') ? 'vod' : 'live';
            } else if (contentType !== 'vod' && contentType !== 'series') {
                contentType = 'live';
            }
            var favEntry = {
                key: key,
                id: ch.id || '',
                name: ch.name,
                logo: ch.logo,
                url: ch.url,
                playlistId: scope || ch.playlistId,
                playlistName: ch.playlistName || '',
                category: ch.category,
                type: contentType,
                addedAt: now
            };
            // Preserve Stalker identity so the favorite plays + types correctly.
            if (ch.type === 'stalker') {
                favEntry.origType = 'stalker';
                favEntry.stalkerKind = ch.stalkerKind || '';
                if (ch.stalkerCmd) favEntry.stalkerCmd = ch.stalkerCmd;
                if (ch.stalkerId) favEntry.stalkerId = ch.stalkerId;
            }
            favs.push(favEntry);
        }
        setFavorites(favs);
        return idx < 0;
    }
    function isFavorite(ch) {
        return favMatchIndex(getFavorites(), ch) >= 0;
    }

    function getSettings() {
        return get('settings', {
            player: 'auto',
            overlayMs: APP_CONFIG.OVERLAY_MS || 5000,
            sync: 'off',
            autoResume: 'off',
            // videoScale is defaulted here (rather than only being written when the
            // user visits Settings) so that it ALWAYS exists in the settings object
            // and therefore always travels in the cloud payload.
            //
            // Previously it was absent until the Settings screen was opened and
            // saved, and every read was defensive (st.videoScale || 'contain'), so
            // the app worked fine without it — but a device that had never touched
            // the setting pushed a payload with no videoScale key at all, and the
            // value silently failed to sync. Defaulting it closes that hole.
            //
            // textSize is deliberately NOT defaulted here and is device-local: see
            // DEVICE_LOCAL_SETTINGS in cloudsync.js.
            videoScale: 'contain',
            // Catalogue-cache toggle. When ON (default), a playlist's parsed
            // Movies/Series catalogue is persisted to IndexedDB and reused on the
            // next launch instead of re-fetching from the network (30-day TTL, or
            // until the source changes / the playlist is manually refreshed).
            // Covers Movies AND Series together. Defaulted so it always exists in
            // the sync payload. A user who prefers a guaranteed fresh pull every
            // launch can switch it OFF. (Live has no such toggle: it uses
            // paint-then-refresh and always refreshes in the background, so a
            // cache-skip switch would only slow perceived launch for no benefit.)
            cacheVod: 'on',
            // View mode per content section: 'list' (the classic two-pane category
            // list + rows) or 'card' (a full-width poster grid with a top action bar
            // and a category dropdown). Keyed by section so Live, Movies and Series
            // can each be set independently. Defaulted here (like videoScale) so it
            // always exists in the sync payload, and it SYNCS (like language): the
            // preferred browsing layout is a property of the person, not the panel, so
            // it follows the user across their TVs. Defaults to 'list' to preserve the
            // existing layout; the card renderers are wired in progressively.
            viewMode: { live: 'list', movies: 'list', series: 'list' },
            // App language. Syncs (unlike textSize): the language you read in is a
            // property of the PERSON, not of the panel — someone who reads Spanish
            // reads Spanish on both their TVs. Defaulted here so it always exists in
            // the payload rather than only appearing once Settings has been saved.
            language: 'en'
        });
    }
    function setSettings(s) { set('settings', s); }

    /* View mode per content section ('live' | 'movies' | 'series'), value 'list' or
     * 'card'. Read defensively: a settings object synced from a device that predates
     * this feature has no viewMode key, or only a partial one, so every lookup falls
     * back to 'list'. setViewMode merges into whatever object exists so setting one
     * section never clobbers the others. */
    function getViewMode(section) {
        var s = getSettings();
        var vm = s && s.viewMode;
        if (!vm || typeof vm !== 'object') return 'list';
        return vm[section] === 'card' ? 'card' : 'list';
    }
    function setViewMode(section, mode) {
        if (section !== 'live' && section !== 'movies' && section !== 'series') return;
        var s = getSettings();
        if (!s.viewMode || typeof s.viewMode !== 'object') {
            s.viewMode = { live: 'list', movies: 'list', series: 'list' };
        }
        s.viewMode[section] = (mode === 'card') ? 'card' : 'list';
        setSettings(s);
    }

    /* Content type preferences — which top-level content categories
     * the user wants to see (Live TV, Movies, Series). Stored as an
     * object with three booleans; at least one must be true. Missing,
     * malformed, or all-false values default to all three enabled so
     * older builds, fresh installs, and any corrupted state degrade to
     * the pre-feature behaviour (everything visible). */

    /* Normalize a raw contentTypes value to {live,movies,series} booleans,
     * defaulting to all-on when absent/malformed/all-false. Shared by the
     * global and per-playlist getters. */
    function normalizeContentTypes(raw) {
        if (!raw || typeof raw !== 'object') {
            return { live: true, movies: true, series: true };
        }
        var live = !!raw.live, movies = !!raw.movies, series = !!raw.series;
        if (!live && !movies && !series) {
            return { live: true, movies: true, series: true };
        }
        return { live: live, movies: movies, series: series };
    }

    /* Per-playlist content selection. Each playlist may carry its own
     * contentTypes; when a playlist has none (e.g. created before this
     * feature), default to all-on so it shows everything until the user
     * sets a per-playlist preference. */
    function getPlaylistContentTypes(id) {
        if (!id) return { live: true, movies: true, series: true };
        var pls = getPlaylists();
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === id) {
                return normalizeContentTypes(pls[i].contentTypes);
            }
        }
        return { live: true, movies: true, series: true };
    }
    function setPlaylistContentTypes(id, ct) {
        if (!id) return;
        var pls = getPlaylists();
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === id) {
                pls[i].contentTypes = normalizeContentTypes(ct);
                stampPlaylist(pls[i]);
                setPlaylists(pls);
                return;
            }
        }
    }

    /* Per-playlist EPG enable flag. Defaults to true (EPG on) when a playlist
     * has no stored value, matching the pairing-server default. Stored as an
     * explicit boolean on the playlist object. */
    function getPlaylistEpgEnabled(id) {
        if (!id) return true;
        var pls = getPlaylists();
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === id) {
                return pls[i].epgEnabled !== false; // default true
            }
        }
        return true;
    }
    function setPlaylistEpgEnabled(id, enabled) {
        if (!id) return;
        var pls = getPlaylists();
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === id) {
                pls[i].epgEnabled = !!enabled;
                stampPlaylist(pls[i]);
                setPlaylists(pls);
                return;
            }
        }
    }

    function getLastChannel() { return get('lastChannel', null); }
    function setLastChannel(ch) {
        if (!ch) { del('lastChannel'); return; }
        var slim = {
            id: ch.id, name: ch.name, url: ch.url, logo: ch.logo,
            category: ch.category, tvgId: ch.tvgId, epgId: ch.epgId,
            number: ch.number, playlistId: ch.playlistId,
            playlistName: ch.playlistName, type: ch.type,
            fallbackUrl: ch.fallbackUrl || ''
        };
        set('lastChannel', slim);
        // Also push to recent channels list (max 10, most recent first)
        addRecent(slim);
    }

    function getRecentChannels() { return get('recentChannels', []) || []; }
    function addRecent(ch) {
        var list = getRecentChannels();
        var key = ch.id || ch.url;
        // Remove if already in list (move to front). Same id in a different
        // playlist is a different entry.
        var filtered = [];
        for (var i = 0; i < list.length; i++) {
            if ((list[i].id || list[i].url) !== key || (list[i].playlistId || '') !== (ch.playlistId || '')) filtered.push(list[i]);
        }
        ch.at = Date.now();   // lets the cloud merge keep the newest copy per channel
        filtered.unshift(ch);
        if (filtered.length > 10) filtered = filtered.slice(0, 10);
        set('recentChannels', filtered);
    }

    function cacheChannels(playlistId, channels) {
        if (!channels || channels.length > 5000) {
            dropChannelsCache(playlistId); // Fix: clear stale cache
            return;
        }
        try {
            var json = JSON.stringify(channels);
            if (json.length > 3 * 1024 * 1024) return;
            rawSet('xtivio.chcache.' + playlistId, json);
        }
        catch (e) {
            // Quota exceeded — silently skip
            try {
                if (LS) {
                    var keys = [];
                    for (var i = 0; i < LS.length; i++) {
                        var k = LS.key(i);
                        if (k && k.indexOf('xtivio.chcache.') === 0) keys.push(k);
                    }
                    for (var j = 0; j < keys.length; j++) LS.removeItem(keys[j]);
                }
            } catch (e2) {}
        }
    }
    function readCachedChannels(playlistId) {
        var v = rawGet('xtivio.chcache.' + playlistId);
        if (!v) return null;
        // Don't parse huge caches — they block the main thread
        if (v.length > 3 * 1024 * 1024) {
            rawRemove('xtivio.chcache.' + playlistId);
            return null;
        }
        try { return JSON.parse(v); } catch (e) { return null; }
    }
    function dropChannelsCache(playlistId) {
        rawRemove('xtivio.chcache.' + playlistId);
        // Also drop the IndexedDB copies (fire-and-forget). Large lists live in
        // IDB rather than localStorage, so clearing the cache must reach both —
        // and across all content kinds (live, vod, series) so a refresh/edit/
        // delete doesn't leave a stale movies or series cache behind.
        try {
            if (typeof IDB !== 'undefined') {
                IDB.init().then(function () { IDB.deleteAllKinds(playlistId); });
            }
        } catch (e) {}
    }

    // Threshold above which a channel list is too big for localStorage and
    // belongs in IndexedDB instead. Matches the historical localStorage cutoff
    // so small lists keep their existing fast synchronous path.
    var IDB_CACHE_THRESHOLD = 5000;

    /* Cache a parsed channel list, choosing the right backend by size.
     * Small lists (<= threshold) go to localStorage as before, giving a
     * synchronous instant-paint read on next launch. Large lists go to
     * IndexedDB, which has no JSON-string-in-localStorage ceiling — this is
     * the whole point of the migration: real playlists here are ~21k channels
     * and were previously not cached at all. Returns a Promise that resolves
     * when the write settles (or immediately for the localStorage path).
     * Never rejects — a storage failure must never break a load. */
    function cacheChannelsAsync(playlistId, channels) {
        if (!playlistId || !channels || !channels.length) {
            return Promise.resolve(false);
        }
        if (channels.length <= IDB_CACHE_THRESHOLD) {
            // Small enough for localStorage. Drop any large IDB copy so the two
            // backends never disagree about the same playlist.
            cacheChannels(playlistId, channels);
            try {
                if (typeof IDB !== 'undefined') {
                    IDB.init().then(function () { IDB.deleteChannels(playlistId); });
                }
            } catch (e) {}
            return Promise.resolve(true);
        }
        // Too big for localStorage — use IndexedDB. Drop any stale localStorage
        // copy first for the same consistency reason.
        rawRemove('xtivio.chcache.' + playlistId);
        if (typeof IDB === 'undefined') return Promise.resolve(false);
        return IDB.init().then(function (ok) {
            if (!ok) return false;
            return IDB.putChannels(playlistId, channels);
        })['catch'](function () { return false; });
    }

    /* Read a cached channel list, checking localStorage first (synchronous,
     * used elsewhere for instant paint) then IndexedDB. Always returns a
     * Promise resolving to the array or null. Callers that want the instant
     * synchronous localStorage value still call readCachedChannels() directly;
     * this async reader is for the large-list case that only IDB holds. */
    function readCachedChannelsAsync(playlistId) {
        if (!playlistId) return Promise.resolve(null);
        var local = readCachedChannels(playlistId);
        if (local && local.length) return Promise.resolve(local);
        if (typeof IDB === 'undefined') return Promise.resolve(null);
        return IDB.init().then(function (ok) {
            if (!ok) return null;
            return IDB.getChannels(playlistId);
        })['catch'](function () { return null; });
    }


    /* Read a cached VOD or series list for a playlist. Resolves to the array or
     * null. IndexedDB-only (no localStorage tier for these kinds). */
    function readContentAsync(kind, playlistId) {
        if (!playlistId) return Promise.resolve(null);
        if (kind !== 'vod' && kind !== 'series') return Promise.resolve(null);
        if (typeof IDB === 'undefined') return Promise.resolve(null);
        return IDB.init().then(function (ok) {
            if (!ok) return null;
            return IDB.getItems(kind, playlistId);
        })['catch'](function () { return null; });
    }

    /* Evict a single content kind's IndexedDB cache for a playlist
     * (fire-and-forget). Used when a per-playlist content type is switched off,
     * so a disabled type's large cache doesn't linger in storage and can't
     * serve stale data if the type is later re-enabled. Live channels also
     * have a localStorage copy, so that is dropped too for the 'live' kind. */
    function dropContentCache(kind, playlistId) {
        if (!playlistId) return;
        if (kind === 'live') rawRemove('xtivio.chcache.' + playlistId);
        try {
            if (typeof IDB !== 'undefined') {
                IDB.init().then(function () { IDB.deleteItems(kind, playlistId); });
            }
        } catch (e) {}
    }

    function wipeAll() {
        if (LS) {
            var keys = [];
            for (var i = 0; i < LS.length; i++) {
                var k = LS.key(i);
                if (k && k.indexOf('xtivio.') === 0) keys.push(k);
            }
            for (var j = 0; j < keys.length; j++) LS.removeItem(keys[j]);
        }
        memStore = {};
        // Drop the IndexedDB caches too (all content kinds), so a full wipe
        // leaves no orphaned large-list caches behind.
        // Returns a promise that settles once the IndexedDB clear has finished (never
        // rejects), so the caller can wait for it before reloading the page.
        try {
            if (typeof IDB !== 'undefined') {
                return IDB.wipeAll ? IDB.wipeAll() : IDB.init().then(function () { return IDB.clearAllKinds(); })['catch'](function () { return true; });
            }
        } catch (e) {}
        return Promise.resolve(true);
    }

    // One-time upgrade of favorites saved before they were per playlist (1.0.3).
    try {
        var _favList = getFavorites();
        if (migrateFavorites(_favList)) setFavorites(_favList);
    } catch (eMig) {}

    return {
        getDeviceId: getDeviceId,
        getPlaylists: getPlaylists,
        setPlaylists: setPlaylists,
        onPlaylistsChanged: function (fn) { playlistsChangedHook = fn; },
        stampPlaylist: stampPlaylist,
        getPlaylistTombstones: getPlaylistTombstones,
        setPlaylistTombstones: setPlaylistTombstones,
        addPlaylistTombstone: addPlaylistTombstone,
        updatePlaylist: updatePlaylist,
        getActivePlaylistId: getActivePlaylistId,
        setActivePlaylistId: setActivePlaylistId,
        getFavorites: getFavorites,
        setFavorites: setFavorites,
        getFavTombstones: getFavTombstones,
        setFavTombstones: setFavTombstones,
        toggleFavorite: toggleFavorite,
        isFavorite: isFavorite,
        favBase: favBase,
        favScopedKey: favScopedKey,
        favScope: favScope,
        migrateFavorites: migrateFavorites,
        scopeFavEntry: scopeFavEntry,
        getSettings: getSettings,
        setSettings: setSettings,
        getViewMode: getViewMode,
        setViewMode: setViewMode,
        getPlaylistContentTypes: getPlaylistContentTypes,
        setPlaylistContentTypes: setPlaylistContentTypes,
        getPlaylistEpgEnabled: getPlaylistEpgEnabled,
        setPlaylistEpgEnabled: setPlaylistEpgEnabled,
        getLastChannel: getLastChannel,
        setLastChannel: setLastChannel,
        getRecentChannels: getRecentChannels,
        getVodHistory: function () { return get('vodHistory', []); },
        addVodHistory: function (item) {
            var h = get('vodHistory', []);
            // Remove existing entry for same id IN THE SAME PLAYLIST
            h = h.filter(function (x) { return x.id !== item.id || (x.playlistId || '') !== (item.playlistId || ''); });
            h.unshift(item); // newest first
            if (h.length > 20) h = h.slice(0, 20);
            set('vodHistory', h);
        },
        // Remove a Continue Watching entry by key (id or url) from BOTH the VOD
        // history and the recent-channels list, so one call covers vod/series and
        // live alike. Returns true if anything was removed.
        removeFromContinueWatching: function (key, playlistId) {
            if (!key) return false;
            var removed = false;
            // playlistId (optional) limits removal to that playlist's entry; omitted
            // keeps the old behaviour of removing every entry with this key.
            function hit(x) { return (x.id || x.url) === key && (!playlistId || (x.playlistId || '') === playlistId); }
            var vh = get('vodHistory', []) || [];
            var vh2 = vh.filter(function (x) { return !hit(x); });
            if (vh2.length !== vh.length) { set('vodHistory', vh2); removed = true; }
            var rc = get('recentChannels', []) || [];
            var rc2 = rc.filter(function (x) { return !hit(x); });
            if (rc2.length !== rc.length) { set('recentChannels', rc2); removed = true; }
            return removed;
        },
        // Purge a deleted playlist's entries from the favorites list and from both
        // Continue Watching stores (recentChannels = live, vodHistory = movie/series),
        // so cards for a removed playlist don't linger on Home or the Favorites screen.
        purgePlaylistFromLists: function (playlistId) {
            if (!playlistId) return false;
            var changed = false;
            function keepOther(list) {
                var out = [];
                for (var i = 0; i < list.length; i++) {
                    if (!list[i] || list[i].playlistId !== playlistId) out.push(list[i]);
                }
                if (out.length !== list.length) changed = true;
                return out;
            }
            try { set('favorites', keepOther(get('favorites', []) || [])); } catch (e1) {}
            try { set('recentChannels', keepOther(get('recentChannels', []) || [])); } catch (e2) {}
            try { set('vodHistory', keepOther(get('vodHistory', []) || [])); } catch (e3) {}
            return changed;
        },
        cacheChannels: cacheChannels,
        readCachedChannels: readCachedChannels,
        cacheChannelsAsync: cacheChannelsAsync,
        readCachedChannelsAsync: readCachedChannelsAsync,
        readContentAsync: readContentAsync,
        dropContentCache: dropContentCache,
        dropChannelsCache: dropChannelsCache,
        getHiddenCategories: function (plId, type) {
            var all = get('hiddenCats') || {};
            // Normalise type to canonical form. Earlier
            // versions of renderVodScreen called with 'movie' (no s)
            // while the cat manager wrote with 'movies' — same data,
            // two different storage keys, so hidden categories from
            // the manager weren't being filtered out on render. Normalising
            // here makes the store self-consistent regardless of which
            // legacy string a caller uses.
            var t = type || 'live';
            if (t === 'movie' || t === 'vod') t = 'movies';
            if (t !== 'movies' && t !== 'series') t = 'live';
            var key = plId + '_' + t;
            return all[key] || {};
        },
        setHiddenCategory: function (plId, type, catName, hidden) {
            var all = get('hiddenCats') || {};
            var t = type || 'live';
            if (t === 'movie' || t === 'vod') t = 'movies';
            if (t !== 'movies' && t !== 'series') t = 'live';
            var key = plId + '_' + t;
            if (!all[key]) all[key] = {};
            if (hidden) all[key][catName] = true;
            else delete all[key][catName];
            set('hiddenCats', all);
        },
        // Custom category sort order, per (plId, type).
        // Stored as an array of category names in user-chosen order.
        // Missing entry means "use default sort". Returned by
        // applyCustomCategoryOrder() below as a convenience for renderers.
        // Same type normalisation applied as hidden-categories above.
        getCustomCategoryOrder: function (plId, type) {
            var all = get('customCatOrder') || {};
            var t = type || 'live';
            if (t === 'movie' || t === 'vod') t = 'movies';
            if (t !== 'movies' && t !== 'series') t = 'live';
            var key = plId + '_' + t;
            return all[key] || null;
        },
        setCustomCategoryOrder: function (plId, type, order) {
            var all = get('customCatOrder') || {};
            var t = type || 'live';
            if (t === 'movie' || t === 'vod') t = 'movies';
            if (t !== 'movies' && t !== 'series') t = 'live';
            var key = plId + '_' + t;
            if (order && order.length) all[key] = order;
            else delete all[key]; // null/empty = "reset to default"
            set('customCatOrder', all);
        },
        /* How the categories (and, for dated Movies / Series, the items inside them) are ordered, per playlist and section
         * (movies, series or live; Live and M3U only use az / za / provider):
         * 'az' (default), 'za', 'provider', 'newest', 'oldest'. Stored in the customCatOrder map under
         * "<playlist>_<section>#sort", so it travels with the category order through cloud sync (that
         * field takes any value; no rules change). The order readers only look at "<playlist>_<section>". */
        getItemSort: function (plId, type) {
            var all = get('customCatOrder') || {};
            var m = all[plId + '_' + (type === 'series' ? 'series' : type === 'live' ? 'live' : 'movies') + '#sort'];
            return (m === 'za' || m === 'provider' || m === 'newest' || m === 'oldest') ? m : 'az';
        },
        setItemSort: function (plId, type, mode) {
            var all = get('customCatOrder') || {};
            var key = plId + '_' + (type === 'series' ? 'series' : type === 'live' ? 'live' : 'movies') + '#sort';
            if (mode === 'za' || mode === 'provider' || mode === 'newest' || mode === 'oldest') all[key] = mode;
            else delete all[key];
            set('customCatOrder', all);
        },
        // Reorder defaultSortedNames to match the saved custom order. Any
        // name in the custom order that's no longer in defaultSortedNames
        // is dropped; any name in defaultSortedNames not in the custom
        // order is appended at the end (so newly-added categories show
        // up in a predictable place). If no custom order is saved,
        // returns the default-sorted list unchanged.
        applyCustomCategoryOrder: function (plId, type, defaultSortedNames) {
            var saved = this.getCustomCategoryOrder(plId, type);
            if (!saved || !saved.length) return defaultSortedNames.slice(0);
            var present = {};
            for (var i = 0; i < defaultSortedNames.length; i++) present[defaultSortedNames[i]] = true;
            var seen = {};
            var out = [];
            // First pass: names from the saved order that still exist
            for (var j = 0; j < saved.length; j++) {
                var n = saved[j];
                if (present[n] && !seen[n]) { out.push(n); seen[n] = true; }
            }
            // Second pass: any new names not in the saved order, in
            // default-sort order
            for (var k = 0; k < defaultSortedNames.length; k++) {
                var dn = defaultSortedNames[k];
                if (!seen[dn]) { out.push(dn); seen[dn] = true; }
            }
            return out;
        },
        getParental: function () {
            return get('parental', { enabled:false, pin:'', startup:'off', protectActions:'on' });
        },
        setParental: function (cfg) {
            // Critical key: confirm it persisted to localStorage (freeing channel caches and
            // retrying if the quota is full) rather than silently falling back to in-memory,
            // which would be lost on the next reload (e.g. a language change reloads the app).
            var ok = rawSetVerified('xtivio.parental', JSON.stringify(cfg || {}));
            if (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn && CloudSync.isSignedIn()) {
                try { CloudSync.schedulePush(); } catch (e2) {}
            }
            return ok;
        },
        // Preferred subtitle language for VOD playback.
        // Set when user picks a subtitle track in the picker; consumed
        // on VOD play to auto-load the same language if available.
        // Stored as ISO 639-3 (e.g. 'eng') OR the special string 'off'
        // to remember an explicit "no subtitles" preference. null/empty
        // means "haven't asked yet" so auto-load picks the browser
        // locale on first run.
        getPreferredSubLang: function () { return get('preferredSubLang') || null; },
        setPreferredSubLang: function (lang) { set('preferredSubLang', lang || ''); },
        wipeAll: wipeAll,
        get: get,
        set: set,
        del: del,
        raw: { get: get, set: set, del: del }
    };
})();
/* CloudSync is defined in cloudsync.js */
