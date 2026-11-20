/* imageloader.js — bounded-concurrency image loading.
 *
 * List rendering used to fire every poster/logo <img> load at once. On a big
 * catalog that is hundreds of simultaneous network requests, which on a weak TV
 * competes for memory/sockets and can stall the UI. This queue caps how many
 * loads are in flight at once (from PerfConfig 'imageConcurrency'), and honours
 * 'disablePosterPreload' (Lite) by skipping poster loads entirely — leaving the
 * container empty rather than loading images the weakest devices can't afford.
 *
 * ES5 / IIFE. No const/let/arrow/Promises required.
 */
var ImageLoader = (function () {
    'use strict';

    var queue = [];       // pending { img, url, onload, onerror, isPoster }
    var active = 0;

    function concurrency() {
        try {
            if (typeof PerfConfig !== 'undefined') {
                var c = PerfConfig.get('imageConcurrency');
                if (c && c > 0) return c;
            }
        } catch (e) {}
        return 4;
    }

    function postersDisabled() {
        try {
            if (typeof PerfConfig !== 'undefined') {
                return PerfConfig.get('disablePosterPreload') === true;
            }
        } catch (e) {}
        return false;
    }

    function pump() {
        var max = concurrency();
        while (active < max && queue.length) {
            startOne(queue.shift());
        }
    }

    /* A load that was cut off by the phone locking, the app going to the background or the
     * network changing never reports back, and every such load keeps one of the few slots
     * for good, so nothing after it loaded. Three guards: each load has a time limit, a load
     * that failed (or timed out) across a hidden/visible change is tried again, and coming
     * back to the app frees the slots held by loads started before it. */
    var LOAD_TIMEOUT_MS = 15000;
    var MAX_TRIES = 3;
    var epoch = 0;        // bumped on every hidden/visible change
    var running = [];     // jobs in flight

    function startOne(job) {
        active++;
        var img = job.img;
        var done = false;
        job.tries = (job.tries || 0) + 1;
        job.epoch = epoch;
        var timer = null;
        function release() {
            for (var i = 0; i < running.length; i++) if (running[i] === job) { running.splice(i, 1); break; }
            if (timer) { clearTimeout(timer); timer = null; }
        }
        function finish(ok, why) {
            if (done) return;
            done = true;
            active--;
            release();
            img.onload = null;
            img.onerror = null;
            if (ok && job.onload) { try { job.onload.call(img); } catch (e) {} }
            if (!ok) {
                // Cut off by a pause/resume (or a time-out): try once more instead of giving up.
                if ((job.epoch !== epoch || why === 'timeout') && job.tries < MAX_TRIES) {
                    queue.push(job);
                } else if (job.onerror) { try { job.onerror.call(img); } catch (e) {} }
            }
            // Continue draining on the next tick so a long list doesn't run as
            // one synchronous burst.
            setTimeout(pump, 0);
        }
        job.abort = function () { try { img.removeAttribute('src'); } catch (e) {} finish(false, 'timeout'); };
        running.push(job);
        timer = setTimeout(function () { job.abort(); }, LOAD_TIMEOUT_MS);
        img.onload = function () { finish(true); };
        img.onerror = function () { finish(false, 'error'); };
        // Assigning src kicks the load.
        img.src = job.url;
    }

    function onVisibility() {
        epoch++;
        try {
            if (typeof document !== 'undefined' && document.hidden === false) {
                // Back in the app: whatever was in flight before is dead. Restart it.
                var stale = running.slice();
                for (var i = 0; i < stale.length; i++) if (stale[i].epoch !== epoch) stale[i].abort();
            }
        } catch (e) {}
    }
    try {
        if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility, false);
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', onVisibility, false);
    } catch (e) {}

    return {
        /* Queue an image load. img: an <img> element (or new Image()). url: src.
         * opts: { onload, onerror, isPoster }. If isPoster and posters are
         * disabled (Lite), the load is skipped and onerror (if any) is called so
         * callers can clear the container. */
        load: function (img, url, opts) {
            opts = opts || {};
            if (!img || !url) return;
            if (opts.isPoster && postersDisabled()) {
                if (opts.onerror) { try { opts.onerror.call(img); } catch (e) {} }
                return;
            }
            queue.push({ img: img, url: url, onload: opts.onload, onerror: opts.onerror });
            pump();
        },
        /* Drop any not-yet-started loads (e.g. when leaving a screen). In-flight
         * loads finish naturally. */
        clearPending: function () { queue.length = 0; },
        _stats: function () { return { active: active, queued: queue.length }; },
        _timeoutMs: function (n) { LOAD_TIMEOUT_MS = n; }
    };
})();
