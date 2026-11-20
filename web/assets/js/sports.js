/* sports.js - Sports page: 7-day schedule/scores from the pairing server,
 * sport + team filter, and EPG matching ("is this on one of my channels?").
 *
 * ES5 only. Data comes from APP_CONFIG.PAIR_SERVER + /api/sports/events (the
 * server owns the provider and its key; see pairing-server sports-routes.js).
 *
 * D-pad: Sports.nav(cur, dir) is called from app.js handleArrow for the sports
 * section and returns true if it moved focus. Layout is three zones, walked
 * explicitly (no geometry guessing):  header buttons  ->  day tabs  ->  rows.
 * Left from the first item of a zone returns false so app.js sends focus to
 * the side menu. Touch: every control is also a plain click target.
 */
var Sports = (function () {
    'use strict';

    var PREF_KEY = 'sports_prefs';
    var DAYS = 7;
    var STALE_MS = 5 * 60 * 1000;
    var MAX_ROWS = 150;
    /* A cold server fills its cache one paced upstream call at a time, which can take minutes, so
     * the app keeps re-asking while the server says sports are pending: quickly at first, then
     * every 15 s, and gives up after ~10 minutes (Refresh starts it again). Re-asks that bring
     * nothing new change nothing on screen (see render()). */
    var MAX_RETRIES = 45;
    var cfg = { retryScale: 1 };
    function retryDelay(n) { return Math.round((n < 3 ? 4000 : n < 8 ? 8000 : 15000) * cfg.retryScale); }
    var MATCH_DAYS = 2;            // EPG matching for today and tomorrow only
    var LEAGUE_MAX = 40;           // most-active leagues listed per sport in the filter
    var MAX_CANDIDATES = 600;      // sports-looking channels scanned
    var SPORTS_CH_RE = /sport|espn|bein|dazn|eurosport|sky\s?sp|bt\s?sp|\btnt\b|nbc\s?sp|cbs\s?sp|fox\s?sp|supersport|kayo|foxtel|optus|\btsn\b|sportsnet|setanta|premier|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|\bufc\b|\bwwe\b|\bf1\b|formula|golf|tennis|cricket|rugby|racing|football|soccer|fight|boxing|arena|\bmatch\b|laliga|bundesliga|serie\s?a|ligue|mls|afl|nrl|motogp|nascar/i;

    var state = {
        loaded: false, loading: false, error: '', partial: false, updatedAt: 0,
        pending: null, failed: [],  // sports the server has not fetched yet / could not fetch
        retries: 0, retryTimer: 0, sig: '', when: 'upcoming', idleTimer: 0, busySince: 0,
        events: [], sportsList: [], day: 0, prefs: null,
        matches: {},               // eventId -> [{ch, prog, score}]
        matchedFor: '',            // signature of what matches were computed for
        scanTimers: [], reqSeq: 0
    };

    function T2(key, fallback) {
        try { var v = T(key); if (v && v !== key) return v; } catch (e) {}
        return fallback;
    }
    function $id(id) { return document.getElementById(id); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function mk(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    /* ---------- prefs ---------- */
    function loadPrefs() {
        var p = null;
        try { p = Store.raw.get(PREF_KEY, null); } catch (e) {}
        if (!p || typeof p !== 'object') p = {};
        if (!(p.sports instanceof Array)) p.sports = [];
        if (!(p.teams instanceof Array)) p.teams = [];
        if (!(p.leagues instanceof Array)) p.leagues = [];     // 'sport|League name', applies per sport
        if (p.mode !== 'all' && p.mode !== 'mine') p.mode = (p.sports.length || p.teams.length || p.leagues.length) ? 'mine' : 'all';
        return p;
    }
    function savePrefs() { try { Store.raw.set(PREF_KEY, state.prefs); } catch (e) {} }
    /* Last good feed, kept on this device so the page can show it at once on the next visit and refresh behind it
     * (the server can take several seconds to answer when its own cache is filling). Plain localStorage, not the
     * synced store: it is bulky, per device and disposable. Only complete (non-partial) feeds are kept. */
    var FEED_KEY = 'xtivio.sports_feed_cache', FEED_MAX_AGE_MS = 6 * 3600000, FEED_MAX_CHARS = 700000;
    function saveFeedCache(data) {
        try {
            var txt = JSON.stringify({ at: Date.now(), sports: data.sports || [], events: data.events });
            if (txt.length <= FEED_MAX_CHARS) localStorage.setItem(FEED_KEY, txt);
        } catch (e) {}
    }
    function loadFeedCache() {
        try {
            var raw = localStorage.getItem(FEED_KEY); if (!raw) return false;
            var c = JSON.parse(raw);
            if (!c || !(c.events instanceof Array) || !c.at || (Date.now() - c.at) > FEED_MAX_AGE_MS || c.at > Date.now() + 60000) return false;
            state.events = c.events; state.sportsList = c.sports || state.sportsList;
            state.loaded = true; state.partial = false; state.pending = []; state.failed = [];
            state.updatedAt = c.at;      // older than STALE_MS: load() still asks the server for fresh data
            return true;
        } catch (e) { return false; }
    }
    function hasFilter() { return !!(state.prefs.sports.length || state.prefs.teams.length || (state.prefs.leagues && state.prefs.leagues.length)); }

    /* ---------- time helpers ---------- */
    function dayStart(offset) {
        var d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 0, 0, 0, 0);
    }
    function fmtTime(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    function dayLabel(offset) {
        if (offset === 0) return T2('sp_today', 'Today');
        var d = dayStart(offset), s = '';
        try { s = d.toLocaleDateString(I18n.getLanguage(), { weekday: 'short' }); } catch (e) {}
        if (!s) s = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
        return s + ' ' + d.getDate();
    }
    function sportLabel(key) {
        var fb = key;
        for (var i = 0; i < state.sportsList.length; i++) if (state.sportsList[i].key === key) fb = state.sportsList[i].label;
        return T2('sp_s_' + key.replace(/-/g, '_'), fb);
    }

    /* ---------- fetch ---------- */
    function feedUrl() {
        var from = dayStart(0).getTime(), to = dayStart(DAYS).getTime();
        var base = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '');
        return base + '/api/sports/events?from=' + encodeURIComponent(new Date(from).toISOString()) +
            '&to=' + encodeURIComponent(new Date(to).toISOString());
    }
    function fetchJson(url, cb) {
        var xhr = new XMLHttpRequest();
        var done = false;
        xhr.open('GET', url, true);
        xhr.timeout = 15000;
        function fin(err, data) { if (done) return; done = true; cb(err, data); }
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { fin(null, JSON.parse(xhr.responseText)); } catch (e) { fin('bad'); }
            } else fin('http' + xhr.status);
        };
        xhr.onerror = function () { fin('net'); };
        xhr.ontimeout = function () { fin('timeout'); };
        try { xhr.send(); } catch (e) { fin('net'); }
    }
    /* The playlist loads live -> EPG -> movies -> series one after another to keep the UI
     * responsive. Sports still waits for that to finish (feed request and EPG matching both: older TVs and low-memory boxes
     * stay responsive), but it is TOLD the moment indexing ends (indexingDone, called by app.js) instead of
     * finding out on a 2.5 s timer; the 1 s timer below is only a safety net. */
    var BUSY_CAP_MS = 90000;       // never wait longer than this, whatever the indexer reports
    function playlistBusy() {
        var busy = false;
        try { busy = !!(window.App && App.isCatalogIndexing && App.isCatalogIndexing()); } catch (e) {}
        if (!busy) { state.busySince = 0; return false; }
        if (!state.busySince) state.busySince = Date.now();
        return (Date.now() - state.busySince) < BUSY_CAP_MS;
    }
    function waitForPlaylist() {
        if (state.idleTimer) return;
        state.idleTimer = setTimeout(function () {
            state.idleTimer = 0;
            if (!isActive()) return;
            if (playlistBusy()) { waitForPlaylist(); return; }
            state.sig = ''; state.matchedFor = '';
            load(false); render();
        }, 1000);
    }
    /* App calls this the moment the catalog indexer finishes: start whatever Sports was waiting for, now. */
    function indexingDone() {
        if (!state.idleTimer) return;                      // Sports was not waiting
        clearTimeout(state.idleTimer); state.idleTimer = 0;
        if (!isActive()) return;
        if (playlistBusy()) { waitForPlaylist(); return; }
        state.sig = ''; state.matchedFor = '';
        load(false); render();
    }
    function load(force) {
        if (state.loading) return;
        if (playlistBusy()) { waitForPlaylist(); render(); return; }
        if (!force && state.loaded && !state.partial && (Date.now() - state.updatedAt) < STALE_MS) { render(); return; }
        if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = 0; }
        state.loading = true; state.error = '';
        var seq = ++state.reqSeq;
        render();
        fetchJson(feedUrl(), function (err, data) {
            if (seq !== state.reqSeq) return;
            state.loading = false;
            if (err || !data || !(data.events instanceof Array)) {
                state.error = err || 'bad';
            } else {
                state.events = data.events; state.sportsList = data.sports || state.sportsList;
                state.partial = !!data.partial; state.loaded = true; state.updatedAt = Date.now();
                // Older servers send no pending[]: treat a partial answer as "everything pending".
                state.pending = (data.pending instanceof Array) ? data.pending : (state.partial ? null : []);
                state.failed = (data.failed instanceof Array) ? data.failed : [];
                state.matches = {}; state.matchedFor = '';
                if (!state.partial) saveFeedCache(data);
                // First request after a server cold start can be partial: ask again a few times,
                // not forever (a sport the provider cannot serve must not keep us asking).
                if (state.partial && state.retries < MAX_RETRIES) {
                    state.retries++;
                    state.retryTimer = setTimeout(function () { state.retryTimer = 0; if (isActive()) load(true); }, retryDelay(state.retries));
                } else if (state.partial) { state.partial = false; }
            }
            render();
        });
    }

    /* ---------- filtering ---------- */
    function norm(s) {
        s = String(s || '').toLowerCase();
        try { s = s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s; } catch (e) {}
        return s.replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }
    function teamHit(ev, team) {
        var t = norm(team);
        if (!t) return false;
        return norm(ev.home + ' ' + ev.away + ' ' + ev.title).indexOf(t) >= 0;
    }
    function passes(ev) {
        if (state.prefs.mode !== 'mine') return true;
        var p = state.prefs, i;
        if (p.sports.length) {
            var ok = false;
            for (i = 0; i < p.sports.length; i++) if (p.sports[i] === ev.sport) { ok = true; break; }
            if (!ok) return false;
        }
        // Leagues are chosen per sport: a sport with leagues ticked shows only those; other sports are untouched.
        if (p.leagues && p.leagues.length) {
            var pre = ev.sport + '|', any = false, hit = false;
            for (i = 0; i < p.leagues.length; i++) {
                if (p.leagues[i].indexOf(pre) === 0) { any = true; if (p.leagues[i] === pre + (ev.league || '')) { hit = true; break; } }
            }
            if (any && !hit) return false;
        }
        if (p.teams.length) {
            for (i = 0; i < p.teams.length; i++) if (teamHit(ev, p.teams[i])) return true;
            return false;
        }
        return true;
    }
    function isPast(ev) {
        if (ev.status === 'final') return true;
        if (ev.status === 'live' || ev.status === 'postponed' || ev.allDay) return false;
        var t = Date.parse(ev.start), te = ev.end ? Date.parse(ev.end) : NaN;
        return (te > t ? te : t + 3 * 3600000) < Date.now();      // over, even if the feed has not marked it final yet
    }
    function eventsForDay(offset) {
        var a = dayStart(offset).getTime(), b = dayStart(offset + 1).getTime(), out = [];
        for (var i = 0; i < state.events.length; i++) {
            var ev = state.events[i], t = Date.parse(ev.start), te = ev.end ? Date.parse(ev.end) : NaN;
            // A multi-day event (golf week, tennis tournament) shows on every day it spans.
            var on = (te > t) ? (t < b && te > a) : (t >= a && t < b);
            if (on && passes(ev) && (offset !== 0 || (state.when === 'past') === isPast(ev))) out.push(ev);
        }
        return out;
    }

    /* ---------- EPG matching ---------- */
    /* Live channels are tagged by SOURCE (parser.js: 'xtream' / 'm3u'; Stalker live is 'stalker'),
     * only rig fixtures say 'live'. Anything that is not VOD/series counts as live. */
    function isLiveCh(ch) {
        var t = ch && ch.type;
        if (!t) return true;
        if (t === 'movies' || t === 'movie' || t === 'series' || t === 'vod') return false;
        if (t === 'stalker') return ch.stalkerKind !== 'vod' && ch.stalkerKind !== 'series';
        return true;
    }
    /* Xtream/M3U hold the whole playlist in UI.getChannels(); a Stalker playlist only holds the
     * genre last opened there, so also read every genre opened so far (no extra portal calls). */
    function allChannels() {
        var all = [], st = [];
        try { all = UI.getChannels() || []; } catch (e) {}
        try { if (UI.getStalkerChannels) st = UI.getStalkerChannels() || []; } catch (e) {}
        return st.length ? st : all;
    }
    var candCache = { src: null, n: -1, list: [] };
    function candidateChannels() {
        var all = allChannels();
        // The scan runs a long regular expression over every channel (tens of thousands), so keep
        // the answer for as long as the channel list is the same one.
        if (candCache.src === all && candCache.n === all.length) return candCache.list;
        var out = [];
        for (var i = 0; i < all.length && out.length < MAX_CANDIDATES; i++) {
            var ch = all[i];
            if (!isLiveCh(ch)) continue;
            if (!(ch.tvgId || ch.epgId || ch.xmltvId)) continue;
            if (SPORTS_CH_RE.test((ch.name || '') + ' ' + (ch.category || ''))) out.push(ch);
        }
        candCache = { src: all, n: all.length, list: out };
        return out;
    }
    /* Event channels: some providers publish one channel per game ("NBA 03: Lakers vs Celtics"),
     * with no EPG at all. Those are matched on the channel NAME. Only names that look like a
     * fixture (vs / v / @ / -) are kept, and the normalised names are cached per channel list. */
    var evCache = { src: null, n: -1, list: [] };
    function eventChannels() {
        var all = allChannels();
        if (evCache.src === all && evCache.n === all.length) return evCache.list;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var ch = all[i], nm = ch.name || '';
            if (!isLiveCh(ch)) continue;
            if (/\s(vs\.?|v|@|x)\s|\s-\s/i.test(nm) && /[a-z]{3}/i.test(nm)) out.push({ ch: ch, text: norm(nm) });
        }
        evCache = { src: all, n: all.length, list: out };
        return out;
    }
    function nameMatches(ev, evch) {
        var out = [];
        if (!(ev.home && ev.away)) return out;
        for (var i = 0; i < evch.length && out.length < 4; i++) {
            if (nameIn(evch[i].text, ev.home) && nameIn(evch[i].text, ev.away)) out.push({ ch: evch[i].ch, prog: null, score: 2, byName: true });
        }
        return out;
    }
    function sigToks(name) {
        var t = norm(name).split(' '), out = [];
        for (var i = 0; i < t.length; i++) {
            if (t[i].length >= 3 && !/^(fc|afc|cf|sc|the|and|vs|club|city2)$/.test(t[i])) out.push(t[i]);
        }
        return out;
    }
    function nameIn(text, name) {
        var n = norm(name);
        if (!n) return false;
        if (text.indexOf(n) >= 0) return true;
        var toks = sigToks(name);                       // "Manchester United" ~ "Man United" via last token
        if (toks.length >= 2 && text.indexOf(toks[toks.length - 1]) >= 0 && text.indexOf(toks[0].slice(0, 3)) >= 0) return true;
        // "Los Angeles Lakers" ~ "Lakers": a distinctive last word is enough ("United"/"City" are not).
        var last = toks[toks.length - 1];
        if (toks.length >= 2 && last && last.length >= 5 && !/^(united|city|town|rovers|wanderers|athletic|county|albion|hotspur|rangers|county|stars|kings)$/.test(last) &&
            (' ' + text + ' ').indexOf(' ' + last + ' ') >= 0) return true;
        return false;
    }
    function progScore(ev, text) {
        var s = 0;
        if (ev.home && ev.away) {
            if (nameIn(text, ev.home)) s++;
            if (nameIn(text, ev.away)) s++;
            if (s === 1 && nameIn(text, ev.league)) s = 2;   // "Premier League: Arsenal" on a one-team title
            return s;
        }
        var t = norm(ev.title);
        if (t && text.indexOf(t) >= 0) return 2;
        var lg = norm(ev.league);
        if (lg && text.indexOf(lg) >= 0) return 1;
        return 0;
    }
    /* Programmes of one candidate channel for the viewed day, fetched once per matching run (not
     * once per event) with their titles already normalised. */
    function dayProgs(ch, run) {
        var key = (ch.playlistId || '') + '|' + (ch.tvgId || ch.epgId || '') + '|' + (ch.xmltvId || '');
        var hit = run.cache[key];
        if (hit) return hit;
        var pid = ch.playlistId || Store.getActivePlaylistId(), progs = [];
        try {
            progs = Epg.getProgrammesBetween(pid, ch.tvgId || ch.epgId, run.a, run.b) || [];
            if (!progs.length && ch.xmltvId) progs = Epg.getProgrammesBetween(pid, ch.xmltvId, run.a, run.b) || [];
        } catch (e) { progs = []; }
        var nt = [];
        for (var k = 0; k < progs.length; k++) nt.push(norm(progs[k].title));
        hit = run.cache[key] = { progs: progs, nt: nt };
        return hit;
    }
    function matchOne(ev, cands, run) {
        var st = Date.parse(ev.start), found = [];
        var dA = dayStart(state.day).getTime(), dB = dayStart(state.day + 1).getTime();
        var te = ev.end ? Date.parse(ev.end) : NaN;
        var a = ev.allDay ? st : st - 20 * 60000;
        var b = ev.allDay ? st + 86400000 : st + 30 * 60000;
        if (te > st) { a = Math.max(st, dA); b = Math.min(te, dB); }   // multi-day: whatever airs on the viewed day
        for (var i = 0; i < cands.length; i++) {
            var dp = dayProgs(cands[i], run);
            for (var k = 0; k < dp.progs.length; k++) {
                var pr = dp.progs[k];
                if (!(pr.stop > a && pr.start < b)) continue;
                var sc = progScore(ev, dp.nt[k]);
                if (sc >= 2 || (sc === 1 && !ev.home && !ev.allDay)) { found.push({ ch: cands[i], prog: pr, score: sc }); break; }
            }
            if (found.length >= 6) break;
        }
        return found;
    }
    var matchToken = 0;
    function computeMatches() {
        if (playlistBusy()) { waitForPlaylist(); return; }
        var cands = candidateChannels(), evch = eventChannels();
        if (!cands.length && !evch.length) return;
        var sig = state.day + ':' + state.updatedAt + ':' + cands.length + ':' + state.prefs.mode;
        var evs = eventsForDay(state.day);
        var dA = dayStart(state.day).getTime(), dB = dayStart(state.day + 1).getTime();
        // One programme fetch per channel for the whole day, shared by every event.
        var run = { cache: {}, a: dA - 3600000, b: dB + 3600000 };
        var token = ++matchToken, i = 0, SLICE_MS = 30;
        // Work through the events in slices of about 30 ms so a TV with a slow processor keeps scrolling and
        // answering the remote while the matching runs (it used to freeze for several seconds).
        function step() {
            if (token !== matchToken) return;                  // a newer run replaced this one
            var t0 = Date.now();
            for (; i < evs.length && (i === 0 || Date.now() - t0 < SLICE_MS); i++) {
                if (evs[i].status === 'final') continue;
                var m = matchOne(evs[i], cands, run), byName = nameMatches(evs[i], evch);
                for (var q = 0; q < byName.length && m.length < 6; q++) {
                    var dupe = false;
                    for (var w = 0; w < m.length; w++) if (m[w].ch === byName[q].ch) dupe = true;
                    if (!dupe) m.push(byName[q]);
                }
                if (m.length) state.matches[evs[i].id] = m; else delete state.matches[evs[i].id];
            }
            if (i < evs.length) { setTimeout(step, 0); return; }
            state.matchedFor = sig;
            if (isActive()) updateBadges();
        }
        step();
    }
    function scheduleMatching() {
        var t;
        while ((t = state.scanTimers.pop())) clearTimeout(t);
        if (state.day >= MATCH_DAYS || !window.Epg || !Epg.prefetchChannels) return;
        if (playlistBusy()) { waitForPlaylist(); return; }
        var cands = candidateChannels();
        if (!cands.length) return;
        var byPl = {}, i;
        for (i = 0; i < cands.length; i++) {
            var pid = cands[i].playlistId || Store.getActivePlaylistId();
            (byPl[pid] = byPl[pid] || []).push(cands[i].tvgId || cands[i].epgId);
        }
        for (var p in byPl) if (byPl.hasOwnProperty(p)) { try { Epg.prefetchChannels(p, byPl[p]); } catch (e) {} }
        // EPG lists load asynchronously from IndexedDB: recompute as they land.
        var delays = [250, 1200, 3500];
        for (i = 0; i < delays.length; i++) {
            state.scanTimers.push(setTimeout(function () {
                if (!isActive()) return;
                computeMatches(); updateBadges();
            }, delays[i]));
        }
    }

    /* ---------- render ---------- */
    function isActive() {
        var s = document.querySelector('.content-section.active');
        return !!(s && s.getAttribute('data-section-content') === 'sports');
    }
    function renderHeader() {
        var mode = $id('spMode'), filter = $id('spFilter');
        if (mode) {
            mode.textContent = state.prefs.mode === 'mine' ? T2('sp_mode_mine', 'My filter') : T2('sp_mode_all', 'All events');
            mode.style.display = hasFilter() ? '' : 'none';
        }
        if (filter) {
            var n = state.prefs.sports.length + state.prefs.teams.length + state.prefs.leagues.length;
            filter.textContent = T2('sp_filter', 'Filter') + (n ? ' (' + n + ')' : '');
        }
    }
    function renderDays() {
        var host = $id('spDays');
        if (!host) return;
        host.innerHTML = '';
        for (var i = 0; i < DAYS; i++) {
            (function (off) {
                var b = mk('button', 'btn focusable' + (off === state.day ? ' active' : ''), dayLabel(off));
                b.setAttribute('tabindex', '-1');
                b.setAttribute('data-focus-key', 'sp-day-' + off);
                b.setAttribute('data-sp-day', String(off));
                b.addEventListener('click', function () { selectDay(off, true); });
                host.appendChild(b);
            })(i);
        }
    }
    function renderWhen() {
        var host = $id('spWhen');
        if (!host) return;
        host.innerHTML = '';
        host.style.display = state.day === 0 ? '' : 'none';
        var opts = [['upcoming', T2('sp_upcoming', 'Upcoming')], ['past', T2('sp_past', 'Past')]];
        for (var i = 0; i < opts.length; i++) {
            (function (o) {
                var b = mk('button', 'btn focusable' + (state.when === o[0] ? ' active' : ''), o[1]);
                b.setAttribute('tabindex', '-1');
                b.setAttribute('data-focus-key', 'sp-when-' + o[0]);
                b.setAttribute('data-sp-when', o[0]);
                b.addEventListener('click', function () {
                    if (state.when === o[0]) return;
                    state.when = o[0];
                    renderWhen(); render();
                    var again = document.querySelector('#spWhen [data-sp-when="' + o[0] + '"]');
                    if (again && window.Focus) Focus.focus(again);
                });
                host.appendChild(b);
            })(opts[i]);
        }
    }
    function statusBadge(ev) {
        if (ev.status === 'live') return mk('span', 'sp-badge sp-live', T2('sp_live', 'LIVE'));
        if (ev.status === 'final') return mk('span', 'sp-badge sp-final', T2('sp_final', 'FT'));
        if (ev.status === 'postponed') return mk('span', 'sp-badge sp-pp', T2('sp_postponed', 'Postponed'));
        return null;
    }
    function buildRow(ev, idx) {
        var row = mk('div', 'sp-row focusable');
        row.setAttribute('tabindex', '-1');
        row.setAttribute('data-focus-key', 'sp-ev-' + idx);
        row.setAttribute('data-sp-id', ev.id);
        var t0 = Date.parse(ev.start);
        var carried = !!(ev.end && Date.parse(ev.end) > t0 && t0 < dayStart(state.day).getTime());   // started on an earlier day
        var t = (ev.allDay || carried) ? T2('sp_all_day', 'All day') : fmtTime(t0);
        row.appendChild(mk('div', 'sp-time', t));
        var main = mk('div', 'sp-main');
        var teams = (ev.home && ev.away) ? ev.home + '  v  ' + ev.away : ev.title;
        main.appendChild(mk('div', 'sp-teams', teams));
        var sub = ev.league || sportLabel(ev.sport);
        if (ev.home && ev.away && ev.title && ev.title.indexOf(ev.home) < 0) sub = ev.title + ' · ' + sub;
        main.appendChild(mk('div', 'sp-league', sub));
        row.appendChild(main);
        var side = mk('div', 'sp-side');
        if (ev.status !== 'scheduled' && (ev.hst || ev.ast)) {
            // cricket: scores are text such as "88/3", not a single number
            side.appendChild(mk('span', 'sp-score', (ev.hst || '-') + ' v ' + (ev.ast || '-')));
        } else if (ev.hs !== null && ev.hs !== undefined && ev.as !== null && ev.as !== undefined && ev.status !== 'scheduled') {
            side.appendChild(mk('span', 'sp-score', ev.hs + ' - ' + ev.as));
        }
        var b = statusBadge(ev);
        if (b) side.appendChild(b);
        var tv = mk('span', 'sp-tv');
        tv.setAttribute('data-sp-tv', ev.id);
        side.appendChild(tv);
        row.appendChild(side);
        row.addEventListener('click', function () { openEvent(ev); });
        return row;
    }
    function updateBadges() {
        var tvs = document.querySelectorAll('#spList [data-sp-tv]');
        for (var i = 0; i < tvs.length; i++) {
            var id = tvs[i].getAttribute('data-sp-tv'), m = state.matches[id];
            tvs[i].textContent = m && m.length ? '▶ ' + (m.length > 1 ? m.length + ' ' + T2('sp_channels', 'channels') : T2('sp_on_tv', 'On TV')) : '';
            tvs[i].className = 'sp-tv' + (m && m.length ? ' on' : '');
        }
    }
    function waitingFor() {
        // True while the server is still fetching a sport this view cares about.
        if (!state.partial) return false;
        if (!(state.pending instanceof Array)) return true;       // older server: partial = everything pending
        if (!state.pending.length) return false;
        if (state.prefs.mode === 'mine' && state.prefs.sports.length) {
            for (var i = 0; i < state.prefs.sports.length; i++) {
                for (var k = 0; k < state.pending.length; k++) if (state.pending[k] === state.prefs.sports[i]) return true;
            }
            return false;
        }
        return true;
    }
    /* Events of the day grouped by sport, in the server's sport order. */
    function groupedForDay() {
        var evs = eventsForDay(state.day), order = [], by = {}, i, k;
        for (i = 0; i < state.sportsList.length; i++) order.push(state.sportsList[i].key);
        for (i = 0; i < evs.length; i++) {
            k = evs[i].sport;
            if (!by[k]) { by[k] = []; if (indexOfEl(order, k) < 0) order.push(k); }
            by[k].push(evs[i]);
        }
        var out = [], n = 0;
        for (i = 0; i < order.length && n < MAX_ROWS; i++) {
            var g = by[order[i]];
            if (!g) continue;
            if (n + g.length > MAX_ROWS) g = g.slice(0, MAX_ROWS - n);
            out.push({ sport: order[i], events: g });
            n += g.length;
        }
        return { groups: out, total: evs.length, shown: n };
    }
    function render() {
        state.prefs = state.prefs || loadPrefs();
        renderHeader();
        if (!$id('spDays') || !$id('spDays').children.length) renderDays();
        var list = $id('spList'), hint = $id('spHint');
        if (!list) return;
        var gd = (state.loaded && !(state.error && !state.loaded)) ? groupedForDay() : { groups: [], total: 0, shown: 0 };
        var waiting = waitingFor();
        // Nothing visible changed (e.g. the background re-ask for a partial feed returned the same
        // rows): leave the DOM, the scroll position and the focus exactly as they are.
        var sig = [state.day, state.prefs.mode, state.prefs.sports.join(','), state.prefs.teams.join(','), state.prefs.leagues.join(','), (state.loading && !state.loaded) ? 1 : 0, state.loaded ? 1 : 0,
                   state.error, waiting ? 1 : 0, state.when, playlistBusy() ? 1 : 0, I18n.getLanguage ? I18n.getLanguage() : ''];
        for (var gi = 0; gi < gd.groups.length; gi++) {
            sig.push(gd.groups[gi].sport);
            for (var ei = 0; ei < gd.groups[gi].events.length; ei++) {
                var e0 = gd.groups[gi].events[ei];
                sig.push(e0.id + ':' + e0.status + ':' + e0.hs + ':' + e0.as + ':' + (e0.hst || '') + ':' + (e0.ast || '') + ':' + e0.start);
            }
        }
        sig = sig.join('|');
        if (sig === state.sig && list.children.length) return;
        var viewKey = state.day + '|' + state.prefs.mode + '|' + state.prefs.sports.join(',') + '|' + state.prefs.teams.join(',') + '|' + state.prefs.leagues.join(',');
        var keepTop = (viewKey === state.viewKey) ? list.scrollTop : 0;
        state.sig = sig; state.viewKey = viewKey;
        var keepId = null, cur = window.Focus && Focus.current ? Focus.current() : null;
        if (cur && list.contains(cur)) keepId = cur.getAttribute('data-sp-id');
        list.innerHTML = '';
        hint.textContent = '';
        if (!state.loaded && playlistBusy()) { list.appendChild(mk('div', 'sp-empty', T2('sp_waiting', 'Waiting for your playlist to finish loading…'))); return; }
        if (state.loading && !state.loaded) { list.appendChild(mk('div', 'sp-empty', T2('sp_loading', 'Loading sports…'))); return; }
        if (state.error && !state.loaded) {
            list.appendChild(mk('div', 'sp-empty', T2('sp_error', 'Sports feed unavailable. Check your connection and try again.')));
            var rb = mk('button', 'btn focusable', T2('sp_retry', 'Retry'));
            rb.setAttribute('tabindex', '-1'); rb.setAttribute('data-focus-key', 'sp-retry');
            rb.addEventListener('click', function () { state.retries = 0; load(true); });
            list.appendChild(rb);
            return;
        }
        if (!gd.total) {
            var msg = waiting ? T2('sp_filling', 'Still gathering today’s schedule…')
                : (state.prefs.mode === 'mine' && hasFilter() ? T2('sp_none_filtered', 'Nothing matches your filter on this day.') : T2('sp_none', 'No events listed for this day.'));
            list.appendChild(mk('div', 'sp-empty', msg));
            return;
        }
        var idx = 0;
        for (var g = 0; g < gd.groups.length; g++) {
            var grp = gd.groups[g];
            list.appendChild(mk('div', 'sp-group', sportLabel(grp.sport)));
            for (var i = 0; i < grp.events.length; i++) list.appendChild(buildRow(grp.events[i], idx++));
        }
        if (gd.total > gd.shown) hint.textContent = T2('sp_more_hint', 'Showing the first {n}. Use Filter to narrow the list.').replace('{n}', String(gd.shown));
        updateBadges();
        list.scrollTop = keepTop;
        if (keepId) {
            var rows = list.querySelectorAll('.sp-row');
            for (var r = 0; r < rows.length; r++) {
                if (rows[r].getAttribute('data-sp-id') === keepId) {
                    if (window.Focus) { Focus.focus(rows[r]); list.scrollTop = keepTop; }   // refocus without moving the view
                    break;
                }
            }
        }
        if (state.day < MATCH_DAYS) { computeMatches(); updateBadges(); scheduleMatching(); }
    }
    function selectDay(off, focusTab) {
        state.day = off;
        renderWhen();
        var tabs = document.querySelectorAll('#spDays .btn');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-sp-day') === String(off)) tabs[i].classList.add('active'); else tabs[i].classList.remove('active');
        }
        render();
        if (focusTab) { var t = document.querySelector('#spDays [data-sp-day="' + off + '"]'); if (t && window.Focus) Focus.focus(t); }
    }

    /* ---------- event actions ---------- */
    function openEvent(ev) {
        var m = state.matches[ev.id] || [];
        var items = [], acts = [], i;
        for (i = 0; i < m.length; i++) {
            (function (hit) {
                items.push('▶ ' + hit.ch.name + (hit.prog && hit.prog.title ? '  —  ' + hit.prog.title : ''));
                acts.push(function () { try { UI.tryPlay(hit.ch); } catch (e) {} });
            })(m[i]);
        }
        var teams = [];
        if (ev.home) teams.push(ev.home);
        if (ev.away) teams.push(ev.away);
        for (i = 0; i < teams.length; i++) {
            (function (tm) {
                var following = false;
                for (var k = 0; k < state.prefs.teams.length; k++) if (norm(state.prefs.teams[k]) === norm(tm)) following = true;
                items.push((following ? '✓ ' : '☆ ') + (following ? T2('sp_following', 'Following') : T2('sp_follow', 'Follow')) + ' ' + tm);
                acts.push(function () { toggleTeam(tm); });
            })(teams[i]);
        }
        if (!m.length && (UI.toast)) {
            if (state.day < MATCH_DAYS && !teams.length) { UI.toast(T2('sp_no_channel', 'No matching channel found in your guide'), null); return; }
        }
        if (!items.length) { UI.toast(T2('sp_no_channel', 'No matching channel found in your guide'), null); return; }
        var title = ((ev.home && ev.away) ? ev.home + ' v ' + ev.away : ev.title) + (m.length ? '' : '  —  ' + T2('sp_no_channel_short', 'no channel match'));
        UI.openListPicker({
            title: title, items: items, selected: -1, widthPx: 1180, wrapRows: true,
            onSelect: function (idx) { if (acts[idx]) acts[idx](); }
        });
    }
    function toggleTeam(name) {
        var t = state.prefs.teams, out = [], had = false;
        for (var i = 0; i < t.length; i++) { if (norm(t[i]) === norm(name)) had = true; else out.push(t[i]); }
        if (!had) out.push(name);
        state.prefs.teams = out;
        if (!had && state.prefs.mode !== 'mine') state.prefs.mode = 'mine';
        if (!hasFilter()) state.prefs.mode = 'all';
        savePrefs(); state.matches = {}; render();
        if (UI.toast) UI.toast((had ? T2('sp_unfollowed', 'Unfollowed') : T2('sp_following', 'Following')) + ' ' + name, null);
    }

    /* ---------- filter modal ---------- */
    function openFilter() {
        var body = mk('div', 'sp-filter');
        var sportsHead = mk('div', 'sp-fhead', T2('sp_sports', 'Sports'));
        var sportsGrid = mk('div', 'sp-fgrid');
        var teamsHead = mk('div', 'sp-fhead', T2('sp_teams', 'Teams'));
        var teamsWrap = mk('div', 'sp-fgrid');
        var leaguesHead = mk('div', 'sp-fhead', T2('sp_leagues', 'Leagues'));
        var leaguesWrap = mk('div', 'sp-fleagues');
        body.appendChild(sportsHead); body.appendChild(sportsGrid);
        body.appendChild(leaguesHead); body.appendChild(leaguesWrap);
        body.appendChild(teamsHead); body.appendChild(teamsWrap);

        var teamDraft = '', leagueGrids = [];
        function sportOn(k) { for (var i = 0; i < state.prefs.sports.length; i++) if (state.prefs.sports[i] === k) return true; return false; }
        function buildSports() {
            sportsGrid.innerHTML = '';
            var list = state.sportsList.length ? state.sportsList : [];
            for (var i = 0; i < list.length; i++) {
                (function (s) {
                    var on = sportOn(s.key);
                    var b = mk('button', 'btn focusable sp-chip' + (on ? ' active' : ''), (on ? '✓ ' : '') + sportLabel(s.key));
                    b.setAttribute('tabindex', '-1'); b.setAttribute('data-focus-key', 'spf-' + s.key);
                    b.addEventListener('click', function () {
                        var arr = state.prefs.sports, out = [], had = false;
                        for (var k = 0; k < arr.length; k++) { if (arr[k] === s.key) had = true; else out.push(arr[k]); }
                        if (!had) out.push(s.key);
                        state.prefs.sports = out;
                        if (had) {     // un-ticking a sport also drops its league choices
                            var keepL = [], pre = s.key + '|';
                            for (var lk = 0; lk < state.prefs.leagues.length; lk++) if (state.prefs.leagues[lk].indexOf(pre) !== 0) keepL.push(state.prefs.leagues[lk]);
                            state.prefs.leagues = keepL;
                        }
                        buildSports();
                        buildLeagues();
                        Focus.focusKey('spf-' + s.key);
                    });
                    sportsGrid.appendChild(b);
                })(list[i]);
            }
        }
        /* Leagues of the ticked sports, read from the events already loaded (no server change). Most events first;
         * a league that is ticked but not in today's feed still shows so it can be un-ticked. */
        function leaguesOf(sportKey) {
            var cnt = {}, names = [], i, nm;
            for (i = 0; i < state.events.length; i++) {
                var e = state.events[i];
                if (e.sport !== sportKey) continue;
                nm = String(e.league || '').replace(/^\s+|\s+$/g, '');
                if (!nm) continue;
                if (!cnt[nm]) { cnt[nm] = 0; names.push(nm); }
                cnt[nm]++;
            }
            names.sort(function (a, b) { return (cnt[b] - cnt[a]) || (a < b ? -1 : a > b ? 1 : 0); });
            if (names.length > LEAGUE_MAX) names = names.slice(0, LEAGUE_MAX);
            var pre = sportKey + '|';
            for (i = 0; i < state.prefs.leagues.length; i++) {
                if (state.prefs.leagues[i].indexOf(pre) === 0) {
                    nm = state.prefs.leagues[i].substring(pre.length);
                    if (names.indexOf(nm) < 0) names.push(nm);
                }
            }
            return names;
        }
        function leagueOn(k) { return state.prefs.leagues.indexOf(k) >= 0; }
        function buildLeagues() {
            leaguesWrap.innerHTML = '';
            leagueGrids = [];
            var sel = state.prefs.sports, shown = 0;
            for (var si = 0; si < sel.length; si++) {
                (function (sk) {
                    var names = leaguesOf(sk);
                    if (!names.length) return;
                    shown++;
                    leaguesWrap.appendChild(mk('div', 'sp-fsub', sportLabel(sk)));
                    var grid = mk('div', 'sp-fgrid');
                    for (var ni = 0; ni < names.length; ni++) {
                        (function (nm) {
                            var key = sk + '|' + nm, on = leagueOn(key);
                            var b = mk('button', 'btn focusable sp-chip sp-chip-wrap' + (on ? ' active' : ''), (on ? '\u2713 ' : '') + nm);
                            b.setAttribute('tabindex', '-1'); b.setAttribute('data-focus-key', 'spl-' + sk + '-' + norm(nm).replace(/ /g, '_'));
                            b.addEventListener('click', function () {
                                var arr = state.prefs.leagues, out = [], had = false;
                                for (var k = 0; k < arr.length; k++) { if (arr[k] === key) had = true; else out.push(arr[k]); }
                                if (!had) out.push(key);
                                state.prefs.leagues = out;
                                buildLeagues();
                                Focus.focusKey(b.getAttribute('data-focus-key'));
                            });
                            grid.appendChild(b);
                        })(names[ni]);
                    }
                    leaguesWrap.appendChild(grid);
                    leagueGrids.push(grid);
                })(sel[si]);
            }
            if (!shown) leaguesWrap.appendChild(mk('div', 'sp-fhint', sel.length ? T2('sp_leagues_none', 'No leagues listed yet for the chosen sports') : T2('sp_leagues_hint', 'Pick a sport above to choose leagues')));
            wireSportNav();
        }
        function buildTeams() {
            teamsWrap.innerHTML = '';
            var fld = document.createElement('input');
            fld.type = 'text'; fld.className = 'field focusable sp-team-field';
            fld.setAttribute('readonly', 'readonly'); fld.setAttribute('tabindex', '-1');
            fld.setAttribute('data-focus-key', 'spf-field');
            fld.setAttribute('placeholder', T2('sp_team_ph', 'Type a team name'));
            fld.value = teamDraft;
            fld.addEventListener('input', function () { teamDraft = fld.value; });
            fld.addEventListener('click', function () { if (UI.openVKeyboard) UI.openVKeyboard(fld, fld); });
            var add = mk('button', 'btn focusable sp-chip', '+ ' + T2('sp_add_team', 'Add'));
            add.setAttribute('tabindex', '-1'); add.setAttribute('data-focus-key', 'spf-add');
            add.addEventListener('click', function () {
                var v = String(fld.value || '').replace(/^\s+|\s+$/g, '');
                if (!v) { Focus.focus(fld); return; }
                var dup = false;
                for (var q = 0; q < state.prefs.teams.length; q++) if (norm(state.prefs.teams[q]) === norm(v)) dup = true;
                if (!dup) state.prefs.teams.push(v);
                teamDraft = '';
                buildTeams();
                Focus.focusKey('spf-field');
            });
            teamsWrap.appendChild(fld);
            teamsWrap.appendChild(add);
            for (var i = 0; i < state.prefs.teams.length; i++) {
                (function (tm) {
                    var b = mk('button', 'btn focusable sp-chip active', '✕ ' + tm);
                    b.setAttribute('tabindex', '-1'); b.setAttribute('data-focus-key', 'spf-t-' + norm(tm).replace(/ /g, '_'));
                    b.addEventListener('click', function () {
                        var out = [];
                        for (var k = 0; k < state.prefs.teams.length; k++) if (state.prefs.teams[k] !== tm) out.push(state.prefs.teams[k]);
                        state.prefs.teams = out; buildTeams(); Focus.focusKey('spf-field');
                    });
                    teamsWrap.appendChild(b);
                })(state.prefs.teams[i]);
            }
            wireSportNav();
        }
        /* Explicit up/down pointers for the sports grid (NAVIGATION-OVERRIDES.md: wrong geometric pick ->
         * data-focus override). Rows are read from the laid-out chips, so it follows whatever column
         * count the screen gives. Down: same column in the next row; if that row is shorter, its last
         * chip; from the last row, the team field. Up: same column in the row above (top row is left to
         * spatial so it can leave the grid). */
        /* The chip in a row whose centre is closest to el's centre; a tie goes to the later chip
         * (a short, centred last row sits half a chip off the rows above it). */
        function nearestInRow(row, el) {
            var cx = el.offsetLeft + el.offsetWidth / 2, best = row[0], bd = 1e9;
            for (var q = 0; q < row.length; q++) {
                var d = Math.abs(row[q].offsetLeft + row[q].offsetWidth / 2 - cx);
                if (d <= bd + 0.5) { best = row[q]; if (d < bd) bd = d; }
            }
            return best.getAttribute('data-focus-key');
        }
        function gridRows(grid) {
            var chips = grid.children, rows = [], lastTop = null, i;
            if (!chips.length || !(chips[0].offsetWidth || chips[0].offsetHeight)) return null;
            for (i = 0; i < chips.length; i++) {
                var tp = chips[i].offsetTop;
                if (lastTop === null || Math.abs(tp - lastTop) > 4) { rows.push([]); lastTop = tp; }
                rows[rows.length - 1].push(chips[i]);
            }
            return rows;
        }
        /* Sports grid, then one grid per ticked sport's leagues, then the team field: Down/Up between them are
         * explicit, in the same way as inside the sports grid. */
        function wireSportNav() {
            var chain = [sportsGrid].concat(leagueGrids), all = [], g, r, c;
            for (g = 0; g < chain.length; g++) { var rw = gridRows(chain[g]); if (!rw) { if (g === 0) return; continue; } all.push(rw); }
            for (g = 0; g < all.length; g++) {
                var rows = all[g];
                for (r = 0; r < rows.length; r++) {
                    for (c = 0; c < rows[r].length; c++) {
                        var el = rows[r][c], dn, up;
                        if (r + 1 < rows.length) dn = nearestInRow(rows[r + 1], el);
                        else if (g + 1 < all.length) dn = nearestInRow(all[g + 1][0], el);
                        else dn = 'spf-field';
                        el.setAttribute('data-focus-down', dn);
                        if (r > 0) up = nearestInRow(rows[r - 1], el);
                        else if (g > 0) up = nearestInRow(all[g - 1][all[g - 1].length - 1], el);
                        if (up) el.setAttribute('data-focus-up', up); else el.removeAttribute('data-focus-up');
                    }
                }
            }
            var fld = teamsWrap.querySelector('.sp-team-field');
            if (fld && all.length) { var lastG = all[all.length - 1]; fld.setAttribute('data-focus-up', nearestInRow(lastG[lastG.length - 1], fld)); }
        }
        var buildSportsBase = buildSports;
        buildSports = function () { buildSportsBase(); wireSportNav(); };
        buildSports(); buildLeagues(); buildTeams();
        function commit() {
            state.prefs.mode = hasFilter() ? 'mine' : 'all';
            savePrefs(); state.matches = {}; render();
        }
        UI.openModal({
            title: T2('sp_filter_title', 'Filter sports and teams'),
            bodyEl: body,
            okText: T2('sp_apply', 'Apply'),
            cancelText: T2('sp_clear', 'Clear all'),
            cardClass: 'sp-filter-card',
            onOk: commit,
            onCancel: function () { state.prefs.sports = []; state.prefs.teams = []; state.prefs.leagues = []; state.prefs.mode = 'all'; savePrefs(); state.matches = {}; render(); }
        });
        wireSportNav();                                   // chips only have a layout once the modal is attached
        setTimeout(wireSportNav, 60);
    }

    /* ---------- d-pad ---------- */
    function zoneOf(cur) {
        if (!cur) return null;
        if (cur.id === 'spMode' || cur.id === 'spFilter' || cur.id === 'spRefresh') return 'head';
        if (cur.parentNode && cur.parentNode.id === 'spDays') return 'days';
        if (cur.parentNode && cur.parentNode.id === 'spWhen') return 'when';
        if (cur.classList && (cur.classList.contains('sp-row') || cur.getAttribute('data-focus-key') === 'sp-retry')) return 'rows';
        return null;
    }
    function visibleBtns(sel) {
        var all = document.querySelectorAll(sel), out = [];
        for (var i = 0; i < all.length; i++) if (all[i].offsetWidth || all[i].offsetHeight) out.push(all[i]);
        return out;
    }
    function indexOfEl(arr, el) { for (var i = 0; i < arr.length; i++) if (arr[i] === el) return i; return -1; }
    function focusEl(el) { if (el && window.Focus) { Focus.focus(el); return true; } return false; }

    /* Returns true when the key was handled (focus moved or deliberately held),
     * false when the caller should hand focus to the side menu (left only). */
    function nav(cur, dir) {
        var z = zoneOf(cur);
        var when = visibleBtns('#spWhen .btn');
        var head = visibleBtns('.sp-head-btn'), days = visibleBtns('#spDays .btn'), rows = visibleBtns('#spList .sp-row, #spList [data-focus-key="sp-retry"]');
        var i;
        if (!z) { // nothing in-section focused: enter at the active day tab
            var act = document.querySelector('#spDays .btn.active') || days[0];
            return focusEl(act);
        }
        if (z === 'head') {
            i = indexOfEl(head, cur);
            if (dir === 'left') { if (i > 0) return focusEl(head[i - 1]); return false; }
            if (dir === 'right') { if (i < head.length - 1) focusEl(head[i + 1]); return true; }
            if (dir === 'down') { return focusEl(document.querySelector('#spDays .btn.active') || days[0]) || true; }
            return true;
        }
        if (z === 'days') {
            i = indexOfEl(days, cur);
            if (dir === 'left') { if (i > 0) return focusEl(days[i - 1]); return false; }
            if (dir === 'right') { if (i < days.length - 1) focusEl(days[i + 1]); return true; }
            if (dir === 'up') { if (head.length) focusEl(head[0]); return true; }
            if (dir === 'down') { if (when.length) focusEl(when[0]); else if (rows.length) focusEl(rows[0]); return true; }
        }
        if (z === 'when') {
            i = indexOfEl(when, cur);
            if (dir === 'left') { if (i > 0) return focusEl(when[i - 1]); return false; }
            if (dir === 'right') { if (i < when.length - 1) focusEl(when[i + 1]); return true; }
            if (dir === 'up') { focusEl(document.querySelector('#spDays .btn.active') || days[0]); return true; }
            if (dir === 'down') { if (rows.length) focusEl(rows[0]); return true; }
        }
        if (z === 'rows') {
            i = indexOfEl(rows, cur);
            if (dir === 'left') return false;
            if (dir === 'right') return true;
            if (dir === 'down') { if (i < rows.length - 1) focusEl(rows[i + 1]); return true; }
            if (dir === 'up') {
                if (i > 0) focusEl(rows[i - 1]);
                else if (when.length) focusEl(when[0]);
                else focusEl(document.querySelector('#spDays .btn.active') || days[0]);
                return true;
            }
        }
        return true;
    }

    /* ---------- lifecycle ---------- */
    function bind() {
        var mode = $id('spMode'), filter = $id('spFilter'), refresh = $id('spRefresh');
        if (mode) mode.addEventListener('click', function () {
            state.prefs.mode = state.prefs.mode === 'mine' ? 'all' : 'mine';
            savePrefs(); state.matches = {}; render();
        });
        if (filter) filter.addEventListener('click', openFilter);
        if (refresh) refresh.addEventListener('click', function () { state.retries = 0; load(true); });
    }
    function enter() {
        state.prefs = loadPrefs();
        if (!$id('spDays') || !$id('spDays').children.length) renderDays();
        bind_once();
        state.day = 0; state.retries = 0; state.when = 'upcoming';
        renderDays(); renderWhen();
        if (!state.loaded) loadFeedCache();      // show the last feed instantly; load() below refreshes it
        load(false);
    }
    var bound = false;
    function bind_once() { if (!bound) { bound = true; bind(); } }

    return {
        enter: enter, nav: nav, render: render, load: load, indexingDone: indexingDone,
        _state: state, _cfg: cfg, _norm: norm, _progScore: progScore, _passes: passes
    };
})();
