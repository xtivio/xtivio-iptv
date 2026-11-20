/* portal-net.js - raw HTTP GET with caller-chosen headers, for the direct Stalker client.
 *
 * A web page cannot send Cookie, Referer or User-Agent, which a MAG portal expects. Where the platform
 * can do it for us, this module is the one place that knows how:
 *   Android: AndroidBridge.portalFetch (PortalHttp.kt), answers arrive as PortalNative.onEvent events.
 *   webOS:   the packaged JS service com.xtivio.iptv.service (webos-service/), called over Luna with a subscription;
 *            its replies are turned into the same events. available() turns true once the service has answered a ping.
 * Everywhere else available() is false and callers use the pairing server instead.
 *
 * get(url, headers, opts)            -> Promise { status, body }          (whole body as text)
 * stream(url, headers, onChunk, opts) -> Promise { status }               (body handed over in pieces)
 *   opts: timeoutMs (idle time allowed between pieces, default 12000), maxBytes (default 8 MB for get,
 *         none for stream), deadlineMs (stream only: whole-transfer limit).
 *   onChunk(text) may return false or throw to stop the transfer (the promise then rejects).
 * Rejections are { status: 0, err: 'network' | 'timeout' | 'too-large' | 'stopped' }.
 * An HTTP error status is NOT a rejection: the caller reads status and body. */
var PortalNet = (function () {
    'use strict';

    var seq = 0;
    var pending = {};
    var GET_MAX = 8 * 1024 * 1024;

    /* ---- webOS: the Luna service ---- */
    var LUNA = 'luna://com.xtivio.iptv.service/';
    var luna = { ok: false, calls: {}, pingTimer: null, pings: 0, busy: false, last: 0, startup: true };
    var READY_STEP_MS = 250;
    var PING_TIMEOUT_MS = 4000;
    var PING_GAP_MS = [1500, 3000, 6000, 12000, 20000, 30000, 30000, 30000];

    function hasPalm() {
        try { return typeof PalmServiceBridge !== 'undefined'; } catch (e) { return false; }
    }
    /* One Luna call with one answer. A call the platform drops silently (the page is still starting up) must not
     * hang for good: it ends with null after timeoutMs. */
    function lunaOnce(command, payload, cb, timeoutMs) {
        var got = false, b, t = null;
        function end(o) {
            if (got) return;
            got = true;
            if (t) clearTimeout(t);
            try { if (b) b.cancel(); } catch (e3) { /* ignore */ }
            cb(o);
        }
        try { b = new PalmServiceBridge(); } catch (e) { got = true; cb(null); return; }
        b.onservicecallback = function (m) {
            var o = null;
            try { o = JSON.parse(m); } catch (e2) { /* bad reply */ }
            end(o);
        };
        if (timeoutMs) t = setTimeout(function () { end(null); }, timeoutMs);
        try { b.call(LUNA + command, JSON.stringify(payload || {})); } catch (e4) { end(null); }
    }
    function lunaPing() {
        luna.pingTimer = null;
        if (luna.busy || luna.ok) return;
        luna.busy = true;
        luna.last = Date.now();
        luna.pings++;
        lunaOnce('ping', {}, function (o) {
            luna.busy = false;
            if (o && o.returnValue === true) { luna.ok = true; luna.startup = false; return; }
            luna.ok = false;
            // The service starts on its first call, which can be slow on a cold TV, and calls made while the page
            // is still loading can be lost: ask again, a little later each time.
            var gap = PING_GAP_MS[luna.pings - 1];
            if (gap && !luna.pingTimer) luna.pingTimer = setTimeout(lunaPing, gap);
            if (luna.pings >= 5) luna.startup = false;
        }, PING_TIMEOUT_MS);
    }
    function lunaLost() {
        if (!luna.ok) return;
        luna.ok = false;
        luna.pings = 4;
        if (!luna.pingTimer) luna.pingTimer = setTimeout(lunaPing, 30000);
    }
    function lunaClose(id) {
        var b = luna.calls[id];
        if (!b) return;
        delete luna.calls[id];
        try { b.cancel(); } catch (e) { /* ignore */ }
    }
    function lunaFetch(id, url, headersJson, idleMs, maxBytes) {
        var b = new PalmServiceBridge();
        var headers = {};
        try { headers = JSON.parse(headersJson) || {}; } catch (e) { headers = {}; }
        luna.calls[id] = b;
        b.onservicecallback = function (m) {
            var o = null;
            try { o = JSON.parse(m); } catch (e2) { /* bad reply */ }
            if (!o || o.returnValue === false) {
                lunaClose(id);
                lunaLost();
                onEvent(id, 'done', { status: 0, err: 'network' });
                return;
            }
            if (o.type === 'chunk') { onEvent(id, 'chunk', o.data || ''); return; }
            if (o.type === 'done') {
                lunaClose(id);
                onEvent(id, 'done', { status: o.status, err: o.err });
            }
        };
        b.call(LUNA + 'fetch', JSON.stringify({ reqId: id, url: url, headers: headers, timeoutMs: idleMs, maxBytes: maxBytes, subscribe: true }));
    }
    function lunaCancel(id) {
        lunaClose(id);
        lunaOnce('cancel', { reqId: id }, function () { /* nothing to do */ }, 5000);
    }

    /* The transport in use: { fetch, cancel } or null. */
    function bridge() {
        try {
            var b = window.AndroidBridge;
            if (b && typeof b.portalFetch === 'function') {
                return {
                    fetch: function (id, url, hj, idle, max) { b.portalFetch(id, url, hj, idle, max); },
                    cancel: function (id) { if (typeof b.portalCancel === 'function') b.portalCancel(id); }
                };
            }
        } catch (e) { /* no bridge */ }
        if (luna.ok && hasPalm()) return { fetch: lunaFetch, cancel: lunaCancel };
        return null;
    }

    function available() {
        var ok = !!bridge();
        // Still no answer from the service: ask again now and then (the answer comes later; callers use the server meanwhile).
        if (!ok && hasPalm() && !luna.busy && !luna.ok && Date.now() - luna.last > 8000) lunaPing();
        return ok;
    }

    /* True while the webOS service is still starting up and has not answered yet (the first seconds after the app
     * opens, longer on a cold TV). Once it has answered, or it has not for a good while, this stays false. */
    function starting() {
        return hasPalm() && !luna.ok && luna.startup;
    }
    /* Resolves true as soon as the service answers, or false after maxMs (default 10 s) or at once when it is not
     * coming. Calls that arrive in the start-up window wait here instead of going to the pairing server. */
    function whenReady(maxMs) {
        return new Promise(function (resolve) {
            if (available()) { resolve(true); return; }
            if (!starting()) { resolve(false); return; }
            var waited = 0, limit = maxMs || 10000;
            (function tick() {
                if (available()) { resolve(true); return; }
                if (!starting()) { resolve(false); return; }
                waited += READY_STEP_MS;
                if (waited >= limit) { luna.startup = false; resolve(false); return; }
                setTimeout(tick, READY_STEP_MS);
            })();
        });
    }

    function nextId() {
        seq++;
        return 'p' + Date.now().toString(36) + '_' + seq;
    }

    function finish(id, fn, value) {
        var p = pending[id];
        if (!p) return;
        delete pending[id];
        if (p.timer) clearTimeout(p.timer);
        if (p.deadline) clearTimeout(p.deadline);
        fn(p, value);
    }

    function cancelNative(id) {
        try { var b = bridge(); if (b) b.cancel(id); } catch (e) { /* ignore */ }
    }

    function failWith(id, err) {
        if (!pending[id]) return;
        cancelNative(id);
        finish(id, function (p, v) { p.reject({ status: 0, err: v }); }, err);
    }

    function arm(id) {
        var p = pending[id];
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        // The native side has its own read timeout; this one only covers an answer that never arrives.
        p.timer = setTimeout(function () { failWith(id, 'timeout'); }, p.idleMs + 6000);
    }

    /* Called by PortalHttp.kt through evaluateJavascript. The name must not start with an underscore: the release
     * minify step renames such properties, and it cannot see the Kotlin side when it runs on the web folder alone. */
    function onEvent(id, type, data) {
        var p = pending[id];
        if (!p) return;
        if (type === 'chunk') {
            p.bytes += data.length;
            if (p.maxBytes && p.bytes > p.maxBytes) { failWith(id, 'too-large'); return; }
            arm(id);
            var keep;
            try { keep = p.onChunk(data); } catch (e) { keep = false; }
            if (keep === false) failWith(id, 'stopped');
            return;
        }
        if (type === 'done') {
            if (data && data.status > 0) {
                finish(id, function (q, v) { q.resolve({ status: v }); }, data.status);
            } else {
                finish(id, function (q, v) { q.reject({ status: 0, err: v }); }, (data && data.err) || 'network');
            }
        }
    }

    function start(url, headers, onChunk, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var b = bridge();
            if (!b) { reject({ status: 0, err: 'network' }); return; }
            var id = nextId();
            var idleMs = opts.timeoutMs || 12000;
            pending[id] = {
                resolve: resolve, reject: reject, onChunk: onChunk,
                bytes: 0, maxBytes: opts.maxBytes || 0, idleMs: idleMs, timer: null, deadline: null
            };
            if (opts.deadlineMs) {
                pending[id].deadline = setTimeout(function () { failWith(id, 'timeout'); }, opts.deadlineMs);
            }
            arm(id);
            try {
                b.fetch(id, url, JSON.stringify(headers || {}), idleMs, opts.maxBytes || 0);
            } catch (e) {
                failWith(id, 'network');
            }
        });
    }

    function get(url, headers, opts) {
        opts = opts || {};
        var parts = [];
        return start(url, headers, function (t) { parts.push(t); return true; }, {
            timeoutMs: opts.timeoutMs,
            maxBytes: opts.maxBytes || GET_MAX
        }).then(function (r) { return { status: r.status, body: parts.join('') }; });
    }

    function stream(url, headers, onChunk, opts) {
        return start(url, headers, onChunk, opts);
    }

    window.PortalNative = { onEvent: onEvent };
    if (hasPalm()) lunaPing();

    return { available: available, starting: starting, whenReady: whenReady, get: get, stream: stream };
})();
