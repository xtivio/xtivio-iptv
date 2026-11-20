/* stalker-direct.js - the app talks to a Stalker / Ministra portal itself, as a MAG box does.
 *
 * This is the pairing server's stalker.js ported to the page: handshake, profile, categories, channel
 * lists (per category and the whole list), play links, the programme guide, movies, series and catch-up.
 * Every call answers in the same shape as the matching /api/stalker/<path> route, so api.js can use
 * either one. The requests go out through PortalNet (see portal-net.js), which can set the MAG headers.
 *
 * When it is used (StalkerDirect.usable): PortalNet exists on this platform, the Store setting
 * stalkerDirect is not false and the portal has not been handed to the server (see holdServer).
 *
 * When the server takes over: only when the portal could not be reached or did not give a usable answer
 * (error.fallback === true: network, timeout, no endpoint, unreadable or empty answers after retries).
 * A portal that answers and says no (credentials, blocked, link limit) is NOT retried on the server: it
 * would only get the same answer. After a fallback the portal stays on the server for HOLD_MS, because two
 * sessions for one MAC knock each other out on many portals.
 *
 * Identity: with no serial / device id given, a portal that answers the profile with a device conflict gets
 * the ids a MAG box derives from its MAC (MD5 / SHA-256 below), device id lower-case first, then upper-case,
 * exactly as the server does. */
var StalkerDirect = (function () {
    'use strict';

    var MAG_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
    var MAG_XUA = 'Model: MAG200; Link: WiFi';
    var REQUEST_TIMEOUT_MS = 12000;
    var SESSION_TTL_MS = 90 * 1000;
    var ORDERED_LIST_MAX_PAGES = 60;
    var ALL_MAX_BYTES = 80 * 1024 * 1024;
    var ALL_MAX_ITEMS = 150000;
    var ALL_IDLE_MS = 45000;
    var ALL_DEADLINE_MS = 240000;
    var EMPTY_RETRIES = 2;
    var EMPTY_PAUSE_MS = 700;
    var HOLD_MS = 10 * 60 * 1000;
    var EPG_BATCH_MAX = 60;
    var EPG_BATCH_CONCURRENCY = 5;

    var PATHS = {
        'genres': 1, 'probe': 1, 'channels': 1, 'channels/all': 1, 'resolve': 1, 'epg': 1, 'epg/batch': 1,
        'vod/categories': 1, 'vod/items': 1, 'vod/resolve': 1,
        'series/categories': 1, 'series/items': 1, 'series/seasons': 1, 'series/resolve': 1,
        'archive': 1, 'archive/resolve': 1
    };
    var CAT_KINDS_TTL_MS = 6 * 3600 * 1000;
    var ARCHIVE_MAX_DATES = 8, ARCHIVE_MAX_PAGES = 8, ARCHIVE_CONCURRENCY = 3;

    var sessions = {};      // portalKey -> { token, createdAt, profile, ttl }
    var inflight = {};      // portalKey -> Promise of the session being opened
    var endpoints = {};     // portalKey -> working endpoint URL
    var plainPortals = {};  // portalKey -> true: the profile is sent without ver / stb_type
    var plainTried = {};    // portalKey -> true: plain did not help
    var serverUntil = {};   // portalKey -> time (ms) until which the server handles this portal
    var derivedPortals = {}; // portalKey -> 'lower' | 'upper': derived ids in use (case of the device id)
    var derivedTried = {};  // portalKey -> true: derived ids did not help
    var vodSeriesMode = {}; // portalKey -> true | false: movies and series share the VOD list
    var vodCatKinds = {};   // portalKey -> { at, kinds } | { pending }

    /* ---- small helpers ---- */
    function E(message, code) { return { message: message, code: code }; }
    function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function str(v, max) { return (v == null ? '' : String(v)).slice(0, max); }
    function keyOf(pl) {
        return (pl.url || '').toLowerCase() + '|' + (pl.mac || '').toLowerCase() +
            (pl.stbModel ? '|' + String(pl.stbModel).toLowerCase() : '');
    }
    function originOf(url) {
        var m = /^(https?:\/\/[^\/?#]+)/i.exec(url || '');
        return m ? m[1] : '';
    }
    function refererFor(url) {
        var o = originOf(url);
        return o ? o + '/c/' : '';
    }
    function identityHeaders(pl) {
        var m = pl && pl.stbModel;
        if (!m) return {};
        return { 'User-Agent': MAG_UA.replace('MAG200', m), 'X-User-Agent': 'Model: ' + m + '; Link: WiFi' };
    }
    function magCookie(pl) {
        var c = 'mac=' + encodeURIComponent(pl.mac || '') + '; stb_lang=en; timezone=Europe/London';
        var ids = effectiveIds(pl);
        // Derived ids ride in the cookie too, as a real MAG box sends them.
        if (ids.derived) c += '; sn=' + encodeURIComponent(ids.serial) + '; device_id=' + encodeURIComponent(ids.deviceId) + '; device_id2=' + encodeURIComponent(ids.deviceId);
        return c;
    }
    function merge(a, b) {
        var o = {}, k;
        for (k in a) if (a.hasOwnProperty(k)) o[k] = a[k];
        for (k in b) if (b.hasOwnProperty(k)) o[k] = b[k];
        return o;
    }

    function endpointCandidates(portalUrl) {
        var m = /^(https?:\/\/[^\/?#]+)([^?#]*)/i.exec(portalUrl || '');
        if (!m) throw E('Invalid portal URL', 'portal');
        if (/(load|portal)\.php$/i.test(m[2])) return [portalUrl];
        return [m[1] + '/portal.php', m[1] + '/stalker_portal/server/load.php', m[1] + '/c/portal.php'];
    }

    /* ---- MD5 and SHA-256 (the page has no synchronous hash) ---- */
    function utf8Bytes(str) {
        var enc = unescape(encodeURIComponent(String(str)));
        var out = [];
        for (var i = 0; i < enc.length; i++) out.push(enc.charCodeAt(i) & 255);
        return out;
    }
    function hexWords(words, littleEndian) {
        var h = '';
        for (var i = 0; i < words.length; i++) {
            for (var b = 0; b < 4; b++) {
                var sh = littleEndian ? b * 8 : 24 - b * 8;
                h += ('0' + ((words[i] >>> sh) & 255).toString(16)).slice(-2);
            }
        }
        return h;
    }
    function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
    var MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    var MD5_K = [];
    (function () { for (var i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0; })();
    function md5Hex(str) {
        var bytes = utf8Bytes(str), n = bytes.length, i;
        bytes.push(128);
        while (bytes.length % 64 !== 56) bytes.push(0);
        var bits = n * 8;
        for (i = 0; i < 8; i++) bytes.push(i < 4 ? (bits >>> (i * 8)) & 255 : 0);
        var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
        for (var off = 0; off < bytes.length; off += 64) {
            var M = [];
            for (i = 0; i < 16; i++) M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
            var A = a0, B = b0, C = c0, D = d0;
            for (i = 0; i < 64; i++) {
                var F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; }
                else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                else { F = C ^ (B | ~D); g = (7 * i) % 16; }
                F = (F + A + MD5_K[i] + M[g]) | 0;
                A = D; D = C; C = B;
                B = (B + rol(F, MD5_S[(i >> 4) * 4 + (i % 4)])) | 0;
            }
            a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
        }
        return hexWords([a0, b0, c0, d0], true);
    }
    var SHA_K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    function ror(x, n) { return (x >>> n) | (x << (32 - n)); }
    function sha256Hex(str) {
        var bytes = utf8Bytes(str), n = bytes.length, i;
        bytes.push(128);
        while (bytes.length % 64 !== 56) bytes.push(0);
        var bits = n * 8;
        for (i = 0; i < 8; i++) bytes.push(i < 4 ? 0 : (bits >>> ((7 - i) * 8)) & 255);
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        for (var off = 0; off < bytes.length; off += 64) {
            var W = [];
            for (i = 0; i < 16; i++) W[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
            for (i = 16; i < 64; i++) {
                var s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
                var s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
                W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
            }
            var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (i = 0; i < 64; i++) {
                var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
                var ch = (e & f) ^ (~e & g);
                var t1 = (h + S1 + ch + SHA_K[i] + W[i]) | 0;
                var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
                var mj = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (S0 + mj) | 0;
                h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
        }
        return hexWords(H, false);
    }

    /* Identity a real MAG box derives from its MAC: serial = first 13 hex of md5(MAC upper-case), device id =
     * sha256(MAC upper-case). Used only after the portal answered the profile with a device conflict and no ids
     * were given (same rule as the server). */
    function deriveIds(mac, upper) {
        var m = String(mac || '').toUpperCase();
        var dev = sha256Hex(m);
        return { serial: md5Hex(m).slice(0, 13).toUpperCase(), deviceId: upper ? dev.toUpperCase() : dev };
    }
    function effectiveIds(pl) {
        if (pl.serial || pl.deviceId) return { serial: pl.serial || '', deviceId: pl.deviceId || '', derived: false };
        var mode = derivedPortals[keyOf(pl)];
        if (mode) {
            var d = deriveIds(pl.mac, mode === 'upper');
            return { serial: d.serial, deviceId: d.deviceId, derived: true };
        }
        return { serial: '', deviceId: '', derived: false };
    }

    /* ---- one request ---- */
    function netErr(e) {
        if (e && typeof e.err === 'string') {
            if (e.err === 'timeout') { var te = E('Portal timeout', 'network'); te.timeout = true; return te; }
            if (e.err === 'too-large' || e.err === 'stopped') return E('Portal response too large', 'bad_response');
            return E('Network error', 'network');
        }
        return e;
    }
    function httpGet(url, headers) {
        var h = merge({ 'User-Agent': MAG_UA, 'X-User-Agent': MAG_XUA, 'Accept': '*/*', 'Accept-Encoding': 'identity' }, headers || {});
        return PortalNet.get(url, h, { timeoutMs: REQUEST_TIMEOUT_MS }).then(null, function (e) { throw netErr(e); });
    }
    function authHeaders(pl, token) {
        return merge({ 'Cookie': magCookie(pl), 'Referer': refererFor(pl.url), 'Authorization': 'Bearer ' + token }, identityHeaders(pl));
    }
    var AUTH_TEXT = /^\s*(authori[sz]ation (failed|required)|not authori[sz]ed|access denied)\b/i;

    /* One answer -> its js payload. An empty body is its own error (code 'empty'): some portals answer a
     * request with HTTP 200 and nothing at all, and asking again usually works. */
    function parseJs(resp) {
        if (resp.status === 401 || resp.status === 403) throw E('Portal rejected credentials', 'auth');
        if (resp.status < 200 || resp.status >= 300) throw E('Portal HTTP ' + resp.status, 'portal');
        var body = resp.body || '';
        if (AUTH_TEXT.test(body)) throw E('Portal rejected the session token', 'auth');
        if (!/\S/.test(body)) throw E('Portal answered with an empty body', 'empty');
        var data;
        try { data = JSON.parse(body); }
        catch (e) { throw E('Portal returned non-JSON', 'bad_response'); }
        if (data && typeof data === 'object' && 'js' in data) return data.js;
        return data;
    }

    /* ---- session ---- */
    function handshake(pl, key) {
        var known = endpoints[key];
        var candidates = known ? [known] : endpointCandidates(pl.url);
        function tryNext(i) {
            if (i >= candidates.length) throw E('No portal endpoint responded with a token', 'portal');
            var base = candidates[i];
            var url = base + '?type=stb&action=handshake&token=&JsHttpRequest=1-xml';
            return httpGet(url, merge({ 'Cookie': magCookie(pl), 'Referer': refererFor(pl.url) }, identityHeaders(pl)))
                .then(function (resp) {
                    if (resp.status === 404) return tryNext(i + 1);
                    var js;
                    try { js = parseJs(resp); } catch (e) { return tryNext(i + 1); }
                    var token = js && js.token;
                    if (!token) return tryNext(i + 1);
                    endpoints[key] = base;
                    return token;
                }, function (err) {
                    // A portal that does not answer at all will not answer on the next path either: give up at once
                    // (the server is tried instead) rather than wait out the timeout three times.
                    if (err && err.timeout) throw err;
                    if (i + 1 < candidates.length) return tryNext(i + 1);
                    throw err;
                });
        }
        return Promise.resolve().then(function () { return tryNext(0); });
    }

    /* The profile call. An empty body gives { __emptyBody: true } so the session logic can ask again. */
    function getProfile(pl, key, token) {
        var plain = !!plainPortals[key];
        var ids = effectiveIds(pl);
        var params = [
            'type=stb', 'action=get_profile', 'hd=1',
            'sn=' + encodeURIComponent(ids.serial),
            'device_id=' + encodeURIComponent(ids.deviceId),
            'device_id2=' + encodeURIComponent(ids.deviceId),
            'mac=' + encodeURIComponent(pl.mac || '')
        ];
        if (!plain) params.push('ver=ImageDescription:%200.2.18-r14;%20ImageDate:%20Fri%20Jan%2015;%20api%20ver:%20js;');
        params.push('JsHttpRequest=1-xml');
        if (pl.stbModel && !plain) params.splice(3, 0, 'stb_type=' + encodeURIComponent(pl.stbModel));
        var url = endpoints[key] + '?' + params.join('&');
        return httpGet(url, authHeaders(pl, token)).then(function (resp) {
            try { return parseJs(resp); }
            catch (e) {
                if (e && e.code === 'empty') return { __emptyBody: true };
                throw e;
            }
        });
    }

    function profileBlock(profile) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
        var st = Number(profile.status);
        var msg = String(profile.msg || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        if (!(st > 0) || !msg || profile.id) return null;
        var extra = String(profile.block_msg || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        return {
            msg: (msg + (extra ? ' - ' + extra : '')).slice(0, 200),
            conflict: /serial|device/i.test(msg) && /mismatch|conflict/i.test(msg)
        };
    }
    function profileEmpty(profile) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
        return !profile.id && Number(profile.status) > 0 && !profileBlock(profile);
    }
    function profileDegraded(profile) {
        return !!(profile && typeof profile === 'object' && profile.id && Number(profile.status) > 0 && !profileBlock(profile));
    }
    function sessionTtl(profile) {
        var wd = profile && Number(profile.watchdog_timeout);
        if (!(wd > 0)) return SESSION_TTL_MS;
        return Math.max(30000, Math.min(180000, Math.round(wd * 750)));
    }

    /* handshake + profile; an empty profile answer is asked for again (EMPTY_RETRIES times) before giving up. */
    function open(pl, key, left) {
        return handshake(pl, key).then(function (token) {
            return getProfile(pl, key, token).then(function (profile) { return { token: token, profile: profile }; });
        }).then(function (r) {
            if (!(r.profile && r.profile.__emptyBody)) return r;
            if (left > 0) return delay(EMPTY_PAUSE_MS).then(function () { return open(pl, key, left - 1); });
            throw E('Portal answered the profile with nothing', 'empty');
        });
    }
    function openFresh(pl, key) { return open(pl, key, EMPTY_RETRIES); }

    function openSession(pl, key) {
        return openFresh(pl, key).then(function (r) {
            if (profileEmpty(r.profile) && !plainPortals[key] && !plainTried[key]) {
                // Empty profile with status > 0 and no message: try the plain request once; keep it only if it works.
                plainPortals[key] = true;
                return openFresh(pl, key).then(function (r2) {
                    if (!profileEmpty(r2.profile)) return r2;
                    delete plainPortals[key];
                    plainTried[key] = true;
                    return openFresh(pl, key);
                }, function () {
                    delete plainPortals[key];
                    plainTried[key] = true;
                    return openFresh(pl, key);
                });
            }
            return r;
        }).then(function (r) {
            var blocked = profileBlock(r.profile);
            var noIds = !pl.serial && !pl.deviceId && !derivedPortals[key] && !derivedTried[key];
            if (noIds && ((blocked && blocked.conflict) || profileDegraded(r.profile))) {
                // Device conflict, or a profile the portal marks status > 0, with no ids given: ask again as a MAG box
                // would, with ids derived from the MAC (device id lower-case, then upper-case after another conflict).
                // The new handshake replaces the first token on many portals, so the retry's answer is the one to use.
                // The derived identity is kept for this portal only if the portal accepts it.
                var giveUp = function (rx) {
                    delete derivedPortals[key];
                    derivedTried[key] = true;
                    if (rx && !profileBlock(rx.profile)) return rx;
                    return openFresh(pl, key);
                };
                derivedPortals[key] = 'lower';
                return openFresh(pl, key).then(function (r2) {
                    if (!profileBlock(r2.profile) && !profileDegraded(r2.profile)) return r2;
                    var b2 = profileBlock(r2.profile);
                    if (b2 && b2.conflict) {
                        derivedPortals[key] = 'upper';
                        return openFresh(pl, key).then(function (r3) {
                            if (!profileBlock(r3.profile) && !profileDegraded(r3.profile)) return r3;
                            return giveUp(r3);
                        }, function () { return giveUp(null); });
                    }
                    return giveUp(r2);
                }, function (err) {
                    delete derivedPortals[key];
                    derivedTried[key] = true;
                    if (blocked) throw err;
                    return openFresh(pl, key);
                });
            }
            return r;
        }).then(function (r) {
            var blocked2 = profileBlock(r.profile);
            if (blocked2) throw E(blocked2.msg, 'blocked');
            var sess = { token: r.token, createdAt: Date.now(), profile: r.profile, ttl: sessionTtl(r.profile) };
            sessions[key] = sess;
            return sess;
        });
    }

    /* One session per portal at a time: concurrent calls share a single handshake (a second one would replace the first token on many portals). */
    function getSession(pl, forceNew, staleToken) {
        var key = keyOf(pl);
        var cached = sessions[key];
        var fresh = cached && (Date.now() - cached.createdAt) < (cached.ttl || SESSION_TTL_MS);
        if (fresh && !forceNew) return Promise.resolve(cached);
        if (forceNew && staleToken && fresh && cached.token !== staleToken) return Promise.resolve(cached);
        if (inflight[key]) return inflight[key];
        var p = openSession(pl, key);
        inflight[key] = p;
        var done = function () { if (inflight[key] === p) delete inflight[key]; };
        p.then(done, done);
        return p;
    }

    function withSession(pl, fn) {
        return getSession(pl).then(function (sess) {
            return fn(sess).then(null, function (err) {
                if (err && err.code === 'auth') {
                    return getSession(pl, true, sess.token).then(fn);
                }
                if (err && err.code === 'empty') {
                    return delay(EMPTY_PAUSE_MS).then(function () { return getSession(pl, true, sess.token); }).then(fn);
                }
                throw err;
            });
        });
    }

    function call(pl, sess, query) {
        return httpGet(endpoints[keyOf(pl)] + '?' + query + '&JsHttpRequest=1-xml', authHeaders(pl, sess.token)).then(parseJs);
    }

    /* ---- categories and channels ---- */
    function genreList(pl) {
        return withSession(pl, function (sess) {
            return call(pl, sess, 'type=itv&action=get_genres').then(function (js) {
                if (!Array.isArray(js)) return { genres: [] };
                var out = [];
                for (var i = 0; i < js.length; i++) {
                    var g = js[i];
                    out.push({ id: String(g.id), title: g.title || g.name || ('Genre ' + g.id) });
                }
                return { genres: out };
            });
        });
    }

    function mapChannel(c) {
        return {
            id: String(c.id),
            name: c.name || c.title || ('Channel ' + c.id),
            number: c.number || '',
            genreId: String(c.tv_genre_id || c.genre_id || ''),
            logo: c.logo || '',
            cmd: c.cmd || '',
            archive: !!(c.tv_archive || c.enable_tv_archive),
            archiveHours: (c.tv_archive || c.enable_tv_archive) && Number(c.tv_archive_duration) > 0 ? Math.round(Number(c.tv_archive_duration)) : 0,
            xmltvId: c.xmltv_id || c.epg_id || ''
        };
    }

    function orderedListPage(pl, sess, genre, page) {
        return call(pl, sess, 'type=itv&action=get_ordered_list&genre=' + encodeURIComponent(genre) + '&p=' + page);
    }

    function genreChannels(pl, genreId, maxPages, startPage) {
        return withSession(pl, function (sess) {
            var out = [];
            var cap = maxPages || ORDERED_LIST_MAX_PAGES;
            var first = startPage && startPage > 0 ? startPage : 1;
            function pull(page) {
                return orderedListPage(pl, sess, genreId || '*', page).then(function (js) {
                    var data = (js && js.data) || [];
                    for (var i = 0; i < data.length; i++) out.push(mapChannel(data[i]));
                    var total = (js && parseInt(js.total_items, 10)) || out.length;
                    var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                    var maxPage = Math.ceil(total / perPage);
                    if (page < maxPage && (page - first + 1) < cap && data.length > 0) return pull(page + 1);
                    var more = page < maxPage && data.length > 0;
                    return { channels: out, total: total, fetchedPages: page, totalPages: maxPage, startPage: first, nextPage: more ? page + 1 : null };
                });
            }
            return pull(first);
        });
    }

    /* Incremental scanner for one big JSON array of objects (same logic as the server's): onElement(objectText)
     * for every complete top-level object, so only one element is ever held as text. */
    function createArrayScanner(onElement) {
        var depth = 0, inStr = false, esc = false;
        var arrStarted = false, arrDepth = 0, arrCount = 0, finished = false;
        var capturing = false, buf = '';
        return {
            push: function (s) {
                if (finished) return;
                var segStart = 0;
                for (var i = 0; i < s.length; i++) {
                    var c = s.charCodeAt(i);
                    if (inStr) {
                        if (esc) esc = false;
                        else if (c === 92) esc = true;
                        else if (c === 34) inStr = false;
                        continue;
                    }
                    if (c === 34) { inStr = true; continue; }
                    if (c === 123) {
                        depth++;
                        if (arrStarted && !capturing && depth === arrDepth + 1) { capturing = true; segStart = i; buf = ''; }
                    } else if (c === 125) {
                        if (capturing && depth === arrDepth + 1) {
                            capturing = false;
                            var text = buf + s.slice(segStart, i + 1);
                            buf = '';
                            arrCount++;
                            onElement(text);
                        }
                        depth--;
                    } else if (c === 91) {
                        depth++;
                        if (!arrStarted && depth <= 3) { arrStarted = true; arrDepth = depth; arrCount = 0; }
                    } else if (c === 93) {
                        if (arrStarted && depth === arrDepth) {
                            if (arrCount === 0) arrStarted = false;
                            else { finished = true; return; }
                        }
                        depth--;
                    }
                }
                if (capturing) buf += s.slice(segStart);
            }
        };
    }

    /* The whole portal list in one request (get_all_channels), read piece by piece. */
    function allChannels(pl) {
        return withSession(pl, function (sess) {
            var out = [], count = 0, head = '';
            var scanner = createArrayScanner(function (text) {
                var c;
                try { c = JSON.parse(text); } catch (e) { return; }
                if (!c || typeof c !== 'object' || c.id == null) return;
                count++;
                out.push(mapChannel(c));
            });
            var url = endpoints[keyOf(pl)] + '?type=itv&action=get_all_channels&JsHttpRequest=1-xml';
            var h = merge({ 'User-Agent': MAG_UA, 'X-User-Agent': MAG_XUA, 'Accept': '*/*', 'Accept-Encoding': 'identity' }, authHeaders(pl, sess.token));
            return PortalNet.stream(url, h, function (chunk) {
                if (head.length < 160) head += chunk.slice(0, 160 - head.length);
                if (count > ALL_MAX_ITEMS) return false;
                scanner.push(chunk);
                return true;
            }, { timeoutMs: ALL_IDLE_MS, maxBytes: ALL_MAX_BYTES, deadlineMs: ALL_DEADLINE_MS }).then(function (r) {
                if (r.status === 401 || r.status === 403) throw E('Portal rejected credentials', 'auth');
                if (r.status < 200 || r.status >= 300) throw E('Portal HTTP ' + r.status, 'portal');
                if (!count) {
                    if (AUTH_TEXT.test(head)) throw E('Portal rejected the session token', 'auth');
                    return { channels: [], total: 0, complete: false, unsupported: true };
                }
                return { channels: out, total: count, complete: true };
            }, function (e) { throw netErr(e); });
        });
    }

    /* ---- play links ---- */
    var LINK_ERRORS = {
        limit: ['limit', 'Portal connection limit reached for this account'],
        nothing_to_play: ['nothing', 'Portal has nothing to play for this item'],
        link_fault: ['link', 'Portal could not create a link for this item'],
        access_denied: ['denied', 'Portal denied access to this item']
    };

    /* The http(s) URL inside a cmd ("ffmpeg http://..."), or '' when there is none or it is a placeholder. */
    function extractStreamUrl(cmd) {
        if (!cmd) return '';
        var m = String(cmd).match(/https?:\/\/\S+/);
        if (!m) return '';
        var url = m[0];
        var hm = /^https?:\/\/(\[[^\]]*\]|[^\/:?#]+)/i.exec(url);
        var host = hm ? hm[1].toLowerCase() : '';
        if (!host) return '';
        if (/^(localhost|0\.0\.0\.0|\[::1?\]|::1?)$/.test(host) || /^127\./.test(host) || /\.localhost$/.test(host)) return '';
        if (/[?&]stream=(&|$)/.test(url)) return '';
        return url;
    }

    function linkFromJs(js, failMsg) {
        var list = Array.isArray(js) ? js : [js];
        var url = '', err = '';
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it || typeof it !== 'object') continue;
            if (it.error && !err) err = String(it.error);
            if (String(it.type || '').toLowerCase() === 'ad') continue;
            var u = extractStreamUrl(it.cmd || it.url || '');
            if (u) url = u;
        }
        if (url) return url;
        if (err) {
            var known = LINK_ERRORS[err.toLowerCase()];
            if (known) throw E(known[1], known[0]);
            throw E('Portal error: ' + err.replace(/[^\w .:-]/g, '').slice(0, 60), 'link');
        }
        throw E(failMsg || 'Portal did not return a stream link', 'bad_response');
    }

    function createLink(pl, sess, cmd) {
        return call(pl, sess, 'type=itv&action=create_link&cmd=' + encodeURIComponent(cmd || '')).then(function (js) {
            return { url: linkFromJs(js, 'Portal did not return a stream link'), via: 'create_link' };
        });
    }

    function freshCmdForChannel(pl, sess, channelId, genreId) {
        var want = String(channelId);
        var genre = genreId || '*';
        function pull(page) {
            return orderedListPage(pl, sess, genre, page).then(function (js) {
                var data = (js && js.data) || [];
                for (var i = 0; i < data.length; i++) {
                    if (String(data[i].id) === want) return data[i].cmd || '';
                }
                var total = (js && parseInt(js.total_items, 10)) || 0;
                var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                var maxPage = Math.ceil(total / perPage);
                if (page < maxPage && page < ORDERED_LIST_MAX_PAGES && data.length > 0) return pull(page + 1);
                return '';
            });
        }
        return pull(1);
    }

    function freshLink(pl, cmd, channelId, genreId) {
        return withSession(pl, function (sess) {
            function viaList(firstErr) {
                if (!channelId) throw firstErr;
                return freshCmdForChannel(pl, sess, channelId, genreId).then(function (useCmd) {
                    var u = extractStreamUrl(useCmd);
                    if (u) return { url: u, via: 'cmd-refetch' };
                    throw firstErr;
                });
            }
            if (!cmd) return Promise.resolve().then(function () { return viaList(E('Portal did not return a stream link', 'bad_response')); });
            return createLink(pl, sess, cmd).then(null, function (e) {
                if (e && e.code === 'auth') throw e;
                return viaList(e);
            });
        });
    }

    function resolveLink(pl, cmd, channelId, genreId, fresh) {
        // A saved cmd that already holds a real stream URL needs no portal call at all.
        var saved = extractStreamUrl(cmd);
        if (saved && !fresh) return Promise.resolve({ url: saved, via: 'cmd' });
        if (fresh) return freshLink(pl, cmd, channelId, genreId);
        return withSession(pl, function (sess) {
            if (channelId && cmd) {
                // Ask for the link with the entry we have, as a MAG box does: one request. Looking the channel up again
                // costs one portal request per list page (3-5 s on a big portal from a phone), so that is only done when
                // the portal could not make a link from this entry.
                return createLink(pl, sess, cmd).then(null, function (e) {
                    var c = e && e.code;
                    if (c === 'auth' || c === 'empty' || c === 'network' || c === 'limit') throw e;
                    return freshCmdForChannel(pl, sess, channelId, genreId).then(function (useCmd) {
                        var u = extractStreamUrl(useCmd);
                        if (u) return { url: u, via: 'cmd-refetch' };
                        if (useCmd && useCmd !== cmd) return createLink(pl, sess, useCmd);
                        throw e;
                    });
                });
            }
            if (channelId) {
                return freshCmdForChannel(pl, sess, channelId, genreId).then(function (useCmd) {
                    var u = extractStreamUrl(useCmd);
                    if (u) return { url: u, via: 'cmd-refetch' };
                    return createLink(pl, sess, useCmd || cmd);
                });
            }
            return createLink(pl, sess, cmd);
        });
    }

    /* ---- programme guide (now / next) ---- */
    function epgOne(pl, sess, channelId) {
        return call(pl, sess, 'type=itv&action=get_short_epg&ch_id=' + encodeURIComponent(channelId) + '&size=4').then(function (js) {
            if (!Array.isArray(js)) return [];
            var out = [];
            for (var i = 0; i < js.length; i++) {
                var e = js[i];
                out.push({
                    title: e.name || e.t_title || '',
                    start: e.start_timestamp || e.start || 0,
                    stop: e.stop_timestamp || e.stop || 0,
                    desc: e.descr || ''
                });
            }
            return out;
        });
    }

    function epgBatch(pl, channelIds) {
        var ids = [];
        var src = Array.isArray(channelIds) ? channelIds : [];
        for (var i = 0; i < src.length && ids.length < EPG_BATCH_MAX; i++) ids.push(String(src[i]).slice(0, 32));
        if (!ids.length) return Promise.resolve({ epg: {}, actionFailed: false });

        function runRound(sess, list) {
            var out = {}, failed = {}, next = 0, authAborted = false;
            function worker() {
                if (authAborted || next >= list.length) return Promise.resolve();
                var id = list[next++];
                return epgOne(pl, sess, id).then(function (l) { out[id] = l; }, function (err) {
                    if (err && err.code === 'auth') { authAborted = true; return; }
                    out[id] = [];
                    failed[id] = true;
                }).then(worker);
            }
            var workers = [];
            var n = Math.min(EPG_BATCH_CONCURRENCY, list.length);
            for (var w = 0; w < n; w++) workers.push(worker());
            return Promise.all(workers).then(function () { return { out: out, failed: failed, authAborted: authAborted }; });
        }

        return withSession(pl, function (sess) {
            return runRound(sess, ids).then(function (r1) {
                if (!r1.authAborted) return r1;
                var remaining = [];
                for (var k = 0; k < ids.length; k++) if (!r1.out.hasOwnProperty(ids[k])) remaining.push(ids[k]);
                if (!remaining.length) return r1;
                return getSession(pl, true, sess.token).then(function (sess2) {
                    return runRound(sess2, remaining).then(function (r2) {
                        return { out: merge(r1.out, r2.out), failed: merge(r1.failed, r2.failed), authAborted: false };
                    });
                });
            });
        }).then(function (result) {
            var all = true;
            for (var j = 0; j < ids.length; j++) if (!result.failed[ids[j]]) { all = false; break; }
            return { epg: result.out, actionFailed: all };
        });
    }

    /* ---- movies (VOD) ----
     * The list cmd is a base64 blob, not a playable address, so a movie always goes through create_link
     * (type=vod). Containers (movie -> seasons -> episodes -> files) are opened down to a file. */
    function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
    function rowKind(v) {
        if (truthy(v.is_file)) return 'file';
        if (truthy(v.is_episode)) return 'episode';
        if (truthy(v.is_season)) return 'season';
        if (truthy(v.is_series)) return 'series';
        return 'movie';
    }
    function openParamFor(kind) {
        return kind === 'season' ? 'season_id' : kind === 'episode' ? 'episode_id' : 'movie_id';
    }

    /* Poster paths come relative on some portals: make them absolute with the portal address. */
    function absLogo(pl, p) {
        if (!p || typeof p !== 'string') return '';
        if (/^https?:\/\//i.test(p)) return p;
        var base = endpoints[keyOf(pl)] || pl.url || '';
        var origin = originOf(base);
        if (!origin) return p;
        if (p.indexOf('//') === 0) return (/^https/i.test(base) ? 'https:' : 'http:') + p;
        var path;
        if (p.charAt(0) === '/') path = p;
        else {
            var dir = base.replace(/[?#].*$/, '').slice(origin.length);
            dir = dir.slice(0, dir.lastIndexOf('/') + 1) || '/';
            path = dir + p;
        }
        var prev;
        do { prev = path; path = path.replace(/\/\.\//g, '/').replace(/\/[^\/]+\/\.\.\//, '/'); } while (path !== prev);
        return origin + path;
    }

    /* One page-walk over type=vod get_ordered_list with arbitrary query text (category=, movie_id=, ...). */
    function vodList(pl, sess, query, maxPages) {
        var cap = maxPages || ORDERED_LIST_MAX_PAGES;
        var rows = [];
        function pull(page) {
            return call(pl, sess, 'type=vod&action=get_ordered_list&' + query + '&p=' + page).then(function (js) {
                var data = (js && Array.isArray(js.data)) ? js.data : [];
                for (var i = 0; i < data.length; i++) rows.push(data[i]);
                var total = (js && parseInt(js.total_items, 10)) || rows.length;
                var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                var maxPage = Math.ceil(total / perPage);
                if (page < maxPage && page < cap && data.length > 0) return pull(page + 1);
                return { rows: rows, total: total };
            });
        }
        return pull(1);
    }
    /* Containers are listed with the last id alone on some portals, with all ids walked so far on others:
     * the forms are tried in order; the first one with rows wins, an error (not auth) moves on. */
    function vodListAny(pl, sess, queries, maxPages) {
        var i = 0;
        function next() {
            if (i >= queries.length) return Promise.resolve({ rows: [], total: 0 });
            return vodList(pl, sess, queries[i++], maxPages).then(
                function (r) { return r.rows.length ? r : next(); },
                function (e) { if (e && e.code === 'auth') throw e; return next(); }
            );
        }
        return next();
    }
    function chainQueries(ctx, param, id) {
        var own = param + '=' + encodeURIComponent(id);
        var q = [own];
        if (ctx && ctx.length) q.push(ctx.join('&') + '&' + own);
        return q;
    }

    /* In vod-series mode only the rows say whether a category holds movies or series: look at the first page of
     * every category once (6 at a time, one flight per portal, remembered for 6 h). */
    function vodCategoryKinds(pl, sess, cats) {
        var key = keyOf(pl);
        var hit = vodCatKinds[key];
        if (hit && hit.kinds && Date.now() - hit.at < CAT_KINDS_TTL_MS) return Promise.resolve(hit.kinds);
        if (hit && hit.pending) return hit.pending;
        var kinds = {};
        var next = 0;
        function worker() {
            if (next >= cats.length) return Promise.resolve();
            var c = cats[next++];
            if (String(c.id) === '*') { kinds['*'] = 'both'; return worker(); }
            return vodList(pl, sess, 'category=' + encodeURIComponent(c.id), 1).then(function (r) {
                var ns = 0, nm = 0;
                for (var i = 0; i < r.rows.length; i++) { if (rowKind(r.rows[i]) === 'series') ns++; else nm++; }
                kinds[c.id] = (ns && !nm) ? 'series' : (nm && !ns) ? 'movies' : 'both';
            }, function (e) { if (e && e.code === 'auth') throw e; kinds[c.id] = 'both'; }).then(worker);
        }
        var pending = Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(
            function () { vodCatKinds[key] = { at: Date.now(), kinds: kinds }; return kinds; },
            function (e) { delete vodCatKinds[key]; throw e; }
        );
        vodCatKinds[key] = { pending: pending };
        return pending;
    }

    /* Some portals have no type=series: movies and series share the VOD list and only the rows' is_series flag
     * tells them apart. Detected once per portal. */
    function detectVodSeries(pl, sess, seriesCatsJs) {
        var key = keyOf(pl);
        if (vodSeriesMode.hasOwnProperty(key)) return Promise.resolve(vodSeriesMode[key]);
        if (Array.isArray(seriesCatsJs) && seriesCatsJs.length) { vodSeriesMode[key] = false; return Promise.resolve(false); }
        function look(page) {
            return call(pl, sess, 'type=vod&action=get_ordered_list&category=*&p=' + page).then(function (js) {
                var data = (js && Array.isArray(js.data)) ? js.data : [];
                for (var i = 0; i < data.length; i++) if (truthy(data[i].is_series)) return true;
                if (page < 3 && data.length > 0) return look(page + 1);
                return false;
            });
        }
        return look(1).then(function (yes) { vodSeriesMode[key] = yes; return yes; });
    }
    function isVodSeriesMode(pl, sess) {
        var key = keyOf(pl);
        if (vodSeriesMode.hasOwnProperty(key)) return Promise.resolve(vodSeriesMode[key]);
        return call(pl, sess, 'type=series&action=get_categories').then(
            function (js) { return detectVodSeries(pl, sess, js); },
            function (e) { if (e && e.code === 'auth') throw e; return false; }   // no verdict: do not remember
        );
    }

    /* A season's cmd in vod-series mode ('xv1:' + base64 of JSON, the same text the server makes). */
    function encodeVodCmd(obj) {
        return 'xv1:' + btoa(encodeURIComponent(JSON.stringify(obj)).replace(/%([0-9A-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }));
    }
    function decodeVodCmd(cmd) {
        if (!/^xv1:/.test(String(cmd || ''))) return null;
        try {
            var bin = atob(String(cmd).slice(4)), enc = '';
            for (var i = 0; i < bin.length; i++) enc += '%' + ('0' + bin.charCodeAt(i).toString(16)).slice(-2);
            var o = JSON.parse(decodeURIComponent(enc));
            return o && o.id ? o : null;
        } catch (e) { return null; }
    }

    function categoriesOf(js) {
        var out = [];
        for (var i = 0; i < js.length; i++) out.push({ id: String(js[i].id), title: js[i].title || js[i].name || ('Category ' + js[i].id) });
        return out;
    }

    function vodCategories(pl) {
        return withSession(pl, function (sess) {
            return call(pl, sess, 'type=vod&action=get_categories').then(function (js) {
                if (!Array.isArray(js)) return { categories: [] };
                var cats = categoriesOf(js);
                // Movies and series share the portal's categories: keep only those that hold movies.
                return isVodSeriesMode(pl, sess).then(function (split) {
                    if (!split) return { categories: cats };
                    return vodCategoryKinds(pl, sess, cats).then(function (kinds) {
                        var keep = [];
                        for (var i = 0; i < cats.length; i++) if (kinds[cats[i].id] !== 'series') keep.push(cats[i]);
                        return { categories: keep };
                    });
                });
            });
        });
    }

    function vodItems(pl, categoryId, maxPages) {
        return withSession(pl, function (sess) {
            return isVodSeriesMode(pl, sess).then(function (splitSeries) {
                var cap = maxPages || ORDERED_LIST_MAX_PAGES;
                var out = [];
                function pull(page) {
                    return call(pl, sess, 'type=vod&action=get_ordered_list&category=' + encodeURIComponent(categoryId || '*') + '&p=' + page).then(function (js) {
                        var data = (js && js.data) || [];
                        for (var i = 0; i < data.length; i++) {
                            var v = data[i];
                            // Portals that share one list for movies and series: series rows belong to the Series tab.
                            if (splitSeries && rowKind(v) === 'series') continue;
                            out.push({
                                id: String(v.id),
                                name: v.name || v.title || ('Movie ' + v.id),
                                kind: rowKind(v),
                                hasFiles: parseInt(v.has_files, 10) || 0,
                                cmd: v.cmd || '',
                                logo: absLogo(pl, v.screenshot_uri || v.poster || v.cover),
                                year: v.year || '',
                                rating: v.rating_imdb || v.rating_kinopoisk || '',
                                plot: v.description || v.plot || '',
                                added: v.added || ''
                            });
                        }
                        var total = (js && parseInt(js.total_items, 10)) || out.length;
                        var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                        var maxPage = Math.ceil(total / perPage);
                        if (page < maxPage && page < cap && data.length > 0) return pull(page + 1);
                        return { items: out, total: total, fetchedPages: page, totalPages: maxPage };
                    });
                }
                return pull(1);
            });
        });
    }

    function createVodLink(pl, sess, cmd, episodeNum) {
        return call(pl, sess, 'type=vod&action=create_link&cmd=' + encodeURIComponent(cmd) +
            (episodeNum ? '&series=' + encodeURIComponent(episodeNum) : '')).then(function (js) {
            return linkFromJs(js, 'Portal did not return a VOD link');
        });
    }

    /* A file row is played with create_link on /media/file_<its own id>.mpg (the address it carries is refused
     * when opened directly). Its own cmd and then the raw address are last resorts. */
    function fileUrlOf(row) { return extractStreamUrl(row.cmd) || extractStreamUrl(row.url); }
    function fileLink(pl, sess, row, via) {
        return createVodLink(pl, sess, '/media/file_' + row.id + '.mpg').then(function (u) { return { url: u, via: via }; }, function (e1) {
            if (e1 && (e1.code === 'limit' || e1.code === 'denied')) throw e1;
            var again = row.cmd ? createVodLink(pl, sess, row.cmd) : Promise.reject(e1);
            return again.then(function (u) { return { url: u, via: via + '_cmd' }; }, function () {
                var direct = fileUrlOf(row);
                if (direct) return { url: direct, via: 'file_url' };
                throw e1;
            });
        });
    }

    /* Episodes list newest first on this kind of portal. Number them by series_number, ascending. */
    function sortEpisodes(rows) {
        var a = rows.slice(), i;
        var nums = [];
        for (i = 0; i < a.length; i++) nums.push(parseInt(a[i].series_number, 10));
        if (!a.length) return a;
        for (i = 0; i < nums.length; i++) if (!nums[i] || nums[i] < 1) return a;
        var seen = {};
        for (i = 0; i < nums.length; i++) { if (seen[nums[i]]) return a; seen[nums[i]] = 1; }
        a.sort(function (x, y) { return parseInt(x.series_number, 10) - parseInt(y.series_number, 10); });
        return a;
    }
    function hasNums(rows) {
        var seen = {};
        for (var i = 0; i < rows.length; i++) {
            var n = parseInt(rows[i].series_number, 10);
            if (!n || n < 1 || seen[n]) return false;
            seen[n] = 1;
        }
        return rows.length > 0;
    }
    function episodeNumbers(rows) {
        var out = [];
        var useNums = hasNums(rows);
        var a = sortEpisodes(rows);
        for (var i = 0; i < a.length && i < 500; i++) out.push(useNums ? parseInt(a[i].series_number, 10) : i + 1);
        return out;
    }
    function pickEpisode(rows, ep) {
        var a = sortEpisodes(rows);
        if (hasNums(rows)) {
            for (var i = 0; i < a.length; i++) if (parseInt(a[i].series_number, 10) === ep) return a[i];
            return null;
        }
        return a[ep - 1] || null;
    }

    function walkToFile(pl, sess, param, id, depth, ctx) {
        if (depth > 4) return Promise.reject(E('Portal has nothing to play for this item', 'nothing'));
        return vodListAny(pl, sess, chainQueries(ctx, param, id), 3).then(function (r) {
            var rows = r.rows;
            if (!rows.length) throw E('Portal has nothing to play for this item', 'nothing');
            var pick = null;
            for (var i = 0; i < rows.length && !pick; i++) if (rowKind(rows[i]) === 'file' && (rows[i].cmd || rows[i].url)) pick = rows[i];
            if (!pick) pick = rows[0];
            var kind = rowKind(pick);
            var hasFlags = truthy(pick.is_file) || truthy(pick.is_episode) || truthy(pick.is_season);
            if (kind === 'file' || (!hasFlags && pick.cmd)) return fileLink(pl, sess, pick, 'create_link_file');
            var own = param + '=' + encodeURIComponent(id);
            return walkToFile(pl, sess, openParamFor(kind), pick.id, depth + 1, (ctx || []).concat([own]));
        });
    }

    function resolveVod(pl, cmd, open) {
        if (!cmd && !(open && open.id)) return Promise.reject(E('Missing VOD cmd', 'portal'));
        return withSession(pl, function (sess) {
            function opened() { return walkToFile(pl, sess, open.param || 'movie_id', open.id, 0); }
            if (!cmd) return opened();
            // The row's own cmd first; only "nothing to play" (a container row) sends us down to the file.
            return createVodLink(pl, sess, cmd).then(function (u) { return { url: u, via: 'create_link_vod' }; }, function (e) {
                if (open && open.id && e && (e.code === 'nothing' || e.code === 'bad_response')) return opened();
                throw e;
            });
        });
    }

    /* ---- series ---- */
    function seriesCategories(pl) {
        return withSession(pl, function (sess) {
            return call(pl, sess, 'type=series&action=get_categories').then(function (js) {
                if (!Array.isArray(js)) {
                    // No type=series: when the VOD rows carry the is_series flag the series live in the VOD categories.
                    return detectVodSeries(pl, sess, js).then(function (vodMode) {
                        if (!vodMode) return { categories: [] };
                        return call(pl, sess, 'type=vod&action=get_categories').then(function (vjs) {
                            var all = [], list = categoriesOf(Array.isArray(vjs) ? vjs : []);
                            for (var i = 0; i < list.length; i++) if (list[i].id !== '*') all.push(list[i]);
                            return vodCategoryKinds(pl, sess, all).then(function (kinds) {
                                var keep = [];
                                for (var j = 0; j < all.length; j++) if (kinds[all[j].id] !== 'movies') keep.push(all[j]);
                                return { categories: keep, vodMode: true };
                            });
                        });
                    });
                }
                return { categories: categoriesOf(js) };
            });
        });
    }

    function seriesRow(pl, v, tmdb) {
        return {
            id: String(v.id),
            name: v.name || v.o_name || ('Series ' + v.id),
            logo: absLogo(pl, v.screenshot_uri || v.pic),
            year: v.year || '',
            rating: v.rating_imdb || v.rating_kinopoisk || '',
            plot: v.description || '',
            director: v.director || '',
            actors: v.actors || '',
            genres: v.genres_str || '',
            tmdbId: tmdb ? (v.tmdb_id || '') : '',
            added: v.added || ''
        };
    }

    function seriesItems(pl, categoryId, maxPages) {
        return withSession(pl, function (sess) {
            return isVodSeriesMode(pl, sess).then(function (vodMode) {
                if (vodMode) {
                    return vodList(pl, sess, 'category=' + encodeURIComponent(categoryId || '*'), maxPages).then(function (r) {
                        var out = [];
                        for (var i = 0; i < r.rows.length; i++) if (rowKind(r.rows[i]) === 'series') out.push(seriesRow(pl, r.rows[i], false));
                        return { items: out, total: out.length, fetchedPages: 1, totalPages: 1 };
                    });
                }
                var cap = maxPages || ORDERED_LIST_MAX_PAGES;
                var out = [];
                function pull(page) {
                    return call(pl, sess, 'type=series&action=get_ordered_list&category=' + encodeURIComponent(categoryId || '*') + '&p=' + page).then(function (js) {
                        var data = (js && js.data) || [];
                        for (var i = 0; i < data.length; i++) out.push(seriesRow(pl, data[i], true));
                        var total = (js && parseInt(js.total_items, 10)) || out.length;
                        var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                        var maxPage = Math.ceil(total / perPage);
                        if (page < maxPage && page < cap && data.length > 0) return pull(page + 1);
                        return { items: out, total: total, fetchedPages: page, totalPages: maxPage };
                    });
                }
                return pull(1);
            });
        });
    }

    /* Seasons of one series in VOD-series mode: movie_id lists seasons, each season_id its episodes. The app only
     * knows numbered episodes, so a season carries a cmd that names it and the episodes are numbered. */
    function vodSeriesSeasons(pl, sess, seriesId) {
        return vodList(pl, sess, 'movie_id=' + encodeURIComponent(seriesId), 5).then(function (r) {
            var rows = r.rows, seasonRows = [], i;
            for (i = 0; i < rows.length; i++) if (rowKind(rows[i]) === 'season') seasonRows.push(rows[i]);
            function eps(n) { var a = []; for (var k = 1; k <= Math.min(n, 500); k++) a.push(k); return a; }
            if (!seasonRows.length) {
                if (!rows.length) return { seasons: [], total: 0, fetchedPages: 1, totalPages: 1 };
                return { seasons: [{ id: String(seriesId), name: 'Episodes', cmd: encodeVodCmd({ id: String(seriesId), p: 'movie_id' }),
                                     episodes: episodeNumbers(rows), logo: '' }], total: 1, fetchedPages: 1, totalPages: 1 };
            }
            var out = new Array(seasonRows.length);
            var next = 0;
            function worker() {
                if (next >= seasonRows.length) return Promise.resolve();
                var idx = next++;
                var sr = seasonRows[idx];
                return vodListAny(pl, sess, chainQueries(['movie_id=' + encodeURIComponent(seriesId)], 'season_id', sr.id), 5).then(function (er) {
                    out[idx] = {
                        id: String(sr.id), name: sr.name || ('Season ' + sr.id),
                        cmd: encodeVodCmd({ id: String(sr.id), p: 'season_id', q: 'movie_id=' + encodeURIComponent(seriesId) }),
                        episodes: er.rows.length ? episodeNumbers(er.rows) : eps(Array.isArray(sr.season_series) ? sr.season_series.length : (parseInt(sr.season_series, 10) || 0)),
                        logo: absLogo(pl, sr.screenshot_uri || sr.pic)
                    };
                }).then(worker);
            }
            return Promise.all([worker(), worker(), worker()]).then(function () {
                var seasons = [];
                for (var j = 0; j < out.length; j++) if (out[j] && out[j].episodes.length) seasons.push(out[j]);
                return { seasons: seasons, total: seasons.length, fetchedPages: 1, totalPages: 1 };
            });
        });
    }

    function seriesSeasons(pl, seriesId, maxPages) {
        return withSession(pl, function (sess) {
            return isVodSeriesMode(pl, sess).then(function (vodMode) {
                if (vodMode) return vodSeriesSeasons(pl, sess, seriesId);
                var cap = maxPages || ORDERED_LIST_MAX_PAGES;
                var out = [];
                function pull(page) {
                    return call(pl, sess, 'type=series&action=get_ordered_list&movie_id=' + encodeURIComponent(seriesId || '') + '&p=' + page).then(function (js) {
                        var data = (js && js.data) || [];
                        for (var i = 0; i < data.length; i++) {
                            var s = data[i];
                            out.push({
                                id: String(s.id),
                                name: s.name || ('Season ' + s.id),
                                cmd: s.cmd || '',
                                episodes: Array.isArray(s.series) ? s.series.slice() : [],
                                logo: absLogo(pl, s.screenshot_uri || s.pic)
                            });
                        }
                        var total = (js && parseInt(js.total_items, 10)) || out.length;
                        var perPage = (js && parseInt(js.max_page_items, 10)) || data.length || 1;
                        var maxPage = Math.ceil(total / perPage);
                        if (page < maxPage && page < cap && data.length > 0) return pull(page + 1);
                        return { seasons: out, total: total, fetchedPages: page, totalPages: maxPage };
                    });
                }
                return pull(1);
            });
        });
    }

    function resolveSeriesEpisode(pl, cmd, episode) {
        if (!cmd) return Promise.reject(E('Missing series cmd', 'portal'));
        var ep = parseInt(episode, 10);
        if (!ep || ep < 1) return Promise.reject(E('Missing/invalid episode number', 'portal'));
        var vodCmd = decodeVodCmd(cmd);
        if (vodCmd) {
            // VOD-series mode: the Nth episode of the season (or of the series), opened down to its file.
            return withSession(pl, function (sess) {
                var ctx0 = vodCmd.q ? [vodCmd.q] : [];
                return vodListAny(pl, sess, chainQueries(ctx0, vodCmd.p, vodCmd.id), 5).then(function (r) {
                    var row = pickEpisode(r.rows, ep);
                    if (!row) throw E('Portal has nothing to play for this item', 'nothing');
                    var kind = rowKind(row);
                    if (kind === 'file' && (row.cmd || row.url)) return fileLink(pl, sess, row, 'create_link_series_file');
                    return walkToFile(pl, sess, openParamFor(kind === 'movie' ? 'episode' : kind), row.id, 0, ctx0.concat([vodCmd.p + '=' + encodeURIComponent(vodCmd.id)])).then(null, function (e) {
                        // no files listed under the episode: its own cmd may be the file
                        if (row.cmd && e && e.code === 'nothing') {
                            return createVodLink(pl, sess, row.cmd).then(function (u) { return { url: u, via: 'create_link_series' }; });
                        }
                        throw e;
                    });
                });
            });
        }
        return withSession(pl, function (sess) {
            return call(pl, sess, 'type=vod&action=create_link&cmd=' + encodeURIComponent(cmd) + '&series=' + encodeURIComponent(ep)).then(function (js) {
                return { url: linkFromJs(js, 'Portal did not return an episode link'), via: 'create_link_series' };
            });
        });
    }

    /* ---- catch-up (TV archive) ----
     * Past programmes: type=epg get_simple_data_table per date (paged); rows flagged mark_archive carry id and epoch
     * times. The link: type=tv_archive create_link, cmd 'auto /media/<programme id>.mpg' (the portal works out the start). */
    function ymdUtc(ms) { return new Date(ms).toISOString().slice(0, 10); }

    function epgDay(pl, sess, channelId, date) {
        function read(p) {
            return call(pl, sess, 'type=epg&action=get_simple_data_table&ch_id=' + encodeURIComponent(channelId) + '&date=' + date + '&p=' + p);
        }
        return read(1).then(function (js) {
            if (!js || typeof js !== 'object') return [];
            var rows = Array.isArray(js.data) ? js.data.slice() : (Array.isArray(js) ? js.slice() : []);
            var per = Number(js.max_page_items) || rows.length || 1, total = Number(js.total_items) || rows.length;
            var pages = Math.min(ARCHIVE_MAX_PAGES, Math.ceil(total / per));
            var chain = Promise.resolve();
            function add(p) {
                chain = chain.then(function () { return read(p); }).then(function (j) { if (j && Array.isArray(j.data)) rows = rows.concat(j.data); });
            }
            for (var p = 2; p <= pages; p++) add(p);
            return chain.then(function () { return rows; });
        });
    }

    function archiveList(pl, channelId, hours) {
        var nowMs = Date.now(), fromMs = nowMs - hours * 3600000;
        var dates = [];
        for (var t = fromMs - 86400000; t <= nowMs + 86400000 && dates.length < ARCHIVE_MAX_DATES; t += 86400000) dates.push(ymdUtc(t));
        return withSession(pl, function (sess) {
            var out = {}, queue = dates.slice();
            function worker() {
                var d = queue.shift();
                if (!d) return Promise.resolve();
                return epgDay(pl, sess, channelId, d).then(function (rows) {
                    for (var i = 0; i < rows.length; i++) {
                        var r = rows[i];
                        if (!r || r.id == null || !truthy(r.mark_archive)) continue;
                        var start = Number(r.start_timestamp) || 0, stop = Number(r.stop_timestamp) || 0;
                        if (!start || stop <= start || stop * 1000 > nowMs || stop * 1000 < fromMs) continue;
                        out[String(r.id)] = { id: String(r.id), title: String(r.name || '').slice(0, 200), start: start, stop: stop, desc: String(r.descr || '').slice(0, 400) };
                    }
                }, function (err) { if (err && err.code === 'auth') throw err; }).then(worker);   // one day failing leaves that day out
            }
            var pool = [];
            for (var i = 0; i < ARCHIVE_CONCURRENCY; i++) pool.push(worker());
            return Promise.all(pool).then(function () {
                var list = [];
                for (var k in out) if (out.hasOwnProperty(k)) list.push(out[k]);
                list.sort(function (a, b) { return b.start - a.start; });
                return { programmes: list };
            });
        });
    }

    function resolveArchive(pl, programmeId) {
        return withSession(pl, function (sess) {
            return call(pl, sess, 'type=tv_archive&action=create_link&cmd=' + encodeURIComponent('auto /media/' + programmeId + '.mpg') +
                '&series=&forced_storage=&disable_ad=0&download=0&force_ch_link_check=0').then(function (js) {
                return { url: linkFromJs(js, 'Portal did not return an archive link'), via: 'tv_archive' };
            });
        });
    }

    /* ---- the same errors the server routes answer with, so the screens need no change ---- */
    var STATUS = { auth: 401, blocked: 403, limit: 409, nothing: 404, denied: 403, link: 502, portal: 502, network: 504, bad_response: 502, empty: 502, request: 400 };
    var SHOWN = { blocked: 1, limit: 1, nothing: 1, denied: 1, link: 1, auth: 1 };
    var FALLBACK = { network: 1, portal: 1, bad_response: 1, empty: 1 };
    function errText(e) {
        var code = e && e.code, m = (e && e.message) || '';
        if (code === 'auth') return 'Portal rejected credentials (MAC not authorised or expired).';
        if (code === 'blocked') return 'Portal refused this device: ' + String(m).slice(0, 200);
        if (code === 'portal') return 'Portal endpoint error.';
        if (code === 'network') return 'Could not reach portal.';
        if (code === 'bad_response' || code === 'empty') return 'Portal returned an unexpected response.';
        if (SHOWN[code]) return String(m);
        return String(m || 'Request failed');
    }
    function toHttp(e) {
        var code = (e && e.code) || 'internal';
        var st = STATUS[code] || 500;
        var body = { error: errText(e) };
        if (SHOWN[code]) body.code = code;
        // body is JSON text, like the responseText of a failed server request (Util.xhr)
        return { status: st, err: 'HTTP ' + st, body: JSON.stringify(body), fallback: !!FALLBACK[code], direct: true };
    }

    /* ---- entry points ---- */
    function settingOn() {
        try {
            var s = window.Store && Store.getSettings ? Store.getSettings() : null;
            return !(s && s.stalkerDirect === false);
        } catch (e) { return true; }
    }
    function onServer(pl) {
        var key = keyOf(pl);
        return !!(serverUntil[key] && serverUntil[key] > Date.now());
    }
    function usable(pl) {
        return !!(pl && pl.url && pl.mac && PortalNet.available() && settingOn() && !onServer(pl));
    }
    function handles(path) { return PATHS.hasOwnProperty(path); }
    /* Everything but the transport says this portal would go direct (used to wait for a starting service). */
    function wants(pl) { return !!(pl && pl.url && pl.mac && settingOn() && !onServer(pl)); }

    function holdServer(pl) {
        var key = keyOf(pl);
        serverUntil[key] = Date.now() + HOLD_MS;
        delete sessions[key];
        delete inflight[key];
    }

    /* The server could not be reached either: stop parking the portal on it, so the next call tries the portal again. */
    function release(pl) { delete serverUntil[keyOf(pl)]; }

    function pages(v) {
        var n = parseInt(v, 10);
        return isFinite(n) && n >= 1 ? Math.min(n, 120) : undefined;
    }
    function dispatch(path, pl, x) {
        switch (path) {
            case 'genres': return genreList(pl);
            case 'probe': return genreList(pl).then(function () { return { ok: true }; });
            case 'channels': {
                var mp = parseInt(x.maxPages, 10), sp = parseInt(x.startPage, 10);
                return genreChannels(pl, str(x.genreId || '*', 32),
                    isFinite(mp) && mp >= 1 ? Math.min(mp, 120) : undefined,
                    isFinite(sp) && sp >= 1 ? Math.min(sp, 100000) : undefined);
            }
            case 'channels/all': return allChannels(pl);
            case 'resolve': {
                var cmd = str(x.cmd, 1024), cid = str(x.channelId, 32);
                if (!cmd && !cid) return Promise.reject(E('cmd or channelId required', 'request'));
                return resolveLink(pl, cmd, cid, str(x.genreId, 32), x.fresh === true);
            }
            case 'epg': {
                var one = str(x.channelId, 32);
                if (!one) return Promise.reject(E('channelId required', 'request'));
                return withSession(pl, function (sess) { return epgOne(pl, sess, one); });
            }
            case 'epg/batch': return epgBatch(pl, x.channelIds);
            case 'vod/categories': return vodCategories(pl);
            case 'vod/items': return vodItems(pl, str(x.categoryId || '*', 32), pages(x.maxPages));
            case 'vod/resolve': {
                var vcmd = str(x.cmd, 4096), openId = str(x.openId, 64);
                var openParam = x.openParam == null || x.openParam === '' ? 'movie_id' : String(x.openParam);
                if (openId && ['movie_id', 'season_id', 'episode_id'].indexOf(openParam) < 0) return Promise.reject(E('openParam invalid', 'request'));
                if (!vcmd && !openId) return Promise.reject(E('cmd required', 'request'));
                return resolveVod(pl, vcmd, openId ? { param: openParam, id: openId } : null);
            }
            case 'series/categories': return seriesCategories(pl);
            case 'series/items': return seriesItems(pl, str(x.categoryId || '*', 32), pages(x.maxPages));
            case 'series/seasons': {
                var sid = str(x.seriesId, 32);
                if (!sid) return Promise.reject(E('seriesId required', 'request'));
                return seriesSeasons(pl, sid, pages(x.maxPages));
            }
            case 'series/resolve': {
                var scmd = str(x.cmd, 4096), ep = parseInt(x.episode, 10);
                if (!scmd) return Promise.reject(E('cmd required', 'request'));
                if (!ep || ep < 1) return Promise.reject(E('episode (positive integer) required', 'request'));
                return resolveSeriesEpisode(pl, scmd, ep);
            }
            case 'archive': {
                var ach = str(x.channelId, 32);
                if (!ach) return Promise.reject(E('channelId required', 'request'));
                var hours = parseInt(x.hours, 10);
                if (!isFinite(hours) || hours < 1) hours = 120;
                return archiveList(pl, ach, Math.min(hours, 720));
            }
            case 'archive/resolve': {
                var pid = x.programmeId == null ? '' : String(x.programmeId);
                if (!/^[0-9A-Za-z_.:-]{1,64}$/.test(pid)) return Promise.reject(E('programmeId required', 'request'));
                return resolveArchive(pl, pid);
            }
        }
        return Promise.reject(E('Unsupported call', 'request'));
    }

    /* Runs one call directly. A rejection has the shape of a failed server request ({status, err, body}) plus
     * fallback: true when the caller should ask the server instead. */
    function run(path, pl, extra) {
        return Promise.resolve().then(function () { return dispatch(path, pl, extra || {}); }).then(null, function (e) {
            var he = toHttp(e);
            if (he.fallback) holdServer(pl);
            throw he;
        });
    }

    function reset() {
        sessions = {}; inflight = {}; endpoints = {}; plainPortals = {}; plainTried = {}; serverUntil = {}; derivedPortals = {}; derivedTried = {}; vodSeriesMode = {}; vodCatKinds = {};
    }

    return { usable: usable, handles: handles, wants: wants, run: run, release: release, reset: reset };
})();
