/* Xtivio portal helper (webOS JS service).
 *
 * A web page cannot send Cookie, Referer or User-Agent, which a MAG / Stalker portal expects. This service makes the
 * request for the page, with exactly the headers it is given, and hands the answer back in pieces over a Luna
 * subscription. Plain Node core modules only (no npm packages), so nothing has to be installed.
 *
 *   ping                                   -> { returnValue: true, v: 1, node: 'v8.12.0' }
 *   fetch  { reqId, url, headers, timeoutMs, maxBytes, subscribe: true }
 *          replies, in order:  { returnValue: true, type: 'chunk', data: '<text>' } ...
 *          then once:          { returnValue: true, type: 'done', status: 200 }
 *                          or  { returnValue: true, type: 'done', status: 0, err: 'network' | 'timeout' | 'too-large' }
 *   cancel { reqId }
 * An HTTP error status (403, 404, ...) is a normal 'done' with that status; the page decides what it means.
 * Same contract as PortalHttp.kt on Android. */
var Service = require('webos-service');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var urlmod = require('url');

var service = new Service('com.xtivio.iptv.service');
var live = {};            // reqId -> function (reason) that stops that request
var CHUNK_CHARS = 65536;  // text handed over per reply
var MAX_REDIRECTS = 5;
var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function clamp(n, lo, hi, dflt) {
    n = parseInt(n, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
}

service.register('ping', function (message) {
    message.respond({ returnValue: true, v: 1, node: process.version });
});

service.register('cancel', function (message) {
    var id = String((message.payload || {}).reqId || '');
    if (live[id]) live[id]('cancel');
    message.respond({ returnValue: true });
});

service.register('fetch', function (message) {
    var p = message.payload || {};
    var id = String(p.reqId || '');
    var finished = false;
    var req = null;
    var timer = null;

    function send(o) {
        try { message.respond(o); return true; } catch (e) { return false; }
    }
    function cleanup() {
        finished = true;
        if (timer) clearTimeout(timer);
        delete live[id];
    }
    function done(status, err) {
        if (finished) return;
        cleanup();
        var o = { returnValue: true, type: 'done', status: status };
        if (status <= 0) { o.status = 0; o.err = err || 'network'; }
        send(o);
    }
    function stop(reason) {
        if (finished) return;
        try { if (req) req.abort(); } catch (e) { /* ignore */ }
        if (reason === 'cancel') { cleanup(); return; }       // the page asked: no reply needed
        done(0, reason);
    }

    if (!ID_RE.test(id)) { send({ returnValue: false, errorText: 'bad reqId' }); return; }
    var target;
    try { target = urlmod.parse(String(p.url || '')); } catch (e0) { target = null; }
    if (!target || !/^https?:$/.test(target.protocol || '') || !target.hostname) { done(0, 'network'); return; }

    var idleMs = clamp(p.timeoutMs, 2000, 120000, 12000);
    var maxBytes = clamp(p.maxBytes, 0, 1 << 30, 0);
    var headers = {};
    var hin = p.headers || {};
    for (var k in hin) if (Object.prototype.hasOwnProperty.call(hin, k) && typeof hin[k] === 'string') headers[k] = hin[k];
    live[id] = stop;
    // Backstop against a request nobody reads any more: the page cancels, but if it is gone this still ends.
    timer = setTimeout(function () { stop('timeout'); }, 15 * 60 * 1000);
    try { if (typeof message.on === 'function') message.on('cancel', function () { stop('cancel'); }); } catch (e1) { /* older runtimes */ }

    var received = 0;

    function go(urlStr, hops) {
        var u = urlmod.parse(urlStr);
        var lib = u.protocol === 'https:' ? https : http;
        var opt = {
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.path,
            method: 'GET', headers: headers, agent: false
        };
        req = lib.request(opt, function (res) {
            var sc = res.statusCode || 0;
            if (sc >= 300 && sc < 400 && res.headers.location && hops < MAX_REDIRECTS) {
                res.resume();
                go(urlmod.resolve(urlStr, String(res.headers.location)), hops + 1);
                return;
            }
            var enc = String(res.headers['content-encoding'] || '').toLowerCase();
            var src = res;
            if (enc === 'gzip' || enc === 'x-gzip') { src = res.pipe(zlib.createGunzip()); src.on('error', function () { stop('network'); }); }
            else if (enc === 'deflate') { src = res.pipe(zlib.createInflate()); src.on('error', function () { stop('network'); }); }
            src.setEncoding('utf8');
            var buf = '';
            src.on('data', function (c) {
                if (finished) return;
                received += c.length;
                if (maxBytes && received > maxBytes) { stop('too-large'); return; }
                buf += c;
                while (buf.length >= CHUNK_CHARS) {
                    if (!send({ returnValue: true, type: 'chunk', data: buf.slice(0, CHUNK_CHARS) })) { stop('cancel'); return; }
                    buf = buf.slice(CHUNK_CHARS);
                }
            });
            src.on('end', function () {
                if (finished) return;
                if (buf) { if (!send({ returnValue: true, type: 'chunk', data: buf })) { stop('cancel'); return; } }
                done(sc, null);
            });
            res.on('aborted', function () { stop('network'); });
            res.on('error', function () { stop('network'); });
            res.setTimeout(idleMs, function () { stop('timeout'); });
        });
        req.on('error', function () { stop('network'); });
        req.setTimeout(idleMs, function () { stop('timeout'); });
        req.end();
    }
    try { go(String(p.url), 0); } catch (e2) { stop('network'); }
});
