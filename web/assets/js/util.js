/* util.js - Small utility helpers (ES5 only) */
var Util = (function () {
    'use strict';

    function $(sel, parent) { return (parent || document).querySelector(sel); }
    function $$(sel, parent) {
        var list = (parent || document).querySelectorAll(sel);
        var arr = [];
        for (var i = 0; i < list.length; i++) arr.push(list[i]);
        return arr;
    }

    /* Apply a CSS declaration string ("a:b;c:d") to an element WITHOUT using
     * setAttribute('style') or cssText, both of which a strict CSP style-src
     * blocks. We set each property individually via el.style[prop], which is a
     * DOM API call and CSP-exempt. Property names are hyphen-cased in CSS
     * (e.g. text-align) and must be camelCased for the style object
     * (textAlign). Custom properties (--x) and unknown props fall back to
     * setProperty, which also bypasses the inline-style CSP restriction. */
    function applyStyleString(e, str) {
        if (!str) return;
        var decls = ('' + str).split(';');
        for (var i = 0; i < decls.length; i++) {
            var d = decls[i];
            if (!d) continue;
            var idx = d.indexOf(':');
            if (idx < 0) continue;
            var prop = trim(d.slice(0, idx));
            var val = trim(d.slice(idx + 1));
            if (!prop) continue;
            if (prop.indexOf('--') === 0) {
                try { e.style.setProperty(prop, val); } catch (err) {}
                continue;
            }
            // hyphen-case -> camelCase
            var camel = prop.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
            try {
                e.style[camel] = val;
            } catch (err2) {
                try { e.style.setProperty(prop, val); } catch (err3) {}
            }
        }
    }

    function trim(s) {
        return ('' + s).replace(/^\s+|\s+$/g, '');
    }

    function el(tag, attrs, children) {
        var e = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (!attrs.hasOwnProperty(k)) continue;
                if (k === 'class') e.className = attrs[k];
                else if (k === 'html') e.innerHTML = attrs[k];
                else if (k === 'text') e.textContent = attrs[k];
                else if (k === 'style') applyStyleString(e, attrs[k]);
                else if (k.indexOf('data-') === 0) e.setAttribute(k, attrs[k]);
                else if (k === 'on' && typeof attrs[k] === 'object') {
                    for (var ev in attrs[k]) {
                        if (attrs[k].hasOwnProperty(ev)) e.addEventListener(ev, attrs[k][ev]);
                    }
                } else e[k] = attrs[k];
            }
        }
        if (children) {
            for (var i = 0; i < children.length; i++) {
                var c = children[i];
                if (c == null) continue;
                if (typeof c === 'string') e.appendChild(document.createTextNode(c));
                else e.appendChild(c);
            }
        }
        return e;
    }

    function empty(node) {
        if (node) node.innerHTML = '';
    }

    function debounce(fn, wait) {
        var t;
        return function () {
            var args = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    function throttle(fn, wait) {
        var last = 0, t;
        return function () {
            var now = Date.now(), args = arguments, ctx = this;
            var remaining = wait - (now - last);
            if (remaining <= 0) {
                clearTimeout(t);
                t = null;
                last = now;
                fn.apply(ctx, args);
            } else if (!t) {
                t = setTimeout(function () {
                    last = Date.now();
                    t = null;
                    fn.apply(ctx, args);
                }, remaining);
            }
        };
    }

    function pad(n, w) {
        w = w || 2;
        var s = '' + n;
        while (s.length < w) s = '0' + s;
        return s;
    }

    function formatTime(d) {
        d = d || new Date();
        // A malformed EPG timestamp yields an Invalid Date whose getHours() is NaN,
        // which rendered as "NaN:NaN" in the guide. Treat invalid dates as empty.
        if (isNaN(d.getTime())) return '';
        var h = d.getHours();
        var m = d.getMinutes();
        return pad(h) + ':' + pad(m);
    }

    /* "25", "29.97", "23.976": a frame rate for display. Whole numbers stay whole; a broadcast fraction keeps its
     * decimals; anything else is rounded to one decimal. */
    function formatFps(f) {
        f = Number(f);
        if (!isFinite(f) || f <= 0) return '';
        if (Math.abs(f - Math.round(f)) < 0.005) return String(Math.round(f));
        var known = [23.976, 29.97, 59.94, 119.88];
        for (var i = 0; i < known.length; i++) if (Math.abs(f - known[i]) < 0.01) return String(known[i]);
        return String(Math.round(f * 10) / 10);
    }

    function formatTimeRange(start, end) {
        if (!start) return '';
        var s = formatTime(start);
        var e = end ? formatTime(end) : '';
        // formatTime returns '' for an invalid date; avoid a stray leading/trailing
        // dash when one endpoint is bad (for example " - 15:00" or "14:00 - ").
        if (s && e) return s + ' - ' + e;
        return s || e;
    }

    // XHR wrapper - works on WebOS/Tizen without fetch polyfill
    function xhr(opts) {
        return new Promise(function (resolve, reject) {
            try {
                var x = new XMLHttpRequest();
                x.open(opts.method || 'GET', opts.url, true);
                x.timeout = opts.timeout || 30000;

                if (opts.headers) {
                    for (var k in opts.headers) {
                        if (opts.headers.hasOwnProperty(k)) x.setRequestHeader(k, opts.headers[k]);
                    }
                }
                if (opts.responseType) x.responseType = opts.responseType;

                // Optional response size guard. A response larger than maxBytes
                // is aborted rather than buffered, so a huge VOD/series payload
                // (hundreds of MB on a big catalog) can't fill the heap before
                // parsing even starts — the buffered responseText, not the
                // parser, is the real OOM source on weak TVs. We reject with
                // err:'too-large' so the caller can fall back gracefully.
                var maxBytes = opts.maxBytes || 0;
                var abortedForSize = false;
                if (maxBytes) {
                    // Early out on the declared size, before downloading the body.
                    // Skipped entirely when truncateAt is set: in that mode we WANT
                    // the prefix, so aborting at HEADERS_RECEIVED (before any body
                    // exists) would yield nothing at all. Truncation is handled in
                    // onprogress instead, once enough body has arrived to use.
                    x.onreadystatechange = function () {
                        if (opts.truncateAt) return;
                        if (x.readyState === 2 && !abortedForSize) { // HEADERS_RECEIVED
                            var len = 0;
                            try { len = parseInt(x.getResponseHeader('Content-Length'), 10) || 0; } catch (e) {}
                            if (len && len > maxBytes) {
                                abortedForSize = true;
                                try { x.abort(); } catch (e2) {}
                                reject({ status: 0, err: 'too-large', bytes: len });
                            }
                        }
                    };
                    // Guard servers that don't send Content-Length: watch the
                    // body grow and abort once it crosses the budget.
                    var isTyped = !!opts.responseType;
                    x.onprogress = function (ev) {
                        if (abortedForSize) return;
                        var grown = 0;
                        // IMPORTANT: for a typed response (e.g. responseType
                        // 'blob'), reading responseText throws on WebKit and can
                        // fault the in-flight request — so for typed responses we
                        // use ONLY the progress event's loaded byte count and
                        // never touch responseText.
                        if (isTyped) {
                            grown = (ev && ev.loaded) ? ev.loaded : 0;
                        } else {
                            try { grown = x.responseText ? x.responseText.length : 0; } catch (e) {}
                        }
                        if (grown > maxBytes) {
                            abortedForSize = true;
                            // Two behaviours:
                            //
                            //  - truncateAt (streaming catalogs): the body is
                            //    bounded, but what already arrived is USABLE. Abort
                            //    the download to stop the string growing, then
                            //    resolve with the partial text so the caller can
                            //    parse the prefix. The parser stops at the last
                            //    complete object, so a mid-object cut is harmless.
                            //    This is what keeps a huge catalog from OOMing while
                            //    still giving the user a partial (browsable+partly
                            //    searchable) result.
                            //
                            //  - plain maxBytes (legacy): reject with too-large. The
                            //    caller gets nothing. Kept for callers that cannot
                            //    use a partial body.
                            //
                            // CRITICAL: never read responseText on a TYPED response
                            // (it throws on WebKit and can fault the in-flight
                            // request), so truncation is only offered for the
                            // untyped/string path.
                            if (opts.truncateAt && !isTyped) {
                                var partial = '';
                                try { partial = x.responseText || ''; } catch (ePt) { partial = ''; }
                                try { x.abort(); } catch (e3a) {}
                                resolve({ status: 200, body: partial, raw: x, truncated: true, bytes: grown });
                                return;
                            }
                            try { x.abort(); } catch (e3) {}
                            reject({ status: 0, err: 'too-large', bytes: grown });
                        }
                    };
                }

                x.onload = function () {
                    if (abortedForSize) return;
                    if (x.status >= 200 && x.status < 400) {
                        var body = x.responseType ? x.response : x.responseText;
                        if (opts.json && typeof body === 'string') {
                            try { body = JSON.parse(body); } catch (e) { return reject({ status: x.status, err: 'bad-json' }); }
                        }
                        resolve({ status: x.status, body: body, raw: x });
                    } else {
                        var errBody = '';
                        if (!x.responseType) { try { errBody = x.responseText; } catch (e) {} }
                        reject({ status: x.status, err: (x.statusText && String(x.statusText).replace(/^\s+|\s+$/g, '')) || ('HTTP ' + (x.status || '?')), body: errBody });
                    }
                };
                x.onerror = function () { if (!abortedForSize) reject({ status: 0, err: 'network' }); };
                x.ontimeout = function () { reject({ status: 0, err: 'timeout' }); };

                if (opts.body) {
                    if (typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
                        x.setRequestHeader('Content-Type', 'application/json');
                        x.send(JSON.stringify(opts.body));
                    } else x.send(opts.body);
                } else x.send();
            } catch (e) { reject({ status: 0, err: e.message || 'xhr-error' }); }
        });
    }

    function uuid() {
        return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : ((r & 0x3) | 0x8);
            return v.toString(16);
        });
    }

    function genShortCode() {
        // 6-char uppercase alphanumeric, avoiding ambiguous chars
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var s = '';
        for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
        return s;
    }

    /* The M3U,
     * Xtream and Stalker "Add Source" forms and the external EPG source
     * manager accepted a plain word with no scheme at all in a URL field and
     * saved it as the active source, with no validation error and no way to
     * tell from the Sources list that anything was wrong.
     *
     * Deliberately lenient beyond requiring the scheme and a host: real
     * Stalker/Xtream/M3U/EPG sources are frequently bare IPs with a port and
     * no dot at all (e.g. http://192.168.1.5:8080/c/), so this does not
     * require a TLD, and does not use the URL constructor because some
     * engines accept things like "http:foo" that have no real host. */
    function isHttpUrl(s) {
        if (typeof s !== 'string') return false;
        return /^https?:\/\/[^\s/][^\s]*$/i.test(s.trim());
    }

    function escapeHtml(s) {
        if (s == null) return '';
        s = '' + s;
        return s.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
    }

    /* Decode HTML entities WITHOUT touching the DOM. The previous version
     * assigned the input to a div's innerHTML, which parses HTML — so a
     * malicious playlist/category name like <img src=x onerror=...> would
     * execute in the app's origin. The IPTV threat model accepts playlists from
     * arbitrary sources, so this must not parse HTML. Static string-replace of
     * the common named entities plus numeric (decimal and hex) references. */
    function decodeHtmlEntities(str) {
        return String(str || '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#0*39;|&apos;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
                var n = parseInt(h, 16);
                return (n >= 0 && n <= 0x10FFFF) ? String.fromCharCode(n) : '';
            })
            .replace(/&#(\d+);/g, function (_, d) {
                var n = parseInt(d, 10);
                return (n >= 0 && n <= 0x10FFFF) ? String.fromCharCode(n) : '';
            });
    }

    /* Strip decorative/unrenderable glyphs from a display name so they don't
     * show as tofu boxes (□) on WebOS, whose font lacks many symbol blocks.
     * Conservative: removes astral-plane symbols (emoji, flags — encoded as
     * surrogate pairs), variation selectors, box-drawing/block elements, and
     * common pictographic symbol ranges in the BMP. Leaves normal letters,
     * digits, punctuation, and superscripts (e.g. "RAW", "8K") intact, then
     * collapses any whitespace the removals leave behind. ES5-safe (no \p{},
     * no u-flag) for the Chromium 79 target. */
    function cleanseDisplayName(str) {
        return String(str || '')
            // Astral plane (U+10000+): emoji, regional-indicator flags, many
            // pictographs. In ES5 these are high+low surrogate pairs.
            .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
            // Lone/stray surrogates left behind.
            .replace(/[\uD800-\uDFFF]/g, '')
            // Variation selectors + zero-width joiners/marks used to compose emoji.
            .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, '')
            // Box drawing, block elements, geometric shapes, misc symbols,
            // dingbats, misc-symbols-and-arrows — common tofu sources.
            .replace(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u2500-\u259F\u25A0-\u25FF]/g, '')
            // Superscript / modifier / phonetic Latin letters and super-subscript
            // digits. IPTV providers use these as decorative name tags (e.g. a
            // "VIP RAW" suffix written in tiny raised letters), which the WebOS
            // font has no glyphs for, so they render as tofu. They never carry
            // real channel-name meaning, so strip the whole decorative range:
            // U+1D2C-1DBF (modifier/phonetic Latin), U+2070-209F (super/subscripts),
            // U+2C7C-2C7F (Latin Extended-C tail).
            .replace(/[\u1D2C-\u1DBF\u2070-\u209F\u2C7C-\u2C7F]/g, '')
            // Superscript-letter modifiers from the Spacing Modifier Letters block:
            // U+02B0-02B8 (superscript h,j,r,w,y and friends) and U+02E0-02E4
            // (superscript gamma,l,s,x and reversed glottal). Providers tag titles
            // with these (e.g. a raised "h"); the WebOS font lacks glyphs so they
            // show as tofu. Only these superscript-letter sub-ranges are stripped —
            // the rest of the block (U+02B9-02DF) holds modifier apostrophes and
            // diacritic marks that can carry real meaning in a title, so they stay.
            .replace(/[\u02B0-\u02B8\u02E0-\u02E4]/g, '')
            // Latin-1 superscript digits and ordinal indicators used as decorative
            // tags (e.g. "4K²", "HD³", ordinal ª/º). Purely cosmetic in channel
            // names; some WebOS fonts render them, others show tofu — a source of
            // the 6.5-vs-10 inconsistency. Safe to strip (they never carry
            // channel-name meaning).
            .replace(/[\u00B2\u00B3\u00B9\u00AA\u00BA]/g, '')
            // Combining Diacritical Marks Supplement (U+1DC0-1DFF): rare, and when
            // present in provider tags they're decorative stacked marks that one
            // WebOS font composes and the other shows as boxes. (The main combining
            // block U+0300-036F is deliberately left intact so legitimately
            // accented names aren't mangled.)
            .replace(/[\u1DC0-\u1DFF]/g, '')
            // Collapse whitespace the removals may have orphaned.
            .replace(/\s{2,}/g, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    // Remove the standard OK button from the CURRENT modal. Scoped to the open
    // modal layer (not a bare document-wide getElementById, which could match a
    // stale/other #modalOk) and done synchronously — the old setTimeout(0)
    // version raced with openModal's own OK-button creation, so a modal meant to
    // have only Cancel could end up with a working OK re-added on the next tick.
    // Call this AFTER the modal body is fully built.
    function removeDefaultModalOk() {
        var layer = document.getElementById('modalLayer');
        if (!layer) return;
        var ok = layer.querySelector('#modalOk');
        if (ok && ok.parentNode) ok.parentNode.removeChild(ok);
    }

    function log() {
        if (APP_CONFIG && APP_CONFIG.DEBUG && window.console && console.log) {
            console.log.apply(console, arguments);
        }
    }
    function logErr() {
        if (Log && Log.enabled && Log.enabled() && window.console && console.error) console.error.apply(console, arguments);
    }

    /* ---- Background-work pause gate --------------------------------------
     * The VOD/series search-index build (JSON parse in api.js, index build in
     * search.js, IDB chunk writes in idb.js) competes with the main thread. When
     * a heavy parental manager modal is open, its list interaction was starved by
     * those background bursts (measured: multi-hundred-ms input stalls, up to a
     * 4.7s freeze, while a 56k-row content manager was open mid-index). The
     * managers do NOT depend on the search index, so the correct priority is:
     * pause background indexing while a manager is open, resume when it closes.
     *
     * The gate is DERIVED FROM THE DOM: it reports "pause" only while a
     * .lock-mgr-modal-card is present AND the modal layer is actually visible
     * (not .hidden). closeModal hides the layer immediately but defers clearing
     * its innerHTML by ~200ms, so keying off visibility (not just node presence)
     * means the gate releases the instant the manager closes — and it can't get
     * stuck paused if a node ever lingers in a hidden layer.
     *
     * There is deliberately NO time cap. A time cap would force indexing to
     * resume — and the jank to return — while someone is still legitimately
     * working through a large list (scrolling, locking channels one by one for
     * minutes). That is exactly the case this fix exists to protect. Pause lasts
     * precisely as long as the manager is genuinely open; the visibility check is
     * what guarantees it ends. */
    function shouldPauseBgWork() {
        try {
            var layer = document.getElementById('modalLayer');
            if (!layer) return false;
            if (layer.classList && layer.classList.contains('hidden')) return false;
            return !!layer.querySelector('.lock-mgr-modal-card');
        } catch (e) {
            return false;
        }
    }


    /* ---- Stream-URL credential placeholders (cloud sync) ----
     * Continue Watching, Favorites and recent channels keep the full stream URL, and for
     * Xtream that URL carries the playlist login (/live/USER/PASS/123.m3u8). Syncing it
     * as-is would put the login in Firebase in the clear, so the synced copy swaps the
     * login for placeholders and the receiving device swaps in ITS OWN playlist login.
     * Only whole path segments (and username=/password= query values) that equal the
     * playlist's user/pass are replaced, so a short password can never corrupt other
     * parts of a URL. M3U playlists have no separate login, so the one in the playlist
     * address (get.php?username=..&password=..) is used. */
    var CRED_U = '{xt:u}', CRED_P = '{xt:p}';
    function playlistCreds(pl) {
        var u = pl && pl.user ? String(pl.user) : '', p = pl && pl.pass ? String(pl.pass) : '';
        if ((!u || !p) && pl && typeof pl.url === 'string') {
            var q = pl.url.indexOf('?');
            if (q >= 0) {
                var parts = pl.url.substring(q + 1).split('&');
                for (var i = 0; i < parts.length; i++) {
                    var kv = parts[i].split('='), k = (kv[0] || '').toLowerCase(), v = kv.slice(1).join('=');
                    try { v = decodeURIComponent(v); } catch (e) {}
                    if (!u && (k === 'username' || k === 'user')) u = v;
                    if (!p && (k === 'password' || k === 'pass')) p = v;
                }
            }
        }
        return { u: u, p: p };
    }
    function credVariants(v) {
        var out = [v], enc = '';
        try { enc = encodeURIComponent(v); } catch (e) {}
        if (enc && enc !== v) out.push(enc);
        return out;
    }
    function redactStreamCreds(str, pl) {
        if (typeof str !== 'string' || !str) return str;
        var c = playlistCreds(pl);
        if (!c.u && !c.p) return str;
        var uv = c.u ? credVariants(c.u) : [], pv = c.p ? credVariants(c.p) : [];
        var qi = str.indexOf('?'), head = qi >= 0 ? str.substring(0, qi) : str, tail = qi >= 0 ? str.substring(qi) : '';
        var segs = head.split('/');
        for (var i = 0; i < segs.length; i++) {
            if (uv.indexOf(segs[i]) >= 0) segs[i] = CRED_U;
            else if (pv.indexOf(segs[i]) >= 0) segs[i] = CRED_P;
        }
        head = segs.join('/');
        if (tail) {
            tail = tail.replace(/([?&])(username|user|password|pass)=([^&#]*)/gi, function (m, sep, name, val) {
                var dv = val; try { dv = decodeURIComponent(val); } catch (e) {}
                var isU = /^user/i.test(name);
                var list = isU ? uv : pv;
                return list.indexOf(val) >= 0 || list.indexOf(dv) >= 0 ? sep + name + '=' + (isU ? CRED_U : CRED_P) : m;
            });
        }
        return head + tail;
    }
    function expandStreamCreds(str, pl) {
        if (typeof str !== 'string' || !str || str.indexOf('{xt:') < 0) return str;
        var c = playlistCreds(pl), out = str;
        if (c.u) out = out.split(CRED_U).join(c.u);
        if (c.p) out = out.split(CRED_P).join(c.p);
        return out;
    }
    function hasCredPlaceholder(str) { return typeof str === 'string' && str.indexOf('{xt:') >= 0; }

    return {
        $: $, $$: $$, el: el, empty: empty,
        debounce: debounce, throttle: throttle,
        pad: pad, formatTime: formatTime,
        formatFps: formatFps, formatTimeRange: formatTimeRange,
        xhr: xhr, uuid: uuid, genShortCode: genShortCode, isHttpUrl: isHttpUrl,
        escapeHtml: escapeHtml, log: log, logErr: logErr,
        decodeHtmlEntities: decodeHtmlEntities, removeDefaultModalOk: removeDefaultModalOk,
        cleanseDisplayName: cleanseDisplayName,
        redactStreamCreds: redactStreamCreds, expandStreamCreds: expandStreamCreds,
        hasCredPlaceholder: hasCredPlaceholder, playlistCreds: playlistCreds,
        shouldPauseBgWork: shouldPauseBgWork
    };
})();
