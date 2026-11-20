/**
 * GlobalSearch — unified search index across live TV, movies, and series.
 * Builds an in-memory normalized index for fast substring matching.
 * ES5 compatible, no external dependencies.
 */
var GlobalSearch = (function () {
    'use strict';

    var INDEX = [];
    // Bucketed index (Avenue 1): on some older WebKit/JSC engines a single array
    // growing past ~150k entries trips an allocation/limit failure (heap is fine —
    // this is an engine array ceiling). To sidestep it, streaming index entries
    // are stored across several smaller sub-arrays ("buckets") of at most
    // BUCKET_SIZE each; no single array ever approaches the wall. search() walks
    // all buckets. The legacy array path still uses INDEX directly. If this lets
    // the constrained device exceed 150k, no item cap is needed.
    var BUCKETS = [];
    var BUCKET_SIZE = 50000;
    var _bucketTotal = 0;
    var INDEX_READY = false;
    var MAX_RESULTS = 80;
    // Shortest query we will actually run. A single character matches nearly
    // every entry in a large catalog, making the scan pathological (see search()).
    var MIN_QUERY_CHARS = 2;
    // Collect at most MAX_RESULTS * CANDIDATE_MULTIPLE matches before stopping, so
    // the sort operates on a bounded array instead of the whole index. Generous
    // enough that scoring still has a deep pool to rank from.
    var CANDIDATE_MULTIPLE = 25;
    // Generation token: bumped whenever the index is (re)built. In-flight chunked
    // addItems loops check it and abort if a newer build/playlist-switch started,
    // so two large catalogs (e.g. m3u then xtream) never index concurrently —
    // overlapping chunk loops compound main-thread/memory pressure on weak TVs.
    var INDEX_GEN = 0;
    function indexGen() { return INDEX_GEN; }
    function bumpIndexGen() { INDEX_GEN++; return INDEX_GEN; }

    function norm(v) {
        if (!v) return '';
        return String(v).toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    // Identity of an index entry. ONE definition, used both to build the entry and
    // to recognise an item that is already indexed (see freshOnly) — they must never
    // drift apart or duplicate detection silently stops working.
    function entryId(kind, item, title, playlist) {
        return item.id || item.stream_id || (kind + ':' + title + ':' + playlist);
    }
    function itemTitle(item) { return item.name || item.title || item.stream_name || ''; }
    function itemPlaylist(item, playlistName) { return playlistName || item.playlistName || ''; }

    // Keys of titles already added through addItems (browse paths). Used only where
    // browsing is a real indexing source: Stalker (categories load lazily) and Lite /
    // crash-recovery mode (no preload). Re-opening the same category must not append
    // its titles again. The key is the provider's own id (series use series_id), or,
    // when an item has none, title + category, so the same title sitting in several
    // categories (e.g. one per language) stays as separate entries. An O(1) lookup on
    // purpose: scanning a 300k-entry catalog per category open is seconds on a weak TV.
    // Reset whenever the index is rebuilt.
    var ADDED = {};

    // kind + playlist name pairs whose catalog is indexed at playlist load (streaming
    // preload or cache rebuild). Browsing those categories must NOT index again.
    var STREAMED = {};
    function streamKey(kind, playlistName) { return kind + '\u0001' + (playlistName || ''); }
    function markStreamed(kind, playlistName) {
        var k = streamKey(kind, playlistName);
        if (STREAMED[k]) return;
        STREAMED[k] = true;
        // The playlist load now owns this kind. If a category was browsed before the
        // load started, that browse put entries into INDEX; drop them so the load's
        // copy is the only one. INDEX is small (browse-added items only), so this is cheap.
        var kept = [];
        for (var i = 0; i < INDEX.length; i++) {
            var e = INDEX[i];
            if (e && e.kind === kind && e.playlistName === (playlistName || '')) continue;
            kept.push(e);
        }
        if (kept.length !== INDEX.length) INDEX = kept;
        ADDED = {};
    }

    function browseKey(kind, it, pl) {
        var id = it.series_id || it.stream_id || it.id;
        if (!id) id = itemTitle(it) + '\u0002' + (it.category_name || it.category || it.group || '');
        return 'k' + kind + '\u0001' + pl + '\u0001' + id;
    }

    function freshOnly(kind, items, playlistName) {
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            var pl = itemPlaylist(it, playlistName);
            var key = browseKey(kind, it, pl);
            if (ADDED[key]) continue;
            ADDED[key] = true;
            out.push(it);
        }
        return out;
    }

    function pushEntry(out, kind, item, playlistName) {
        if (!item) return;
        var title = item.name || item.title || item.stream_name || '';
        var category = item.category || item.group || item.genre || item.category_name || '';
        var playlist = playlistName || item.playlistName || '';

        // Search blob intentionally excludes plot/description and cast: those
        // are long strings (a full synopsis + cast list per VOD item) and were
        // the main per-item cost when indexing tens of thousands of VOD/series
        // entries at startup. Search matches title/category/genre/playlist,
        // which is what users actually search by. (plot/cast remain on the
        // item via ref for the info panel — only the SEARCH index drops them.)
        var searchBlob = norm(
            title + ' ' +
            category + ' ' +
            playlist + ' ' +
            (item.tvgId || '') + ' ' +
            (item.epgId || '') + ' ' +
            (item.genre || '')
        );

        if (!title || !searchBlob) return;

        // Slim ref for VOD/series only: the search index retains just the fields
        // needed to render a result row and launch playback — NOT the whole item.
        // The full object (plot/cast/description/genre/rating/year) was the
        // dominant memory cost when indexing 150k+ VOD entries; on a large
        // catalog the resident index alone could exhaust a small TV heap, which
        // crashed the series parse while the movie index was still held. Those
        // fat fields are fetched on demand (the info panel has a _detailFetched
        // lazy path) when a single item is opened, so dropping them here costs
        // nothing visible while cutting the per-entry footprint substantially.
        //
        // DEDUPED: name / stream_icon / cover are deliberately NOT stored. They
        // duplicate strings the outer entry already holds:
        //
        //     ref.name        == entry.title   (both derive from item.name||item.title)
        //     ref.stream_icon )
        //     ref.cover       ) == entry.logo  (logo = item.logo || item.stream_icon
        //                                        || item.cover, so it IS one of them)
        //
        // Every consumer already falls back to the outer entry — see the
        // search-open path in ui.js:
        //
        //     name: ref.name || entry.title || ''
        //     logo: ref.stream_icon || ref.cover || entry.logo || ''
        //
        // so removing them is safe by construction. On a 300k-entry index this
        // drops three string slots per VOD/series row (a title and a poster URL,
        // the latter often ~80 chars) with no behaviour change.
        //
        // category_name is RETAINED and must NOT be collapsed into entry.category:
        // they legitimately differ. pushEntry builds the outer category as
        // item.category || item.group || item.genre || item.category_name, so a
        // series with a genre stores the GENRE outer while ref keeps the provider's
        // Xtream CATEGORY. Both are consumed (ui.js uses ref.category_name for the
        // genre field and as the searchCategory fallback).
        //
        // Live channels keep their full ref: the search-open path uses the ref
        // AS the channel (it needs url and playback fields), and live (~tens of
        // thousands) was never the memory problem — only the huge VOD/series
        // catalogs are.
        var refToStore;
        if (kind === 'movie' || kind === 'series') {
            refToStore = {
                stream_id: item.stream_id || item.id || '',
                series_id: item.series_id || '',
                container_extension: item.container_extension || '',
                category_name: item.category_name || item.category || ''
            };
        } else {
            refToStore = item;
        }

        out.push({
            id: entryId(kind, item, title, playlist),
            kind: kind,
            title: title,
            titleNorm: norm(title),
            category: category,
            categoryNorm: norm(category),
            playlistId: item.playlistId || '',
            playlistName: playlist,
            logo: item.logo || item.stream_icon || item.cover || '',
            number: item.number || item.num || '',
            searchBlob: searchBlob,
            ref: refToStore
        });
    }

    /**
     * Build or rebuild the full index from available data.
     * @param {Object} data - { channels: [], movies: [], series: [] }
     */
    function buildIndex(data) {
        // Starting a fresh full index supersedes any in-flight chunked addItems.
        bumpIndexGen();
        // Also clear the streamed buckets: buildIndex means "rebuild the index
        // from scratch", and the streaming VOD/series entries live in BUCKETS.
        // Without this, re-running the preload (e.g. toggling a content type back
        // on, or reloading the playlist) would APPEND a second full set of movies
        // and series on top of the existing ones — doubling ~217k entries and
        // blowing the device budget (observed: disable+re-enable Series crashed
        // into Lite).
        BUCKETS = [];
        _bucketTotal = 0;
        ADDED = {};
        STREAMED = {};
        var out = [];
        if (!data) { INDEX = out; INDEX_READY = true; return; }

        var channels = data.channels || [];
        var movies = data.movies || [];
        var series = data.series || [];

        for (var i = 0; i < channels.length; i++) pushEntry(out, 'live', channels[i], channels[i].playlistName);
        for (var j = 0; j < movies.length; j++) pushEntry(out, 'movie', movies[j], movies[j].playlistName || data.playlistName || '');
        for (var k = 0; k < series.length; k++) pushEntry(out, 'series', series[k], series[k].playlistName || data.playlistName || '');

        INDEX = out;
        INDEX_READY = true;
    }

    /**
     * Add items to the existing index without rebuilding.
     * Used for incrementally indexing VOD categories as they load.
     */
    /* Index build chunking. addItems is called with the FULL movie/series
     * catalog from a provider, which can be tens of thousands of entries on
     * large Xtream lines. Building those index entries in one synchronous loop
     * blocked the main thread for several seconds at startup (the ~5-10s hang),
     * especially as it overlapped the EPG load. Process in batches that yield to
     * the event loop between them, mirroring parser.js's chunked import. */
    var INDEX_CHUNK_SIZE = 300;
    var INDEX_CHUNK_DELAY_MS = 8;

    /**
     * Add items to the existing index without rebuilding.
     * Used for incrementally indexing VOD categories as they load.
     * meta (optional) is stamped onto each item DURING the chunked loop so the
     * caller doesn't need a separate synchronous pass over the whole catalog
     * (that pass was a startup-stall contributor on large lists).
     */
    function addItems(kind, items, playlistName, meta) {
        if (!items || !items.length) return;
        // The playlist-load index already holds this catalog: nothing to add.
        if (STREAMED[streamKey(kind, playlistName)]) return;
        // Skip titles already added by an earlier browse (see freshOnly). The caller's items
        // are left alone; only what actually gets indexed is the filtered copy.
        items = freshOnly(kind, items, playlistName);
        if (!items.length) return;
        function stamp(it) {
            if (meta) {
                it.playlistName = meta.playlistName;
                it.playlistId = meta.playlistId;
                it._playlistHost = meta.host;
                it._playlistUser = meta.user;
                it._playlistPass = meta.pass;
            }
        }
        if (items.length <= INDEX_CHUNK_SIZE) {
            for (var i = 0; i < items.length; i++) {
                stamp(items[i]);
                pushEntry(INDEX, kind, items[i], playlistName);
            }
            return;
        }
        // Large catalog: chunk so the UI stays responsive while it indexes.
        var myGen = INDEX_GEN;
        var pos = 0;
        function step() {
            // Abort if a newer build/playlist-switch superseded this index pass.
            if (myGen !== INDEX_GEN) return;
            // Yield priority to an open parental manager. Re-check staleness on the
            // eventual resume via this same guard (the setTimeout re-enters step,
            // which re-runs the myGen check above), so a playlist switch during the
            // pause cleanly abandons this pass instead of resuming a dead build.
            if (Util.shouldPauseBgWork && Util.shouldPauseBgWork()) {
                setTimeout(step, 150);
                return;
            }
            var end = Math.min(pos + INDEX_CHUNK_SIZE, items.length);
            for (var i = pos; i < end; i++) {
                stamp(items[i]);
                pushEntry(INDEX, kind, items[i], playlistName);
            }
            pos = end;
            if (pos < items.length) setTimeout(step, INDEX_CHUNK_DELAY_MS);
        }
        step();
    }

    /**
     * Index a SINGLE item immediately (streaming primitive). Used by the
     * streaming preload path so a huge catalog is indexed object-by-object as it
     * parses, without ever holding the full parsed array. Applies the same meta
     * stamp and slim-ref extraction (via pushEntry) as addItems. No chunking —
     * the caller controls pacing (the parser already yields between bursts).
     */
    function addOne(kind, item, playlistName, meta) {
        if (!item) return;
        if (meta) {
            item.playlistName = meta.playlistName;
            item.playlistId = meta.playlistId;
            item._playlistHost = meta.host;
            item._playlistUser = meta.user;
            item._playlistPass = meta.pass;
        }
        // Push into the current bucket, rolling to a fresh one at BUCKET_SIZE so
        // no single array approaches the engine's ~150k ceiling.
        if (!BUCKETS.length || BUCKETS[BUCKETS.length - 1].length >= BUCKET_SIZE) {
            BUCKETS.push([]);
        }
        markStreamed(kind, playlistName || item.playlistName);
        pushEntry(BUCKETS[BUCKETS.length - 1], kind, item, playlistName);
        _bucketTotal++;
        INDEX_READY = true;
    }

    function scoreEntry(entry, q, tokens) {
        var score = 0;
        if (entry.titleNorm === q) score += 1000;
        else if (entry.titleNorm.indexOf(q) === 0) score += 700;
        else if (entry.titleNorm.indexOf(q) >= 0) score += 450;

        if (entry.categoryNorm.indexOf(q) >= 0) score += 120;

        for (var i = 0; i < tokens.length; i++) {
            if (entry.titleNorm.indexOf(tokens[i]) >= 0) score += 100;
            if (entry.searchBlob.indexOf(tokens[i]) >= 0) score += 35;
        }

        if (entry.kind === 'live') score += 8;
        return score;
    }

    function search(query) {
        var q = norm(query);
        if (!INDEX_READY || !q) return [];

        // Minimum query length.
        //
        // A 1-character query matches almost every entry in a large catalog
        // (searchBlob.indexOf('a') is true for nearly all of them), so the scan
        // scores ~300k entries, pushes ~300k into the result array, sorts all of
        // them, and then throws away all but the ~80 that are displayed. That is
        // why the first keystroke or two feels slow while longer queries are fast:
        // the cost is driven by the MATCH COUNT, not the scan.
        //
        // Debouncing does not help this — the work itself is O(n log n) on a huge
        // n. Requiring 2 characters skips the pathological case entirely, and a
        // single character is not a meaningful search on a 300k-item catalog
        // anyway.
        if (q.length < MIN_QUERY_CHARS) return [];

        // Snapshot current content-type preferences once per call. The
        // kind field on each indexed entry is 'live' | 'movie' | 'series';
        // map those to the preference object's keys. Prefer the ACTIVE
        // playlist's per-playlist selection, falling back to the global.
        var ct = { live: true, movies: true, series: true };
        if (window.Store) {
            var apId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
            if (apId && Store.getPlaylistContentTypes) {
                ct = Store.getPlaylistContentTypes(apId);
            }
        }
        var kindAllowed = { live: ct.live, movie: ct.movies, series: ct.series };

        var tokens = q.split(' ');
        var res = [];
        // Candidate ceiling.
        //
        // Only MAX_RESULTS (~80) entries are ever displayed, but the scan used to
        // collect EVERY match, score it, and sort the lot before capping. On a
        // broad query against a 300k-entry index that means scoring and sorting
        // hundreds of thousands of entries to show 80 — the dominant cost of a
        // slow search.
        //
        // Collect a generous multiple of the display cap instead, so scoring still
        // has plenty of candidates to rank well, then stop. The sort then operates
        // on a bounded array rather than the whole index.
        //
        // NOTE this makes the result set order-dependent for very broad queries
        // (we may stop before seeing a late entry that would have scored highly).
        // That is an acceptable trade: such queries are not meaningfully
        // rankable anyway, and the alternative is sorting the entire catalog.
        // Narrow queries — the ones where ranking actually matters — never reach
        // the ceiling.
        var candidateCap = MAX_RESULTS * CANDIDATE_MULTIPLE;
        var stopped = false;
        // Scan the legacy INDEX (live + array-path entries) AND every streamed
        // bucket. Buckets keep each array under the engine's size ceiling.
        function scanArray(arr) {
            if (stopped) return;
            for (var i = 0; i < arr.length; i++) {
                var entry = arr[i];
                if (kindAllowed[entry.kind] === false) continue;
                if (entry.searchBlob.indexOf(q) < 0) {
                    var matchedAll = true;
                    for (var t = 0; t < tokens.length; t++) {
                        if (entry.searchBlob.indexOf(tokens[t]) < 0) {
                            matchedAll = false;
                            break;
                        }
                    }
                    if (!matchedAll) continue;
                }
                entry._score = scoreEntry(entry, q, tokens);
                res.push(entry);
                if (res.length >= candidateCap) { stopped = true; return; }
            }
        }
        scanArray(INDEX);
        for (var b = 0; b < BUCKETS.length; b++) scanArray(BUCKETS[b]);

        res.sort(function (a, b) {
            if (b._score !== a._score) return b._score - a._score;
            return (a.title || '').toLowerCase() < (b.title || '').toLowerCase() ? -1 : 1;
        });

        // Result cap comes from the performance policy (Lite narrows it for very
        // large catalogs). Falls back to the module default.
        var cap = MAX_RESULTS;
        try {
            if (typeof PerfConfig !== 'undefined') {
                var lim = PerfConfig.get('searchLimit');
                if (lim) cap = lim;
            }
        } catch (e) {}
        if (res.length > cap) res.length = cap;
        return res;
    }

    function isReady() { return INDEX_READY; }
    function count() { return INDEX.length + _bucketTotal; }

    /* Snapshot the slim index entries for one (kind, playlistId), for persisting
     * to IDB. Returns references to the ALREADY-BUILT bucket entries (no new
     * objects, no full-catalog copy) filtered by kind + playlist. These are the
     * exact slim entries the index holds — the whole point of Option B is that we
     * persist only what is already resident and bounded. Safe to call after a
     * stream completes; the caller writes the result via Store/IDB.putItems. */
    function exportSlim(kind, playlistId) {
        var out = [];
        for (var b = 0; b < BUCKETS.length; b++) {
            var bucket = BUCKETS[b];
            for (var i = 0; i < bucket.length; i++) {
                var e = bucket[i];
                if (e && e.kind === kind && e.playlistId === playlistId) {
                    out.push(e);
                }
            }
        }
        return out;
    }

    /* Rebuild path: append cached slim entries (as produced by exportSlim and
     * reloaded from IDB) straight into the buckets, rolling buckets at BUCKET_SIZE
     * exactly like addOne. The entries are already in final index shape, so no
     * re-derivation happens — a cache-rebuilt index is byte-identical to a
     * freshly-streamed one. Used by the launch freshness gate to skip the network
     * fetch + parse entirely. */
    function importSlim(entries) {
        if (!entries || !entries.length) return 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e) continue;
            if (!BUCKETS.length || BUCKETS[BUCKETS.length - 1].length >= BUCKET_SIZE) {
                BUCKETS.push([]);
            }
            BUCKETS[BUCKETS.length - 1].push(e);
            _bucketTotal++;
            markStreamed(e.kind, e.playlistName);
        }
        INDEX_READY = true;
        return entries.length;
    }

    /* Purge every entry of one (kind, playlistId) from the in-memory buckets.
     * Used when a content type is toggled OFF: the type's entries must leave the
     * search index (not just be hidden from browsing), and a later re-enable must
     * not create duplicates. Rebuilds the buckets keeping only non-matching
     * entries, re-rolling at BUCKET_SIZE, and recomputes _bucketTotal. Returns the
     * count removed. */
    function removeKind(kind, playlistId) {
        if (!BUCKETS.length) return 0;
        var kept = [];
        var removed = 0;
        for (var b = 0; b < BUCKETS.length; b++) {
            var bucket = BUCKETS[b];
            for (var i = 0; i < bucket.length; i++) {
                var e = bucket[i];
                if (e && e.kind === kind && (playlistId == null || e.playlistId === playlistId)) {
                    removed++;
                    delete STREAMED[streamKey(e.kind, e.playlistName)];
                } else {
                    kept.push(e);
                }
            }
        }
        // Re-chunk the kept entries into fresh buckets.
        BUCKETS = [];
        for (var k = 0; k < kept.length; k++) {
            if (!BUCKETS.length || BUCKETS[BUCKETS.length - 1].length >= BUCKET_SIZE) {
                BUCKETS.push([]);
            }
            BUCKETS[BUCKETS.length - 1].push(kept[k]);
        }
        _bucketTotal = kept.length;
        ADDED = {};
        return removed;
    }

    return {
        buildIndex: buildIndex,
        addItems: addItems,
        addOne: addOne,
        markStreamed: markStreamed,
        exportSlim: exportSlim,
        importSlim: importSlim,
        removeKind: removeKind,
        search: search,
        isReady: isReady,
        count: count
    };
})();
