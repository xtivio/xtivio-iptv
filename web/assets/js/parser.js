/* parser.js - M3U and Xtream parsers
 *
 * Normalized channel object:
 *   {
 *     id, name, url, logo, category, tvgId, epgId,
 *     number, playlistId, playlistName, type ('m3u'|'xtream')
 *   }
 */
var Parser = (function () {
    'use strict';

    /* Xtream catch-up: days of archive the provider keeps for a stream (0 = none). tv_archive_duration is in days. */
    function archiveDaysOf(s) {
        if (!s || String(s.tv_archive) !== '1') return 0;
        var d = parseInt(s.tv_archive_duration, 10);
        return d > 0 ? d : 1;
    }

    /* M3U catch-up: which channels keep an archive and how the playlist says to ask for it. Players write this in several
     * ways, so every common spelling is read: catchup / catchup-type (the kind of link), catchup-source (a URL template),
     * catchup-days, catchup-hours, tvg-rec and timeshift (how much is kept). The values come from the channel line, or
     * from the #EXTM3U header line as a default for every channel. A bare number is days; a number over 60 is taken as
     * hours, because lists that put hours in "timeshift" use values like 48 or 168. Returns { days, type, source } or null. */
    function m3uCatchup(a, h) {
        var type = (a['catchup'] || a['catchup-type'] || h['catchup'] || h['catchup-type'] || '').toLowerCase();
        var src = a['catchup-source'] || h['catchup-source'] || '';
        var days = 0, v;
        v = parseInt(a['catchup-days'] || a['tvg-rec'] || a['timeshift'] || h['catchup-days'] || h['tvg-rec'] || h['timeshift'], 10);
        if (v > 0) days = v > 60 ? Math.ceil(v / 24) : v;
        else {
            v = parseInt(a['catchup-hours'] || h['catchup-hours'], 10);
            if (v > 0) days = Math.max(1, Math.ceil(v / 24));
        }
        if (!days && (type || src)) days = 3;
        if (type === 'none' || type === 'off' || type === '0') return null;
        if (!days) return null;
        return { days: days, type: type, source: src };
    }

    /* Scheme whitelist for URLs coming from untrusted playlists. Blocks
     * javascript:/data:/etc. so a malicious M3U can't smuggle a dangerous
     * URL into the player or an <img> logo. Allows the media/stream schemes
     * the app actually uses; anything else returns '' (treated as no URL). */
    function safeUrl(u) {
        if (!u || typeof u !== 'string') return '';
        var s = u.replace(/^\s+/, '');
        if (/^https?:\/\//i.test(s)) return s;
        if (/^(rtmp|rtmps|rtsp|udp|rtp):\/\//i.test(s)) return s;
        return '';
    }

    /* Resolve a stream line that may be scheme-less or relative against the
     * playlist's own URL, then scheme-check it. Some providers/proxies emit
     * lines like "host/live/u/p/123.ts" (no https://) or "/live/123.ts"
     * (root-relative); lenient native players assume the playlist's scheme/host,
     * so we do the same instead of dropping the channel. A line that already has
     * an allowed scheme is returned by safeUrl unchanged. */
    function resolveStreamUrl(line, playlist) {
        if (!line) return '';
        var s = line.replace(/^\s+/, '').replace(/\s+$/, '');
        var direct = safeUrl(s);
        if (direct) return direct;
        // Reject anything with a (non-allowed) explicit scheme, e.g.
        // javascript:, data: — don't try to "resolve" those.
        if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
        // Derive scheme + origin from the playlist URL.
        var base = (playlist && playlist.url) ? playlist.url : '';
        var m = base.match(/^(https?:)\/\/([^\/?#]+)/i);
        var scheme = m ? m[1] : 'https:';
        var host = m ? m[2] : '';
        if (s.charAt(0) === '/') {
            // root-relative
            if (!host) return '';
            return scheme + '//' + host + s;
        }
        // Scheme-less but host-qualified: "host/path..." → add scheme. Heuristic:
        // first path segment contains a dot (a hostname). Otherwise treat as
        // path-relative to the playlist host.
        var firstSeg = s.split('/')[0];
        if (firstSeg.indexOf('.') !== -1 || firstSeg.indexOf(':') !== -1) {
            return scheme + '//' + s;
        }
        if (host) return scheme + '//' + host + '/' + s;
        return '';
    }

    /* ===== Channel import chunk size =====
     * buildChannelsChunked() parses the channel list in batches, yielding
     * to the event loop between batches so input (e.g. the vkeyboard)
     * stays responsive while a large playlist loads. The chunk size is
     * the load-speed vs input-responsiveness lever: bigger = faster total
     * load but longer synchronous bursts between yields.
     *
     * Two performance tiers (the planned Lite/Normal split):
     *   Normal (unrestricted, default) : 500  — active value below
     *   Lite (low-end devices)         : 250
     * The yield gap stays constant across tiers; shrinking the chunk is
     * the right lever, the gap just needs to be a real non-zero yield.
     *
     * Lite Mode is not wired up yet. When it is, set IMPORT_CHUNK_SIZE
     * from the lite flag (e.g. App.liteMode ? 250 : 500) — this is the
     * single place that needs to change.
     *
     * History: the original base used 2000 with a 0ms gap, which froze
     * the UI during load of 145k+ item playlists (bursts too long, no
     * real yield). The current values (Normal 500/8ms) yield far more
     * often, keeping the UI responsive during large imports. */
    var IMPORT_CHUNK_SIZE = 500;
    var IMPORT_CHUNK_DELAY_MS = 8;

    /* ===== M3U VOD / Series sniffing =====
     *
     * Plain M3U carries no content-type metadata, so historically every entry
     * became a live channel (type 'm3u' → the Live section). But two common,
     * reliable signals let us route movies and series to their own sections:
     *
     *   1. URL PATH — an Xtream 'm3u_plus' export uses structural path segments:
     *        /movie/USER/PASS/ID.ext   → a movie
     *        /series/USER/PASS/ID.ext  → a series episode
     *        /live/USER/PASS/ID.ext    → explicitly live
     *      This is the strongest signal (server-generated, not user text).
     *
     *   2. group-title PREFIX — providers commonly prefix the group with the
     *      kind, e.g. group-title="VOD - 4K VOD | Hindi" or "SERIES | Drama".
     *      Softer (provider-chosen text) but often the ONLY signal, because the
     *      stream URL may be a plain .mkv not under /movie/. The prefix set here
     *      mirrors the one already stripped in ui.js normalizeLockName (VOD/SRS/
     *      SERIES) so classification and lock-name handling stay consistent.
     *
     * Either signal alone is enough to pull an entry OUT of Live. When they
     * disagree on movie-vs-series, the URL path wins (structural > text): a
     * /series/ URL tagged group-title="VOD - ..." is a series. A /live/ URL is
     * forced live regardless of prefix (guards against a channel whose group
     * merely contains the word "movies").
     *
     * classifyM3UItem(url, category) → { type, category }
     *   type     : 'movies' | 'series' | 'm3u'  (the section router in ui.js maps
     *              'movies'/'series' to those sections; anything else → live)
     *   category : the group-title with any kind-prefix stripped for display
     *              (so "VOD - 4K VOD | Hindi" shows as "4K VOD | Hindi")
     */
    var M3U_KIND_PREFIX_RE = /^\s*(vod|movies?|series|serie|srs|tv\s*shows?)\s*[-–—:|]/i;

    function m3uUrlKind(url) {
        if (!url) return null;
        // Match a path segment, not a substring: "/movie/" but not "moviesite.com".
        // Strip query/hash first so a ?x=/movie/ can't false-positive.
        var path = String(url).split('#')[0].split('?')[0];
        if (/\/series\//i.test(path)) return 'series';
        if (/\/movie\//i.test(path)) return 'movies';
        if (/\/live\//i.test(path)) return 'live';
        return null;
    }

    function stripKindPrefix(category) {
        if (!category) return category;
        // Remove a single leading kind-prefix + its separator, then trim.
        var out = String(category).replace(M3U_KIND_PREFIX_RE, '');
        out = out.replace(/^\s+/, '');
        return out || category; // never blank the category out entirely
    }

    function m3uPrefixKind(category) {
        if (!category) return null;
        var m = M3U_KIND_PREFIX_RE.exec(category);
        if (!m) return null;
        var word = m[1].toLowerCase().replace(/\s+/g, '');
        if (word === 'series' || word === 'serie' || word === 'srs' || word === 'tvshow' || word === 'tvshows') return 'series';
        return 'movies'; // vod / movie / movies
    }

    function classifyM3UItem(url, category) {
        var urlKind = m3uUrlKind(url);
        // Explicit live URL wins outright — never reclassify a /live/ stream.
        if (urlKind === 'live') return { type: 'm3u', category: category };

        var prefixKind = m3uPrefixKind(category);
        var kind = null;
        // URL path decides movie-vs-series when present; prefix is the fallback
        // and also the sole signal when the URL isn't Xtream-shaped.
        if (urlKind === 'movies' || urlKind === 'series') kind = urlKind;
        else if (prefixKind) kind = prefixKind;

        if (kind === 'movies' || kind === 'series') {
            return { type: kind, category: stripKindPrefix(category) };
        }
        return { type: 'm3u', category: category };
    }

    /* ===== M3U parser =====
     * Supports standard #EXTM3U / #EXTINF lines with tvg-id, tvg-logo, group-title attrs.
     */
    function parseM3U(text, playlist) {
        var channels = [];
        if (!text) return channels;
        var lines = text.replace(/\r\n/g, '\n').split('\n');
        var current = null;
        var number = 1;
        var hdrAttrs = {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            line = line.trim();
            if (!line) continue;
            if (line.indexOf('#EXTM3U') === 0) {
                var hRE = /(\w[\w-]*)="([^"]*)"/g, hm;
                while ((hm = hRE.exec(line)) !== null) hdrAttrs[hm[1].toLowerCase()] = hm[2];
                continue;
            }
            if (line.indexOf('#EXTINF') === 0) {
                // #EXTINF:-1 tvg-id="..." tvg-logo="..." group-title="...",Channel Name
                current = {
                    id: null,
                    name: '',
                    url: '',
                    logo: '',
                    category: 'Uncategorized',
                    tvgId: '',
                    epgId: '',
                    number: number,
                    playlistId: playlist.id,
                    playlistName: playlist.name,
                    type: 'm3u'
                };
                // name = after last comma
                var commaIdx = line.lastIndexOf(',');
                if (commaIdx >= 0) current.name = line.substr(commaIdx + 1).trim();
                // parse attrs
                var attrRE = /(\w[\w-]*)="([^"]*)"/g;
                var m;
                var cuAttrs = {};
                while ((m = attrRE.exec(line)) !== null) {
                    var key = m[1].toLowerCase();
                    var val = m[2];
                    if (key.indexOf('catchup') === 0 || key === 'timeshift' || key === 'tvg-rec') cuAttrs[key] = val;
                    if (key === 'tvg-id') { current.tvgId = val; current.epgId = val; }
                    else if (key === 'tvg-logo') current.logo = safeUrl(val);
                    else if (key === 'group-title') current.category = val || 'Uncategorized';
                    else if (key === 'tvg-name' && !current.name) current.name = val;
                    else if (key === 'tvg-chno') {
                        var n = parseInt(val, 10);
                        if (!isNaN(n)) current.number = n;
                    }
                }
                var cu = m3uCatchup(cuAttrs, hdrAttrs);
                if (cu) {
                    current.archiveDays = cu.days;
                    if (cu.type) current.cuType = cu.type;
                    if (cu.source) current.cuSource = cu.source;
                }
                continue;
            }
            if (line.indexOf('#') === 0) continue; // skip other directives
            if (!current) {
                // URL without EXTINF - skip or wrap
                continue;
            }
            var safe = resolveStreamUrl(line, playlist);
            if (!safe) { current = null; continue; } // reject unsafe/empty scheme
            current.url = safe;
            // Sniff movies/series from the URL path and/or group-title prefix so
            // VOD content lands in Movies/Series instead of Live. Live entries are
            // untouched (type stays 'm3u'). The cleaned category drops the kind
            // prefix for display.
            var kindInfo = classifyM3UItem(safe, current.category);
            if (kindInfo.type !== 'm3u') {
                current.type = kindInfo.type;      // 'movies' | 'series'
                current.category = kindInfo.category;
            }
            current.id = playlist.id + ':' + (current.tvgId || current.name || current.url);
            channels.push(current);
            number++;
            current = null;
        }
        return channels;
    }

    /* ===== Xtream => normalized channels =====
     * Given streams + categories arrays from API. We build HLS URLs by default.
     */
    function fromXtream(playlist, streams, categories) {
        var catMap = {};
        if (categories && categories.length) {
            for (var i = 0; i < categories.length; i++) {
                catMap[categories[i].category_id] = categories[i].category_name;
            }
        }
        var channels = [];
        if (!streams || !streams.length) return channels;
        // Pre-build base URL to avoid repeated string ops
        var base = playlist.host.replace(/\/$/, '');
        var userEnc = encodeURIComponent(playlist.user);
        var passEnc = encodeURIComponent(playlist.pass);
        // Standard Xtream live path: /live/USER/PASS/ID.ext. The old bare form
        // (/USER/PASS/ID.ext) is not redirected to the panel's token host by some
        // panels, so those streams did not play (1.0.4.1).
        var urlPrefix = base + '/live/' + userEnc + '/' + passEnc + '/';
        for (var j = 0; j < streams.length; j++) {
            var s = streams[j];
            var catName = catMap[s.category_id] || s.category_name || 'Uncategorized';
            channels.push({
                id: playlist.id + ':' + s.stream_id,
                name: s.name || ('Channel ' + s.stream_id),
                url: urlPrefix + s.stream_id + '.m3u8',
                fallbackUrl: urlPrefix + s.stream_id + '.ts',
                logo: s.stream_icon || '',
                category: catName,
                tvgId: s.epg_channel_id || '',
                epgId: s.epg_channel_id || '',
                number: s.num != null ? s.num : (j + 1),
                playlistId: playlist.id,
                playlistName: playlist.name,
                type: 'xtream',
                streamId: s.stream_id,
                archiveDays: archiveDaysOf(s)
            });
        }
        return channels;
    }

    /* ===== Load a playlist, returning normalized channels =====
     * Xtream: single API call for all streams (fast), but builds channel
     * objects in chunks via setTimeout to avoid blocking the UI.
     */
    function load(playlist) {
        if (playlist.type === 'xtream') {
            return Promise.all([
                Api.xtreamAllStreamsChunked(playlist.host, playlist.user, playlist.pass),
                Api.xtreamCategories(playlist.host, playlist.user, playlist.pass)
            ]).then(function (arr) {
                var streams = arr[0];
                var categories = arr[1];
                // If the streams response came back non-empty but yielded zero
                // channels, that's a real failure (parse error, or the parser's
                // memory ceiling truncating everything) — don't fail silently
                // with an empty live list. Signal it so the UI can tell the user
                // rather than showing "0 channels" with no explanation.
                var rawLen = (streams && streams.length) || 0;
                // Build channels in chunks to avoid blocking the UI
                return buildChannelsChunked(playlist, streams, categories).then(function (channels) {
                    if ((!channels || channels.length === 0) && rawLen > 0) {
                        if (window.console && console.warn) {
                            Log.warn('[Parser] Xtream live streams returned ' + rawLen +
                                ' raw entries but 0 channels were built — possible parse/memory truncation');
                        }
                        try { if (window.UI && UI.toast) UI.toast(T('live_channel_list_could_not_be'), 'err'); } catch (eT) {}
                    }
                    // Persist the parsed list so subsequent launches are fast.
                    // Xtream playlists are the large-list case (tens of
                    // thousands of channels) and were previously never cached
                    // at all — cacheChannelsAsync routes them to IndexedDB.
                    try { Store.cacheChannelsAsync(playlist.id, channels); } catch (e) {}
                    return channels;
                });
            });
        }
        // M3U. If the playlist carries inline content (an uploaded file embedded
        // in the pairing payload), parse it directly — the TV never fetches a
        // URL. Otherwise fetch the remote URL the user supplied.
        if (playlist.content && playlist.content.length) {
            var inlineChannels = parseM3U(playlist.content, playlist);
            Store.cacheChannelsAsync(playlist.id, inlineChannels);
            return Promise.resolve(inlineChannels);
        }
        // Append a cache-buster so the webview can't serve a stale cached
        // redirect/response for this URL. M3U links are often shorteners issuing
        // a 308 PERMANENT redirect; the WebOS webview caches those aggressively,
        // so if the shortener is ever repointed, the app would keep following the
        // OLD cached redirect (to a now-dead host) and get an error page while a
        // fresh fetch elsewhere works. A unique query value forces a real request.
        var fetchUrl = playlist.url + (playlist.url.indexOf('?') === -1 ? '?' : '&') + '_=' + (new Date()).getTime();
        // Optional HTTP Basic auth for a protected M3U URL (authUser/authPass set
        // on the playlist). Sent as an Authorization header — robust across webOS
        // engines, unlike inline user:pass@ in the URL which webviews mishandle.
        var m3uAuth = (Api.basicAuthHeader ? Api.basicAuthHeader(playlist.authUser, playlist.authPass) : null);
        return Api.fetchText(fetchUrl, m3uAuth).then(function (text) {
            var channels = parseM3U(text, playlist);
            if (!channels.length) {
                // Fetch succeeded but no channels parsed. Distinguish the cases
                // so the message isn't misleading:
                //  - HTML body  → not a playlist (error page / interstitial).
                //  - has M3U directives but no playable URLs → every stream line
                //    was rejected (e.g. an unusable scheme we couldn't resolve).
                //  - otherwise  → not a recognizable M3U.
                var head = (text || '').replace(/^\uFEFF/, '').slice(0, 400).toLowerCase();
                var hasDirectives = head.indexOf('#extm3u') !== -1 || head.indexOf('#extinf') !== -1;
                var looksHtml = head.indexOf('<!doctype') !== -1 || head.indexOf('<html') !== -1 || head.indexOf('<head') !== -1 || head.indexOf('<script') !== -1;
                var msg;
                if (looksHtml) {
                    msg = T('err_m3u_webpage');
                } else if (hasDirectives) {
                    msg = T('err_m3u_no_urls');
                } else {
                    msg = T('err_m3u_invalid');
                }
                return Promise.reject({ status: 0, err: 'no-channels', userMessage: msg });
            }
            Store.cacheChannelsAsync(playlist.id, channels);
            return channels;
        });
    }

    function buildChannelsChunked(playlist, streams, categories) {
        if (!streams || !streams.length) {
            return Promise.resolve(fromXtream(playlist, [], categories));
        }
        // Chunk size / yield gap come from the performance policy so Lite mode
        // can use smaller chunks with more yielding on weak devices. Read at
        // parse time (not module load) so a mode change takes effect next parse.
        // Falls back to the module constants if PerfConfig is unavailable.
        var CHUNK = IMPORT_CHUNK_SIZE;
        var CHUNK_DELAY_MS = IMPORT_CHUNK_DELAY_MS;
        try {
            if (typeof PerfConfig !== 'undefined') {
                var cs = PerfConfig.get('importChunkSize');
                var cd = PerfConfig.get('importChunkDelayMs');
                if (cs) CHUNK = cs;
                if (cd != null) CHUNK_DELAY_MS = cd;
            }
        } catch (e) {}
        var catMap = {};
        if (categories && categories.length) {
            for (var i = 0; i < categories.length; i++) {
                catMap[categories[i].category_id] = categories[i].category_name;
            }
        }
        var base = playlist.host.replace(/\/$/, '');
        var userEnc = encodeURIComponent(playlist.user);
        var passEnc = encodeURIComponent(playlist.pass);
        var urlPrefix = base + '/live/' + userEnc + '/' + passEnc + '/';
        var channels = [];
        var idx = 0;
        try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('channel parse start (' + streams.length + ' streams, chunk ' + CHUNK + '/' + CHUNK_DELAY_MS + 'ms)'); } catch (eDiag) {}

        return new Promise(function (resolve) {
            function processChunk() {
                var end = Math.min(idx + CHUNK, streams.length);
                for (; idx < end; idx++) {
                    var s = streams[idx];
                    channels.push({
                        id: playlist.id + ':' + s.stream_id,
                        name: s.name || ('Channel ' + s.stream_id),
                        url: urlPrefix + s.stream_id + '.m3u8',
                        fallbackUrl: urlPrefix + s.stream_id + '.ts',
                        logo: s.stream_icon || '',
                        category: catMap[s.category_id] || s.category_name || 'Uncategorized',
                        tvgId: s.epg_channel_id || '',
                        epgId: s.epg_channel_id || '',
                        number: s.num != null ? s.num : (idx + 1),
                        playlistId: playlist.id,
                        playlistName: playlist.name,
                        type: 'xtream',
                        streamId: s.stream_id,
                        archiveDays: archiveDaysOf(s)
                    });
                }
                if (idx < streams.length) {
                    // Yield to the UI with a real gap so queued input
                    // (e.g. vkeyboard keypresses) can be processed before
                    // the next batch seizes the thread again.
                    setTimeout(processChunk, CHUNK_DELAY_MS);
                } else {
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('channel parse done (' + channels.length + ')'); } catch (eDiag2) {}
                    resolve(channels);
                }
            }
            // Start after a brief yield so loading overlay paints
            setTimeout(processChunk, 10);
        });
    }

    return {
        parseM3U: parseM3U,
        classifyM3UItem: classifyM3UItem,
        fromXtream: fromXtream,
        load: load
    };
})();
