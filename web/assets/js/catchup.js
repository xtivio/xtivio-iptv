/* catchup.js - Xtream catch-up (TV archive): which programmes can be replayed and the URL that plays one.
 *
 * Data comes from the provider itself, per channel, when the user opens Catch-up:
 *   player_api.php?action=get_simple_data_table&stream_id=ID
 * (not from the XMLTV guide, which only keeps 12 hours of past programmes while providers archive up to
 * several days). Each row carries start_timestamp / stop_timestamp (real UTC seconds), start / end as
 * provider-local text ("2026-11-04 05:50:00") and has_archive. The archive URL wants the provider-local
 * clock, so the text of the SAME row is used: it is right for that programme whatever daylight-saving
 * changes happened inside the archive window, and the app never needs the provider's time-zone name.
 *
 *   {host}/timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-MM}/{stream_id}.m3u8   (.ts as the fallback)
 *
 * The .m3u8 form answers with a finished (ENDLIST) playlist, so the player treats it as a recording: seek
 * and pause work. Starting somewhere inside a programme is a new start time with a shorter duration.
 *
 * Pure logic only (no DOM), so it can be tested on its own. ES5. */
var Catchup = (function () {
    'use strict';

    var LIST_TTL_MS = 5 * 60 * 1000;     // a channel's programme list is reused for this long
    var ENDED_GRACE_MS = 60 * 1000;      // a programme is offered once it ended this long ago
    var WINDOW_SLACK_MS = 10 * 60 * 1000; // programmes whose start is just outside the archive window are still tried
    var cache = {};                       // playlistId|streamId -> { at, list }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    /* Xtream channels carry archiveDays (from tv_archive=1 + tv_archive_duration) when the provider archives them. */
    function isStalkerLive(ch) {
        return !!(ch && ch.type === 'stalker' && ch.stalkerKind !== 'vod' && ch.stalkerKind !== 'series' && ch.stalkerId != null && ch.stalkerId !== '');
    }
    /* Stalker channels carry archiveHours (the portal keeps that many hours; server v88). */
    function supports(ch) {
        if (isStalkerLive(ch)) return Number(ch.archiveHours) > 0;
        if (ch && ch.type === 'm3u') return !!(ch.url && Number(ch.archiveDays) > 0);
        return !!(ch && ch.type === 'xtream' && ch.streamId != null && ch.streamId !== '' && Number(ch.archiveDays) > 0);
    }

    /* Titles and descriptions are base64 on a standard panel. A plain-text title must survive: decode, and fall back
     * to the raw text when the result is not readable text. */
    function decodeText(s) {
        s = String(s == null ? '' : s);
        if (!s) return '';
        if (!/^[A-Za-z0-9+\/]+=*$/.test(s) || s.length % 4 !== 0) return s;
        try {
            var bin = (typeof atob === 'function') ? atob(s) : null;
            if (bin === null) return s;
            var out;
            try { out = decodeURIComponent(escape(bin)); }
            catch (eU) {
                // Not valid UTF-8: real base64 text of a title always is, so this was a plain word that only
                // looks like base64 ("News", "Test"). Keep the original.
                return s;
            }
            // control characters or the replacement character mean this was not base64 text after all
            if (/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(out)) return s;
            return out;
        } catch (e) { return s; }
    }

    /* "2026-11-04 05:50:00" read as if it were UTC, in seconds. */
    function textAsUtcSec(t) {
        var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
        if (!m) return null;
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
    }

    /* Turn the provider's rows into programmes that can be replayed now, newest first.
     * archiveDays: the channel's archive length in days. nowMs is injectable for tests. */
    function parseTable(json, archiveDays, nowMs) {
        var rows = json && json.epg_listings;
        var out = [];
        if (!rows || !rows.length) return out;
        var now = nowMs || new Date().getTime();
        var oldest = now - (Number(archiveDays) || 1) * 86400000 - WINDOW_SLACK_MS;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var st = Number(r.start_timestamp), en = Number(r.stop_timestamp || r.end_timestamp);
            if (!isFinite(st) || !isFinite(en) || en <= st) continue;
            var stMs = st * 1000, enMs = en * 1000;
            if (enMs > now - ENDED_GRACE_MS) continue;                  // not finished yet
            if (stMs < oldest) continue;                                 // older than the archive keeps
            if (r.has_archive !== undefined && r.has_archive !== null && String(r.has_archive) === '0') continue;
            var local = textAsUtcSec(r.start);
            out.push({
                title: decodeText(r.title) || '',
                startTs: st, stopTs: en,
                // provider-local clock minus real UTC, in seconds, for THIS programme (e.g. 3600 in winter, 7200 in summer)
                offSec: local === null ? null : Math.round(local - st)
            });
        }
        out.sort(function (a, b) { return b.startTs - a.startTs; });
        return out;
    }

    /* "2026-11-04:05-50" for a real UTC instant shown on the provider's clock. */
    function clockText(utcSec, offSec) {
        var d = new Date((utcSec + offSec) * 1000);
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ':' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes());
    }

    /* The archive URL for a programme, starting skipSec seconds into it. ext 'm3u8' or 'ts'.
     * Returns '' when the programme has no usable clock. */
    function buildUrl(pl, ch, prog, skipSec, ext) {
        if (!pl || !pl.host || !prog || prog.offSec === null || prog.offSec === undefined) return '';
        var skip = Math.max(0, Math.floor(skipSec || 0));
        var startSec = prog.startTs + skip;
        // the clock text has no seconds: floor to the minute and make the duration cover the dropped seconds
        var floored = startSec - (startSec + prog.offSec) % 60;
        if ((startSec + prog.offSec) % 60 < 0) floored = startSec;
        var minutes = Math.max(1, Math.ceil((prog.stopTs - floored) / 60));
        var base = String(pl.host).replace(/\/$/, '');
        return base + '/timeshift/' + encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' + minutes + '/' +
            clockText(floored, prog.offSec) + '/' + ch.streamId + '.' + (ext || 'm3u8');
    }

    /* The object the player plays. type stays 'xtream' (so history and "last channel" code treat it as Live TV
     * and never as a movie); catchup marks it as a recording for the player. */
    function makeItem(pl, ch, prog, skipSec) {
        var url = buildUrl(pl, ch, prog, skipSec, 'm3u8');
        if (!url) return null;
        return {
            id: ch.id + ':cu:' + prog.startTs,
            name: (ch.name || '') + ' \u2013 ' + (prog.title || ''),
            url: url,
            fallbackUrl: buildUrl(pl, ch, prog, skipSec, 'ts'),
            logo: ch.logo || '',
            category: ch.category || '',
            tvgId: ch.tvgId || '',
            epgId: ch.epgId || '',
            number: ch.number || 0,
            playlistId: ch.playlistId,
            playlistName: ch.playlistName,
            type: 'xtream',
            streamId: ch.streamId,
            catchup: { startTs: prog.startTs, stopTs: prog.stopTs, title: prog.title || '', channelId: ch.id }
        };
    }

    /* Stalker: the server's /api/stalker/archive answer ({programmes:[{id,title,start,stop}]}, finished and archived
     * already) -> programmes inside the archive window. The portal builds the link itself from the programme id. */
    function parseStalker(json, archiveHours, nowMs) {
        var rows = json && json.programmes, out = [];
        if (!rows || !rows.length) return out;
        var now = nowMs || new Date().getTime();
        var oldest = now - (Number(archiveHours) || 24) * 3600000 - WINDOW_SLACK_MS;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], st = Number(r.start), en = Number(r.stop);
            if (!isFinite(st) || !isFinite(en) || en <= st || r.id == null || r.id === '') continue;
            if (en * 1000 > now - ENDED_GRACE_MS || st * 1000 < oldest) continue;
            out.push({ title: String(r.title || ''), startTs: st, stopTs: en, pid: String(r.id), offSec: null });
        }
        out.sort(function (a, b) { return b.startTs - a.startTs; });
        return out;
    }

    /* The object the player plays for a Stalker programme: no URL yet, the player asks the server for the portal's
     * archive link at play time (stalkerKind 'archive'). */
    function makeStalkerItem(ch, prog) {
        if (!prog || !prog.pid) return null;
        return {
            id: ch.id + ':cu:' + prog.startTs,
            name: (ch.name || '') + ' \u2013 ' + (prog.title || ''),
            url: '',
            logo: ch.logo || '',
            category: ch.category || '',
            tvgId: ch.tvgId || '',
            epgId: ch.epgId || '',
            number: ch.number || 0,
            playlistId: ch.playlistId,
            playlistName: ch.playlistName,
            type: 'stalker',
            stalkerKind: 'archive',
            stalkerId: ch.stalkerId,
            stalkerProgId: prog.pid,
            catchup: { startTs: prog.startTs, stopTs: prog.stopTs, title: prog.title || '', channelId: ch.id }
        };
    }

    /* A channel's own id within its source: Xtream stream id, Stalker id, or (playlist channels, which have neither) the
     * channel id the parser made. Without the last one every playlist channel shared one cache and one 'empty' entry. */
    function ownId(ch) { return ch.streamId != null ? ch.streamId : (ch.stalkerId != null ? ch.stalkerId : ch.id); }
    function key(ch) { return ch.playlistId + '|' + ownId(ch); }
    function cached(ch, nowMs) {
        var e = cache[key(ch)];
        return (e && ((nowMs || new Date().getTime()) - e.at) < LIST_TTL_MS) ? e.list : null;
    }
    function remember(ch, list, nowMs) { cache[key(ch)] = { at: nowMs || new Date().getTime(), list: list }; }
    function forget() { cache = {}; }

    /* Channels that opened with no past programmes are remembered (per source) and left out of the list, so a provider that
     * flags hundreds of channels it never recorded stops cluttering the page. The map is { sourceId: { channelId: time } };
     * these helpers only read and change it, the screen stores it. An entry expires, because a guide can come back. */
    var EMPTY_TTL_MS = 7 * 24 * 3600 * 1000;
    function chanId(ch) { return String(ownId(ch)); }
    function isEmptyIn(map, ch, nowMs) {
        var m = map && map[ch.playlistId], t = m ? m[chanId(ch)] : 0;
        return !!t && ((nowMs || new Date().getTime()) - t) < EMPTY_TTL_MS;
    }
    function markEmptyIn(map, ch, nowMs) {
        map = map || {};
        if (!map[ch.playlistId]) map[ch.playlistId] = {};
        map[ch.playlistId][chanId(ch)] = nowMs || new Date().getTime();
        return map;
    }
    function unmarkEmptyIn(map, ch) {
        if (map && map[ch.playlistId]) delete map[ch.playlistId][chanId(ch)];
        return map;
    }
    function pruneEmpty(map, nowMs) {
        var now = nowMs || new Date().getTime(), out = {}, p, c;
        if (!map || typeof map !== 'object') return out;
        for (p in map) {
            if (!map.hasOwnProperty(p) || !map[p] || typeof map[p] !== 'object') continue;
            for (c in map[p]) {
                if (map[p].hasOwnProperty(c) && (now - Number(map[p][c])) < EMPTY_TTL_MS) { if (!out[p]) out[p] = {}; out[p][c] = Number(map[p][c]); }
            }
        }
        return out;
    }

    /* Channels whose guide has no past rows can still have a recording: Xtream answers a time-slot request without a guide
     * row (probe v16/v19). The slot needs the provider's clock, which the login answer carries as server_info.time_now
     * (provider-local text) next to timestamp_now (real UTC); their difference is the offset, rounded to a quarter hour. */
    function offsetFromServerInfo(si) {
        if (!si) return null;
        var tn = textAsUtcSec(si.time_now), ts = Number(si.timestamp_now);
        if (tn === null || !isFinite(ts) || ts <= 0) return null;
        return Math.round((tn - ts) / 900) * 900;
    }
    function posMod(a, m) { return ((a % m) + m) % m; }
    /* One-hour slots on the provider's hour, newest first, every one fully finished and inside the archive window.
     * Each looks like a programme (startTs, stopTs, offSec) so the same URL builder plays it. titleFn(startSec, stopSec)
     * names it for the list. */
    function buildSlots(nowMs, archiveDays, offSec, titleFn) {
        var out = [], nowS = Math.floor(nowMs / 1000);
        var oldest = nowS - (Number(archiveDays) || 1) * 86400;
        var st = nowS - posMod(nowS + offSec, 3600) - 3600;          // the latest hour that has fully ended
        while (st >= oldest && out.length < 24 * 14) {
            out.push({ title: titleFn ? titleFn(st, st + 3600) : '', startTs: st, stopTs: st + 3600, offSec: offSec, slot: true });
            st -= 3600;
        }
        return out;
    }
    /* A real archive answer is a playlist with media or variants in it; an empty page or an error text is not. */
    function playlistLooksValid(body) {
        var t = String(body || '');
        return /^\s*#EXTM3U/.test(t) && /#EXTINF|#EXT-X-STREAM-INF/.test(t);
    }

    /* ===== Playlist (M3U) catch-up =====
     * A plain playlist carries no programme table and no archive link: only how long the archive is (timeshift,
     * catchup-days, tvg-rec) and, sometimes, the kind of link (catchup="flussonic" ...) or a template (catchup-source).
     * Providers differ, so for one programme several candidate links are built, in the order the playlist and the stream
     * address make likely, each is asked for, and the first one that answers with a real recording is played. Which kind
     * worked is remembered per source, so the next programme goes straight to it.
     *
     * Kinds: 'default' (catchup-source is the whole link), 'append' (catchup-source is added to the stream link),
     * 'flussonic' (index.m3u8 -> index-{utc}-{duration}.m3u8, also archive-...), 'flussonic-ts' (timeshift_abs / archive
     * .ts), 'shift' (?utc={utc}&lutc={lutc}), 'xc' (Xtream timeshift paths, on the provider's clock; only when the playlist
     * names it, because the clock cannot be known). */
    function two(n) { return n < 10 ? '0' + n : '' + n; }
    function dateParts(sec) {
        var d = new Date(sec * 1000);
        return { Y: '' + d.getUTCFullYear(), m: two(d.getUTCMonth() + 1), d: two(d.getUTCDate()), H: two(d.getUTCHours()), M: two(d.getUTCMinutes()), S: two(d.getUTCSeconds()) };
    }
    /* {utc} {start} {timestamp} (start, UTC seconds), {utcend} {end}, {lutc} {now}, {duration} (seconds; {duration:60} = minutes),
     * {offset} (seconds since the start), {Y}{m}{d}{H}{M}{S} (start, UTC), {utc:YmdHMS} / {utcend:YmdHMS}; also the ${name} form. */
    function fillTemplate(tpl, startSec, durSec, nowSec) {
        var endSec = startSec + durSec, sp = dateParts(startSec);
        function fmt(sec, f) {
            var p = dateParts(sec), o = '', i;
            for (i = 0; i < f.length; i++) o += (p[f.charAt(i)] !== undefined ? p[f.charAt(i)] : f.charAt(i));
            return o;
        }
        return String(tpl).replace(/\$?\{([A-Za-z]+)(?::([^}]*))?\}/g, function (all, name, arg) {
            switch (name) {
                case 'utc': case 'start': case 'timestamp': return arg ? fmt(startSec, arg) : '' + startSec;
                case 'utcend': case 'end': return arg ? fmt(endSec, arg) : '' + endSec;
                case 'lutc': case 'now': return '' + nowSec;
                case 'duration': return arg === '60' ? '' + Math.max(1, Math.round(durSec / 60)) : '' + durSec;
                case 'offset': return '' + Math.max(0, nowSec - startSec);
                case 'Y': case 'm': case 'd': case 'H': case 'M': case 'S': return sp[name];
                default: return all;
            }
        });
    }
    function splitUrl(u) {
        var q = u.indexOf('?'), h = q >= 0 ? q : u.length;
        var base = u.substring(0, h), qs = q >= 0 ? u.substring(q) : '';
        var s = base.lastIndexOf('/');
        return { dir: base.substring(0, s + 1), file: base.substring(s + 1), qs: qs, base: base };
    }
    function addQuery(u, add) { return u + (u.indexOf('?') >= 0 ? '&' : '?') + add; }
    function stemOf(file) { var d = file.lastIndexOf('.'); return d > 0 ? file.substring(0, d) : file; }

    function groupFlussonic(u, st, dur) {
        var s = splitUrl(u), out = [];
        if (!/\.m3u8$/i.test(s.file)) return out;
        var stem = stemOf(s.file);
        out.push({ id: 'flussonic', url: s.dir + stem + '-' + st + '-' + dur + '.m3u8' + s.qs });
        if (stem !== 'archive') out.push({ id: 'flussonic-archive', url: s.dir + 'archive-' + st + '-' + dur + '.m3u8' + s.qs });
        return out;
    }
    function groupFlussonicTs(u, st, dur) {
        var s = splitUrl(u), out = [];
        if (/\.m3u8$/i.test(s.file)) return out;
        out.push({ id: 'flussonic-ts', url: s.dir + 'timeshift_abs-' + st + '.ts' + s.qs });
        out.push({ id: 'flussonic-ts-archive', url: s.dir + 'archive-' + st + '-' + dur + '.ts' + s.qs });
        return out;
    }
    function groupShift(u, st, dur, now) {
        return [{ id: 'shift', url: addQuery(u, 'utc=' + st + '&lutc=' + now) }];
    }
    /* Xtream-style stream address: http://host/[live/]user/pass/ID(.m3u8|.ts). The clock text is on the provider's clock,
     * which a plain playlist does not give, so UTC and then this device's clock are tried. */
    function groupXc(u, st, dur, now, devOffSec) {
        var m = /^(https?:\/\/[^\/]+(?:\/[^\/]+)*?)\/(?:live\/)?([^\/?]+)\/([^\/?]+)\/(\d+)(?:\.(?:m3u8|ts))?(?:\?.*)?$/i.exec(u);
        var out = [];
        if (!m) return out;
        var minutes = Math.max(1, Math.ceil(dur / 60)), offs = [0], k;
        if (devOffSec) offs.push(devOffSec);
        for (k = 0; k < offs.length; k++) {
            var d = new Date((st + offs[k]) * 1000);
            var clock = d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate()) + ':' + two(d.getUTCHours()) + '-' + two(d.getUTCMinutes());
            var tag = k === 0 ? 'utc' : 'local';
            out.push({ id: 'xc-' + tag, url: m[1] + '/timeshift/' + m[2] + '/' + m[3] + '/' + minutes + '/' + clock + '/' + m[4] + '.m3u8' });
            out.push({ id: 'xc-php-' + tag, url: m[1] + '/streaming/timeshift.php?username=' + m[2] + '&password=' + m[3] + '&stream=' + m[4] + '&start=' + clock + '&duration=' + minutes });
        }
        return out;
    }
    function looksFlussonic(u) {
        var s = splitUrl(u);
        return /^(index|mono|video|playlist|archive)(-.*)?\.m3u8$/i.test(s.file) || /\/mpegts$/i.test(s.base);
    }

    /* Candidate links for one programme, best guess first. startSec/durSec/nowSec in UTC seconds; devOffSec is this device's
     * clock offset from UTC in seconds. */
    function m3uCandidates(ch, startSec, durSec, nowSec, devOffSec) {
        var url = String(ch.url || ''), type = String(ch.cuType || '').toLowerCase(), src = String(ch.cuSource || '');
        var out = [], seen = {};
        function add(list) {
            for (var i = 0; i < list.length; i++) {
                if (!list[i].url || list[i].url === url || seen[list[i].url]) continue;
                seen[list[i].url] = 1; out.push(list[i]);
            }
        }
        function fromSource() {
            if (!src) return [];
            var filled = fillTemplate(src, startSec, durSec, nowSec);
            if (type === 'append' || !/^[a-z][a-z0-9+.\-]*:\/\//i.test(filled)) {
                if (/^[?&]/.test(filled)) return [{ id: 'append', url: url + (url.indexOf('?') >= 0 && filled.charAt(0) === '?' ? '&' + filled.substring(1) : filled) }];
                return [{ id: 'append', url: url + filled }];
            }
            return [{ id: 'source', url: filled }];
        }
        var flu = function () { return groupFlussonic(url, startSec, durSec); };
        var fts = function () { return groupFlussonicTs(url, startSec, durSec); };
        var sft = function () { return groupShift(url, startSec, durSec, nowSec); };
        var xc = function () { return groupXc(url, startSec, durSec, nowSec, devOffSec); };
        add(fromSource());
        if (type === 'flussonic' || type === 'fs') { add(flu()); add(fts()); }
        else if (type === 'flussonic-ts' || type === 'fs-ts') { add(fts()); add(flu()); }
        else if (type === 'shift' || type === 'timeshift') { add(sft()); }
        else if (type === 'xc' || type === 'xtream') { add(xc()); }
        // not told (or told a kind that did not work): what the stream address looks like, then the rest
        if (looksFlussonic(url)) { add(flu()); add(fts()); add(sft()); }
        else { add(sft()); add(flu()); add(fts()); }
        return out;
    }

    /* A recording is told from the live feed by what the answer says. 'good': a finished playlist (ENDLIST / VOD) or one
     * whose clock sits at the programme start. 'bad': not a playlist, or the live feed itself (the same segments as the live
     * link). 'weak': a playlist that cannot be told apart. liveSet = { segment name: 1 } of the live playlist, or null. */
    function segNames(body) {
        var out = {}, lines = String(body || '').split(/\r?\n/), i, t, q;
        for (i = 0; i < lines.length; i++) {
            t = lines[i].replace(/^\s+|\s+$/g, '');
            if (!t || t.charAt(0) === '#') continue;
            q = t.indexOf('?'); if (q >= 0) t = t.substring(0, q);
            out[t] = 1;
        }
        return out;
    }
    function judgePlaylist(body, startSec, nowSec, liveSet) {
        var t = String(body || '');
        if (!playlistLooksValid(t)) return 'bad';
        if (/#EXT-X-STREAM-INF/.test(t)) return 'master';
        if (liveSet) {
            var seg = segNames(t), k, n = 0, same = 0;
            for (k in seg) { if (seg.hasOwnProperty(k)) { n++; if (liveSet[k]) same++; } }
            if (n && same === n) return 'bad';
        }
        if (/#EXT-X-ENDLIST/.test(t) || /#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(t)) return 'good';
        var pdt = /#EXT-X-PROGRAM-DATE-TIME:\s*([^\r\n]+)/.exec(t);
        if (pdt) {
            var ms = Date.parse(pdt[1].replace(/^\s+|\s+$/g, ''));
            if (isFinite(ms)) {
                var d = Math.abs(ms / 1000 - startSec);
                if (d <= 20 * 60) return 'good';
                if (Math.abs(ms / 1000 - nowSec) <= 5 * 60) return 'bad';     // the clock is now: this is live
            }
        }
        return 'weak';
    }
    function absUrl(rel, base) {
        if (/^https?:\/\//i.test(rel)) return rel;
        var s = splitUrl(base);
        if (rel.charAt(0) === '/') { var m = /^(https?:\/\/[^\/]+)/i.exec(base); return (m ? m[1] : '') + rel; }
        return s.dir + rel;
    }
    function firstVariant(body, base) {
        var lines = String(body).split(/\r?\n/), i, t;
        for (i = 0; i < lines.length; i++) {
            t = lines[i].replace(/^\s+|\s+$/g, '');
            if (t && t.charAt(0) !== '#') {
                var u = absUrl(t, base);
                if (t.indexOf('?') < 0 && base.indexOf('?') >= 0) u += base.substring(base.indexOf('?'));
                return u;
            }
        }
        return '';
    }

    /* Which candidate plays this programme. io(url) -> Promise of { body } (rejects with { status } on failure);
     * remembered = the kind that worked before ('' if none). Resolves { url, id, how } or null when nothing answered.
     * how: 'good' | 'weak' | 'unknown' (the answers could not be read, e.g. blocked: the best guess is used). */
    function resolveM3U(ch, prog, io, nowMs, devOffSec, remembered) {
        var nowSec = Math.floor((nowMs || new Date().getTime()) / 1000);
        var dur = Math.max(60, Math.round(prog.stopTs - prog.startTs));
        var cands = m3uCandidates(ch, prog.startTs, dur, nowSec, devOffSec || 0);
        if (!cands.length) return Promise.resolve(null);
        if (remembered) {
            for (var r = 0; r < cands.length; r++) {
                if (cands[r].id === remembered) { var first = cands.splice(r, 1)[0]; cands.unshift(first); break; }
            }
        }
        // A kind that already played a recording for this source is used at once: no check of the live feed and no test
        // request, so the programme starts as fast as the provider answers (each check was a round trip before playback).
        if (remembered && cands[0].id === remembered) return Promise.resolve({ url: cands[0].url, id: cands[0].id, how: 'remembered' });
        var liveSet = null, weak = null, blocked = 0, idx = 0;
        function judgeOne(c) {
            return io(c.url).then(function (r) {
                var v = judgePlaylist(r && r.body, prog.startTs, nowSec, liveSet);
                if (v !== 'master') return v;
                var vu = firstVariant(r.body, c.url);
                if (!vu) return 'weak';
                return io(vu).then(function (r2) {
                    var v2 = judgePlaylist(r2 && r2.body, prog.startTs, nowSec, liveSet);
                    return v2 === 'master' ? 'weak' : v2;
                }, function () { return 'weak'; });
            });
        }
        function step() {
            if (idx >= cands.length) {
                if (weak) return { url: weak.url, id: weak.id, how: 'weak' };
                return blocked ? { url: cands[0].url, id: cands[0].id, how: 'unknown' } : null;
            }
            var c = cands[idx++];
            return judgeOne(c).then(function (v) {
                blocked = 0;
                if (v === 'good') return { url: c.url, id: c.id, how: 'good' };
                if (v === 'weak' && !weak) weak = c;
                return step();
            }, function (e) {
                // an answer such as 404 means this kind is not it; no answer at all (status 0) may mean the request is
                // blocked, and then asking more kinds would only wait longer: use the best guess
                if (e && e.status > 0) { blocked = 0; return step(); }
                blocked++;
                if (blocked >= 2 && !weak) return { url: cands[0].url, id: cands[0].id, how: 'unknown' };
                return step();
            });
        }
        // the live feed first, so a link that only returned the live feed is not taken for a recording
        return io(ch.url).then(function (r) { if (r && playlistLooksValid(r.body) && !/#EXT-X-STREAM-INF/.test(r.body)) liveSet = segNames(r.body); }, function () {}).then(step);
    }

    /* The object the player plays for a playlist programme. type stays 'm3u'; catchup marks it as a recording. */
    function makeM3uItem(ch, prog, url) {
        if (!url) return null;
        return {
            id: ch.id + ':cu:' + prog.startTs,
            name: (ch.name || '') + ' \u2013 ' + (prog.title || ''),
            url: url,
            logo: ch.logo || '',
            category: ch.category || '',
            tvgId: ch.tvgId || '',
            epgId: ch.epgId || '',
            number: ch.number || 0,
            playlistId: ch.playlistId,
            playlistName: ch.playlistName,
            type: 'm3u',
            catchup: { startTs: prog.startTs, stopTs: prog.stopTs, title: prog.title || '', channelId: ch.id }
        };
    }

    /* Day heading for the picker: 0 = today, 1 = yesterday, else the weekday and date. */
    function dayLabel(startMs, nowMs, T, localeFn) {
        var d = new Date(startMs), n = new Date(nowMs);
        var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var b = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
        var diff = Math.round((b - a) / 86400000);
        if (diff === 0) return T('cu_today');
        if (diff === 1) return T('cu_yesterday');
        if (localeFn) { try { return localeFn(d); } catch (e) {} }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    return {
        supports: supports,
        parseTable: parseTable,
        buildUrl: buildUrl,
        makeItem: makeItem,
        parseStalker: parseStalker,
        makeStalkerItem: makeStalkerItem,
        cached: cached,
        remember: remember,
        forget: forget,
        dayLabel: dayLabel,
        offsetFromServerInfo: offsetFromServerInfo,
        buildSlots: buildSlots,
        playlistLooksValid: playlistLooksValid,
        m3uCandidates: m3uCandidates,
        resolveM3U: resolveM3U,
        makeM3uItem: makeM3uItem,
        _judge: judgePlaylist,
        _fill: fillTemplate,
        isEmptyIn: isEmptyIn,
        markEmptyIn: markEmptyIn,
        unmarkEmptyIn: unmarkEmptyIn,
        pruneEmpty: pruneEmpty,
        _decodeText: decodeText,
        _clockText: clockText
    };
})();
