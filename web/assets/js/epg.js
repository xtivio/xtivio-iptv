/* epg.js - XMLTV EPG fetching, parsing, lookups
 *
 * Parses <tv><channel><programme> into:
 *   { channels: { tvgId: displayName }, programmes: { tvgId: [{start, stop, title, desc}] } }
 */
var Epg = (function () {
    'use strict';

    var STATE = {
        settling: {},
        byPlaylist: {}   // playlistId -> { channels:{}, programmes:{}, loadedAt }
    };

    // Per-channel programme LRU: with EPG stored per-channel in IndexedDB, only a
    // small set of recently-viewed channels' programme lists are kept resident
    // (instead of all ~175k programmes). Keyed 'playlistId\u0000channelId'.
    var EPG_LRU = {};          // key -> { list, at }
    var EPG_LRU_ORDER = [];    // keys, most-recent last
    // Must comfortably exceed one visible guide PAGE (CAT_PAGE_SIZE = 50 rows) PLUS the
    // now/next side box's own EPG lookups for the focused channel. At 60 this was too tight:
    // 50 rows nearly filled it, then the side box (added with the now/next feature) querying
    // the focused channel + its window tipped it past 60 and EVICTED the very rows on screen,
    // so they fell back to "No EPG data" and — because the async-fill re-render only refreshed
    // the side box, not the rows — never recovered until manual navigation. 256 gave the full
    // page permanent headroom so a visible row can't evict itself. 683-follow-up: raised to 512
    // so several pages of already-viewed channels (and the in-player mini list's channels) stay
    // resident, cutting the async IDB re-fetch delay on scroll/revisit. Programme objects are
    // tiny ({start,stop,title,desc:''}) and KNOWN-ITEMS records 315k+ entries resident on a
    // 347MB device with headroom (the search index, not this LRU, is the memory ceiling), so
    // 512 channels resident is comfortably within budget. Programmes persist in IDB regardless;
    // this only bounds the in-memory resident set.
    var EPG_LRU_MAX = 512;     // channels resident (>> several pages of rows + side-box lookups)
    var EPG_PENDING = {};      // key -> true while an async IDB load is in flight
    var _epgRerender = null;   // optional callback to nudge a re-render on fill

    // ---- Freshness cache -----------------------------------------------------
    // On a complete parse the light lookup maps + a freshness record are written
    // to IDB (STORE_EPG_META); the programmes themselves already persist to
    // STORE_EPG. On boot, if the record is fresh enough and the source set is
    // unchanged, load() restores the maps and skips the fetch+parse entirely
    // (the ~20-35s cost). now/next is always recomputed live against the wall
    // clock from the persisted programmes, never cached as a pointer, so a stale-
    // but-valid guide never shows the wrong "current" programme.
    var EPG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6h; tunable. See KNOWN-ITEMS.
    var EPG_FORCE = {};        // playlistId -> true to bypass the gate for one load

    // Cheap, header-independent fingerprint of the resolved source-URL SET. If
    // the set changes (an external EPG added/removed, or override toggled) this
    // changes, forcing a re-parse regardless of TTL.
    function sourceSetKey(urls) {
        if (!urls || !urls.length) return '';
        // Order matters (merge precedence), so join as-is without sorting.
        return urls.join('\u0001');
    }

    // The light, JSON-safe lookup maps that drive resolution. Programmes live in
    // IDB and are intentionally excluded here.
    function extractLightMaps(data) {
        if (!data) return null;
        return {
            channels: data.channels || {},
            nameToId: data.nameToId || {},
            nameToIdExact: data.nameToIdExact || {},
            _progChannels: data._progChannels || {},
            _progChannelsLC: data._progChannelsLC || {}
        };
    }

    // Rebuild a resident EPG object from restored light maps. programmes/
    // programmesLC stay null because they live in IDB and load on demand.
    function rehydrateFromMaps(playlistId, maps, coverUntil) {
        var e = makeEmptyEpg(playlistId);
        e.channels = maps.channels || {};
        e.nameToId = maps.nameToId || {};
        e.nameToIdExact = maps.nameToIdExact || {};
        e._progChannels = maps._progChannels || {};
        e._progChannelsLC = maps._progChannelsLC || {};
        e.programmes = null;
        e.programmesLC = null;
        e._coverUntil = coverUntil || 0;
        e._fromCache = true;
        return e;
    }

    function epgLruKey(playlistId, channelId) { return playlistId + '\u0000' + channelId; }

    function epgLruGet(playlistId, channelId) {
        var k = epgLruKey(playlistId, channelId);
        var e = EPG_LRU[k];
        if (!e) return undefined;
        // bump recency
        var idx = EPG_LRU_ORDER.indexOf(k);
        if (idx >= 0) EPG_LRU_ORDER.splice(idx, 1);
        EPG_LRU_ORDER.push(k);
        return e.list;
    }

    function epgLruPut(playlistId, channelId, list) {
        var k = epgLruKey(playlistId, channelId);
        if (!EPG_LRU[k]) EPG_LRU_ORDER.push(k);
        EPG_LRU[k] = { list: list, at: Date.now() };
        while (EPG_LRU_ORDER.length > EPG_LRU_MAX) {
            var old = EPG_LRU_ORDER.shift();
            delete EPG_LRU[old];
        }
    }

    function epgLruDrop(playlistId, channelId) {
        var k = epgLruKey(playlistId, channelId);
        if (EPG_LRU[k]) {
            delete EPG_LRU[k];
            var idx = EPG_LRU_ORDER.indexOf(k);
            if (idx >= 0) EPG_LRU_ORDER.splice(idx, 1);
        }
    }

    // Kick off an async IDB load of a channel's programme list into the LRU,
    // then nudge a re-render so the just-loaded data shows. De-duped per key.
    function epgLoadChannelAsync(playlistId, channelId) {
        if (typeof IDB === 'undefined' || !IDB.epgGetChannel) return;
        var k = epgLruKey(playlistId, channelId);
        if (EPG_PENDING[k]) return;
        EPG_PENDING[k] = true;
        IDB.epgGetChannel(playlistId, channelId).then(function (list) {
            delete EPG_PENDING[k];
            // Don't cache a false-empty: if IDB returned nothing but the light map
            // says this channel HAS programmes, the write hasn't landed yet. Caching
            // [] here would stick permanently (epgLruGet returns it, resolveList
            // never reloads) and blank the row forever. Leave uncached so the next
            // access retries; only cache when we actually got data, or when the
            // channel legitimately has none (not flagged in _progChannels).
            var d = STATE.byPlaylist[playlistId];
            var flaggedHasProg = d && d._progChannels && d._progChannels[channelId];
            if ((list && list.length) || !flaggedHasProg) {
                epgLruPut(playlistId, channelId, list || []);
                if (_epgRerender) { try { _epgRerender(); } catch (e) {} }
            }
        })['catch'](function () { delete EPG_PENDING[k]; });
    }

    function setEpgRerenderHook(fn) { _epgRerender = fn; }

    // Batch-prefetch a set of channels' programme lists into the LRU in one pass,
    // then nudge a SINGLE re-render when the batch settles. Used when a page of
    // rows (the main guide, or the in-player mini channel list) is about to show:
    // instead of each row lazily triggering its own async IDB load + its own
    // re-render (piecemeal fill, visible as a staggered delay), we load all the
    // not-yet-resident channels together and repaint once. De-dupes against both
    // the LRU (already resident) and EPG_PENDING (already loading). Concurrency is
    // bounded so a 50-row page doesn't open 50 IDB transactions at once.
    function prefetchChannels(playlistId, channelIds) {
        if (!playlistId || !channelIds || !channelIds.length) return;
        if (typeof IDB === 'undefined' || !IDB.epgGetChannel) return;
        // Collect the channels that are neither resident nor already in flight.
        var todo = [];
        for (var i = 0; i < channelIds.length; i++) {
            var cid = channelIds[i];
            if (!cid) continue;
            var k = epgLruKey(playlistId, cid);
            if (EPG_LRU[k] || EPG_PENDING[k]) continue;
            EPG_PENDING[k] = true;
            todo.push(cid);
        }
        if (!todo.length) return;
        var remaining = todo.length;
        var CONCURRENCY = 8;   // cap simultaneous IDB reads
        var next = 0;
        var inFlight = 0;
        var didRerender = false;
        function settle() {
            remaining--;
            if (remaining <= 0 && !didRerender) {
                didRerender = true;
                if (_epgRerender) { try { _epgRerender(); } catch (e) {} }
            }
        }
        function pump() {
            while (next < todo.length && inFlight < CONCURRENCY) {
                (function (channelId) {
                    var key = epgLruKey(playlistId, channelId);
                    inFlight++;
                    IDB.epgGetChannel(playlistId, channelId).then(function (list) {
                        delete EPG_PENDING[key];
                        epgLruPut(playlistId, channelId, list || []);
                        inFlight--;
                        settle();
                        pump();
                    })['catch'](function () { delete EPG_PENDING[key]; inFlight--; settle(); pump(); });
                })(todo[next]);
                next++;
            }
        }
        pump();
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function decodeEntities(str) {
        str = String(str || '');
        // Every pattern below starts with an ampersand, so a string without one
        // is returned unchanged. Skips six regex passes (and up to six temporary
        // strings) for the vast majority of titles during a large guide parse.
        if (str.indexOf('&') < 0) return str;
        return str.replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
    }

    // XMLTV date: YYYYMMDDHHmmss +HHMM
    function parseXmltvDate(s) {
        if (!s) return null;
        s = s.trim();
        // Take first 14 chars
        var y = parseInt(s.substr(0, 4), 10);
        var mo = parseInt(s.substr(4, 2), 10) - 1;
        var d = parseInt(s.substr(6, 2), 10);
        var h = parseInt(s.substr(8, 2), 10) || 0;
        var mi = parseInt(s.substr(10, 2), 10) || 0;
        var se = parseInt(s.substr(12, 2), 10) || 0;
        // Timezone
        var tzMatch = s.match(/([+-])(\d{2})(\d{2})$/);
        var base = Date.UTC(y, mo, d, h, mi, se);
        if (tzMatch) {
            var sign = tzMatch[1] === '+' ? -1 : 1;
            var offMin = (parseInt(tzMatch[2], 10) * 60 + parseInt(tzMatch[3], 10)) * sign;
            base += offMin * 60 * 1000;
        }
        return new Date(base);
    }

    /* Allocation-free helpers for the programme loop in parseXmltvChunked.
     *
     * The loop used to build, for EVERY scanned programme (419k on a big merged
     * guide, kept or not): the whole programme block as a substring, the opening
     * tag, the body, three attribute substrings, two Date objects and the
     * temporaries inside parseXmltvDate (trim, six substr, a regex match array).
     * That is millions of short-lived objects, and the TV's process memory
     * climbed by well over 100MB during the parse while only ~190k small records
     * were actually kept. These helpers read the same values straight out of the
     * big string by index, so a programme that is dropped costs no allocations
     * beyond the small attribute values, and a kept one costs its record and its
     * title. Results are identical to the old code; anything unusual falls back
     * to parseXmltvDate. */

    // Value of name="..." between from (inclusive) and to (exclusive), exactly as
    // extractAttr would return it for that slice: first occurrence of name="
    // anywhere in the slice, up to the next quote; '' when absent or unterminated.
    // Returns the value as [valStart, valEnd] via the two-slot array passed in, or
    // false when absent, so the caller can read digits without a substring.
    function attrRangeAt(xml, from, to, name, out) {
        var i = xml.indexOf(name + '="', from);
        if (i < 0 || i >= to) return false;
        var vs = i + name.length + 2;
        var ve = xml.indexOf('"', vs);
        if (ve < 0 || ve >= to || ve <= vs) return false;
        out[0] = vs;
        out[1] = ve;
        return true;
    }

    // XMLTV time (YYYYMMDDHHmmss, optional space, optional +HHMM) at [a, b) as
    // epoch ms. Handles the canonical shapes by charCode arithmetic and defers to
    // parseXmltvDate for everything else (leading/trailing spaces, short or odd
    // values), so the result is the same number the old code produced.
    function xmltvMsAt(xml, a, b) {
        var n = b - a;
        if (n === 14 || (n >= 19 && n <= 25)) {
            var i, c, ok = true;
            for (i = 0; i < 14; i++) {
                c = xml.charCodeAt(a + i);
                if (c < 48 || c > 57) { ok = false; break; }
            }
            var offMin = 0;
            if (ok && n > 14) {
                // Spaces, then a sign and four digits that end the value.
                for (i = 14; i < n - 5; i++) {
                    if (xml.charCodeAt(a + i) !== 32) { ok = false; break; }
                }
                if (ok) {
                    var sg = xml.charCodeAt(b - 5);
                    if (sg !== 43 && sg !== 45) ok = false;
                    for (i = 4; ok && i >= 1; i--) {
                        c = xml.charCodeAt(b - i);
                        if (c < 48 || c > 57) ok = false;
                    }
                    if (ok) {
                        offMin = ((xml.charCodeAt(b - 4) - 48) * 10 + (xml.charCodeAt(b - 3) - 48)) * 60 +
                                 ((xml.charCodeAt(b - 2) - 48) * 10 + (xml.charCodeAt(b - 1) - 48));
                        if (sg === 43) offMin = -offMin;
                    }
                }
            }
            if (ok) {
                var y = (xml.charCodeAt(a) - 48) * 1000 + (xml.charCodeAt(a + 1) - 48) * 100 +
                        (xml.charCodeAt(a + 2) - 48) * 10 + (xml.charCodeAt(a + 3) - 48);
                return Date.UTC(
                    y,
                    (xml.charCodeAt(a + 4) - 48) * 10 + (xml.charCodeAt(a + 5) - 48) - 1,
                    (xml.charCodeAt(a + 6) - 48) * 10 + (xml.charCodeAt(a + 7) - 48),
                    (xml.charCodeAt(a + 8) - 48) * 10 + (xml.charCodeAt(a + 9) - 48),
                    (xml.charCodeAt(a + 10) - 48) * 10 + (xml.charCodeAt(a + 11) - 48),
                    (xml.charCodeAt(a + 12) - 48) * 10 + (xml.charCodeAt(a + 13) - 48)
                ) + offMin * 60000;
            }
        }
        var dt = parseXmltvDate(xml.substring(a, b));
        return dt ? dt.getTime() : 0;
    }

    // Decoded text of the first <title ...>...</title> between from and to, the
    // same text extractTag(body, 'title') gave on that slice ('' when absent).
    function titleAt(xml, from, to) {
        var i = xml.indexOf('<title', from);
        if (i < 0 || i >= to) return '';
        var gt = xml.indexOf('>', i);
        if (gt < 0 || gt >= to) return '';
        var close = xml.indexOf('</title>', gt);
        if (close < 0 || close + 8 > to) return '';
        return decodeEntities(xml.substring(gt + 1, close).trim());
    }

    // parseXmlString removed — chunked parser is used exclusively for TV compatibility

    /* Chunked text-based XMLTV parser — no DOMParser, processes in batches.
     * Uses regex to extract channel and programme data from raw XML text.
     * Returns a Promise that resolves when parsing is complete. */
    // Playlist channel ids the guide is actually used for, per playlist. Built once
    // per boot from the live channel list (setWantedChannels) so the parse can skip
    // programmes for channels nobody can look up. Keys are lower-cased tvg/epg/xmltv
    // ids. Absent or empty means "no filtering" (keep everything, as before).
    var WANTED = {};
    function setWantedChannels(playlistId, channels) {
        if (!playlistId || !channels || !channels.length) { delete WANTED[playlistId]; return; }
        var m = {}, n = 0, i, ch, ids, j, v;
        for (i = 0; i < channels.length; i++) {
            ch = channels[i];
            if (!ch) continue;
            ids = [ch.tvgId, ch.epgId, ch.xmltvId];
            for (j = 0; j < 3; j++) {
                v = ids[j];
                if (v === undefined || v === null || v === '') continue;
                v = String(v).toLowerCase();
                // value = 1 + catch-up days: the parse keeps past programmes this far
                // back for channels that have an archive (see parseXmltvCore).
                var w = 1 + (Number(ch.archiveDays) > 0 ? Math.min(Math.floor(Number(ch.archiveDays)), 14) : 0);
                if (!m[v]) { m[v] = w; n++; } else if (w > m[v]) { m[v] = w; }
            }
        }
        if (n) WANTED[playlistId] = m; else delete WANTED[playlistId];
    }

    /* Past programmes kept for catch-up channels are bounded by a budget sized from the
     * heap LIMIT (the usage figure is not reliable): ~150 programmes per MB of limit,
     * a third of that in Lite, never more than 400k. */
    function epgPastBudget() {
        var lim = 0, n;
        try { lim = (window.performance && performance.memory && performance.memory.jsHeapSizeLimit) || 0; } catch (eLm) {}
        n = Math.round((lim ? lim / 1048576 : 256) * 150);
        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.isLite && PerfConfig.isLite()) n = Math.round(n / 3); } catch (eLt) {}
        return Math.min(n, 400000);
    }

    /* feed (optional): function () -> Promise<string|null>, the rest of the guide in slices
     * (null = end). With a feed the guide is never held as one string, so its size is not
     * limited by the engine's maximum string length. xmlText is then the first slice. */
    function parseXmltvChunked(xmlText, gen, wantedLC, feed) {
        if (!feed) return parseXmltvCore(xmlText, gen, wantedLC, null);
        // The header (all <channel> entries up to the first <programme>) must be complete.
        return new Promise(function (resolve) {
            var text = xmlText || '';
            (function pull() {
                if (text.indexOf('<programme') >= 0) { resolve(parseXmltvCore(text, gen, wantedLC, feed)); return; }
                feed().then(function (c) {
                    if (c == null) { resolve(parseXmltvCore(text, gen, wantedLC, null)); return; }
                    text += c; pull();
                }, function () { resolve(parseXmltvCore(text, gen, wantedLC, null)); });
            })();
        });
    }

    function parseXmltvCore(xmlText, gen, wantedLC, feed) {
        var result = {
            channels: {}, programmes: {}, programmesLC: {},
            nameToId: {}, nameToIdExact: {}
        };
        if (!xmlText || xmlText.length < 50) return Promise.resolve(result);

        // Retention window for programmes (memory guard — see the filter in the
        // chunk loop). Generous enough that guide paging still has data: 12h back
        // to 7 days ahead. Programmes outside this are dropped at parse time.
        var nowMs = Date.now();
        var RETAIN_FROM = nowMs - 12 * 3600000;
        // Forward horizon comes from the performance policy (epgMaxDays: Normal
        // 3, Lite 1). Kept deliberately short so the resident programme set stays
        // small: a full XMLTV can carry 1-2 weeks, and holding ~7 days for
        // thousands of channels put ~175k programme objects on the heap — which,
        // alongside the live channels and the VOD/series search index, exhausted
        // a small TV heap and crashed the VOD preload. The guide only shows a few
        // hours to a day or two around now; paging further can re-load later.
        // Lite trims further still. The fallback below matches the Normal policy
        // value and is only used if PerfConfig is unavailable.
        var horizonDays = 3;
        try {
            if (typeof PerfConfig !== 'undefined') {
                var d = PerfConfig.get('epgMaxDays');
                if (d) horizonDays = d;
            }
        } catch (e) {}
        var RETAIN_TO = nowMs + horizonDays * 24 * 3600000;

        // Phase 1: Extract <channel> elements. In XMLTV all <channel> elements
        // precede the <programme> elements, so only scan the header region up to
        // the first <programme>. Running a global regex with [\s\S]*? over the
        // full ~57MB body caused catastrophic backtracking + huge capture strings
        // that exhausted the TV heap (the OOM crash) BEFORE chunking began. Use
        // indexOf-based slicing over just the small header instead.
        var firstProg = xmlText.indexOf('<programme');
        var headerEnd = firstProg > -1 ? firstProg : Math.min(xmlText.length, 2 * 1024 * 1024);
        var header = xmlText.substring(0, headerEnd);
        var dnRe = /<display-name[^>]*>([\s\S]*?)<\/display-name>/i;
        var cPos = 0;
        while (true) {
            var cStart = header.indexOf('<channel ', cPos);
            if (cStart < 0) break;
            var cTagEnd = header.indexOf('>', cStart);
            if (cTagEnd < 0) break;
            var cClose = header.indexOf('</channel>', cTagEnd);
            if (cClose < 0) break;
            var cOpenTag = header.substring(cStart, cTagEnd);
            var chId = extractAttr(cOpenTag.substring('<channel '.length), 'id');
            var chBody = header.substring(cTagEnd + 1, cClose);
            if (chId) {
                var displayName = '';
                var dnPos = 0;
                while (true) {
                    var dnStart = chBody.indexOf('<display-name', dnPos);
                    if (dnStart < 0) break;
                    var dnClose = chBody.indexOf('</display-name>', dnStart);
                    if (dnClose < 0) break;
                    var dnFrag = chBody.substring(dnStart, dnClose + '</display-name>'.length);
                    var dnm = dnRe.exec(dnFrag);
                    dnPos = dnClose + 1;
                    if (!dnm) continue;
                    var dn = decodeEntities(dnm[1].replace(/^\s+|\s+$/g, ''));
                    if (!dn) continue;
                    if (!displayName) displayName = dn;
                    result.nameToIdExact[dn] = chId;
                    result.nameToId[dn.toLowerCase()] = chId;
                }
                result.channels[chId] = displayName || chId;
            }
            cPos = cClose + 1;
        }

        // Relevance filter. A programme can only ever be looked up through a
        // playlist channel id (resolveChannelId): directly by id, or through a
        // header display-name that equals one. So a header channel is relevant when
        // its id, or any of its display names, is a playlist id; any other
        // programme channel (including channels declared AFTER the programmes, which
        // have no header entry and are never name-resolved) is relevant only by id.
        // Without a wanted set nothing is filtered.
        var relevantFilter = !!wantedLC;
        var relevantById = {};
        if (relevantFilter) {
            var hk;
            for (hk in result.channels) {
                if (result.channels.hasOwnProperty(hk) && wantedLC[hk.toLowerCase()]) relevantById[hk] = wantedLC[hk.toLowerCase()];
            }
            for (hk in result.nameToId) {
                if (result.nameToId.hasOwnProperty(hk) && wantedLC[hk]) relevantById[result.nameToId[hk]] = Math.max(relevantById[result.nameToId[hk]] || 0, wantedLC[hk]);
            }
        }
        var verdictByCid = {};   // memo: channel id -> relevant (decided once per distinct id)
        // A guide read as a stream may be far larger than one that has to fit in a string,
        // and its playlist channels may sit well into the file: allow more before giving up.
        var EARLY_ABORT_AFTER = feed ? 1500000 : 150000;  // scanned programmes with none relevant -> stop
        var feedDone = !feed;     // true once there is no more input to read
        var maxPastDays = 0, pastBudget = 0, pastUsed = 0;
        try { if (typeof PerfConfig !== 'undefined') maxPastDays = PerfConfig.get('epgMaxPastDays') || 0; } catch (ePd) {}
        if (maxPastDays > 0) pastBudget = epgPastBudget();
        var maxProgrammes = 0;
        try { if (typeof PerfConfig !== 'undefined') maxProgrammes = PerfConfig.get('epgMaxProgrammes') || 0; } catch (eMp) {}
        var relevantSeen = 0, skippedIrrelevant = 0, dupDropped = 0;

        // Phase 2: Find and parse <programme> elements in chunks
        // Instead of regex on entire 67MB string, search for tags incrementally
        return new Promise(function (resolve) {
            var progStart = '<programme ';
            var progEnd = '</programme>';
            var pos = 0;
            var programmes = result.programmes;
            var count = 0;
            var _epgDateFails = 0;
            var _epgDateSample = '';
            var CHUNK_ITEMS = 250;
            var CHUNK_DELAY_MS = 8;
            var _rng = [0, 0];   // scratch [start, end] for attrRangeAt (no per-programme arrays)
            // GC breather. The parse leaves a steady stream of short-lived strings;
            // on a small TV heap the collector needs idle time to keep up (the same
            // lesson as the movie/series parse). Every EPG_BREATHER_EVERY scanned
            // programmes the next chunk waits EPG_BREATHER_MS instead of the usual
            // few ms. About 40 pauses on a 420k-programme guide, a few seconds in all.
            var EPG_BREATHER_EVERY = 10000;
            var EPG_BREATHER_MS = 100;
            var _scannedSinceBreather = 0;

            // Runaway-loop guard only. This counts EVERY <programme> scanned,
            // BEFORE the retention filter drops the out-of-window ones, so it must
            // exceed the total programme count of a large provider EPG (1-2 weeks x
            // thousands of channels can be well over 500k) — otherwise the parse
            // aborts partway and every channel physically later in the file gets no
            // programmes for that load. Memory is bounded by the retention window
            // (only ~3 days are kept regardless of file size), NOT by this cap, so a
            // high ceiling is safe. If it's ever hit, that's a real truncation and
            // must be loud, not silent.
            var MAX_ITERATIONS = feed ? 8000000 : 2000000; // safety limit (runaway guard, not a size cap)
            var totalIterations = 0;
            var diagLast = 0;
            try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('EPG parse start'); } catch (eDiag) {}
            function findAndParseChunk() {
                // Abort if a newer EPG load started (playlist switched mid-parse).
                if (gen != null && gen !== STATE.loadGen) { resolve(result); return; }
                var processed = 0;
                var needMore = false;
                while (pos < xmlText.length && processed < CHUNK_ITEMS) {
                    if (++totalIterations > MAX_ITERATIONS) {
                        Util.logErr('EPG parser: safety limit (' + MAX_ITERATIONS + ') reached at ' +
                            Math.round(100 * pos / xmlText.length) + '% of file — GUIDE TRUNCATED, ' +
                            'later channels will have no programmes. Raise MAX_ITERATIONS.');
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG TRUNCATED at cap ' + MAX_ITERATIONS); } catch (eTrunc) {}
                        pos = xmlText.length;
                        feedDone = true;
                        break;
                    }
                    var start = xmlText.indexOf(progStart, pos);
                    if (start < 0) {
                        if (!feedDone) { pos = Math.max(pos, xmlText.length - 12); needMore = true; break; }
                        pos = xmlText.length; break;
                    }
                    var end = xmlText.indexOf(progEnd, start);
                    if (end < 0) {
                        if (!feedDone) { pos = start; needMore = true; break; }
                        pos = xmlText.length; break;
                    }
                    end += progEnd.length;
                    // Guard: ensure we advance
                    if (end <= pos) { pos = end + 1; continue; }

                    // Work on indices into xmlText instead of cutting the block, the
                    // opening tag and the body out as separate strings (see the
                    // helpers above). tagGt is the end of the opening tag; if the
                    // block has no usable one the old code fell back to the last
                    // character of the block, so do the same.
                    var tagGt = xmlText.indexOf('>', start);
                    if (tagGt < 0 || tagGt > end - 1) tagGt = end - 1;
                    var aFrom = start + progStart.length;

                    var cid = '';
                    var ver = 0;
                    if (attrRangeAt(xmlText, aFrom, tagGt, 'channel', _rng)) {
                        cid = xmlText.substring(_rng[0], _rng[1]);
                    }
                    if (cid && relevantFilter) {
                        ver = verdictByCid[cid];
                        if (ver === undefined) {
                            ver = relevantById[cid] || wantedLC[cid.toLowerCase()] || 0;   // 0 = not wanted, else 1 + catch-up days
                            verdictByCid[cid] = ver;
                        }
                        if (!ver) {
                            skippedIrrelevant++;
                            if (!relevantSeen && totalIterations >= EARLY_ABORT_AFTER) {
                                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG aborted: no playlist channel in first ' + totalIterations + ' programmes'); } catch (eAb) {}
                                pos = xmlText.length;
                                feedDone = true;
                                break;
                            }
                            pos = end;
                            processed++;
                            continue;
                        }
                        relevantSeen++;
                    }
                    if (cid) {
                        var startMs = attrRangeAt(xmlText, aFrom, tagGt, 'start', _rng) ? xmltvMsAt(xmlText, _rng[0], _rng[1]) : 0;
                        var stopMs = attrRangeAt(xmlText, aFrom, tagGt, 'stop', _rng) ? xmltvMsAt(xmlText, _rng[0], _rng[1]) : 0;
                        // Diagnostic: count programmes whose dates didn't parse
                        // (which the filter below can't drop) and capture one raw
                        // sample, so we can tell if a date-format mismatch is
                        // defeating the retention window and keeping everything.
                        if (!startMs && !stopMs) {
                            _epgDateFails++;
                            if (!_epgDateSample && attrRangeAt(xmlText, aFrom, tagGt, 'start', _rng)) {
                                _epgDateSample = xmlText.substring(_rng[0], Math.min(_rng[1], _rng[0] + 24));
                            }
                        }
                        // Retention window: keep only programmes near "now". A full
                        // XMLTV can carry 1-2 weeks (~190k programmes here) and hold
                        // the whole set resident — enough to OOM the TV webview. The
                        // guide only ever shows a few hours either side of now, so
                        // drop anything that ended before the window or starts after
                        // it. This is the primary memory fix for the parse crash.
                        if (stopMs && stopMs < RETAIN_FROM) {
                            // Already ended. Kept only for a channel with a catch-up archive, back to
                            // its archive length (at most maxPastDays), while the budget lasts.
                            if (ver > 1 && pastUsed < pastBudget &&
                                stopMs >= nowMs - Math.min(ver - 1, maxPastDays) * 86400000 - 900000) {
                                pastUsed++;
                            } else {
                                pos = end;
                                processed++;
                                continue;
                            }
                        } else if (startMs && startMs > RETAIN_TO) {
                            pos = end;
                            processed++;
                            continue;
                        }
                        var title = decodeEntities(titleAt(xmlText, tagGt + 1, end - progEnd.length));
                        if (maxProgrammes && count >= maxProgrammes) {
                            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG capped at ' + maxProgrammes + ' programmes (reduced mode)'); } catch (eCap) {}
                            pos = xmlText.length;
                            feedDone = true;
                            break;
                        }
                        if (!programmes[cid]) programmes[cid] = [];
                        programmes[cid].push({
                            start: startMs,
                            stop: stopMs,
                            title: title,
                            desc: ''
                        });
                        count++;
                    }
                    pos = end;
                    processed++;
                }

                if (feed && !feedDone && (needMore || pos >= xmlText.length)) {
                    // Read the next slice, keeping the unparsed tail.
                    feed().then(function (c) {
                        if (c == null) feedDone = true;
                        else { xmlText = xmlText.substring(pos) + c; pos = 0; }
                        setTimeout(findAndParseChunk, 0);
                    }, function (eFeed) {
                        Util.logErr('EPG stream read failed - using what arrived: ' + (eFeed && eFeed.message));
                        feedDone = true;
                        setTimeout(findAndParseChunk, 0);
                    });
                    return;
                }
                if (pos < xmlText.length) {
                    // Periodic heap sample every ~20k programmes scanned, so we
                    // can see memory climb during the parse without spamming.
                    if (count - diagLast >= 20000) {
                        diagLast = count;
                        try {
                            if (typeof PerfConfig !== 'undefined') {
                                PerfConfig.mark('EPG parsing… ' + count + ' kept' +
                                    (feed ? ' (streaming)' : ', pos ' + Math.round(100 * pos / xmlText.length) + '%'));
                            }
                        } catch (eDiag2) {}
                    }
                    _scannedSinceBreather += processed;
                    var _delay = CHUNK_DELAY_MS;
                    if (_scannedSinceBreather >= EPG_BREATHER_EVERY) {
                        _scannedSinceBreather = 0;
                        _delay = EPG_BREATHER_MS;
                    }
                    setTimeout(findAndParseChunk, _delay);
                } else {
                    // Sort each channel's list and build the LIGHT lookup maps
                    // (which channel ids have programmes + lowercase aliases).
                    // Programmes stay in memory through parse + merge; the IDB
                    // offload + heap drop happens once in load(), after all
                    // sources are merged.
                    result._progChannels = {};
                    result._progChannelsLC = {};
                    for (var k in programmes) {
                        if (programmes.hasOwnProperty(k)) {
                            programmes[k].sort(function (a, b) { return a.start - b.start; });
                            // Same channel + same start twice (merged feeds repeat
                            // them): keep the first. The list is sorted, so
                            // duplicates are adjacent and this needs no extra memory.
                            var pl_ = programmes[k], w_ = 1, r_;
                            for (r_ = 1; r_ < pl_.length; r_++) {
                                if (pl_[r_].start === pl_[w_ - 1].start && pl_[r_].start) { dupDropped++; continue; }
                                pl_[w_++] = pl_[r_];
                            }
                            if (w_ < pl_.length) { pl_.length = w_; }
                            result._progChannels[k] = 1;
                            result._progChannelsLC[k.toLowerCase()] = k;
                            result.programmesLC[k.toLowerCase()] = programmes[k];
                        }
                    }
                    count -= dupDropped;
                    if (window.console && console.log) {
                        Log.log('[EPG] parsed: ' + Object.keys(result.channels).length + ' channels, ' +
                                    Object.keys(programmes).length + ' with programmes, ' + count + ' total programmes');
                    }
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('EPG parse done (' + count + ' kept' + (pastUsed ? ', ' + pastUsed + ' past for catch-up' : '') + ')'); } catch (eDiag3) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG parsed: ' + count + ' kept (horizon ' + horizonDays + 'd)' + (relevantFilter ? ' skipped ' + skippedIrrelevant + ' not in playlist' : '') + (dupDropped ? ' dups ' + dupDropped : '') + ' dateFails=' + _epgDateFails + (_epgDateSample ? ' eg[' + _epgDateSample + ']' : '')); } catch (eBcE) {}
                    resolve(result);
                }
            }

            setTimeout(findAndParseChunk, 25);
        });
    }

    function extractAttr(attrStr, name) {
        var idx = attrStr.indexOf(name + '="');
        if (idx < 0) return '';
        var start = idx + name.length + 2;
        var end = attrStr.indexOf('"', start);
        return end > start ? attrStr.substring(start, end) : '';
    }
    function extractTag(body, tag) {
        var open = '<' + tag;
        var idx = body.indexOf(open);
        if (idx < 0) return '';
        var gt = body.indexOf('>', idx);
        if (gt < 0) return '';
        var close = body.indexOf('</' + tag + '>', gt);
        if (close < 0) return '';
        return decodeEntities(body.substring(gt + 1, close).trim());
    }

    function makeEmptyEpg(playlistId) {
        var empty = { channels: {}, programmes: {}, programmesLC: {}, nameToId: {}, nameToIdExact: {}, _progChannels: {}, _progChannelsLC: {}, playlistId: playlistId || null, loadedAt: Date.now() };
        if (playlistId) STATE.byPlaylist[playlistId] = empty;
        return empty;
    }

    function mergeParsedEpg(base, extra) {
        var k, lk;
        if (!base) base = makeEmptyEpg();
        if (!extra) return base;
        for (k in extra.channels) if (extra.channels.hasOwnProperty(k) && !base.channels[k]) base.channels[k] = extra.channels[k];
        for (k in extra.programmes) if (extra.programmes.hasOwnProperty(k) && !base.programmes[k]) base.programmes[k] = extra.programmes[k];
        for (k in extra.programmesLC) if (extra.programmesLC.hasOwnProperty(k) && !base.programmesLC[k]) base.programmesLC[k] = extra.programmesLC[k];
        for (k in extra.nameToId) if (extra.nameToId.hasOwnProperty(k) && !base.nameToId[k]) base.nameToId[k] = extra.nameToId[k];
        for (k in extra.nameToIdExact) if (extra.nameToIdExact.hasOwnProperty(k) && !base.nameToIdExact[k]) base.nameToIdExact[k] = extra.nameToIdExact[k];
        if (extra._progChannels) { if (!base._progChannels) base._progChannels = {}; for (k in extra._progChannels) if (extra._progChannels.hasOwnProperty(k)) base._progChannels[k] = 1; }
        if (extra._progChannelsLC) { if (!base._progChannelsLC) base._progChannelsLC = {}; for (lk in extra._progChannelsLC) if (extra._progChannelsLC.hasOwnProperty(lk) && !base._progChannelsLC[lk]) base._progChannelsLC[lk] = extra._progChannelsLC[lk]; }
        base.loadedAt = Date.now();
        return base;
    }

    // Turn a fetched EPG response into XML text, decompressing gzip when needed.
    // Handles three cases: (1) a .gz URL fetched as arraybuffer -> inflate;
    // (2) a normal URL whose body nonetheless starts with the gzip magic bytes
    // (0x1f 0x8b) because the server served a raw .gz without Content-Encoding
    // -> inflate; (3) plain text -> pass through. Returns a string, or null if
    // the data is gzip we cannot inflate (caller then fails gracefully — never
    // feeds binary to the XML parser, which is what crashed on .xml.gz before).
    /* Size cap on one EPG file once unpacked (characters), from the performance policy. */
    function epgMaxChars() {
        var n = 0;
        try { if (typeof PerfConfig !== 'undefined') n = PerfConfig.get('epgMaxChars') || 0; } catch (eMc) {}
        return n > 0 ? n : 100000000;
    }
    /* Set when the last unpacked guide was cut at the cap (read once by fetchParseEpgUrl). */
    var _epgCapped = false;

    /* gzip -> string in slices, stopping once the text passes capChars. pako.inflate(...,{to:'string'})
     * builds the whole text first, which a very large guide turns into an out-of-memory failure. */
    function inflateCapped(u8, capChars) {
        var inf = new pako.Inflate({ to: 'string' });
        var parts = [], len = 0, STEP = 65536;
        inf.onData = function (c) { parts.push(c); len += c.length; };
        for (var i = 0; i < u8.length; i += STEP) {
            var last = i + STEP >= u8.length;
            inf.push(u8.subarray(i, last ? u8.length : i + STEP), last);
            if (inf.err) throw new Error(inf.msg || 'inflate');
            if (len > capChars && !last) { _epgCapped = true; break; }
        }
        return parts.join('');
    }

    function epgBodyToXml(body, wasArrayBuffer) {
        if (body == null) return '';
        // arraybuffer path (.gz URL): body is an ArrayBuffer of gzip bytes.
        if (wasArrayBuffer) {
            try {
                var u8 = new Uint8Array(body);
                if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
                    if (typeof window !== 'undefined' && window.pako && pako.inflate) {
                        return (pako.Inflate && u8.subarray) ? inflateCapped(u8, epgMaxChars()) : pako.inflate(u8, { to: 'string' });
                    }
                    Log.error('[EPG] gzip body but pako unavailable');
                    return null;
                }
                // Not actually gzip — decode the bytes as UTF-8 text.
                try {
                    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
                } catch (eTd) {}
                // Last-resort byte->char (ASCII/Latin1) if no TextDecoder.
                var s = '';
                for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                return s;
            } catch (eAb) {
                Log.error('[EPG] gzip inflate failed', eAb);
                return null;
            }
        }
        // text path: normally plain XML, but detect a raw-gzip body that came
        // back as a mangled string (first two char codes are the gzip magic).
        if (typeof body === 'string' && body.length >= 2 &&
            body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
            try {
                if (typeof window !== 'undefined' && window.pako && pako.inflate) {
                    var bytes = new Uint8Array(body.length);
                    for (var j = 0; j < body.length; j++) bytes[j] = body.charCodeAt(j) & 0xff;
                    return pako.inflate(bytes, { to: 'string' });
                }
            } catch (eStr) {
                Log.error('[EPG] gzip(text) inflate failed', eStr);
                return null;
            }
            Log.error('[EPG] gzip(text) body but pako unavailable');
            return null;
        }
        return body;
    }

    /* ---- Reading a guide as a stream ------------------------------------------------
     * A guide is handed to the parser in slices of about STREAM_SLICE characters, so it is
     * never held as one string. The engine's maximum string length (about 268M characters on a
     * 32-bit webOS TV, measured at 265 MB ok / 275 MB empty) therefore no longer limits the
     * guide size, and a gzip is unpacked a slice at a time instead of all at once. */
    var STREAM_SLICE = 1048576;
    function canStream() {
        try { return typeof TextDecoder !== 'undefined' && typeof Uint8Array !== 'undefined' && !!Uint8Array.prototype.subarray; } catch (e) { return false; }
    }
    // feed() over a source of byte chunks: readBytes() -> Promise<Uint8Array|null>. Detects gzip
    // by its magic bytes (a plain address may still serve gzip).
    function makeByteFeed(readBytes) {
        var dec = new TextDecoder('utf-8');
        var inf = null, started = false, ended = false, acc = [], accLen = 0;
        function emit(t) { if (t) { acc.push(t); accLen += t.length; } }
        function take() { var t = acc.join(''); acc = []; accLen = 0; return t; }
        return function feed() {
            return new Promise(function (resolve, reject) {
                (function step() {
                    if (accLen >= STREAM_SLICE || (ended && accLen)) { resolve(take()); return; }
                    if (ended) { resolve(null); return; }
                    readBytes().then(function (u8) {
                        try {
                            if (u8 == null) {
                                ended = true;
                                if (inf) { inf.push(new Uint8Array(0), true); if (inf.err) throw new Error(inf.msg || 'inflate'); }
                                else emit(dec.decode());
                            } else {
                                STATE.progBytes = (STATE.progBytes || 0) + u8.length;
                                if (!started && u8.length) {
                                    started = true;
                                    if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
                                        if (!(window.pako && pako.Inflate)) throw new Error('gzip body but pako unavailable');
                                        inf = new pako.Inflate({ to: 'string' });
                                        inf.onData = emit;
                                    }
                                }
                                if (inf) { inf.push(u8, false); if (inf.err) throw new Error(inf.msg || 'inflate'); }
                                else emit(dec.decode(u8, { stream: true }));
                            }
                        } catch (eRead) { reject(eRead); return; }
                        step();
                    }, reject);
                })();
            });
        };
    }
    function bufferReader(buf, step) {
        var u8 = new Uint8Array(buf), i = 0;
        return function () {
            if (i >= u8.length) return Promise.resolve(null);
            var e = Math.min(u8.length, i + step), c = u8.subarray(i, e);
            i = e;
            return Promise.resolve(c);
        };
    }
    function canFetchStream() {
        try { return typeof fetch === 'function' && typeof Response !== 'undefined' && 'body' in Response.prototype && canStream(); } catch (e) { return false; }
    }
    // Resolves {feed, bytes} (bytes known only for a gz arraybuffer); rejects before any data
    // arrives so the caller can fall back to the whole-text path.
    function openEpgStream(url, isGz, authHeader) {
        if (isGz) {
            return Util.xhr({ method: 'GET', url: url, timeout: 300000, responseType: 'arraybuffer', headers: authHeader || undefined })
                .then(function (r) {
                    var n = r.body ? r.body.byteLength : 0;
                    Log.log('[EPG] HTTP ' + r.status + ' - ' + n + ' bytes (gz, streaming)');
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('EPG fetched ' + Math.round(n / 1048576) + 'MB (gz)'); } catch (eDiag) {}
                    return { feed: makeByteFeed(bufferReader(r.body || new ArrayBuffer(0), 65536)) };
                });
        }
        if (!canFetchStream()) return Promise.reject(new Error('no-stream'));
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var opts = { method: 'GET' };
        if (authHeader) opts.headers = authHeader;
        if (ctl) opts.signal = ctl.signal;
        return fetch(url, opts).then(function (resp) {
            if (!resp.ok || !resp.body || !resp.body.getReader) throw new Error('http ' + resp.status);
            Log.log('[EPG] HTTP ' + resp.status + ' (streaming)');
            var reader = resp.body.getReader(), got = 0;
            function read() {
                // no bytes for 60 s -> give up on this download
                return new Promise(function (res, rej) {
                    var t = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (eA) {} rej(new Error('stalled')); }, 60000);
                    reader.read().then(function (r) {
                        clearTimeout(t);
                        if (r.done) { try { PerfConfig.mark('EPG fetched ' + Math.round(got / 1048576) + 'MB (streamed)'); } catch (eD) {} res(null); }
                        else { got += r.value.length; res(r.value); }
                    }, function (e) { clearTimeout(t); rej(e); });
                });
            }
            return { feed: makeByteFeed(read) };
        });
    }

    function fetchParseEpgUrl(url, gen, tries, authHeader, wantedLC) {
        /* Scrub credentials before logging. Xtream EPG
         * URLs include username/password as querystring parameters; the
         * raw URL would leak them to anyone with console access. */
        if (window.console && console.log) {
            Log.log('[EPG] fetching ' + (Crypto && Crypto.scrubUrl ? Crypto.scrubUrl(url) : url));
        }
        // Bounded retry on an empty/short body. Some providers intermittently
        // return a 0-byte / truncated EPG (observed: HTTP 222, 0 bytes) that
        // succeeds on a later attempt. Without this the guide rendered silently
        // empty until a manual app restart. We retry a few times with a short
        // backoff, then give up gracefully. tries counts attempts already made.
        tries = tries || 0;
        var MAX_EPG_RETRIES = 2;
        var EPG_RETRY_BACKOFF_MS = 4000;
        // A .gz (or .gzip) URL must be fetched as binary so pako can inflate it;
        // fetching gzip as text corrupts the bytes. Plain URLs stay on the text
        // path (which still guards against a stray gzip body).
        var isGz = /\.gz(ip)?(\?|#|$)/i.test(url);
        var xhrOpts = isGz
                ? { method: 'GET', url: url, timeout: 120000, responseType: 'arraybuffer' }
                : { method: 'GET', url: url, timeout: 120000, maxBytes: epgMaxChars(), truncateAt: true };
        _epgCapped = false;
        if (authHeader) xhrOpts.headers = authHeader;

        // Empty / short body: retry a few times, then give up (shared by both read paths).
        function onEmpty(len) {
            Log.error('[EPG] empty/short response (len=' + len + ')');
            // Don't retry if a newer load superseded this one.
            if (gen != null && gen !== STATE.loadGen) return makeEmptyEpg();
            if (tries < MAX_EPG_RETRIES) {
                if (tries === 0 && window.UI && UI.toast) UI.toast(T('epg_didn_t_load_retrying'), null);
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        if (gen != null && gen !== STATE.loadGen) { resolve(makeEmptyEpg()); return; }
                        resolve(fetchParseEpgUrl(url, gen, tries + 1, authHeader, wantedLC));
                    }, EPG_RETRY_BACKOFF_MS);
                });
            }
            if (window.UI && UI.toast) UI.toast(T('epg_unavailable_for_now'), 'err');
            return makeEmptyEpg();
        }

        // Preferred: read the guide as a stream (never one big string). Falls back to the
        // whole-text path below when the platform cannot stream or the request fails up front.
        function viaText() {
        return Util.xhr(xhrOpts)
            .then(function (r) {
                var rawLen = r.body ? (r.body.byteLength != null ? r.body.byteLength : r.body.length) : 0;
                if (r.truncated) _epgCapped = true;
                if (r.truncated && typeof r.body === 'string' && r.body.length > epgMaxChars()) r.body = r.body.substring(0, epgMaxChars());
                if (window.console && console.log) {
                    Log.log('[EPG] HTTP ' + r.status + ' - ' + rawLen + ' bytes' + (isGz ? ' (gz)' : ''));
                }
                try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('EPG fetched ' + Math.round(rawLen / 1048576) + 'MB'); } catch (eDiag) {}
                var xml = epgBodyToXml(r.body, isGz);
                if (xml === null) {
                    // gzip we couldn't inflate — fail gracefully, never parse binary.
                    if (window.UI && UI.toast) UI.toast(T('epg_unavailable_for_now'), 'err');
                    return makeEmptyEpg();
                }
                return xml;
            })
            .then(function (xml) {
                if (xml && xml.channels) return xml; // already an empty-epg object from a graceful bail
                if (!xml || xml.length < 40) return onEmpty(xml && xml.length);
                // Bail before the heavy parse if a newer load already superseded us.
                if (gen != null && gen !== STATE.loadGen) return makeEmptyEpg();
                if (_epgCapped) {
                    _epgCapped = false;
                    if (window.UI && UI.toast) UI.toast(T('epg_too_large_partial'), null);
                }
                Log.log('[EPG] parsing ' + Math.round(xml.length / 1024 / 1024) + 'MB XML...');
                return parseXmltvChunked(xml, gen, wantedLC);
            })['catch'](function (e) {
                Log.error('[EPG] source failed', e);
                return makeEmptyEpg();
            });
        }

        if (!canStream()) return viaText();
        return openEpgStream(url, isGz, authHeader).then(function (st) {
            if (gen != null && gen !== STATE.loadGen) return makeEmptyEpg();
            return st.feed().then(function (first) {
                if (first == null || first.length < 40) return onEmpty(first ? first.length : 0);
                if (gen != null && gen !== STATE.loadGen) return makeEmptyEpg();
                Log.log('[EPG] parsing as a stream...');
                return parseXmltvChunked(first, gen, wantedLC, st.feed);
            }, function () { return viaText(); });
        }, function () {
            return viaText();    // could not open a stream: whole-text path
        })['catch'](function (e) {
            Log.error('[EPG] source failed', e);
            return makeEmptyEpg();
        });
    }

    function getEpgSourceUrls(playlist) {
        var settings = Store.getSettings ? Store.getSettings() : {};
        var urls = [];
        var i, u, externals;
        externals = settings.externalEpgUrls || null;
        if ((!externals || !externals.length) && settings.externalEpgUrl) externals = [settings.externalEpgUrl];
        // "Override provider EPG" only means anything when an external EPG actually
        // exists to override TO. If override is on but there are no external
        // sources (e.g. they were cleared after being paired with override on),
        // treat override as off so the provider EPG is still used — otherwise the
        // guide would report no source despite the provider having one.
        var overrideActive = settings.externalEpgOverride === 'on' &&
                             !!(externals && externals.length);
        // Respect the per-playlist provider-EPG toggle: if provider EPG is disabled
        // for this playlist, never include the provider URL (regardless of override).
        // Externals are a separate opt-in and are unaffected by this toggle.
        var providerOn = !(playlist && playlist.id && Store.getPlaylistEpgEnabled &&
                           Store.getPlaylistEpgEnabled(playlist.id) === false);
        if (!overrideActive && providerOn) {
            if (playlist && playlist.epgUrl) urls.push(playlist.epgUrl);
            else if (playlist && playlist.type === 'xtream') urls.push(Api.xtreamEpgUrl(playlist.host, playlist.user, playlist.pass));
        }
        for (i = 0; externals && i < externals.length && i < 3; i++) {
            u = String(externals[i] || '').replace(/^\s+|\s+$/g, '');
            if (u && urls.indexOf(u) < 0) urls.push(u);
        }
        // Lite mode: ONE source only.
        //
        // Normal allows a multi-source merge (provider EPG plus up to 3 externals).
        // Lite exists for small-heap / slow devices, and every extra XMLTV feed
        // multiplies exactly the costs Lite is trying to avoid: another fetch,
        // another full parse, and another set of IDB writes. A single provider EPG
        // is already the heaviest step of a cold load (a 122MB XML and a 322k
        // programme parse have both been observed), so merging several is precisely
        // what a constrained device cannot afford.
        //
        // The list above is built in PRECEDENCE order — when externalEpgOverride is
        // 'on' the provider EPG is never pushed, so urls[0] is the first external;
        // otherwise urls[0] is the provider EPG. Taking the first element therefore
        // honours the override without needing to re-derive which source won.
        try {
            if (typeof PerfConfig !== 'undefined' && PerfConfig.isLite && PerfConfig.isLite() && urls.length > 1) {
                if (window.console && console.log) {
                    Log.log('[EPG] Lite mode: using 1 of ' + urls.length +
                        ' sources (multi-source merge is disabled on constrained devices)');
                }
                urls = urls.slice(0, 1);
            }
        } catch (eLite) {}
        return urls;
    }

    // Progress for the "Loading TV guide" toast: bytes read so far in this load, and how many loads run.
    function load(playlist) {
        STATE.busy = (STATE.busy || 0) + 1;
        STATE.progBytes = 0;
        var done = function () { STATE.busy = Math.max(0, (STATE.busy || 1) - 1); };
        var p = loadInner(playlist);
        p.then(done, done);
        return p;
    }
    function isBusy() { return (STATE.busy || 0) > 0; }
    function progressMB() { return Math.round((STATE.progBytes || 0) / 104857.6) / 10; }
    function loadInner(playlist) {
        // Cancellation: each load() bumps a generation counter. The chunked parse
        // checks it and aborts if a newer load has started (e.g. the user switched
        // playlists mid-parse), so two heavy 50MB+ parses never run concurrently —
        // that overlap could exhaust memory and hard-freeze the TV.
        STATE.loadGen = (STATE.loadGen || 0) + 1;
        var myGen = STATE.loadGen;
        var urls = getEpgSourceUrls(playlist);
        var idx = 0;
        var merged = makeEmptyEpg();
        var allSourcesOk = true;   // cleared if any source parses empty/fails
        if (!urls.length) {
            Log.log('[EPG] no EPG URL for playlist ' + playlist.id);
            // Stalker playlists showed no EPG for any channel, on every
            // platform: this
            // used to unconditionally call makeEmptyEpg(playlist.id) here,
            // which OVERWRITES STATE.byPlaylist[playlistId] wholesale.
            // load() is called generically for the ACTIVE playlist
            // regardless of type — once at app boot (~9s in, with no
            // check for whether a URL-based source even exists) and again
            // on a couple of reload paths — so this branch runs for every
            // Stalker playlist, every time, since Stalker never has an
            // XMLTV URL (its EPG arrives per-channel from the portal via
            // ui.js's loadStalkerEpgForPage/Api.stalkerEpgBatch calling
            // Epg.setChannelProgrammes, entirely independent of this
            // fetch-and-parse path — see setChannelProgrammes's own doc
            // comment). Wiping this object here silently discarded
            // whatever Stalker had already written in by the time this ran
            // — and ui.js's own dedup cache (stalkerState.epgFetched) has
            // no idea the wipe happened, so it never retries a channel it
            // already marked fetched: once wiped, that channel stays blank
            // for the rest of the session, which matches "no EPG for any
            // channel" exactly (every channel gets wiped the same way).
            // Preserve whatever's already resident for this playlist
            // instead; only create a fresh empty entry if there's
            // genuinely nothing there yet (first load, or a playlist type
            // that really has no EPG at all — unchanged for those).
            return Promise.resolve(STATE.byPlaylist[playlist.id] || makeEmptyEpg(playlist.id));
        }

        var setKey = sourceSetKey(urls);
        var forced = !!EPG_FORCE[playlist.id];
        EPG_FORCE[playlist.id] = false;

        // Freshness gate: try to reuse a recent complete parse and skip fetching.
        // Falls through to the fetch loop on any miss/doubt.
        function tryCacheThenLoad() {
            if (forced || typeof IDB === 'undefined' || !IDB.epgMetaGet) {
                return runFetchLoop();
            }
            return IDB.epgMetaGet(playlist.id).then(function (rec) {
                if (myGen !== STATE.loadGen) return merged; // superseded while awaiting
                var fresh = rec && rec.complete && rec.maps &&
                    rec.sourceSetKey === setKey &&
                    (Date.now() - (rec.parsedAt || 0)) < EPG_CACHE_TTL_MS &&
                    (rec.coverUntil || 0) > Date.now();
                if (fresh) {
                    var e = rehydrateFromMaps(playlist.id, rec.maps, rec.coverUntil);
                    STATE.byPlaylist[playlist.id] = e;
                    Log.log('[EPG] using cached parse (age ' + Math.round((Date.now() - rec.parsedAt) / 60000) + 'm) — skipped fetch');
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG freshness hit; fetch+parse skipped'); } catch (eBd) {}
                    return e;
                }
                return runFetchLoop();
            })['catch'](function () { return runFetchLoop(); });
        }

        function next() {
            if (myGen !== STATE.loadGen) {
                // A newer load superseded this one; stop without storing.
                return merged;
            }
            if (idx >= urls.length) {
                merged.loadedAt = Date.now();
                merged.playlistId = playlist.id;
                // Forward horizon covered by this parse, used by the freshness
                // gate to reject a cache that no longer spans "now + epgMaxDays".
                var horizonDays = 3;
                try { if (typeof PerfConfig !== 'undefined') { var h = PerfConfig.get('epgMaxDays'); if (typeof h === 'number' && h > 0) horizonDays = h; } } catch (eH) {}
                var coverUntil = Date.now() + horizonDays * 24 * 60 * 60 * 1000;
                var lightMaps = extractLightMaps(merged);
                // Offload the merged programme lists to IndexedDB and drop them
                // from the heap, keeping only the light lookup maps + the on-demand
                // LRU resident. This is what stops ~175k programme objects from
                // competing with the VOD/series search index on small-heap TVs.
                // Store first so the guide is usable immediately, then persist and
                // drop asynchronously; if IDB is unavailable the in-memory maps
                // remain and resolveList's legacy path serves reads.
                STATE.byPlaylist[playlist.id] = merged;
                var canIdb = (typeof IDB !== 'undefined' && IDB.epgPutAll && merged.programmes);
                if (canIdb) {
                    // Gen-guard the write. If a newer load for this playlist has
                    // started, do NOT write — its own epgPutAll (which begins with
                    // epgClearPlaylist and then writes in chunked transactions) would
                    // otherwise interleave with ours in the same object store and
                    // leave a mix of the two guides or missing channels. Skipping
                    // here is safe: the newer load owns the persisted copy, and this
                    // load's in-memory merged set still serves reads until then.
                    if (myGen !== STATE.loadGen) {
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG write skipped (superseded by newer load)'); } catch (eSk) {}
                        return merged;
                    }
                    var progRef = merged.programmes;
                    // Settle signal for the caller (whenSettled): the movie/series
                    // preload waits for this write to finish and the programme lists
                    // to be dropped, so the two never compete for the heap. Resolves
                    // on success, failure or error alike, never rejects.
                    var settleDone = function () {};
                    STATE.settling[playlist.id] = new Promise(function (res) { settleDone = res; });
                    var slowTimer = setTimeout(function () {
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG persist still running after 8s'); } catch (eSl) {}
                    }, 8000);
                    var onPersisted = function (ok) {
                        try { clearTimeout(slowTimer); } catch (eCt) {}
                        if (!ok) {
                            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG persist FAILED; guide stays on the heap'); } catch (eFl) {}
                        }
                        // Re-check generation: a newer load may have started while
                        // this write was in flight. If so, leave its result alone —
                        // don't drop our heap copy (it may still be the active read
                        // source) and don't stamp a meta record that could shadow the
                        // newer write.
                        if (myGen !== STATE.loadGen) {
                            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG write completed but superseded — meta not stamped'); } catch (eSk2) {}
                            return;
                        }
                        if (ok && STATE.byPlaylist[playlist.id] === merged) {
                            merged.programmes = null;
                            merged.programmesLC = null;
                            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG persisted to IDB; programmes dropped from heap'); } catch (eBd) {}
                        }
                        // Only stamp a fresh, reusable record when EVERY source
                        // parsed non-empty AND the programmes actually persisted.
                        // A partial merge is never fast-pathed: a failed record is
                        // deleted so the next boot re-parses rather than trusting a
                        // degraded guide.
                        if (typeof IDB !== 'undefined' && IDB.epgMetaPut) {
                            if (ok && allSourcesOk && lightMaps) {
                                IDB.epgMetaPut(playlist.id, {
                                    parsedAt: Date.now(),
                                    sourceSetKey: setKey,
                                    coverUntil: coverUntil,
                                    complete: true,
                                    maps: lightMaps
                                })['catch'](function () {});
                            } else if (IDB.epgMetaDelete) {
                                IDB.epgMetaDelete(playlist.id)['catch'](function () {});
                            }
                        }
                    };
                    IDB.epgPutAll(playlist.id, progRef).then(function (ok) {
                        try { onPersisted(ok); } catch (ePh) {}
                        settleDone();
                    }, function () {
                        try { clearTimeout(slowTimer); } catch (eCt2) {}
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('EPG persist ERROR; guide stays on the heap'); } catch (eEr) {}
                        settleDone();
                    });
                }
                return merged;
            }
            var _curUrl = urls[idx++];
            var _epgHdr = null;
            // Basic auth: the playlist's OWN EPG URL uses playlist.epgAuth*, and
            // each EXTERNAL EPG URL uses its index-aligned entry in
            // externalEpgAuth. Match this url to whichever applies.
            if (Api.basicAuthHeader) {
                if (playlist && playlist.epgUrl && _curUrl === playlist.epgUrl &&
                    (playlist.epgAuthUser || playlist.epgAuthPass)) {
                    _epgHdr = Api.basicAuthHeader(playlist.epgAuthUser, playlist.epgAuthPass);
                } else {
                    try {
                        var _st = Store.getSettings ? Store.getSettings() : {};
                        var _exUrls = _st.externalEpgUrls || [];
                        var _exAuth = _st.externalEpgAuth || [];
                        for (var _xi = 0; _xi < _exUrls.length; _xi++) {
                            if (_exUrls[_xi] === _curUrl && _exAuth[_xi] &&
                                (_exAuth[_xi].user || _exAuth[_xi].pass)) {
                                _epgHdr = Api.basicAuthHeader(_exAuth[_xi].user, _exAuth[_xi].pass);
                                break;
                            }
                        }
                    } catch (eXa) {}
                }
            }
            return fetchParseEpgUrl(_curUrl, myGen, 0, _epgHdr, WANTED[playlist.id] || null).then(function (parsed) {
                // A source that failed/emptied resolves to an empty EPG (see
                // fetchParseEpgUrl); detect that so the merge isn't stamped fresh.
                if (!parsed || !parsed.programmes || isEmptyParsed(parsed)) allSourcesOk = false;
                merged = mergeParsedEpg(merged, parsed);
                return next();
            });
        }

        function runFetchLoop() { return next(); }

        return tryCacheThenLoad();
    }

    // True if a parsed EPG carries no programmes for any channel (an empty/failed
    // source resolves to makeEmptyEpg()). Used only to gate cache-freshness, not
    // to change merge behavior.
    function isEmptyParsed(parsed) {
        if (!parsed || !parsed.programmes) return true;
        for (var k in parsed.programmes) {
            if (parsed.programmes.hasOwnProperty(k) && parsed.programmes[k] && parsed.programmes[k].length) return false;
        }
        return true;
    }

    // Force the next load() for this playlist to bypass the freshness gate and
    // re-fetch + re-parse every source. Wired to the playlist "EPG Refresh"
    // action. Re-runs the full load(), which re-merges provider + externals.
    function forceReload(playlist) {
        if (!playlist || !playlist.id) return Promise.resolve(makeEmptyEpg());
        EPG_FORCE[playlist.id] = true;
        return load(playlist);
    }

    // Resolve a tvgId to the canonical channel id used as the programme key,
    // using only the light, always-resident lookup maps.
    function resolveChannelId(data, tvgId) {
        if (!data || !tvgId) return null;
        var lc = tvgId.toLowerCase();
        // Prefer an id that ACTUALLY HAS PROGRAMMES. An external EPG can declare a
        // <channel> whose id matches the live tvg-id but carry no programmes for it;
        // if we matched on mere existence we'd resolve to that empty channel and
        // blank the guide, even though another source (e.g. the provider) has the
        // data under a name-matched id. So check the programme-bearing maps first.
        if (data._progChannels && data._progChannels[tvgId]) return tvgId;
        if (data._progChannelsLC && data._progChannelsLC[lc]) return data._progChannelsLC[lc];
        // Display-name -> id, but only when that id has programmes.
        if (data.nameToIdExact && data.nameToIdExact[tvgId] &&
            (!data._progChannels || data._progChannels[data.nameToIdExact[tvgId]])) return data.nameToIdExact[tvgId];
        if (data.nameToId && data.nameToId[lc] &&
            (!data._progChannels || data._progChannels[data.nameToId[lc]])) return data.nameToId[lc];
        // Fallbacks (no programme-bearing match found): keep the original behaviour
        // so channels that legitimately resolve by name/id still work when there is
        // no conflict. A direct channels[] hit is last so it can't hijack a
        // populated alias above.
        if (data.nameToIdExact && data.nameToIdExact[tvgId]) return data.nameToIdExact[tvgId];
        if (data.nameToId && data.nameToId[lc]) return data.nameToId[lc];
        if (data.channels && data.channels[tvgId]) return tvgId;
        return null;
    }

    function resolveList(data, tvgId) {
        if (!data || !tvgId) return null;
        // In-memory programmes (Stalker's per-channel get_short_epg
        // injection, or any other in-memory source) take priority when
        // present for this exact tvgId — fast, and always at least as
        // fresh as an external file.
        if (data.programmes) {
            if (data.programmes[tvgId]) return data.programmes[tvgId];
            if (data.programmesLC && data.programmesLC[tvgId.toLowerCase()]) return data.programmesLC[tvgId.toLowerCase()];
            if (data.nameToIdExact && data.nameToIdExact[tvgId] && data.programmes[data.nameToIdExact[tvgId]]) return data.programmes[data.nameToIdExact[tvgId]];
            if (data.nameToId && data.nameToId[tvgId.toLowerCase()] && data.programmes[data.nameToId[tvgId.toLowerCase()]]) return data.programmes[data.nameToId[tvgId.toLowerCase()]];
            // Stalker channels showed no EPG even with an
            // external EPG source configured: this used to return null right here,
            // unconditionally, on any miss. data.programmes is truthy for
            // EVERY Stalker playlist from the moment it's created —
            // makeEmptyEpg sets programmes: {} before Stalker ever writes
            // a single channel into it — so this branch was ALWAYS taken
            // for a Stalker playlist, meaning a genuinely-loaded, correctly
            // parsed external XMLTV EPG sitting in IDB could never be
            // reached for a Stalker channel: this function returned null
            // before the IDB-backed lookup below ever ran, no matter how
            // well the external source was configured or matched. Fall
            // through instead of returning, so an external source can
            // still serve a channel the in-memory source has nothing for.
            // Harmless for a playlist that only ever has in-memory data
            // (M3U with no EPG, say): the IDB-backed lookup below simply
            // finds nothing either and returns null the same as before.
        }
        // IDB-backed path: resolve to channel id via light maps, then read the
        // list from the LRU. On a miss, kick off an async load and return null
        // for now (the re-render hook shows it a moment later).
        var chId = resolveChannelId(data, tvgId);
        if (!chId) return null;
        var pid = data.playlistId;
        var cached = epgLruGet(pid, chId);
        if (cached !== undefined) {
            // Guard against a STALE EMPTY entry: if the LRU cached [] for a channel
            // that _progChannels says has programmes, the async load ran before the
            // IDB write landed (load/write race). Drop the stale entry and reload —
            // otherwise the row stays blank forever despite data being in IDB.
            if (cached && cached.length === 0 && data._progChannels && data._progChannels[chId]) {
                epgLruDrop(pid, chId);
                epgLoadChannelAsync(pid, chId);
                return null;
            }
            return cached;
        }
        epgLoadChannelAsync(pid, chId);
        return null;
    }

    /* Inject a programme list for a single channel under a playlist. Used by
     * Stalker, whose EPG arrives per-channel (get_short_epg) rather than as one
     * bulk XMLTV. Creates the playlist bucket if absent and stores under the
     * channel key so resolveList / getProgrammesBetween find it like any other. */
    function setChannelProgrammes(playlistId, channelKey, programmes) {
        if (!playlistId || !channelKey) return;
        var data = STATE.byPlaylist[playlistId];
        if (!data) {
            // This stub used to omit playlistId, unlike
            // makeEmptyEpg's struct. Usually harmless on its own — but a
            // separate, earlier fix made Epg.load()'s no-URL branch
            // PRESERVE an existing STATE.byPlaylist[id] rather than
            // replacing it, so if Stalker's own setChannelProgrammes created
            // this object FIRST (no playlistId), a later Epg.load() call
            // for the same playlist (e.g. applying an external EPG) would
            // now preserve this playlistId-less object indefinitely rather
            // than ever getting a corrected one — permanently breaking
            // resolveList's IDB-backed fallback path (needs data.playlistId
            // to look anything up), which is exactly the path that fell
            // through into. Setting it here closes that gap regardless of
            // which code path creates this object first.
            data = { programmes: {}, programmesLC: {}, nameToId: {}, nameToIdExact: {}, playlistId: playlistId };
            STATE.byPlaylist[playlistId] = data;
        }
        if (!data.programmes) data.programmes = {};
        data.programmes[String(channelKey)] = programmes || [];
    }

    function getNowNext(playlistId, tvgId) {
        if (!tvgId) return { now: null, next: null };
        var data = STATE.byPlaylist[playlistId];
        var list = resolveList(data, tvgId);
        if (!list) return { now: null, next: null };
        var now = Date.now();
        var currentIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (list[i].start <= now && list[i].stop > now) { currentIdx = i; break; }
            if (list[i].start > now) { currentIdx = i - 1; break; }
        }
        var nowP = currentIdx >= 0 ? list[currentIdx] : null;
        var nextP = currentIdx + 1 < list.length ? list[currentIdx + 1] : null;
        // Overlapping feed entries (two programmes covering the same time): the
        // guide rows already drop the shorter one (dedupOverlaps); do the same here
        // so Next is the programme that really follows Now, not one that starts
        // while Now is still running. Only done when an overlap is actually seen.
        if (nowP && nextP && nextP.start < nowP.stop - 10000) {
            var win = [];
            for (var w = Math.max(0, currentIdx - 3); w < list.length && win.length < 40; w++) {
                if (list[w].stop > now - 6 * 3600000 && list[w].start < now + 24 * 3600000) win.push(list[w]);
            }
            var dd = dedupOverlaps(win), ci = -1, d;
            for (d = 0; d < dd.length; d++) {
                if (dd[d].start <= now && dd[d].stop > now) { ci = d; break; }
                if (dd[d].start > now) { ci = d - 1; break; }
            }
            nowP = ci >= 0 ? dd[ci] : null;
            nextP = ci + 1 < dd.length ? dd[ci + 1] : null;
        }
        return { now: nowP, next: nextP };
    }

    function getProgrammesBetween(playlistId, tvgId, startMs, endMs) {
        var data = STATE.byPlaylist[playlistId];
        var list = resolveList(data, tvgId);
        if (!list) return [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].stop > startMs && list[i].start < endMs) out.push(list[i]);
        }
        return dedupOverlaps(out);
    }

    // Drop programmes that overlap a kept one on the same
    // channel. Real XMLTV feeds often contain duplicate / overlapping
    // entries — e.g. the same show repeated with slightly different
    // timestamps, or a "main entry" plus an ad-break override that should
    // have replaced it but got appended. Result was overlapping titles
    // drawn on top of each other in the same row (for example a
    // 20-minute entry overlapping the next one by 9 minutes).
    //
    // Strategy: walk programmes in start-time order; for each candidate,
    // if it overlaps the most recent KEPT programme by more than a few
    // seconds, drop the shorter one (or break ties by keeping the
    // earlier-starting). Tiny overlaps (≤ 10s) are tolerated — those
    // usually come from timestamp rounding and not from real conflicts.
    function dedupOverlaps(progs) {
        if (!progs || progs.length < 2) return progs || [];
        // Sort by start, stable on stop (longer first if same start)
        var sorted = progs.slice(0).sort(function (a, b) {
            if (a.start !== b.start) return a.start - b.start;
            return (b.stop - b.start) - (a.stop - a.start);
        });
        var TOLERANCE_MS = 10 * 1000;
        var kept = [];
        for (var i = 0; i < sorted.length; i++) {
            var cur = sorted[i];
            // If cur is fully contained inside an already-kept programme
            // (i.e. starts later AND ends earlier), drop cur. We compare
            // against the most recent kept entry only (programmes are now
            // start-sorted, so anything earlier-starting that ended before
            // cur can't overlap it).
            var last = kept.length ? kept[kept.length - 1] : null;
            if (!last) { kept.push(cur); continue; }
            // Overlap amount in ms.
            var overlap = Math.min(cur.stop, last.stop) - Math.max(cur.start, last.start);
            if (overlap <= TOLERANCE_MS) {
                // No meaningful overlap; keep both.
                kept.push(cur);
                continue;
            }
            // Real overlap. Keep the longer programme. If equal length,
            // keep the earlier-starting (which is last, since sorted).
            var lastDur = last.stop - last.start;
            var curDur = cur.stop - cur.start;
            if (curDur > lastDur) {
                // cur is longer — replace last
                kept[kept.length - 1] = cur;
            }
            // else: drop cur (don't push)
        }
        return kept;
    }

    function dataFor(playlistId) { return STATE.byPlaylist[playlistId] || null; }

    /* Drop a playlist's loaded EPG (used when the per-playlist EPG toggle is
     * turned off). Leaves other playlists untouched. */
    function clear(playlistId) {
        if (playlistId && STATE.byPlaylist[playlistId]) {
            delete STATE.byPlaylist[playlistId];
        }
    }

    /* Free every playlist's EPG except the one given. Only the active playlist's
     * EPG is ever displayed, but switching playlists used to leave the previous
     * playlist's parsed EPG resident — so two (or more) full ~57MB datasets piled
     * up in memory and OOM'd the TV on switch, even though a single playlist left
     * alone was fine. Called on activation to keep only the active EPG. */
    function clearAllExcept(keepId) {
        for (var pid in STATE.byPlaylist) {
            if (STATE.byPlaylist.hasOwnProperty(pid) && pid !== keepId) {
                delete STATE.byPlaylist[pid];
            }
        }
    }

    function hasEpgSource(playlist) {
        try { return getEpgSourceUrls(playlist).length > 0; }
        catch (e) { return false; }
    }

    // Resolves once the latest load for this playlist has finished offloading its
    // programmes to IndexedDB (or failed to), or at once if nothing is pending.
    // maxMs caps the wait so a stuck write can never hold anything back.
    function whenSettled(playlistId, maxMs) {
        var p = STATE.settling[playlistId];
        if (!p) return Promise.resolve(false);
        return new Promise(function (resolve) {
            var done = false;
            var t = setTimeout(function () { if (!done) { done = true; resolve(false); } }, maxMs || 30000);
            p.then(function () { if (!done) { done = true; clearTimeout(t); resolve(true); } });
        });
    }

    return {
        whenSettled: whenSettled,
        load: load,
        isBusy: isBusy,
        progressMB: progressMB,
        setWantedChannels: setWantedChannels,
        forceReload: forceReload,
        hasEpgSource: hasEpgSource,
        clear: clear,
        clearAllExcept: clearAllExcept,
        getNowNext: getNowNext,
        setChannelProgrammes: setChannelProgrammes,
        getProgrammesBetween: getProgrammesBetween,
        setEpgRerenderHook: setEpgRerenderHook,
        prefetchChannels: prefetchChannels,
        dataFor: dataFor,
        parseXmltv: parseXmltvChunked
    };
})();
