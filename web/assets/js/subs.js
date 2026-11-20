/*
 * subs.js — subtitle discovery and conversion.
 *
 * Talks to the public Wyzie subtitle aggregator (sub.wyzie.ru), fetches
 * a candidate list per VOD item, then on-demand downloads the chosen
 * file, normalises it (SRT → WebVTT if needed), and returns a Blob URL
 * that the player can attach to a <track> element.
 *
 * ES5 / WebOS 6.5 compatible. No fetch.then().finally() chains, no
 * arrow functions, no destructuring. We use Promise (polyfilled by
 * polyfills.js if missing) and XMLHttpRequest under the hood.
 *
 * Public API (Subs.* on window):
 *   Subs.fetchForItem(item)        -> Promise<TrackOption[]>
 *     Returns the list of available subtitle tracks for a VOD item.
 *     Cached per item-key for the session; a second call with the same
 *     item returns the cached result without a network round-trip.
 *   Subs.loadTrack(option)         -> Promise<{blobUrl, format}>
 *     Downloads the chosen track, converts SRT->VTT if needed, returns
 *     a Blob URL the caller can drop into <track src>. The Blob URL is
 *     remembered so we can revoke it later when subtitles change.
 *   Subs.clearActive()
 *     Revokes any Blob URLs from the current item so we don't leak
 *     memory when the user switches VODs.
 *
 * Each TrackOption: { language, languageName, format, url, source }
 *   - language: ISO 639-3 code as returned by Wyzie (e.g. 'eng')
 *   - languageName: human-readable ('English')
 *   - format: 'srt' | 'vtt' | 'ass' (we drop 'ass' on the floor;
 *     positioning/styling can't be cleanly mapped to <track>)
 *   - url: the absolute URL of the subtitle file
 *   - source: provider ('opensubtitles', 'subdl', etc.) for logging
 *
 * Item-key strategy (what fetchForItem keys its cache by):
 *   Prefers tmdb_id, then imdb_id, then title+year. If only title+year
 *   is available we ask Wyzie to do a title search and only return
 *   results that match the exact title+year tuple (no fuzzy matching).
 */
var Subs = (function () {
    'use strict';

    /* Changed in v9 server patch.
     * Wyzie now requires an API key; the key lives server-side in
     * WYZIE_API_KEY env var. The TV no longer talks to sub.wyzie.io
     * directly — it goes through the pairing server proxy at
     *   GET /api/subtitles?id=...&season=...&episode=...&language=...
     *   GET /api/subtitle-file?url=<encoded>
     * which injects the key, validates host allowlists, and rate-limits.
     *
     * Also corrected the previous client:
     *   1. Old domain was .ru (typo); current Wyzie is sub.wyzie.io.
     *      Doesn't matter now since we hit our own proxy, but keep it
     *      noted for posterity.
     *   2. Wyzie's 'id' param accepts BOTH IMDB ("tt...") and TMDB
     *      (numeric) — it disambiguates by the "tt" prefix. The old
     *      client used id= only for IMDB and tmdb_id= for TMDB,
     *      which Wyzie no longer supports.
     *   3. Language codes are 2-letter ISO 639-1 ('en', 'nl'), not
     *      3-letter ISO 639-3 ('eng', 'nld').
     *   4. Response fields: each entry has display (human name),
     *      language (2-letter), url, format, media. */
    function apiBase() {
        var base = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.PAIR_SERVER)
            ? APP_CONFIG.PAIR_SERVER : '';
        // Strip trailing slash if present
        return base.replace(/\/+$/, '');
    }
    var SEARCH_PATH = '/api/subtitles';
    var FILE_PATH = '/api/subtitle-file';
    var RESOLVE_PATH = '/api/tmdb-resolve';

    // Network timeout (ms). Wyzie is generally fast but the third-party
    // sources behind it can be slow; 7s is a balance between giving
    // results a chance to land and not stalling the modal.
    var REQ_TIMEOUT = 7000;

    // Per-session cache. Key = item identity string, value = Promise
    // (so concurrent calls during the same session share one request).
    // Cleared only when the page reloads — items are typically watched
    // once per session so this is fine.
    var fetchCache = {};

    // Blob URLs we've created and should revoke on clearActive(). Each
    // entry is the URL string from URL.createObjectURL. The list is
    // small (one or two URLs at a time) so a plain array is fine.
    var activeBlobUrls = [];

    /* Wyzie now uses ISO 639-1 (2-letter) codes. The
     * old table was 3-letter ISO 639-3. Both are documented; we keep
     * a small map of common 2-letter codes for the picker label.
     * Anything not in the table falls back to the code itself in
     * uppercase ("PL" for Polish if we missed it). */
    var LANG_NAMES = {
        en: 'English', es: 'Spanish', fr: 'French', de: 'German',
        it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic',
        zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi',
        bn: 'Bengali', tr: 'Turkish', nl: 'Dutch', pl: 'Polish',
        sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian',
        cs: 'Czech', el: 'Greek', he: 'Hebrew', hu: 'Hungarian',
        ro: 'Romanian', uk: 'Ukrainian', vi: 'Vietnamese', th: 'Thai',
        id: 'Indonesian', ms: 'Malay', bg: 'Bulgarian', hr: 'Croatian',
        sr: 'Serbian', sk: 'Slovak', sl: 'Slovenian', ca: 'Catalan',
        et: 'Estonian', lt: 'Lithuanian', lv: 'Latvian', is: 'Icelandic',
        ga: 'Irish', mt: 'Maltese', cy: 'Welsh'
    };

    /* ---- Item-key derivation ---- */

    // Build a stable identifier for an item so we can cache by it. The
    // returned object also contains the search params we send to Wyzie.
    function itemKey(item) {
        if (!item) return null;
        // Stalker/MAG portals expose an internal numeric content ID that is NOT a
        // real TMDB/IMDB ID. Trusting it sends a bogus id to the subtitle search
        // (finds nothing). Ignore IDs for stalker items so they key/search by title.
        var isStalker = (item.type === 'stalker');
        // tmdb_id and imdb_id may come back from Xtream as 'tmdb_id' or
        // 'tmdb'; same for imdb. Try both.
        var tmdb = isStalker ? null : (item.tmdb_id || item.tmdb || item.tmdbId || null);
        var imdb = isStalker ? null : (item.imdb_id || item.imdb || item.imdbId || null);
        // Normalise imdb: Wyzie expects 'ttNNNNNNN' format. If we got a
        // bare number, prefix it. If we got the full "ttNNNNNNN", keep.
        if (imdb) {
            imdb = String(imdb);
            if (imdb.indexOf('tt') !== 0) imdb = 'tt' + imdb;
        }
        var title = item.name || item.title || '';
        var year = item.year || '';
        var season = item.season || item.season_num || null;
        var episode = item.episode || item.episode_num || null;

        if (!tmdb && !imdb && !title) return null;

        var key;
        if (tmdb) key = 'tmdb:' + tmdb;
        else if (imdb) key = 'imdb:' + imdb;
        else key = 'title:' + String(title).toLowerCase() + '|y:' + year;
        if (season != null && episode != null) {
            key = key + '|s' + season + 'e' + episode;
        }
        return {
            key: key,
            tmdb: tmdb,
            imdb: imdb,
            title: title,
            year: year,
            season: season,
            episode: episode
        };
    }

    /* ---- Search request (via pairing-server proxy) ---- */

    function buildSearchUrl(ik) {
        // 'Id' accepts both forms — Wyzie checks for
        // 'tt' prefix to disambiguate. We prefer IMDB if we have it
        // (more reliable matching) else TMDB.
        var qs = [];
        function add(k, v) {
            if (v == null || v === '') return;
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
        if (ik.imdb) add('id', ik.imdb);
        else if (ik.tmdb) add('id', ik.tmdb);
        else {
            // Title-only fallback. The proxy currently requires id, so
            // title-only items can't be searched. Return null to signal
            // "no search possible" — fetchForItem will resolve to [].
            return null;
        }
        if (ik.season != null && ik.episode != null) {
            add('season', ik.season);
            add('episode', ik.episode);
        }
        // Language scoping. An explicit ik.language (from the picker's language
        // input) takes priority and is the ONLY language fetched — this keeps the
        // Wyzie call to a single language instead of pulling every language and
        // filtering client-side. With no explicit language we fall back to the
        // user's saved preference, else fetch all and dedupe.
        var langToUse = null;
        if (ik.language && /^[a-z]{2}$/.test(ik.language)) {
            langToUse = ik.language;
        } else if (typeof Store !== 'undefined' && Store.getPreferredSubLang) {
            var pref = Store.getPreferredSubLang();
            if (pref && pref !== 'off' && pref.length === 2 && /^[a-z]{2}$/.test(pref)) {
                langToUse = pref;
            }
        }
        if (langToUse) add('language', langToUse);
        return apiBase() + SEARCH_PATH + (qs.length ? ('?' + qs.join('&')) : '');
    }

    function xhrJson(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            try { xhr.open('GET', url, true); } catch (e) { reject(e); return; }
            xhr.timeout = REQ_TIMEOUT;
            xhr.ontimeout = function () { reject(new Error('subs:timeout')); };
            xhr.onerror = function () { reject(new Error('subs:network')); };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText || '[]')); }
                    catch (parseErr) { reject(new Error('subs:badjson')); }
                } else {
                    reject(new Error('subs:http' + xhr.status));
                }
            };
            try { xhr.send(); } catch (sendErr) { reject(sendErr); }
        });
    }

    function xhrText(url) {
        // For subtitle file content. Some files are non-UTF8 (Windows-
        // 1252 for European languages was common a decade ago). XHR
        // gives us responseText decoded as UTF-8 by default which may
        // mangle those — but trying to detect encoding here would be
        // a rabbit hole. Accept that older files might render with
        // wrong accents and move on; users can pick a different source.
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            try { xhr.open('GET', url, true); } catch (e) { reject(e); return; }
            xhr.timeout = REQ_TIMEOUT;
            xhr.ontimeout = function () { reject(new Error('subs:timeout')); };
            xhr.onerror = function () { reject(new Error('subs:network')); };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText || '');
                } else {
                    reject(new Error('subs:http' + xhr.status));
                }
            };
            try { xhr.send(); } catch (sendErr) { reject(sendErr); }
        });
    }

    /* ---- Result normalisation ---- */

    function langName(code, display) {
        // Prefer the server-provided 'display' field
        // (Wyzie sends a human label like "English" or "Português (BR)").
        // Fall back to our local table, then the code itself uppercased.
        if (display) return String(display);
        if (!code) return 'Unknown';
        var lc = String(code).toLowerCase();
        return LANG_NAMES[lc] || String(code).toUpperCase();
    }

    function inferFormat(item) {
        // Wyzie returns a format field on each entry but it's not
        // always populated. Fall back to URL suffix detection.
        if (item.format) return String(item.format).toLowerCase();
        var u = String(item.url || '').toLowerCase();
        if (u.indexOf('.vtt') >= 0) return 'vtt';
        if (u.indexOf('.srt') >= 0) return 'srt';
        if (u.indexOf('.ass') >= 0 || u.indexOf('.ssa') >= 0) return 'ass';
        return 'srt'; // most likely default
    }

    var MAX_PER_LANG = 5;

    function normalise(raw, wantLang) {
        // Take Wyzie's raw array and return [{language, languageName, format,
        // url, source, variant}], keeping up to MAX_PER_LANG entries PER LANGUAGE
        // (was one) so the user can try alternates when a file is out of sync or
        // mistimed. Wyzie returns results roughly by relevance/downloads, so we
        // keep that order within each language. ASS/SSA dropped (can't map to
        // <track>). variant is the 1-based position within its language, used
        // by the picker to label alternates (e.g. "English", "English (2)").
        // Wyzie entry shape: { display, language, format, encoding, media, url,
        // source }; language is 2-letter, display is the human name.
        // wantLang (optional 2-letter): when we asked the backend for a specific
        // language, drop anything it returned in OTHER languages — a safety net,
        // since the upstream free key/sources don't always honour the filter and
        // the user explicitly chose one language.
        if (!raw || !raw.length) return [];
        var only = (wantLang && /^[a-z]{2}$/.test(wantLang)) ? wantLang : null;
        var perLangCount = {};      // lang -> how many kept so far
        var seenUrl = {};           // url -> true, to drop exact dupes
        var groups = {};            // lang -> [entry,...] preserving order
        var langOrder = [];         // first-seen order of languages
        for (var i = 0; i < raw.length; i++) {
            var item = raw[i];
            if (!item || !item.url) continue;
            var format = inferFormat(item);
            if (format === 'ass' || format === 'ssa') continue; // unsupported
            var lang = (item.language || item.lang || '').toLowerCase();
            if (!lang) continue;
            // Normalise common 3-letter codes Wyzie occasionally emits, then drop
            // anything outside the requested language.
            if (lang.length === 3) {
                var twoMap = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', ara: 'ar', rus: 'ru', dut: 'nl', nld: 'nl', tur: 'tr', pol: 'pl' };
                if (twoMap[lang]) lang = twoMap[lang];
            }
            if (only && lang !== only) continue;
            if (seenUrl[item.url]) continue;
            var n = perLangCount[lang] || 0;
            if (n >= MAX_PER_LANG) continue;
            seenUrl[item.url] = true;
            perLangCount[lang] = n + 1;
            if (!groups[lang]) { groups[lang] = []; langOrder.push(lang); }
            groups[lang].push({
                language: lang,
                languageName: langName(lang, item.display),
                format: format,
                url: item.url,
                source: item.source || item.provider || '',
                variant: n + 1
            });
        }
        // Sort languages: English first, then by language name.
        langOrder.sort(function (a, b) {
            if (a === 'en' && b !== 'en') return -1;
            if (b === 'en' && a !== 'en') return 1;
            var an = (groups[a][0].languageName), bn = (groups[b][0].languageName);
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        var out = [];
        for (var li = 0; li < langOrder.length; li++) {
            var g = groups[langOrder[li]];
            for (var gi = 0; gi < g.length; gi++) out.push(g[gi]);
        }
        return out;
    }

    /* ---- Format conversion ---- */

    // SRT -> WebVTT conversion. The differences are small:
    //  1. WebVTT files start with "WEBVTT" header.
    //  2. SRT uses commas in timestamps (00:00:01,500), WebVTT uses
    //     dots (00:00:01.500).
    //  3. SRT may have a numeric cue ID line before each cue; WebVTT
    //     allows it but it's optional. We keep them (browsers ignore
    //     unrecognised cue identifiers).
    //  4. SRT line endings may be CRLF; normalise to LF.
    //  5. Some SRT files have a BOM at the start; strip it.
    function srtToVtt(srtText) {
        if (!srtText) return 'WEBVTT\n\n';
        var s = String(srtText);
        // Strip UTF-8 BOM if present
        if (s.charCodeAt(0) === 0xFEFF) s = s.substring(1);
        // Normalise line endings
        s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // Convert timestamp commas to dots — only inside the
        // hh:mm:ss,mmm format, not inside dialogue text
        s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        return 'WEBVTT\n\n' + s;
    }

    function toVttText(text, format) {
        var vtt = (format === 'srt') ? srtToVtt(text) : text;
        // Guard: even if format said 'vtt', verify the file starts with
        // the WEBVTT header — some sources mislabel SRT as VTT. If the
        // header is missing AND we see SRT-style timestamps with commas,
        // run it through the converter.
        if (vtt.substring(0, 6) !== 'WEBVTT') {
            if (/\d{2}:\d{2}:\d{2},\d{3}/.test(vtt)) vtt = srtToVtt(vtt);
            else vtt = 'WEBVTT\n\n' + vtt;
        }
        return vtt;
    }
    function toVttBlobUrl(text, format) {
        var vtt = toVttText(text, format);
        var blob = new Blob([vtt], { type: 'text/vtt' });
        var url = URL.createObjectURL(blob);
        // Only the most-recently-loaded blob is ever attached to the player, so
        // revoke any previously-created ones now rather than letting them
        // accumulate across repeated subtitle selections in one session (the old
        // behaviour only cleaned up on player stop, so switching subtitles a few
        // times leaked a blob URL each time). clearActive() still revokes the
        // final one on stop.
        for (var i = 0; i < activeBlobUrls.length; i++) {
            try { URL.revokeObjectURL(activeBlobUrls[i]); } catch (e) {}
        }
        activeBlobUrls = [url];
        return url;
    }

    /* ---- Public API ---- */

    /* Return shape now {options:[], reason:string}
     * where reason is one of:
     *   - 'ok'         normal — options array populated
     *   - 'no-id'      item lacks tmdb/imdb id, no API call made
     *   - 'no-results' API returned but no subs found
     *   - 'error'      network or parse error
     *
     * Picker UI can use reason to show a more helpful message than
     * just "no subtitles found". Backwards compat: if a caller treats
     * the return as an array (legacy code), the .length property works
     * because we use Array semantics on the options array — but
     * callers SHOULD migrate to read result.options. */
    function fetchForItem(item, opts) {
        var ik = itemKey(item);
        if (!ik) {
            if (window.console && console.warn) {
                Log.warn('[subs] skipped: itemKey returned null. item fields:',
                    item ? Object.keys(item).join(',') : '(no item)');
            }
            return Promise.resolve({ options: [], reason: 'no-id' });
        }
        // Explicit language scopes the request (single-language Wyzie call) and
        // gets its own cache entry so different languages don't collide.
        var ikBaseKey = ik.key;
        if (opts && opts.language && /^[a-z]{2}$/.test(opts.language)) {
            ik.language = opts.language;
            ik.key = ik.key + '|lang=' + opts.language;
        }
        if (fetchCache[ik.key]) return fetchCache[ik.key];
        var url = buildSearchUrl(ik);
        if (!url) {
            if (window.console && console.warn) {
                Log.warn('[subs] skipped: no tmdb_id or imdb_id on item. ' +
                    'Wyzie requires an ID. item:', {
                        title: ik.title,
                        year: ik.year,
                        tmdb: ik.tmdb,
                        imdb: ik.imdb,
                        rawFields: item ? Object.keys(item).join(',') : ''
                    });
            }
            fetchCache[ik.key] = Promise.resolve({ options: [], reason: 'no-id' });
            return fetchCache[ik.key];
        }
        // Persistent cache: subtitle availability for a title is stable, so we
        // cache the (normalised) search RESULTS in localStorage keyed by item, with
        // a 7-day TTL. This survives app restarts and avoids re-hitting Wyzie for
        // titles the user revisits. We cache only the lightweight result list (URLs
        // + language/format), never the subtitle file contents. Empty/error results
        // are NOT persisted, so a transient failure doesn't get stuck for a week.
        var cached = persistentGet(ik.key);
        if (cached) {
            var hit = Promise.resolve({ options: cached, reason: cached.length ? 'ok' : 'no-results', resolvedKey: idKeyOf(ikBaseKey) });
            fetchCache[ik.key] = hit;
            return hit;
        }
        var promise = xhrJson(url)
            .then(function (raw) {
                var normalised = normalise(raw, ik.language);
                if (normalised.length) {
                    persistentSet(ik.key, normalised);
                    if (ik.language) indexLang(ikBaseKey, ik.language);
                }
                return {
                    options: normalised,
                    reason: normalised.length ? 'ok' : 'no-results',
                    resolvedKey: idKeyOf(ikBaseKey)
                };
            })
            ['catch'](function (err) {
                if (window.console && console.warn) {
                    Log.warn('[subs] fetch failed for', ik.key, err && err.message);
                }
                return { options: [], reason: 'error' };
            });
        fetchCache[ik.key] = promise;
        return promise;
    }

    // ---- Persistent search-results cache (localStorage, 7-day TTL) ----
    var PERSIST_PREFIX = 'subsCache2.'; // bumped: old entries may be unfiltered / all-language
    var PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    function persistentGet(key) {
        if (!window.Store || !Store.get) return null;
        try {
            var rec = Store.get(PERSIST_PREFIX + key, null);
            if (!rec || !rec.t || !rec.o) return null;
            if ((Date.now() - rec.t) > PERSIST_TTL_MS) return null; // stale
            return rec.o;
        } catch (e) { return null; }
    }

    function persistentSet(key, options) {
        if (!window.Store || !Store.set) return;
        try { Store.set(PERSIST_PREFIX + key, { t: Date.now(), o: options }); } catch (e) {}
    }

    // Per-title "last language searched", so reopening the picker for a title can
    // jump straight to that language's results instead of the chooser.
    var LASTLANG_PREFIX = 'subsLastLang.';
    var LANGIDX_PREFIX = 'subsLangs.';   // per-title index of cached languages
    var RESOLVED_PREFIX = 'subsResolved.'; // providerKey -> resolved-ID key

    // ---- Bulletproof single-record cache ----
    // Everything needed to restore the picker for an item is stored in ONE record
    // under the item's own key: the language, the options, and (if resolved) the
    // resolved ID key. One write, one read, same key — nothing to desync. This is
    // the primary persistence path; the older multi-key helpers remain for
    // backward-compatible reads.
    var ONE_PREFIX = 'subsOne.';
    function saveOne(item, lang, options, resolvedKey, loadedUrl, offsetMs) {
        if (!window.Store || !Store.set) { return; }
        var ik = itemKey(item);
        if (!ik || !options || !options.length) { return; }
        // Preserve an existing saved offset if this caller didn't supply one.
        var prevOffset = 0;
        if (offsetMs == null) {
            try { var pv = Store.get(ONE_PREFIX + ik.key, null); if (pv && typeof pv.off === 'number') prevOffset = pv.off; } catch (ep) {}
        }
        var rec = { t: Date.now(), lang: lang || null, o: options, rk: resolvedKey || null, lu: loadedUrl || null, off: (offsetMs == null ? prevOffset : offsetMs) };
        try { Store.set(ONE_PREFIX + ik.key, rec); } catch (e) {}
        if (resolvedKey) {
            try { Store.set(ONE_PREFIX + resolvedKey, rec); } catch (e2) {}
            // Bridge this provider's item key to the stable resolved key, so a
            // later loadOne for this item can find the shared record even though
            // the item key alone missed.
            try { Store.set(RESOLVED_PREFIX + ik.key, resolvedKey); } catch (e2b) {}
        }
        // Verify the write actually persisted (read it straight back).
        var ok = false;
        try { var v = Store.get(ONE_PREFIX + ik.key, null); ok = !!(v && v.o && v.o.length); } catch (e3) {}
        Log.log('[subs] saveOne key=' + ONE_PREFIX + ik.key + ' rk=' + resolvedKey + ' lang=' + lang + ' n=' + options.length + ' off=' + rec.off + ' readback=' + ok);
    }
    function loadOne(item) {
        if (!window.Store || !Store.get) return null;
        var ik = itemKey(item);
        if (!ik) return null;
        var rec = null;
        try { rec = Store.get(ONE_PREFIX + ik.key, null); } catch (e) {}
        // Fall back to the resolved-ID record (e.g. same film on another playlist
        // we've resolved before, mapped via subsResolved).
        if (!rec) {
            var rk = null;
            if (ik.tmdb) rk = 'tmdb:' + ik.tmdb;
            else if (ik.imdb) rk = 'imdb:' + ik.imdb;
            else { try { rk = Store.get(RESOLVED_PREFIX + ik.key, null); } catch (e2) {} }
            if (rk) { try { rec = Store.get(ONE_PREFIX + rk, null); } catch (e3) {} }
        }
        if (!rec || !rec.o || !rec.o.length) {
            Log.log('[subs] loadOne MISS key=' + ONE_PREFIX + ik.key);
            return null;
        }
        if ((Date.now() - (rec.t || 0)) > PERSIST_TTL_MS) return null;
        Log.log('[subs] loadOne HIT key=' + ONE_PREFIX + ik.key + ' lang=' + rec.lang + ' n=' + rec.o.length);
        return { lang: rec.lang, options: rec.o, resolvedKey: rec.rk, loadedUrl: rec.lu || null, offsetMs: (typeof rec.off === "number" ? rec.off : 0) };
    }


    // Remember that a provider item (its provider-title key) resolves to a stable
    // ID key, so reopening THAT provider item can find the shared cache without
    // re-resolving. (A different playlist's version has a different provider key;
    // once it resolves once, it maps to the same ID and shares the cache.)
    function idKeyOf(key) {
        // Only an ID-based key (tmdb:/imdb:, optionally with |sNeN) is stable across
        // providers. A title-based key must NOT be used for cross-provider reuse.
        if (!key) return null;
        if (key.indexOf('tmdb:') === 0 || key.indexOf('imdb:') === 0) return key;
        return null;
    }

    function loadByResolvedKey(resolvedKey) {
        if (!window.Store || !Store.get || !resolvedKey) return null;
        var rec = null;
        try { rec = Store.get(ONE_PREFIX + resolvedKey, null); } catch (e) {}
        if (!rec || !rec.o || !rec.o.length) return null;
        if ((Date.now() - (rec.t || 0)) > PERSIST_TTL_MS) return null;
        Log.log('[subs] loadByResolvedKey HIT key=' + ONE_PREFIX + resolvedKey + ' n=' + rec.o.length);
        return { lang: rec.lang, options: rec.o, resolvedKey: resolvedKey, loadedUrl: rec.lu || null, offsetMs: (typeof rec.off === 'number' ? rec.off : 0) };
    }

    function setResolvedKey(item, resolvedKey) {
        if (!window.Store || !Store.set || !resolvedKey) return;
        var ik = itemKey(item);
        if (!ik) return;
        // Only worth storing when the provider item had no ID of its own.
        if (ik.tmdb || ik.imdb) return;
        try { Store.set(RESOLVED_PREFIX + ik.key, resolvedKey); } catch (e) {}
    }
    function getResolvedKey(item) {
        var ik = itemKey(item);
        if (!ik) return null;
        if (ik.tmdb) return 'tmdb:' + ik.tmdb;     // already has an ID
        if (ik.imdb) return 'imdb:' + ik.imdb;
        if (!window.Store || !Store.get) return null;
        try { return Store.get(RESOLVED_PREFIX + ik.key, null) || null; } catch (e) { return null; }
    }

    // Cache results under an EXPLICIT base key (e.g. a resolved 'tmdb:123') plus a
    // language, and index the language under that same base key.
    function cacheResultsByKey(baseKey, lang, options) {
        if (!baseKey || !options || !options.length) return;
        var key = baseKey;
        if (lang && /^[a-z]{2}$/.test(lang)) { key = key + '|lang=' + lang; indexLang(baseKey, lang); }
        persistentSet(key, options);
    }

    // Find any cached language for an EXPLICIT base key (used with a resolved ID).
    function findAnyCachedByKey(baseKey) {
        if (!baseKey) return null;
        var tryLangs = [];
        var indexed = getIndexedLangs(baseKey);
        for (var a = 0; a < indexed.length; a++) if (tryLangs.indexOf(indexed[a]) === -1) tryLangs.push(indexed[a]);
        var common = ['en','es','fr','de','it','pt','ar','ru','nl','tr','pl'];
        for (var b = 0; b < common.length; b++) if (tryLangs.indexOf(common[b]) === -1) tryLangs.push(common[b]);
        for (var i = 0; i < tryLangs.length; i++) {
            var got = persistentGet(baseKey + '|lang=' + tryLangs[i]);
            if (got && got.length) return { lang: tryLangs[i], options: got };
        }
        return null;
    }


    // Record that <lang> has cached results for <baseKey> (the item key WITHOUT the
    // |lang= suffix). Keeps a small de-duplicated, most-recent-first list so reopen
    // can find every language cached for a title — including custom ones typed via
    // "Type code" that aren't in the common list.
    function indexLang(baseKey, lang) {
        if (!window.Store || !Store.set || !lang || !/^[a-z]{2}$/.test(lang)) return;
        var list = [];
        try { list = Store.get(LANGIDX_PREFIX + baseKey, []) || []; } catch (e) { list = []; }
        if (!(list instanceof Array)) list = [];
        // Move/insert lang to the front.
        var idx = -1;
        for (var i = 0; i < list.length; i++) { if (list[i] === lang) { idx = i; break; } }
        if (idx >= 0) list.splice(idx, 1);
        list.unshift(lang);
        if (list.length > 12) list = list.slice(0, 12);
        try { Store.set(LANGIDX_PREFIX + baseKey, list); } catch (e2) {}
    }
    function getIndexedLangs(baseKey) {
        if (!window.Store || !Store.get) return [];
        try {
            var list = Store.get(LANGIDX_PREFIX + baseKey, []) || [];
            return (list instanceof Array) ? list : [];
        } catch (e) { return []; }
    }

    function getLastLang(item) {
        if (!window.Store || !Store.get) return null;
        var ik = itemKey(item);
        if (!ik) return null;
        try {
            var v = Store.get(LASTLANG_PREFIX + ik.key, null);
            var out = (v && /^[a-z]{2}$/.test(v)) ? v : null;
            return out;
        } catch (e) { return null; }
    }
    function setLastLang(item, lang) {
        if (!window.Store || !Store.set) return;
        var ik = itemKey(item);
        if (!ik || !lang || !/^[a-z]{2}$/.test(lang)) {
            return;
        }
        try { Store.set(LASTLANG_PREFIX + ik.key, lang); } catch (e) {}
    }

    // Persist an explicit results array under an item+language (used by manual
    // search, whose resolved ID differs from the original no-ID item — caching
    // under the ORIGINAL item lets reopen restore the list).
    function cacheResults(item, lang, options) {
        var ik = itemKey(item);
        if (!ik || !options || !options.length) return;
        var key = ik.key;
        if (lang && /^[a-z]{2}$/.test(lang)) { key = key + '|lang=' + lang; indexLang(ik.key, lang); }
        persistentSet(key, options);
        // Atomically record this as the title's last language too, so reopen can
        // restore without depending on a separate setLastLang call succeeding.
        if (lang && /^[a-z]{2}$/.test(lang)) {
            try { Store.set(LASTLANG_PREFIX + ik.key, lang); } catch (e) {}
            // Immediate read-back to confirm the write actually persisted.
            var verify = null;
            try { verify = Store.get(LASTLANG_PREFIX + ik.key, null); } catch (e2) {}
        }
    }


    // WITHOUT triggering a network fetch. Returns the cached options array, or
    // null if nothing is cached / it's stale. Lets the picker show saved results
    // for the last language immediately on open.
    function findAnyCached(item) {
        var ik = itemKey(item);
        if (!ik) return null;
        // Languages to try: the per-title index first (covers custom codes typed
        // via "Type code"), then the common list as a fallback for any entries
        // cached before the index existed. De-duplicated, index order preserved.
        var tryLangs = [];
        var indexed = getIndexedLangs(ik.key);
        for (var a = 0; a < indexed.length; a++) if (tryLangs.indexOf(indexed[a]) === -1) tryLangs.push(indexed[a]);
        var common = ['en','es','fr','de','it','pt','ar','ru','nl','tr','pl'];
        for (var b = 0; b < common.length; b++) if (tryLangs.indexOf(common[b]) === -1) tryLangs.push(common[b]);
        for (var i = 0; i < tryLangs.length; i++) {
            var got = persistentGet(ik.key + '|lang=' + tryLangs[i]);
            if (got && got.length) {
                return { lang: tryLangs[i], options: got };
            }
        }
        return null;
    }

    function peekCache(item, lang) {
        var ik = itemKey(item);
        if (!ik) return null;
        var key = ik.key;
        if (lang && /^[a-z]{2}$/.test(lang)) key = key + '|lang=' + lang;
        var got = persistentGet(key);
        return got;
    }

    function loadTrack(option) {
        if (!option || !option.url) {
            return Promise.reject(new Error('subs:notrack'));
        }
        /* Route the actual file fetch through the
         * pairing-server proxy too. Two reasons:
         *   1. The TV app's origin is file:// or appid:// — most
         *      subtitle CDNs don't send CORS headers permissive enough
         *      for that, and the request would fail at the browser.
         *   2. We can normalise content-type and apply rate limits
         *      server-side. */
        var proxyUrl = apiBase() + FILE_PATH +
            '?url=' + encodeURIComponent(option.url);
        return xhrText(proxyUrl).then(function (text) {
            var vttText = toVttText(text, option.format);
            var blobUrl = toVttBlobUrl(text, option.format);
            return { blobUrl: blobUrl, vttText: vttText, format: 'vtt' };
        });
    }

    function clearActive() {
        for (var i = 0; i < activeBlobUrls.length; i++) {
            try { URL.revokeObjectURL(activeBlobUrls[i]); } catch (e) {}
        }
        activeBlobUrls = [];
    }

    /* ---- Manual search (user-entered terms, never provider metadata) ----
     * Provider titles are junk, so we never auto-resolve from them. The user
     * types a clean title (+ optional year; + season/episode for series) in the
     * picker; we resolve that to a TMDB id via the server, then run the normal
     * subtitle search against that id. */

    function resolveTitle(title, year, type) {
        title = (title || '').replace(/^\s+|\s+$/g, '');
        if (!title) return Promise.resolve({ ok: false, reason: 'no-title' });
        var t = (type === 'tv') ? 'tv' : 'movie';
        var qs = 'title=' + encodeURIComponent(title) + '&type=' + t;
        if (year) qs += '&year=' + encodeURIComponent(year);
        var url = apiBase() + RESOLVE_PATH + '?' + qs;
        return xhrJson(url).then(function (r) {
            if (r && (r.tmdb_id || r.imdb_id)) {
                return { ok: true, tmdb: r.tmdb_id || null, imdb: r.imdb_id || null,
                         matchedTitle: r.matched_title || title, year: r.year || year, type: t };
            }
            return { ok: false, reason: 'no-match' };
        })['catch'](function (err) {
            // 503 = TMDB not configured server-side; surface distinctly.
            var msg = (err && err.message) || '';
            return { ok: false, reason: msg.indexOf('503') >= 0 ? 'not-configured' : 'error' };
        });
    }

    /* searchManual(terms) -> Promise<{options, reason}>
     * terms: { title, year, type:'movie'|'tv', season, episode }
     * Resolves the title to an id, then searches subtitles for it. Does NOT use
     * the per-session cache (manual searches are intentional re-tries). */
    function searchManual(terms, language) {
        terms = terms || {};
        return resolveTitle(terms.title, terms.year, terms.type).then(function (res) {
            if (!res.ok) {
                var reason = res.reason === 'not-configured' ? 'not-configured'
                           : res.reason === 'no-title' ? 'no-title'
                           : 'no-match';
                return { options: [], reason: reason };
            }
            var ik = {
                imdb: res.imdb ? (String(res.imdb).indexOf('tt') === 0 ? String(res.imdb) : 'tt' + res.imdb) : null,
                tmdb: res.tmdb,
                season: (terms.type === 'tv' && terms.season != null && terms.season !== '') ? terms.season : null,
                episode: (terms.type === 'tv' && terms.episode != null && terms.episode !== '') ? terms.episode : null
            };
            if (language && /^[a-z]{2}$/.test(language)) ik.language = language;
            var url = buildSearchUrl(ik);
            if (!url) return { options: [], reason: 'no-id' };
            // Build the resolved-ID key (stable across providers) so caching uses
            // the ID, never the provider's arbitrary title. IMDB is preferred (more
            // stable / what providers expose), then TMDB.
            var resolvedKey = ik.imdb ? ('imdb:' + ik.imdb) : (ik.tmdb ? ('tmdb:' + ik.tmdb) : null);
            if (resolvedKey && ik.season != null && ik.episode != null) {
                resolvedKey = resolvedKey + '|s' + ik.season + 'e' + ik.episode;
            }
            // Cross-provider reuse: if this film was already fetched (on this or any
            // other provider), reuse the cached list instead of another Wyzie call.
            // Check BOTH id forms — one provider may have cached under tmdb and
            // another resolve via imdb (resolveTitle returns both when available).
            var seSuffix = (ik.season != null && ik.episode != null) ? ('|s' + ik.season + 'e' + ik.episode) : '';
            var candKeys = [];
            if (ik.imdb) candKeys.push('imdb:' + ik.imdb + seSuffix);
            if (ik.tmdb) candKeys.push('tmdb:' + ik.tmdb + seSuffix);
            for (var ci = 0; ci < candKeys.length; ci++) {
                var hit = loadByResolvedKey(candKeys[ci]);
                if (hit && hit.options && hit.options.length) {
                    var reuse = hit.options;
                    if (ik.language) {
                        var scoped = [];
                        for (var ri = 0; ri < reuse.length; ri++) {
                            if (reuse[ri] && reuse[ri].language === ik.language) scoped.push(reuse[ri]);
                        }
                        // Cache holds nothing in the requested language — don't reuse
                        // the other-language entries; fetch fresh for this language.
                        if (!scoped.length) continue;
                        reuse = scoped;
                    }
                    Log.log('[subs] searchManual REUSE id=' + candKeys[ci] + ' n=' + reuse.length + ' (no Wyzie call)');
                    return {
                        options: reuse,
                        reason: 'ok',
                        resolvedKey: resolvedKey,
                        resolvedTmdb: ik.tmdb || null,
                        resolvedImdb: ik.imdb || null,
                        reused: true
                    };
                }
            }
            return xhrJson(url).then(function (raw) {
                var normalised = normalise(raw, ik.language);
                return {
                    options: normalised,
                    reason: normalised.length ? 'ok' : 'no-results',
                    resolvedKey: resolvedKey,
                    resolvedTmdb: ik.tmdb || null,
                    resolvedImdb: ik.imdb || null
                };
            })['catch'](function () {
                return { options: [], reason: 'error' };
            });
        });
    }

    return {
        fetchForItem: fetchForItem,
        loadTrack: loadTrack,
        clearActive: clearActive,
        resolveTitle: resolveTitle,
        searchManual: searchManual,
        getLastLang: getLastLang,
        setLastLang: setLastLang,
        cacheResults: cacheResults,
        peekCache: peekCache,
        findAnyCached: findAnyCached,
        findAnyCachedByKey: findAnyCachedByKey,
        cacheResultsByKey: cacheResultsByKey,
        setResolvedKey: setResolvedKey,
        getResolvedKey: getResolvedKey,
        saveOne: saveOne,
        loadOne: loadOne,
        langName: langName,
        // Exposed for testing / debugging
        _itemKey: itemKey,
        _srtToVtt: srtToVtt
    };
})();
