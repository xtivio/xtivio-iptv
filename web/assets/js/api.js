/* api.js - external APIs (pairing server + Xtream Codes) */
var Api = (function () {
    'use strict';

    /* ---- Pairing ---- */
    // The pairing server exposes:
    //   POST /api/pair          -> { code, expiresAt }
    //   GET  /api/pair/:code    -> { status: 'pending' | 'completed', payload?: {...} }
    //   DELETE /api/pair/:code  -> close session after consumption
    //
    // A self-hosted Node.js implementation is included in the server folder.

    function createPairCode(deviceId) {
        var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/api/pair';
        return Util.xhr({
            method: 'POST',
            url: url,
            body: { deviceId: deviceId, ttl: APP_CONFIG.PAIR_CODE_TTL_MS },
            json: true
        }).then(function (r) { return r.body; });
    }
    function checkPairCode(code) {
        var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/api/pair/' + encodeURIComponent(code);
        return Util.xhr({ method: 'GET', url: url, json: true })
            .then(function (r) { return r.body; });
    }
    function closePairCode(code) {
        var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/api/pair/' + encodeURIComponent(code);
        return Util.xhr({ method: 'DELETE', url: url })
            ['catch'](function () {});
    }

    /* Upload an M3U/M3U8/PLS/TXT file's TEXT to the pairing server, which stores
     * it and returns a temporary hosted URL ({ url, expiresInSec }). Used by the
     * mobile "Upload M3U file" flow: the returned URL is then fed into the normal
     * M3U-URL playlist path, so an uploaded file becomes an ordinary m3u
     * playlist. The server (POST /api/upload) expects the raw file text as the
     * body, an X-Filename header, and text/plain content-type. Uploads are TTL'd
     * server-side, so the file should be indexed reasonably soon after upload —
     * which the app does on playlist load, matching the existing TV/web flow.
     *
     * fileText: the file's contents as a string.
     * filename: the original name (used only for extension/label; sanitised
     *           server-side). Defaults to playlist.m3u. */
    function uploadM3u(fileText, filename) {
        var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/api/upload';
        var name = filename || 'playlist.m3u';
        var headers = { 'Content-Type': 'text/plain; charset=utf-8' };
        try { headers['X-Filename'] = encodeURIComponent(name); } catch (e) { headers['X-Filename'] = 'playlist.m3u'; }
        return Util.xhr({
            method: 'POST',
            url: url,
            body: String(fileText == null ? '' : fileText),
            headers: headers,
            json: true,
            timeout: 60000
        }).then(function (r) { return r.body; });
    }

    /* ---- Stalker / MAG portal (direct where possible, else via pairing server) ----
     * A web page can't send the headers a MAG box sends (Cookie, Referer, User-Agent),
     * so on platforms without a native request helper all portal calls go through
     * our server, which emulates a MAG box (see stalkerCall below for the direct
     * path). LAZY model: load genres upfront, then a genre's channels only
     * when the user opens it (portals have tens of thousands of channels —
     * loading all would hammer the portal and risk a MAC ban). Stream URLs are
     * resolved per-play (tokens are ephemeral). */
    function stalkerBody(pl, extra) {
        var b = {
            url: pl.url, mac: pl.mac,
            serial: pl.serial || '', deviceId: pl.deviceId || ''
        };
        // Optional STB model (MAG250, AuraHD, custom). Sent only when set so the server keeps its default.
        if (pl.stbModel) b.stbModel = pl.stbModel;
        if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) b[k] = extra[k];
        return b;
    }
    function stalkerServerCall(path, pl, extra, timeoutMs) {
        var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/api/stalker/' + path;
        return Util.xhr({ method: 'POST', url: url, body: stalkerBody(pl, extra), json: true, timeout: timeoutMs })
            .then(function (r) { return r.body; });
    }
    /* Where the platform lets the app talk to the portal itself (Android, see stalker-direct.js) it does,
     * and the server is only asked when the portal could not be reached or gave no usable answer. A portal
     * that answers "no" (credentials, blocked, link limit) is reported as it is, not retried on the server.
     * Calls StalkerDirect does not handle (and platforms without it) go to the server. */
    function stalkerViaServer(path, pl, extra, timeoutMs) {
        return stalkerServerCall(path, pl, extra, timeoutMs).then(null, function (e) {
            // Server unreachable (or failing): the portal must not stay parked on it, or every retry fails the same way.
            if (window.StalkerDirect && (!e || !e.status || e.status >= 500)) { try { StalkerDirect.release(pl); } catch (eR) { /* ignore */ } }
            throw e;
        });
    }
    function stalkerCall(path, pl, extra, timeoutMs) {
        // webOS: the helper service answers a few seconds after the app opens (longer on a cold TV). A call that
        // arrives before that waits for it, up to 10 s, instead of going to the pairing server.
        if (window.StalkerDirect && window.PortalNet && PortalNet.starting() && StalkerDirect.handles(path) && StalkerDirect.wants(pl)) {
            return PortalNet.whenReady(10000).then(function () { return stalkerCallNow(path, pl, extra, timeoutMs); });
        }
        return stalkerCallNow(path, pl, extra, timeoutMs);
    }
    function stalkerCallNow(path, pl, extra, timeoutMs) {
        if (window.StalkerDirect && StalkerDirect.handles(path) && StalkerDirect.usable(pl)) {
            return StalkerDirect.run(path, pl, extra).then(null, function (e) {
                if (e && e.fallback) return stalkerViaServer(path, pl, extra, timeoutMs);
                throw e;
            });
        }
        if (window.StalkerDirect && StalkerDirect.handles(path)) return stalkerViaServer(path, pl, extra, timeoutMs);
        return stalkerServerCall(path, pl, extra, timeoutMs);
    }
    function stalkerGenres(pl) { return stalkerCall('genres', pl); }
    /* Called at save time, before
     * persisting a new Stalker source — see the matching Xtream probe and
     * the server's own doc comment on this route for the full rationale
     * and its one documented limitation (not every portal rejects an
     * unregistered MAC with an auth error at the protocol level). */
    function stalkerProbe(pl) { return stalkerCall('probe', pl); }
    function stalkerChannels(pl, genreId, maxPages) {
        return stalkerCall('channels', pl, { genreId: genreId, maxPages: maxPages });
    }
    /* Whole portal list in ONE streamed answer (server v74). Can be several MB and the portal may take
     * a while to start answering, hence the long timeout. Resolves { channels, total, complete } or
     * { unsupported: true } when the portal has no such action (then walk stalkerChannelsPage). */
    function stalkerChannelsAll(pl) { return stalkerCall('channels/all', pl, null, 180000); }
    /* One resumable slice of a genre: follow res.nextPage until it is null (server v74). */
    function stalkerChannelsPage(pl, genreId, maxPages, startPage) {
        return stalkerCall('channels', pl, { genreId: genreId, maxPages: maxPages, startPage: startPage }, 120000);
    }
    /* fresh = the saved link failed to play: the server asks the portal for a new one. */
    function stalkerResolve(pl, cmd, channelId, genreId, fresh) {
        var extra = { cmd: cmd, channelId: channelId, genreId: genreId };
        if (fresh) extra.fresh = true;
        return stalkerCall('resolve', pl, extra);
    }
    /* Catch-up: finished programmes of one channel (hours = its archive length), and the portal's archive link for one. */
    function stalkerArchive(pl, channelId, hours) { return stalkerCall('archive', pl, { channelId: channelId, hours: hours }, 60000); }
    function stalkerArchiveResolve(pl, programmeId) { return stalkerCall('archive/resolve', pl, { programmeId: programmeId }); }
    function stalkerVodCategories(pl) { return stalkerCall('vod/categories', pl); }
    function stalkerVodItems(pl, categoryId, maxPages) {
        return stalkerCall('vod/items', pl, { categoryId: categoryId, maxPages: maxPages });
    }
    /* openId: the row to open down to a file when its own cmd has nothing to play (a container row). */
    function stalkerVodResolve(pl, cmd, openId) {
        var extra = { cmd: cmd };
        if (openId) { extra.openId = String(openId); extra.openParam = 'movie_id'; }
        return stalkerCall('vod/resolve', pl, extra);
    }
    function stalkerSeriesCategories(pl) { return stalkerCall('series/categories', pl); }
    function stalkerSeriesItems(pl, categoryId, maxPages) {
        return stalkerCall('series/items', pl, { categoryId: categoryId, maxPages: maxPages });
    }
    /* Session cache for Stalker series/seasons — the parallel of the Xtream
     * get_series_info cache. Opening a Stalker series' episode list POSTs to
     * series/seasons, and the whole-series season+episode payload doesn't change
     * within a session, yet every open of the SAME series used to re-request and
     * re-parse it (slow to open every time, in both card and list view, since both
     * funnel through here). This memoises the resolved response per
     * (playlistId|seriesId|maxPages): the first open is unchanged, re-opens are
     * instant (Promise.resolve, no network). Capped with oldest-eviction so a long
     * browse can't grow the heap without bound (TV memory is tight). Only usable
     * (season-bearing) responses are cached — an error or empty body is left
     * uncached so a transient portal failure can be retried on the next open. */
    var STALKER_SEASONS_CACHE = {};
    var stalkerSeasonsOrder = [];
    var STALKER_SEASONS_CACHE_MAX = 40;

    function stalkerSeasonsKey(pl, seriesId, maxPages) {
        return String((pl && pl.id) || (pl && pl.url) || '') + '|' + String(seriesId) + '|' + String(maxPages == null ? '' : maxPages);
    }
    function stalkerSeriesSeasons(pl, seriesId, maxPages) {
        var key = stalkerSeasonsKey(pl, seriesId, maxPages);
        if (STALKER_SEASONS_CACHE.hasOwnProperty(key)) {
            return Promise.resolve(STALKER_SEASONS_CACHE[key]);
        }
        return stalkerCall('series/seasons', pl, { seriesId: seriesId, maxPages: maxPages })
            .then(function (res) {
                // Cache only a usable response (has seasons). Leave failures and
                // empty bodies uncached so they can be retried on the next open.
                if (res && res.seasons && res.seasons.length) {
                    if (!STALKER_SEASONS_CACHE.hasOwnProperty(key)) {
                        stalkerSeasonsOrder.push(key);
                        if (stalkerSeasonsOrder.length > STALKER_SEASONS_CACHE_MAX) {
                            var evict = stalkerSeasonsOrder.shift();
                            delete STALKER_SEASONS_CACHE[evict];
                        }
                    }
                    STALKER_SEASONS_CACHE[key] = res;
                }
                return res;
            });
    }
    /* Drop cached Stalker seasons. No arg clears all (e.g. on playlist
     * switch/refresh); a (pl, seriesId[, maxPages]) clears just that entry. Kept
     * exported for a future "refresh series" action. */
    function clearStalkerSeriesSeasonsCache(pl, seriesId, maxPages) {
        if (pl == null && seriesId == null) {
            STALKER_SEASONS_CACHE = {};
            stalkerSeasonsOrder = [];
            return;
        }
        var key = stalkerSeasonsKey(pl, seriesId, maxPages);
        if (STALKER_SEASONS_CACHE.hasOwnProperty(key)) {
            delete STALKER_SEASONS_CACHE[key];
            var i = stalkerSeasonsOrder.indexOf(key);
            if (i !== -1) stalkerSeasonsOrder.splice(i, 1);
        }
    }
    function stalkerSeriesResolve(pl, cmd, episode) {
        return stalkerCall('series/resolve', pl, { cmd: cmd, episode: episode });
    }
    function stalkerEpg(pl, channelId) { return stalkerCall('epg', pl, { channelId: channelId }); }
    // Batched short-EPG: one request for up to a page's worth of channels
    // instead of one request per channel. The server's per-IP rate limit is
    // shared across every Stalker list-type call (genres/channels/vod/series/
    // epg alike, 30/minute) — a per-channel EPG loop could need 50 requests
    // for a single page, nowhere near fitting that budget no matter how it's
    // paced. This turns that into 1 request; the server fans out to the
    // portal itself, unaffected by our own app-facing limiter. Response:
    // { epg: { <channelId>: [...programmes] } }.
    function stalkerEpgBatch(pl, channelIds) { return stalkerCall('epg/batch', pl, { channelIds: channelIds }); }

    /* ---- Xtream Codes ---- */
    // Xtream provides:
    //   /player_api.php?username=&password=&action=get_live_categories
    //   /player_api.php?username=&password=&action=get_live_streams[&category_id=]
    //   /player_api.php?username=&password=  (user info + server info)
    //   Stream URL:     /live/USER/PASS/STREAM_ID.m3u8   (HLS)
    //              or   /live/USER/PASS/STREAM_ID.ts     (TS, fallback)
    //
    // EPG (XMLTV):
    //   /xmltv.php?username=&password=
    //
    // Some providers only serve .ts; we attempt HLS first then fall back in the player.

    function buildXtreamPlayerBase(host) {
        return host.replace(/\/$/, '') + '/player_api.php';
    }
    function xtreamRequest(host, user, pass, action, extraParams) {
        var url = buildXtreamPlayerBase(host) + '?username=' +
                  encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);
        if (action) url += '&action=' + encodeURIComponent(action);
        if (extraParams) {
            for (var k in extraParams) {
                if (extraParams.hasOwnProperty(k)) {
                    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]);
                }
            }
        }
        return Util.xhr({ method: 'GET', url: url, timeout: 60000 })
            .then(function (r) {
                var body = r.body;
                if (typeof body === 'string') {
                    try { body = JSON.parse(body); } catch (e) { throw { status: r.status, err: 'bad-json' }; }
                }
                return body;
            });
    }

    /* Chunked text fetch + parse for large Xtream array responses.
     * Fetches as text, splits on object boundaries, parses in small batches
     * via setTimeout to keep the UI responsive on slow TVs. */
    function xtreamAllStreamsChunked(host, user, pass) {
        var url = buildXtreamPlayerBase(host) + '?username=' +
                  encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) +
                  '&action=get_live_streams';
        // Byte cap on the LIVE payload.
        //
        // This path previously had NO byte budget at all, while movies and series
        // both did. That was a real hole: a provider with a very large channel
        // list would buffer the whole response as one string and reproduce exactly
        // the OOM the byte cap exists to prevent — same mechanism, different
        // endpoint. Measured payloads for reference (merged provider): live
        // ~24.4MB (~77k channels, ~317 B/channel) vs a ~66MB budget, so the cap
        // does not bite a normal provider — it is insurance against a pathological
        // one.
        //
        // Live is loaded FIRST, against an empty index, so it has the whole heap
        // to itself (unlike series, which collides with a large resident movie
        // index). The same 0.19 fraction is therefore comfortably safe here.
        //
        // truncateAt (rather than plain maxBytes) means an over-budget payload is
        // cut and the PREFIX is kept, instead of the request being rejected
        // outright. The parser stops at the last complete object.
        var budget = catalogByteBudget();
        var opts = { method: 'GET', url: url, timeout: 90000 };
        if (budget) {
            opts.maxBytes = budget;
            opts.truncateAt = true;
        }
        return Util.xhr(opts)
            .then(function (r) {
                var text = r.body;
                var wasTruncated = !!(r && r.truncated);
                if (wasTruncated) {
                    if (window.console && console.log) {
                        Log.log('[live] channel list exceeded the device budget (' +
                            Math.floor(budget / 1048576) + 'MB) — download stopped at ' +
                            Math.floor((r.bytes || 0) / 1048576) + 'MB. Some channels ' +
                            'could not be loaded.');
                    }
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.noteLiveCapHit) PerfConfig.noteLiveCapHit(0, (r && r.bytes) || 0); } catch (eLc) {}
                }
                // A non-array body is a FAILURE, not an empty channel list. This
                // path used to swallow it (return []), which is the same silent-zero
                // bug that was previously fixed for movies/series: a transient provider
                // error would render as "you have no channels" rather than an error.
                if (!text || typeof text !== 'string') {
                    throw { err: 'live-failed', reason: 'empty response',
                            userMessage: 'The provider did not return a channel list. Try refreshing the playlist.' };
                }
                text = text.trim();
                if (text.charAt(0) !== '[') {
                    var arr = null;
                    try { arr = JSON.parse(text); } catch (eP) { arr = null; }
                    if (arr && arr.length) return arr;
                    if (window.console && console.log) {
                        Log.log('[live] provider did not return a channel array. len=' +
                            text.length + ' body[0:200]=' + text.substring(0, 200));
                    }
                    throw { err: 'live-failed', reason: 'non-array response',
                            sample: text.substring(0, 200),
                            userMessage: 'The provider did not return a channel list. Try refreshing the playlist.' };
                }
                // Strip the outer brackets. A TRUNCATED payload has no closing
                // ']' (it was cut mid-object), so blindly removing the last
                // character would chop a byte off a real object instead. Only
                // strip the tail when it is actually the closing bracket.
                //
                // The parser itself tolerates a ragged tail: it emits an object
                // only when brace depth returns to 0, so an incomplete trailing
                // object is simply never produced.
                var endIdx = text.length;
                if (text.charAt(endIdx - 1) === ']') endIdx = endIdx - 1;
                text = text.substring(1, endIdx).trim();
                if (!text) return [];
                return parseJsonArrayChunked(text);
            });
    }

    function parseJsonArrayChunked(text, onObject) {
        // Parse a large JSON array of objects, yielding often so the garbage
        // collector can keep up. Each object is parsed via a transient
        // text.substring(...) that lives only until JSON.parse consumes it.
        //
        // Two modes:
        //  - No onObject: accumulate into an array and resolve with it (legacy
        //    behaviour; used by callers that want the whole array, e.g. live).
        //  - onObject(obj) provided: call it for each parsed object and DO NOT
        //    accumulate — resolve with { count: N, capped: bool }. This is the
        //    streaming path that lets a huge catalog be indexed/cached without
        //    ever holding the full parsed array (the working-set OOM fix).
        var streaming = (typeof onObject === 'function');
        var SCAN_CHUNK_CHARS = 64000;   // smaller synchronous burst
        var YIELD_EVERY_OBJECTS = 2000; // also yield after this many objects
        // GC breather schedule. A 0ms yield is a macrotask boundary, but the
        // engine resumes allocating almost immediately, so a major GC never gets
        // a window to complete. Every BREATHER_EVERY_OBJECTS parsed objects we
        // take a real idle pause instead — which is what the debugger pause was
        // doing by accident when it gave the full catalog room to parse.
        //
        // Cost is negligible, so the pause can be generous. The device parses
        // ~10k objects/sec, so a breather every 10k objects fires roughly once a
        // second. Across a full 217k-object catalog (movies + series) that is ~21
        // breathers; at 120ms each that adds ~2.5s to a parse that already takes
        // ~51s — under 5%, in exchange for not crashing.
        var BREATHER_EVERY_OBJECTS = 10000;
        var BREATHER_MS = 120;
        var _lastBreatherAt = 0;
        var maxObjects = 250000;
        try {
            if (typeof PerfConfig !== 'undefined') {
                var cap = PerfConfig.get('maxParseObjects');
                if (cap) maxObjects = cap;
            }
        } catch (ePerf) {}
        // Last-resort byte ceiling.
        //
        // NOTE this is a BACKSTOP, not the primary defence. The device OOM was
        // diagnosed (via a debugger pause, after which the full catalog completed and
        // stay resident) as TRANSIENT allocation pressure during the parse, not
        // retained data — the full 55k live + 172k movies + 45k series FITS. The
        // real fix is the GC breather below, which gives the collector the idle
        // window it was never getting.
        //
        // So this ceiling must sit high enough that it does NOT truncate catalogs
        // the breather can now handle. It exists only to stop a pathologically
        // large payload from being buffered on a genuinely tiny heap.
        //
        // History: it previously read Math.max(heap * 0.25, 96000000). The
        // Math.max FLOORED it at 96M chars (~192MB UTF-16), pushing the ceiling
        // ABOVE the 92M-char payload that crashed a 347MB device — so it never
        // fired on the only payload that mattered. A floor here disables the
        // guard; do not reintroduce one.
        //
        // 0.35 * heap = ~127M chars on a 347MB device, comfortably above the 92M
        // payload that now parses fine with the breather, while still bounding a
        // truly absurd payload on a small heap.
        var maxScanChars = 0; // 0 = no ceiling (only when heap size is unknown)
        try {
            var heap = (typeof performance !== 'undefined' && performance.memory) ? performance.memory.jsHeapSizeLimit : 0;
            if (heap) {
                maxScanChars = Math.floor(heap * 0.35);
            }
        } catch (eHeap) {}
        var objects = streaming ? null : [];
        var count = 0;
        var capped = false;

        return new Promise(function (resolve) {
            var i = 0;
            var depth = 0;
            var start = 0;
            var inString = false;
            var escaped = false;

            function emit(obj) {
                if (streaming) {
                    try { onObject(obj); } catch (eCb) {}
                } else {
                    objects.push(obj);
                }
                count++;
            }

            function scanSlice() {
                // Yield priority to an open parental manager BEFORE processing this
                // slice. The gate was previously only checked at the BOTTOM (to pick
                // the next delay), so each 150ms tick still parsed and indexed a full
                // ~64000-char slice (~95 objects) while "paused" — the index kept
                // advancing (probe showed 59 -> 1226 across a 3s pause). Checking here
                // and returning WITHOUT processing makes the pause a true halt: no
                // objects are parsed or handed to addOne until the manager closes. The
                // parse state lives in closure vars (i/depth/inString/escaped/start),
                // so resuming re-enters exactly where we stopped.
                if (!capped && i < text.length &&
                    Util.shouldPauseBgWork && Util.shouldPauseBgWork()) {
                    setTimeout(scanSlice, 150);
                    return;
                }
                var sliceEnd = Math.min(i + SCAN_CHUNK_CHARS, text.length);
                var objectsThisBurst = 0;
                var yieldNow = false;
                for (; i < sliceEnd; i++) {
                    var ch = text.charAt(i);
                    if (inString) {
                        if (escaped) { escaped = false; }
                        else if (ch === '\\') { escaped = true; }
                        else if (ch === '"') { inString = false; }
                        continue;
                    }
                    if (ch === '"') { inString = true; }
                    else if (ch === '{') { if (depth === 0) start = i; depth++; }
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            // Parse this object immediately and drop the slice —
                            // no boundaries array to accumulate.
                            try {
                                emit(JSON.parse(text.substring(start, i + 1)));
                            } catch (e) {
                                // Skip malformed object
                            }
                            if (count >= maxObjects) {
                                capped = true;
                                break;
                            }
                            if (maxScanChars && i >= maxScanChars) {
                                // Emergency byte ceiling reached — stop at this
                                // completed object rather than risk OOM walking
                                // the rest of an oversized payload on a small heap.
                                capped = true;
                                break;
                            }
                            // Yield mid-burst once enough objects have been parsed,
                            // so the transient substrings can be collected before
                            // we allocate the next batch.
                            objectsThisBurst++;
                            if (objectsThisBurst >= YIELD_EVERY_OBJECTS) {
                                i++; // resume past this closing brace next time
                                yieldNow = true;
                                break;
                            }
                        }
                    }
                }
                if (capped) {
                    if (window.console && console.log) {
                        var reason = (maxScanChars && i >= maxScanChars && count < maxObjects)
                            ? ('byte ceiling reached (~' + Math.floor(i / 1000000) + 'M chars)')
                            : ('object cap reached (' + maxObjects + ')');
                        Log.log('[Parse] ' + reason +
                            '; truncating large catalog to protect memory');
                    }
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.noteCapHit) PerfConfig.noteCapHit(); } catch (eCap) {}
                    resolve(streaming ? { count: count, capped: true } : objects);
                    return;
                }
                if (i < text.length && !capped) {
                    // GC breather.
                    //
                    // The crash this addresses is NOT retained data — a debugger
                    // pause on the OOM guard, then resume, allowed the FULL catalog
                    // (55k live + 172k movies + 45k series) complete and stay
                    // resident. It fits. The crash is TRANSIENT allocation
                    // pressure during the parse: every object allocates a
                    // text.substring(...) which is JSON.parsed and then dropped,
                    // and the indexing of each object allocates further
                    // intermediates. That garbage piles up faster than GC can
                    // reclaim it. The debugger pause worked purely because it gave
                    // GC an idle window it otherwise never gets.
                    //
                    // The previous form of this could never fire:
                    //
                    //     var longYield = (count % 50000 === 0 && yieldNow);
                    //
                    // yieldNow is only set when the YIELD_EVERY_OBJECTS (2000)
                    // break is taken — but SCAN_CHUNK_CHARS (64000) binds first at
                    // roughly 95 objects per slice, so that break is never reached
                    // and yieldNow is always false. The whole clause collapsed to
                    // false and EVERY burst yielded with 0ms. Across a 92M-char
                    // payload that is ~1437 bursts with nothing but 0ms macrotask
                    // gaps — no real GC window anywhere in the parse.
                    //
                    // Now the breather is driven by the object count alone, so it
                    // actually fires. A 0ms yield is a macrotask boundary but the
                    // engine returns to allocating almost immediately; a longer
                    // idle window is what lets a major GC run to completion.
                    var longYield = (count > 0 && count - _lastBreatherAt >= BREATHER_EVERY_OBJECTS);
                    if (longYield) _lastBreatherAt = count;
                    // Yield priority to an open parental manager: the parse holds all
                    // its state in closure vars (i/depth/inString/escaped/start), so
                    // deferring the next slice is safe — we resume mid-catalog exactly
                    // where we stopped once the manager closes. Re-check every 150ms.
                    if (Util.shouldPauseBgWork && Util.shouldPauseBgWork()) {
                        setTimeout(scanSlice, 150);
                    } else {
                        setTimeout(scanSlice, longYield ? BREATHER_MS : 0);
                    }
                } else if (!capped) {
                    resolve(streaming ? { count: count, capped: false } : objects);
                }
            }

            setTimeout(scanSlice, 10);
        });
    }

    function xtreamAuth(host, user, pass) {
        return xtreamRequest(host, user, pass, null)
            .then(function (body) {
                if (!body || !body.user_info) throw { err: 'auth-failed', body: body };
                // Some portals respond HTTP 200 with user_info PRESENT but the
                // credentials explicitly rejected (auth: 0/"0"/false) rather than
                // omitting user_info entirely — the check above alone missed this
                // real response shape. Absence of the field is NOT a failure (some
                // portals don't send it on a valid account), only an explicit falsy
                // value is.
                var auth = body.user_info.auth;
                if (auth === 0 || auth === '0' || auth === false) throw { err: 'auth-failed', body: body };
                return body;
            });
    }

    function xtreamCategories(host, user, pass) {
        return xtreamRequest(host, user, pass, 'get_live_categories');
    }
    function xtreamStreams(host, user, pass, categoryId) {
        var params = categoryId ? { category_id: categoryId } : null;
        return xtreamRequest(host, user, pass, 'get_live_streams', params);
    }

    function xtreamStreamUrl(host, user, pass, streamId, format) {
        var base = host.replace(/\/$/, '');
        // HLS preferred
        if (format === 'm3u8') return base + '/live/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + streamId + '.m3u8';
        // TS fallback (raw)
        return base + '/live/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + streamId + '.ts';
    }

    /* Provider's own programme table for one stream, including past programmes (catch-up). */
    function xtreamEpgTable(host, user, pass, streamId) {
        return xtreamRequest(host, user, pass, 'get_simple_data_table', { stream_id: streamId });
    }

    function xtreamEpgUrl(host, user, pass) {
        return host.replace(/\/$/, '') + '/xmltv.php?username=' +
               encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);
    }

    /* ---- VOD (Movies) ---- */
    function xtreamVodCategories(host, user, pass) {
        return xtreamRequest(host, user, pass, 'get_vod_categories');
    }
    function xtreamVodStreams(host, user, pass, categoryId) {
        var params = categoryId ? { category_id: categoryId } : null;
        return xtreamRequest(host, user, pass, 'get_vod_streams', params);
    }
    /* Streaming variant of the movies fetch (mirrors xtreamAllSeriesStreaming):
     * emits each parsed VOD object via onObject and resolves { count, capped },
     * never accumulating the full array. */
    /* Shared body handler for the streaming catalog fetches (movies + series).
     *
     * The bug this exists to prevent: a transient provider failure used to be
     * reported as a SUCCESSFUL fetch of zero items. Seen on a fresh install —
     * a movie request "completed" in 513ms with 0 objects (a healthy run takes
     * ~28s and returns 173k), and the app rendered an empty movie catalog as
     * though that were the truth. No log, no toast, nothing. The same playlist
     * loaded fine minutes later, so it was provider load-shedding, almost
     * certainly triggered by hammering get_vod_streams straight after pulling a
     * 68MB EPG and a 55k channel list.
     *
     * A non-array body means the provider did NOT give us a catalog. That is a
     * FAILURE, and it must be reported as one — never as an empty catalog. The
     * only legitimate zero is a well-formed empty array.
     *
     * Returns { count, capped } on success, or throws { err:'bad-body', ... } so
     * the caller can retry and ultimately surface the failure. */
    function handleStreamBody(kind, text, onObject) {
        if (!text || typeof text !== 'string') {
            throw { err: 'bad-body', kind: kind, reason: 'empty response', sample: '' };
        }
        text = text.trim();
        if (text.charAt(0) === '[') {
            return parseJsonArrayChunked(text, onObject);
        }
        // Not an array. It may still be a valid (if unusual) JSON array-like
        // payload from a non-standard panel — accept that, but ONLY when it
        // actually yields items.
        var arr = null;
        try { arr = JSON.parse(text); } catch (eP) { arr = null; }
        if (arr && arr.length) {
            for (var k = 0; k < arr.length; k++) onObject(arr[k]);
            return { count: arr.length, capped: false };
        }
        // Anything else — an error object, an auth blob, an HTML error page, a
        // rate-limit notice, an empty string — is a failed fetch. Log what the
        // provider actually sent (truncated, and credentials never appear in a
        // response body) so this stops being a mystery zero.
        var sample = text.substring(0, 200);
        if (window.console && console.log) {
            Log.log('[' + kind + '] provider did not return a catalog array. ' +
                'len=' + text.length + ' body[0:200]=' + sample);
        }
        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(kind + ' BAD BODY len=' + text.length + ' :: ' + sample.substring(0, 80)); } catch (eB) {}
        throw { err: 'bad-body', kind: kind, reason: 'non-array response', sample: sample, len: text.length };
    }

    /* Run a streaming catalog fetch with retries.
     *
     * The observed failure is transient (the same request succeeded minutes
     * later, and the series fetch — issued ~25s afterwards — succeeded in the very
     * run where movies failed), so a retry with backoff should recover most
     * occurrences. Backoff is generous because the suspected cause is the provider
     * shedding load after the EPG + channel burst; retrying instantly would just
     * be hammering it again.
     *
     * onObject may have already been called with some items before a failure, so
     * the caller must be able to tolerate a partial index on the final give-up
     * (it reports what it indexed, which is honest). */
    /* Heap-scaled download budget for the big catalog payloads.
     *
     * THIS is the guard that actually bounds memory. The scan ceiling inside
     * parseJsonArrayChunked (maxScanChars) only stops the PARSE — by the time it
     * runs, Util.xhr has already buffered the entire response as one string, so
     * the string is resident regardless of where the scan stops. Capping the scan
     * saves index entries; it does not save the string.
     *
     * Peak memory during a catalog load is:
     *
     *     (buffered response string, ~2 bytes/char UTF-16) + (search index entries)
     *
     * CALIBRATION (empirical, on a 347MB WebOS 6.5 device).
     *
     * The failure mode is a COLLISION, not a payload size. Peak is
     * buffered string + resident index, and because movies is parsed BEFORE
     * series, the series step always pays for whatever movies left behind. The
     * decisive number is therefore the INDEX SIZE WHEN SERIES STARTS:
     *
     *   budget  movies indexed  index at series start  outcome
     *   0.19    208,768         285,764                SURVIVED (364,656 total)
     *   0.205   225,215         302,175                CRASHED (~362k)
     *   0.22    240,399         317,395                CRASHED (~337k)
     *
     * So the threshold sits between 285,764 and 302,175 entries. Every extra movie
     * indexed makes the series step more likely to die — raising the movie budget
     * actively increases the risk to series.
     *
     * MEASURED single-provider payloads (curl):
     *   movies 70,529,372 B (67.26MB) -> needs fraction >= 0.19378  <-- binding
     *   series 65,315,603 B (62.29MB) -> needs fraction >= 0.17946
     *
     * 0.195 (~67.7MB) is chosen because it is simultaneously:
     *
     *   a) the MINIMUM that loads the largest single provider in full. That
     *      playlist has always worked on this device, so truncating it was a
     *      regression (the old 0.19 cap = 65.9MB cut its 67.26MB movies by ~1.4MB).
     *      0.19378 is the exact break-even; 0.195 adds ~0.42MB of margin so that a
     *      provider adding a few titles does not suddenly start truncating.
     *
     *   b) the SAFEST choice for the merged playlist. It is barely above 0.19, so
     *      it indexes only slightly more movies than the 0.19 run that survived,
     *      keeping the index near the known-good ~286k at series start rather than
     *      the ~302k that died.
     *
     * Going higher buys nothing on the single provider (already full at 0.195) while
     * increasing merged crash risk. Going lower re-truncates a known-good playlist.
     *
     * IF THIS STILL CRASHES on the merged playlist, one shared constant is the wrong
     * shape and the fix is an ASYMMETRIC budget: keep movies at 0.195 (needed for the
     * single provider) and give SERIES less (its single-provider payload is only
     * 62.29MB, so it can afford ~0.18), because series is the kind doing the
     * dangerous work against a loaded index.
     *
     * Larger catalogs are TRUNCATED rather than crashing: the download is aborted,
     * the prefix is parsed to the last complete object, and the user gets a partial
     * index plus the persistent notice. Browsing still reaches everything (content
     * screens fetch per category on demand).
     *
     * Applied to movies, series AND live (live via xtreamAllStreamsChunked).
     *
     * Returns 0 (no cap) when the heap size is unknown — never degrade blindly. */
    function catalogByteBudget() {
        try {
            var mem = (typeof performance !== 'undefined') ? performance.memory : null;
            var heap = mem && mem.jsHeapSizeLimit ? mem.jsHeapSizeLimit : 0;
            if (!heap) return 0;
            return Math.floor(heap * 0.195);
        } catch (e) { return 0; }
    }

    function fetchCatalogStreaming(kind, url, onObject, attemptsLeft, delayMs) {
        if (attemptsLeft == null) attemptsLeft = 3;
        if (delayMs == null) delayMs = 2000;
        var budget = catalogByteBudget();
        var opts = { method: 'GET', url: url, timeout: 120000 };
        if (budget) {
            opts.maxBytes = budget;
            opts.truncateAt = true;   // keep the prefix; do not reject
        }
        return Util.xhr(opts)
            .then(function (r) {
                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(kind + ' payload received ' + (r && r.body ? r.body.length : 0) + 'B' + (r && r.truncated ? ' (TRUNCATED at budget)' : '')); } catch (eBpay) {}
                if (r && r.truncated) {
                    if (window.console && console.log) {
                        Log.log('[' + kind + '] payload exceeded the device budget (' +
                            Math.floor(budget / 1048576) + 'MB) — download stopped at ' +
                            Math.floor((r.bytes || 0) / 1048576) + 'MB. Indexing the prefix; ' +
                            'search will cover part of the catalog.');
                    }
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.noteCapHit) PerfConfig.noteCapHit(kind); } catch (eNc) {}
                }
                // handleStreamBody returns the PARSER's result, and for the normal
                // array path that is a PROMISE, not a plain object. An earlier
                // revision did:
                //
                //     var parsed = handleStreamBody(...);
                //     if (parsed && r.truncated) parsed.truncated = true;
                //
                // which set the flag on the PROMISE rather than on its resolved
                // value, so the caller never saw it and the log kept reporting
                // "Indexed 208573 of 208573" as though coverage were complete.
                //
                // Resolve first, then tag the result. Wrapped in Promise.resolve so
                // both the promise path and the synchronous non-array fallback path
                // are handled.
                var wasTruncated = !!(r && r.truncated);
                var truncBytes = (r && r.bytes) || 0;
                return Promise.resolve(handleStreamBody(kind, r.body, onObject))
                    .then(function (parsed) {
                        if (parsed && wasTruncated) {
                            parsed.truncated = true;
                            parsed.truncatedAtBytes = truncBytes;
                        }
                        return parsed;
                    });
            })['catch'](function (err) {
                if (err && err.err === 'too-large') {
                    if (window.console && console.log) {
                        Log.log('[' + kind + '] payload too large (' + (err.bytes || '?') +
                            ' bytes) — skipped to protect memory');
                    }
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.noteCapHit) PerfConfig.noteCapHit(kind); } catch (e2) {}
                    return { count: 0, capped: true };
                }
                var retryable = !!(err && (err.err === 'bad-body' || err.status >= 500 || err.status === 429 || !err.status));
                if (retryable && attemptsLeft > 1) {
                    if (window.console && console.log) {
                        Log.log('[' + kind + '] fetch failed (' +
                            ((err && (err.reason || err.err || err.status)) || 'unknown') +
                            ') — retrying in ' + delayMs + 'ms (' + (attemptsLeft - 1) + ' left)');
                    }
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            resolve(fetchCatalogStreaming(kind, url, onObject, attemptsLeft - 1, delayMs * 2));
                        }, delayMs);
                    });
                }
                // Out of retries. Do NOT resolve with a zero count — that is what
                // made this bug invisible. Reject so the caller can tell the user
                // the catalog failed to load rather than showing an empty one.
                return Promise.reject({
                    err: 'catalog-failed',
                    kind: kind,
                    cause: (err && (err.reason || err.err || err.status)) || 'unknown',
                    sample: (err && err.sample) || ''
                });
            });
    }

    function xtreamAllVodStreamsStreaming(host, user, pass, onObject) {
        var url = buildXtreamPlayerBase(host) + '?username=' +
                  encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) +
                  '&action=get_vod_streams';
        // No maxBytes cap here: this is the STREAMING path, whose whole purpose is
        // to handle payloads too large to hold as one parsed object. The response
        // text is walked incrementally by parseJsonArrayChunked and only slim
        // index entries are retained, so a big catalog no longer needs the byte
        // abort that the non-streaming (…Chunked) fetches still use. Capping here
        // aborted the download on large catalogs and zeroed out the whole kind.
        return fetchCatalogStreaming('movie', url, onObject);
    }

    /* Streaming variant of the series fetch: instead of resolving with the full
     * parsed array, it calls onObject(seriesItem) for each parsed object and
     * resolves with { count, capped }. The raw response string is still buffered
     * by responseText (unavoidable with XHR), but the parsed OBJECTS are never
     * accumulated into an array — the caller indexes + caches each and discards
     * it, so a huge series catalog is handled without the 45k-object array that
     * OOM'd on the small heap. */
    function xtreamAllSeriesStreaming(host, user, pass, onObject) {
        var url = buildXtreamPlayerBase(host) + '?username=' +
                  encodeURIComponent(user) + '&password=' + encodeURIComponent(pass) +
                  '&action=get_series';
        // No maxBytes cap: streaming path, parsed incrementally by
        // parseJsonArrayChunked (see xtreamAllVodStreamsStreaming for rationale).
        // The 18%-heap cap here was aborting the get_series download on large
        // catalogs, which surfaced as "0 series indexed" plus a truncation
        // warning even after wiping stored data (the abort is on the live
        // download size, not anything cached).
        return fetchCatalogStreaming('series', url, onObject);
    }
    function xtreamVodInfo(host, user, pass, vodId) {
        return xtreamRequest(host, user, pass, 'get_vod_info', { vod_id: vodId });
    }
    function xtreamVodUrl(host, user, pass, streamId, ext) {
        var base = host.replace(/\/$/, '');
        return base + '/movie/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + streamId + '.' + (ext || 'mp4');
    }

    /* ---- Series ---- */
    function xtreamSeriesCategories(host, user, pass) {
        return xtreamRequest(host, user, pass, 'get_series_categories');
    }
    function xtreamSeries(host, user, pass, categoryId) {
        var params = categoryId ? { category_id: categoryId } : null;
        return xtreamRequest(host, user, pass, 'get_series', params);
    }
    /* Session cache for get_series_info.
     *
     * Opening a series' episode list calls get_series_info, whose response is the
     * WHOLE series (every season, every episode + metadata) — the largest per-item
     * payload the app fetches. Nothing here changes between opens within a session,
     * yet every open of the SAME series used to re-request and re-parse it, so the
     * episode modal was slow to open every time — including in list view, since
     * both views funnel through here. This memoises the resolved info per
     * (host|user|seriesId): the first open is unchanged, and re-opens are instant
     * (Promise.resolve, no network, no re-parse). It is capped so a long session of
     * browsing many series can't grow the heap without bound (TV memory is tight);
     * on overflow the oldest entry is evicted. Only successful, episode-bearing
     * responses are cached — an error or empty body is never stored, so a transient
     * provider failure doesn't get pinned for the session.
     */
    var SERIES_INFO_CACHE = {};
    var seriesInfoOrder = [];
    var SERIES_INFO_CACHE_MAX = 40;

    function seriesInfoCacheKey(host, user, seriesId) {
        return String(host) + '|' + String(user) + '|' + String(seriesId);
    }
    function xtreamSeriesInfo(host, user, pass, seriesId) {
        var key = seriesInfoCacheKey(host, user, seriesId);
        if (SERIES_INFO_CACHE.hasOwnProperty(key)) {
            return Promise.resolve(SERIES_INFO_CACHE[key]);
        }
        return xtreamRequest(host, user, pass, 'get_series_info', { series_id: seriesId })
            .then(function (info) {
                // Cache only a usable response (has episodes). Leave failures and
                // empty bodies uncached so they can be retried on the next open.
                if (info && info.episodes) {
                    if (!SERIES_INFO_CACHE.hasOwnProperty(key)) {
                        seriesInfoOrder.push(key);
                        if (seriesInfoOrder.length > SERIES_INFO_CACHE_MAX) {
                            var evict = seriesInfoOrder.shift();
                            delete SERIES_INFO_CACHE[evict];
                        }
                    }
                    SERIES_INFO_CACHE[key] = info;
                }
                return info;
            });
    }
    /* Drop cached series info. No arg clears all (e.g. on playlist switch/refresh);
     * a seriesId clears just that entry. Kept exported so a future "refresh series"
     * action can force a fresh fetch without a full reload. */
    function clearXtreamSeriesInfoCache(host, user, seriesId) {
        if (seriesId == null) {
            SERIES_INFO_CACHE = {};
            seriesInfoOrder = [];
            return;
        }
        var key = seriesInfoCacheKey(host, user, seriesId);
        if (SERIES_INFO_CACHE.hasOwnProperty(key)) {
            delete SERIES_INFO_CACHE[key];
            var i = seriesInfoOrder.indexOf(key);
            if (i !== -1) seriesInfoOrder.splice(i, 1);
        }
    }
    function xtreamSeriesEpisodeUrl(host, user, pass, episodeId, ext) {
        var base = host.replace(/\/$/, '');
        return base + '/series/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) + '/' + episodeId + '.' + (ext || 'mp4');
    }

    /* ---- M3U fetch ---- */
    function fetchText(url, headers) {
        var opts = { method: 'GET', url: url, timeout: 60000 };
        if (headers) opts.headers = headers;
        return Util.xhr(opts)
            .then(function (r) { return r.body; });
    }
    /* Build a Basic-auth header object from user/pass, or null if none. Uses
     * btoa where available (present on our floor; player-avplay.js has a fallback
     * pattern if ever needed). Encodes to Latin-1-safe bytes first so non-ASCII
     * credentials don't throw in btoa. */
    function basicAuthHeader(user, pass) {
        if (!user && !pass) return null;
        var raw = (user || '') + ':' + (pass || '');
        var b64;
        try {
            b64 = btoa(unescape(encodeURIComponent(raw)));
        } catch (e) {
            try { b64 = btoa(raw); } catch (e2) { return null; }
        }
        return { 'Authorization': 'Basic ' + b64 };
    }

    return {
        createPairCode: createPairCode,
        stalkerGenres: stalkerGenres,
        stalkerProbe: stalkerProbe,
        stalkerChannels: stalkerChannels,
        stalkerChannelsAll: stalkerChannelsAll,
        stalkerChannelsPage: stalkerChannelsPage,
        stalkerResolve: stalkerResolve,
        stalkerArchive: stalkerArchive,
        stalkerArchiveResolve: stalkerArchiveResolve,
        stalkerVodCategories: stalkerVodCategories,
        stalkerVodItems: stalkerVodItems,
        stalkerVodResolve: stalkerVodResolve,
        stalkerSeriesCategories: stalkerSeriesCategories,
        stalkerSeriesItems: stalkerSeriesItems,
        stalkerSeriesSeasons: stalkerSeriesSeasons,
        clearStalkerSeriesSeasonsCache: clearStalkerSeriesSeasonsCache,
        stalkerSeriesResolve: stalkerSeriesResolve,
        stalkerEpg: stalkerEpg,
        stalkerEpgBatch: stalkerEpgBatch,
        checkPairCode: checkPairCode,
        closePairCode: closePairCode,
        uploadM3u: uploadM3u,
        xtreamAuth: xtreamAuth,
        xtreamCategories: xtreamCategories,
        xtreamStreams: xtreamStreams,
        xtreamAllStreamsChunked: xtreamAllStreamsChunked,
        xtreamStreamUrl: xtreamStreamUrl,
        xtreamEpgUrl: xtreamEpgUrl,
        xtreamEpgTable: xtreamEpgTable,
        xtreamVodCategories: xtreamVodCategories,
        xtreamVodStreams: xtreamVodStreams,
        xtreamSeriesCategories: xtreamSeriesCategories,
        xtreamSeries: xtreamSeries,
        xtreamSeriesInfo: xtreamSeriesInfo,
        clearXtreamSeriesInfoCache: clearXtreamSeriesInfoCache,
        xtreamAllVodStreamsStreaming: xtreamAllVodStreamsStreaming,
        xtreamAllSeriesStreaming: xtreamAllSeriesStreaming,
        xtreamVodInfo: xtreamVodInfo,
        fetchText: fetchText,
        basicAuthHeader: basicAuthHeader
    };
})();
