/* app.js - Boot sequence and global wiring
 *
 * Boot:
 *   1. splash (init modules)
 *   2. if no playlists -> onboarding (show pair code, poll server)
 *      else -> home (load active playlist, render)
 *
 * Wires:
 *   - sidebar nav buttons
 *   - manual entry tabs + save/cancel
 *   - settings selects
 *   - section render on nav
 *   - remote events: navigation, ok, back, color buttons, channel +/-,
 *                    digits (channel jump), info, menu
 */
var App = (function () {
    'use strict';

    var $ = Util.$, $$ = Util.$$;

    // Highest pairing-payload schema version this app understands. The pairing
    // server sends payloadSchemaVersion alongside a completed payload; a mismatch
    // is refused (see startPairPoll). Bump in lockstep with the server when the
    // payload contract changes.
    var PAIR_PAYLOAD_SCHEMA_VERSION = 1;

    var state = {
        booted: false,
        pairCode: null,
        pairTimer: null,
        digitBuffer: '',
        digitTimer: null,
        miniOpen: false,
        miniClosedAt: 0
    };


    /* Central parental / protected-action gatekeeper. */
    var Access = (function () {
        var unlockedUntil = 0;
        var pendingCb = null;
        var enteredPin = '';
        var PIN_MIN_LEN = 4;
        var PIN_MAX_LEN = 8;
        var CONTENT_UNLOCK_MS = 5 * 60 * 1000; // browse window for locked content only

        // --- Parental PIN hashing ---------------------------------------
        // PINs are stored as a salted, key-stretched hash (never plaintext).
        // Current format uses PBKDF2-HMAC-SHA256 via WebCrypto:
        //     pinHash = "pbkdf2$" + base64(deriveBits(salt, pin, 200000, 256))
        // The salt is CSPRNG bytes (crypto.getRandomValues), base64-encoded.
        //
        // A legacy format exists from earlier builds: a bare 16-hex-char FNV
        // string produced by the old simpleHash. We still VERIFY those so
        // existing users aren't locked out, and transparently UPGRADE them to
        // PBKDF2 on the next successful unlock (see verifyPin). New PINs are
        // always PBKDF2.
        var PBKDF2_ITERS = 200000;
        var PBKDF2_TAG = 'pbkdf2$';

        function bufToB64(bytes) {
            var bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        }
        // CSPRNG salt (16 bytes, base64). Falls back to the old predictable
        // string only if WebCrypto RNG is somehow unavailable — every target
        // that reaches the PIN flow has WebCrypto (ZKSync.hasWebCrypto gates the
        // sync flows on it too), so the fallback is defensive, not expected.
        function pinSalt() {
            try {
                if (window.crypto && window.crypto.getRandomValues) {
                    var b = new Uint8Array(16);
                    window.crypto.getRandomValues(b);
                    return bufToB64(b);
                }
            } catch (e) {}
            return (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
        }

        // Legacy FNV hash — retained ONLY to verify old stored hashes so we can
        // migrate them. Never used to produce a new stored hash.
        function legacyHash(str) {
            var h1 = 0x811c9dc5, h2 = 0x45d9f3b, i, ch;
            str = String(str || '');
            for (i = 0; i < str.length; i++) {
                ch = str.charCodeAt(i);
                h1 ^= ch;
                h1 += (h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24);
                h2 ^= ch + i;
                h2 = ((h2 << 5) - h2 + ch) | 0;
            }
            return ('00000000' + (h1 >>> 0).toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
        }
        function legacyHashPin(pin, salt) { return legacyHash(String(salt || '') + ':' + String(pin || '')); }

        // Async PBKDF2 hash -> Promise<string> of "pbkdf2$<base64bits>".
        function hashPinAsync(pin, salt) {
            try {
                var subtle = window.crypto && window.crypto.subtle;
                if (!subtle) return Promise.reject(new Error('no-subtle'));
                var enc = new TextEncoder();
                return subtle.importKey('raw', enc.encode(String(pin || '')), 'PBKDF2', false, ['deriveBits'])
                    .then(function (baseKey) {
                        return subtle.deriveBits({
                            name: 'PBKDF2',
                            salt: enc.encode(String(salt || '')),
                            iterations: PBKDF2_ITERS,
                            hash: 'SHA-256'
                        }, baseKey, 256);
                    })
                    .then(function (bits) {
                        return PBKDF2_TAG + bufToB64(new Uint8Array(bits));
                    });
            } catch (e) {
                return Promise.reject(e);
            }
        }

        function isPbkdf2Hash(h) { return typeof h === 'string' && h.indexOf(PBKDF2_TAG) === 0; }

        // Migration on read no longer HASHES (hashing is async now). It only
        // normalizes structure. If a plaintext pin survived from an old
        // object, we leave it in place for verifyPin/set-flow to convert; we do
        // NOT drop it here (dropping without hashing would lock the user out).
        function migrateParental(c) {
            if (!c) c = { enabled:false, startup:'off', protectActions:'on' };
            return c;
        }
        function cfg() {
            var c = Store.getParental ? Store.getParental() : Store.raw.get('parental', { enabled:false, pin:'', startup:'off', protectActions:'on' });
            return migrateParental(c);
        }
        function save(c) {
            // Stamp the write time so a cloud PULL can tell whether the cloud copy is
            // older than this device's PIN and refuse to clobber a just-set PIN. Without
            // this, boot's CloudSync.pull() overwrote the local parental config
            // unconditionally — so setting a PIN then reloading (e.g. a language change
            // triggers window.location.reload) could restore a stale/empty cloud copy and
            // make the correct PIN read as "incorrect". Set on the object BEFORE persisting
            // so both the local store and any subsequent cloud push carry it.
            if (c && typeof c === 'object') c.pinUpdatedAt = Date.now();
            if (Store.setParental) Store.setParental(c);
            else Store.raw.set('parental', c);
        }

        // Async verify -> Promise<boolean>. Handles three stored shapes:
        //   1. PBKDF2 hash (current): compare via PBKDF2.
        //   2. Legacy FNV hash: verify via legacyHashPin; on success, UPGRADE
        //      the stored hash to PBKDF2 and persist (transparent migration).
        //   3. A surviving plaintext pin (very old / pulled from cloud): compare directly;
        //      on success, convert to a PBKDF2 hash and persist.
        function verifyPin(pin, c) {
            c = c || cfg();
            if (isPbkdf2Hash(c.pinHash) && c.pinSalt) {
                return hashPinAsync(pin, c.pinSalt).then(function (h) {
                    return h === c.pinHash;
                })['catch'](function (e) {
                    // A crypto ERROR (WebCrypto unavailable/misbehaving) is NOT the same as a
                    // wrong PIN. Re-throw a tagged error so the caller can tell the user
                    // "couldn't verify, try again" instead of falsely reporting "incorrect PIN"
                    // (which is a confusing, Samsung/Tizen-plausible failure mode). Security is
                    // preserved: we never resolve true on error.
                    var err = new Error('pin-verify-crypto-failed');
                    err.cryptoFailed = true;
                    throw err;
                });
            }
            if (c.pinHash && c.pinSalt) {
                // Legacy FNV path. Verify, then upgrade on success.
                var ok = legacyHashPin(pin, c.pinSalt) === c.pinHash;
                if (!ok) return Promise.resolve(false);
                return hashPinAsync(pin, c.pinSalt).then(function (h) {
                    c.pinHash = h; if (c.pin) delete c.pin; save(c);
                    return true;
                })['catch'](function () { return true; }); // upgrade failed, but PIN was correct
            }
            if (c.pin) {
                // Plaintext survivor. Compare directly, then convert.
                if (String(pin) !== String(c.pin)) return Promise.resolve(false);
                var salt = c.pinSalt || pinSalt();
                return hashPinAsync(pin, salt).then(function (h) {
                    c.pinSalt = salt; c.pinHash = h; delete c.pin; save(c);
                    return true;
                })['catch'](function () { return true; });
            }
            return Promise.resolve(false);
        }
        function isEnabled() { var c = cfg(); return !!(c && c.enabled && (c.pinHash || c.pin)); }
        function isUnlocked() { return !isEnabled() || (unlockedUntil && Date.now() < unlockedUntil); }
        function unlock() {
            // Short browse window for locked CONTENT only (after a PIN unlock you
            // can keep watching/browsing within a locked category without
            // re-entering the PIN for every item). Protected actions never use
            // this window — they re-prompt every time (see canProtected). Fixed
            // duration now that the user-facing timeout setting was removed.
            unlockedUntil = Date.now() + (CONTENT_UNLOCK_MS);
        }
        function lock() { unlockedUntil = 0; }
        function canProtected() {
            // Protected ACTIONS (open Settings/Playlists/Parental, wipe data,
            // remove locks, change parental settings) are gated per-action and do
            // NOT honour the content browse-unlock window: if a parent unlocks a
            // locked channel then steps away, a child must still not be able to
            // change settings without the PIN. Content playback keeps a short
            // window (see isUnlocked); these actions never do.
            var c = cfg();
            if (!isEnabled()) return true;
            if (c.protectActions === 'off') return true;
            return false;
        }
        /* "Restrict Playback" gates ALL playback when parental is enabled,
         * independently of per-item/category locks AND of Protected Actions.
         * It's now its own setting; when unset it falls back to the legacy
         * protectActions value so existing users keep prior behaviour. Honours
         * the short content unlock window (one PIN covers a viewing session). */
        function isPlaybackRestricted() {
            var c = cfg();
            if (!isEnabled()) return false;
            var rp = c.restrictPlayback;
            if (rp !== 'on' && rp !== 'off') rp = (c.protectActions === 'off') ? 'off' : 'on';
            return rp === 'on';
        }
        function requirePin(reason, cb) {
            if (!isEnabled() || isUnlocked()) { if (cb) cb(true); return true; }
            pendingCb = cb || null;
            enteredPin = '';
            openPinModal(reason || 'Enter PIN');
            return false;
        }
        function requirePinStrict(reason, cb) {
            if (!isEnabled()) { if (cb) cb(true); return true; }
            pendingCb = cb || null;
            enteredPin = '';
            openPinModal(reason || 'Enter PIN');
            return false;
        }
        function pinDots() {
            var boxes = document.querySelectorAll('.pin-box');
            for (var i = 0; i < boxes.length; i++) {
                var start = Math.max(0, enteredPin.length - boxes.length);
                boxes[i].textContent = (start + i) < enteredPin.length ? '•' : '';
            }
        }
        function pressDigit(n) {
            if (enteredPin.length >= PIN_MAX_LEN) return;
            enteredPin += '' + n;
            pinDots();
        }
        function backspace() { enteredPin = enteredPin.slice(0, enteredPin.length - 1); pinDots(); }
        function checkPin() {
            var c = cfg();
            if (enteredPin.length < PIN_MIN_LEN) { UI.toast(T('pin_must_be_at_least_4'), 'err'); return; }
            var attempt = enteredPin;
            verifyPin(attempt, c).then(function (ok) {
                if (ok) {
                    unlock();
                    UI.closeModal();
                    UI.toast(T('unlocked'), 'ok');
                    var cb = pendingCb; pendingCb = null;
                    if (cb) cb(true);
                } else {
                    enteredPin = '';
                    pinDots();
                    UI.toast(T('incorrect_pin'), 'err');
                }
            })['catch'](function (e) {
                // Crypto failed to run (not a wrong PIN). Don't tell the user their correct
                // PIN is incorrect — clear the entry and ask them to try again. Keeps them
                // locked out safely (no unlock) but avoids the misleading message.
                enteredPin = '';
                pinDots();
                if (e && e.cryptoFailed) UI.toast(T('pin_verify_failed_try_again'), 'err');
                else UI.toast(T('incorrect_pin'), 'err');
            });
        }
        function openPinModal(title) {
            var body = document.createElement('div');
            body.style.textAlign = 'center';
            var _pbr = document.createElement('div'); _pbr.className = 'pin-box-row'; _pbr.setAttribute('dir','ltr'); body.appendChild(_pbr);
            var row = body.querySelector('.pin-box-row');
            for (var i = 0; i < PIN_MAX_LEN; i++) { var bx = document.createElement('div'); bx.className = 'pin-box'; row.appendChild(bx); }
            var hint = document.createElement('div'); hint.className = 'pin-hint'; hint.textContent = T('minimum_4_digits_press_ok_when'); body.appendChild(hint);
            body.appendChild(buildPinKeypad('pin', 'OK', checkPin));
            UI.openModal({
                title: title,
                bodyEl: body,
                okText: false,
                cancelText: T('cancel'),
                cancelClass: 'btn focusable pin-key-word',
                onCancel: function () { var cb = pendingCb; pendingCb = null; if (cb) cb(false); }
            });
            setTimeout(function(){ Focus.focusKey('pin-0'); }, 100);
        }
        /* Shared 0-9 / Del / <last> keypad used by BOTH PIN flows. The flows
         * themselves stay separate (one verifies an existing PIN, the other
         * captures+saves a new one); only this identical button grid is shared.
         * prefix keys the focus keys (pin / pinset); lastLabel + lastAction
         * are the final button (OK→checkPin vs Save→save handler). Del and digits
         * are identical across both. */
        function buildPinKeypad(prefix, lastLabel, lastAction) {
            var keypad = document.createElement('div'); keypad.className = 'pin-keypad'; keypad.setAttribute('dir', 'ltr');
            // 0 comes BEFORE the word keys: Del/Save/OK each take a full keypad
            // row (see .pin-key-word in screens.css), so the old
            // [..9, 'Del', 0, label] order would break the digit grid and strand
            // 0 on a row of its own. Digits first, then the word keys stacked.
            var nums = [1,2,3,4,5,6,7,8,9,0,'Del',lastLabel];
            for (var k = 0; k < nums.length; k++) {
                (function (val, idx) {
                    var b = document.createElement('button'); b.className = 'btn focusable';
                    b.setAttribute('tabindex','-1'); b.setAttribute('data-focus-key', prefix + '-' + idx);
                    // val stays the untranslated identity used by the click handler
                    // below; only the DISPLAYED label is localised. Del/OK/Save were
                    // rendering in English in every language.
                    var label = val;
                    if (val === 'Del') label = T('vk_del');
                    else if (val === 'Save') label = T('md_save');
                    else if (val === 'OK') label = T('ui_ok');
                    // Del / Save / OK are WORDS, not digits. In a localised build
                    // they can be long (Greek "Diagrafi" / "Apothikefsi"), and a
                    // 72px digit cell fits ~3 characters at 26px, so they spilled
                    // over the neighbouring key. Tag them so the stylesheet can
                    // size them as word-buttons on their own row.
                    if (val === 'Del' || val === 'Save' || val === 'OK') {
                        b.className += ' pin-key-word';
                    }
                    b.textContent = '' + label;
                    b.addEventListener('click', function () {
                        if (val === 'Del') backspace();
                        else if (val === lastLabel) lastAction();
                        else pressDigit(val);
                    });
                    keypad.appendChild(b);
                })(nums[k], k);
            }
            return keypad;
        }
        function setPinFlow() {
            if (isEnabled()) {
                requirePinStrict(T('ap_enter_current_pin'), function (ok) { if (ok) setPinFlowUnlocked(); });
                return;
            }
            setPinFlowUnlocked();
        }
        function setPinFlowUnlocked() {
            enteredPin = '';
            var body = document.createElement('div'); body.style.textAlign = 'center';
            var msg = document.createElement('div'); msg.className = 'modal-body'; msg.textContent = T('enter_a_new_pin_minimum_4'); body.appendChild(msg);
            var _pbr = document.createElement('div'); _pbr.className = 'pin-box-row'; _pbr.setAttribute('dir','ltr'); body.appendChild(_pbr);
            var row = body.querySelector('.pin-box-row');
            for (var i = 0; i < PIN_MAX_LEN; i++) { var bx = document.createElement('div'); bx.className = 'pin-box'; row.appendChild(bx); }
            var hint = document.createElement('div'); hint.className = 'pin-hint'; hint.textContent = T('minimum_4_digits_press_save_when'); body.appendChild(hint);
            body.appendChild(buildPinKeypad('pinset', 'Save', function () {
                if (enteredPin.length < PIN_MIN_LEN) { UI.toast(T('pin_must_be_at_least_4'), 'err'); return; }
                var newPin = enteredPin;
                var c = cfg();
                var salt = pinSalt();
                var wasEnabled = !!c.enabled;
                hashPinAsync(newPin, salt).then(function (h) {
                    c.enabled = true; c.pinSalt = salt; c.pinHash = h; if (c.pin) delete c.pin;
                    // Restrict Playback starts Off for a NEW parental setup. Content/category
                    // locks still apply; the user can turn Restrict Playback on. Not touched
                    // when changing the PIN of an already-enabled setup, and a value the user
                    // set (on or off) is always kept; an existing setup that never set it
                    // keeps the legacy fallback (see isPlaybackRestricted).
                    if (!wasEnabled && c.restrictPlayback !== 'on' && c.restrictPlayback !== 'off') c.restrictPlayback = 'off';
                    save(c); lock(); UI.closeModal(); Parental.renderParentalControls();
                    if (UI.refreshLockIndicators) UI.refreshLockIndicators();
                    UI.toast(T('parental_controls_enabled'), 'ok');
                    // Restore focus to the Enable/Change button the user came
                    // from. The save path is async now (PBKDF2), so the modal
                    // closes inside this .then; without an explicit restore,
                    // focus was left on the now-removed modal and landed nowhere.
                    setTimeout(function () { Focus.focusKey('parental-enable'); }, 100);
                })['catch'](function () {
                    UI.toast(T('could_not_set_pin_on_this'), 'err');
                    setTimeout(function () { Focus.focusKey('parental-enable'); }, 100);
                });
            }));
            UI.openModal({
                title: T('ap_set_pin'),
                bodyEl: body,
                okText: false,
                cancelText: T('cancel'),
                cancelClass: 'btn focusable pin-key-word'
            });
            setTimeout(function(){ Focus.focusKey('pinset-0'); }, 100);
        }
        return { cfg:cfg, save:save, isEnabled:isEnabled, isUnlocked:isUnlocked, unlock:unlock, lock:lock, requirePin:requirePin, requirePinStrict:requirePinStrict, canProtected:canProtected, isPlaybackRestricted:isPlaybackRestricted, setPinFlow:setPinFlow };
    })();
    window.Access = Access;


    /* ========== Boot ========== */
    /* Runtime heap-pressure monitor. Only meaningful where the (Chromium)
     * performance.memory API exists — a no-op otherwise, which is most TVs.
     * When running in Auto+Normal and heap use stays high across a few checks,
     * it records a medium auto-detect signal (so the next boot leans Lite) and,
     * once per session, surfaces a gentle suggestion. It never hot-swaps the
     * mode mid-session: switching parse/preload behaviour after the fact would
     * be jarring, so the change is applied cleanly on the next launch. */
    var perfMonitorTimer = null;
    var perfPressureHits = 0;
    var perfRecommended = false;
    function startPerfMonitor() {
        try {
            if (typeof PerfConfig === 'undefined' || !PerfConfig.underHeapPressure) return;
            // Only worth monitoring when Auto is choosing and we're in Normal;
            // an explicit user choice is respected and Lite is already reduced.
            if (PerfConfig.getRequestedMode() !== 'auto') return;
            if (PerfConfig.isLite()) return;
            if (perfMonitorTimer) return;
            perfMonitorTimer = setInterval(function () {
                var under = false;
                try { under = PerfConfig.underHeapPressure(); } catch (e) { under = false; }
                if (!under) { perfPressureHits = 0; return; }
                perfPressureHits++;
                // Sustained pressure (3 consecutive checks ~= 30s) is the signal.
                if (perfPressureHits >= 3 && !perfRecommended) {
                    perfRecommended = true;
                    try { PerfConfig.noteSlowness(); } catch (e2) {}
                    try {
                        UI.toast(T('running_low_on_memory_try_lite'), 'info');
                    } catch (e3) {}
                    // One recommendation per session is enough; stop checking.
                    try { clearInterval(perfMonitorTimer); } catch (e4) {}
                    perfMonitorTimer = null;
                }
            }, 10000);
        } catch (e) {}
    }

    /* Persistent, acknowledge-to-dismiss performance notice. Unlike a toast
     * (which auto-dismisses and is easy to miss), this is a modal the user must
     * OK. It fires when Auto has put the device in Lite AND/OR a catalog was too
     * large to fully index this session — composing one message for whichever
     * conditions are true — so the user understands why the guide/search/totals
     * look reduced. Explicit Normal/Lite choices don't trigger the Lite part.
     *
     * Shown at most once per launch. The Lite part is also gated by a persisted
     * once-per-device flag so it doesn't nag every boot; the cap part shows
     * whenever a catalog is capped (it's tied to the specific large playlist and
     * worth repeating if they keep loading it). */
    var _perfNoticeShown = false;
    var _perfNoticeWasIdb = false;
    // Called when IDB becomes ready after we'd forced Lite for idb-unavailable
    // (a slow post-wipe open that recovered late). Clears the transient reason,
    // re-resolves PerfConfig back to the user's real mode, and retracts the now-
    // stale "storage isn't available" notice if it is still up.
    function onIdbRecovered() {
        try {
            if (typeof PerfConfig === 'undefined') return;
            if (!PerfConfig.getReason || PerfConfig.getReason() !== 'idb-unavailable') return;
            if (PerfConfig.setIdbUnavailable) PerfConfig.setIdbUnavailable(false);
            if (PerfConfig.resolve) PerfConfig.resolve();
            try { if (PerfConfig.breadcrumb) PerfConfig.breadcrumb('IDB recovered -> cleared idb-unavailable, restored mode'); } catch (eB) {}
            // Retract the stale reduced-mode dialog if it was shown for this reason.
            if (_perfNoticeWasIdb) {
                _perfNoticeWasIdb = false;
                _perfNoticeShown = false;
                try { if (UI && UI.closeModal) UI.closeModal(); } catch (eC) {}
            }
            // Let the user know storage recovered and full mode is back — a brief
            // toast rather than another modal (most cases self-recover quickly, and
            // this also covers a user who already dismissed the notice).
            try { if (UI && UI.toast) UI.toast(T('perf_notice_idb_recovered'), 'ok'); } catch (eT) {}
        } catch (e) {}
    }
    /* Load a language table on demand.
     *
     * Only ONE non-English table is ever in memory. Bundling all 21 would cost a
     * few hundred KB of resident strings on a device where the search index is
     * already pressed against the heap ceiling — and 20 of them would never be
     * read. English is always present as the fallback, so a failed load degrades
     * to English rather than to raw keys.
     *
     * Injected as a <script> rather than fetched + eval'd: the tables are plain
     * I18n.register(code, {...}) calls, so the browser's own parser does the
     * work and there is no eval in the app. */
    function loadLanguage(code, done) {
        if (!code || code === 'en' || I18n.has(code)) {
            I18n.setLanguage(code || 'en');
            try { I18n.applyStatic(); } catch (eAs0) {}
            if (done) done(true);
            return;
        }
        var s = document.createElement('script');
        s.type = 'text/javascript';
        s.src = 'assets/lang/' + code + '.js';
        s.onload = function () {
            I18n.setLanguage(code);
            // Translate the static markup (side menu, settings, buttons,
            // placeholders) — without this only t() call sites change language.
            try { I18n.applyStatic(); } catch (eAs1) {}
            if (done) done(true);
        };
        s.onerror = function () {
            // Degrade to English rather than showing keys.
            Log.log('[i18n] failed to load ' + code + ', falling back to English');
            I18n.setLanguage('en');
            try { I18n.applyStatic(); } catch (eAs2) {}
            if (done) done(false);
        };
        document.head.appendChild(s);
    }

    /* Applying a language changes strings that are already rendered, so the
     * screens must be rebuilt. A full reload is the honest way to do it: the app
     * builds its DOM imperatively in dozens of places, and re-running every
     * renderer piecemeal would be a large surface for stale-string bugs. The
     * reload is fast (everything is cached) and only happens when the user
     * deliberately changes language. */
    function applyLanguage(code, reload) {
        var st = Store.getSettings();
        st.language = code;
        Store.setSettings(st);
        loadLanguage(code, function () {
            if (reload) {
                // This reload is intentional (user changed language), NOT a crash.
                // If VOD preload is mid-flight its crash guard is armed; a reload
                // while armed would look like a crash to the next boot and wrongly
                // drop it into recovery/Lite mode. Disarm first.
                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.clearCrashGuard) PerfConfig.clearCrashGuard(); } catch (eCg) {}
                window.location.reload();
            }
        });
    }

    function bootLanguage(done) {
        var st = Store.getSettings();
        loadLanguage((st && st.language) || 'en', done);
    }

    function showPerfNotice() {
        try {
            if (_perfNoticeShown) return;
            if (typeof PerfConfig === 'undefined') return;

            var st = Store.getSettings ? Store.getSettings() : {};

            // Lite condition: auto-applied Lite, not yet acknowledged on this device.
            var liteActive = PerfConfig.isLite() &&
                PerfConfig.getRequestedMode() === 'auto' &&
                !st.liteNoticeSeen;
            // Recovery-forced Lite (crash recovery) should also be surfaced.
            // A guide crash keeps Lite on until the user picks a mode, so tell them
            // once (epgLiteNoticeSeen), not on every boot.
            var epgCrashLite = !!(PerfConfig.getReason && PerfConfig.getReason() === 'epg-crash' && !st.epgLiteNoticeSeen);
            var recoveryLite = (PerfConfig.getReason && PerfConfig.getReason() === 'crash-recovery') || epgCrashLite;
            // IDB-unavailable-forced Lite: the device has no storage layer, so the
            // app dropped to reduced mode to avoid an out-of-memory crash on large
            // playlists. Surface it the same way as the other reduced-mode reasons.
            var idbLite = PerfConfig.getReason && PerfConfig.getReason() === 'idb-unavailable';
            // Cap condition: a VOD/series payload was skipped/truncated this
            // session, OR a pending flag persisted from a previous session that
            // may have crashed before it could show (then came up in Lite, which
            // skips the preload so capWasHit wouldn't be set again).
            var capped = (PerfConfig.capWasHit && PerfConfig.capWasHit()) ||
                (PerfConfig.capNoticePending && PerfConfig.capNoticePending());
            // Live cap: the CHANNEL LIST itself was truncated. Tracked separately
            // from the VOD/series cap because the consequence is different — the
            // channels are genuinely missing from the app, not merely absent from
            // search. It must NOT be folded into the "you can still browse
            // everything by category" message, which would be false.
            var liveCapped = (PerfConfig.liveCapWasHit && PerfConfig.liveCapWasHit()) ||
                (PerfConfig.liveCapNoticePending && PerfConfig.liveCapNoticePending());

            if (!liteActive && !recoveryLite && !idbLite && !capped && !liveCapped) return;

            // Decide WHICH messages apply now, but turn them into text only when the
            // modal is built (below). T() reads the active language table, which
            // loads asynchronously at boot (bootLanguage() is fire-and-forget), and
            // this function runs in the same tick: composing the text here always
            // produced English for every non-English language whenever the notice
            // was raised at boot (a persisted cap flag, auto-Lite, no storage).
            // Which cap kinds were hit is captured now, since it is in-memory state.
            var capKindsKey = capped ? ((PerfConfig.capKindsKey && PerfConfig.capKindsKey()) || 'both') : '';
            var composeLines = function () {
                var out = [];
                if (liveCapped) {
                    out.push(T('perf_notice_live_capped'));
                }
                if (capped) {
                    // Three complete sentences rather than one sentence with a noun
                    // substituted in: the noun changes the agreement of the words
                    // around it in most languages. Unknown kinds (e.g. the flag was
                    // persisted from an earlier session) use the "both" wording.
                    out.push(capKindsKey === 'movies' ? T('perf_notice_search_capped_movies')
                           : capKindsKey === 'series' ? T('perf_notice_search_capped_series')
                           : T('perf_notice_search_capped_both'));
                }
                if (idbLite) {
                    out.push(T('perf_notice_idb_lite'));
                } else if (liteActive || recoveryLite) {
                    out.push(T('perf_notice_lite_active'));
                }
                // The Settings line only makes sense when a setting can change what
                // the notice describes. A truncated list in Normal mode is by design
                // and no Performance Mode setting would bring it back, and a Lite
                // forced by crash recovery overrides the setting, so it is shown only
                // for an automatic Lite or a guide-crash Lite (both end when the user
                // picks a mode).
                if (idbLite) {
                    out.push(T('perf_notice_idb_auto'));
                } else if (liteActive || epgCrashLite) {
                    out.push(T('perf_notice_change_in_settings'));
                }
                return out;
            };

            _perfNoticeShown = true;
            // Remember if this notice was shown for the transient idb-unavailable
            // reason, so a late IDB recovery can retract it (post-wipe first open
            // can exceed the grace window, fire this, then recover moments later).
            _perfNoticeWasIdb = !!idbLite;
            // Persist the Lite acknowledgement so it isn't shown every boot.
            if (epgCrashLite) {
                try { st.epgLiteNoticeSeen = true; if (Store.setSettings) Store.setSettings(st); } catch (e2b) {}
            }
            if (liteActive) {
                try { st.liteNoticeSeen = true; if (Store.setSettings) Store.setSettings(st); } catch (e2) {}
            }
            // Clear any persisted cap-notice-pending flag now that we're showing it.
            try { if (PerfConfig.clearCapNoticePending) PerfConfig.clearCapNoticePending(); } catch (e3) {}
            try { if (PerfConfig.clearLiveCapNoticePending) PerfConfig.clearLiveCapNoticePending(); } catch (e3b) {}

            // Defer slightly so it doesn't fight the splash / first paint.
            setTimeout(function () {
                try {
                    var lines = composeLines();
                    var wrap = document.createElement('div');
                    for (var li = 0; li < lines.length; li++) {
                        var p = document.createElement('p');
                        p.className = 'modal-para';
                        p.textContent = lines[li];
                        wrap.appendChild(p);
                    }
                    UI.openModal({
                        title: T('ap_performance'),
                        bodyEl: wrap,
                        okText: T('ap_got_it'),
                        cancelText: false
                    });
                } catch (e) {}
            }, 1200);
        } catch (e) {}
    }

    function showLastCrashTrail() {
        // Surface the PREVIOUS run's breadcrumb trail on screen (readable
        // without the console/debugger). Only shows if a trail exists and it does
        // NOT end with a normal completion marker (i.e. the last run likely died).
        try {
            if (typeof PerfConfig === 'undefined' || !PerfConfig.readBreadcrumbs) return;
            if (!PerfConfig.diagEnabled || !PerfConfig.diagEnabled()) return;
            var trail = PerfConfig.readBreadcrumbs();
            if (!trail || !trail.length) return;
            var last = trail[trail.length - 1] || '';
            // If the last run finished series cleanly, no need to show a crash box.
            if (last.indexOf('series stream DONE') !== -1) return;
            var box = document.createElement('div');
            box.className = 'crash-trail-box';
            var title = document.createElement('div');
            title.className = 'crash-trail-title';
            title.textContent = T('last_run_trail_previous_boot');
            box.appendChild(title);
            var body = document.createElement('div');
            // Show only the tail if the trail is long, so it fits on screen.
            var shown = trail.length > 24 ? trail.slice(trail.length - 24) : trail;
            body.textContent = shown.join('\n');
            box.appendChild(body);
            var hint = document.createElement('div');
            hint.className = 'crash-trail-hint';
            hint.textContent = T('press_back_or_wait_60s_to');
            box.appendChild(hint);
            document.body.appendChild(box);
            var killed = false;
            var kill = function () {
                if (killed) return;
                killed = true;
                window._crashTrailKill = null;
                try { if (box && box.parentNode) box.parentNode.removeChild(box); } catch (e) {}
            };
            // Dismiss on BACK. The app's Remote handler (registered at boot, capture
            // phase) runs BEFORE any listener we could add here, so a separate
            // keydown listener loses the race — Remote's handleBack would pop the
            // exit prompt first, then our listener would close the overlay (both
            // happening on one fast BACK press). Instead, expose the kill fn and let
            // handleBack call it FIRST, so BACK closes the overlay and nothing else.
            window._crashTrailKill = kill;
            setTimeout(kill, 60000);
            box.addEventListener('click', kill);
        } catch (e) {}
    }

    var _epgRerenderThrottle = 0;
    var _epgTrailingTimer = null;
    // Toggle scroll-affordance classes on the VOD info panel so up/down chevron
    // glyphs appear when the synopsis actually has more to scroll — users won't
    // know the panel scrolls otherwise. Cheap; called on panel-enter and scroll.
    function updateVodScrollHint(infoEl) {
        if (!infoEl) return;
        // Inject the up/down chevron affordances once.
        if (!infoEl.querySelector('.vod-scroll-chevron.up')) {
            var up = document.createElement('div'); up.className = 'vod-scroll-chevron up';
            var dn = document.createElement('div'); dn.className = 'vod-scroll-chevron down';
            infoEl.appendChild(up); infoEl.appendChild(dn);
        }
        var body = infoEl.querySelector('.vod-info-body') || infoEl;
        var canScroll = body.scrollHeight > body.clientHeight + 4;
        var atTop = body.scrollTop <= 2;
        var atBottom = body.scrollTop >= (body.scrollHeight - body.clientHeight - 2);
        infoEl.classList.toggle('can-scroll-up', canScroll && !atTop);
        infoEl.classList.toggle('can-scroll-down', canScroll && !atBottom);
    }

    function refreshVisibleEpg() {
        // When a channel's programmes finish loading from IDB, nudge the active
        // EPG-bearing view to re-render so they appear. Throttled to avoid churn
        // when many async loads land together. Uses whatever refresh the UI
        // exposes; if none is available the data still shows on the next natural
        // render (channel navigation / screen change).
        var nowT = Date.now();
        if (nowT - _epgRerenderThrottle < 400) {
            // Within the throttle window: a burst of async fills is landing. Ensure
            // a refresh runs AFTER the burst settles. Re-arm the trailing timer on
            // EVERY fill (clear any pending one first) so the repaint always fires
            // ~450ms after the LAST fill, not the first — otherwise channels whose
            // IDB load completes late in (or after) the burst never paint, and which
            // rows have EPG ends up depending on load timing (non-deterministic).
            if (_epgTrailingTimer) { clearTimeout(_epgTrailingTimer); }
            _epgTrailingTimer = setTimeout(function () {
                _epgTrailingTimer = null;
                _epgRerenderThrottle = Date.now();
                doRefreshVisibleEpg();
            }, 450);
            return;
        }
        _epgRerenderThrottle = nowT;
        doRefreshVisibleEpg();
        // Also arm a trailing repaint after this immediate one, so any fills that
        // land in the quiet window just after (but before the next 400ms throttle
        // opens) still get painted rather than waiting for an unrelated trigger.
        if (_epgTrailingTimer) { clearTimeout(_epgTrailingTimer); }
        _epgTrailingTimer = setTimeout(function () {
            _epgTrailingTimer = null;
            _epgRerenderThrottle = Date.now();
            doRefreshVisibleEpg();
        }, 450);
    }
    function doRefreshVisibleEpg() {
        try {
            var screen = activeScreenId();
            // Live TV and Home both live inside the 'home' screen as SECTIONS, not as
            // their own .screen with id 'live'. Detect the active section so async EPG
            // fills actually repaint the now/next box and the guide rows. (The old
            // screen === 'live' check was never true, so rows never refreshed on fill.)
            var liveSectionActive = !!document.querySelector('.content-section[data-section-content="livetv"].active');
            if ((screen === 'home' || screen === 'live') && UI.refreshEpgNowNext) {
                UI.refreshEpgNowNext();
            }
            // Re-render the live guide ROWS when async EPG fills land, so they don't
            // stay on "No EPG data" until a manual navigation.
            if (liveSectionActive && UI.refreshLiveEpgRows) {
                UI.refreshLiveEpgRows();
            }
            // If the in-player mini channel list is open, its now-playing lines
            // also need to repaint when async/prefetched EPG lands.
            if (state.miniOpen && UI.refreshMiniChannels) {
                UI.refreshMiniChannels();
            }
        } catch (e) {}
    }

    function boot() {
        setSplashStatus('Initializing...');
        try { showLastCrashTrail(); } catch (eTrail) {}
        try { if (typeof Epg !== 'undefined' && Epg.setEpgRerenderHook) Epg.setEpgRerenderHook(refreshVisibleEpg); } catch (eHook) {}
        // Backstop for the deferred EPG-IDB clear: once boot has settled (playlists
        // loaded, IDB ready), clear stored EPG for any playlist left disabled, so a
        // deliberate toggle-off is honoured even if the app closed before its 60s
        // timer fired. Deferred so it doesn't race the boot EPG load.
        try { setTimeout(function () { try { reconcileDisabledEpg(); } catch (eR) {} }, 15000); } catch (eRt) {}
        /* Apply text-size from saved settings BEFORE
         * any UI renders, so users with a saved Large/Extra Large
         * preference see it immediately rather than flashing to
         * Normal first. */
        try {
            /* Mobile/tablet first: if this is the mobile build (or a mobile
             * browser), apply html[data-vp="mobile"] + form-factor attributes and
             * SKIP the TV 720/1080 branch below entirely — a phone must not be
             * tagged data-vp="720" or it would inherit the TV-720 layout. On all
             * TV builds Mobile.applyProfile() returns false and we fall through to
             * the unchanged 720/1080 logic. */
            var wentMobile = false;
            try { wentMobile = (typeof Mobile !== 'undefined' && Mobile.applyProfile()); } catch (eMob) {}
            // Touch is tagged on <html> INDEPENDENTLY of data-vp="mobile" —
            // isMobile() (and so applyProfile/data-vp) is currently hardcoded
            // off for the Android build (phones run the TV UI on purpose, see
            // Mobile.isMobile docs), but touch-only affordances like the
            // donate/bug-report links still need real styling instead of
            // falling through to unstyled default <a> tags (which is why they
            // looked "harsh" — bare blue underlined browser-default links).
            // CSS gates on this attribute wherever a touch-specific look is
            // needed but the full mobile layout isn't (necessarily) active.
            try {
                if (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView()) {
                    applyScreenMargin(String((Store.getSettings() || {}).screenMargin || 'off'));
                }
            } catch (eSm) {}
            try {
                if (typeof Mobile !== 'undefined' && Mobile.isTouch && Mobile.isTouch()) {
                    document.documentElement.setAttribute('data-touch', '1');
                    // On some phones in landscape, the front camera's
                    // cutout sits directly over the collapsed (icon-only, 80px)
                    // sidebar, so the Movies icon in particular was
                    // unreachable/obscured. The rail normally only expands while
                    // D-pad FOCUS is inside it (see the Focus.onChange handler
                    // below) and collapses the instant focus leaves — which on a
                    // touch device is almost immediately after every tap, so in
                    // practice it stayed collapsed nearly all the time. Touch
                    // devices get the expanded rail (existing .sidebar.expanded
                    // CSS, unchanged) permanently instead: still narrower than
                    // the whole icon column sitting flush against the cutout
                    // edge, but each row now also has its label extending well
                    // clear of that edge, so the row stays tappable even where
                    // the icon glyph itself lands under the cutout.
                    var sbEl = document.getElementById('sidebar');
                    if (sbEl) sbEl.classList.add('expanded');
                }
            } catch (eTouchTag) {}
            if (!wentMobile) {
                /* Pick the layout canvas: 1920 (default) or 720 (tv-720.css
                 * scales the 1920 layout to 0.667 for a genuine 1280x720 panel).
                 *
                 * The naive test — innerWidth <= 1366 -> 720 — is WRONG on some
                 * Android TV boxes. There, a real 1920x1080 panel reports
                 * window.innerWidth as 1280 (or 980, etc.) because the device
                 * density (devicePixelRatio, e.g. 1.5) divides the CSS pixels
                 * down: 1920 / 1.5 = 1280. Treating that as a 720 device applies
                 * the 0.667 scale ON TOP of a layout that is already 1920 —
                 * double-scaling, the shifted/shrunken rendering we saw.
                 *
                 * Distinguish REAL vs FAKE 720 with the innerWidth/clientWidth
                 * relationship and DPR:
                 *   - REAL 720p device: innerWidth ~= clientWidth ~= 1280, DPR ~1.
                 *   - FAKE 720 (1080 panel, high DPR): innerWidth (~1280) is the
                 *     CSS-px viewport, but documentElement.clientWidth reports the
                 *     true authored canvas (1920), and DPR > 1. The mismatch
                 *     (clientWidth much larger than innerWidth, and/or DPR > ~1.25)
                 *     means it's really a 1920 canvas — do NOT apply 720.
                 *
                 * The native shell also pins initialScale so innerWidth reports
                 * ~1920 directly; this JS guard is the belt-and-braces so we pick
                 * 720 ONLY for a device that is genuinely 720-class. */
                var iw = window.innerWidth || 0;
                var cw = (document.documentElement && document.documentElement.clientWidth) || 0;
                var dpr = window.devicePixelRatio || 1;
                var vpw = iw || cw || 1920;

                // Is this a genuine small-canvas (720-class) device?
                var reallySmall =
                    vpw > 0 && vpw <= 1366 &&      // reports a small width, AND
                    dpr <= 1.25 &&                 // not a high-density (faked) panel, AND
                    !(cw && iw && cw >= iw * 1.4); // clientWidth isn't reporting a much larger real canvas

                if (reallySmall) {
                    document.documentElement.setAttribute('data-vp', '720');
                } else {
                    document.documentElement.removeAttribute('data-vp');
                }
            }
        } catch (eVp) {}
        try {
            var bootSt = Store.getSettings ? Store.getSettings() : {};
            applyTextSize(bootSt.textSize || 'normal');
            /* Apply the saved language for the same reason: strings must be right
             * on FIRST paint, not swapped in afterwards.
             *
             * The table for a non-English language loads asynchronously (a script
             * tag), so it may not be ready before the first render. That is
             * deliberate and safe: I18n falls back to English per-key, so an early
             * render shows English and the reload triggered on a language CHANGE
             * puts everything right. In practice the table is a small file served
             * from the same package and lands long before the playlist does.
             *
             * setLanguage() is also what sets <html dir="rtl"> for Arabic, so the
             * layout mirrors as early as possible rather than visibly flipping. */
            bootLanguage();
        } catch (tsErr) {}
        // Resolve the performance mode (Normal/Lite) before any parsing or UI
        // work, so every lever reads the right value from the first load. Safe
        // no-op if the module is somehow absent.
        try {
            if (typeof PerfConfig !== 'undefined') PerfConfig.resolve();
        } catch (perfErr) {}
        // IndexedDB is the spill/cache layer that keeps the big live+EPG+VOD+series
        // dataset off the heap. If it's unavailable (missing, private mode, or the
        // open()-stall some WebOS builds hit), there's no spill layer and a large
        // provider would push the resident set back toward the ~330k-entry ceiling
        // that historically OOM-crashed weak devices. Probe it up front; if it
        // can't open, force Lite (skips VOD/series indexing, tightens parse caps)
        // and tell the user once. This runs before the playlist preload, so the
        // re-resolved mode is in effect by the time the heavy work starts. Dormant
        // when IDB works — the probe just resolves true and nothing changes.
        try {
            if (typeof IDB !== 'undefined' && IDB.init) {
                // If the handle is adopted late (after any grace window), undo the
                // forced-Lite + retract the stale "storage unavailable" notice.
                try { if (IDB.onLateRecover) IDB.onLateRecover(onIdbRecovered); } catch (eReg) {}
                IDB.init().then(function (ok) {
                    // A slow post-wipe/upgrade open can resolve init() false at the
                    // unblock timeout and THEN complete a moment later (the handler
                    // is no longer detached, so the handle gets adopted late). Don't
                    // force Lite on the strength of that first false — give the late
                    // adopt a brief grace window and re-check before degrading.
                    function forceLiteNoIdb() {
                        if (typeof PerfConfig !== 'undefined' && PerfConfig.setIdbUnavailable) {
                            PerfConfig.setIdbUnavailable(true);
                            PerfConfig.resolve();
                            try { if (PerfConfig.breadcrumb) PerfConfig.breadcrumb('IDB unavailable -> forced Lite (no spill layer)'); } catch (eBd) {}
                            try { _perfNoticeShown = false; showPerfNotice(); } catch (eN) {}
                        }
                    }
                    if (!ok) {
                        // Re-check after a grace window; a late onsuccess may have
                        // flipped IDB.isReady() true by now.
                        setTimeout(function () {
                            if (IDB.isReady && IDB.isReady()) {
                                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('IDB opened late — cache adopted, staying full mode'); } catch (eLl) {}
                                return; // handle came alive; do not force Lite
                            }
                            forceLiteNoIdb();
                        }, 4000);
                    }
                })['catch'](function () {});
            }
        } catch (eIdbProbe) {}
        showPerfNotice();
        startPerfMonitor();
        // Leaving the screen mid-load (home / recents / swipe-away) is the user
        // closing the app, not a crash: pause the crash marker while hidden and
        // restore it if the app comes back while the load is still running.
        try {
            document.addEventListener('visibilitychange', function () {
                if (typeof PerfConfig === 'undefined') return;
                if (document.hidden) { if (PerfConfig.suspendCrashGuard) PerfConfig.suspendCrashGuard(); }
                else if (PerfConfig.resumeCrashGuard) PerfConfig.resumeCrashGuard();
            });
            window.addEventListener('pagehide', function () {
                if (typeof PerfConfig !== 'undefined' && PerfConfig.suspendCrashGuard) PerfConfig.suspendCrashGuard();
            });
        } catch (eVis) {}
        // If this is a recovery boot (the previous boot crashed), arm the guard
        // again up front so that if even this lighter boot crashes, the count
        // escalates (level 1 -> 2 -> force Lite, which also drops the EPG boot
        // preload). A normal boot arms the guard later, around the VOD preload.
        try {
            if (typeof PerfConfig !== 'undefined' && PerfConfig.getRecoveryLevel &&
                PerfConfig.getRecoveryLevel() >= 1 && PerfConfig.armCrashGuard) {
                PerfConfig.armCrashGuard();
            }
        } catch (eArmR) {}
        // Crash-guard self-heal for the light-boot case: when crash recovery
        // skipped the VOD preload this boot, that preload never runs to reach
        // its own guard-clear. So if we're still alive a while after boot, treat
        // the start as successful and clear the marker — letting a device that
        // recovered (or switched to a smaller playlist) return to normal next
        // time. Only armed when the preload was skipped; when the preload runs,
        // it clears the guard itself on completion (and clearing on a timer here
        // could fire mid-parse, before a real crash, defeating the guard).
        setTimeout(function () {
            try {
                if (typeof PerfConfig !== 'undefined' &&
                    PerfConfig.getRecoveryLevel && PerfConfig.getRecoveryLevel() >= 1 &&
                    PerfConfig.clearCrashGuard) {
                    PerfConfig.clearCrashGuard();
                }
            } catch (e) {}
        }, 20000);
        Focus.init();
        Remote.init();
        Player.init();
        Parental.wrapPlayerAccessGate();
        bindVideoScaleRefresh();
        setTimeout(bindVideoScaleRefresh, 500);
        UI.init();
        if (window.LiveTopMiniPlayer && LiveTopMiniPlayer.init) LiveTopMiniPlayer.init();

        var verEl = $('#appVerVal');
        if (verEl) verEl.textContent = APP_CONFIG.APP_VERSION;

        // Settings UI -> state
        wireSettings();
        wireNav();
        wireManualEntry();
        wirePlaylistButtons();
        wirePlayerOverlay();
        wireVodInfoPanelButtons();
        wireSyncUI();
        Parental.wireParentalControls();

        // Apply content-type preferences to the side menu now that the
        // nav buttons exist. Re-fires later on cloud pull and on
        // settings change.
        applyContentTypeVisibility();

        /* Refresh UI surfaces on any CloudSync auth
         * state change (sign-in / sign-out / token refresh). The event
         * is dispatched by CloudSync's Firebase onAuthStateChanged
         * listener; refreshSignInUI re-renders whatever surfaces
         * display auth status. */
        document.addEventListener('cloudsync-auth-changed', function () {
            refreshSignInUI();
            applyContentTypeVisibility();
        });
        wireRemote();

        // Wire manage category buttons
        var liveMgr = document.getElementById('liveTvManageCats');
        if (liveMgr) liveMgr.addEventListener('click', function () { Parental.openCategoryManager('livetv'); });
        var movieMgr = document.getElementById('movieManageCats');
        if (movieMgr) movieMgr.addEventListener('click', function () { Parental.openCategoryManager('movies'); });
        var seriesMgr = document.getElementById('seriesManageCats');
        if (seriesMgr) seriesMgr.addEventListener('click', function () { Parental.openCategoryManager('series'); });

        var liveContentMgr = document.getElementById('liveTvManageContent');
        if (liveContentMgr) liveContentMgr.addEventListener('click', function () { Parental.openContentLockManager('livetv'); });
        var movieContentMgr = document.getElementById('movieManageContent');
        if (movieContentMgr) movieContentMgr.addEventListener('click', function () { Parental.openContentLockManager('movies'); });
        var seriesContentMgr = document.getElementById('seriesManageContent');
        if (seriesContentMgr) seriesContentMgr.addEventListener('click', function () { Parental.openContentLockManager('series'); });

        wireCardActionBars();


        // Handle app relaunch / visibility change (WebOS home button)
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' || !document.hidden) {
                Util.log('App visibility restored');
                Focus.refresh();
                // Back from another player app: the picture played there, so leave the player
                // screen (and its old error) and return to the list or card it was opened from.
                if (activeScreenId() === 'player') {
                    var backFromExternal = false;
                    try { backFromExternal = !!Player.consumeExternalReturn(); } catch (eEx) {}
                    if (backFromExternal) { try { exitPlayer(); } catch (eXp) {} }
                    else { try { Player.resume(); } catch (e) {} }
                }
            } else {
                // App going to background — pause video to save resources
                Util.log('App going to background');
                try { Player.noteBackgrounded(); } catch (eNb) {}
                try { Player.pause(); } catch (e) {}
                // Release the IndexedDB connection so it can't linger and block
                // the next open while the webview stays warm in the background
                // (the cause of playlists not loading until a power-cycle). init()
                // reopens lazily on the next read/write.
                try { if (typeof IDB !== 'undefined' && IDB.close) IDB.close(); } catch (eIdb) {}
                // Release screen wake lock
                try {
                    if (typeof tizen !== 'undefined' && tizen.power) tizen.power.release('SCREEN');
                } catch (e) {}
            }
        });
        // WebOS: when user taps app icon again after backgrounding, webOSRelaunch fires
        document.addEventListener('webOSRelaunch', function (evt) {
            Util.log('webOSRelaunch received');
            // Bring the app back to a usable state
            var screen = activeScreenId();
            if (!screen || screen === 'splash') {
                goHome();
            }
            Focus.refresh();
        });
        // WebOS: also listen for webOSSystem events
        if (typeof window.webOSSystem !== 'undefined') {
            try {
                // Ensure app doesn't fully close on back
                window.webOSSystem.onclose = function () {
                    Util.log('webOSSystem.onclose — preventing full close');
                    // Don't actually close — let the system background us
                };
            } catch (e) {}
        }

        // Decide initial screen
        var pls = Store.getPlaylists();
        setSplashStatus('Loading...');
        setTimeout(function () {
            if (!pls.length) goOnboarding();
            else goHome();
        }, 600);
    }

    function setSplashStatus(s) {
        var el = $('#splashStatus');
        if (el) el.textContent = s;
    }

    /* ===== Card-view action bar wiring (Phase 5) =====
     * The bar's buttons are alternates for controls that already exist in list view,
     * so each reuses the existing path rather than duplicating logic:
     *   - Search: opens the same on-screen keyboard on the section's search field.
     *   - Manage buttons: the same Parental managers the list-view buttons call.
     *   - Category dropdown: lists the section's existing .panel-cat-item elements and
     *     clicks the chosen one, so category load + lock checks run exactly as a
     *     list-view category click would.
     * The category button label is kept in sync with the active category. */
    function updateCardCatName(section) {
        var nameId = section === 'series' ? 'seriesCardCatName' : 'movieCardCatName';
        var nameEl = document.getElementById(nameId);
        if (!nameEl) return;
        var nm = (UI.getVodCardActiveName ? UI.getVodCardActiveName(section) : '');
        if (nm) nameEl.textContent = nm;
    }

    function openCardCategoryPicker(section) {
        var cats = UI.getVodCardCategories ? UI.getVodCardCategories(section) : [];
        if (!cats.length) return;
        var names = [];
        var lockedArr = [];
        var pcActive = !!(window.Access && Access.isEnabled && Access.isEnabled());
        for (var i = 0; i < cats.length; i++) {
            var cnm = cats[i]._catName || cats[i].name || '';
            names.push(cats[i].name || cnm);
            lockedArr.push(pcActive && Parental.isCategoryLocked && Parental.isCategoryLocked(section, cnm));
        }
        var activeIdx = UI.getVodCardActiveIndex ? UI.getVodCardActiveIndex(section) : 0;
        if (activeIdx < 0) activeIdx = 0;
        UI.openListPicker({
            title: T('ui_categories') || 'Categories',
            items: names,
            selected: activeIdx,
            locked: lockedArr,
            filterable: true,
            onSelect: function (idx) {
                if (UI.selectVodCardCategory) UI.selectVodCardCategory(section, idx);
                updateCardCatName(section);
            }
        });
    }

    function wireCardActionBars() {
        var sections = ['movie', 'series'];
        for (var s = 0; s < sections.length; s++) {
            (function (pfx) {
                var section = (pfx === 'series') ? 'series' : 'movies';
                var catBtn = document.getElementById(pfx + 'CardCat');
                if (catBtn) catBtn.addEventListener('click', function () { openCardCategoryPicker(section); });
                var searchBtn = document.getElementById(pfx + 'CardSearch');
                if (searchBtn) searchBtn.addEventListener('click', function () {
                    var fld = document.getElementById(pfx + 'SearchField');
                    // In card view the field is display:none, so pass the search
                    // button as the return-focus target — otherwise closing the
                    // keyboard restores focus to a hidden input and it's lost.
                    if (fld && UI.openVKeyboard) UI.openVKeyboard(fld, searchBtn);
                });
                var mCats = document.getElementById(pfx + 'CardManageCats');
                if (mCats) mCats.addEventListener('click', function () { Parental.openCategoryManager(section); });
                var mContent = document.getElementById(pfx + 'CardManageContent');
                if (mContent) mContent.addEventListener('click', function () { Parental.openContentLockManager(section); });
            })(sections[s]);
        }
        // Live card action bar (mirrors movies/series, live handlers).
        var liveCatBtn = document.getElementById('liveCardCat');
        if (liveCatBtn) liveCatBtn.addEventListener('click', function () { openLiveCardCategoryPicker(); });
        var liveSearchBtn = document.getElementById('liveCardSearch');
        if (liveSearchBtn) liveSearchBtn.addEventListener('click', function () {
            var fld = document.getElementById('liveSearchField');
            if (fld && UI.openVKeyboard) UI.openVKeyboard(fld, liveSearchBtn);
        });
        var liveMCats = document.getElementById('liveCardManageCats');
        if (liveMCats) liveMCats.addEventListener('click', function () { Parental.openCategoryManager('livetv'); });
        var liveMContent = document.getElementById('liveCardManageContent');
        if (liveMContent) liveMContent.addEventListener('click', function () { Parental.openContentLockManager('livetv'); });
    }

    function updateLiveCardCatName() {
        var nameEl = document.getElementById('liveCardCatName');
        if (!nameEl) return;
        var nm = (UI.getLiveCardActiveName ? UI.getLiveCardActiveName() : '');
        if (nm) nameEl.textContent = nm;
    }

    function openLiveCardCategoryPicker() {
        var cats = UI.getLiveCardCategories ? UI.getLiveCardCategories() : [];
        if (!cats.length) return;
        var names = [];
        var lockedArr = [];
        var pcActive = !!(window.Access && Access.isEnabled && Access.isEnabled());
        for (var i = 0; i < cats.length; i++) {
            names.push(cats[i].display || cats[i].name || '');
            lockedArr.push(pcActive && cats[i].name !== '__all__' && Parental.isCategoryLocked && Parental.isCategoryLocked('livetv', cats[i].name));
        }
        var activeIdx = UI.getLiveCardActiveIndex ? UI.getLiveCardActiveIndex() : 0;
        if (activeIdx < 0) activeIdx = 0;
        UI.openListPicker({
            title: T('ui_categories') || 'Categories',
            items: names,
            selected: activeIdx,
            locked: lockedArr,
            filterable: true,
            onSelect: function (idx) {
                if (UI.selectLiveCardCategory) UI.selectLiveCardCategory(idx);
                updateLiveCardCatName();
            }
        });
    }

    /* ========== Onboarding (pairing) ========== */
    function goOnboarding() {
        UI.showScreen('onboarding');
        var urlEl = $('#pairUrl');
        var pairUrlText = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '');
        // The pairing address is a tappable link ONLY inside the Android app.
        // MainActivity's shouldOverrideUrlLoading hands http(s) taps to the
        // system browser, which only exists on Android; on webOS/Tizen there
        // is no such handoff, so a link there is a dead control. Everywhere
        // else it stays plain text next to the QR, exactly as it always was.
        //
        // Deliberately keyed on "is this the Android app", NOT on
        // Mobile.isTouch(): touch detection is unreliable on some generic
        // Android boxes (firmware can declare a touchscreen with none
        // present), and a wrong answer there is what used to change this
        // screen's DOM and focus order. On Android the QR and the link are
        // therefore both always shown, and the link is not .focusable, so
        // it can never become or block the initial D-pad focus target.
        var isAndroidApp = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());
        if (urlEl) {
            Util.empty(urlEl);
            if (isAndroidApp) {
                var pairLink = document.createElement('a');
                pairLink.className = 'pair-url-link';
                pairLink.textContent = pairUrlText;
                pairLink.href = (pairUrlText.indexOf('://') === -1 ? 'https://' : '') + pairUrlText;
                pairLink.target = '_blank';
                pairLink.rel = 'noopener noreferrer';
                urlEl.appendChild(pairLink);
            } else {
                urlEl.textContent = pairUrlText;
            }
        }
        // Surface the Lite-mode notice on the first screen the user sees when
        // Auto has resolved to Lite for this device, so reduced behaviour isn't
        // mistaken for a fault.
        try {
            var liteNote = $('#onboardLiteNote');
            if (liteNote && typeof PerfConfig !== 'undefined' &&
                PerfConfig.isLite() && PerfConfig.getRequestedMode() === 'auto') {
                liteNote.classList.remove('init-hidden');
                // Flag the column so CSS can reserve room below the centered
                // stack for the fixed disclaimer — at X-Large + long languages the
                // note and disclaimer otherwise converge to a few px (see
                // .onboard-col.right.has-lite-note).
                var liteCol = liteNote.parentNode;
                if (liteCol && liteCol.classList) liteCol.classList.add('has-lite-note');
            }
        } catch (eLite) {}
        // Touch/Remote Mode override was previously also surfaced here on
        // the onboarding screen (mirroring Settings), but the onboarding
        // QR/link fix (see CHANGELOG) means this screen no longer needs
        // to react to touch detection at all — both options are always
        // shown regardless, so there's nothing left for this control to
        // fix on this specific screen. Removed from onboarding; it remains
        // available in Settings.
        startPairFlow();
        // Set initial focus on the first button
        setTimeout(function () {
            var scr = document.getElementById('onboarding');
            if (scr) Focus.focusFirstIn(scr);
        }, 100);
    }

    // Consecutive auto-refresh guard. The countdown auto-requests a new code on
    // expiry; on a flaky LAN (or against the server's 10/min pair-create rate
    // limit) that can loop indefinitely with the user stuck on "Refreshing".
    // Bail out after a few consecutive AUTO refreshes and ask the user to act.
    // Reset on any manual refresh or successful code issue that the user acts on.
    var pairAutoRefreshCount = 0;
    var PAIR_AUTO_REFRESH_MAX = 3;
    function startPairFlow(isAuto) {
        stopPairPoll();
        stopPairCountdown();
        if (!isAuto) pairAutoRefreshCount = 0;
        var codeEl = $('#pairCode');
        if (codeEl) codeEl.textContent = '...';
        Api.createPairCode(Store.getDeviceId()).then(function (resp) {
            if (!resp || !resp.code) throw new Error('no code');
            state.pairCode = resp.code;
            state.pairExpiresAt = resp.expiresAt || (Date.now() + 2 * 60 * 1000);
            if (codeEl) codeEl.textContent = resp.code;
            renderPairQr(resp.code);
            schedulePairPoll();
            startPairCountdown();
        })['catch'](function (e) {
            Util.logErr('createPairCode failed', e);
            if (codeEl) codeEl.textContent = T('error');
            var expEl = $('#pairExpires');
            if (expEl) expEl.textContent = '';
            UI.toast(T('pairing_server_unreachable_use_manual_entry'), 'err');
        });
    }

    /* Pair-code countdown. Reads state.pairExpiresAt
     * (set by server v9 in the POST /api/pair response) and updates
     * #pairExpires once per second. When the code expires, the server
     * returns 410 on the next poll which the existing pair-poll flow
     * already handles (it triggers a refresh). We just stop the timer
     * locally and let the user see "Expired — refresh to continue". */
    var pairCountdownTimer = null;
    function stopPairCountdown() {
        if (pairCountdownTimer) {
            clearInterval(pairCountdownTimer);
            pairCountdownTimer = null;
        }
    }
    function startPairCountdown() {
        stopPairCountdown();
        var expEl = $('#pairExpires');
        if (!expEl) return;
        function tick() {
            var ms = (state.pairExpiresAt || 0) - Date.now();
            if (ms <= 0) {
                /* Auto-refresh on expiry. Previously
                 * the countdown stopped at 0:00 and the user had to
                 * press Refresh. There's no reason for that friction —
                 * the TV is the same device that originally requested
                 * the code; we can just request a new one. The pair
                 * screen stays visible the whole time.
                 * Guard: after PAIR_AUTO_REFRESH_MAX consecutive auto
                 * refreshes, stop and ask the user to act, so a flaky
                 * LAN or a rate-limited server can't spin forever. */
                stopPairCountdown();
                pairAutoRefreshCount++;
                if (pairAutoRefreshCount > PAIR_AUTO_REFRESH_MAX) {
                    pairAutoRefreshCount = 0;
                    expEl.textContent = T('code_expired_press_refresh_to_continue');
                    return;
                }
                expEl.textContent = T('refreshing_code');
                // Defer slightly so the "Refreshing" text shows briefly
                setTimeout(function () { startPairFlow(true); }, 200);
                return;
            }
            var sec = Math.floor(ms / 1000);
            var m = Math.floor(sec / 60);
            var s = sec % 60;
            expEl.textContent = T('code_expires_in') + ' ' + m + ':' + (s < 10 ? '0' + s : s);
        }
        tick();
        pairCountdownTimer = setInterval(tick, 1000);
    }

    function renderPairQr(code) {
        var canvas = $('#qrCanvas');
        if (!canvas) return;
        Util.empty(canvas);
        try {
            var url = APP_CONFIG.PAIR_SERVER.replace(/\/$/, '') + '/?code=' + encodeURIComponent(code);
            // qrcode.js exposes QRCode.render(container, text, opts)
            if (typeof QRCode !== 'undefined' && QRCode.render) {
                // Size the QR to the actual box. The renderer writes the canvas's
                // inline width/height from this value, and inline styles beat the
                // stylesheet, so a hardcoded size overflows a scaled (720) box and
                // spills over the caption. offsetWidth reflects the CSS-scaled box.
                var qrSize = canvas.offsetWidth || 320;
                QRCode.render(canvas, url, {
                    size: qrSize,
                    background: '#ffffff',
                    foreground: '#000000',
                    margin: 2
                });
            } else {
                canvas.textContent = code;
            }
        } catch (e) {
            Util.logErr('QR render failed', e);
            canvas.textContent = code;
        }
    }

    function schedulePairPoll() {
        stopPairPoll();
        state.pairTimer = setInterval(function () {
            if (!state.pairCode) return;
            Api.checkPairCode(state.pairCode).then(function (resp) {
                if (!resp) return;
                if (resp.status === 'completed' && resp.payload) {
                    // Refuse a payload whose schema version this app doesn't
                    // support — defensive against a compromised/buggy pairing
                    // server. A server that omits the field (older server) is
                    // allowed through for backward compatibility; only a PRESENT
                    // version outside our supported range is rejected.
                    var sv = resp.payloadSchemaVersion;
                    if (sv != null && sv !== PAIR_PAYLOAD_SCHEMA_VERSION) {
                        stopPairPoll();
                        UI.toast(T('pairing_failed_this_app_version_does') + sv + ').', 'err');
                        return;
                    }
                    onPairCompleted(resp.payload);
                }
            })['catch'](function () { /* swallow - retry next tick */ });
        }, APP_CONFIG.PAIR_POLL_MS || 3000);
    }
    function stopPairPoll() {
        if (state.pairTimer) { clearInterval(state.pairTimer); state.pairTimer = null; }
        stopPairCountdown();
    }

    /* Top-level pull-prompt helper, callable from any
     * sign-in flow. Distinct from the Settings-screen-scoped
     * promptPullOnSignIn — this one knows nothing about updateSyncUI or
     * refocus and just invokes onComplete when the user is done.
     *
     * Used by:
     *   - Sign-in via pairing (onPairCompleted → applyAuthThenContinue)
     *   - Future flows that need the same prompt
     *
     * onComplete is called whether the user chose Pull or Keep local,
     * AFTER the pull (if any) finishes. */
    function confirmPullThen(onComplete) {
        function done() { if (typeof onComplete === 'function') onComplete(); }
        if (!window.CloudSync || typeof CloudSync.pull !== 'function') {
            done();
            return;
        }
        UI.openModal({
            title: T('ap_pull_title'),
            body: T('ap_pull_body'),
            okText: T('ap_pull_now'),
            cancelText: T('ap_keep_local'),
            onOk: function () {
                UI.toast(T('pulling_cloud_data'), null);
                CloudSync.pull().then(function (data) {
                    UI.toast(T('cloud_data_pulled'), 'ok');
                    refreshSignInUI();
                    done();
                    // Cloud copy is ZK with the key locked this session — prompt
                    // for the passphrase so synced creds can be decrypted.
                    if (data && data.zkLocked && typeof _zkUnlockFlowRef === 'function') {
                        _zkUnlockFlowRef();
                    }
                })['catch'](function (err) {
                    UI.toast(T('pull_failed') + ' ' + (err.message || err), 'err')
                    refreshSignInUI();
                    done();
                });
            },
            onCancel: function () {
                refreshSignInUI();
                done();
            }
        });
    }

    /* Refresh whatever UI surfaces show the sign-in
     * status, after sign-in happens via pairing (or any other path
     * outside the Settings → Sync screen). Today this just re-renders
     * the Settings sync block. If we add other status indicators
     * (e.g. a corner badge), they hook in here. */
    var _updateSyncUIRef = null;
    // Populated inside wireSyncUI(); lets module-level pull flows (e.g. the
    // pairing sign-in pull) trigger the passphrase unlock prompt when a pull
    // comes back zkLocked.
    var _zkUnlockFlowRef = null;
    function refreshSignInUI() {
        // _updateSyncUIRef is populated inside wireSyncUI() at boot.
        // Best-effort — if the function isn't available yet (boot
        // hasn't reached wireSyncUI), do nothing; the next refresh
        // will catch it.
        if (typeof _updateSyncUIRef === 'function') {
            try { _updateSyncUIRef(); } catch (e) {}
        }
    }

    function onPairCompleted(payload) {
        stopPairPoll();
        if (!payload || typeof payload !== 'object') {
            UI.toast(T('pairing_returned_empty_payload'), 'err');
            return;
        }

        // A payload may carry an optional __auth piggyback
        // (Firebase custom token from the pairing page) alongside any main
        // payload. We always do the sign-in FIRST, then continue with the
        // primary payload. If the TV is already signed in as a different
        // account, we ask for confirmation before swapping sessions.
        var authBundle = payload.__auth || null;

        // Strip __auth before forwarding so downstream code doesn't see it.
        var primaryPayload = payload;
        if (authBundle) {
            primaryPayload = {};
            for (var k in payload) {
                if (payload.hasOwnProperty(k) && k !== '__auth') primaryPayload[k] = payload[k];
            }
        }

        function continueWithPrimary() {
            // Special: action='sync-only' means there is no primary payload
            // — the auth handoff itself is the whole request. We're already
            // done at this point (auth and any optional pull were applied
            // above), just toast and exit.
            if (primaryPayload.action === 'sync-only') {
                /* Refresh sign-in UI surfaces so the
                 * settings → sync screen reflects the new auth state if
                 * the user navigates to it. */
                refreshSignInUI();
                UI.toast(T('sign_in_complete_on_this_tv'), 'ok');
                if (state.pairCode) Api.closePairCode(state.pairCode);
                state.pairCode = null;
                goHome();
                return;
            }
            // Legacy email/password sync-signin path (older pairing server).
            if (primaryPayload.action === 'sync-signin') {
                if (window.CloudSync && CloudSync.signInEmail) {
                    CloudSync.signInEmail(primaryPayload.email || '', primaryPayload.password || '').then(function () {
                        if (CloudSync.pull) return CloudSync.pull();
                        return null;
                    }).then(function () {
                        UI.toast(T('signed_in_and_synced_from_pairing'), 'ok');
                        goHome();
                    })['catch'](function (e) {
                        UI.toast(T('sync_sign_in_failed'), 'err');
                    });
                } else {
                    UI.toast(T('cloud_sync_is_not_available'), 'err');
                }
                if (state.pairCode) Api.closePairCode(state.pairCode);
                state.pairCode = null;
                return;
            }
            // EPG-only payload from the External EPG tab.
            if (primaryPayload.action === 'set-external-epg') {
                try {
                    var stEpg = Store.getSettings ? Store.getSettings() : {};
                    var urlsEpg = [];
                    var authEpg = [];
                    if (primaryPayload.externalEpgUrls && primaryPayload.externalEpgUrls.length) {
                        var pAuth = primaryPayload.externalEpgAuth || [];
                        for (var ei = 0; ei < primaryPayload.externalEpgUrls.length && urlsEpg.length < 3; ei++) {
                            var v = String(primaryPayload.externalEpgUrls[ei] || '').replace(/^\s+|\s+$/g, '');
                            urlsEpg.push(v);
                            var a = pAuth[ei];
                            authEpg.push((a && (a.user || a.pass)) ? { user: a.user || '', pass: a.pass || '' } : null);
                        }
                    }
                    // Drop trailing empty URLs, keeping auth aligned.
                    while (urlsEpg.length && !urlsEpg[urlsEpg.length - 1]) { urlsEpg.pop(); authEpg.pop(); }
                    stEpg.externalEpgUrls = urlsEpg;
                    stEpg.externalEpgUrl = urlsEpg.length ? urlsEpg[0] : '';
                    var anyAuth = false;
                    for (var aj = 0; aj < authEpg.length; aj++) if (authEpg[aj]) anyAuth = true;
                    if (anyAuth) stEpg.externalEpgAuth = authEpg;
                    else if (stEpg.hasOwnProperty('externalEpgAuth')) delete stEpg.externalEpgAuth;
                    stEpg.externalEpgOverride = primaryPayload.externalEpgOverride === 'on' ? 'on' : 'off';
                    Store.setSettings(stEpg);
                    try { updateEpgSummary(); } catch (eSum) {}
                    UI.toast(T('external_epg_sources_updated_reload_playlist'), 'ok');
                    // Close the pairing/onboarding screen the same way the playlist
                    // path does, then actually load the newly-added EPG so it parses,
                    // indexes and repaints — rather than leaving the user on the
                    // onboarding screen with the source merely stored.
                    if (state.pairCode) Api.closePairCode(state.pairCode);
                    state.pairCode = null;
                    try {
                        var onOnboarding = !!document.querySelector('#onboarding.active') ||
                                           (typeof activeScreenId === 'function' && activeScreenId() === 'onboarding');
                        if (onOnboarding && Store.getActivePlaylistId && Store.getActivePlaylistId()) {
                            // Just leave the onboarding screen — do NOT call goHome(),
                            // which re-runs loadPlaylistChannels (a full channel/VOD/
                            // series reload). The playlist is already loaded; only the
                            // EPG needs to load, which reloadEpgForActive does below.
                            try { UI.showScreen('home'); } catch (eSh) {}
                            try { UI.renderHome(); } catch (eRh) {}
                        }
                    } catch (eNav) {}
                    try { reloadEpgForActive(); } catch (eRl) {}
                } catch (epgErr) {
                    Util.logErr('Pairing: failed to apply external EPG sources', epgErr);
                    UI.toast(T('failed_to_apply_epg_sources'), 'err');
                    if (state.pairCode) Api.closePairCode(state.pairCode);
                    state.pairCode = null;
                }
                return;
            }

            // Playlist payload: { type: 'm3u', ... } or { type: 'xtream', ... }
            var pl = makePlaylistFromPayload(primaryPayload);
            if (!pl) {
                UI.toast(T('pairing_returned_invalid_playlist'), 'err');
                if (state.pairCode) Api.closePairCode(state.pairCode);
                state.pairCode = null;
                return;
            }
            addPlaylist(pl);
            // Apply content-type preferences from the pairing payload
            // if the server sent them. The pairing form always submits
            // a contentTypes object; older server builds without the
            // field simply leave the preference unset and the TV will
            // show the in-app picker on next launch.
            // Per-playlist contentTypes from the pairing payload are carried
            // onto the playlist object by makePlaylistFromPayload; just refresh
            // the side-menu visibility for the (now active) playlist.
            applyContentTypeVisibility();
            if (primaryPayload.externalEpgUrls && primaryPayload.externalEpgUrls.length) {
                try {
                    var stPair = Store.getSettings ? Store.getSettings() : {};
                    var extPair = [];
                    var authPair = [];
                    var pAuth2 = primaryPayload.externalEpgAuth || [];
                    for (var ep = 0; ep < primaryPayload.externalEpgUrls.length && extPair.length < 3; ep++) {
                        var epUrl = String(primaryPayload.externalEpgUrls[ep] || '').replace(/^\s+|\s+$/g, '');
                        if (!epUrl) continue;
                        extPair.push(epUrl);
                        var a2 = pAuth2[ep];
                        authPair.push((a2 && (a2.user || a2.pass)) ? { user: a2.user || '', pass: a2.pass || '' } : null);
                    }
                    stPair.externalEpgUrls = extPair;
                    stPair.externalEpgUrl = extPair.length ? extPair[0] : '';
                    var anyPairAuth = false;
                    for (var ak = 0; ak < authPair.length; ak++) if (authPair[ak]) anyPairAuth = true;
                    if (anyPairAuth) stPair.externalEpgAuth = authPair;
                    else if (stPair.hasOwnProperty('externalEpgAuth')) delete stPair.externalEpgAuth;
                    stPair.externalEpgOverride = primaryPayload.externalEpgOverride === 'on' ? 'on' : 'off';
                    Store.setSettings(stPair);
                    try { updateEpgSummary(); } catch (eSum2) {}
                } catch (pairEpgErr) {}
            }
            if (state.pairCode) Api.closePairCode(state.pairCode);
            state.pairCode = null;
            UI.toast(T('playlist_paired') + (pl.name ? ' ' + pl.name : ''), 'ok')
            activatePlaylist(pl.id, true);
        }

        function applyAuthThenContinue() {
            if (!window.CloudSync || !CloudSync.signInWithCustomToken) {
                UI.toast(T('cloud_sync_is_not_available_pairing'), 'err');
                continueWithPrimary();
                return;
            }
            CloudSync.signInWithCustomToken(authBundle.customToken).then(function () {
                UI.toast(T('signed_in_as') + ' ' + (authBundle.email || 'account') + '.', 'ok')
                /* Was — silent auto-pull immediately
                 * after sign-in. Now prompts the user "Pull cloud data?
                 * [Pull now] [Keep local]" so they can choose. This
                 * matches the Settings → Sign In flow and avoids the
                 * surprise of having local data silently overwritten
                 * by cloud state.
                 *
                 * After the user decides, continueWithPrimary runs as
                 * before — applying any playlist payload that came
                 * alongside __auth (or just goHome for sync-only). */
                confirmPullThen(continueWithPrimary);
            })['catch'](function (e) {
                Util.logErr('Pairing: signInWithCustomToken failed', e);
                UI.toast(T('sign_in_via_pairing_failed') + ' ' + ((e && e.message) || 'unknown'), 'err')
                // Don't continue the primary payload — if the user expected
                // their session to sync, silently applying their playlist
                // without sign-in would be misleading.
                if (state.pairCode) Api.closePairCode(state.pairCode);
                state.pairCode = null;
            });
        }

        if (authBundle) {
            // If we're already signed into Firebase as a DIFFERENT account,
            // confirm before swapping. The TV's local data will be replaced
            // with whatever's synced for the new account.
            var currentEmail = (window.CloudSync && CloudSync.getUserEmail) ? CloudSync.getUserEmail() : null;
            var currentlySignedIn = !!(window.CloudSync && CloudSync.isSignedIn && CloudSync.isSignedIn());
            var newEmail = authBundle.email || '(another account)';
            if (currentlySignedIn && currentEmail && currentEmail !== newEmail) {
                UI.openModal({
                    title: T('ap_switch_account'),
                    body: T('ap_switch_body', { current: currentEmail, next: newEmail }),
                    okText: T('ap_sign_in_as', { name: newEmail }),
                    cancelText: T('cancel'),
                    onOk: function () { applyAuthThenContinue(); },
                    onCancel: function () {
                        UI.toast(T('pairing_cancelled_account_on_tv_unchanged'), null);
                        if (state.pairCode) Api.closePairCode(state.pairCode);
                        state.pairCode = null;
                    }
                });
                return;
            }
            // Same account or not signed in — proceed without confirmation.
            applyAuthThenContinue();
            return;
        }

        // No auth piggyback — just process the primary payload as before.
        continueWithPrimary();
    }

    function makePlaylistFromPayload(p) {
        if (!p || !p.type) return null;
        var base = { id: Util.uuid(), name: p.name || (p.type === 'xtream' ? 'Xtream' : 'Playlist'), type: p.type };
        // Per-playlist content selection from the pairing payload (server v10+).
        // Normalized/defaulted by the Store when read; stored raw here.
        if (p.contentTypes && typeof p.contentTypes === 'object') {
            base.contentTypes = p.contentTypes;
        }
        // Per-playlist EPG enable from the pairing payload (server v12+).
        // Default true when the field is absent.
        if (typeof p.epgEnabled === 'boolean') {
            base.epgEnabled = p.epgEnabled;
        }
        if (p.type === 'm3u') {
            // M3U arrives either as inline content (uploaded file embedded in the
            // pairing payload — no server URL ever touches the TV) or as a remote
            // url the TV fetches itself. Accept either; require one.
            if (typeof p.content === 'string' && p.content.length) {
                base.content = p.content;
                base.url = '';
            } else if (p.url) {
                base.url = p.url;
            } else {
                return null;
            }
            base.epgUrl = p.epgUrl || '';
            // Basic-auth creds from the pairing funnel for a protected M3U URL
            // and/or its EPG URL (they can differ). Only carried when present.
            if (p.authUser || p.authPass) { base.authUser = p.authUser || ''; base.authPass = p.authPass || ''; }
            if (p.epgAuthUser || p.epgAuthPass) { base.epgAuthUser = p.epgAuthUser || ''; base.epgAuthPass = p.epgAuthPass || ''; }
        } else if (p.type === 'xtream') {
            if (!p.host || !p.user || !p.pass) return null;
            base.host = p.host;
            base.user = p.user;
            base.pass = p.pass;
        } else if (p.type === 'stalker') {
            if (!p.url || !p.mac) return null;
            base.url = p.url;
            base.mac = p.mac;
            base.serial = p.serial || '';
            base.deviceId = p.deviceId || '';
            if (p.stbModel) base.stbModel = String(p.stbModel).slice(0, 32);
        } else return null;
        return base;
    }

    /* ========== Home / playlist activation ========== */
    function goHome() {
        UI.showScreen('home');
        var activeId = Store.getActivePlaylistId();
        var pls = Store.getPlaylists();
        if (!activeId && pls.length) {
            activeId = pls[0].id;
            Store.setActivePlaylistId(activeId);
        }
        if (activeId) {
            loadPlaylistChannels(activeId);
        } else {
            UI.setActivePlaylistChip('No playlist', 0);
            UI.renderHome();
        }
        // Show last played channel in hero
        var lastCh = Store.getLastChannel();
        if (lastCh) {
            UI.renderHeroFromChannel(lastCh);
        }
        // Auto-resume last channel if setting enabled
        var settings = Store.getSettings();
        if (settings.autoResume === 'on' && lastCh && lastCh.url) {
            // If last channel is from a different playlist, activate that playlist first
            if (lastCh.playlistId && lastCh.playlistId !== activeId) {
                var plExists = findPlaylist(lastCh.playlistId);
                if (plExists) {
                    Store.setActivePlaylistId(lastCh.playlistId);
                    loadPlaylistChannels(lastCh.playlistId);
                }
            }
            UI.showScreen('player');
            Player.play(lastCh);
            return;
        }
        UI.showSection('home');
        setTimeout(function () { Focus.focusKey('nav-home'); }, 200);
        setTimeout(function () {
            if (window.Access) {
                var pc = Access.cfg();
                if (pc && pc.enabled && pc.startup === 'on' && !Access.isUnlocked()) {
                    Access.requirePin(T('ap_unlock_app'), function () {});
                }
            }
        }, 600);
    }


    function getPlaylistTotalCount(pl, liveCount) {
        var total = liveCount || 0;
        try {
            if (pl && pl.type === 'xtream') {
                var st = Store.raw && Store.raw.get ? Store.raw.get('xtreamCounts.' + pl.id, null) : null;
                if (st && typeof st.total === 'number') return st.total;
            }
        } catch (e) {}
        return total;
    }

    function setPlaylistTotalCount(pl, liveCount, vodCount, seriesCount) {
        var total = (liveCount || 0) + (vodCount || 0) + (seriesCount || 0);
        try {
            if (pl && Store.raw && Store.raw.set) Store.raw.set('xtreamCounts.' + pl.id, { live: liveCount || 0, vod: vodCount || 0, series: seriesCount || 0, total: total });
        } catch (e) {}
        UI.setActivePlaylistChip(pl ? pl.name : '', total);
        return total;
    }

    /* Does this playlist lack a usable source on THIS device?
     *
     * Credentials/secrets are NOT synced across devices by default (they're in
     * cloudsync's SECRET_FIELDS and get shell-stripped), so a playlist synced
     * from another TV can arrive missing them. This mirrors cloudsync's own
     * hasCreds check so the two never disagree:
     *   Xtream : needs user + pass.
     *   Stalker: needs mac (the MAC address is treated as a credential — it is a
     *            stripped secret field, so a synced Stalker shell lacks it).
     *   M3U    : ready with EITHER a remote url OR embedded content (an uploaded
     *            file is delivered as inline content with no url — via the pairing
     *            server's file-upload path, or restored from a local copy). It
     *            needs a source only when it has neither. (Requiring a url here
     *            wrongly flagged every uploaded-file M3U as "credentials needed"
     *            and routed it to manual entry.)
     *
     * credsNeeded is an explicit flag set elsewhere (e.g. by a cloud pull that
     * couldn't restore a shell's secrets); it always forces the gate. */
    function playlistNeedsCreds(pl) {
        if (!pl) return false;
        if (pl.credsNeeded) return true;
        if (pl.type === 'xtream') return (!pl.user || !pl.pass);
        if (pl.type === 'stalker') return !pl.mac;
        if (pl.type === 'm3u') return !(pl.url || (pl.content && pl.content.length));
        return false;
    }

    function loadPlaylistChannels(playlistId) {
        var pl = findPlaylist(playlistId);
        if (!pl) return;
        // Credential gate. A playlist synced as a "shell" from another device has
        // no provider credentials on THIS device (creds aren't synced by default),
        // so loading it would fail with "0 items" / a load error. Guard here — the
        // choke point every load path funnels through — because the boot auto-load
        // calls loadPlaylistChannels directly (bypassing activatePlaylist's guard).
        // On this path DON'T force the edit form open (it would race the rest of
        // the boot sequence — hero render, auto-resume). Instead bail cleanly into
        // an empty state with a clear message; the user taps the playlist (an
        // activatePlaylist call) to be routed to credential entry deliberately.
        var needsCreds = playlistNeedsCreds(pl);
        if (needsCreds || pl.credsNeeded) {
            if (window.console && console.log) {
                Log.log('[creds-gate] load blocked for "' + (pl.name || '') + '"' +
                    ' type=' + pl.type +
                    ' hasUser=' + !!pl.user + ' hasPass=' + !!pl.pass +
                    ' hasUrl=' + !!pl.url + ' credsNeeded=' + !!pl.credsNeeded);
            }
            UI.setChannels([]);
            try { UI.setActivePlaylistChip(pl.name + ' — credentials needed', 0); } catch (eChip) {}
            if (UI.renderHome) UI.renderHome();
            UI.toast(T('this_playlist_needs_credentials_open_it'), null);
            return;
        }
        // Reset per-session performance-notice state so a freshly (re)loaded
        // playlist — e.g. cleared and re-added within this session — can surface
        // the cap notice again instead of being suppressed by the prior load.
        _perfNoticeShown = false;
        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.resetCapState) PerfConfig.resetCapState(); } catch (eRc) {}

        // Load-sequence token. Each call bumps the counter and captures its value;
        // every async completion below checks isStale() before touching the UI, so
        // late results from a playlist the user already switched away from can't
        // overwrite the current playlist's channels / chip / totals / search / EPG.
        var mySeq = (state.playlistLoadSeq = (state.playlistLoadSeq || 0) + 1);
        function isStale() {
            return mySeq !== state.playlistLoadSeq ||
                !(Store.getActivePlaylistId && Store.getActivePlaylistId() === playlistId);
        }

        // Free every other playlist's parsed EPG before loading this one. Only the
        // active playlist's EPG is shown, but switching used to leave the previous
        // playlist's EPG resident, so two large datasets stacked in memory and
        // OOM'd the TV on switch (a single playlist left alone never hit this).
        if (typeof Epg !== 'undefined' && Epg.clearAllExcept) {
            try { Epg.clearAllExcept(playlistId); } catch (e) {}
        }

        // Per-playlist content selection: if Live is disabled, skip the live
        // channel fetch, the live search index, and (downstream) EPG — but
        // still preload VOD/series so a VOD-only playlist loads its content.
        var ct = Store.getPlaylistContentTypes
            ? Store.getPlaylistContentTypes(pl.id)
            : { live: true, movies: true, series: true };

        // Mark catalog indexing in-progress AS SOON as we know this playlist will
        // preload movies/series — which is knowable from content types right here,
        // ~4-5s BEFORE the deferred VOD/series preload actually starts. Every chip
        // paint below (including the no-Live branch, which previously painted a bare
        // "0 items") then reflects "Indexing… {n}" immediately instead of showing a
        // settled 0 that makes the user think nothing is happening. Xtream only (M3U
        // has no separate VOD step). maybeFireTotalsToast flips it false when done.
        if (pl.type === 'xtream' && (ct.movies !== false || ct.series !== false)) {
            state.catalogIndexing = true;
        }

        if (!ct.live) {
            UI.setChannels([]);
            UI.setActivePlaylistChip(pl.name, getPlaylistTotalCount(pl, 0));
            UI.hideLoading();
            UI.renderHome();
            if (typeof GlobalSearch !== 'undefined') {
                setTimeout(function () {
                    if (isStale()) return;
                    GlobalSearch.buildIndex({ channels: [], movies: [], series: [] });
                    try { preloadVodForSearch(pl, mySeq); } catch (e) { Log.log('[Search] preload error:', e); }
                }, 1200);
            }
            return;
        }

        UI.showLoading('Loading ' + pl.name + '...');

        // Stalker: load GENRES first (cheap) and show them as categories, then load the WHOLE
        // channel list in the background (UI.startStalkerLoadAll: one streamed request, or a paged
        // walk if the portal has no get_all_channels). Genres are then split locally, so opening one
        // makes no portal call, and live channels become searchable. If that load fails, genres fall
        // back to being fetched one at a time when opened (the old behaviour).
        if (pl.type === 'stalker') {
            UI.setStalkerMode(pl);
            (function loadGenres(retriesLeft) {
                Api.stalkerGenres(pl).then(function (res) {
                    if (isStale()) return;
                    var genres = (res && res.genres) || [];
                    UI.setStalkerGenres(pl, genres);
                    UI.setActivePlaylistChip(pl.name, genres.length + ' categories');
                    UI.hideLoading();
                    UI.renderHome();
                    UI.toast(T('toast_categories_loaded', { name: pl.name, n: genres.length }), 'ok');
                    // Let the UI paint first, then start the whole-list load.
                    setTimeout(function () { if (!isStale() && UI.startStalkerLoadAll) UI.startStalkerLoadAll(pl); }, 800);
                })['catch'](function (e) {
                    if (isStale()) return;
                    var status = e && e.status;
                    var transient = (status === 429 || status === 503 || status === 504 || !status);
                    if (retriesLeft > 0 && transient) {
                        // The portal rate-limits; back off and retry rather than
                        // failing the whole load on a transient 429.
                        var delay = 1000 + (3 - retriesLeft) * 800;
                        setTimeout(function () { if (!isStale()) loadGenres(retriesLeft - 1); }, delay);
                        return;
                    }
                    UI.hideLoading();
                    UI.toast(T('failed_to_load_portal') + ' ' + UI.stalkerErrText(e), 'err')
                });
            })(3);
            return;
        }

        // Non-Stalker playlist: ensure Stalker lazy mode is off so the guide
        // reverts to the normal channel-bucketing path.
        if (UI.clearStalkerMode) UI.clearStalkerMode();

        // Track whether the network parse has already painted, so a late
        // IndexedDB cache read doesn't clobber fresher network channels.
        var networkArrived = false;

        // Use cache for instant display while loading from network.
        // The synchronous localStorage read only holds small playlists; large
        // ones (the common case here) live in IndexedDB, so also try the async
        // reader. Guard both against staleness and against overwriting a
        // network result that may have already arrived.
        var cached = Store.readCachedChannels(pl.id);
        if (cached && cached.length) {
            UI.setChannels(cached);
            UI.setActivePlaylistChip(pl.name, getPlaylistTotalCount(pl, cached.length));
            UI.hideLoading();
            UI.renderHome();
        } else if (Store.readCachedChannelsAsync) {
            Store.readCachedChannelsAsync(pl.id).then(function (idbCached) {
                // Bail if the user switched playlists, the network result
                // already painted, or there was nothing cached.
                if (isStale() || networkArrived) return;
                if (!idbCached || !idbCached.length) return;
                cached = idbCached;
                UI.setChannels(idbCached);
                UI.setActivePlaylistChip(pl.name, getPlaylistTotalCount(pl, idbCached.length));
                UI.hideLoading();
                UI.renderHome();
            })['catch'](function () {});
        }

        Parser.load(pl).then(function (channels) {
            // A late Parser.load result for a playlist the user already left must
            // not repaint the current playlist's channels/chip/search/EPG.
            if (isStale()) return;
            networkArrived = true;
            // Fetch expiry for Xtream playlists
            if (pl.type === 'xtream' && Api.xtreamAuth) {
                Api.xtreamAuth(pl.host, pl.user, pl.pass).then(function (auth) {
                    if (isStale()) return;
                    if (auth && auth.user_info && auth.user_info.exp_date) {
                        var exp = parseInt(auth.user_info.exp_date, 10);
                        if (exp > 0) {
                            pl.expiry = exp * 1000; // Convert to ms
                            Store.updatePlaylist(pl);
                            UI.updatePlaylistExpiry(pl.id, pl.expiry);
                        }
                    }
                })['catch'](function () {});
            }
            // Re-render when there's no cache, the count changed, or a cheap
            // signature (first/last channel id) differs — count-only missed cases
            // where names/logos/URLs changed but the count happened to match.
            function chSig(list) {
                if (!list || !list.length) return '0';
                var f = list[0], l = list[list.length - 1];
                return list.length + ':' + ((f && (f.id || f.url)) || '') + ':' + ((l && (l.id || l.url)) || '');
            }
            var needsRerender = !cached || chSig(cached) !== chSig(channels);
            UI.setChannels(channels);
            // Decide the indexing state BEFORE the first chip paint. For an Xtream
            // playlist that will preload movies/series, mark indexing now so the very
            // first chip render shows "Indexing… {n}" instead of a bare "0 items" —
            // which is what happened when no Live content was paired (channels.length
            // is 0 and the flag was previously set AFTER this render). The equivalent
            // assignment further down is now redundant for Xtream but harmless.
            if (pl.type === 'xtream') {
                var _ctEarly = (pl.contentTypes || {});
                if (_ctEarly.movies !== false || _ctEarly.series !== false) {
                    state.catalogIndexing = true;
                }
            }
            UI.setActivePlaylistChip(pl.name, getPlaylistTotalCount(pl, channels.length));
            UI.hideLoading();
            if (needsRerender) UI.renderHome();
            // Phrase the early toast so it's clear what's been
            // loaded so far. For Xtream playlists the VOD/series totals will
            // arrive later via preloadVodForSearch and fire a follow-up toast
            // with the full item count. For M3U playlists this is the full
            // total because there is no separate VOD step.
            if (pl.type === 'xtream') {
                UI.toast(T('toast_live_loaded', { name: pl.name, n: channels.length }), 'ok');
                // Item 2: search covers live now but NOT movies/series yet — mark
                // indexing in-progress immediately so the Search screen's "still
                // loading" notice shows from this point, not only once the VOD
                // preload actually starts (which is deferred until after EPG, ~9s+
                // later). Only when this playlist will actually preload VOD/series.
                var _ct = (pl.contentTypes || {});
                if (_ct.movies !== false || _ct.series !== false) {
                    state.catalogIndexing = true;
                }
            } else {
                UI.toast(T('toast_items', { name: pl.name, n: channels.length }), 'ok');
            }
            // Build global search index with live channels. Deferred so the
            // live UI paints and settles before indexing begins. The heavier
            // VOD/series preload+indexing is NOT started here: on big catalogs
            // it indexes ~100k+ items and, starting at ~1.2s, it monopolized the
            // boot thread right through the EPG load window and starved the EPG
            // parse on slow TVs (the guide then only appeared after toggling EPG
            // off/on). It is now kicked off only after the EPG load settles —
            // see startVodPreloadAfterEpg() below.
            if (typeof GlobalSearch !== 'undefined') {
                setTimeout(function () {
                    if (isStale()) return;
                    GlobalSearch.buildIndex({ channels: channels, movies: [], series: [] });
                }, 1200);
            }
            // Kick the VOD/series preload once — either after the EPG load
            // resolves, or right away when there is no EPG step to wait for.
            // Guarded so it can only run a single time per load.
            var vodPreloadStarted = false;
            function startVodPreloadAfterEpg() {
                if (vodPreloadStarted) return;
                vodPreloadStarted = true;
                if (typeof GlobalSearch === 'undefined') return;
                // Two guards between the EPG phase and the movie preload. First the
                // preload waits until the guide has been written to IndexedDB and
                // its programme lists dropped from the heap (Epg.whenSettled, capped
                // at EPG_SETTLE_MAX_MS so a stuck write cannot block movies for
                // good): the guide's ~180k programme objects used to stay resident
                // through the whole movie download and parse, which is what ran a
                // 347MB heap out. Then a short idle gap lets GC reclaim the guide's
                // transient strings before the large movie fetch starts.
                var EPG_TO_MOVIES_GAP_MS = 2000;
                var EPG_SETTLE_MAX_MS = 15000;
                var _settleWait = Promise.resolve(false);
                try {
                    if (window.Epg && Epg.whenSettled && pl && pl.id) _settleWait = Epg.whenSettled(pl.id, EPG_SETTLE_MAX_MS);
                } catch (eSw) {}
                _settleWait.then(function (settled) {
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(settled ? 'EPG settled; releasing VOD preload' : 'VOD preload released (no EPG write pending or wait timed out)'); } catch (eSb) {}
                    setTimeout(runVodPreload, EPG_TO_MOVIES_GAP_MS);
                });
                function runVodPreload() {
                    if (isStale()) return;
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('VOD preload start'); } catch (eDiag) {}
                    // Fresh crash-breadcrumb trail for this VOD attempt. The
                    // PREVIOUS run's trail was already read + surfaced at boot
                    // (see showLastCrashTrail), so it's safe to reset now.
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('VOD preload start'); } catch (eBc) {}
                    try { preloadVodForSearch(pl, mySeq); } catch (e) {
                        Log.log('[Search] preload error:', e);
                    }
                }
            }
            // Log sample tvg-ids so we can diagnose EPG key mismatches.
            if (window.console && console.log) {
                var samples = [];
                var withIds = 0;
                for (var i = 0; i < channels.length; i++) {
                    var id = channels[i].tvgId || channels[i].epgId;
                    if (id) {
                        withIds++;
                        if (samples.length < 5) samples.push(id);
                    }
                }
                Log.log('[Channels] ' + withIds + '/' + channels.length + ' have tvg/epg ids');
                if (samples.length) Log.log('[Channels] sample tvg ids (first 5): ' + samples.join(', '));
            }
            // Delay EPG start so TV UI can finish painting before heavy XMLTV work begins.
            // EPG parsing itself is also chunked in epg.js, but starting it immediately after boot
            // can still cause a visible webOS frame stall on some TVs.
            // Per-playlist EPG toggle: skip the automatic boot EPG load when the
            // provider EPG is disabled — UNLESS an external EPG source has been
            // added. The toggle means "don't use the provider's EPG", not "never
            // show any guide", so an explicitly-added external source still loads.
            var epgOn = Store.getPlaylistEpgEnabled ? Store.getPlaylistEpgEnabled(pl.id) : true;
            if (!epgOn) {
                try {
                    var stExt = Store.getSettings ? Store.getSettings() : {};
                    var hasExt = (stExt.externalEpgUrls && stExt.externalEpgUrls.length) || stExt.externalEpgUrl;
                    if (hasExt) epgOn = true;
                } catch (eExtChk) {}
            }
            // Performance policy: Lite skips the automatic boot-time EPG preload
            // (the guide still loads on demand when the user opens it). Normal
            // preloads as before.
            var epgBootOn = true;
            try {
                if (typeof PerfConfig !== 'undefined' && PerfConfig.get('epgBootPreload') === false) {
                    epgBootOn = false;
                }
            } catch (ePerf) {}
            if (epgOn && epgBootOn) {
                if (state.epgLoadTimer) {
                    try { clearTimeout(state.epgLoadTimer); } catch (epgTimerErr) {}
                }
                // Delay before the EPG fetch so the channel list and home UI have
                // settled first — the EPG download is large (60-75MB+) and heavy,
                // and starting it while the UI is still painting competes for the
                // thread on weak TVs. Widened from 6.5s to 9s after a bigger
                // (74MB) EPG on a slow device; the guide isn't needed in the
                // first seconds, so a later start costs nothing visible.
                var EPG_BOOT_DELAY_MS = 9000;
                state.epgLoadTimer = setTimeout(function () {
                    if (isStale()) return;
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('EPG timer fired -> Epg.load'); } catch (eDiag) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.resetBreadcrumbs) { PerfConfig.resetBreadcrumbs(); PerfConfig.breadcrumb('EPG load start'); } } catch (eBcR) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.armEpgGuard) PerfConfig.armEpgGuard(); } catch (eEg) {}
                    // Item 1: tell the user the guide is loading (it starts ~9s
                    // after channels, so without this the guide silently populating
                    // later looks like nothing happened). Paired with a "loaded"
                    // toast on resolve. Only shown when the playlist actually has an
                    // EPG source: epgOn just means the per-playlist EPG toggle is on,
                    // not that a source URL exists, so without this check a playlist
                    // with no EPG still flashed "Loading TV guide" then "loaded".
                    var epgHasSource = false;
                    try { epgHasSource = !!(window.Epg && Epg.hasEpgSource && Epg.hasEpgSource(pl)); } catch (eHasSrc) {}
                    if (epgHasSource) {
                        guideToast();
                    }
                    try { if (Epg.setWantedChannels) Epg.setWantedChannels(pl.id, channels); } catch (eWc) {}
                    // Disarm the guide crash guard once the guide has finished loading
                    // AND been written out (or on failure): a death before that leaves
                    // the marker, and the next boot comes up in Lite.
                    var disarmEpgGuard = function () {
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.clearEpgGuard) PerfConfig.clearEpgGuard(); } catch (eDg) {}
                    };
                    Epg.load(pl).then(function () {
                        try { Epg.whenSettled(pl.id, 120000).then(disarmEpgGuard); } catch (eWs) { disarmEpgGuard(); }
                        if (!isStale()) {
                            if (epgHasSource) {
                                try { if (window.UI && UI.toast) UI.toast(T('tv_guide_loaded'), 'ok'); } catch (eEpgT2) {}
                            }
                            UI.renderHeroFromChannel(Player.currentChannel() || channels[0]);
                            try { UI.renderHome(); } catch (epgRenderErr) {}
                            // Guide finished loading: if the user is already sitting on
                            // Live (list view), its rows may have rendered "No EPG data"
                            // before the guide was ready. Repaint them now so they fill
                            // automatically, instead of only on a manual leave/return.
                            try {
                                if (document.querySelector('.content-section[data-section-content="livetv"].active') && UI.refreshLiveEpgRows &&
                                    !(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                                    UI.refreshLiveEpgRows();
                                }
                            } catch (eLiveEpg) {}
                        }
                        // EPG is done (or was skipped as stale) — now start the
                        // heavy VOD/series preload without contending with it.
                        startVodPreloadAfterEpg();
                    })['catch'](function () {
                        disarmEpgGuard();
                        // Even if the EPG load fails, don't strand the VOD preload.
                        startVodPreloadAfterEpg();
                    });
                }, EPG_BOOT_DELAY_MS);
            } else {
                // No boot EPG load to wait for (disabled per-playlist, or Lite
                // skips it): start the VOD preload on the normal short delay.
                setTimeout(startVodPreloadAfterEpg, 1200);
            }
        })['catch'](function (e) {
            Util.logErr('Parser.load failed', e);
            UI.hideLoading();
            if (e && e.userMessage) {
                UI.toast(e.userMessage, 'err');
            } else {
                var _detail = (e && e.err != null) ? String(e.err).replace(/^\s+|\s+$/g, '') : '';
                if (_detail === 'null' || _detail === 'undefined') _detail = '';
                UI.toast(_detail ? (T('failed_to_load_playlist') + ' ' + _detail) : T('failed_to_load_playlist'), 'err');
            }
        });
    }

    /* Lite mode: update the totals chip from the cached movie/series lists
     * without any network preload or search indexing. Reads whatever the IDB
     * cache holds (from a prior Normal run); if a type isn't cached yet its
     * count is simply 0 until the user has run Normal once. Respects the
     * playlist's content-type selection and the stale-load guard. */
    function updateLiteTotalsFromCache(pl, seq) {
        if (!pl || !Store.readContentAsync) return;
        function stale() { return seq != null && seq !== state.playlistLoadSeq; }
        if (stale()) return;
        var ct = (Store.getPlaylistContentTypes)
            ? Store.getPlaylistContentTypes(pl.id)
            : { live: true, movies: true, series: true };
        var liveCount = (window.UI && UI.getChannelsCount) ? UI.getChannelsCount() : 0;
        var counts = { vod: 0, series: 0 };
        function apply() {
            if (stale()) return;
            try { setPlaylistTotalCount(pl, liveCount, counts.vod, counts.series); } catch (e) {}
        }
        var pending = 0;
        function done() { pending--; if (pending <= 0) apply(); }
        if (ct.movies) {
            pending++;
            Store.readContentAsync('vod', pl.id).then(function (list) {
                counts.vod = (list && list.length) ? list.length : 0; done();
            })['catch'](function () { done(); });
        }
        if (ct.series) {
            pending++;
            Store.readContentAsync('series', pl.id).then(function (list) {
                counts.series = (list && list.length) ? list.length : 0; done();
            })['catch'](function () { done(); });
        }
        // If neither type is enabled, still refresh the chip with the live count.
        if (pending === 0) apply();
    }

    function buildSeriesCatMap(cats) {
        var m = {};
        if (cats && cats.length) {
            for (var i = 0; i < cats.length; i++) {
                var c = cats[i];
                if (c && c.category_id != null) m[String(c.category_id)] = c.category_name || '';
            }
        }
        return m;
    }

    // Per-playlist one-shot "force a fresh fetch, bypass the cache" flag. Mirrors
    // EPG_FORCE. Set when a content type is toggled ON via the playlist card so
    // enabling a type always re-fetches fresh (matching pre-cache behaviour), with
    // no dependence on the async eviction landing first. Checked+cleared in the gate.
    var VOD_CACHE_FORCE = {};

    // --- Content-toggle coalescing + per-kind load generations -------------------
    // Rapid/accidental toggling (off/on/off, possibly across multiple types) must
    // settle to the FINAL state and act once, not fire a load per intermediate
    // flip. Each (playlistId, kind) has a generation that bumps on every toggle; a
    // surgical load captures its generation and aborts at paint/index time if it's
    // been superseded. Toggles are debounced so a burst collapses into one action.
    var _ctGen = {};                 // "id\u0001kind" -> integer generation
    var _ctToggleTimers = {};        // id -> debounce timer
    var _ctPendingBefore = {};       // id -> content types captured BEFORE the burst
    var CT_TOGGLE_DEBOUNCE_MS = 400;
    function _ctGenKey(id, kind) { return id + '\u0001' + kind; }
    function ctGeneration(id, kind) { return _ctGen[_ctGenKey(id, kind)] || 0; }
    function bumpCtGeneration(id, kind) {
        var k = _ctGenKey(id, kind);
        _ctGen[k] = (_ctGen[k] || 0) + 1;
        return _ctGen[k];
    }

    // 30-day TTL for the Movies/Series catalogue cache. Catalogues change rarely;
    // a manual playlist refresh or a source change invalidates sooner (see
    // Store.contentSourceKey). Confirmed model against EPG's TTL+sourceSetKey gate.
    var VOD_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    // Read side of the catalogue cache. If a FRESH cache exists for this
    // (kind, playlist) — source-key matches AND within TTL — load the slim chunks
    // and rebuild the index from them via importSlim, skipping the network fetch.
    // Resolves the rebuilt row count (>0 = cache hit, index populated) or 0 (miss/
    // stale/disabled/error -> caller streams from network as before). Never throws.
    function tryRebuildFromCache(cacheKind, searchKind, pl, forceFresh) {
        try {
            var st = (Store.getSettings ? Store.getSettings() : {}) || {};
            if (st.cacheVod === 'off') return Promise.resolve(0); // toggle off -> always fresh fetch
            // Per-load force (e.g. a content type was just toggled ON): bypass the
            // cache so the user gets a guaranteed fresh fetch for every kind.
            if (forceFresh) {
                try { Log.log('[Cache] ' + searchKind + ' force-fresh (cache bypassed for this load)'); } catch (eF) {}
                return Promise.resolve(0);
            }
            if (typeof IDB === 'undefined' || !IDB.getItemsMeta || !IDB.getItems || !GlobalSearch.importSlim) {
                return Promise.resolve(0);
            }
            var wantKey = Store.contentSourceKey ? Store.contentSourceKey(pl) : '';
            return IDB.getItemsMeta(cacheKind, pl.id).then(function (meta) {
                if (!meta || !meta.total) return 0;                       // no cache
                if (meta.sourceKey !== wantKey) return 0;                 // source changed
                if (!meta.savedAt || (Date.now() - meta.savedAt) > VOD_CACHE_TTL_MS) return 0; // stale (TTL)
                // Fresh — load the slim entries and rebuild the index.
                return IDB.getItems(cacheKind, pl.id).then(function (items) {
                    if (!items || !items.length) return 0;
                    var n = GlobalSearch.importSlim(items);
                    try { Log.log('[Cache] ' + searchKind + ' rebuilt from cache (' + n + ' rows' + (meta.partial ? ', partial prefix' : '') + ') — skipped network'); } catch (eL) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' cache read ok (' + n + (meta.partial ? ' partial' : '') + ')'); } catch (eB) {}
                    return n;
                })['catch'](function () { return 0; });
            })['catch'](function () { return 0; });
        } catch (e) { return Promise.resolve(0); }
    }

    function preloadVodForSearch(pl, seq, onlyKind) {
        if (!pl || pl.type !== 'xtream') return;
        // Wait for IDB init to settle before the heavy VOD/series work. IDB is the
        // spill layer; if it's unavailable the boot probe forces Lite (see boot()),
        // but that resolution is async. Gating the preload on IDB.init() here means
        // the idb-unavailable -> Lite override is guaranteed to be in effect before
        // shouldSkipVodPreload() is read below — closing the race where the preload
        // could otherwise start in Normal and OOM on a device that has no cache
        // layer. When IDB is fine this adds only the (already-cached) init promise.
        var idbGate = (typeof IDB !== 'undefined' && IDB.init) ? IDB.init() : Promise.resolve(true);
        idbGate.then(function () { preloadVodForSearchInner(pl, seq, onlyKind); })['catch'](function () { preloadVodForSearchInner(pl, seq, onlyKind); });
    }

    function preloadVodForSearchInner(pl, seq, onlyKind) {
        if (!pl || pl.type !== 'xtream') return;
        // Consume the one-shot force-fresh flag ONCE for this whole load (both
        // movies and series run under this call). Reading it per-kind would let the
        // first kind clear it and the second fall back to cache.
        var _forceFreshLoad = !!VOD_CACHE_FORCE[pl.id];
        if (_forceFreshLoad) VOD_CACHE_FORCE[pl.id] = false;
        // Skip the boot-time VOD/series network preload + indexing when either
        // Lite disables it OR crash recovery is forcing a light boot (the
        // previous boot crashed, most likely OOM during this very work on a huge
        // catalog). The content screens still fetch on demand when opened, and
        // the totals chip is filled from the IndexedDB cache — cheap, no network,
        // no indexing — so the app can start.
        var skipPreload = false;
        try {
            skipPreload = (typeof PerfConfig !== 'undefined' &&
                PerfConfig.shouldSkipVodPreload && PerfConfig.shouldSkipVodPreload());
        } catch (ePerf) {}
        if (skipPreload) {
            updateLiteTotalsFromCache(pl, seq);
            // Preload skipped (Lite/crash recovery) — nothing will index, so clear
            // the in-progress flag set when live finished (item 2) or the Search
            // notice would stick forever.
            state.catalogIndexing = false;
            try { if (window.Sports && Sports.indexingDone) Sports.indexingDone(); } catch (eSpD) {}
            try { if (window.CatchupScreen) CatchupScreen.refreshNav(); } catch (eCuD) {}
            try { if (window.UI && UI.refreshSearchIfOpen) UI.refreshSearchIfOpen(); } catch (eRsi) {}
            return;
        }
        // Capability guard: the VOD/series preload runs entirely through the
        // streaming fetches (runMoviesThenSeries -> preloadMoviesStreaming /
        // preloadSeriesStreaming), so check those are present before arming the
        // crash guard and starting. If the API layer lacks them, skip the
        // preload rather than half-starting it.
        if (!Api.xtreamAllVodStreamsStreaming || !Api.xtreamAllSeriesStreaming) {
            // Can't preload (API layer lacks the streaming methods) — clear the
            // in-progress flag (item 2) so the Search notice doesn't stick.
            state.catalogIndexing = false;
            try { if (window.Sports && Sports.indexingDone) Sports.indexingDone(); } catch (eSpD) {}
            try { if (window.CatchupScreen) CatchupScreen.refreshNav(); } catch (eCuD) {}
            return;
        }
        // Arm the crash guard around the risky work: it persists a marker now and
        // is cleared only once the preload completes (maybeFireTotalsToast). If
        // the app OOMs/crashes mid-parse, the marker survives and the next boot
        // loads light (recovery level 1), then Lite (level 2+) — breaking a
        // crash loop even when the user explicitly chose Normal.
        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.armCrashGuard) PerfConfig.armCrashGuard(); } catch (eArm) {}
        // Stale-load guard: if a seq token was passed, bail when a newer playlist
        // load has superseded this one (so totals/toasts/index don't apply to the
        // wrong playlist after a fast switch).
        function preloadStale() {
            return seq != null && seq !== state.playlistLoadSeq;
        }
        if (preloadStale()) return;
        // Respect the playlist's content selection: don't fetch/parse/index
        // a content type the playlist has disabled. A "live only" playlist
        // should never pull VOD or series into memory.
        var ct = (Store.getPlaylistContentTypes)
            ? Store.getPlaylistContentTypes(pl.id)
            : { live: true, movies: true, series: true };
        // Surgical single-kind load (toggle-on refetch): restrict to just the kind
        // being (re)loaded so the OTHER kind, already resident in the index, is left
        // untouched. Shallow-copy so we don't mutate the stored content types.
        if (onlyKind === 'movies' || onlyKind === 'series') {
            ct = { live: ct.live, movies: onlyKind === 'movies', series: onlyKind === 'series' };
        }
        // Capture THIS playlist's live count now, while its live channels are the
        // ones on screen. Reading UI.getChannelsCount() later (at promise resolve)
        // would read whatever playlist is visible THEN — wrong totals if the user
        // switched. Falls back to the cached xtream live count if needed.
        var initialLiveCount = (window.UI && UI.getChannelsCount) ? UI.getChannelsCount() : 0;
        var _vodCount = 0;
        var _seriesCount = 0;
        var _idxToastTimer = null;
        // Sticky across BOTH kinds. Movies and series each run their own
        // preloadKindStreaming, so a per-kind halt flag alone would allow series
        // index a further warm-up window (10k entries) after movies had already
        // stopped for heap pressure — re-growing the very index we just stopped
        // growing. Once either kind halts, the other starts already halted.
        var _indexHaltedGlobal = false;
        // Ensures the partial-search notice is shown at most once per load.
        var _indexNoticeShown = false;
        // Track preload completion so we can emit a single
        // "total items" toast after both VOD and series counts are in. This
        // gives the user the full Live + VOD figure (not just live channels)
        // even on the first load when xtreamCounts isn't cached yet.
        // A disabled type is treated as already done with a count of 0.
        var _vodDone = !ct.movies;
        var _seriesDone = !ct.series;
        var _totalsToastFired = false;
        // Search "still indexing" signal. True while VOD/series are streaming into
        // the search index; the Search screen reads App.isCatalogIndexing() to show
        // a transient "still loading movies & series" notice so partial results
        // during the load don't look like a bug. Cleared in maybeFireTotalsToast
        // (both kinds done). If neither type is enabled, we're not indexing.
        state.catalogIndexing = !!(ct.movies || ct.series);
        function updateTotalFromVodPreload() {
            if (preloadStale()) return;
            try { UI.toast(T('toast_indexing_items'), null, { sticky: true }); } catch (eIx) {}
            // Keep the toast alive through a long download between counts; it stops when both kinds are done,
            // the load goes stale, or another toast has replaced it.
            if (!_idxToastTimer) {
                _idxToastTimer = setInterval(function () {
                    var on = false;
                    try { on = !!(UI.toastIsSticky && UI.toastIsSticky()); } catch (eSt) {}
                    if (!on || preloadStale() || (_vodDone && _seriesDone)) {
                        clearInterval(_idxToastTimer); _idxToastTimer = null;
                        try { if (UI.toastHide) UI.toastHide(); } catch (eHd) {}
                        return;
                    }
                    try { UI.toast(T('toast_indexing_items'), null, { sticky: true }); } catch (eIx2) {}
                }, 5000);
            }
            try {
                var vod = _vodCount, series = _seriesCount;
                // Surgical single-kind reload: only THIS kind's count is valid from
                // this load. Preserve the other kind's stored count instead of
                // overwriting it with 0 (which would wrongly zero it in the chip).
                if (onlyKind === 'movies' || onlyKind === 'series') {
                    var _rec = (Store.raw && Store.raw.get) ? Store.raw.get('xtreamCounts.' + pl.id, null) : null;
                    if (onlyKind === 'movies') {
                        series = (_rec && typeof _rec.series === 'number') ? _rec.series : _seriesCount;
                    } else { // series only
                        vod = (_rec && typeof _rec.vod === 'number') ? _rec.vod : _vodCount;
                    }
                }
                setPlaylistTotalCount(pl, initialLiveCount, vod, series);
            } catch (e) {}
        }
        function maybeFireTotalsToast() {
            if (_totalsToastFired) return;
            if (!_vodDone || !_seriesDone) return;
            _totalsToastFired = true;
            // Indexing finished — clear the "still indexing" signal and, if the
            // Search screen is open, re-render it so its transient notice clears
            // (or switches to the truncation notice if the cap was hit).
            state.catalogIndexing = false;
            try { if (window.Sports && Sports.indexingDone) Sports.indexingDone(); } catch (eSpD) {}
            try { if (window.CatchupScreen) CatchupScreen.refreshNav(); } catch (eCuD) {}
            // Indexing is done: repaint the totals chip once more so it drops the
            // "Indexing… {n}" label + pulse (setActivePlaylistChip reads the now-false
            // App.isCatalogIndexing()) and settles on the final "{n} items indexed".
            // Without this the chip could keep its indexing style until the next
            // unrelated chip update.
            try {
                var _finalTotal = initialLiveCount + (_vodFailed ? 0 : _vodCount) + (_seriesFailed ? 0 : _seriesCount);
                setPlaylistTotalCount(pl, initialLiveCount, (_vodFailed ? 0 : _vodCount), (_seriesFailed ? 0 : _seriesCount));
            } catch (eFinalChip) {}
            try {
                if (window.UI && UI.refreshSearchIfOpen) UI.refreshSearchIfOpen();
            } catch (eRs) {}
            try { if (UI.toastHide) UI.toastHide(); } catch (eHd2) {}
            if (preloadStale()) return;
            try {
                // A FAILED catalog is not a zero catalog. Report it as unavailable
                // rather than asserting "0 Movies", and don't dress the toast up as
                // a success when part of the load actually failed.
                var anyFailed = _vodFailed || _seriesFailed;
                var movieStr = _vodFailed ? T('toast_movies_unavailable') : T('toast_n_movies', { n: _vodCount });
                var seriesStr = _seriesFailed ? T('toast_series_unavailable') : T('toast_n_series', { n: _seriesCount });
                var total = initialLiveCount + (_vodFailed ? 0 : _vodCount) + (_seriesFailed ? 0 : _seriesCount);
                var head = anyFailed
                    ? T('toast_total_partial', { name: pl.name, n: total })
                    : T('toast_items', { name: pl.name, n: total });
                UI.toast(
                    head + ' (' + T('toast_n_live', { n: initialLiveCount }) + ', ' + movieStr + ', ' + seriesStr + ')',
                    anyFailed ? 'err' : 'ok'
                );
            } catch (toastErr) {}
            // If a VOD/series payload was too large to fully index (hit the cap
            // or was aborted at download), surface the persistent notice so the
            // user knows search is reduced. showPerfNotice composes the right
            // message and is guarded to show once per launch.
            try {
                if (typeof PerfConfig !== 'undefined' && PerfConfig.capWasHit && PerfConfig.capWasHit()) {
                    showPerfNotice();
                }
            } catch (eCapNote) {}
            // Preload completed without crashing — clear the crash guard so the
            // next boot starts clean (and the consecutive-crash count resets).
            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.clearCrashGuard) PerfConfig.clearCrashGuard(); } catch (eClear) {}
        }
        // Generalized streaming preload for a content kind: parse each object,
        // index it (addOne extracts a slim ref), then discard it — the full
        // object array is NEVER built and full objects are not retained. This is
        // the working-set fix: on a small heap, holding a full 170k-movie or
        // 45k-series array (on top of the other kind's) is what OOM'd. Index-only
        // (no IDB cache write during streaming — see the note below).
        //   cacheKind    - 'vod' | 'series' (IDB store)
        //   searchKind   - kind label passed to GlobalSearch.addOne
        //   catFn        - provider categories fetch (for category_name stamping)
        //   fetchStreamFn(host,user,pass,onObject) - streaming provider fetch
        //   onCount      - receives the final count
        function preloadKindStreaming(cacheKind, searchKind, catFn, fetchStreamFn, onCount) {
            // Read gate: if a fresh cache exists for this kind, rebuild the index
            // from IDB and SKIP the network fetch + parse + index entirely. Miss ->
            // fall through to the streaming path below (which re-writes the cache).
            // This kind is indexed at playlist load from here on: browsing its categories
            // must not index it again (that is what showed a title twice in search).
            try { GlobalSearch.markStreamed(searchKind, pl.name); } catch (eMs) {}
            return tryRebuildFromCache(cacheKind, searchKind, pl, _forceFreshLoad).then(function (cachedN) {
                if (cachedN > 0) {
                    if (preloadStale()) return;               // playlist switched mid-rebuild
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark(searchKind + ' from cache'); } catch (eMk) {}
                    if (onCount) onCount(cachedN);
                    return;                                   // done — no network for this kind
                }
                return preloadKindStreamingNetwork(cacheKind, searchKind, catFn, fetchStreamFn, onCount);
            })['catch'](function () {
                return preloadKindStreamingNetwork(cacheKind, searchKind, catFn, fetchStreamFn, onCount);
            });
        }

        function preloadKindStreamingNetwork(cacheKind, searchKind, catFn, fetchStreamFn, onCount) {
            var meta = {
                playlistName: pl.name, playlistId: pl.id,
                host: pl.host, user: pl.user, pass: pl.pass
            };
            var searchOn = true;
            try {
                if (typeof PerfConfig !== 'undefined' && PerfConfig.get('globalSearchVodEnabled') === false) searchOn = false;
            } catch (ePerf) {}
            var catMap = null;
            var catReady = catFn
                ? catFn(pl.host, pl.user, pl.pass).then(function (cats) { catMap = buildSeriesCatMap(cats); })['catch'](function () { catMap = {}; })
                : Promise.resolve();
            return catReady.then(function () {
                // NOTE: no streaming IDB cache write here. An earlier attempt fed
                // each object to an incremental IDB writer, but its flush queue is
                // async and slower than the synchronous parser, so full objects
                // piled up in the write buffer faster than IDB drained them —
                // re-introducing (worse) full-object retention and crashing before
                // movies even finished. Indexing is what matters for search; the
                // IDB cache is only a relaunch optimisation. So the streaming path
                // now ONLY indexes (slim ref extracted, object then discarded) and
                // does NOT cache. Relaunch re-fetches (as it already does when no
                // cache exists).
                var count = 0;
                var indexed = 0;
                // Seed from the run-scoped flag: if the other kind already halted
                // for heap pressure, start halted rather than indexing another
                // warm-up window's worth of entries.
                var indexHalted = _indexHaltedGlobal;
                try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark(searchKind + ' stream start'); } catch (e0) {}
                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' stream start (cats ready)'); } catch (eB0) {}

                // Mid-index memory guard. The startup Lite gates run BEFORE the
                // index exists, so a device with a modest heap can boot healthy,
                // pass every gate, and then exhaust its heap as ~200k VOD/series
                // entries become resident (the index is the dominant steady-state
                // cost — the streamed objects themselves are discarded).
                //
                // Enforced by COUNTING entries, not by reading used-heap. On real
                // WebOS hardware performance.memory.usedJSHeapSize is not reported
                // honestly: a device measured with 274,047 entries resident
                // reported used=9.5MB both before AND after indexing (delta zero),
                // so any used/limit ratio sits frozen and can never trip. The
                // entry count is something we measure ourselves, and
                // jsHeapSizeLimit (which IS reported truthfully) sizes the budget.
                // See PerfConfig.maxIndexEntries for the calibration.
                //
                // The budget covers the WHOLE index, live included: live channels
                // are indexed before this runs and occupy the same heap, so the
                // check reads GlobalSearch.count() (the running total) rather than
                // this kind's own counter. On a big-live playlist that correctly
                // leaves less room for movies/series.
                //
                // We can't stop the parser (onObject's return value is discarded by
                // design), so instead we latch indexHalted and the remaining objects
                // stream past without being retained — draining the response is
                // cheap, keeping the objects is not.
                //
                // The result is a partial index rather than a crash: search covers
                // the first N of M items, the app stays up, and playback and the
                // content screens (which fetch per-category on demand) are
                // unaffected. Checked every 1k objects — the check is just an
                // integer compare, so it can be frequent enough not to overshoot.
                var BUDGET_EVERY = 1000;
                var _maxEntries = 0;
                try {
                    _maxEntries = (typeof PerfConfig !== 'undefined' && PerfConfig.maxIndexEntries)
                        ? PerfConfig.maxIndexEntries() : 0;
                } catch (eMx) { _maxEntries = 0; }
                function checkIndexBudget() {
                    if (indexHalted) return;
                    if (!_maxEntries) return;           // unknown heap: never degrade
                    if (count % BUDGET_EVERY !== 0) return;
                    var total = 0;
                    try { total = GlobalSearch.count ? GlobalSearch.count() : 0; } catch (eC) { return; }
                    if (total < _maxEntries) return;
                    indexHalted = true;
                    _indexHaltedGlobal = true;
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' INDEX CAPPED at total ' + total + ' (budget ' + _maxEntries + ')'); } catch (eBh) {}
                    if (window.console && console.log) {
                        Log.log('[Search] index budget reached (' + total + '/' + _maxEntries +
                            ' entries) while indexing ' + searchKind +
                            ' — search will cover a partial catalog.');
                    }
                }

                function onObject(item) {
                    if (!item) return;
                    count++;
                    if (!indexHalted) {
                        if (catMap && !item.category_name && item.category_id != null) {
                            var nm = catMap[String(item.category_id)];
                            if (nm) item.category_name = nm;
                        }
                        if (searchOn) {
                            try { GlobalSearch.addOne(searchKind, item, pl.name, meta); indexed++; } catch (eIdx) {}
                        }
                        checkIndexBudget();
                    }
                    // Live totals: push the running indexed count to the chip every
                    // ~2000 items so the total ticks up AS movies/series stream in,
                    // instead of jumping only when each kind fully finishes. Cheap
                    // (setPlaylistTotalCount just rewrites the chip text); throttled
                    // so it isn't per-object. The final onCount(indexed) below still
                    // fires the authoritative end value.
                    if (onCount && indexed > 0 && indexed % 500 === 0) {
                        try { onCount(indexed); } catch (eInc) {}
                    }
                    // Periodic crash breadcrumb: every 10k objects, record how far
                    // we got + heap. If the app OOMs mid-parse, the last surviving
                    // breadcrumb pinpoints the count/heap at death.
                    if (count % 10000 === 0) {
                        try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' seen ' + count + ' indexed ' + indexed + (indexHalted ? ' (halted)' : '')); } catch (eBp) {}
                    }
                    // item goes out of scope here — only the slim index ref is
                    // retained (and nothing at all once halted); the full object is
                    // now collectable.
                }

                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' fetch begin'); } catch (eBf) {}
                return fetchStreamFn(pl.host, pl.user, pl.pass, onObject).then(function (res) {
                    var seenCount = (res && res.count != null) ? res.count : count;
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark(searchKind + ' stream done (' + seenCount + ')'); } catch (e1) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' stream DONE seen ' + seenCount + ' indexed ' + indexed + ' | index size ' + (GlobalSearch.count ? GlobalSearch.count() : '?') + ' ready=' + (GlobalSearch.isReady ? GlobalSearch.isReady() : '?')); } catch (eB1) {}
                    // Report accurately. Two DIFFERENT things can limit a kind, and
                    // conflating them has already cost debugging time:
                    //
                    //   indexHalted  -> the ENTRY budget was reached
                    //                   (PerfConfig.maxIndexEntries; the whole index
                    //                    is full, across all kinds)
                    //   res.truncated -> the BYTE budget was reached
                    //                   (catalogByteBudget; the download was cut, so
                    //                    seenCount is only the prefix that arrived,
                    //                    NOT the provider's real catalog size)
                    //
                    // The old message said "HALTED — heap pressure", which was a
                    // leftover from the removed indexPressureHigh check and is simply
                    // wrong: used-heap is stubbed on WebOS and never triggers anything.
                    var limitNote = '';
                    if (indexHalted) {
                        limitNote = ' (HALTED — index entry budget reached)';
                    } else if (res && res.truncated) {
                        limitNote = ' (payload truncated at device byte budget — catalog is larger than this)';
                    }
                    if (window.console) {
                        Log.log('[Search] Indexed ' + indexed + ' of ' + seenCount + ' ' + searchKind +
                            limitNote + ' (network, streamed, no-cache)');
                    }
                    // Surface the partial-index notice ONCE per load, not once per
                    // kind, so a device that halts on movies and then starts series
                    // already halted doesn't toast twice. State the real numbers:
                    // the totals will read short, and the user needs to know that is
                    // a device limit rather than a missing catalog.
                    if (indexHalted && indexed < seenCount && !_indexNoticeShown) {
                        _indexNoticeShown = true;
                        try { UI.toast(T('this_device_ran_low_on_memory') + indexed + ' of ' + seenCount + ' ' + searchKind + '. Totals and search cover the indexed items; browsing by category still reaches everything.', null); } catch (eT) {}
                    }
                    // Report the INDEXED count, not the provider's count. If the
                    // index halted under heap pressure, the catalog is NOT fully
                    // searchable, and a total showing the provider's full figure
                    // would tell the user everything is there when it isn't. A
                    // short total is the honest signal that coverage is partial.
                    if (onCount) onCount(indexed);

                    // --- Persist the slim index to IDB (Option B) ----------------
                    // Reuse this parsed catalogue on the next launch instead of
                    // re-fetching. exportSlim returns the already-resident slim
                    // entries; putItems writes them chunked with yields (never inline
                    // with the parser, so an out-of-memory failure cannot recur). The write
                    // is RETURNED (not fire-and-forget) so the next kind doesn't begin
                    // parsing while this write is still draining — see below.
                    var _writeP = Promise.resolve();
                    try {
                        // Cache even a truncated prefix: truncation is an OOM guard
                        // at parse time, but the prefix we DID index is safe to
                        // persist and reusing it beats re-fetching the same prefix
                        // every launch. Record whether it was partial so the read
                        // side knows it's a prefix, not the whole catalogue.
                        var _wasPartial = !!((res && res.truncated) || indexHalted);
                        var _st = (Store.getSettings ? Store.getSettings() : {}) || {};
                        var _cacheOn = (_st.cacheVod !== 'off'); // default on
                        if (_cacheOn && indexed > 0 &&
                            typeof IDB !== 'undefined' && IDB.putItems &&
                            GlobalSearch.exportSlim) {
                            var _slim = GlobalSearch.exportSlim(searchKind, pl.id);
                            if (_slim && _slim.length) {
                                var _srcKey = Store.contentSourceKey ? Store.contentSourceKey(pl) : '';
                                _writeP = IDB.init().then(function () {
                                    return IDB.putItems(cacheKind, pl.id, _slim, { sourceKey: _srcKey, partial: _wasPartial });
                                }).then(function (ok) {
                                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(searchKind + ' cache write ' + (ok ? 'ok' : 'fail') + ' (' + _slim.length + (_wasPartial ? ' partial' : '') + ')'); } catch (eBw) {}
                                    try { Log.log('[Cache] ' + searchKind + ' cache write ' + (ok ? 'ok' : 'FAILED') + ' (' + _slim.length + ' rows' + (_wasPartial ? ', partial prefix' : '') + ')'); } catch (eCw) {}
                                })['catch'](function () {});
                            }
                        }
                    } catch (eCacheWrite) {}
                    // Await the write so the movies->series handoff is sequential:
                    // series parsing won't overlap the movie IDB write.
                    return _writeP;
                });
            });
        }
        function preloadSeriesStreaming(onCount) {
            return preloadKindStreaming('series', 'series', Api.xtreamSeriesCategories, Api.xtreamAllSeriesStreaming, onCount);
        }
        function preloadMoviesStreaming(onCount) {
            return preloadKindStreaming('vod', 'movie', Api.xtreamVodCategories, Api.xtreamAllVodStreamsStreaming, onCount);
        }
        // Run movies then series SEQUENTIALLY, not in parallel. Each buffers a
        // large raw JSON payload (tens of MB) before parsing; running both at
        // once doubled the peak (two raw strings + both parsing + the growing
        // index), which OOM'd weak TVs. Chaining them means only one large
        // payload is resident at a time, roughly halving peak memory.
        // Track catalog fetch failures so the totals toast can tell the truth. A
        // failed fetch must NOT be presented as an empty catalog: that is exactly
        // what made the silent zero-movies bug invisible (the provider shed load,
        // returned a non-array body, and the app rendered "no movies" as fact).
        var _vodFailed = false;
        var _seriesFailed = false;
        function reportCatalogFailure(kind, e) {
            var cause = (e && (e.cause || e.err)) || 'unknown';
            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb(kind + ' CATALOG FAILED: ' + cause); } catch (eB) {}
            if (window.console && console.log) {
                Log.log('[' + kind + '] catalog failed to load after retries (' + cause + ')');
            }
            var label = (kind === 'movie') ? 'Movies' : 'Series';
            try {
                UI.toast(label + ' could not be loaded from the provider — refresh the playlist to try again.', 'err');
            } catch (eT) {}
        }
        function runMoviesThenSeries() {
            var moviesP = ct.movies
                ? preloadMoviesStreaming(function (n) {
                    _vodCount = n; updateTotalFromVodPreload();
                })['catch'](function (eMov) {
                    // Do not swallow. Mark the kind failed so the count is reported
                    // as unknown rather than zero, and tell the user.
                    _vodFailed = true;
                    reportCatalogFailure('movie', eMov);
                })
                : Promise.resolve();
            moviesP.then(function () {
                _vodDone = true;
                // Item 4: an intermediate "movies indexed" toast — but only when
                // movies were actually loaded AND series will ALSO load (so it's a
                // distinct milestone, not a duplicate of the final all-done totals
                // toast, and never a bogus "0 Movies indexed" when movies are off).
                if (ct.movies && ct.series && !_vodFailed && !preloadStale()) {
                    try { UI.toast(T('toast_movies_indexed', { name: pl.name, n: _vodCount }), 'ok'); } catch (eMt) {}
                }
                maybeFireTotalsToast();
                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('movies promise RESOLVED (ct.series=' + ct.series + ')'); } catch (eBm) {}
                if (!ct.series) return;
                var SERIES_GC_GAP_MS = 1000;
                setTimeout(function () {
                    try { if (typeof PerfConfig !== 'undefined') PerfConfig.mark('series step start (after movies)'); } catch (eDs) {}
                    try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('series gap timer fired -> calling preloadSeriesStreaming'); } catch (eBg) {}
                    preloadSeriesStreaming(function (n) {
                        _seriesCount = n; updateTotalFromVodPreload();
                    })['catch'](function (eSer) {
                        _seriesFailed = true;
                        reportCatalogFailure('series', eSer);
                    }).then(function () {
                        _seriesDone = true; maybeFireTotalsToast();
                    });
                }, SERIES_GC_GAP_MS);
            }, function (eMov) {
                try { if (typeof PerfConfig !== 'undefined' && PerfConfig.breadcrumb) PerfConfig.breadcrumb('movies promise REJECTED: ' + (eMov && eMov.message ? eMov.message : eMov)); } catch (eB) {}
            });
        }
        runMoviesThenSeries();
        // If both types are disabled, still fire the totals toast (live-only).
        maybeFireTotalsToast();
    }

    function findPlaylist(id) {
        var pls = Store.getPlaylists();
        for (var i = 0; i < pls.length; i++) if (pls[i].id === id) return pls[i];
        return null;
    }

    function addPlaylist(pl) {
        Store.stampPlaylist(pl);
        var pls = Store.getPlaylists();
        pls.push(pl);
        Store.setPlaylists(pls);
    }

    /* Set a playlist's content selection and apply it live. Persists the
     * choice, refreshes the cards (so the chips reflect the new state), and —
     * if this is the ACTIVE playlist — re-applies the side-menu visibility and
     * reloads its content so newly-enabled types load (and become searchable)
     * and newly-disabled types are dropped, all without leaving the screen. */
    /* Toggle a playlist's per-playlist EPG. Persists, refreshes the cards
     * (preserving focus), and — for the active playlist — clears the loaded EPG
     * when turning off (so it disappears immediately) or reloads to fetch it
     * when turning on. */
    // Pending deferred EPG-IDB clears, keyed by playlist id. A toggle-off
    // schedules a wipe after a grace window so an accidental toggle that's undone
    // keeps its cached guide; re-enabling cancels it.
    var _epgClearTimers = {};
    var EPG_IDB_CLEAR_DELAY_MS = 60000; // 60s grace for an accidental toggle

    function doEpgIdbClear(id) {
        try {
            if (typeof IDB !== 'undefined') {
                if (IDB.epgClearPlaylist) IDB.epgClearPlaylist(id)['catch'](function () {});
                if (IDB.epgMetaDelete) IDB.epgMetaDelete(id)['catch'](function () {});
            }
        } catch (eIdbClr) {}
    }

    function scheduleEpgIdbClear(id) {
        if (!id) return;
        if (_epgClearTimers[id]) { try { clearTimeout(_epgClearTimers[id]); } catch (e) {} }
        _epgClearTimers[id] = setTimeout(function () {
            delete _epgClearTimers[id];
            // Re-check the toggle is still OFF — a late re-enable (after the timer
            // was somehow not cancelled) must not have its fresh data wiped.
            var stillOff = Store.getPlaylistEpgEnabled ? (Store.getPlaylistEpgEnabled(id) === false) : true;
            if (stillOff) doEpgIdbClear(id);
        }, EPG_IDB_CLEAR_DELAY_MS);
    }

    function cancelEpgIdbClear(id) {
        if (id && _epgClearTimers[id]) {
            try { clearTimeout(_epgClearTimers[id]); } catch (e) {}
            delete _epgClearTimers[id];
        }
    }

    // Boot backstop: clear stored EPG for any playlist currently disabled, so a
    // deliberate toggle-off is honoured even if the app closed before its deferred
    // timer fired. Runs once at startup.
    function reconcileDisabledEpg() {
        try {
            var pls = Store.getPlaylists ? Store.getPlaylists() : [];
            for (var i = 0; i < pls.length; i++) {
                var p = pls[i];
                if (p && p.id && Store.getPlaylistEpgEnabled && Store.getPlaylistEpgEnabled(p.id) === false) {
                    doEpgIdbClear(p.id);
                }
            }
        } catch (eRec) {}
    }

    function setPlaylistEpg(id, enabled) {
        if (!id || !Store.setPlaylistEpgEnabled) return;
        Store.setPlaylistEpgEnabled(id, enabled);
        var focusKeyToRestore = null;
        var curF = (window.Focus && Focus.current) ? Focus.current() : null;
        if (curF && curF.getAttribute) focusKeyToRestore = curF.getAttribute('data-focus-key');
        UI.renderPlaylists();
        if (focusKeyToRestore && window.Focus && Focus.focusKey) {
            setTimeout(function () { Focus.focusKey(focusKeyToRestore); }, 30);
        }
        if (Store.getActivePlaylistId && Store.getActivePlaylistId() === id) {
            if (!enabled) {
                // Drop the loaded EPG immediately so the guide clears from view.
                if (typeof Epg !== 'undefined' && Epg.clear) { try { Epg.clear(id); } catch (e) {} }
                // Disabling EPG is a deliberate on/off choice, so the stored guide
                // in IndexedDB should be evicted too. But do it on a DELAY, not
                // immediately: an accidental toggle that's flipped back on within the
                // grace window keeps the cached data for an instant re-enable (no
                // full re-fetch/re-parse of a large guide). Re-enabling cancels this
                // (see the enable branch). A boot-time sweep is the backstop if the
                // app closes before the timer fires (see reconcileDisabledEpg).
                scheduleEpgIdbClear(id);
                try { UI.renderHome(); } catch (e2) {}
            } else {
                // Cancel any pending deferred IDB clear from a recent toggle-off —
                // the user re-enabled within the grace window, so keep the cache.
                cancelEpgIdbClear(id);
                // Re-enabling: fetch ONLY the EPG. Do NOT call loadPlaylistChannels
                // here — that is the full playlist loader (live channels, search
                // index rebuild, VOD/series preload) and would needlessly reload
                // movies and series when only the live guide is affected.
                var plForEpg = findPlaylist(id);
                var hasSrc = false;
                try { hasSrc = !!(plForEpg && Epg.hasEpgSource && Epg.hasEpgSource(plForEpg)); } catch (eHs) {}
                if (!hasSrc) {
                    // Nothing to load — this provider exposes no EPG URL and no
                    // external EPG is configured. Tell the user rather than silently
                    // doing nothing (which looks like the toggle is broken).
                    try { if (window.UI && UI.toast) UI.toast(T('no_epg_source_for_playlist'), null); } catch (eNo) {}
                } else if (plForEpg && typeof Epg !== 'undefined' && Epg.load) {
                    try { if (Epg.forceReload) Epg.forceReload(plForEpg); } catch (eFr) {}
                    guideToast();
                    Epg.load(plForEpg).then(function () {
                        if (!(Store.getActivePlaylistId && Store.getActivePlaylistId() === id)) return;
                        try { if (window.UI && UI.toast) UI.toast(T('tv_guide_loaded'), 'ok'); } catch (eOk2) {}
                        try { UI.renderHeroFromChannel(Player.currentChannel()); } catch (eHero) {}
                        try { UI.renderHome(); } catch (eHome) {}
                        try {
                            if (document.querySelector('.content-section[data-section-content="livetv"].active') && UI.refreshLiveEpgRows &&
                                !(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                                UI.refreshLiveEpgRows();
                            }
                        } catch (eLiveEpg2) {}
                    });
                }
            }
        }
        if (typeof CloudSync !== 'undefined' && CloudSync.schedulePush) {
            try { CloudSync.schedulePush(); } catch (e) {}
        }
    }

    function setPlaylistContent(id, ct) {
        if (!id || !Store.setPlaylistContentTypes) return;
        // Capture the state BEFORE this burst of toggles (only on the first toggle
        // of the burst — a rapid off/on/off must be compared against where it
        // started, not against the previous intermediate flip).
        if (!_ctPendingBefore[id]) {
            _ctPendingBefore[id] = Store.getPlaylistContentTypes
                ? Store.getPlaylistContentTypes(id)
                : { live: true, movies: true, series: true };
        }
        var prevImmediate = Store.getPlaylistContentTypes
            ? Store.getPlaylistContentTypes(id)
            : { live: true, movies: true, series: true };
        Store.setPlaylistContentTypes(id, ct);
        var next = Store.getPlaylistContentTypes
            ? Store.getPlaylistContentTypes(id)
            : ct;
        // Bump the generation of any kind that changed in THIS flip, so any load
        // currently in flight for that kind knows it's been superseded.
        if (prevImmediate.live !== next.live) bumpCtGeneration(id, 'live');
        if (prevImmediate.movies !== next.movies) bumpCtGeneration(id, 'movies');
        if (prevImmediate.series !== next.series) bumpCtGeneration(id, 'series');

        // Visibility + card re-render happen IMMEDIATELY (responsive), independent
        // of the debounced load/purge below.
        var focusKeyToRestore = null;
        var curF = (window.Focus && Focus.current) ? Focus.current() : null;
        if (curF && curF.getAttribute) focusKeyToRestore = curF.getAttribute('data-focus-key');
        UI.renderPlaylists();
        if (focusKeyToRestore && window.Focus && Focus.focusKey) {
            setTimeout(function () { Focus.focusKey(focusKeyToRestore); }, 30);
        }
        if (Store.getActivePlaylistId && Store.getActivePlaylistId() === id) {
            applyContentTypeVisibility();
        }

        // Debounce the actual load/purge work so a burst of quick toggles settles
        // to its final state and acts once.
        if (_ctToggleTimers[id]) clearTimeout(_ctToggleTimers[id]);
        _ctToggleTimers[id] = setTimeout(function () {
            _ctToggleTimers[id] = null;
            var before = _ctPendingBefore[id] || { live: true, movies: true, series: true };
            _ctPendingBefore[id] = null;
            applySettledContentToggle(id, before);
        }, CT_TOGGLE_DEBOUNCE_MS);

        if (typeof CloudSync !== 'undefined' && CloudSync.schedulePush) {
            try { CloudSync.schedulePush(); } catch (eCs) {}
        }
    }

    // Runs once per settled toggle-burst. Compares the pre-burst content types
    // (before) with the current final state and, per kind, evicts+purges a type
    // turned OFF or surgically (re)loads a type turned ON — only the kinds that
    // actually changed net across the burst.
    function applySettledContentToggle(id, before) {
        var now = Store.getPlaylistContentTypes
            ? Store.getPlaylistContentTypes(id)
            : { live: true, movies: true, series: true };
        var isActive = Store.getActivePlaylistId && Store.getActivePlaylistId() === id;

        // Net transitions across the whole burst.
        var offLive = before.live && !now.live;
        var offMovies = before.movies && !now.movies;
        var offSeries = before.series && !now.series;
        var onLive = !before.live && now.live;
        var onMovies = !before.movies && now.movies;
        var onSeries = !before.series && now.series;

        // --- OFF: evict caches + purge the kind from the in-memory search index --
        if (Store.dropContentCache) {
            if (offLive) Store.dropContentCache('live', id);
            if (offMovies) Store.dropContentCache('vod', id);
            if (offSeries) Store.dropContentCache('series', id);
        }
        // Purge disabled kinds from the resident search index so they stop
        // appearing in search results (and a later re-enable can't duplicate them).
        // Live search entries are keyed 'live'; VOD/series use 'movie'/'series'.
        if (GlobalSearch.removeKind) {
            if (offLive) { try { GlobalSearch.removeKind('live', id); } catch (ePl) {} }
            if (offMovies) { try { GlobalSearch.removeKind('movie', id); } catch (ePm) {} }
            if (offSeries) { try { GlobalSearch.removeKind('series', id); } catch (ePs) {} }
        }

        // --- Chip: recompute from the types still enabled (per-type counts) ------
        // Runs on ANY net change (on OR off), not just off. Turning a kind ON used to
        // skip this, so after ticking Live on (with a cached series-only total) the
        // chip kept showing the stale series count until restart. Recompute now from
        // the stored per-kind counts so the chip immediately reflects the enabled set;
        // the async (re)load below then refines the freshly-enabled kind's count when
        // it arrives (e.g. loadSingleContentType('live') repaints with the real live
        // count on completion).
        var _anyChange = offLive || offMovies || offSeries || onLive || onMovies || onSeries;
        if (_anyChange && isActive) {
            try {
                var _rec = (Store.raw && Store.raw.get) ? Store.raw.get('xtreamCounts.' + id, null) : null;
                var _plNow = null;
                var _pls = Store.getPlaylists ? Store.getPlaylists() : [];
                for (var _i = 0; _i < _pls.length; _i++) { if (_pls[_i].id === id) { _plNow = _pls[_i]; break; } }
                var _liveNow = (now.live && window.UI && UI.getChannelsCount) ? UI.getChannelsCount() : 0;
                var _vod = 0, _series = 0;
                if (_rec) {
                    if (typeof _rec.vod === 'number' || typeof _rec.series === 'number') {
                        _vod = now.movies ? (_rec.vod || 0) : 0;
                        _series = now.series ? (_rec.series || 0) : 0;
                        if (!now.live && typeof _rec.live === 'number') _liveNow = 0;
                        else if (now.live && !_liveNow && typeof _rec.live === 'number') _liveNow = _rec.live;
                    } else if (typeof _rec.extra === 'number') {
                        _vod = (now.movies && now.series) ? _rec.extra : 0;
                    }
                }
                var _newTotal = (_liveNow || 0) + _vod + _series;
                try { Store.raw.set('xtreamCounts.' + id, { live: _liveNow || 0, vod: _vod, series: _series, total: _newTotal }); } catch (eSt) {}
                UI.setActivePlaylistChip(_plNow ? _plNow.name : '', _newTotal);
            } catch (eRc) {}
        }

        // --- ON: surgically (re)load ONLY the kind(s) turned on -----------------
        // Only the active playlist loads; a background playlist just keeps its
        // stored selection and loads when next opened.
        if (!isActive) return;
        var pl = findPlaylist(id);
        if (!pl) return;

        // Turning movies/series ON kicks off a network fetch + parse that can take
        // ~15-20s before the streaming index (and its chip animation) begins. Mark
        // catalog indexing in-progress NOW so the totals chip shows "Indexing…"
        // immediately on the toggle, not only once the parse starts. Cleared by
        // maybeFireTotalsToast (or the failure paths) when the load settles. Live is
        // a quick channel fetch with no streaming index, so it doesn't set this.
        if (pl.type === 'xtream' && (onMovies || onSeries)) {
            state.catalogIndexing = true;
            try {
                var _plName = pl.name;
                var _recNow = (Store.raw && Store.raw.get) ? Store.raw.get('xtreamCounts.' + id, null) : null;
                var _tNow = (_recNow && typeof _recNow.total === 'number') ? _recNow.total : 0;
                UI.setActivePlaylistChip(_plName, _tNow);
            } catch (eCi) {}
        }

        if (onLive) loadSingleContentType(pl, 'live');
        if (onMovies) loadSingleContentType(pl, 'movies');
        if (onSeries) loadSingleContentType(pl, 'series');
    }

    // Load exactly one content type for an already-active playlist, guarded by that
    // kind's generation so a toggle-off (or another toggle) during the load aborts
    // it cleanly. Live runs the channel fetch; movies/series run the single-kind
    // VOD preload. Forces a fresh fetch (bypasses the cache) since a re-enable
    // should pull fresh, matching pre-cache behaviour.
    function loadSingleContentType(pl, kind) {
        if (!pl) return;
        var id = pl.id;
        var gen = bumpCtGeneration(id, kind); // this load's generation
        function superseded() {
            return ctGeneration(id, kind) !== gen ||
                   !(Store.getActivePlaylistId && Store.getActivePlaylistId() === id);
        }
        if (kind === 'live') {
            // Re-fetch live channels only. Parser.load returns the channel list.
            if (!(window.Parser && Parser.load)) return;
            Parser.load(pl).then(function (channels) {
                if (superseded()) return;
                UI.setChannels(channels);
                // Merge the new live count into the STORED per-type total. Using
                // getPlaylistTotalCount here was the bug: when a cached total already
                // existed (e.g. 46k from a series-only pairing), it returned that
                // stale total and ignored the freshly-loaded live count entirely, so
                // the chip stayed at 46k after ticking Live on. Instead update the
                // 'live' field and recompute total = live + vod + series from the
                // stored record, then paint that.
                var liveN = channels ? channels.length : 0;
                var _rec = null;
                try { _rec = (Store.raw && Store.raw.get) ? Store.raw.get('xtreamCounts.' + id, null) : null; } catch (eG) {}
                var vodN = (_rec && typeof _rec.vod === 'number') ? _rec.vod : 0;
                var seriesN = (_rec && typeof _rec.series === 'number') ? _rec.series : 0;
                var totalN = liveN + vodN + seriesN;
                try { if (Store.raw && Store.raw.set) Store.raw.set('xtreamCounts.' + id, { live: liveN, vod: vodN, series: seriesN, total: totalN }); } catch (eS) {}
                UI.setActivePlaylistChip(pl.name, totalN);
                UI.hideLoading();
                UI.renderHome();
            })['catch'](function () {});
            return;
        }
        if (kind === 'movies' || kind === 'series') {
            VOD_CACHE_FORCE[id] = true; // enabling -> fetch fresh
            // Purge any resident entries for this kind first so the reload can't
            // duplicate them (searchKind is 'movie'/'series').
            if (GlobalSearch.removeKind) {
                try { GlobalSearch.removeKind(kind === 'movies' ? 'movie' : 'series', id); } catch (ePk) {}
            }
            // preloadVodForSearch with onlyKind loads just this kind; its own
            // preloadStale()/seq guards plus our generation check below keep a
            // superseded load from painting.
            var seq = (state && state.playlistLoadSeq) || 0;
            try { preloadVodForSearch(pl, seq, kind); } catch (e) {
                Log.log('[Search] single-kind preload error:', e);
            }
        }
    }

    // Fetch ONLY the EPG for the currently-active playlist and repaint the guide.
    // Used after an external EPG is applied out-of-band (e.g. paired on its own):
    // the boot EPG loader has already run, so storing a new source does nothing
    // visible until we re-load. Mirrors the re-enable path — deliberately does NOT
    // call loadPlaylistChannels (that would needlessly rebuild live/VOD/series);
    // only the guide is affected. Note: Epg.load uses getEpgSourceUrls, which
    // includes externals regardless of the per-playlist epgEnabled toggle, so a
    // playlist originally paired with EPG off still picks up a later external EPG.
    function reloadEpgForActive() {
        var id = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
        if (!id) return;
        var plForEpg = findPlaylist(id);
        if (!plForEpg || typeof Epg === 'undefined' || !Epg.load) return;
        var hadSource = false;
        try { hadSource = !!(Epg.hasEpgSource && Epg.hasEpgSource(plForEpg)); } catch (eHs0) {}
        guideToast();
        Epg.load(plForEpg).then(function () {
            if (!(Store.getActivePlaylistId && Store.getActivePlaylistId() === id)) return;
            if (hadSource) { try { if (window.UI && UI.toast) UI.toast(T('tv_guide_loaded'), 'ok'); } catch (eOk) {} }
            try { UI.renderHeroFromChannel(Player.currentChannel()); } catch (eHero) {}
            try { UI.renderHome(); } catch (eHome) {}
            try {
                if (document.querySelector('.content-section[data-section-content="livetv"].active') && UI.refreshLiveEpgRows &&
                    !(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                    UI.refreshLiveEpgRows();
                }
            } catch (eLiveEpg) {}
        });
    }

    function activatePlaylist(id, goingHome) {
        // A playlist synced as a "shell" from another device has no credentials
        // on THIS device (creds aren't synced by default). Trying to load it would
        // fail confusingly, so route the user to fill in credentials first. Once
        // they're entered (and saved locally), the playlist loads normally.
        var pls = Store.getPlaylists ? Store.getPlaylists() : [];
        var target = null;
        for (var pi = 0; pi < pls.length; pi++) { if (pls[pi] && pls[pi].id === id) { target = pls[pi]; break; } }
        if (target) {
            var missingCreds = playlistNeedsCreds(target);
            if (missingCreds || target.credsNeeded) {
                if (typeof openManualEntryForEdit === 'function') {
                    UI.toast(T('enter_credentials_to_use_this_playlist'), null);
                    openManualEntryForEdit(id);
                    return;
                }
            }
        }
        Store.setActivePlaylistId(id);
        // Side menu reflects the active playlist's content selection.
        applyContentTypeVisibility();
        UI.renderPlaylists();
        if (goingHome) {
            goHome();
        } else {
            loadPlaylistChannels(id);
        }
    }

    function deletePlaylist(id, silent) {
        var pls = Store.getPlaylists();
        var keep = [];
        for (var i = 0; i < pls.length; i++) if (pls[i].id !== id) keep.push(pls[i]);
        Store.setPlaylists(keep);
        // Record a deletion tombstone so the removal syncs (newest-wins) instead of
        // the playlist reappearing from another TV's cloud copy.
        Store.addPlaylistTombstone(id);
        Store.dropChannelsCache(id);
        // Evict this playlist's Continue Watching (live + movie/series) and
        // Favorites entries so orphaned cards don't remain on Home/Favorites.
        try { if (Store.purgePlaylistFromLists) Store.purgePlaylistFromLists(id); } catch (ePurge) {}
        // Also clear this playlist's data from IndexedDB. dropChannelsCache only
        // clears the localStorage channel cache; without this the deleted
        // playlist's VOD/series/live records and its EPG programmes are orphaned
        // in IDB. Beyond wasting space, stale EPG rows share the epg store with
        // every playlist, so leaving them behind can interfere with the next
        // playlist's load. Fire-and-forget: deletion shouldn't block the UI, and
        // both helpers swallow their own errors.
        try { if (typeof IDB !== 'undefined') {
            if (IDB.deleteAllKinds) IDB.deleteAllKinds(id);
            if (IDB.epgClearPlaylist) IDB.epgClearPlaylist(id);
            // Drop the EPG freshness record too; otherwise a surviving "fresh"
            // record could later rehydrate lookup maps pointing at now-cleared
            // programme data.
            if (IDB.epgMetaDelete) IDB.epgMetaDelete(id);
        } } catch (e) { Log.log('[Delete] IDB clear error:', e); }
        if (Store.getActivePlaylistId() === id) {
            Store.setActivePlaylistId(keep.length ? keep[0].id : null);
            applyContentTypeVisibility();
            if (keep.length) loadPlaylistChannels(keep[0].id);
            else { UI.setChannels([]); UI.setActivePlaylistChip('No playlist', 0); UI.renderHome(); }
        }
        UI.renderPlaylists();
        if (!silent) UI.toast(T('playlist_deleted'), 'ok');
    }

    /* Force a playlist to re-fetch from its source, discarding the cached
     * channel list. For URL-based playlists (m3u url, xtream, stalker) this
     * pulls the current channels/stream URLs from the provider — use when the
     * upstream playlist has changed. For an inline-content M3U (file embedded at
     * pairing) there's no remote to re-fetch, so it just re-parses the stored
     * content. If it's the active playlist, reload it now; otherwise clearing
     * the cache is enough — the next activation will fetch fresh. */
    /* Force a full EPG re-fetch + re-parse for a playlist, bypassing the
     * freshness cache. Re-merges every source (provider EPG plus externals,
     * honoring the external-override setting) via Epg.forceReload. Available for
     * any playlist; when it's the active one, refresh the on-screen now/next
     * once the new guide is in. */
    function refreshPlaylistEpg(id) {
        if (!id) return;
        var pls = Store.getPlaylists();
        var pl = null;
        for (var i = 0; i < pls.length; i++) if (pls[i].id === id) { pl = pls[i]; break; }
        if (!pl) return;
        if (typeof Epg === 'undefined' || !Epg.forceReload) return;
        var isActive = (Store.getActivePlaylistId && Store.getActivePlaylistId() === id);
        UI.toast(T('refreshing_epg_for') + ' ' + (pl.name || 'playlist') + '...', null);
        Epg.forceReload(pl).then(function () {
            UI.toast(T('epg_refreshed'), 'ok');
            if (isActive && UI.refreshEpgNowNext) UI.refreshEpgNowNext();
        })['catch'](function () {
            UI.toast(T('epg_refresh_failed'), 'err');
        });
    }

    function refreshPlaylist(id) {
        if (!id) return;
        var pls = Store.getPlaylists();
        var pl = null;
        for (var i = 0; i < pls.length; i++) if (pls[i].id === id) { pl = pls[i]; break; }
        if (!pl) return;
        Store.dropChannelsCache(id);
        if (Store.getActivePlaylistId && Store.getActivePlaylistId() === id) {
            UI.toast(T('refreshing') + ' ' + (pl.name || 'playlist') + '...', null);
            loadPlaylistChannels(id);
        } else {
            UI.toast(T('refreshed') + ' ' + (pl.name || 'playlist') + ' — set active to load it', 'ok')
        }
    }

    /* Replace an existing playlist's definition in place (same id/position),
     * drop its cached channels (the source may have changed), and reload it if
     * it's the active one. Used by the Edit flow. */
    function updatePlaylist(pl) {
        if (!pl || !pl.id) return;
        var pls = Store.getPlaylists();
        var found = false;
        for (var i = 0; i < pls.length; i++) {
            if (pls[i].id === pl.id) { pls[i] = pl; found = true; break; }
        }
        if (!found) { addPlaylist(pl); }
        else { Store.setPlaylists(pls); }
        Store.dropChannelsCache(pl.id);
        applyContentTypeVisibility();
        if (Store.getActivePlaylistId && Store.getActivePlaylistId() === pl.id) {
            loadPlaylistChannels(pl.id);
        }
        UI.showScreen('home');
        UI.showSection('playlists');
        UI.renderPlaylists();
        UI.toast(T('playlist_updated'), 'ok');
    }

    /* Open the manual-entry screen pre-filled to edit an existing playlist. On
     * save the playlist is updated in place rather than added. M3U, Xtream and
     * Stalker are all editable; an inline-content M3U (uploaded file) has no URL
     * to edit, so only its name is meaningfully editable there. */
    function openManualEntryForEdit(id) {
        var pls = Store.getPlaylists();
        var pl = null;
        for (var i = 0; i < pls.length; i++) if (pls[i].id === id) { pl = pls[i]; break; }
        if (!pl) return;
        window._editingPlaylistId = id;
        UI.showScreen('manualEntry');
        // Defer so the screen is in the DOM before we select the tab + fill.
        setTimeout(function () {
            var tabName = (pl.type === 'xtream') ? 'xtream' : (pl.type === 'stalker') ? 'stalker' : 'm3u';
            var tabBtn = document.querySelector('#manualEntry [data-tab="' + tabName + '"]');
            if (tabBtn) tabBtn.click();
            function setv(sel, v) { var e = document.querySelector(sel); if (e) e.value = v || ''; }
            if (pl.type === 'm3u') {
                setv('#m3uName', pl.name); setv('#m3uUrl', pl.url); setv('#m3uEpg', pl.epgUrl);
                // Restore Basic-auth creds for the playlist URL and EPG URL.
                function seedPw(id, val) {
                    var e = document.getElementById(id);
                    if (!e) return;
                    e._realValue = val || '';
                    if (e._maskFn) e._maskFn(); else e.value = e._realValue;
                }
                function restoreAuth(chkId, fieldsId, userId, passId, user, pass) {
                    var has = !!(user || pass);
                    var chk = document.getElementById(chkId);
                    var fields = document.getElementById(fieldsId);
                    if (chk) chk.checked = has;
                    if (fields) { if (has) fields.classList.remove('init-hidden'); else fields.classList.add('init-hidden'); }
                    setv('#' + userId, user);
                    seedPw(passId, pass);
                }
                restoreAuth('m3uAuth', 'm3uAuthFields', 'm3uAuthUser', 'm3uAuthPass', pl.authUser, pl.authPass);
                restoreAuth('m3uEpgAuth', 'm3uEpgAuthFields', 'm3uEpgAuthUser', 'm3uEpgAuthPass', pl.epgAuthUser, pl.epgAuthPass);
            } else if (pl.type === 'stalker') {
                setv('#stName', pl.name); setv('#stUrl', pl.url); setv('#stMac', pl.mac);
                setv('#stSerial', pl.serial); setv('#stDevId', pl.deviceId);
                // A saved model that is on the list selects it; any other value is the custom text.
                var stSel = $('#stModel'), stModel = pl.stbModel || '', stListed = false;
                if (stSel) {
                    for (var smi = 0; smi < stSel.options.length; smi++) { if (stSel.options[smi].value === stModel) stListed = true; }
                    stSel.value = stListed ? stModel : '';
                }
                setv('#stModelCustom', stListed ? '' : stModel);
            } else {
                setv('#xtName', pl.name); setv('#xtHost', pl.host); setv('#xtUser', pl.user);
                // Password is a vkeyboard _isPassword field: seed _realValue and
                // render it masked, rather than writing plaintext to .value.
                var xpf = document.getElementById('xtPass');
                if (xpf) {
                    xpf._realValue = pl.pass || '';
                    if (xpf._maskFn) xpf._maskFn();
                    else xpf.value = xpf._realValue;
                }
            }
            // Restore content-type + EPG toggles for xtream/stalker.
            if (pl.type === 'xtream' || pl.type === 'stalker') {
                var ct = pl.contentTypes || { live: true, movies: true, series: true };
                var p = (pl.type === 'stalker') ? 'stalker' : 'manual';
                function setck(elid, on) { var e = document.getElementById(elid); if (e) e.checked = !!on; }
                setck(p === 'stalker' ? 'stalkerCtLive' : 'manualCtLive', ct.live);
                setck(p === 'stalker' ? 'stalkerCtMovies' : 'manualCtMovies', ct.movies);
                setck(p === 'stalker' ? 'stalkerCtSeries' : 'manualCtSeries', ct.series);
                setck(p === 'stalker' ? 'stalkerEpg' : 'manualEpg', pl.epgEnabled !== false);
            }
            Focus.refresh();
        }, 80);
    }

    /* ========== Wiring ========== */
    function wireNav() {
        var navs = $$('.nav-btn');
        for (var i = 0; i < navs.length; i++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    // Any sidebar tap leaves the current section: close the search keyboard
                    // now, even when a PIN prompt (Settings / Sources / Parental) comes first.
                    try { if (UI.dismissVKeyboard) UI.dismissVKeyboard(); } catch (eDkn) {}
                    // Exit button — show dialog
                    if (btn.id === 'navExit') {
                        showExitDialog();
                        return;
                    }
                    var section = btn.getAttribute('data-section');
                    if ((section === 'settings' || section === 'playlists' || section === 'parental') && window.Access && !Access.canProtected()) {
                        Access.requirePinStrict(section === 'settings' ? 'Unlock Settings' : (section === 'playlists' ? 'Unlock Playlists' : 'Unlock Parental Controls'), function (ok) {
                            if (!ok) return;
                            if (section === 'settings') populateSettings();
                            if (section === 'parental') Parental.renderParentalControls();
                            UI.showSection(section, true);
                        });
                        return;
                    }
                    if (section === 'settings') populateSettings();
                    if (section === 'parental') Parental.renderParentalControls();
                    UI.showSection(section, true);
                });
            })(navs[i]);
        }

        // Exit dialog buttons
        var exitYes = document.getElementById('exitYes');
        var exitNo = document.getElementById('exitNo');
        if (exitYes) exitYes.addEventListener('click', function () { tryExitApp(); });
        if (exitNo) exitNo.addEventListener('click', function () { hideExitDialog(); });
    }


    /* Sync the sidebar's content-type nav buttons (Live TV, Movies,
     * Series) with the user's preferences. Items whose type is disabled
     * are removed from view with display: none, which also takes them
     * out of the focus tree.
     *
     * Called on app init, after settings updates, after a cloud pull
     * lands new preferences, and after the pairing flow applies a
     * server-side selection. Idempotent — safe to call repeatedly. */
    function applyContentTypeVisibility() {
        // Side menu reflects the ACTIVE playlist's content selection
        // (per-playlist; defaults to all-on when there's no active playlist or
        // the playlist has no stored preference).
        var ct = { live: true, movies: true, series: true };
        var activeId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
        if (activeId && Store.getPlaylistContentTypes) {
            ct = Store.getPlaylistContentTypes(activeId);
        }
        var map = { livetv: ct.live, movies: ct.movies, series: ct.series };
        for (var key in map) {
            if (!map.hasOwnProperty(key)) continue;
            var btn = document.querySelector('.nav-btn[data-section="' + key + '"]');
            if (btn) btn.style.display = map[key] ? '' : 'none';
        }
        try { if (window.CatchupScreen) CatchupScreen.refreshNav(); } catch (eCuV) {}
        // If the currently-active section is one that just got disabled,
        // redirect the user to Home so they aren't stranded on a hidden
        // screen with no focusable nav button.
        var active = document.querySelector('.nav-btn.active');
        if (active) {
            var sec = active.getAttribute('data-section');
            if ((sec === 'livetv' && !ct.live) ||
                (sec === 'movies' && !ct.movies) ||
                (sec === 'series' && !ct.series)) {
                UI.showSection('home', true);
            }
        }
    }

    /* The one place the side menu is allowed to collapse. Touch devices keep it
     * permanently expanded (set once at boot, see boot()'s data-touch block), so a
     * collapse request from anywhere is ignored there; only non-touch (D-pad / remote)
     * devices ever collapse it. Before this, hideExitDialog() removed the class
     * unconditionally, so on a phone: Back on the menu, then dismissing the exit
     * prompt, left the menu collapsed for the rest of the session. */
    function collapseSidebar(sb) {
        if (!sb || document.documentElement.getAttribute('data-touch')) return;
        sb.classList.remove('expanded');
    }

    var exitPrevFocus = null;
    function showExitDialog() {
        var d = document.getElementById('exitDialog');
        var sb = document.getElementById('sidebar');
        // Remember where focus was so Cancel can put it back (the dialog can open
        // from screens that have no side menu, e.g. the Welcome screen).
        var pf = Focus.current();
        if (pf && !(d && d.contains(pf))) exitPrevFocus = pf;
        if (sb) sb.classList.add('expanded');
        if (d) {
            d.classList.remove('hidden');
            setTimeout(function () { Focus.focusKey('exit-no'); }, 50);
        }
    }
    function hideExitDialog() {
        var d = document.getElementById('exitDialog');
        var sb = document.getElementById('sidebar');
        if (d) d.classList.add('hidden');
        collapseSidebar(sb);
        var pf = exitPrevFocus;
        exitPrevFocus = null;
        if (pf && document.body.contains(pf) && pf.offsetParent !== null && Focus.focus(pf) !== false) return;
        Focus.focusKey('nav-exit');
    }
    // Return at the root of the app. Samsung (Tizen) requires an in-app
    // confirmation popup before the app terminates, and the app exits only when
    // the user picks "Yes". Android keeps its direct exit (Google Play wants Back
    // at the root to leave the app) and webOS hands Return to the platform before
    // this is reached.
    /* Screen Margin (overscan inset). 'off' or '2'/'4'/'6' percent. Sets
     * data-margin on <html>; screens.css insets #app. Android / Fire TV only. */
    function applyScreenMargin(v) {
        try {
            var root = document.documentElement;
            if (v === '2' || v === '4' || v === '6') root.setAttribute('data-margin', v);
            else root.removeAttribute('data-margin');
        } catch (e) {}
    }

    function exitOrConfirm() {
        var direct = false;
        try { direct = !!(typeof AndroidBridge !== 'undefined' && AndroidBridge && AndroidBridge.exitApp); } catch (e) {}
        if (direct) { tryExitApp(); return; }
        showExitDialog();
    }

    function wireManualEntry() {
        // M3U auth toggles: reveal/hide the username+password group for the
        // playlist URL and (separately) the EPG URL. Focus.refresh so the newly
        // shown fields become reachable by the remote.
        function wireAuthToggle(chkId, fieldsId) {
            var chk = document.getElementById(chkId);
            var fields = document.getElementById(fieldsId);
            if (!chk || !fields) return;
            chk.addEventListener('change', function () {
                if (chk.checked) fields.classList.remove('init-hidden');
                else fields.classList.add('init-hidden');
                Focus.refresh();
            });
        }
        wireAuthToggle('m3uAuth', 'm3uAuthFields');
        wireAuthToggle('m3uEpgAuth', 'm3uEpgAuthFields');

        // Tabs
        var tabs = $$('#manualEntry [data-tab]');
        for (var i = 0; i < tabs.length; i++) {
            (function (t) {
                t.addEventListener('click', function () {
                    var name = t.getAttribute('data-tab');
                    var allTabs = $$('#manualEntry [data-tab]');
                    var allPanels = $$('#manualEntry .tab-panel');
                    for (var j = 0; j < allTabs.length; j++) allTabs[j].classList.remove('active');
                    for (var k = 0; k < allPanels.length; k++) allPanels[k].classList.remove('active');
                    t.classList.add('active');
                    var panel = document.querySelector('#manualEntry .tab-panel[data-panel="' + name + '"]');
                    if (panel) panel.classList.add('active');
                    Focus.refresh();
                });
            })(tabs[i]);
        }

        // Save
        var saveBtn = $('#manualSave');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                var activeTab = document.querySelector('#manualEntry [data-tab].active');
                var which = activeTab ? activeTab.getAttribute('data-tab') : 'm3u';
                var editId = window._editingPlaylistId || null;
                var pl;
                if (which === 'm3u') {
                    var name = ($('#m3uName') || {}).value || 'Playlist';
                    var url = ($('#m3uUrl') || {}).value || '';
                    var epgUrl = ($('#m3uEpg') || {}).value || '';
                    if (!url) { UI.toast(T('enter_an_m3u_url'), 'err'); return; }
                    // A plain word with no
                    // scheme used to save as the active source with no validation error.
                    if (!Util.isHttpUrl(url)) { UI.toast(T('err_invalid_url', { field: T('ui_m3u_url') }), 'err'); return; }
                    if (epgUrl && !Util.isHttpUrl(epgUrl)) { UI.toast(T('err_invalid_url', { field: T('ui_epg_url_optional') }), 'err'); return; }
                    pl = { id: editId || Util.uuid(), name: name, type: 'm3u', url: url, epgUrl: epgUrl };
                    // Optional Basic-auth credentials for the playlist URL and,
                    // separately, the EPG URL (they can require different logins).
                    // Password real value lives in _realValue (vkeyboard-masked).
                    function pwVal(id) { var e = document.getElementById(id); return e ? (e._isPassword ? (e._realValue || '') : (e.value || '')) : ''; }
                    var m3uAuthOn = ($('#m3uAuth') || {}).checked;
                    if (m3uAuthOn) {
                        var au = ($('#m3uAuthUser') || {}).value || '';
                        var ap = pwVal('m3uAuthPass');
                        if (au || ap) { pl.authUser = au; pl.authPass = ap; }
                    }
                    var m3uEpgAuthOn = ($('#m3uEpgAuth') || {}).checked;
                    if (m3uEpgAuthOn) {
                        var eu = ($('#m3uEpgAuthUser') || {}).value || '';
                        var ep2 = pwVal('m3uEpgAuthPass');
                        if (eu || ep2) { pl.epgAuthUser = eu; pl.epgAuthPass = ep2; }
                    }
                } else if (which === 'stalker') {
                    var sname = ($('#stName') || {}).value || 'Portal';
                    var surl = ($('#stUrl') || {}).value || '';
                    var smac = ($('#stMac') || {}).value || '';
                    if (!surl || !smac) { UI.toast(T('enter_the_portal_url_and_mac'), 'err'); return; }
                    // Same fix as Xtream/M3U:
                    // a plain word used to save as the active portal with no error.
                    if (!Util.isHttpUrl(surl)) { UI.toast(T('err_invalid_url', { field: T('ui_portal_url') }), 'err'); return; }
                    pl = {
                        id: editId || Util.uuid(), name: sname, type: 'stalker', url: surl, mac: smac,
                        serial: ($('#stSerial') || {}).value || '',
                        deviceId: ($('#stDevId') || {}).value || ''
                    };
                    // STB model: the custom text wins over the list; empty = the default identity.
                    var stbModel = (((($('#stModelCustom') || {}).value) || '').replace(/^\s+|\s+$/g, '')) || ((($('#stModel') || {}).value) || '');
                    if (stbModel && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(stbModel)) { UI.toast(T('err_stb_model_invalid'), 'err'); return; }
                    if (stbModel) pl.stbModel = stbModel;
                } else {
                    var xname = ($('#xtName') || {}).value || 'Xtream';
                    var host = ($('#xtHost') || {}).value || '';
                    var user = ($('#xtUser') || {}).value || '';
                    var pass = (function () {
                        var el = $('#xtPass');
                        if (el && el._isPassword) return el._realValue || '';
                        return (el || {}).value || '';
                    })();
                    if (!host || !user || !pass) { UI.toast(T('fill_all_xtream_fields'), 'err'); return; }
                    // This exact field, a plain
                    // word ("bad") used to save as the active source with no error.
                    if (!Util.isHttpUrl(host)) { UI.toast(T('err_invalid_url', { field: T('ui_server_url') }), 'err'); return; }
                    pl = { id: editId || Util.uuid(), name: xname, type: 'xtream', host: host, user: user, pass: pass };
                }
                // Both Xtream and Stalker: probe the credentials against the
                // actual provider before saving (wrong credentials used to save with no auth error
                // at all). Xtream: Api.xtreamAuth() runs directly against the
                // user's own provider, same as every other Xtream request;
                // never touches this project's own server. Stalker: routed
                // through the pairing server's new /api/stalker/probe (same
                // as every OTHER Stalker request already is — nothing new is
                // captured/retained beyond what saving the playlist already
                // requires), which reuses the real handshake -> get_profile ->
                // get_genres sequence and reports a rejected MAC as HTTP 401,
                // same as every other Stalker route. Neither treats a network
                // failure/timeout as proof of wrong credentials (that would
                // repeat the exact mistake this project already made once
                // with Stalker EPG and a genuine provider outage) — the user
                // gets a choice to save anyway rather than being blocked by
                // what could be a transient problem.
                if (which === 'xtream' || which === 'stalker') {
                    saveBtn.disabled = true;
                    saveBtn.textContent = T('ui_checking_account');
                    var probePl = pl;
                    var probePromise = which === 'xtream'
                        ? Api.xtreamAuth(probePl.host, probePl.user, probePl.pass)
                        : Api.stalkerProbe(probePl);
                    probePromise.then(function () {
                        saveBtn.disabled = false;
                        saveBtn.textContent = T('ui_save_playlist');
                        finishPlaylistSave(probePl, which, editId);
                    })['catch'](function (e) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = T('ui_save_playlist');
                        // Xtream's own auth check throws {err:'auth-failed'};
                        // Stalker's rejection surfaces as HTTP 401 from the
                        // pairing server, the same code:'auth' mapping every
                        // other Stalker route already uses.
                        var isAuthFailed = which === 'xtream' ? (e && e.err === 'auth-failed') : (e && e.status === 401);
                        if (isAuthFailed) {
                            UI.toast(T(which === 'xtream' ? 'err_xtream_auth_failed' : 'err_stalker_auth_failed'), 'err');
                            return;
                        }
                        // The portal itself refused this device (for example a serial
                        // number mismatch). Show its own message; saving anyway would
                        // only fail again on load.
                        if (which !== 'xtream' && e && e.status === 403 && e.body && e.body.error) {
                            UI.toast(String(e.body.error), 'err');
                            return;
                        }
                        // Anything else (network/timeout/bad-json/HTTP status) is
                        // the provider being unreachable right now, not proof the
                        // credentials are wrong — offer to save anyway rather
                        // than silently blocking on what could be a temporary blip.
                        var body = document.createElement('div');
                        var desc = document.createElement('div');
                        desc.className = 'modal-body';
                        desc.textContent = T('xtream_verify_failed_body');
                        body.appendChild(desc);
                        var actions = document.createElement('div');
                        actions.className = 'modal-actions';
                        function mkVerifyBtn(label, handler) {
                            var b = document.createElement('button');
                            b.className = 'btn focusable modal-btn';
                            b.textContent = label;
                            b.addEventListener('click', function () { UI.closeModal(); handler(); });
                            return b;
                        }
                        actions.appendChild(mkVerifyBtn(T('ui_save_anyway'), function () {
                            finishPlaylistSave(probePl, which, editId);
                        }));
                        actions.appendChild(mkVerifyBtn(T('cancel'), function () {}));
                        body.appendChild(actions);
                        UI.openModal({ title: T('xtream_verify_failed_title'), bodyEl: body, cancelText: false });
                    });
                    return;
                }
                finishPlaylistSave(pl, which, editId);
            });
        }

        function finishPlaylistSave(pl, which, editId) {
                // Content selection applies to Xtream and Stalker (both have a
                // real live/movies/series split); M3U is a single flat file, so
                // it's skipped there. Read the right tab's toggles; require one.
                if (which === 'xtream' || which === 'stalker') {
                    var pfx = which === 'stalker' ? 'stalker' : 'manual';
                    var ctLiveEl = document.getElementById(which === 'stalker' ? 'stalkerCtLive' : 'manualCtLive');
                    var ctMoviesEl = document.getElementById(which === 'stalker' ? 'stalkerCtMovies' : 'manualCtMovies');
                    var ctSeriesEl = document.getElementById(which === 'stalker' ? 'stalkerCtSeries' : 'manualCtSeries');
                    var ctLive = ctLiveEl ? !!ctLiveEl.checked : true;
                    var ctMovies = ctMoviesEl ? !!ctMoviesEl.checked : true;
                    var ctSeries = ctSeriesEl ? !!ctSeriesEl.checked : true;
                    if (!ctLive && !ctMovies && !ctSeries) {
                        UI.toast(T('pick_at_least_one_content_type'), 'err');
                        return;
                    }
                    pl.contentTypes = { live: ctLive, movies: ctMovies, series: ctSeries };
                    var epgEl = document.getElementById(which === 'stalker' ? 'stalkerEpg' : 'manualEpg');
                    pl.epgEnabled = epgEl ? !!epgEl.checked : true;
                }
                if (editId) {
                    // Editing an existing playlist: replace it in place (keep its
                    // id/position), drop its cached channels so the corrected
                    // source is re-fetched, and reload if it's the active one.
                    // Explicitly clear the shell/creds-needed flags: this object is
                    // freshly built from the form so it already lacks them, but be
                    // defensive in case any survive on a merged copy.
                    if (pl.hasOwnProperty('credsNeeded')) delete pl.credsNeeded;
                    if (pl.hasOwnProperty('credsStripped')) delete pl.credsStripped;
                    // If this edit just supplied the credentials a shell was
                    // missing, make it active and load it — otherwise a shell that
                    // wasn't already the active playlist would save but never load,
                    // leaving the "credentials needed" chip stuck.
                    var wasCredsFix = !playlistNeedsCreds(pl);
                    updatePlaylist(pl);
                    window._editingPlaylistId = null;
                    if (wasCredsFix && Store.getActivePlaylistId && Store.getActivePlaylistId() !== pl.id) {
                        activatePlaylist(pl.id, false);
                    }
                } else {
                    addPlaylist(pl);
                    activatePlaylist(pl.id, true);
                }
        }

        var cancelBtn = $('#manualCancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function () {
                window._editingPlaylistId = null;
                if (Store.getPlaylists().length) {
                    UI.showScreen('home');
                    UI.showSection('playlists');
                    setTimeout(function () {
                        if (window._lastPlaylistFocusEl && document.body.contains(window._lastPlaylistFocusEl)) {
                            Focus.focus(window._lastPlaylistFocusEl);
                        }
                    }, 150);
                } else {
                    goOnboarding();
                }
            });
        }

        // STB model list: product names, filled here (they are not translated text).
        var stModelSel = $('#stModel');
        if (stModelSel && stModelSel.options.length < 2) {
            var stModels = ['MAG200', 'MAG250', 'MAG254', 'MAG256', 'MAG270', 'MAG322', 'MAG324', 'MAG420', 'AuraHD'];
            for (var smo = 0; smo < stModels.length; smo++) {
                var stOpt = document.createElement('option');
                stOpt.value = stModels[smo]; stOpt.textContent = stModels[smo];
                stModelSel.appendChild(stOpt);
            }
        }

        // Open vkeyboard on focus of any text input in manual entry
        // Set inputs readonly to prevent LG/Tizen system keyboard from appearing
        var fields = $$('#manualEntry .field');
        for (var f = 0; f < fields.length; f++) {
            (function (fld, idx) {
                // Readonly prevents system keyboard but allows our virtual keyboard
                if (fld.tagName === 'SELECT') return;   // a list (STB model) opens its own picker, not the keyboard
                if (fld.tagName === 'INPUT' || fld.tagName === 'TEXTAREA') {
                    fld.setAttribute('readonly', 'readonly');
                }
                fld.addEventListener('click', function () {
                    UI.openVKeyboard(fld);
                });
            })(fields[f], f);
        }

        // Wire the Xtream password field into the vkeyboard's canonical
        // password masking — the same mechanism the sign-in modal uses — so it's
        // consistent with every other password field and gets the vkeyboard's
        // built-in show/hide (eye) toggle. The field is type=text (the vkeyboard
        // does the masking, not the browser): the true value lives in _realValue,
        // the visible .value is masked bullets, and _maskFn rebuilds the mask. The
        // save + edit-prefill read/write _realValue accordingly.
        setupPasswordField(document.getElementById('xtPass'));
        // M3U auth password fields (playlist URL auth + EPG URL auth) use the same
        // vkeyboard password treatment so they mask and get the show/hide toggle.
        setupPasswordField(document.getElementById('m3uAuthPass'));
        setupPasswordField(document.getElementById('m3uEpgAuthPass'));
    }

    /* Turn a plain text <input> into a vkeyboard password field: masked display,
     * true value in _realValue, and the built-in show/hide (eye) toggle. The
     * field MUST be type=text (the vkeyboard masks, not the browser). Idempotent. */
    function setupPasswordField(el) {
        if (!el || el._isPassword) return;
        el._realValue = el._realValue || '';
        el._maskTimer = null;
        el._maskFn = function () {
            var real = el._realValue || '';
            if (!real) { el.value = ''; return; }
            if (real.length <= 1) {
                el.value = real;
            } else {
                var masked = '';
                for (var mi = 0; mi < real.length - 1; mi++) masked += '\u2022';
                masked += real.charAt(real.length - 1);
                el.value = masked;
            }
            if (el._maskTimer) clearTimeout(el._maskTimer);
            el._maskTimer = setTimeout(function () {
                var r2 = el._realValue || '';
                var full = '';
                for (var fi = 0; fi < r2.length; fi++) full += '\u2022';
                el.value = full;
            }, 800);
        };
        el._isPassword = true;
    }

    /* A new portal starts on the default STB model, never on the one last edited. */
    function resetStalkerModelFields() {
        var sel = $('#stModel'), cus = $('#stModelCustom');
        if (sel) sel.value = '';
        if (cus) cus.value = '';
    }

    function wirePlaylistButtons() {
        var add = $('#plAdd');
        if (add) add.addEventListener('click', function () {
            window._editingPlaylistId = null;
            resetStalkerModelFields();
            window._lastPlaylistFocusEl = add;
            stopPairPoll();
            UI.showScreen('manualEntry');
        });
        var pair = $('#plPair');
        if (pair) pair.addEventListener('click', function () {
            window._lastPlaylistFocusEl = pair;
            goOnboarding();
        });
        var del = $('#plDeleteAll');
        if (del) del.addEventListener('click', function () {
            if (window.Access && !Access.canProtected()) { Access.requirePinStrict(T('ap_unlock_data_wipe'), function(ok){ if(ok && del) del.click(); }); return; }
            UI.openModal({
                title: T('ap_delete_all_sources'),
                body: T('ap_delete_all_body'),
                okText: T('ap_delete_all'),
                onOk: function () {
                    Store.setPlaylists([]);
                    Store.setActivePlaylistId(null);
                    UI.setChannels([]);
                    UI.setActivePlaylistChip('No playlist', 0);
                    UI.renderPlaylists();
                    UI.renderHome();
                    UI.toast(T('all_playlists_deleted'), 'ok');
                }
            });
        });

        // Language button on the pairing screen (same list and reload as Settings > Language)
        (function () {
            var pl = document.getElementById('pairLang');
            if (!pl || typeof I18n === 'undefined' || !I18n.getLanguages) return;
            var plangs = I18n.getLanguages();
            plangs.sort(function (a, b) {
                if (a.code === 'en') return -1;
                if (b.code === 'en') return 1;
                return a.native.localeCompare(b.native, 'en');
            });
            var plabel = function (l) { return (l.code === 'en') ? l.native : l.native + ' (' + l.name + ')'; };
            var pcur = (Store.getSettings().language) || 'en';
            var pidx = 0;
            for (var pj = 0; pj < plangs.length; pj++) { if (plangs[pj].code === pcur) { pidx = pj; break; } }
            var plv = document.getElementById('pairLangVal');
            if (plv) plv.textContent = ': ' + (plangs.length ? plabel(plangs[pidx]) : pcur);
            pl.addEventListener('click', function () {
                var items = [];
                for (var pk = 0; pk < plangs.length; pk++) items.push(plabel(plangs[pk]));
                UI.openListPicker({
                    title: T('ui_language'),
                    items: items,
                    selected: pidx,
                    onSelect: function (i) { applyLanguage(plangs[i].code, true); }
                });
            });
        })();

        // Onboarding actions
        var pmManual = document.querySelector('[data-focus-key="pair-manual"]');
        if (pmManual) pmManual.addEventListener('click', function () { window._editingPlaylistId = null; resetStalkerModelFields(); window._lastPlaylistFocusEl = pmManual; stopPairPoll(); UI.showScreen('manualEntry'); });
        var pmRefresh = document.querySelector('[data-focus-key="pair-refresh"]');
        if (pmRefresh) pmRefresh.addEventListener('click', function () { startPairFlow(); });
        var pmSkip = document.querySelector('[data-focus-key="pair-skip"]');
        if (pmSkip) pmSkip.addEventListener('click', function () {
            stopPairPoll();
            showExitDialog();
        });

        // Sign In & Sync on pairing screen — wired in wireSyncUI()

        // Hero play - resume last watched channel
        var heroPlay = $('#heroPlay');
        if (heroPlay) heroPlay.addEventListener('click', function () {
            var ch = Player.currentChannel() || Store.getLastChannel();
            if (!ch) {
                var list = UI.getChannels();
                if (list && list.length) ch = list[0];
            }
            if (!ch) return;
            // For on-demand content, enrich from VOD history: getLastChannel stores
            // a slim record that drops currentTime/progress (and stalker resolve
            // fields), so without this the hero couldn't resume (or even resolve a
            // Stalker stream). Match by id within the same playlist.
            var isVodCh = (ch.type === 'vod' || ch.type === 'series' ||
                (ch.type === 'stalker' && (ch.stalkerKind === 'vod' || ch.stalkerKind === 'series')));
            if (isVodCh && Store.getVodHistory) {
                try {
                    var hist = Store.getVodHistory() || [];
                    for (var i = 0; i < hist.length; i++) {
                        if (hist[i] && hist[i].id === ch.id && hist[i].playlistId === ch.playlistId) {
                            // Merge history fields onto the channel (history wins for
                            // progress + stalker resolve data).
                            var h = hist[i];
                            for (var k in h) { if (h.hasOwnProperty(k) && h[k] != null) ch[k] = h[k]; }
                            break;
                        }
                    }
                } catch (eHist) {}
            }
            // Route through tryPlay so VOD gets the resume prompt and everything
            // gets the parental gates (Player.play directly bypassed both). tryPlay
            // -> doPlay switches to the player screen itself.
            if (UI.tryPlay) { UI.tryPlay(ch); }
            else { UI.showScreen('player'); Player.play(ch); }
        });
    }

    var settingsSaveTimer = null;
    function saveSettingsDebounced() {
        if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
        settingsSaveTimer = setTimeout(function () {
            var p = $('#setPlayer');
            var o = $('#setOverlay');
            var ar = $('#setAutoResume');
            var s = $('#setSync');
            var sc = $('#setScale');
            var ts = $('#setTextSize');
            var pm = $('#setPerfMode');
            var ccv = $('#setCacheVod');
            var spa = $('#setSportsAllPl');
            var lll = $('#setLiveLogos');
            var st = Store.getSettings();
            if (p) st.player = p.value;
            if (o) st.overlayMs = parseInt(o.value, 10);
            if (ar) st.autoResume = ar.value;
            if (ccv) st.cacheVod = ccv.value;
            if (spa) st.sportsAllPl = spa.value;
            if (lll) st.liveListLogos = lll.value;
            if (s) st.sync = s.value;
            if (sc) st.videoScale = sc.value;
            // Persist text-size selection.
            if (ts) st.textSize = ts.value;
            // Persist theme selection (applied live in wireSettings' change handler).
            var thSel = $('#setTheme');
            if (thSel) st.theme = thSel.value;
            var smSel = $('#setScreenMargin');
            if (smSel) st.screenMargin = smSel.value;
            // Persist performance mode selection (PerfConfig.setMode also writes
            // it; keeping it here means the debounced save never clobbers it).
            if (pm) st.perfMode = pm.value;
            Store.setSettings(st);
            // Apply video scale immediately
            applyVideoScale(st.videoScale);
        }, 500);
    }

    function applyVideoScale(scale) {
        var vid = document.querySelector('#videoEl');
        var stage, stageW, stageH, videoW, videoH, stageRatio, videoRatio;
        var targetW, targetH, left, top;

        if (!vid) vid = document.querySelector('.player-stage video');
        if (!vid) return;

        stage = vid.parentNode;
        if (!stage || !stage.clientWidth || !stage.clientHeight) {
            stage = document.querySelector('.player-stage');
        }
        if (!stage) return;

        if (scale === 'fill') scale = 'fill-h';
        if (scale !== 'contain' && scale !== 'cover' && scale !== 'fill-v' && scale !== 'fill-h' && scale !== 'four-three') {
            scale = 'contain';
        }

        stageW = stage.clientWidth || 1920;
        stageH = stage.clientHeight || 1080;
        videoW = vid.videoWidth || 0;
        videoH = vid.videoHeight || 0;
        // On the native ExoPlayer engine the picture is a surface behind the
        // WebView, so the hidden <video> reports no size. Use the size native
        // reported; the rect computed below is then pushed to the surface.
        if ((!videoW || !videoH) && window.PlayerExo && PlayerExo.getVideoSize && exoDrivesMainPlayer()) {
            var exSz = PlayerExo.getVideoSize();
            if (exSz) { videoW = exSz.w; videoH = exSz.h; }
        }

        vid.style.position = 'absolute';
        vid.style.margin = '0';
        vid.style.padding = '0';
        vid.style.right = 'auto';
        vid.style.bottom = 'auto';
        vid.style.maxWidth = 'none';
        vid.style.maxHeight = 'none';
        vid.style.transform = 'none';
        vid.style.webkitTransform = 'none';
        vid.style.transformOrigin = '0 0';
        vid.style.webkitTransformOrigin = '0 0';
        vid.style.objectFit = 'fill';
        vid.style.background = '#000';

        vid.classList.remove('scale-contain', 'scale-cover', 'scale-fill', 'scale-fill-h', 'scale-fill-v', 'scale-four-three');
        vid.classList.add('scale-' + scale);

        if (!videoW || !videoH) {
            if (scale === 'contain' || scale === 'cover') {
                vid.style.width = stageW + 'px';
                vid.style.height = stageH + 'px';
                vid.style.left = '0px';
                vid.style.top = '0px';
            } else if (scale === 'fill-v') {
                vid.style.width = stageW + 'px';
                vid.style.height = Math.round(stageH * 1.35) + 'px';
                vid.style.left = '0px';
                vid.style.top = Math.round((stageH - (stageH * 1.35)) / 2) + 'px';
            } else if (scale === 'four-three') {
                // 4:3 pillarbox: height fills the stage, width = height*(4/3),
                // centered with black bars left/right (shrinks a 16:9 source
                // horizontally into a 4:3 frame).
                vid.style.height = stageH + 'px';
                vid.style.width = Math.round(stageH * (4 / 3)) + 'px';
                vid.style.left = Math.round((stageW - (stageH * (4 / 3))) / 2) + 'px';
                vid.style.top = '0px';
            } else {
                vid.style.width = Math.round(stageW * 1.3333) + 'px';
                vid.style.height = stageH + 'px';
                vid.style.left = Math.round((stageW - (stageW * 1.3333)) / 2) + 'px';
                vid.style.top = '0px';
            }
            pushNativeVideoRect(vid, stage, scale);
            return;
        }

        stageRatio = stageW / stageH;
        videoRatio = videoW / videoH;

        if (scale === 'contain') {
            if (videoRatio > stageRatio) {
                targetW = stageW;
                targetH = Math.round(stageW / videoRatio);
            } else {
                targetH = stageH;
                targetW = Math.round(stageH * videoRatio);
            }
        } else if (scale === 'cover') {
            if (videoRatio > stageRatio) {
                targetH = stageH;
                targetW = Math.round(stageH * videoRatio);
            } else {
                targetW = stageW;
                targetH = Math.round(stageW / videoRatio);
            }
        } else if (scale === 'fill-v') {
            targetW = stageW;
            targetH = Math.round(stageH * 1.35);
        } else if (scale === 'four-three') {
            // 4:3 pillarbox: lock the displayed box to a 4:3 aspect, height
            // fitted to the stage. With object-fit:fill the source is
            // squeezed into this narrower box → pillarboxed black bars at
            // the sides. Mirrors the existing centered targetW/targetH math.
            targetH = stageH;
            targetW = Math.round(stageH * (4 / 3));
        } else {
            targetW = Math.round(stageW * 1.3333);
            targetH = stageH;
        }

        left = Math.round((stageW - targetW) / 2);
        top = Math.round((stageH - targetH) / 2);

        vid.style.width = targetW + 'px';
        vid.style.height = targetH + 'px';
        vid.style.left = left + 'px';
        vid.style.top = top + 'px';
        pushNativeVideoRect(vid, stage, scale);
    }

    /* True while ExoPlayer (not the live-TV mini player) is driving the main
     * player: player.js sets html[data-exo-active] only in that case. */
    function exoDrivesMainPlayer() {
        return !!(document.documentElement && document.documentElement.hasAttribute('data-exo-active'));
    }

    /* The rect applyVideoScale just wrote onto the (hidden) <video> is the rect
     * the picture should occupy. On the native engines the picture is not that
     * element, so hand the same rect to the engine that is driving the player:
     * ExoPlayer (Android) moves its surface, Tizen AVPlay sets its display rect and
     * method. Scaling therefore works for MKV/HEVC like it does for the WebView
     * path. The data-avplay-active stage flag is shared by both engines, so Exo is
     * ruled out first. */
    function pushNativeVideoRect(vid, stage, scale) {
        try {
            var sr = stage.getBoundingClientRect();
            var x = (parseFloat(vid.style.left) || 0) + sr.left;
            var y = (parseFloat(vid.style.top) || 0) + sr.top;
            var w = parseFloat(vid.style.width) || stage.clientWidth || 1920;
            var h = parseFloat(vid.style.height) || stage.clientHeight || 1080;
            if (exoDrivesMainPlayer()) {
                if (window.PlayerExo && PlayerExo.setVideoRect) PlayerExo.setVideoRect(x, y, w, h);
            } else if (stage.hasAttribute('data-avplay-active') && window.PlayerAVPlay && PlayerAVPlay.setScale) {
                PlayerAVPlay.setScale(scale, x, y, w, h);
            }
        } catch (e) {}
    }

    var _videoScaleBound = false;
    function bindVideoScaleRefresh() {
        var vid = document.querySelector('#videoEl') || document.querySelector('.player-stage video');
        if (!vid || _videoScaleBound) return;
        function refreshScaleNow() {
            var st = Store.getSettings ? Store.getSettings() : null;
            var scale = st && st.videoScale ? st.videoScale : 'contain';
            applyVideoScale(scale);
        }
        try { vid.addEventListener('loadedmetadata', refreshScaleNow); } catch (e1) {}
        try { vid.addEventListener('resize', refreshScaleNow); } catch (e2) {}
        try { vid.addEventListener('playing', refreshScaleNow); } catch (e3) {}
        try { window.addEventListener('resize', refreshScaleNow); } catch (e4) {}
        _videoScaleBound = true;
    }

    function wireSettings() {
        var p = $('#setPlayer');
        var o = $('#setOverlay');
        var ar = $('#setAutoResume');
        var s = $('#setSync');
        var sc = $('#setScale');
        var ts = $('#setTextSize');
        var lang = $('#setLanguage');
        var r = $('#setReset');
        /* Direct (sideload) build only: Check for Updates. Reads latest.json
         * {version, apk, sha256, notes} from APP_CONFIG.UPDATE_URL and, when newer,
         * downloads the APK inside the app (checked against the sha256) and opens the package
         * installer; without native support it opens the APK link in the browser. Store builds have UPDATE_CHANNEL '' and never show this. */
        (function () {
            var cfgU = (typeof APP_CONFIG !== 'undefined') ? APP_CONFIG : null;
            var ub = $('#updateCheckBtn'), urow = $('#updateRow'), udesc = $('#updateDesc');
            if (!cfgU || cfgU.UPDATE_CHANNEL !== 'direct' || !ub || !urow) return;
            if (!(typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView())) return;
            urow.classList.remove('init-hidden');
            function parseVer(v) {
                var m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
                return m ? [+m[1], +m[2], +m[3], +(m[4] || 0)] : null;
            }
            function newer(a, b) {
                for (var i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
                return false;
            }
            /* Download inside the app (direct build with the install permission only). The
             * native side downloads, checks the SHA-256 from latest.json and opens the system
             * installer. Anything else (store build, old native side, network trouble) falls
             * back to the browser hand-off. A hash mismatch never falls back. */
            function browserHandOff(apk) { window.location.href = apk; }
            function startDownload(apk, sha) {
                var b = window.AndroidBridge;
                var can = false;
                try { can = !!(b && typeof b.updateStart === 'function' && b.updateSupported()); } catch (eC) {}
                if (!can || !/^[0-9a-f]{64}$/i.test(String(sha || ''))) { browserHandOff(apk); return; }
                var open = true;
                function setText(t) { var m = document.getElementById('modalBody'); if (m) m.textContent = t; }
                function finish() { open = false; window.XtivioUpdate = null; }
                window.XtivioUpdate = {
                    _onNative: function (evt, d) {
                        if (!open) return;
                        if (evt === 'progress') setText(T('ui_update_downloading').replace('{p}', String(d.pct)));
                        else if (evt === 'verify') setText(T('ui_update_verifying'));
                        else if (evt === 'installing') { finish(); UI.closeModal(); }
                        else if (evt === 'needperm') { finish(); UI.closeModal(); UI.toast(T('ui_update_allow_install'), 'ok'); }
                        else if (evt === 'error') {
                            finish(); UI.closeModal();
                            if (d && d.code === 'hash') UI.toast(T('ui_update_hash_bad'), 'err');
                            else { UI.toast(T('ui_update_fallback'), 'err'); browserHandOff(apk); }
                        }
                    }
                };
                setTimeout(function () {
                    UI.openModal({
                        title: T('ui_update_check'),
                        body: T('ui_update_downloading').replace('{p}', '0'),
                        okText: false,
                        onCancel: function () { if (open) { try { b.updateCancel(); } catch (eX) {} finish(); } }
                    });
                    try { b.updateStart(apk, String(sha).toLowerCase()); } catch (eS) { finish(); UI.closeModal(); browserHandOff(apk); }
                }, 50);
            }
            /* silent=true is the automatic startup check: no toasts, no button state, a
             * failure is ignored, and a version the user already dismissed is not offered
             * again. The manual button always answers. */
            function checkUpdate(silent) {
                var cur = parseVer(cfgU.INSTALL_TOKEN);
                if (!silent) { if (udesc) udesc.textContent = ''; ub.disabled = true; }
                var done = function () { if (!silent) ub.disabled = false; };
                var fail = function () { done(); if (!silent) UI.toast(T('ui_update_failed'), 'err'); };
                var xhr = new XMLHttpRequest();
                xhr.open('GET', cfgU.UPDATE_URL + '?t=' + Date.now(), true);
                xhr.timeout = 15000;
                xhr.onload = function () {
                    done();
                    var info = null;
                    try { info = JSON.parse(xhr.responseText); } catch (eJ) {}
                    var nv = info && parseVer(info.version);
                    var apk = info && typeof info.apk === 'string' && /^https:\/\//i.test(info.apk) ? info.apk : '';
                    if (xhr.status !== 200 || !nv || !apk || !cur) { if (!silent) UI.toast(T('ui_update_failed'), 'err'); return; }
                    if (!newer(nv, cur)) {
                        if (!silent) {
                            if (udesc) udesc.textContent = T('ui_update_none');
                            UI.toast(T('ui_update_none'), 'ok');
                        }
                        return;
                    }
                    if (silent) {
                        var seen = '';
                        try { seen = localStorage.getItem('xtivio.updateDismissed') || ''; } catch (eS) {}
                        if (seen === String(info.version)) return;
                    }
                    UI.openModal({
                        title: T('ui_update_check'),
                        body: T('ui_update_available').replace('{v}', String(info.version)) +
                            (info.notes ? '\n\n' + String(info.notes).slice(0, 400) : ''),
                        okText: T('ui_update_download'),
                        onOk: function () { startDownload(apk, info.sha256); },
                        onCancel: function () {
                            try { localStorage.setItem('xtivio.updateDismissed', String(info.version)); } catch (eD) {}
                        }
                    });
                };
                xhr.onerror = xhr.ontimeout = fail;
                xhr.send();
            }
            ub.addEventListener('click', function () { checkUpdate(false); });
            /* Automatic check: once per day at most, a few seconds after start, and never over
             * a playing picture (the Exo surface marks the page). Skipped checks retry next start. */
            setTimeout(function () {
                try {
                    if (document.documentElement.hasAttribute('data-exo-active')) return;
                    var last = +(localStorage.getItem('xtivio.updateChecked') || 0);
                    if (Date.now() - last < 86400000) return;
                    localStorage.setItem('xtivio.updateChecked', String(Date.now()));
                } catch (eT) {}
                checkUpdate(true);
            }, 12000);
        })();
        var epgManage = $('#setEpgManage');
        var touchMode = $('#setTouchMode');
        /* Theme: a pure CSS-variable swap (theme.js sets data-theme on <html>), so
         * unlike Language / Touch Mode it applies instantly with no reload. Saved
         * straight away rather than through the debounced save so the choice
         * survives a quick exit. Device-local (excluded from cloud sync). */
        var themeSel = $('#setTheme');
        if (themeSel) themeSel.addEventListener('change', function () {
            var stT = Store.getSettings();
            stT.theme = themeSel.value;
            Store.setSettings(stT);
            if (window.Theme) Theme.apply(themeSel.value);
        });
        /* Screen Margin: insets the app from the screen edges for TVs that crop
         * (overscan). A pure CSS attribute on <html>, so it applies instantly.
         * Android / Fire TV only (the row is hidden elsewhere); device-local. */
        var marginSel = $('#setScreenMargin');
        if (marginSel) marginSel.addEventListener('change', function () {
            var stM = Store.getSettings();
            stM.screenMargin = marginSel.value;
            Store.setSettings(stM);
            applyScreenMargin(marginSel.value);
        });
        /* Playback Buffer (Android / ExoPlayer only; the row is hidden elsewhere). Device-local.
         * Applied from the next stream that starts. */
        var clockSel = $('#setPlayerClock');
        if (clockSel) clockSel.addEventListener('change', function () {
            var stC = Store.getSettings();
            stC.playerClock = clockSel.value;
            Store.setSettings(stC);
            try { Player.refreshClock(); } catch (eC) {}
        });
        /* Match Frame Rate (Android / ExoPlayer only; the row is hidden elsewhere). Device-local. Applied from the next stream. */
        var afrSel = $('#setAfr');
        if (afrSel) afrSel.addEventListener('change', function () {
            var stA = Store.getSettings();
            stA.afr = afrSel.value;
            Store.setSettings(stA);
        });
        var bufferSel = $('#setBufferReserve');
        if (bufferSel) bufferSel.addEventListener('change', function () {
            var stB = Store.getSettings();
            stB.bufferReserve = bufferSel.value;
            Store.setSettings(stB);
        });
        /* Touch/Remote Mode override — like Language, this needs a reload to
         * take effect: Mobile.isTouch() (mobile.js) caches its result once per
         * session in a closure variable, computed the first time anything asks
         * — it's read very early in boot (sidebar setup, player overlay wiring,
         * etc.), long before this settings screen could possibly be open. There
         * is no live re-evaluation to hook into; a reload is the only way this
         * setting can actually change anything the person can see. Saved
         * directly here (not via the generic saveSettingsDebounced() other
         * dropdowns use) for the same reason applyLanguage() special-cases its
         * own save+reload instead of going through that generic path. */
        if (touchMode) touchMode.addEventListener('change', function () {
            var st = Store.getSettings();
            st.touchMode = touchMode.value;
            Store.setSettings(st);
            try { if (typeof PerfConfig !== 'undefined' && PerfConfig.clearCrashGuard) PerfConfig.clearCrashGuard(); } catch (eCg) {}
            UI.toast(T('ui_reloading'), 'ok');
            setTimeout(function () { window.location.reload(); }, 400);
        });
        /* Wire the button to the modal. Both the button and openEpgSourceManager
         * existed earlier but the click handler was never attached, so the
         * button was dead and the modal never opened. */
        if (epgManage) epgManage.addEventListener('click', function () { openEpgSourceManager(); });

        /* Language picker.
         *
         * Options are built from I18n.getLanguages() rather than hard-coded in the
         * HTML, so the list can never drift from the tables the app actually ships.
         *
         * Each option shows the NATIVE name ("Espanol", "Deutsch") because a user
         * hunting for their own language scans for the word they recognise, not for
         * its English exonym. English is labelled plainly.
         *
         * Rendered through UI.openListPicker (the app's own modal list), NOT a
         * native <select>: the native popup showed an un-styleable scrollbar on the
         * webOS engine and could hang/crash the app when left open. The modal list
         * is focusable, scrolls like every other list, and has no native popup.
         *
         * Changing language triggers a full reload — see applyLanguage(). The app
         * builds its DOM imperatively across dozens of renderers, so re-running them
         * all piecemeal to swap strings would be a wide surface for stale-string
         * bugs. A reload is cheap here (everything is cached) and only happens on a
         * deliberate user action. */
        if (lang) {
            /* English first, then the rest alphabetically by NATIVE name. Sorted by
             * the native name because that is what the user reads in the list;
             * English is pinned to the top as the fallback/default.
             *
             * The collation locale is fixed to 'en' on purpose. Called with no
             * locale, localeCompare follows the DEVICE's own locale, and the
             * device's own script then jumps to the front of the list: on a
             * Russian, Bulgarian, Serbian, Greek or Arabic device the Cyrillic /
             * Greek / Arabic names were listed right after English and the rest
             * shifted, so the order differed from device to device. */
            var langs = I18n.getLanguages();
            langs.sort(function (a, b) {
                if (a.code === 'en') return -1;
                if (b.code === 'en') return 1;
                return a.native.localeCompare(b.native, 'en');
            });
            var langLabel = function (l) {
                return (l.code === 'en') ? l.native : l.native + ' (' + l.name + ')';
            };
            var syncLangButton = function () {
                var cur = (Store.getSettings().language) || 'en';
                var found = null;
                for (var k = 0; k < langs.length; k++) { if (langs[k].code === cur) { found = langs[k]; break; } }
                lang.textContent = found ? langLabel(found) : langs[0] && langLabel(langs[0]);
            };
            syncLangButton();
            lang.addEventListener('click', function () {
                var cur = (Store.getSettings().language) || 'en';
                var items = [];
                var curIdx = 0;
                for (var j = 0; j < langs.length; j++) {
                    items.push(langLabel(langs[j]));
                    if (langs[j].code === cur) curIdx = j;
                }
                UI.openListPicker({
                    title: T('ui_language'),
                    items: items,
                    selected: curIdx,
                    onSelect: function (idx) {
                        applyLanguage(langs[idx].code, true);
                    }
                });
            });
        }
        /* Keyboard layout picker: Auto (follows the app language) or one layout. Saved on this
         * device only (see DEVICE_LOCAL_SETTINGS in cloudsync.js); takes effect the next time the
         * on-screen keyboard opens. */
        var kbBtn = $('#setKeyboardLayout');
        if (kbBtn && UI.vkLayoutChoices) {
            kbBtn.textContent = UI.vkLayoutLabel();
            kbBtn.addEventListener('click', function () {
                var ch = UI.vkLayoutChoices(), cur = (Store.getSettings().keyboardLayout) || 'auto', items = [], at = 0;
                for (var q = 0; q < ch.length; q++) { items.push(ch[q].name); if (ch[q].id === cur) at = q; }
                UI.openListPicker({
                    title: T('ui_keyboard_layout'),
                    items: items,
                    selected: at,
                    onSelect: function (idx) {
                        var st = Store.getSettings();
                        st.keyboardLayout = ch[idx].id;
                        Store.setSettings(st);
                        kbBtn.textContent = UI.vkLayoutLabel();
                    }
                });
            });
        }
        try { if (window.BackupUI) BackupUI.bindSettings(); } catch (eBk) {}
        if (p) p.addEventListener('change', function () { saveSettingsDebounced(); });
        if (o) o.addEventListener('change', function () { saveSettingsDebounced(); });
        if (ar) ar.addEventListener('change', function () { saveSettingsDebounced(); });
        if (s) s.addEventListener('change', function () { saveSettingsDebounced(); });
        if (sc) sc.addEventListener('change', function () { saveSettingsDebounced(); });
        var ccvEl = $('#setCacheVod');
        if (ccvEl) ccvEl.addEventListener('change', function () { saveSettingsDebounced(); });
        var spaEl = $('#setSportsAllPl');
        if (spaEl) spaEl.addEventListener('change', function () { saveSettingsDebounced(); });
        var lllEl = $('#setLiveLogos');
        if (lllEl) lllEl.addEventListener('change', function () { saveSettingsDebounced(); });

        /* View mode selects. The VOD control governs BOTH Movies and Series (they
         * share a render path and one preference), the Live control governs Live.
         * On change, persist (which now also syncs) and re-render the affected
         * screens so the layout switches immediately without needing a section
         * change. The renderers read the mode at the top and branch accordingly. */
        var vVod = $('#setViewVod');
        if (vVod) vVod.addEventListener('change', function () {
            if (Store.setViewMode) {
                Store.setViewMode('movies', vVod.value);
                Store.setViewMode('series', vVod.value);
            }
            saveSettingsDebounced();
            try { if (UI.renderMovies) UI.renderMovies(); } catch (e1) {}
            try { if (UI.renderSeries) UI.renderSeries(); } catch (e2) {}
        });
        var vLive = $('#setViewLive');
        if (vLive) vLive.addEventListener('change', function () {
            if (Store.setViewMode) Store.setViewMode('live', vLive.value);
            saveSettingsDebounced();
            // Live is rendered via renderCategories (the live channel/category entry).
            // The live card branch lands in a later phase; until then this re-renders
            // the existing list, and the persisted+synced setting is already correct.
            try { if (UI.renderCategories) UI.renderCategories(); } catch (e3) {}
        });

        /* Text Size setting. Apply immediately on
         * change AND save to settings so the new value persists. The
         * data-text-size attribute on <html> drives the CSS variable
         * --text-scale defined in tv-scale.css. */
        if (ts) ts.addEventListener('change', function () {
            applyTextSize(ts.value);
            saveSettingsDebounced();
            // Changing Text Size resizes every element on the settings screen, so
            // the control the user is standing on gets pushed out of view — worst
            // when scaling UP. Re-reveal it using the SAME general scroll routine
            // navigation uses (Focus.scrollIntoView), rather than a second inline
            // implementation. Focus.focus() can't be reused here because it early-
            // returns when the element is already CURRENT; Focus.scrollIntoView has
            // no such guard and its last-focusable/trailing-content handling covers
            // the coffee card below the last row for free. setTimeout(0) lets the
            // browser apply the changed --ui-scale before anything is measured.
            setTimeout(function () {
                var cur = Focus.current();
                if (cur) Focus.scrollIntoView(cur);
            }, 0);
        });
        /* Performance Mode. Persist via PerfConfig.setMode (which re-resolves the
         * effective mode immediately). Levers read fresh at point of use, so
         * page size, search cap and future parses pick the new mode up right
         * away; things already done this session (the current parse, the boot
         * EPG/VOD preload) only fully reflect it after a reload, so we say so. */
        var pm = $('#setPerfMode');
        if (pm) pm.addEventListener('change', function () {
            var applied = pm.value;
            try {
                if (typeof PerfConfig !== 'undefined') PerfConfig.setMode(applied);
            } catch (ePerf) {}
            saveSettingsDebounced();
            var eff = '';
            try { eff = (typeof PerfConfig !== 'undefined') ? PerfConfig.getMode() : ''; } catch (e2) {}
            var msg = applied === 'auto'
                ? ('Performance: Auto' + (eff ? ' (' + eff + ')' : ''))
                : ('Performance: ' + applied);
            UI.toast(msg + ' \u00b7 reload to fully apply', 'ok');
        });
        if (r) r.addEventListener('click', function () {
            UI.openModal({
                title: T('ap_reset_app'),
                body: T('ap_reset_body'),
                okText: T('ap_wipe'), onOk: function () {
                    try { if (typeof CloudSync !== 'undefined') CloudSync.signOut(); } catch(e) {}
                    var wiped = Store.wipeAll();
                    // Spinner stays up the whole time the IndexedDB clear runs, until the reload.
                    try { UI.showLoading(T('reset_reloading')); } catch (eWl) {}
                    UI.toast(T('reset_reloading'), 'ok');
                    // Reload only once the IndexedDB clear has finished (capped at 30 s):
                    // reloading while the big movie/series/guide stores were still being
                    // emptied made the next boot's database open slow and drop it into
                    // reduced mode.
                    var reloaded = false;
                    var doReload = function () { if (reloaded) return; reloaded = true; location.reload(); };
                    setTimeout(doReload, 30000);
                    Promise.resolve(wiped).then(function () { setTimeout(doReload, 2500); }, function () { setTimeout(doReload, 2500); });
                }
            });
        });
    }

    /* Apply text-size by setting data-text-size on
     * <html>. CSS in tv-scale.css reads this attribute and switches
     * --ui-scale between 0.80 (xsmall), 0.90 (small), 1.00 (normal),
     * 1.10 (large) and 1.20 (xlarge). Called from:
     *   - populateSettings() on boot, with the saved value
     *   - the setTextSize change handler, with the new value */
    function applyTextSize(value) {
        var html = document.documentElement;
        if (!html) return;
        if (value === 'xsmall' || value === 'small' || value === 'large' || value === 'xlarge') {
            html.setAttribute('data-text-size', value);
        } else {
            html.removeAttribute('data-text-size');
        }
    }

    function populateSettings() {
        var st = Store.getSettings();
        var p = $('#setPlayer'), o = $('#setOverlay'), s = $('#setSync'), sc = $('#setScale');
        var ts = $('#setTextSize');
        if (p) p.value = st.player || 'auto';
        var touchModeSel = $('#setTouchMode');
        if (touchModeSel) touchModeSel.value = st.touchMode || 'auto';
        var themeSelP = $('#setTheme');
        if (themeSelP) themeSelP.value = st.theme || 'dark';
        var marginSelP = $('#setScreenMargin');
        if (marginSelP) marginSelP.value = st.screenMargin || 'off';
        var marginRowP = document.getElementById('rowScreenMargin');
        if (marginRowP) {
            var isAndroidM = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());
            marginRowP.style.display = isAndroidM ? '' : 'none';
        }
        // Touch/Remote Mode exists specifically for generic Android TV boxes
        // that misreport their own touchscreen capability (AndroidBridge's
        // PackageManager check) — structurally an Android-only problem.
        // Tizen/webOS have no such ambiguity; the control would just be a
        // stray, out-of-place setting there. Hide the row entirely outside
        // the Android app, same pattern as rowPlayerPref just above.
        var clockSelP = $('#setPlayerClock');
        if (clockSelP) clockSelP.value = st.playerClock === 'always' ? 'always' : 'off';
        var afrSelP = $('#setAfr');
        if (afrSelP) afrSelP.value = (st.afr === 'off' || st.afr === 'always') ? st.afr : 'seamless';
        var afrRowP = document.getElementById('rowAfr');
        if (afrRowP) {
            var isAndroidA = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());
            afrRowP.style.display = isAndroidA ? '' : 'none';
        }
        var bufSel = $('#setBufferReserve');
        if (bufSel) bufSel.value = String(st.bufferReserve || 'off');
        var bufRow = document.getElementById('rowBufferReserve');
        if (bufRow) {
            var isAndroidB = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());
            bufRow.style.display = isAndroidB ? '' : 'none';
        }
        var touchModeRow = document.getElementById('rowTouchMode');
        if (touchModeRow) {
            var isAndroid = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());
            touchModeRow.style.display = isAndroid ? '' : 'none';
        }
        // Preferred Player is a debug-only control (see pickEngine, which ignores
        // the stored value outside debug). Hide the row entirely in normal prod.
        var playerRow = document.getElementById('rowPlayerPref');
        if (playerRow) {
            var dbg = (typeof window !== 'undefined' && window.APP_DEBUG) ||
                      (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.DEBUG);
            playerRow.style.display = dbg ? '' : 'none';
        }
        var langSel = $('#setLanguage');
        if (langSel) {
            // #setLanguage is a button (opens the modal picker), so show the
            // current language as its label rather than setting a select value.
            var lc = st.language || 'en';
            var lgs = (typeof I18n !== 'undefined' && I18n.getLanguages) ? I18n.getLanguages() : [];
            var lm = null;
            for (var lgi = 0; lgi < lgs.length; lgi++) { if (lgs[lgi].code === lc) { lm = lgs[lgi]; break; } }
            if (lm) langSel.textContent = (lm.code === 'en') ? lm.native : lm.native + ' (' + lm.name + ')';
            else langSel.textContent = lc;
        }
        if (o) o.value = '' + (st.overlayMs == null ? (APP_CONFIG.OVERLAY_MS || 5000) : st.overlayMs);
        var ar = $('#setAutoResume');
        if (ar) ar.value = st.autoResume || 'off';
        var ccv = $('#setCacheVod'); if (ccv) ccv.value = (st.cacheVod === 'off') ? 'off' : 'on';
        var spa = $('#setSportsAllPl'); if (spa) spa.value = (st.sportsAllPl === 'off') ? 'off' : 'on';
        var lll = $('#setLiveLogos'); if (lll) lll.value = (st.liveListLogos === 'on') ? 'on' : 'off';
        if (s) s.value = st.sync || 'off';
        if (sc) { var sv = st.videoScale || 'contain'; if (sv === 'fill') sv = 'fill-h'; sc.value = sv; }
        var vVod = $('#setViewVod');
        if (vVod) vVod.value = (Store.getViewMode ? Store.getViewMode('movies') : 'list');
        var vLive = $('#setViewLive');
        if (vLive) vLive.value = (Store.getViewMode ? Store.getViewMode('live') : 'list');
        if (ts) {
            var tv = st.textSize || 'normal';
            ts.value = tv;
            applyTextSize(tv);
        }
        // Performance Mode reflects the requested mode ('auto'|'normal'|'lite'),
        // so an Auto choice still shows as Auto rather than its resolved value.
        var pm = $('#setPerfMode');
        if (pm) {
            var reqMode = 'auto';
            try {
                if (typeof PerfConfig !== 'undefined') reqMode = PerfConfig.getRequestedMode();
                else reqMode = st.perfMode || 'auto';
            } catch (ePm) { reqMode = st.perfMode || 'auto'; }
            pm.value = (reqMode === 'lite' || reqMode === 'normal') ? reqMode : 'auto';
        }
        // Content-type selection is now per-playlist (on playlist cards and
        // the add-playlist page), not a global setting.
        updateEpgSummary();
    }

    function getExternalEpgSources() {
        var st = Store.getSettings ? Store.getSettings() : {};
        var arr = st.externalEpgUrls || null;
        var out = [];
        var i, url;
        // A zk1:-prefixed value is a ZK-encrypted URL pulled while the passphrase is
        // locked — it's ciphertext, not a usable URL, so skip it (the guide just
        // won't load from that source until the user unlocks and it's decrypted).
        function usable(u) { return u && u.indexOf('zk1:') !== 0; }
        if (arr && arr.length) {
            for (i = 0; i < arr.length && out.length < 3; i++) {
                url = String(arr[i] || '').replace(/^\s+|\s+$/g, '');
                if (usable(url)) out.push(url);
            }
        } else if (st.externalEpgUrl) {
            url = String(st.externalEpgUrl || '').replace(/^\s+|\s+$/g, '');
            if (usable(url)) out.push(url);
        }
        return out;
    }

    function setExternalEpgSources(list) {
        setExternalEpgSourcesWithAuth(list, null);
    }

    /* Per-URL Basic-auth creds for the external EPG sources, index-aligned with
     * externalEpgUrls. Each entry is {user,pass} or null (no auth). */
    function getExternalEpgAuth() {
        var st = Store.getSettings ? Store.getSettings() : {};
        var arr = st.externalEpgAuth;
        return (arr && arr.length) ? arr : [];
    }

    /* Store URLs and (optionally) their per-URL auth together so the two arrays
     * never drift out of alignment. auth is an array parallel to list
     * ({user,pass}|null per entry); pass null to clear all auth. */
    function setExternalEpgSourcesWithAuth(list, auth) {
        var st = Store.getSettings ? Store.getSettings() : {};
        var out = [];
        var outAuth = [];
        var i, url;
        for (i = 0; list && i < list.length && out.length < 3; i++) {
            url = String(list[i] || '').replace(/^\s+|\s+$/g, '');
            if (!url) continue;
            out.push(url);
            var a = (auth && auth[i]) ? auth[i] : null;
            // Only keep an auth entry that actually has creds.
            outAuth.push((a && (a.user || a.pass)) ? { user: a.user || '', pass: a.pass || '' } : null);
        }
        st.externalEpgUrls = out;
        st.externalEpgUrl = out.length ? out[0] : '';
        // Store auth only if any entry is set; else drop the key entirely.
        var anyAuth = false;
        for (i = 0; i < outAuth.length; i++) if (outAuth[i]) anyAuth = true;
        if (anyAuth) st.externalEpgAuth = outAuth;
        else if (st.hasOwnProperty('externalEpgAuth')) delete st.externalEpgAuth;
        Store.setSettings(st);
        updateEpgSummary();
    }

    function setExternalEpgOverride(enabled) {
        var st = Store.getSettings ? Store.getSettings() : {};
        st.externalEpgOverride = enabled ? 'on' : 'off';
        Store.setSettings(st);
        updateEpgSummary();
    }

    /* Persistent "Loading TV Guide" toast (animated bar): stays up until Epg has no load running; the
     * "loaded" / error toast then replaces it. Re-asserted every 0.7 s so its 30 s safety timer never fires
     * during a long parse. */
    var guideToastTimer = null;
    function guideToast() {
        function text() { return T('loading_tv_guide'); }
        try { if (window.UI && UI.toast) UI.toast(text(), null, { sticky: true }); } catch (eG1) {}
        if (guideToastTimer) return;
        guideToastTimer = setInterval(function () {
            var busy = false;
            try { busy = !!(Epg.isBusy && Epg.isBusy()); } catch (eB) {}
            if (!busy) {
                clearInterval(guideToastTimer); guideToastTimer = null;
                try { if (window.UI && UI.toastHide) UI.toastHide(); } catch (eH) {}
                return;
            }
            try { if (UI.toastIsSticky && UI.toastIsSticky()) UI.toast(text(), null, { sticky: true }); } catch (eG2) {}
        }, 700);
    }

    function updateEpgSummary() {
        var el = document.getElementById('setEpgSummary');
        var list = getExternalEpgSources();
        if (!el) return;
        if (!list.length) el.textContent = T('no_external_epg_sources_configured');
        else {
            var st = Store.getSettings ? Store.getSettings() : {};
            el.textContent = list.length + ' external EPG source' + (list.length === 1 ? '' : 's') + ' configured' + (st.externalEpgOverride === 'on' ? ' - provider EPG override on.' : '.');
        }
    }

    function openEpgSourceManager() {
        var sources = getExternalEpgSources();
        var wrap = document.createElement('div');
        wrap.className = 'epg-mgr-wrap';
        var desc = document.createElement('div');
        desc.className = 'modal-body';
        desc.textContent = T('ap_epg_sources_desc');
        wrap.appendChild(desc);

        var stNow = Store.getSettings ? Store.getSettings() : {};
        var overRow = document.createElement('div');
        overRow.className = 'epg-overwrite-row';
        var overBtn = document.createElement('button');
        overBtn.className = 'check-toggle focusable';
        overBtn.setAttribute('tabindex', '-1');
        overBtn.setAttribute('data-focus-key', 'epg-src-override');
        overBtn.setAttribute('data-focus-right', '__none__');
        var overText = document.createElement('span');
        overText.className = 'epg-overwrite-label';
        overText.textContent = T('override_provider_epg_completely');
        function updateOverrideBtn(on) {
            overBtn.textContent = on ? '\u2713' : '';
            if (on) overBtn.classList.add('on'); else overBtn.classList.remove('on');
        }
        updateOverrideBtn(stNow.externalEpgOverride === 'on');
        function toggleOverride() {
            var on = !overBtn.classList.contains('on');
            updateOverrideBtn(on);
        }
        overBtn.addEventListener('click', function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            toggleOverride();
        });
        /* The row handler below toggles for any click that is not the button itself.
         * The label (overText) has NO separate handler on purpose: a click on it
         * bubbles to the row and toggles once. It used to have its own handler too,
         * so a label click fired toggleOverride twice (label handler + row bubble)
         * and cancelled out, which read on device as "the checkbox does nothing". */
        overRow.addEventListener('click', function (e) {
            if (e && e.target === overBtn) return;
            toggleOverride();
        });
        overRow.appendChild(overBtn);
        overRow.appendChild(overText);
        wrap.appendChild(overRow);

        var rowAuth = getExternalEpgAuth();
        function addSourceRow(idx, value) {
            var row = document.createElement('div');
            row.className = 'epg-source-row';
            var input = document.createElement('input');
            input.className = 'field focusable epg-source-field';
            input.setAttribute('tabindex', '-1');
            input.setAttribute('readonly', 'readonly');
            input.setAttribute('data-focus-key', 'epg-src-' + idx);
            input.setAttribute('data-focus-left', '__none__');
            input.placeholder = T('ui_ph_external_epg_url') + ' ' + (idx + 1);
            input.value = value || '';
            input.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(input); });
            var del = document.createElement('button');
            del.className = 'btn focusable epg-source-remove';
            del.setAttribute('tabindex', '-1');
            del.setAttribute('data-focus-key', 'epg-src-del-' + idx);
            del.textContent = T('clear');
            del.addEventListener('click', function () { input.value = ''; });
            row.appendChild(input);
            row.appendChild(del);
            wrap.appendChild(row);

            // Per-URL "requires a login" toggle + inline user/pass (reuses the M3U
            // auth component: focusable .ct-check label + revealable .auth-fields).
            var existing = rowAuth[idx] || null;
            var authLabel = document.createElement('label');
            authLabel.className = 'auth-toggle-row ct-check focusable epg-src-auth-toggle';
            authLabel.setAttribute('tabindex', '-1');
            authLabel.setAttribute('data-focus-key', 'epg-src-auth-' + idx);
            var authChk = document.createElement('input');
            authChk.type = 'checkbox';
            authChk.id = 'epgSrcAuth' + idx;
            var authTxt = document.createElement('span');
            authTxt.textContent = T('ui_url_requires_login');
            authLabel.appendChild(authChk);
            authLabel.appendChild(document.createTextNode(' '));
            authLabel.appendChild(authTxt);

            var fieldsWrap = document.createElement('div');
            fieldsWrap.className = 'auth-fields epg-src-auth-fields';
            var userLbl = document.createElement('label'); userLbl.className = 'field-label'; userLbl.textContent = T('ui_username');
            var userInp = document.createElement('input');
            userInp.className = 'field focusable'; userInp.setAttribute('tabindex', '-1');
            userInp.id = 'epgSrcAuthUser' + idx;
            userInp.setAttribute('data-focus-key', 'epg-src-auth-user-' + idx);
            userInp.setAttribute('readonly', 'readonly');
            userInp.placeholder = T('ui_ph_username');
            userInp.value = existing ? (existing.user || '') : '';
            userInp.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(userInp); });
            var passLbl = document.createElement('label'); passLbl.className = 'field-label'; passLbl.textContent = T('ui_password');
            var passInp = document.createElement('input');
            passInp.className = 'field focusable'; passInp.setAttribute('tabindex', '-1');
            passInp.id = 'epgSrcAuthPass' + idx;
            passInp.setAttribute('data-focus-key', 'epg-src-auth-pass-' + idx);
            passInp.setAttribute('readonly', 'readonly');
            passInp.placeholder = T('ui_ph_password');
            passInp.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(passInp); });
            fieldsWrap.appendChild(userLbl); fieldsWrap.appendChild(userInp);
            fieldsWrap.appendChild(passLbl); fieldsWrap.appendChild(passInp);

            // Mark the row's elements so the apply handler can read them by index.
            row._epgAuthChk = authChk;
            row._epgAuthUser = userInp;
            row._epgAuthPass = passInp;
            input._epgAuthRow = row;

            function syncAuthFields() {
                if (authChk.checked) fieldsWrap.classList.remove('init-hidden');
                else fieldsWrap.classList.add('init-hidden');
            }
            authChk.checked = !!existing;
            syncAuthFields();
            authChk.addEventListener('change', function () { syncAuthFields(); if (window.Focus) Focus.refresh(); });

            wrap.appendChild(authLabel);
            wrap.appendChild(fieldsWrap);

            // Password masking (vkeyboard show/hide) + seed existing value.
            if (typeof setupPasswordField === 'function') setupPasswordField(passInp);
            if (existing && existing.pass) { passInp._realValue = existing.pass; if (passInp._maskFn) passInp._maskFn(); }
        }

        for (var i = 0; i < 3; i++) addSourceRow(i, sources[i] || '');

        var actions = document.createElement('div');
        actions.className = 'epg-source-actions modal-actions';
        var apply = document.createElement('button');
        apply.className = 'btn focusable';
        apply.setAttribute('tabindex', '-1');
        apply.setAttribute('data-focus-key', 'epg-src-apply');
        apply.setAttribute('data-focus-left', '__none__');
        apply.textContent = T('apply');
        var cancel = document.createElement('button');
        cancel.className = 'btn focusable';
        cancel.setAttribute('tabindex', '-1');
        cancel.setAttribute('data-focus-key', 'epg-src-cancel');
        cancel.setAttribute('data-focus-right', '__none__');
        cancel.textContent = T('cancel');
        apply.addEventListener('click', function () {
            var fields = wrap.querySelectorAll('.epg-source-field');
            var vals = [];
            var auths = [];
            for (var f = 0; f < fields.length; f++) {
                vals.push(fields[f].value || '');
                // Pull the auth from the same row (aligned with this URL).
                var arow = fields[f]._epgAuthRow;
                if (arow && arow._epgAuthChk && arow._epgAuthChk.checked) {
                    var uEl = arow._epgAuthUser, pEl = arow._epgAuthPass;
                    var uu = uEl ? (uEl.value || '') : '';
                    var pp = pEl ? (pEl._isPassword ? (pEl._realValue || '') : (pEl.value || '')) : '';
                    auths.push((uu || pp) ? { user: uu, pass: pp } : null);
                } else {
                    auths.push(null);
                }
            }
            // A plain word in any of these
            // used to save as a configured external source with no validation
            // error at all — reject BEFORE anything is written, so a bad row
            // can't clear/replace the good rows either. Empty rows are allowed
            // (that's how a source is removed) and skipped here.
            for (var vi = 0; vi < vals.length; vi++) {
                if (vals[vi] && !Util.isHttpUrl(vals[vi])) {
                    UI.toast(T('err_invalid_url', { field: T('ui_ph_external_epg_url') + ' ' + (vi + 1) }), 'err');
                    return;
                }
            }
            // Snapshot the previous external sources to decide add vs clear.
            var prevSources = [];
            try { prevSources = getExternalEpgSources() || []; } catch (ePrev) {}
            // Snapshot the prior override state to detect an override-just-turned-off.
            var prevOverrideOn = false;
            try { prevOverrideOn = (Store.getSettings().externalEpgOverride === 'on'); } catch (ePo) {}
            setExternalEpgSourcesWithAuth(vals, auths);
            // Override only applies when an external source exists. If the user
            // cleared all sources, force override off so the provider EPG isn't
            // suppressed with nothing to replace it.
            var anyLeft = false;
            try { anyLeft = (getExternalEpgSources() || []).length > 0; } catch (eAny) {}
            var overrideNowOn = anyLeft && overBtn.classList.contains('on');
            setExternalEpgOverride(overrideNowOn);
            UI.closeModal();

            var newSources = [];
            try { newSources = getExternalEpgSources() || []; } catch (eNew) {}
            var activeId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;

            // Dead-end config guard: the user just turned override OFF, an external
            // EPG is still present, but the playlist's provider EPG is DISABLED. With
            // override off the external EPG would merely supplement a provider guide
            // that isn't loaded, and clearing the external would leave NO guide. The
            // app must not load the provider EPG on its own initiative, so prompt the
            // user to resolve it: enable the provider EPG, or clear the external EPG.
            var providerDisabled = activeId && Store.getPlaylistEpgEnabled &&
                                   Store.getPlaylistEpgEnabled(activeId) === false;
            if (prevOverrideOn && !overrideNowOn && newSources.length && providerDisabled) {
                var dead = document.createElement('div');
                var deadDesc = document.createElement('div');
                deadDesc.className = 'modal-body';
                deadDesc.textContent = T('epg_override_off_body');
                dead.appendChild(deadDesc);
                var deadActions = document.createElement('div');
                deadActions.className = 'modal-actions epg-deadend-actions';

                function mkBtn(label, handler) {
                    var b = document.createElement('button');
                    b.className = 'btn focusable modal-btn';
                    b.textContent = label;
                    b.addEventListener('click', function () { UI.closeModal(); handler(); });
                    return b;
                }

                // Option 1: keep override on (external EPG only) — undoes the toggle.
                deadActions.appendChild(mkBtn(T('epg_keep_override_on'), function () {
                    try { setExternalEpgOverride(true); } catch (eKo) {}
                    // External-only was already loaded; nothing to download. Just make
                    // sure the guide reflects the (unchanged) external source.
                    reloadEpgForActive();
                }));
                // Option 2: enable provider EPG (use both) — explicit provider opt-in.
                // setPlaylistEpg(true) is the single canonical path: it flips the
                // flag, force-reloads, and shows the loading/loaded toasts when the
                // load (provider included) actually completes. Do NOT also call
                // reloadEpgForActive here — a second concurrent load would race this
                // one and fire a premature "loaded" off the cached external while the
                // provider is still parsing.
                deadActions.appendChild(mkBtn(T('epg_enable_provider'), function () {
                    try { if (App && App.setPlaylistEpg) App.setPlaylistEpg(activeId, true); } catch (eEn) {}
                }));
                // Option 3: clear external EPG — guide becomes empty (both off).
                deadActions.appendChild(mkBtn(T('epg_clear_external'), function () {
                    try { setExternalEpgSources([]); } catch (eCe) {}
                    try { setExternalEpgOverride(false); } catch (eOv) {}
                    try { if (Epg.clear) Epg.clear(activeId); } catch (eC2) {}
                    try { if (typeof IDB !== 'undefined') {
                        if (IDB.epgClearPlaylist) IDB.epgClearPlaylist(activeId)['catch'](function () {});
                        if (IDB.epgMetaDelete) IDB.epgMetaDelete(activeId)['catch'](function () {});
                    } } catch (eIdb2) {}
                    try { updateEpgSummary(); } catch (eSm) {}
                    try { UI.renderHome(); } catch (eRh2) {}
                    try {
                        if (document.querySelector('.content-section[data-section-content="livetv"].active') && UI.refreshLiveEpgRows &&
                            !(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                            UI.refreshLiveEpgRows();
                        }
                    } catch (eLv) {}
                    UI.toast(T('external_epg_cleared'), 'ok');
                }));

                dead.appendChild(deadActions);
                UI.openModal({ title: T('epg_override_off_title'), bodyEl: dead, cancelText: false });
                return;
            }

            // Apply live rather than asking the user to reload the playlist.
            if (!newSources.length && prevSources.length) {
                // All external sources cleared. Evict the external EPG from memory +
                // IDB. If the active playlist still has a provider EPG (toggle on and
                // override off), reload that; otherwise the guide is now empty.
                if (activeId) {
                    try { if (Epg.clear) Epg.clear(activeId); } catch (eC) {}
                    try { if (typeof IDB !== 'undefined') {
                        if (IDB.epgClearPlaylist) IDB.epgClearPlaylist(activeId)['catch'](function () {});
                        if (IDB.epgMetaDelete) IDB.epgMetaDelete(activeId)['catch'](function () {});
                    } } catch (eIdb) {}
                    var plNow = findPlaylist(activeId);
                    var stillHasProvider = false;
                    try {
                        stillHasProvider = !!(plNow && Epg.hasEpgSource && Epg.hasEpgSource(plNow));
                    } catch (eHas) {}
                    if (stillHasProvider) {
                        reloadEpgForActive();
                    } else {
                        try { UI.renderHome(); } catch (eRh) {}
                        try {
                            if (document.querySelector('.content-section[data-section-content="livetv"].active') && UI.refreshLiveEpgRows &&
                                !(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                                UI.refreshLiveEpgRows();
                            }
                        } catch (eLive) {}
                    }
                    UI.toast(T('external_epg_cleared'), 'ok');
                }
            } else {
                // Sources added or changed — load the EPG now (EPG-only, no channel
                // reload). Force a re-fetch so a changed URL isn't served from cache.
                try {
                    var plForce = activeId ? findPlaylist(activeId) : null;
                    if (plForce && Epg.forceReload) Epg.forceReload(plForce);
                } catch (eF) {}
                reloadEpgForActive();
            }
        });
        cancel.addEventListener('click', function () { UI.closeModal(); });
        actions.appendChild(apply);
        actions.appendChild(cancel);
        wrap.appendChild(actions);
        UI.openModal({ title: T('ui_manage_epg_sources'), bodyEl: wrap, cancelText: false });
        var modal = document.getElementById('modalLayer');
        if (modal) {
            var modalActions = modal.querySelector('.modal-actions');
            if (modalActions && modalActions !== actions) modalActions.style.display = 'none';
        }
        Util.removeDefaultModalOk();
        setTimeout(function () {
            if (window.Focus && Focus.refresh) Focus.refresh();
            if (window.Focus && Focus.focusKey && !Focus.focusKey('epg-src-override')) {
                if (window.Focus && Focus.focus) Focus.focus(overBtn);
            }
        }, 120);
    }

    /* Cards view (Movies/Series) VOD info panel Play buttons. Previously
     * only wired to handleOk()'s keyup/Enter path (remote OK) — tapping them
     * on touch did nothing at all, there was no click listener. Reuses the
     * exact same _vodOpen() callback and window._vodPinnedCard the remote
     * path already uses, so behavior is identical either way; this just adds
     * the missing input method. */
    function wireVodInfoPanelButtons() {
        var movieBtn = $('#movieInfoPlay');
        var seriesBtn = $('#seriesInfoPlay');
        function openPinned() {
            var pinned = window._vodPinnedCard;
            if (pinned && typeof pinned._vodOpen === 'function') pinned._vodOpen();
        }
        if (movieBtn) movieBtn.addEventListener('click', openPinned);
        if (seriesBtn) seriesBtn.addEventListener('click', openPinned);
    }

    function wirePlayerOverlay() {
        // Touch gestures on the live/main player (mobile only): swipe up from
        // the bottom of the screen reveals the info overlay; swipe down hides
        // it. Gated entirely behind isTouch() so TV/remote/mouse behavior is
        // completely unchanged.
        //
        // This used to ALSO handle horizontal swipe-left/right to
        // change channel (reusing handleChannelUpDown(), the same path a
        // remote's CH+/CH- keys use). Removed — it interfered with Android's
        // own edge-swipe system gestures (back/home/recents), which read
        // touches starting at/near the screen edges before this listener
        // (attached to the whole #player screen) ever got a clean shot at
        // them. Replaced with two dedicated buttons in the info overlay
        // (infoPrevChBtn/infoNextChBtn, wired below) — same
        // handleChannelUpDown() call, just reachable by tapping a fixed
        // control instead of a gesture that fights the OS for the same
        // screen real estate.
        //
        // Attached to the whole #player screen, not just the video: the
        // overlay's own background has pointer-events:none in CSS (only its
        // buttons/seekbar opt back in), so touches that start on empty
        // overlay space already fall through to this listener — the swipe
        // works whether or not the overlay happens to be showing, and a
        // drag that starts on an actual button/seekbar never reaches here.
        var touchGateGesture = false;
        try { touchGateGesture = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eTg) {}
        if (touchGateGesture) {
            var playerScreenEl = $('#player');
            if (playerScreenEl) {
                var gTouchStartX = 0, gTouchStartY = 0, gTouchStartTime = 0, gTouchTracking = false;
                var SWIPE_MIN_PX = 60;          // minimum travel to count as an intentional swipe
                var SWIPE_MAX_MS = 900;         // ignore slow drags (more likely a deliberate press-hold)
                var EDGE_ZONE_FRACTION = 0.35;  // "from the bottom" = starts in the lowest 35% of the screen

                playerScreenEl.addEventListener('touchstart', function (e) {
                    if (!e.touches || e.touches.length !== 1) { gTouchTracking = false; return; }
                    gTouchStartX = e.touches[0].clientX;
                    gTouchStartY = e.touches[0].clientY;
                    gTouchStartTime = Date.now();
                    gTouchTracking = true;
                }, { passive: true });

                playerScreenEl.addEventListener('touchend', function (e) {
                    if (!gTouchTracking) return;
                    gTouchTracking = false;
                    var touch = (e.changedTouches && e.changedTouches[0]) || null;
                    if (!touch) return;
                    var dx = touch.clientX - gTouchStartX;
                    var dy = touch.clientY - gTouchStartY;
                    var dt = Date.now() - gTouchStartTime;
                    if (dt > SWIPE_MAX_MS) return;
                    var absDx = Math.abs(dx), absDy = Math.abs(dy);
                    if (absDx < SWIPE_MIN_PX && absDy < SWIPE_MIN_PX) return; // just a tap — let it click through normally
                    // Vertical-only now (horizontal swipe removed — see comment
                    // above). A predominantly-horizontal drag is silently
                    // ignored: no preventDefault, no action, so it falls
                    // through to whatever the OS wants to do with it (edge-
                    // swipe back, etc.) instead of this listener fighting it.
                    if (absDx > absDy) return;

                    // Overlay appeared then immediately vanished on
                    // swipe-up: past this point we KNOW it's a genuine swipe,
                    // not a tap. This listener used to be entirely passive, so
                    // the browser still fired its own synthetic click for the
                    // same touch sequence right after — which landed on
                    // whatever tap-to-toggle handler already exists and
                    // immediately toggled back off whatever we'd just shown.
                    // Swipe-down-from-the-top showed the same tell in reverse:
                    // this code has no matching branch for it at all (falls
                    // through both conditions below), yet the overlay still
                    // appeared and stayed — proving a separate click handler
                    // was the one actually doing it. preventDefault() (this
                    // listener is no longer passive, see the addEventListener
                    // call below) stops that synthetic click from firing for
                    // real swipes, while genuine taps (returned above, never
                    // reaching here) still click through untouched.
                    e.preventDefault();

                    var overlayEl = document.getElementById('infoOverlay');
                    var showing = overlayEl && overlayEl.classList.contains('show');
                    if (dy < 0) {
                        // Swipe UP: only reveal if it actually started
                        // near the bottom — an upward swipe starting
                        // mid-screen is more likely a stray gesture than
                        // a deliberate "show info" request.
                        var screenH = window.innerHeight || document.documentElement.clientHeight || 0;
                        if (!showing && screenH && gTouchStartY >= screenH * (1 - EDGE_ZONE_FRACTION)) {
                            Player.showOverlay();
                        }
                    } else if (showing) {
                        // Swipe DOWN anywhere hides an already-open
                        // overlay — a natural "pull down to dismiss",
                        // no edge requirement needed since it's only
                        // acting on something already visible.
                        Player.hideOverlay();
                    }
                }, { passive: false });
            }
        }

        // Prev/next-channel buttons — replace the removed swipe gesture above.
        // Originally wired to handleChannelUpDown(), the same path
        // remote CH+/CH- keys use — but that function explicitly no-ops
        // while the info overlay is showing (its own guard checks
        // ovl.classList.contains('show') and returns), a guard meant to stop
        // an ambient remote key press leaking through while someone's
        // navigating the overlay's own controls. These buttons live INSIDE that same overlay, so every
        // tap hit that guard and did nothing — not unwired, just silently
        // blocked by a check that predates their existence. Call
        // jumpChannel() directly instead: it's the same underlying channel
        // change handleChannelUpDown() itself calls, just without the
        // overlay-open guard that only made sense for an incidental key
        // press, not a deliberate tap on a button that only EXISTS because
        // the overlay is open. Visibility (touch + Live TV only) is handled
        // in player.js's per-refresh content-type toggle, not here — this
        // only wires the click.
        var prevChBtn = $('#infoPrevChBtn');
        if (prevChBtn) prevChBtn.addEventListener('click', function () { jumpChannel(-1); });
        var nextChBtn = $('#infoNextChBtn');
        if (nextChBtn) nextChBtn.addEventListener('click', function () { jumpChannel(+1); });

        // "Open in external player" — every Android device with the native
        // hand-off (phones, tablets, Android TV / Fire TV). Hidden (init-hidden)
        // by default in the HTML and shown only when AndroidBridge exists, so
        // Tizen / webOS never see it. The chooser reports "no apps" itself.
        var externalBtn = $('#infoExternalBtn');
        if (externalBtn) {
            // Android shell only: needs the native hand-off. On Tizen / webOS
            // (no AndroidBridge) the button stays hidden.
            var hasExtBridge = false;
            try { hasExtBridge = !!(window.AndroidBridge && typeof AndroidBridge.openExternalPlayer === 'function'); } catch (eEb) {}
            if (hasExtBridge) externalBtn.classList.remove('init-hidden');
            externalBtn.addEventListener('click', function () {
                if (!window.Player || !Player.getExternalPlayableUrl) return;
                // No native hand-off available: do nothing (never stop the stream for it).
                if (!(window.AndroidBridge && typeof AndroidBridge.openExternalPlayer === 'function')) return;
                // Resolve BEFORE stopping — getExternalPlayableUrl (Stalker's
                // path especially) reads Player.currentChannel()-equivalent
                // state that Player.stop() clears (current = null). Only
                // stop once we actually have somewhere to hand off to; a
                // failed resolve leaves the user's stream running rather
                // than killing it for nothing.
                Player.getExternalPlayableUrl(function (url) {
                    if (!url) {
                        UI.toast(T('could_not_load_stream'), 'err');
                        return;
                    }
                    // Stop (not just pause) the app's own player before
                    // handing off — leaving it running meant the external
                    // app and Xtivio could both hold the stream/decoder at
                    // once, and pressing Back afterward resumed a stale
                    // session instead of a clean one.
                    try { Player.stop(); } catch (eStop) {}
                    try { Player.markExternalHandoff(); } catch (eMk) {}
                    try {
                        if (window.AndroidBridge && AndroidBridge.openExternalPlayer) {
                            AndroidBridge.openExternalPlayer(url);
                        }
                    } catch (e) {}
                });
            });
        }

        var subBtn = $('#infoSubBtn');
        var favBtn = $('#infoFavBtn');
        var scaleBtn = $('#infoScaleBtn');
        var rewBtn = $('#infoRewBtn');
        var playBtn = $('#infoPlayBtn');
        var fwdBtn = $('#infoFwdBtn');

        if (subBtn) subBtn.addEventListener('click', function () {
            // Was a simple Player.toggleSubtitles() —
            // which only toggled BETWEEN tracks already attached to the
            // video (and we never added any), so the button effectively
            // always said "no subtitles available". Now it opens the
            // subtitle picker modal, which fetches available tracks
            // from Wyzie for the current item, lets the user pick one
            // (or off), then loads it as a <track>.
            var ch = Player.currentChannel();
            if (!ch) return;
            // Subtitle picker is VOD-only for now; live TV has no
            // standard subtitle source. The button is wired
            // regardless to make the UX consistent, but for live
            // channels we just show a toast.
            if (!Player.isVod || !Player.isVod() || ch.catchup) {
                UI.toast(T('subtitles_available_for_movies_and_series'), null);
                return;
            }
            if (UI.openSubtitlePicker) UI.openSubtitlePicker(ch);
        });

        if (favBtn) favBtn.addEventListener('click', function () {
            var ch = Player.currentChannel();
            if (ch && !ch.catchup) {
                var added = Store.toggleFavorite(ch);
                UI.refreshFavStars();
                UI.toast(added ? '\u2605 Added to favorites' : 'Removed from favorites', 'ok');
                Player.refreshOverlayContent();
            }
        });

        if (scaleBtn) scaleBtn.addEventListener('click', function () {
            var scales = ['contain', 'cover', 'fill-v', 'fill-h', 'four-three'];
            var labels = [
                T('scale_contain'),
                T('scale_cover'),
                T('scale_fill_v'),
                T('scale_fill_h'),
                T('scale_four_three')
            ];
            var st = Store.getSettings();
            var current = st.videoScale || 'contain';
            if (current === 'fill') current = 'fill-v';
            var curIdx = scales.indexOf(current);
            if (curIdx < 0) curIdx = 0;
            UI.openListPicker({
                title: T('ui_video_scaling'),
                items: labels,
                selected: curIdx,
                onSelect: function (idx) {
                    st.videoScale = scales[idx];
                    Store.setSettings(st);
                    applyVideoScale(scales[idx]);
                    UI.toast(T('scale') + labels[idx].split(' (')[0], 'ok');
                }
            });
        });

        if (rewBtn) rewBtn.addEventListener('click', function () {
            Player.seekRelative(-10);
            Player.refreshOverlayContent();
        });

        if (playBtn) playBtn.addEventListener('click', function () {
            Player.togglePause();
            Player.refreshOverlayContent();
        });

        if (fwdBtn) fwdBtn.addEventListener('click', function () {
            Player.seekRelative(10);
            Player.refreshOverlayContent();
        });

        var audioBtn = $('#infoAudioBtn');
        if (audioBtn) audioBtn.addEventListener('click', function () {
            // This used to read
            // videoEl.audioTracks directly, an API confirmed NOT populated by
            // hls.js (which manages alternate audio internally via its own
            // API) and confirmed absent outright in this Chromium engine —
            // see the fix's own comment in player.js. Player.getEmbeddedAudioTracks()
            // normalizes whichever engine is active so no engine-specific
            // logic is needed here, same pattern as the subtitle picker below.
            var tracks = window.Player && Player.getEmbeddedAudioTracks ? Player.getEmbeddedAudioTracks() : [];
            if (!tracks.length) {
                UI.toast(T('no_audio_tracks_available'), null);
                return;
            }
            // This table used to have only 2-letter (ISO 639-1) keys and fell
            // back to lang.substring(0,2) for anything else. Real HLS
            // LANGUAGE= attributes and MP4/MKV track metadata conventionally
            // use 3-letter ISO 639-2 codes, and truncating those to 2 letters
            // is only EVER correct by coincidence — tested systematically
            // against all 38 languages here: 20 of 38 (including Spanish,
            // German, Portuguese, Japanese, Chinese, Dutch, Polish, Turkish,
            // Swedish, Czech) resolved to nothing at all, and 3 resolved to
            // the WRONG language outright (Romanian->"ru"->Russian,
            // Slovak->"sl"->Slovenian, Estonian->"es"->Spanish) — the last
            // group is worse than unlabeled, since a user picking "Spanish"
            // could actually be selecting Estonian audio. Both the
            // bibliographic and terminological 3-letter variants are listed
            // where they differ (e.g. "ger"/"deu" for German), since real
            // muxers use either depending on the tool. No more substring
            // guessing; every code either has a direct entry or falls
            // through to showing the raw code/label, never a wrong name.
            var langNames = {
                en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese', ru:'Russian', ja:'Japanese', ko:'Korean', zh:'Chinese', ar:'Arabic', hi:'Hindi', nl:'Dutch', pl:'Polish', tr:'Turkish', sv:'Swedish', da:'Danish', fi:'Finnish', no:'Norwegian', cs:'Czech', ro:'Romanian', hu:'Hungarian', el:'Greek', th:'Thai', vi:'Vietnamese', id:'Indonesian', ms:'Malay', uk:'Ukrainian', bg:'Bulgarian', hr:'Croatian', sk:'Slovak', sl:'Slovenian', sr:'Serbian', lt:'Lithuanian', lv:'Latvian', et:'Estonian', he:'Hebrew', fa:'Persian',
                eng:'English', spa:'Spanish', fre:'French', fra:'French', ger:'German', deu:'German', ita:'Italian', por:'Portuguese', rus:'Russian', jpn:'Japanese', kor:'Korean', chi:'Chinese', zho:'Chinese', ara:'Arabic', hin:'Hindi', dut:'Dutch', nld:'Dutch', pol:'Polish', tur:'Turkish', swe:'Swedish', dan:'Danish', fin:'Finnish', nor:'Norwegian', cze:'Czech', ces:'Czech', rum:'Romanian', ron:'Romanian', hun:'Hungarian', gre:'Greek', ell:'Greek', tha:'Thai', vie:'Vietnamese', ind:'Indonesian', may:'Malay', msa:'Malay', ukr:'Ukrainian', bul:'Bulgarian', hrv:'Croatian', slo:'Slovak', slk:'Slovak', slv:'Slovenian', srp:'Serbian', lit:'Lithuanian', lav:'Latvian', est:'Estonian', heb:'Hebrew', per:'Persian', fas:'Persian'
            };
            var items = [];
            var currentIdx = 0;
            for (var ai = 0; ai < tracks.length; ai++) {
                var label = tracks[ai].label || '';
                var lang = tracks[ai].language || '';
                var langFull = langNames[lang.toLowerCase()] || '';
                var display = label || langFull || lang.toUpperCase() || ('Track ' + (ai + 1));
                if (lang && langFull && label && label !== langFull) display = langFull + ' - ' + label;
                else if (langFull) display = langFull;
                items.push(display);
                if (tracks[ai].active) currentIdx = ai;
            }
            UI.openListPicker({
                title: T('ap_audio_track'),
                items: items,
                selected: currentIdx,
                onSelect: function (idx) {
                    // Pass tracks[idx].index, NOT idx itself: hls.js and the native
                    // videoEl path both happen to number sequentially from 0, so this
                    // coincided with idx there, but Tizen's real track index is
                    // whatever the platform assigned (video/text tracks can occupy
                    // lower indices), confirmed in testing — a mocked device had audio
                    // at indices 1 and 2, not 0 and 1. Passing the raw loop position
                    // would silently select the wrong track on a real Tizen device.
                    if (window.Player && Player.setAudioTrack) Player.setAudioTrack(tracks[idx].index);
                    UI.toast(T('audio') + ' ' + items[idx], 'ok')
                }
            });
        });

        var miniBtn = $('#infoMiniBtn');
        if (miniBtn) miniBtn.addEventListener('click', function () {
            Player.hideOverlay();
            openMini();
        });

        var infoBtn = $('#infoInfoBtn');
        if (infoBtn) infoBtn.style.display = 'none';

        var speedBtn = $('#infoSpeedBtn');
        if (speedBtn) speedBtn.addEventListener('click', function () {
            var values = (Player.speedValues && Player.speedValues()) || [0.5, 0.75, 1, 1.25, 1.5, 2];
            var speeds = [];
            for (var sv = 0; sv < values.length; sv++) speeds.push(values[sv] + 'x');
            var vidEl = document.querySelector('#videoEl') || document.querySelector('.player-stage video');
            var curRate = (Player.currentSpeed && Player.currentSpeed()) || (vidEl && vidEl.playbackRate) || 1;
            var curIdx = 2;
            for (var si = 0; si < values.length; si++) {
                if (Math.abs(values[si] - curRate) < 0.01) { curIdx = si; break; }
            }
            UI.openListPicker({
                title: T('ap_playback_speed'),
                items: speeds,
                selected: curIdx,
                onSelect: function (idx) {
                    if (Player.setSpeed) { if (Player.setSpeed(values[idx]) === false) return; }
                    else if (vidEl) vidEl.playbackRate = values[idx];
                    var lbl = document.getElementById('infoSpeedLbl');
                    if (lbl) lbl.textContent = T('speed_2');
                    UI.toast(T('speed') + ' ' + speeds[idx], 'ok')
                }
            });
        });
    }

    /* ========== Remote control ========== */
    function activeScreenId() {
        var s = document.querySelector('.screen.active');
        return s ? s.id : null;
    }

    function wireSyncUI() {
        if (typeof CloudSync !== 'undefined') {
            CloudSync.init();
            // Non-blocking config/rules sanity check once Firebase is ready.
            // Warns (console only) on missing/mismatched config or denied read;
            // never blocks startup or sync.
            if (CloudSync.whenReady && CloudSync.healthCheck) {
                CloudSync.whenReady().then(function () {
                    try { CloudSync.healthCheck(); } catch (e) {}
                })['catch'](function () {});
            }
        }

        var loginBtn = document.getElementById('syncLoginBtn');
        var pushBtn = document.getElementById('syncPushBtn');
        var pullBtn = document.getElementById('syncPullBtn');
        var logoutBtn = document.getElementById('syncLogoutBtn');
        var forgotBtn = document.getElementById('syncForgotBtn');
        var wipeCloudBtn = document.getElementById('syncWipeCloudBtn');

        function updateSyncUI() {
            var statusEl = document.getElementById('syncStatus');
            var actionsEl = document.getElementById('syncActions');
            var descEl = document.getElementById('syncDesc');
            if (typeof CloudSync === 'undefined' || !CloudSync.isSignedIn()) {
                if (statusEl) statusEl.innerHTML = '<button class="btn focusable" id="syncLoginBtn" data-focus-key="set-login" tabindex="-1" data-i18n="ui_sign_in">' + T('ui_sign_in') + '</button>';
                if (actionsEl) actionsEl.style.display = 'none';
                if (descEl) descEl.textContent = T('sign_in_to_sync_playlists_favorites');
                var btn = document.getElementById('syncLoginBtn');
                if (btn) btn.addEventListener('click', showLoginPrompt);
                /* updateZkRow() must run in THIS branch too, not only when signed in.
                 *
                 * It previously appeared only in the else-branch below, so on sign-OUT
                 * the ZK row was never re-evaluated and simply kept the display:flex it
                 * was given while signed in. The row therefore stayed VISIBLE after
                 * signing out — and since it was visible, its toggle was reachable, so
                 * a passphrase could be set up with no cloud account to encrypt for.
                 *
                 * updateZkRow already contains the correct rule (hide when !signedIn);
                 * it just was not being asked. Calling it here is the actual fix — the
                 * row now disappears on sign-out, as its own logic always intended. */
                updateZkRow();
            } else {
                // NOTE: do NOT move focus here. Sign-in completes via the
                // pairing flow which immediately opens a "pull cloud data?"
                // modal; stealing focus to a sync action (which sits behind
                // that modal) made the modal inaccessible. The minor "focus
                // drops to top of Settings" behaviour is preferable to
                // breaking the modal.
                var email = CloudSync.getUserEmail ? CloudSync.getUserEmail() : '';
                if (statusEl) {
                    // Build with textContent so an attacker-controlled email
                    // (user-typed signup or pairing-token claim) can't inject
                    // markup into the app origin.
                    Util.empty(statusEl);
                    var sp = document.createElement('span');
                    sp.style.color = 'var(--accent-2)';
                    sp.style.fontWeight = '600';
                    sp.textContent = T('signed_in_2') + (email ? ' as ' + email : '');
                    statusEl.appendChild(sp);
                }
                if (actionsEl) actionsEl.style.display = 'flex';
                if (descEl) descEl.textContent = T('your_data_is_synced_to_the');
                updateZkRow();
            }
        }

        /* Zero-knowledge row: visible only when signed in. Button label reflects
         * state — "Set Up" (not configured), "Unlock" (configured but the key
         * isn't held this session), "On" (configured + unlocked), with a "Turn
         * Off" affordance handled inside the toggle handler. */
        function updateZkRow() {
            var row = document.getElementById('zkSyncRow');
            var btn = document.getElementById('zkToggleBtn');
            if (!row || !btn) return;
            var signedIn = (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn && CloudSync.isSignedIn());
            var supported = (typeof ZKSync !== 'undefined' && ZKSync.hasWebCrypto && ZKSync.hasWebCrypto());
            if (!signedIn || !supported) { row.style.display = 'none'; return; }
            row.style.display = 'flex';
            var st = (Store.getSettings && Store.getSettings()) || {};
            var configured = !!(st.zkEnabled && st.zkSalt && st.zkVerifier);
            var unlocked = configured && ZKSync.isUnlocked && ZKSync.isUnlocked();
            if (!configured) btn.textContent = T('set_up');
            else if (!unlocked) btn.textContent = T('unlock');
            else btn.textContent = 'On';
        }

        // Build a passphrase-entry modal body with a masked (_isPassword) input.
        function zkPassphraseInput(placeholder) {
            var wrap = document.createElement('div');
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'field focusable';
            inp.setAttribute('readonly', 'readonly');
            inp.setAttribute('data-focus-key', 'zk-pass-input');
            // D-pad DOWN from the passphrase field should land on the primary
            // action (OK/Unlock/Enable), not the Cancel button that spatial nav
            // would otherwise pick when both actions overlap the wide input.
            inp.setAttribute('data-focus-down', 'modal-ok');
            inp.setAttribute('placeholder', placeholder || T('ap_ph_passphrase'));
            inp._realValue = '';
            inp._isPassword = true;
            inp._maskFn = function () {
                var real = inp._realValue || '';
                var masked = '';
                for (var i = 0; i < real.length; i++) masked += '\u2022';
                inp.value = masked;
            };
            inp.addEventListener('click', function () { if (UI.openVKeyboard) UI.openVKeyboard(inp); });
            wrap.appendChild(inp);
            return { wrap: wrap, input: inp };
        }

        function onZkToggle() {
            /* ZK requires an account. The row is hidden by updateZkRow when signed
             * out, but the row can still be on screen if the user signed out while
             * Settings was open (updateZkRow runs on sync-state change, not on every
             * frame), and the toggle would then run with no cloud account to encrypt
             * FOR. Setting up a passphrase in that state writes zkSalt/zkVerifier to
             * local settings and encrypts nothing — the user has "enabled" a feature
             * that cannot do anything until they sign in, and the ZK row then shows
             * "On" misleadingly.
             *
             * Guard here rather than only hiding the row, so the invariant holds
             * regardless of how the control was reached. */
            var signedIn = (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn && CloudSync.isSignedIn());
            if (!signedIn) {
                UI.toast(T('sign_in_first_zk'), 'err');
                refocusSyncActions();
                return;
            }
            var st = (Store.getSettings && Store.getSettings()) || {};
            var configured = !!(st.zkEnabled && st.zkSalt && st.zkVerifier);
            var unlocked = configured && ZKSync.isUnlocked && ZKSync.isUnlocked();
            if (!configured) zkSetupFlow();
            else if (!unlocked) zkUnlockFlow();
            else zkDisableFlow();
        }

        function zkSetupFlow() {
            var pi = zkPassphraseInput(T('ap_ph_new_passphrase'));
            UI.openModal({
                title: T('ap_zk_setup'),
                body: T('ap_zk_setup_body'),
                bodyEl: pi.wrap,
                okText: T('ap_continue'),
                cancelText: T('cancel'),
                cancelClass: 'btn focusable',
                onOk: function () {
                    var pass = pi.input._realValue || '';
                    if (pass.length < 4) { UI.toast(T('passphrase_too_short'), 'err'); return; }
                    var pc = zkPassphraseInput(T('ap_ph_confirm_passphrase'));
                    UI.openModal({
                        title: T('ap_confirm_passphrase'),
                        body: T('ap_same_passphrase'),
                        bodyEl: pc.wrap,
                        okText: T('pc_enable'),
                        cancelText: T('cancel'),
                        cancelClass: 'btn focusable',
                        onOk: function () {
                            if ((pc.input._realValue || '') !== pass) {
                                // Mismatch: openModal already closed this modal before
                                // calling onOk, so re-open the confirm step rather than
                                // leaving the user on a toast with no form and no focus.
                                UI.toast(T('passphrases_do_not_match'), 'err');
                                setTimeout(zkSetupFlow, 60);
                                return;
                            }
                            UI.toast(T('setting_up'), null);
                            ZKSync.setupNewPassphrase(pass).then(function (res) {
                                var s2 = (Store.getSettings && Store.getSettings()) || {};
                                s2.zkEnabled = true;
                                s2.zkSalt = res.salt;
                                s2.zkVerifier = res.verifier;
                                if (Store.setSettings) Store.setSettings(s2);
                                updateZkRow();
                                // The settings write above already schedules the
                                // authoritative auto-push, so success must NOT be
                                // gated on this immediate push promise: it races the
                                // scheduled one and was reporting a push failure even
                                // when the encrypted payload landed correctly. Report
                                // success now, and only surface a genuine rules
                                // rejection.
                                UI.toast(T('zero_knowledge_sync_enabled'), 'ok');
                                if (CloudSync && CloudSync.push) {
                                    CloudSync.push()['catch'](function (e) {
                                        var msg = (e && (e.code || e.message)) || '';
                                        if (String(msg).toLowerCase().indexOf('permission') !== -1) {
                                            UI.toast(T('enabled_but_cloud_rules_rejected_the'), 'err');
                                        }
                                    });
                                }
                                refocusSyncActions();
                            })['catch'](function () {
                                UI.toast(T('setup_failed'), 'err');
                                refocusSyncActions();
                            });
                        }
                    });
                    // Land focus on the confirm input so the D-pad has a defined
                    // starting point after the passphrase step swaps modals.
                    setTimeout(function () { if (Focus.focusKey) Focus.focusKey('zk-pass-input'); }, 60);
                }
            });
            // Focus the passphrase input on open.
            setTimeout(function () { if (Focus.focusKey) Focus.focusKey('zk-pass-input'); }, 60);
        }

        _zkUnlockFlowRef = zkUnlockFlow;
        function zkUnlockFlow() {
            var st = (Store.getSettings && Store.getSettings()) || {};
            var pi = zkPassphraseInput(T('ap_ph_passphrase'));
            UI.openModal({
                title: T('ap_unlock_cred_sync'),
                body: T('ap_zk_unlock_body'),
                bodyEl: pi.wrap,
                okText: T('unlock'),
                cancelText: T('cancel'),
                cancelClass: 'btn focusable',
                onOk: function () {
                    var pass = pi.input._realValue || '';
                    if (!pass) return;
                    UI.toast(T('unlocking'), null);
                    // openModal closes this modal BEFORE running onOk, so the
                    // passphrase field is already gone by the time these branches
                    // run. Every terminal path must therefore hand focus back to a
                    // surviving element (the sync actions row) or the D-pad is left
                    // on a destroyed node and the remote goes dead.
                    ZKSync.unlock(pass, st.zkSalt, st.zkVerifier).then(function (ok) {
                        if (!ok) {
                            UI.toast(T('couldn_t_unlock_synced_credentials_check'), 'err');
                            refocusSyncActions();
                            return;
                        }
                        updateZkRow();
                        if (CloudSync && CloudSync.pull) {
                            CloudSync.pull().then(function () {
                                UI.toast(T('credentials_unlocked'), 'ok');
                                UI.renderPlaylists();
                                refocusSyncActions();
                            })['catch'](function () {
                                UI.toast(T('unlocked_but_pull_failed'), 'err');
                                refocusSyncActions();
                            });
                        } else {
                            UI.toast(T('credentials_unlocked'), 'ok');
                            refocusSyncActions();
                        }
                    })['catch'](function () {
                        UI.toast(T('unlock_failed'), 'err');
                        refocusSyncActions();
                    });
                }
            });
            // Focus the passphrase input on open so the D-pad has a start point.
            setTimeout(function () { if (Focus.focusKey) Focus.focusKey('zk-pass-input'); }, 60);
        }

        function zkDisableFlow() {
            UI.openModal({
                title: T('ap_zk_off'),
                body: T('ap_zk_off_body'),
                okText: T('ap_turn_off'),
                cancelText: T('cancel'),
                onOk: function () {
                    var st = (Store.getSettings && Store.getSettings()) || {};
                    st.zkEnabled = false;
                    delete st.zkSalt;
                    delete st.zkVerifier;
                    if (Store.setSettings) Store.setSettings(st);
                    if (ZKSync.lock) ZKSync.lock();
                    updateZkRow();
                    if (CloudSync && CloudSync.push) { CloudSync.push()['catch'](function () {}); }
                    UI.toast(T('zero_knowledge_sync_turned_off'), 'ok');
                }
            });
        }/* Expose updateSyncUI to the module-level
         * refreshSignInUI helper so sign-in/sign-out events from
         * outside this scope (notably the pairing-sign-in flow) can
         * trigger a re-render of this section. */
        _updateSyncUIRef = updateSyncUI;

        /* Pull-on-sign-in confirmation flow.
         *
         * Previously the prompt was attempted via
         * setTimeout AFTER closeModal — that raced with closeModal's
         * cleanup and intermittently dropped the prompt entirely.
         *
         * Now: open the prompt directly (its openModal call wipes the
         * sign-in modal contents and rebuilds the layer with the
         * prompt). One modal swap, no race.
         *
         * Behaviour summary:
         *  - Default focus: "Pull now" (safe answer for "I just signed
         *    in on a new TV").
         *  - "Pull now" → CloudSync.pull() → THEN opts.onSuccess if it
         *    exists. We DO call opts.onSuccess after our pull so the
         *    parent flow can finish (focus restoration, navigation).
         *    If the parent's onSuccess itself does a pull (e.g.
         *    showLoginFromPairing), there's now a double-pull — wasteful
         *    but harmless. The cleanest long-term fix is to remove the
         *    pull from those callsites.
         *  - "Keep local" → just call opts.onSuccess (no pull). The next
         *    auto-push will overwrite cloud with local.
         */
        function promptPullOnSignIn(opts) {
            if (!window.CloudSync || typeof CloudSync.pull !== 'function') {
                // No pull capability — just finalise the sign-in flow.
                UI.closeModal();
                if (opts && opts.onSuccess) opts.onSuccess();
                else updateSyncUI();
                return;
            }
            UI.openModal({
                title: T('ap_pull_title'),
                body: T('ap_pull_body'),
                okText: T('ap_pull_now'),
                cancelText: T('ap_keep_local'),
                onOk: function () {
                    UI.toast(T('pulling_cloud_data'), null);
                    CloudSync.pull().then(function (data) {
                        UI.toast(T('cloud_data_pulled'), 'ok');
                        if (opts && opts.onSuccess) opts.onSuccess();
                        else { updateSyncUI(); setTimeout(function () { refocusSyncActions(true); }, 200); }
                        // Cloud copy is ZK and the key is locked this session —
                        // prompt for the passphrase so creds can be decrypted.
                        if (data && data.zkLocked) zkUnlockFlow();
                    })['catch'](function (err) {
                        Log.warn('[pullPrompt] pull failed', err);
                        UI.toast(T('pull_failed') + ' ' + (err.message || err), 'err')
                        if (opts && opts.onSuccess) opts.onSuccess();
                        else { updateSyncUI(); setTimeout(function () { refocusSyncActions(true); }, 200); }
                    });
                },
                onCancel: function () {
                    // Keep local. Skip the parent's onSuccess pull (if
                    // any) and just refresh the sync UI.
                    if (opts && opts.onSuccess) opts.onSuccess();
                    else { updateSyncUI(); setTimeout(function () { refocusSyncActions(true); }, 200); }
                }
            });
        }
        /* Return focus to a VISIBLE control in the Settings sync area.
         *
         * The bug this fixes: this used to target #syncActions only, and give up
         * silently if it was absent. But #syncActions carries init-hidden when
         * signed OUT — it is in the DOM but invisible, and Focus.focus() on a
         * hidden element is a no-op (Focus.isVisible tests offsetParent, which is
         * null for display:none). So a user who sets up a ZK passphrase WITHOUT
         * signing in lost focus entirely: the modal closed and nothing was focused.
         * That is a dead remote, and it is reachable — ZK setup does not require
         * being signed in.
         *
         * Now it walks a fallback chain and focuses the first control that is
         * actually visible:
         *
         *   1. #zkSyncRow      — the ZK row itself, if shown. Closest to what the
         *                        user was just doing, so focus lands where they
         *                        expect rather than jumping across the screen.
         *   2. #syncActions    — the push/pull/sign-out cluster. Only visible when
         *                        signed in.
         *   3. #syncLoginBtn   — the "Sign In" button. This is what is visible when
         *                        signed OUT, and is the case the old code missed.
         *   4. any focusable in the sync section, as a last resort.
         *
         * Each candidate is checked for VISIBILITY, not just existence — that
         * distinction is the whole bug.
         */
        function refocusSyncActions(preferSyncActions) {
            function firstVisibleIn(container) {
                if (!container) return null;
                var els = container.querySelectorAll('.focusable');
                for (var i = 0; i < els.length; i++) {
                    if (Focus.isVisible ? Focus.isVisible(els[i]) : els[i].offsetParent) return els[i];
                }
                return null;
            }
            function visibleEl(id) {
                var el = document.getElementById(id);
                if (!el) return null;
                if (el.classList && el.classList.contains('focusable')) {
                    var ok = Focus.isVisible ? Focus.isVisible(el) : el.offsetParent;
                    return ok ? el : null;
                }
                return firstVisibleIn(el);
            }
            // Default order lands on the ZK row first (closest to a just-finished ZK
            // setup — see the long note below). After a SIGN-IN, though, the user
            // expects focus on the sync action cluster's first button (Push to
            // Cloud), not the ZK row — so callers on the auth path pass
            // preferSyncActions=true to check #syncActions (whose first focusable is
            // Push to Cloud) before #zkSyncRow.
            var target = preferSyncActions
                ? (visibleEl('syncActions') || visibleEl('zkSyncRow') || visibleEl('syncLoginBtn') || firstVisibleIn(document.getElementById('settings')))
                : (visibleEl('zkSyncRow') || visibleEl('syncActions') || visibleEl('syncLoginBtn') || firstVisibleIn(document.getElementById('settings')));
            if (target) Focus.focus(target);
        }

        function buildLoginModal(opts) {
            if (typeof CloudSync !== 'undefined') CloudSync.init();
            var modal = document.getElementById('modalLayer');
            if (!modal) return;
            var curFocus = Focus.current();
            if (curFocus) {
                window._lastModalOpenerEl = curFocus;
                var fk = curFocus.getAttribute('data-focus-key');
                if (fk) window._lastModalOpenerKey = fk;
            }
            modal.innerHTML = '';
            var wrap = document.createElement('div'); wrap.className = 'modal-wrap';
            var body = document.createElement('div'); body.className = 'modal-body'; body.style.padding = '30px';
            var h = document.createElement('h2'); h.textContent = opts.title || T('ui_sign_in'); body.appendChild(h);
            var desc = document.createElement('div'); desc.className = 'setting-desc';
            desc.textContent = opts.desc || T('ui_sign_in_desc');
            desc.style.marginBottom = '20px'; body.appendChild(desc);

            var prefix = opts.prefix || 'sync';
            var emailInput = document.createElement('input'); emailInput.type = 'text'; emailInput.className = 'field focusable';
            emailInput.id = prefix + 'Email'; emailInput.setAttribute('data-focus-key', prefix + '-email');
            emailInput.setAttribute('readonly', ''); emailInput.placeholder = T('ui_email');
            emailInput.className += ' login-field login-field-tight'; body.appendChild(emailInput);

            // Password field with masking. No inline eye-toggle here:
            // the vkeyboard has its own show-password toggle
            // (ui.js vkShowPassword) which is the canonical entry point
            // for revealing the password on TV. Two toggles for the
            // same job was redundant and visually noisy. The pairing
            // server's web landing page still has a field-level toggle
            // because there's no vkeyboard there — phone users type
            // with the native keyboard.
            var passInput = document.createElement('input'); passInput.type = 'text'; passInput.className = 'field focusable';
            passInput.id = prefix + 'Pass'; passInput.setAttribute('data-focus-key', prefix + '-pass');
            passInput.setAttribute('readonly', ''); passInput.placeholder = T('ui_password');
            passInput.className += ' login-field';
            passInput._realValue = '';
            passInput._maskTimer = null;
            body.appendChild(passInput);

            // Mask password: show last char briefly, then mask all
            function maskPassword() {
                var real = passInput._realValue;
                if (!real) { passInput.value = ''; return; }
                if (real.length <= 1) {
                    passInput.value = real;
                } else {
                    var masked = '';
                    for (var mi = 0; mi < real.length - 1; mi++) masked += '\u2022';
                    masked += real.charAt(real.length - 1);
                    passInput.value = masked;
                }
                if (passInput._maskTimer) clearTimeout(passInput._maskTimer);
                passInput._maskTimer = setTimeout(function () {
                    var r2 = passInput._realValue;
                    var full = '';
                    for (var fi = 0; fi < r2.length; fi++) full += '\u2022';
                    passInput.value = full;
                }, 800);
            }

            emailInput.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(emailInput); });
            passInput.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(passInput); });

            passInput._isPassword = true;
            passInput._maskFn = maskPassword;

            var actions = document.createElement('div'); actions.className = 'login-actions';
            // TWO bugs were combined here:
            // 1. The container had class "modal-actions" which matched
            //    .modal-actions > * + * { margin-left: 12px } in
            //    components.css — applying a 12px LEFT margin to row2
            //    (the second child of actions). That pushed the entire
            //    bottom row to the right of the top row.
            // 2. The container was appended as a SIBLING of body, not
            //    a child. body has padding:30px (line 1604), so its
            //    inputs sit inside a 30px-padded inner area. The actions
            //    container, being outside, had a different horizontal
            //    boundary — making the row1 buttons stretch wider than
            //    the email/password fields above them.
            // Fix: drop the modal-actions class entirely, drop max-width
            // (the parent body now constrains width), and append actions
            // INSIDE body. The buttons inherit body's padding context so
            // width:100% on the row matches the input width exactly.
            /* layout via .login-actions class */
            var row1 = document.createElement('div');
            row1.className = 'login-row';
            row1.className += ' login-row-gap';
            var row2 = document.createElement('div');
            row2.className = 'login-row';
            /* layout via .login-row class */

            // Equal flex distribution. Left button carries the 12px
            // right margin as the gutter; right button has none.
            // flex:1 1 0 (not "1 1 auto") forces equal share regardless
            // of intrinsic content width. Layout via .login-btn-l/.login-btn-r.

            var signInBtn = document.createElement('button'); signInBtn.className = 'btn focusable modal-btn';
            signInBtn.setAttribute('data-focus-key', prefix + '-signin'); signInBtn.setAttribute('tabindex', '-1');
            signInBtn.textContent = T('sign_in');
            signInBtn.className += ' login-btn-l';

            var signUpBtn = document.createElement('button'); signUpBtn.className = 'btn focusable modal-btn';
            signUpBtn.setAttribute('data-focus-key', prefix + '-signup'); signUpBtn.setAttribute('tabindex', '-1');
            signUpBtn.textContent = T('create_account');
            signUpBtn.className += ' login-btn-r';

            // Reset + cancel use the same .btn class as
            // sign-in / sign-up. Previously they used .btn.ghost which
            // gave them a transparent / outline look that visually
            // didn't match the other two. All four now uniform.
            var resetBtn = document.createElement('button'); resetBtn.className = 'btn focusable modal-btn';
            resetBtn.setAttribute('data-focus-key', prefix + '-reset'); resetBtn.setAttribute('tabindex', '-1');
            resetBtn.textContent = T('reset_password');
            resetBtn.className += ' login-btn-l';

            var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn focusable modal-btn';
            cancelBtn.setAttribute('data-focus-key', prefix + '-cancel'); cancelBtn.setAttribute('tabindex', '-1');
            cancelBtn.textContent = T('cancel');
            cancelBtn.className += ' login-btn-r';

            function getPass() { return passInput._realValue || ''; }

            signInBtn.addEventListener('click', function () {
                var e = emailInput.value.trim(), p = getPass();
                if (!e || !p) { UI.toast(T('enter_email_and_password'), 'err'); return; }
                UI.toast(T('signing_in'), null);
                CloudSync.signInEmail(e, p).then(function () {
                    UI.toast(T('signed_in'), 'ok');
                    window._modalOnCancel = null;
                    /* Was — close sign-in modal, then
                     * setTimeout 300ms, then open pull prompt. That
                     * race with closeModal's cleanup intermittently
                     * dropped the pull prompt entirely on some devices.
                     *
                     * Now: open the pull prompt FIRST (its openModal
                     * call wipes the sign-in modal contents and rebuilds
                     * the layer with the prompt). No close-then-open
                     * race, no setTimeout. */
                    promptPullOnSignIn(opts);
                })['catch'](function (err) {
                    if (window.console && console.warn) {
                        Log.warn('[signin] failed', err);
                    }
                    UI.toast(T('failed') + ' ' + (err.message || err), 'err')
                });
            });
            signUpBtn.addEventListener('click', function () {
                var e = emailInput.value.trim(), p = getPass();
                if (!e || !p) { UI.toast(T('enter_email_and_password'), 'err'); return; }
                if (p.length < 6) { UI.toast(T('password_must_be_6_characters'), 'err'); return; }
                CloudSync.signUp(e, p).then(function () {
                    UI.toast(T('account_created'), 'ok');
                    window._modalOnCancel = null;
                    UI.closeModal();
                    if (opts.onSuccess) opts.onSuccess();
                    else updateSyncUI();
                })['catch'](function (err) { UI.toast(T('failed') + ' ' + (err.message || err), 'err'); });
            });
            resetBtn.addEventListener('click', function () {
                var e = emailInput.value.trim();
                if (!e) { UI.toast(T('enter_your_email_first'), 'err'); return; }
                if (!CloudSync.resetPassword) { UI.toast(T('reset_not_available'), 'err'); return; }
                resetBtn.disabled = true;
                CloudSync.resetPassword(e).then(function () {
                    UI.toast(T('reset_email_sent_check_your_inbox'), 'ok');
                })['catch'](function (err) {
                    UI.toast(T('reset_failed') + ' ' + (err.message || err), 'err')
                }).then(function () { resetBtn.disabled = false; });
            });
            cancelBtn.addEventListener('click', function () {
                window._modalOnCancel = null; // Don't fire again from closeModal
                UI.closeModal();
                if (opts.onCancel) opts.onCancel();
            });

            // Store onCancel so handleBack → closeModal can trigger it too
            window._modalOnCancel = opts.onCancel || null;

            row1.appendChild(signInBtn); row1.appendChild(signUpBtn);
            row2.appendChild(resetBtn); row2.appendChild(cancelBtn);
            actions.appendChild(row1); actions.appendChild(row2);
            // Actions appended INSIDE body so it shares
            // the same 30px padding context as the inputs above. Was a
            // sibling of body, which gave it a different horizontal
            // boundary and made the button row wider than the input row.
            body.appendChild(actions);
            wrap.appendChild(body); modal.appendChild(wrap);
            modal.classList.remove('hidden');
            setTimeout(function () { Focus.focusKey(prefix + '-email'); }, 100);

            return { emailInput: emailInput, passInput: passInput, maskPassword: maskPassword };
        }

        function showLoginPrompt() {
            buildLoginModal({
                title: T('sign_in'),
                desc: T('ui_sign_in_desc'),
                prefix: 'sync',
                onSuccess: function () {
                    updateSyncUI();
                    // After signing in from Settings, move
                    // focus to the first sync action (Push to Cloud) rather
                    // than letting it fall to the top of Settings.
                    //
                    // Timing/safety: this path runs after the "Pull cloud
                    // data?" modal (promptPullOnSignIn, always opened by the
                    // sign-in handler) is dismissed. closeModal() hides the
                    // modal layer SYNCHRONOUSLY on the OK/Keep-local click and
                    // schedules its own opener-focus restore at 150ms. We wait
                    // 200ms so (a) the modal is already hidden — focus can't
                    // land behind a visible modal, the failure that caused the
                    // earlier revert — and (b) we run after the 150ms
                    // restore, so our focus wins. refocusSyncActions(true) prefers
                    // the sync-action cluster (Push to Cloud) since this is a
                    // sign-in; it falls back to leaving focus where closeModal left
                    // it (top of Settings) if syncActions is absent.
                    //
                    // NOTE: this is the SETTINGS sign-in path only. The
                    // pairing path (showLoginFromPairing) navigates home and
                    // is intentionally left untouched.
                    setTimeout(function () { refocusSyncActions(true); }, 200);
                }
            });
        }

        /* Login from pairing screen */
        function showLoginFromPairing() {
            if (typeof CloudSync === 'undefined') {
                UI.toast(T('cloud_sync_not_available_check_config'), 'err');
                return;
            }
            CloudSync.init();
            buildLoginModal({
                title: T('ui_sign_in_sync'),
                desc: 'Sign in to download your playlists and favorites from the cloud.',
                prefix: 'pair-sync',
                onCancel: function () { startPairFlow(); },
                onSuccess: function () {
                    updateSyncUI();
                    // promptPullOnSignIn (opened by buildLoginModal on sign-in
                    // success) has ALREADY run the pull before invoking this
                    // onSuccess, so the playlists are in the Store now. Decide
                    // home-vs-stay from the Store — the source of truth — rather
                    // than doing a second, redundant pull and inspecting its
                    // return value (that double-pull raced the first and could
                    // leave the user stranded on the onboarding "add a playlist"
                    // screen even though playlists had synced). If playlists
                    // exist, leave onboarding for home.
                    var pls = (Store.getPlaylists && Store.getPlaylists()) || [];
                    if (pls.length) {
                        UI.toast(T('playlists_synced'), 'ok');
                        goHome();
                    } else {
                        UI.toast(T('signed_in_add_playlists_to_sync'), null);
                    }
                }
            });
        }



        if (loginBtn) loginBtn.addEventListener('click', showLoginPrompt);

        // Wire pairing screen sign-in button
        var pairLoginBtn = document.getElementById('pairLogin');
        if (pairLoginBtn) pairLoginBtn.addEventListener('click', showLoginFromPairing);

        if (pushBtn) pushBtn.addEventListener('click', function () {
            UI.toast(T('pushing'), null);
            CloudSync.push().then(function () { UI.toast(T('pushed_to_cloud'), 'ok'); })['catch'](function (e) { UI.toast(T('push_failed'), 'err'); });
        });
        var zkToggleBtn = document.getElementById('zkToggleBtn');
        if (zkToggleBtn) zkToggleBtn.addEventListener('click', function () { onZkToggle(); });
        if (pullBtn) pullBtn.addEventListener('click', function () {
            UI.toast(T('pulling'), null);
            CloudSync.pull().then(function (data) {
                // If the cloud copy is zero-knowledge and this session's key
                // is locked, the pull couldn't decrypt the synced credentials.
                // Route to the passphrase unlock flow (which re-pulls on
                // success) rather than reporting a plain sync.
                if (data && data.zkLocked) { zkUnlockFlow(); return; }
                UI.toast(T('synced_from_cloud'), 'ok'); UI.renderHome();
            })['catch'](function (e) { UI.toast(T('pull_failed_2'), 'err'); });
        });
        if (logoutBtn) logoutBtn.addEventListener('click', function () {
            UI.openModal({
                title: T('ap_sign_out'),
                body: T('ap_sign_out_body'),
                okText: T('ap_sign_out'),
                onOk: function () {
                    CloudSync.signOut().then(function () {
                        UI.toast(T('signed_out'), 'ok');
                        updateSyncUI();
                        setTimeout(function () {
                            var syncRow = document.getElementById('syncRow');
                            if (syncRow) {
                                var btn = syncRow.querySelector('.focusable');
                                if (btn) Focus.focus(btn);
                            }
                        }, 300);
                    });
                }
            });
        });
        if (forgotBtn) forgotBtn.addEventListener('click', function () {
            var modal = document.getElementById('modalLayer');
            if (!modal) return;
            modal.innerHTML = '';
            var wrap = document.createElement('div'); wrap.className = 'modal-wrap';
            var body = document.createElement('div'); body.className = 'modal-body'; body.style.padding = '30px';
            var h2 = document.createElement('h2'); h2.textContent = T('reset_password'); body.appendChild(h2);
            var desc = document.createElement('div'); desc.className = 'setting-desc'; desc.textContent = T('enter_your_email_to_receive_a'); desc.style.marginBottom = '20px'; body.appendChild(desc);
            var resetEmail = document.createElement('input'); resetEmail.type = 'text'; resetEmail.className = 'field focusable';
            resetEmail.id = 'resetEmail'; resetEmail.setAttribute('data-focus-key', 'reset-email');
            resetEmail.setAttribute('readonly', ''); resetEmail.placeholder = T('ui_email');
            resetEmail.className += ' login-field';
            resetEmail.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(resetEmail); });
            body.appendChild(resetEmail);
            var actions = document.createElement('div'); actions.className = 'modal-actions';
            actions.className += ' login-actions-col';
            var sendBtn = document.createElement('button'); sendBtn.className = 'btn focusable modal-btn';
            sendBtn.setAttribute('data-focus-key', 'reset-send'); sendBtn.setAttribute('tabindex', '-1');
            sendBtn.textContent = T('send_reset_email');
            sendBtn.addEventListener('click', function () {
                var e = resetEmail.value.trim();
                if (!e) { UI.toast(T('enter_email'), 'err'); return; }
                if (typeof CloudSync !== 'undefined' && CloudSync.resetPassword) {
                    CloudSync.resetPassword(e).then(function () {
                        UI.closeModal(); UI.toast(T('reset_email_sent_check_your_inbox'), 'ok');
                    })['catch'](function (err) { UI.toast(T('failed') + ' ' + (err.message || err), 'err'); });
                } else { UI.toast(T('reset_not_available'), 'err'); }
            });
            var cancelBtn2 = document.createElement('button'); cancelBtn2.className = 'btn focusable modal-btn';
            cancelBtn2.setAttribute('data-focus-key', 'reset-cancel'); cancelBtn2.setAttribute('tabindex', '-1');
            cancelBtn2.textContent = T('cancel');
            cancelBtn2.addEventListener('click', function () { UI.closeModal(); });
            actions.appendChild(sendBtn); actions.appendChild(cancelBtn2);
            wrap.appendChild(body); wrap.appendChild(actions); modal.appendChild(wrap);
            modal.classList.remove('hidden');
            setTimeout(function () { Focus.focusKey('reset-email'); }, 100);
        });
        if (wipeCloudBtn) wipeCloudBtn.addEventListener('click', function () {
            UI.openModal({
                title: T('ap_wipe_cloud'),
                body: T('ap_wipe_cloud_body'),
                okText: T('ap_wipe_cloud_ok'),
                onOk: function () {
                    if (typeof CloudSync !== 'undefined' && CloudSync.isSignedIn()) {
                        CloudSync.wipeCloud().then(function () {
                            UI.toast(T('cloud_data_wiped'), 'ok');
                        })['catch'](function (err) { UI.toast(T('failed') + ' ' + (err.message || err), 'err'); });
                    }
                }
            });
        });
        // Delete Cloud Account. Distinct from Wipe Cloud
        // Data — this removes the cloud data AND deletes the Firebase
        // auth account entirely, then signs the user out. Two-step
        // confirmation because it's irreversible. If Firebase reports
        // the login is too old (requires-recent-login), we tell the
        // user to sign in again and retry rather than failing silently.
        var deleteAccountBtn = document.getElementById('syncDeleteAccountBtn');
        if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', function () {
            UI.openModal({
                title: T('ui_delete_cloud_account'),
                body: T('ap_delete_account_body'),
                okText: T('ap_delete_account'),
                onOk: function () {
                    if (typeof CloudSync === 'undefined' || !CloudSync.isSignedIn()) {
                        UI.toast(T('not_signed_in'), 'err');
                        return;
                    }
                    UI.toast(T('deleting_account'), null);
                    CloudSync.deleteAccount().then(function () {
                        UI.toast(T('account_deleted'), 'ok');
                        updateSyncUI();
                    })['catch'](function (err) {
                        if (err && err.code === 'requires-recent-login') {
                            UI.toast(T('please_sign_in_again_then_retry'), 'err');
                            // Drop them into the sign-in prompt so they can
                            // refresh their session immediately.
                            setTimeout(function () { showLoginPrompt(); }, 600);
                        } else {
                            UI.toast(T('failed') + ' ' + (err.message || err), 'err')
                        }
                    });
                }
            });
        });
        setTimeout(updateSyncUI, 2000);
    }

    /* -- Long-press detection for OK -- */
    // OK press state managed in wireRemote keydown/keyup handlers
    // Focus memory for back navigation
    var focusMemory = {}; // { sectionName: lastFocusKey }


    function wireRemote() {
        Remote.on('up',    function () { handleArrow('up'); });
        Remote.on('down',  function () { handleArrow('down'); });
        Remote.on('left',  function () { arrowOrHold('left'); });
        Remote.on('right', function () { arrowOrHold('right'); });

        /* Live TV list view, focus on a channel row: HOLD Left or Right (600 ms) moves the guide time window two
         * hours earlier / later, and keeps stepping while held. A short press still does what it always did (Left goes
         * to the categories), but it acts when the key is released, as OK does, because a press cannot be told from
         * a hold any earlier. Everywhere else Left/Right act at once, exactly as before (card view, menus and
         * grids use held arrows to travel). */
        var holdDir = null, holdTimer = null, holdRepeat = null, holdFired = false, holdAt = 0;
        function epgHoldContext() {
            try {
                if (activeScreenId() !== 'home') return false;
                var ml = document.getElementById('modalLayer');
                if (ml && !ml.classList.contains('hidden')) return false;
                var vk = document.getElementById('vkeyboard');
                if (vk && !vk.classList.contains('hidden')) return false;
                var sec = document.querySelector('.content-section.active');
                if (!sec || sec.getAttribute('data-section-content') !== 'livetv') return false;
                if (sec.getAttribute('data-view-mode') === 'card') return false;
                var list = document.getElementById('liveChList');
                var cur = Focus.current();
                return !!(list && cur && list.contains(cur) && window.UI && UI.shiftLiveEpg);
            } catch (e) { return false; }
        }
        function holdReset() {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (holdRepeat) { clearInterval(holdRepeat); holdRepeat = null; }
            holdDir = null; holdFired = false;
        }
        function arrowOrHold(dir) {
            if (holdDir) {
                // Key repeat of the key already being timed. A stale hold (key-up lost) is dropped after 4 s.
                if (holdDir === dir && Date.now() - holdAt < 4000) return;
                holdReset();
            }
            if (!epgHoldContext()) { handleArrow(dir); return; }
            holdDir = dir; holdAt = Date.now(); holdFired = false;
            holdTimer = setTimeout(function () {
                holdTimer = null;
                holdFired = true;
                var step = function () { if (epgHoldContext()) UI.shiftLiveEpg(dir === 'right' ? 2 : -2); else holdReset(); };
                step();
                holdRepeat = setInterval(step, 800);
            }, 600);
        }
        document.addEventListener('keyup', function (e) {
            if (!holdDir) return;
            var code = e.keyCode || 0, key = e.key || '';
            var isL = code === 37 || key === 'ArrowLeft', isR = code === 39 || key === 'ArrowRight';
            if (!(isL || isR)) return;
            var dir = holdDir, fired = holdFired;
            holdReset();
            if (!fired) handleArrow(dir);
        }, true);
        window.addEventListener('blur', holdReset);
        document.addEventListener('visibilitychange', function () { if (document.hidden) holdReset(); });
        // OK handled via keydown/keyup (see below), not Remote.on
        Remote.on('back',  function (ev) { handleBack(ev); });
        // Touch devices: tapping the dimmed area outside a modal dismisses it, the same as Back.
        // Only the scrim itself (or a stacked picker overlay's own backdrop) counts: taps inside
        // the card never reach here as target === layer.
        (function () {
            var ml = document.getElementById('modalLayer');
            if (!ml) return;
            ml.addEventListener('click', function (e) {
                var t = e.target;
                if (!(window.Mobile && Mobile.isTouch && Mobile.isTouch())) return;
                if (ml.classList.contains('hidden')) return;
                if (t === ml || (t && t.classList && t.classList.contains('modal-pick-overlay'))) {
                    // A keyboard open over the modal goes with it: one tap outside closes both.
                    var vk = document.getElementById('vkeyboard');
                    if (vk && !vk.classList.contains('hidden')) { try { UI.closeVKeyboard(); } catch (err) {} }
                    handleBack(e);
                }
            });
        })();

        /* Touch devices: a tap anywhere outside the on-screen keyboard (and not on a text field, which
         * re-targets it) closes the keyboard. CAPTURE phase on purpose: keys such as Symbols and Show
         * Password rebuild the keyboard, which detaches the tapped key before a bubbling listener
         * runs, so a bubbling check saw a target "outside" the keyboard and closed it. In capture the
         * target is still in place. Ignored for 400 ms after it opens so the tap that opened it
         * cannot also close it. A tap on the modal scrim is handled above. */
        document.addEventListener('click', function (e) {
            if (!(window.Mobile && Mobile.isTouch && Mobile.isTouch())) return;
            var vk = document.getElementById('vkeyboard');
            if (!vk || vk.classList.contains('hidden')) return;
            if (UI.vkOpenedAt && Date.now() - UI.vkOpenedAt < 400) return;
            var t = e.target;
            if (t && t.closest && (t.closest('#vkeyboard') || t.closest('.field-menu') || t.closest('input.field') || t.closest('textarea.field'))) return;
            try { UI.closeVKeyboard(); } catch (err) {}
        }, true);

        Remote.on('play',  function () { Player.togglePause(); });
        Remote.on('pause', function () { Player.togglePause(); });
        Remote.on('stop',  function () { if (activeScreenId() === 'player') exitPlayer(); });

        Remote.on('info',  function () { if (activeScreenId() === 'player') Player.showOverlay(); });
        Remote.on('menu',  function () { handleMenu(); });

        Remote.on('channel_up',   function () { handleChannelUpDown(+1); });
        Remote.on('channel_down', function () { handleChannelUpDown(-1); });

        Remote.on('red',    function () { /* reserved */ });
        Remote.on('green',  function () {
            // Live TV guide: GREEN = Catch-up for the channel in the Now/Next box.
            var gs = document.querySelector('.content-section.active');
            if (gs && gs.getAttribute('data-section-content') === 'livetv' && activeScreenId() === 'home') { try { UI.openCatchupForShown(); } catch (eG) {} }
        });
        Remote.on('yellow', function () { handleYellow(); });
        Remote.on('blue',   function () { handleBlue(); });

        // Digits
        for (var d = 0; d <= 9; d++) {
            (function (n) {
                Remote.on('' + n, function () { handleDigit(n); });
            })(d);
        }

        // OK is handled via keydown/keyup only — NOT via Remote.on('ok')
        // Long press (600ms) fires on timer, short press fires on keyup if not long
        var okTimer = null;
        var isLongPress = false;

        document.addEventListener('keydown', function (e) {
            var code = e.keyCode || 0;
            var key = e.key || '';
            if (code === 13 || key === 'Enter') {
                if (okTimer) return; // ignore repeats
                isLongPress = false;
                okTimer = setTimeout(function () {
                    isLongPress = true;
                    handleOkLong();
                }, 600);
            }
        }, true);

        document.addEventListener('keyup', function (e) {
            var code = e.keyCode || 0;
            var key = e.key || '';
            if (code === 13 || key === 'Enter') {
                if (okTimer) { clearTimeout(okTimer); okTimer = null; }
                if (!isLongPress) {
                    handleOk(e);
                }
                isLongPress = false;
            }
        }, true);
    }

    /* ========== Navigation: explicit per-section rules ========== */

    function getActiveSection() {
        var s = document.querySelector('.content-section.active');
        return s ? s.getAttribute('data-section-content') : null;
    }

    function isInSidebar(el) {
        var sb = document.getElementById('sidebar');
        return sb && sb.contains(el);
    }

    // Expand sidebar when focus enters, collapse when focus leaves
    Focus.onChange(function (prev, curr) {
        var sb = document.getElementById('sidebar');
        if (!sb) return;
        // Don't collapse if exit dialog is open
        var exitDlg = document.getElementById('exitDialog');
        if (exitDlg && !exitDlg.classList.contains('hidden')) return;
        // Touch devices are kept permanently expanded (set once at boot, see
        // boot()'s data-touch block) — a tap-driven focus change isn't the
        // same "browsing the menu vs browsing content" signal D-pad focus is,
        // so this collapse-on-focus-leave behavior doesn't apply to them.
        if (document.documentElement.getAttribute('data-touch')) return;
        if (curr && isInSidebar(curr)) {
            sb.classList.add('expanded');
        } else {
            collapseSidebar(sb);
        }
    });

    function isInElement(el, id) {
        var container = document.getElementById(id);
        return container && container.contains(el);
    }

    function handleArrow(dir) {
        // NOTE: no RTL left/right flip. The layout is now LTR in both languages (RTL
        // affects TEXT only — see rtl.css), so visual order == DOM order and the
        // physical Left/Right keys already move in the correct visual direction. The
        // former dir=="rtl" swap here existed only because the OLD RTL mirrored the
        // layout; it was the root cause of the RTL nav bugs (stuck rows, reversed
        // buttons). Removing it makes every nav handler work identically in both
        // directions with no per-handler mirroring.
        var screen = activeScreenId();

        // A directional press means the user moved on from the just-closed modal
        // opener; clear the one-shot OK guard so it can't swallow a later OK.
        window._swallowNextOk = false;

        // Info panel entered by OK-pinning a card: LEFT returns to the pinned card.
        // Handled at the very top so it can't be swallowed by the grid/panel nav
        // handlers downstream (which otherwise treat panel-left inconsistently).
        if (window._vodPinnedCard) {
            var apCur = Focus.current();
            var apMInfo = document.getElementById('movieInfo');
            var apSInfo = document.getElementById('seriesInfo');
            var apPfx = apCur && apCur.id === 'seriesInfoPlay' ? 'series' :
                        apCur && apCur.id === 'movieInfoPlay' ? 'movie' :
                        (apSInfo && apCur && (apCur === apSInfo || apSInfo.contains(apCur))) ? 'series' :
                        (apMInfo && apCur && (apCur === apMInfo || apMInfo.contains(apCur))) ? 'movie' : null;
            if (apPfx) {
                var apInfoEl = document.getElementById(apPfx + 'Info');
                var apPlayBtn = document.getElementById(apPfx + 'InfoPlay');
                var onPlayBtn = apCur === apPlayBtn;
                if (dir === 'left' && document.body.contains(window._vodPinnedCard)) {
                    Focus.focus(window._vodPinnedCard); window._vodPinnedCard = null; return;
                }
                // Down from Play button -> synopsis (scrollable). Up from synopsis
                // top -> Play button. This makes the panel a proper detail view.
                if (onPlayBtn && dir === 'down') {
                    Focus.focus(apInfoEl);
                    if (typeof updateVodScrollHint === 'function') updateVodScrollHint(apInfoEl);
                    return;
                }
                if (!onPlayBtn && (dir === 'up' || dir === 'down')) {
                    var apBody = apInfoEl.querySelector('.vod-info-body') || apInfoEl;
                    if (dir === 'up' && apBody.scrollTop <= 2 && apPlayBtn) {
                        Focus.focus(apPlayBtn); return;
                    }
                    var apStep = Math.max(80, Math.floor(apBody.clientHeight * 0.6));
                    apBody.scrollTop += (dir === 'down' ? apStep : -apStep);
                    if (typeof updateVodScrollHint === 'function') updateVodScrollHint(apInfoEl);
                    return;
                }
                if (onPlayBtn && (dir === 'up' || dir === 'right')) { return; }
            }
        }

        // ---- Modal with two-column layout (category manager) ----
        var vk = document.getElementById('vkeyboard');
        var vkVisible = vk && !vk.classList.contains('hidden');
        var modalL = document.getElementById('modalLayer');
        if (modalL && !modalL.classList.contains('hidden') && !vkVisible) {
            var mc = Focus.current();
            // Safety net: if focus was lost (null) or escaped the modal — which can
            // happen when a re-render replaces the focused node — pull focus back
            // INTO the modal rather than letting the handler fall through to the
            // player overlay behind it. Prefer a sensible first focusable.
            if (!mc || !modalL.contains(mc)) {
                var firstFocusable = modalL.querySelector('.focusable');
                if (firstFocusable) { Focus.focus(firstFocusable); return; }
            }
            if (mc && modalL.contains(mc)) {
                var fkModal = mc.getAttribute('data-focus-key') || '';

                // HIGHEST PRIORITY: a filter/list PICKER opened with overlay:true
                // (e.g. from a parental manager) is a .modal-pick-overlay appended into
                // #modalLayer as a SIBLING of the modal card behind it. Its rows and the
                // underlying modal's rows are all inside #modalLayer, so ANY handler
                // that scopes to the whole layer (or to the manager list) would let
                // Up/Down at the first/last pick row jump to a row BEHIND the overlay
                // ("focus goes behind the picker"). Handle the overlay FIRST and confine
                // navigation to it; at its top/bottom edge nothing is in that direction,
                // so focus holds inside the picker. Left/right are no-ops in a 1-column
                // list. OK/Back are handled elsewhere; this is movement only.
                var pickOv = mc.closest ? mc.closest('.modal-pick-overlay') : null;
                if (pickOv) {
                    if (dir === 'up' || dir === 'down') Focus.spatial(dir, pickOv);
                    return;
                }

                // Series episode browser (season chips + episode card grid).
                // Needs custom logic ON TOP of spatial nav: Up from a top-row
                // episode card should return to the FAR-LEFT season chip rather
                // than whichever chip sits geometrically above that column.
                // Matches the Xtream modal (season-/ep-) and Stalker (sseason-/sep-).
                if (fkModal.indexOf('season-') === 0 || fkModal.indexOf('ep-') === 0 ||
                    fkModal.indexOf('sseason-') === 0 || fkModal.indexOf('sep-') === 0) {
                    var wasCard = (fkModal.indexOf('ep-') === 0 || fkModal.indexOf('sep-') === 0);
                    var wasSeason = (fkModal.indexOf('season-') === 0 || fkModal.indexOf('sseason-') === 0);
                    var seasonBar = modalL.querySelector('.series-season-bar');
                    var epGrid = modalL.querySelector('.series-ep-grid');

                    if (wasSeason) {
                        if (fkModal === 'season-select') {
                            // Many-seasons case: the season control is a button that opens the
                            // list picker on OK (not chips, not a select). Down drops into the
                            // episode grid; up/left/right hold — the picker changes the season.
                            if (dir === 'down') {
                                if (epGrid) { var cds = epGrid.querySelector('.focusable'); if (cds) Focus.focus(cds); }
                            }
                            window._navHandled = true; return;
                        }
                        // Season chip row(s). Chips can wrap onto MULTIPLE rows, so up/down
                        // must first try to move within the season bar; only when there's no
                        // chip in that direction do we leave it (down -> episodes, up -> hold).
                        if (dir === 'left' || dir === 'right') {
                            if (seasonBar) Focus.spatial(dir, seasonBar); // else hold
                            window._navHandled = true; return;
                        }
                        if (dir === 'down') {
                            // Next chip row if there is one; otherwise into the episode grid.
                            var movedDownChip = seasonBar ? Focus.spatial('down', seasonBar) : false;
                            if (!movedDownChip) {
                                if (epGrid) { var c0 = epGrid.querySelector('.focusable'); if (c0) Focus.focus(c0); }
                            }
                            window._navHandled = true; return;
                        }
                        if (dir === 'up') {
                            // Previous chip row if there is one; otherwise hold (nothing above).
                            if (seasonBar) Focus.spatial('up', seasonBar);
                            window._navHandled = true; return;
                        }
                        // any other dir: hold.
                        window._navHandled = true; return;
                    }

                    // Episode card.
                    if (dir === 'left' || dir === 'right') {
                        // Stay within the grid; no wrap at row ends.
                        if (epGrid) Focus.spatial(dir, epGrid);
                        window._navHandled = true; return;
                    }
                    if (dir === 'up') {
                        // Try a card in the row above (scoped to the grid). If none
                        // (already top row), go to the season chips — the LAST chip, which
                        // is the row visually adjacent to the grid when seasons wrap onto
                        // multiple rows (going to the first chip would skip past those rows).
                        var movedUp = epGrid ? Focus.spatial('up', epGrid) : false;
                        if (!movedUp) {
                            var chipsUp = modalL.querySelectorAll('.series-season-chip');
                            if (chipsUp && chipsUp.length) {
                                Focus.focus(chipsUp[chipsUp.length - 1]);
                            } else {
                                // Many-seasons mode: no chips, so return to the season dropdown.
                                var selUp = modalL.querySelector('.series-season-select');
                                if (selUp) Focus.focus(selUp);
                            }
                        }
                        window._navHandled = true; return;
                    }
                    if (dir === 'down') {
                        // Try a card in the row below (scoped to the GRID — crucially not
                        // the whole modal, or the full-width Close button below the grid
                        // scores better than a row-3 card and focus skips the last row).
                        var movedDown = epGrid ? Focus.spatial('down', epGrid) : false;
                        if (!movedDown) {
                            // Genuinely the last row: go to the modal's action buttons.
                            var closeBtn = modalL.querySelector('[data-focus-key="ep-close"], .modal-actions .btn');
                            if (closeBtn) Focus.focus(closeBtn);
                        }
                        window._navHandled = true; return;
                    }
                    return;
                }

                // NOTE: openActionSheet used to have a branch here forcing Up from
                // Cancel to the first action button. That was needed when the sheet
                // was a rigid 3-col grid where the wrapped Cancel had no honest
                // button directly above it. The sheet is now flex-centred (423/424),
                // so every button sits under a real neighbour and plain spatial nav
                // resolves Up correctly — the forced jump would now be wrong (it
                // dragged focus to EPG Refresh regardless of where Cancel sat).
                // Removed; the default spatial branch below covers it.

                // Category / content-lock managers (both use .lock-panel-tools +
                // .lock-panel-list). These build ~6 focusable buttons per row over
                // hundreds of rows (~2000+ focusables). The tools buttons sit FIRST
                // in DOM order, so a whole-modal spatial scan from a tools button
                // hits the forward scan window that necessarily extends across ~400
                // deep, freshly-built row buttons — each an isVisible() ancestor-walk
                // plus getBoundingClientRect(), i.e. hundreds of forced layouts per
                // press (the seconds-long highlight delay on the top buttons). The
                // fix is SCOPE, not a different nav algorithm: keep spatial nav
                // everywhere, but scope each scan to the relevant container (the
                // 8-button tools row, or the list) instead of the whole modal, so
                // the row buttons are never in the tools scan and vice versa. D/U
                // cross the tools<->list boundary explicitly.
                var mgrTools = mc.closest ? mc.closest('.lock-panel-tools') : null;
                if (mgrTools) {
                    // The tools row is a WRAPPED 2-column grid (flex-wrap:wrap +
                    // flex:0 0 calc(50% - 6px)), i.e. 4 rows x 2 columns for the
                    // category manager — NOT a single horizontal row. So every
                    // direction must be resolved geometrically WITHIN the grid
                    // first; only fall through when the press would genuinely leave
                    // the grid (i.e. spatial finds nothing).
                    //
                    // Scope stays the tools container (8 elements), so this keeps
                    // the whole-modal scan out of the picture — that part of 464
                    // was correct and is what fixed the seconds-long lag.
                    if (Focus.spatial(dir, mgrTools)) return;
                    // Nothing in that direction inside the grid: Down from the
                    // BOTTOM row enters the filter bar (search/filter) if present,
                    // else the list. Up from the top row has nowhere to go (the
                    // header above is not focusable), so hold focus.
                    if (dir === 'down') {
                        var fbDown = modalL.querySelector('.lock-mgr-filterbar');
                        if (fbDown) { Focus.focusFirstIn(fbDown); return; }
                        var mgrListDown = modalL.querySelector('.lock-panel-list');
                        if (mgrListDown) Focus.focusFirstIn(mgrListDown);
                    }
                    return;
                }
                var mgrFilter = mc.closest ? mc.closest('.lock-mgr-filterbar') : null;
                if (mgrFilter) {
                    // Filter bar: search | filter, side by side. Left/right move
                    // within it spatially. Up leaves to the tools grid (bottom row);
                    // Down enters the list.
                    if (dir === 'left' || dir === 'right') { Focus.spatial(dir, mgrFilter); return; }
                    if (dir === 'up') {
                        var toolsUp = modalL.querySelector('.lock-panel-tools');
                        if (toolsUp && !Focus.spatial('up', toolsUp)) Focus.focusFirstIn(toolsUp);
                        return;
                    }
                    if (dir === 'down') {
                        // Category manager with more than one page: Down lands on the A-Z strip
                        // (the control set data-focus-down to the letter nearest in x).
                        var ovDownKey = mc.getAttribute('data-focus-down');
                        if (ovDownKey) {
                            var ovDown = modalL.querySelector('.focusable[data-focus-key="' + ovDownKey + '"]');
                            if (ovDown && ovDown.offsetWidth > 0) { Focus.focus(ovDown); return; }
                        }
                        var listDown = modalL.querySelector('.lock-panel-list');
                        if (listDown) Focus.focusFirstIn(listDown);
                        return;
                    }
                    return;
                }
                var mgrList = mc.closest ? mc.closest('.lock-panel-list') : null;
                if (mgrList) {
                    // Scope the scan to the list only (never the whole modal), so the
                    // window stays over rows. Up from the first row has nothing above
                    // it inside the list — send focus back to the filter bar (if
                    // present) else the tools grid.
                    if (dir === 'up') {
                        var movedUp = Focus.spatial('up', mgrList);
                        if (!movedUp) {
                            var fbUp = modalL.querySelector('.lock-mgr-filterbar');
                            if (fbUp) { Focus.focusFirstIn(fbUp); return; }
                            // No filter bar: land on the tools grid's BOTTOM row
                            // (Apply / Cancel), not the first button.
                            var toolsRow = modalL.querySelector('.lock-panel-tools');
                            if (toolsRow && !Focus.spatial('up', toolsRow)) {
                                Focus.focusFirstIn(toolsRow);
                            }
                        }
                        return;
                    }
                    Focus.spatial(dir, mgrList);
                    return;
                }

                // PIN keypad (both flows: pin-* verify, pinset-* set). Layout is a
                // 3-col digit grid then single stacked buttons:
                //   1 2 3      idx 0 1 2
                //   4 5 6      idx 3 4 5
                //   7 8 9      idx 6 7 8
                //     0        idx 9   (centred, full-width row)
                //    Del       idx 10  (full-width)
                //   Save/OK    idx 11  (full-width)
                //   Cancel     (footer, .modal-actions, no data-focus-key index)
                // Whole-modal spatial got this wrong: from 7/9 "down" missed the
                // centred 0 (it's diagonal) and grabbed a stacked button, and L/R
                // on the full-width stacked buttons had no neighbour so it wrapped
                // back into the digits. Handle the keypad explicitly instead.
                var kpEl = mc.closest ? mc.closest('.pin-keypad') : null;
                var kpKey = fkModal.replace(/^pin(set)?-/, '');
                var kpPrefix = fkModal.indexOf('pinset-') === 0 ? 'pinset-' : 'pin-';
                var pinKeypadEl = modalL.querySelector('.pin-keypad');
                if (kpEl && /^\d+$/.test(kpKey)) {
                    var idx = parseInt(kpKey, 10);
                    var go = function (i) {
                        var t = kpEl.querySelector('[data-focus-key="' + kpPrefix + i + '"]');
                        if (t) { Focus.focus(t); return true; }
                        return false;
                    };
                    // Digits 1-9 occupy idx 0..8 in a 3-col grid; 0=idx9, Del=10, last=11.
                    if (idx <= 8) {
                        var col = idx % 3, rowN = Math.floor(idx / 3);
                        if (dir === 'left')  { if (col > 0) go(idx - 1); return; }
                        if (dir === 'right') { if (col < 2) go(idx + 1); return; }
                        if (dir === 'up')    { if (rowN > 0) go(idx - 3); return; }
                        if (dir === 'down') {
                            // Bottom digit row (7,8,9 = idx 6,7,8) drops to 0 (idx 9);
                            // any other row moves down one digit row.
                            if (rowN < 2) { go(idx + 3); return; }
                            go(9); return;
                        }
                        return;
                    }
                    // Stacked single buttons: 0 (9) -> Del (10) -> last (11).
                    // L/R are no-ops (nothing beside them). Up/Down walk the stack;
                    // Up from 0 returns to the centre of the bottom digit row (8).
                    if (dir === 'left' || dir === 'right') return;
                    if (dir === 'up') {
                        if (idx === 9) { go(8); return; }   // 0 -> digit 8
                        go(idx - 1); return;                 // Del->0, last->Del
                    }
                    if (dir === 'down') {
                        if (idx < 11) { go(idx + 1); return; } // 0->Del->last
                        // From the last keypad button (Save/OK) down -> Cancel footer.
                        var cancelBtn = modalL.querySelector('.modal-actions .btn');
                        if (cancelBtn) Focus.focus(cancelBtn);
                        return;
                    }
                    return;
                }
                if (pinKeypadEl && mc.closest && mc.closest('.modal-actions')) {
                    // Cancel button in the footer of a PIN modal. L/R no-op; Up
                    // returns to the last keypad button; Down is a no-op (bottom).
                    if (dir === 'up') {
                        var lastKp = pinKeypadEl.querySelector('.pin-key-word:last-child')
                            || pinKeypadEl.querySelector('[data-focus-key$="-11"]');
                        if (lastKp) Focus.focus(lastKp);
                    }
                    return;
                }

                // Details-modal synopsis: if the focused element is the scrollable
                // synopsis region and it has room to scroll in this direction, scroll
                // it rather than moving focus. At the edge, fall through to spatial
                // nav so the user reaches the Play/Close buttons.
                if (mc && mc.classList && mc.classList.contains('vod-details-scroll') && (dir === 'up' || dir === 'down')) {
                    var canScroll = mc.scrollHeight > mc.clientHeight + 2;
                    var atTop = mc.scrollTop <= 0;
                    var atBottom = mc.scrollTop >= (mc.scrollHeight - mc.clientHeight - 2);
                    if (canScroll && !((dir === 'up' && atTop) || (dir === 'down' && atBottom))) {
                        var vstep = Math.max(80, Math.floor(mc.clientHeight * 0.6));
                        mc.scrollTop += (dir === 'down' ? vstep : -vstep);
                        return;
                    }
                }

                // Default modal nav: spatial. The remaining modals (PIN keypad,
                // EPG source editor, sign-in form, subtitle picker, resume /
                // Continue-Watching prompts, and plain OK/Cancel confirm dialogs)
                // are handled by geometry alone — L/R moves between side-by-side
                // buttons, U/D is a no-op for a single button row and crosses
                // container boundaries when a modal stacks controls (the case that
                // broke the resume modal). This replaced a flat moveSibling fallback
                // that walked DOM siblings only, which made U/D read as sideways
                // movement and could not move between controls in different
                // containers. Each of those modals used to have its own branch here
                // that just called Focus.spatial — all collapsed into this one
                // default. (The category / content-lock managers are the exception,
                // handled by the dedicated branch above to avoid a whole-modal scan.)
                Focus.spatial(dir, '#modalLayer');
                return;
            }
        }

        // ---- Virtual Keyboard (can appear on ANY screen, check first) ----
        if (vkVisible) {
            var c0 = Focus.current();
            if (c0 && vk.contains(c0)) {
                if (dir === 'left' || dir === 'right') {
                    var moved = Focus.moveSibling(dir === 'right' ? 'next' : 'prev');
                    if (!moved) {
                        // Wrap around — go to other end of row
                        var siblings = c0.parentNode.querySelectorAll('.focusable');
                        if (siblings.length) Focus.focus(dir === 'right' ? siblings[0] : siblings[siblings.length - 1]);
                    }
                    return;
                }
                if (dir === 'up' || dir === 'down') {
                    var row = c0.parentNode;
                    var targetRow = (dir === 'up') ? row.previousElementSibling : row.nextElementSibling;
                    while (targetRow) {
                        if (targetRow.classList && (targetRow.classList.contains('vk-row') || targetRow.classList.contains('vk-preview'))) {
                            if (targetRow.querySelector('.focusable')) break;
                        }
                        targetRow = (dir === 'up') ? targetRow.previousElementSibling : targetRow.nextElementSibling;
                    }
                    if (targetRow) {
                        var keys = targetRow.querySelectorAll('.focusable');
                        var curRect = c0.getBoundingClientRect();
                        var curCx = curRect.left + curRect.width / 2;
                        var best = null, bestDist = Infinity;
                        for (var ki = 0; ki < keys.length; ki++) {
                            var kr = keys[ki].getBoundingClientRect();
                            var kCx = kr.left + kr.width / 2;
                            var d = Math.abs(kCx - curCx);
                            if (d < bestDist) { bestDist = d; best = keys[ki]; }
                        }
                        if (best) Focus.focus(best);
                    }
                    return;
                }
                return;
            }
        }

        // ---- Modal / Action Sheet (can appear on any screen) ----
        var modal = document.getElementById('modalLayer');
        if (modal && !modal.classList.contains('hidden')) {
            var cm = Focus.current();
            if (cm && modal.contains(cm)) {
                var mwrap = modal.querySelector('.modal-wrap') || modal.querySelector('.modal-card') || modal;
                // Action buttons can wrap to multiple rows (e.g. Set Active / Edit
                // / Refresh / Delete / Cancel), so use geometric spatial nav in all
                // directions rather than flat DOM-sibling order, which made Up read
                // as Left / Down as Right and forced cycling through every button to
                // reach a wrapped Cancel.
                Focus.spatial(dir, '#modalLayer');
                return;
            }
        }

        // ---- Exit Dialog ----
        var exitDlg = document.getElementById('exitDialog');
        if (exitDlg && !exitDlg.classList.contains('hidden')) {
            var ce = Focus.current();
            if (!ce || !exitDlg.contains(ce)) {
                Focus.focusKey('exit-no');
                return;
            }
            if (dir === 'left' || dir === 'right' || dir === 'up' || dir === 'down') {
                Focus.spatial(dir, '#exitDialog');
                return;
            }
            return;
        }

        // ---- Player screen ----
        if (screen === 'player') {
            if (state.miniClosedAt && (Date.now() - state.miniClosedAt < 500)) return;
            if (state.miniOpen) {
                if (dir === 'down') { Focus.moveSibling('next'); return; }
                if (dir === 'up')   { Focus.moveSibling('prev'); return; }
                if (dir === 'left') { closeMini(); return; }
                return;
            }
            // Check if overlay is visible and focus is on an action button
            var overlay = document.getElementById('infoOverlay');
            var overlayVisible = overlay && overlay.classList.contains('show');
            var cur0 = Focus.current();
            var inOverlay = cur0 && overlay && overlay.contains(cur0);

            if (overlayVisible && inOverlay) {
                // Any interaction within the overlay resets the idle countdown,
                // so the overlay only auto-hides after the user stops navigating.
                if (Player.armOverlayHideTimer) Player.armOverlayHideTimer();
                var curEl = Focus.current();
                // Seekbar scrubbing
                if (curEl && curEl.id === 'seekTrack') {
                    if (dir === 'left') { Player.seekRelative(-30); Player.refreshOverlayContent(); return; }
                    if (dir === 'right') { Player.seekRelative(30); Player.refreshOverlayContent(); return; }
                    if (dir === 'up') {
                        var transportUp = document.getElementById('infoTransport');
                        if (transportUp && transportUp.offsetParent !== null) {
                            var pbUp = document.getElementById('infoPlayBtn');
                            if (pbUp) Focus.focus(pbUp);
                        }
                        return;
                    }
                    if (dir === 'down') {
                        var actionsDown = document.getElementById('infoActions');
                        if (actionsDown) Focus.focusFirstIn(actionsDown);
                        return;
                    }
                    return;
                }
                if (dir === 'left')  { Focus.moveSibling('prev'); return; }
                if (dir === 'right') { Focus.moveSibling('next'); return; }
                if (dir === 'up') {
                    var transport = document.getElementById('infoTransport');
                    var inTransport = transport && transport.contains(Focus.current());
                    if (!inTransport) {
                        // From aux buttons, move to transport (play button)
                        var pb = document.getElementById('infoPlayBtn');
                        if (pb && transport && transport.offsetParent !== null) {
                            Focus.focus(pb);
                            return;
                        }
                    }
                    // From transport, do nothing (already at top)
                    return;
                }
                if (dir === 'down') {
                    var transport2 = document.getElementById('infoTransport');
                    if (transport2 && transport2.contains(Focus.current())) {
                        var seekT = document.getElementById('seekTrack');
                        if (seekT && seekT.offsetParent !== null) { Focus.focus(seekT); return; }
                        var act = document.getElementById('infoActions');
                        if (act) { Focus.focusFirstIn(act); return; }
                    }
                    // On the bottom (aux) row already: Down dismisses the overlay
                    // so the user can get back to fullscreen video in one press.
                    var actionsRow = document.getElementById('infoActions');
                    if (actionsRow && actionsRow.contains(Focus.current())) {
                        Player.hideOverlay();
                        return;
                    }
                }
                return;
            }
            if (overlayVisible && !inOverlay) {
                if (dir === 'down') {
                    // Try transport buttons first (both Live TV and VOD)
                    var t = document.getElementById('infoTransport');
                    if (t && t.offsetParent !== null) {
                        var playBtn = document.getElementById('infoPlayBtn');
                        if (playBtn) { Focus.focus(playBtn); return; }
                    }
                    // Then aux buttons
                    var btns = overlay.querySelectorAll('.info-action.focusable');
                    for (var bi = 0; bi < btns.length; bi++) {
                        if (btns[bi].offsetParent !== null) { Focus.focus(btns[bi]); return; }
                    }
                }
            }
            if (Player.isVod()) {
                // VOD without overlay: left/right seek, OK shows overlay
                if (!overlayVisible) {
                    if (dir === 'left') { Player.seekRelative(-10); Player.showOverlay(); return; }
                    if (dir === 'right') { Player.seekRelative(10); Player.showOverlay(); return; }
                }
                return;
            }
            // Live TV: channel jump with up/down ONLY when the overlay is
            // closed. With the overlay open, up/down must not change channel
            // (the overlay's own focus nav handles down to enter it; up is a
            // no-op so a stray press doesn't zap the channel out from under the
            // overlay).
            if (!overlayVisible) {
                if (dir === 'up')   { jumpChannel(+1); return; }
                if (dir === 'down') { jumpChannel(-1); return; }
            }
            return;
        }

        // ---- Onboarding ----
        if (screen === 'onboarding') {
            var c = Focus.current();
            if (!c) {
                var scr = document.getElementById('onboarding');
                if (scr) Focus.focusFirstIn(scr);
                return;
            }
            // 2x2 grid: use nearest container for all directions
            var actions = document.querySelector('.onboard-actions');
            if (actions && actions.contains(c)) {
                Focus.focusNearestInContainer(actions, dir);
            } else if (c.id === 'pairLang' && dir === 'left') {
                // Language button above the QR: Left returns to the button column (data-focus-left)
                Focus.spatial('left', '#onboarding');
            }
            return;
        }

        // ---- Manual Entry (Add Playlist screen) ----
        if (screen === 'manualEntry') {
            var c2 = Focus.current();
            if (!c2) {
                var scr2 = document.getElementById('manualEntry');
                if (scr2) Focus.focusFirstIn(scr2);
                return;
            }
            // Geometry-based nav for cross-parent movement. The content-type
            // checkboxes are each wrapped in their own <label>, so they aren't
            // DOM siblings — moveSibling can't move between them. Spatial nav
            // (scoped to the form) reaches them by position in every direction.
            var wrap = document.querySelector('#manualEntry .modal-wrap');
            if (wrap) {
                var c2key = c2 && c2.getAttribute ? c2.getAttribute('data-focus-key') : null;
                var activePanel = document.querySelector('#manualEntry .tab-panel.active');

                if (dir === 'up') {
                    // Up from the Save/Cancel action buttons → the ACTIVE tab's EPG
                    // checkbox. The buttons are shared across tabs and each tab's
                    // EPG has a different key, so a static data-focus-up can't cover
                    // all tabs; resolve against the active panel. (m3u has no
                    // checkboxes — fall through to spatial.)
                    if (c2key === 'manual-save' || c2key === 'manual-cancel') {
                        var epgInPanel = activePanel ? activePanel.querySelector('.ct-check.focusable[data-focus-key$="-epg"]') : null;
                        if (epgInPanel && Focus.isVisible(epgInPanel)) { Focus.focus(epgInPanel); return; }
                    }
                    // Up from the active panel's FIRST field → the active tab
                    // button, so the user always lands back on the tab row (not a
                    // mis-aligned spatial pick).
                    if (activePanel) {
                        var firstField = activePanel.querySelector('.field.focusable');
                        if (firstField && c2 === firstField) {
                            var activeTabBtn = document.querySelector('#manualEntry [data-tab].active.focusable') ||
                                               document.querySelector('#manualEntry [data-tab].active');
                            if (activeTabBtn && Focus.isVisible(activeTabBtn)) { Focus.focus(activeTabBtn); return; }
                        }
                    }
                    Focus.focusNearestInContainer(wrap, 'up');
                    return;
                }
                if (dir === 'down') { Focus.focusNearestInContainer(wrap, 'down'); return; }
                // Left/right are spatial only. On the vertically-stacked fields
                // nothing is horizontally adjacent, so these are a no-op there
                // (previously they fell back to moveSibling, which wrongly moved
                // up/down through the field stack). On the horizontal tab row,
                // checkbox row, and button row, spatial moves between siblings.
                if (dir === 'right') { Focus.spatial('right', '#manualEntry'); return; }
                if (dir === 'left')  { Focus.spatial('left', '#manualEntry'); return; }
            }
            return;
        }

        // ---- Home screen ----
        if (screen !== 'home') return;

        var cur = Focus.current();
        if (!cur) {
            // Nothing focused — start at the active sidebar button
            var navBtn = document.querySelector('.nav-btn.active');
            if (navBtn) Focus.focus(navBtn);
            return;
        }

        // -- Sidebar navigation --
        if (isInSidebar(cur)) {
            if (dir === 'up')   { Focus.moveSibling('prev'); return; }
            if (dir === 'down') { Focus.moveSibling('next'); return; }
            if (dir === 'right') {
                var section = document.querySelector('.content-section.active');
                if (section) {
                    var sName = section.getAttribute('data-section-content');
                    if (sName === 'livetv') { var lcc = document.getElementById('liveCats'); if (lcc && lcc.classList.contains('cats-collapsed') && Focus.focusKey('livetv-cats-toggle')) return; var lc = document.getElementById('liveCatList'); if (lc && lc.querySelector('.focusable')) { Focus.focusFirstIn(lc); return; } }
                    if (sName === 'movies') { var mcats = document.getElementById('movieCatList'); if (mcats && mcats.querySelector('.focusable')) { Focus.focusFirstIn(mcats); return; } }
                    if (sName === 'series') { var scats = document.getElementById('seriesCatList'); if (scats && scats.querySelector('.focusable')) { Focus.focusFirstIn(scats); return; } }
                    // Playlists: focus first card, not buttons
                    if (sName === 'playlists') {
                        var plList = document.getElementById('plList');
                        if (plList && plList.children.length) {
                            Focus.focusFirstIn(plList) || Focus.focusFirstIn(section);
                        } else {
                            Focus.focusFirstIn(section);
                        }
                    } else {
                        Focus.focusFirstIn(section);
                    }
                }
                return;
            }
            return; // left does nothing from sidebar
        }

        // -- We're in the main content area --
        var sectionName = getActiveSection();

        // LEFT from main content: go to sidebar (active nav button)
        if (dir === 'left') {
            if (handleContentLeft(cur, sectionName)) return;
            // Fallback: go to active nav button
            var activeNav = document.querySelector('.nav-btn.active');
            if (activeNav) Focus.focus(activeNav);
            return;
        }

        // Per-section navigation. Each handler consumes the directions
        // it explicitly maps. If a handler doesn't move focus (an
        // unmapped element/direction), fall through to general spatial
        // navigation so nothing dead-ends. This is the root-cause fix:
        // any .focusable in the active section is reachable by geometry
        // without a bespoke per-element mapping.
        var before = Focus.current();
        // Handlers can set window._navHandled = true to
        // signal "I deliberately consumed this direction (even to do
        // nothing)", suppressing the spatial fallback. Without this, a
        // handler that intentionally dead-ends a direction (e.g. Down on
        // the "Next 50" page button) returns without moving focus, and the
        // fallback below then sends focus to the nearest element (the
        // category list) — overriding the intended dead-end.
        window._navHandled = false;
        switch (sectionName) {
            case 'home':      handleHomeNav(cur, dir); break;
            case 'favorites': handleFavoritesNav(cur, dir); break;
            case 'livetv':handleLiveTvNav(cur, dir); break;
            case 'movies':    handleVodNav(cur, dir, 'movieCatList', 'movieList', 'movieSearchField', 'movieCatFilter'); break;
            case 'series':    handleVodNav(cur, dir, 'seriesCatList', 'seriesList', 'seriesSearchField', 'seriesCatFilter'); break;
            case 'search':    handleSearchNav(cur, dir); break;
            case 'sports':    if (window.Sports) Sports.nav(cur, dir); window._navHandled = true; break;
            case 'catchup':   if (window.CatchupScreen) CatchupScreen.nav(cur, dir); window._navHandled = true; break;
            // case 'epg': removed — EPG integrated into livetv
            case 'playlists': handlePlaylistsNav(cur, dir); break;
            case 'settings':  handleSettingsNav(cur, dir); break;
            case 'parental':  handleSettingsNav(cur, dir); break;
            default:          Focus.moveSibling(dir === 'down' || dir === 'right' ? 'next' : 'prev');
        }
        // Universal fallback: handler left focus where it was AND didn't
        // deliberately consume the key → try geometric nearest-neighbour.
        if (Focus.current() === before && !window._navHandled) {
            Focus.spatial(dir);
        }
    }

    /* --- Left from content: check if we should stay in section or go to sidebar --- */
    function handleContentLeft(cur, sectionName) {
        // Info panel entered by OK-pinning a card: LEFT returns to the pinned card
        // (mirrors Back). Handled first so it isn't lost in the card/non-card nav
        // split below.
        if (cur && (sectionName === 'movies' || sectionName === 'series')) {
            var pInfo = document.getElementById((sectionName === 'series' ? 'series' : 'movie') + 'Info');
            if (pInfo && (cur === pInfo || pInfo.contains(cur)) &&
                window._vodPinnedCard && document.body.contains(window._vodPinnedCard)) {
                Focus.focus(window._vodPinnedCard);
                window._vodPinnedCard = null;
                return true;
            }
        }
        if (sectionName === 'home') {
            // Remove-glyph has focus: LEFT always returns to its own parent
            // card first, same as UP/RIGHT in handleHomeNav below — never
            // spatial-nav away to a different card, since the glyph is a
            // child of the card, not a sibling of it in channelRowRecent,
            // and Focus.prevVisibleSibling below would look at the WRONG
            // set of siblings (the card's other children) if reached here.
            if (cur && cur.classList && cur.classList.contains('cw-remove-glyph')) {
                var pc = cur.closest ? cur.closest('.ch-card') : null;
                if (pc) { Focus.focus(pc); return true; }
            }
            var rGrid = document.getElementById('channelRowRecent');
            var g = (rGrid && rGrid.contains(cur)) ? rGrid : null;
            if (g) {
                // Previous card on the same row; only at column 0 fall through to
                // the nav rail (return false).
                var hpe = Focus.prevVisibleSibling(cur);
                if (hpe) {
                    var hcr = cur.getBoundingClientRect();
                    var hpr = hpe.getBoundingClientRect();
                    if (Math.abs(hcr.top - hpr.top) < 20) { Focus.focus(hpe); return true; }
                }
                return false; // column 0 -> dispatch focuses the nav rail
            }
        }
        if (sectionName === 'favorites') {
            // Delegate to the shared card-grid handler (same edge rules as the
            // rest of favorites nav). It does same-row prev / column-0 -> rail.
            if (handleCardGridNav(cur, 'left', {
                gridId: 'favGrid',
                sidebarKey: 'nav-fav',
                headerSelector: '.fav-tabs',
                headerHorizontal: true
            })) return true;
        }
        if (sectionName === 'sports' && window.Sports) {
            return Sports.nav(cur, 'left');
        }
        if (sectionName === 'catchup' && window.CatchupScreen) {
            return CatchupScreen.nav(cur, 'left');
        }
        if (sectionName === 'search') {
            if (handleCardGridNav(cur, 'left', {
                gridId: 'searchResults',
                sidebarKey: 'nav-search',
                searchFieldId: 'searchField'
            })) return true;
        }
        if (sectionName === 'livetv') {
            var topMini = document.getElementById('liveTopMiniPlayer');
            if (topMini && topMini.contains(cur)) {
                var mfk = cur.getAttribute('data-focus-key') || '';
                if (mfk === 'live-top-mini-expand') { Focus.focusKey('nav-livetv'); return true; }
                if (mfk === 'live-top-mini-close') {
                    // Stop -> Expand. focusKey can silently fail (e.g. visibility
                    // check), so fall back to focusing the expand element directly,
                    // and only consume the key if focus actually moved.
                    var okFk = Focus.focusKey('live-top-mini-expand');
                    if (okFk) return true;
                    var exp = document.getElementById('liveTopMiniExpand');
                    if (exp) { Focus.focus(exp); return true; }
                    return false;
                }
                if (mfk === 'epg-time-prev') { Focus.focusKey('live-top-mini-close'); return true; }
                if (mfk === 'epg-time-now') { Focus.focusKey('epg-time-prev'); return true; }
                if (mfk === 'epg-time-next') { Focus.focusKey('epg-time-now'); return true; }
                return true;
            }
            var centerCol = document.getElementById('liveChannels');
            var catListEl = document.getElementById('liveCatList');
            var filterEl = document.getElementById('liveCatFilter');
            // Card view has no category column: delegate LEFT to the spatial card
            // handler (same pattern as movies/series). It returns true when it moved
            // within the grid/bar and false at a left edge -> sidebar. Must run
            // BEFORE the list-view branches below, which would otherwise try to
            // focus the (nonexistent) category column.
            var liveSecC = document.querySelector('section[data-section-content="livetv"]');
            if (liveSecC && liveSecC.getAttribute('data-view-mode') === 'card') {
                return handleLiveCardNav(cur, 'left');
            }
            // Manage Locks -> the category Manage button (its visual neighbour on
            // the row above the two lists). This MUST be handled here and return
            // true: 'left' from the content area calls handleContentLeft and then
            // returns immediately, so returning false does NOT fall through to
            // handleLiveTvNav's cur === contentManageBtn branch - false means
            // "go to the sidebar", which is what 470 accidentally did.
            var contentMgrBtn = document.getElementById('liveTvManageContent');
            var catsMgrBtn = document.getElementById('liveTvManageCats');
            // Categories column collapse arrow: Left from it goes to Manage (expanded) or the
            // sidebar (collapsed rail); Left from Manage Locks lands on it.
            var catsToggleL = document.getElementById('liveCatsToggle');
            var catsBoxL = document.getElementById('liveCats');
            var catsCollL = !!(catsBoxL && catsBoxL.classList.contains('cats-collapsed'));
            if (catsToggleL && cur === catsToggleL) {
                if (catsCollL) return false;
                if (catsMgrBtn) { Focus.focus(catsMgrBtn); return true; }
                return false;
            }
            if (catsToggleL && contentMgrBtn && cur === contentMgrBtn && Focus.isVisible(catsToggleL)) {
                Focus.focus(catsToggleL);
                return true;
            }
            if (contentMgrBtn && cur === contentMgrBtn && catsMgrBtn) {
                Focus.focus(catsMgrBtn);
                return true;
            }
            if (centerCol && centerCol.contains(cur) && catListEl) {
                if (catsCollL && catsToggleL) { Focus.focus(catsToggleL); return true; }
                if (cur.id === 'liveSearchField' && filterEl) { Focus.focus(filterEl); }
                else {
                    var loadedCat = catListEl.getAttribute('data-cat-loaded');
                    var target = loadedCat ? catListEl.querySelector('.panel-cat-item[data-cat="' + loadedCat + '"]') : null;
                    if (target && Focus.isVisible(target)) Focus.focus(target);
                    else Focus.focusFirstIn(catListEl);
                }
                return true;
            }
            return false;
        }
        if (sectionName === 'playlists') {
            var plFk = cur.getAttribute && cur.getAttribute('data-focus-key');
            // Content-type chips on a card: LEFT steps to the previous chip in the
            // SAME card (EPG -> Series -> Movies -> Live). Only the first chip
            // falls through to the sidebar. (Handled here because handleContentLeft
            // runs before the general playlists nav; without this, LEFT from any
            // chip returned false and jumped to the sidebar.)
            if (cur.classList && cur.classList.contains('pl-ct-check')) {
                var lcard = cur;
                while (lcard && !(lcard.classList && lcard.classList.contains('pl-card'))) lcard = lcard.parentNode;
                if (lcard) {
                    var lchips = lcard.querySelectorAll('.pl-ct-check');
                    for (var lci = 0; lci < lchips.length; lci++) {
                        if (lchips[lci] === cur) {
                            if (lci > 0) { Focus.focus(lchips[lci - 1]); return true; }
                            break; // first chip -> fall through to sidebar
                        }
                    }
                }
                return false;
            }
            // Top-row buttons: step to the button on the left rather than the
            // sidebar. Leftmost (Add Source) returns false -> sidebar.
            if (plFk === 'pl-del-all') { Focus.focusKey('pl-pair'); return true; }
            if (plFk === 'pl-pair') { Focus.focusKey('pl-add'); return true; }
            // pl-add and anything else falls through to the sidebar.
            return false;
        }
        if (sectionName === 'movies') {
            // Card view has no category column: delegate LEFT to the spatial card
            // handler. It returns true when it consumed the press (moved within the
            // grid/bar) and false at a left edge (column-0 card, or the first bar
            // button) — false here falls through to the sidebar, which is correct.
            if (isVodCardView('movies')) {
                return handleVodCardNav(cur, 'left', 'movies');
            }
            var movieInfoEl = document.getElementById('movieInfo');
            if (movieInfoEl && (cur === movieInfoEl || movieInfoEl.contains(cur))) {
                var mList = document.getElementById('movieList');
                if (mList && mList.querySelector('.focusable')) { Focus.focusFirstIn(mList); return true; }
            }
            var centerCol2 = document.getElementById('movieChannels');
            var mCats = document.getElementById('movieCatList');
            var filterEl2 = document.getElementById('movieCatFilter');
            // See the Live TV note above: this hop must be handled HERE and return
            // true, because returning false sends focus to the sidebar.
            var mContentMgrBtn = document.getElementById('movieManageContent');
            var mContentMgrBtnCats = document.getElementById('movieManageCats');
            if (mContentMgrBtn && cur === mContentMgrBtn && mContentMgrBtnCats) {
                Focus.focus(mContentMgrBtnCats);
                return true;
            }
            if (centerCol2 && centerCol2.contains(cur) && mCats) {
                if (cur.id === 'movieSearchField' && filterEl2) { Focus.focus(filterEl2); }
                else {
                    var lc = mCats.getAttribute('data-cat-loaded');
                    var t = lc ? mCats.querySelector('.panel-cat-item[data-cat="' + lc + '"]') : null;
                    if (t && Focus.isVisible(t)) Focus.focus(t);
                    else Focus.focusFirstIn(mCats);
                }
                return true;
            }
            return false;
        }
        if (sectionName === 'series') {
            if (isVodCardView('series')) {
                return handleVodCardNav(cur, 'left', 'series');
            }
            var seriesInfoEl = document.getElementById('seriesInfo');
            if (seriesInfoEl && (cur === seriesInfoEl || seriesInfoEl.contains(cur))) {
                var sList = document.getElementById('seriesList');
                if (sList && sList.querySelector('.focusable')) { Focus.focusFirstIn(sList); return true; }
            }
            var centerCol3 = document.getElementById('seriesChannels');
            var sCats = document.getElementById('seriesCatList');
            var filterEl3 = document.getElementById('seriesCatFilter');
            // See the Live TV note above: this hop must be handled HERE and return
            // true, because returning false sends focus to the sidebar.
            var sContentMgrBtn = document.getElementById('seriesManageContent');
            var sContentMgrBtnCats = document.getElementById('seriesManageCats');
            if (sContentMgrBtn && cur === sContentMgrBtn && sContentMgrBtnCats) {
                Focus.focus(sContentMgrBtnCats);
                return true;
            }
            if (centerCol3 && centerCol3.contains(cur) && sCats) {
                if (cur.id === 'seriesSearchField' && filterEl3) { Focus.focus(filterEl3); }
                else {
                    var lc2 = sCats.getAttribute('data-cat-loaded');
                    var t2 = lc2 ? sCats.querySelector('.panel-cat-item[data-cat="' + lc2 + '"]') : null;
                    if (t2 && Focus.isVisible(t2)) Focus.focus(t2);
                    else Focus.focusFirstIn(sCats);
                }
                return true;
            }
            return false;
        }
        // Default: try a genuine on-screen LEFT neighbour within the current
        // control (spatial, direction-aware). If there is none — e.g. a single
        // control, or a vertically-stacked one like the sync action buttons —
        // return false so the dispatcher sends focus to the sidebar, which is the
        // normal Left-from-content behaviour everywhere else. (This replaced a
        // Focus.moveSibling('prev') catch-all, which walked DOM sibling order
        // regardless of on-screen direction and slid a vertical stack UP on Left,
        // wrongly consuming the press and blocking the sidebar.)
        // Match either the settings control wrapper (.setting-ctl) OR the parental
        // Enable/Disable row (.parental-actions) — both are horizontal groups where
        // Left should first try the on-screen-left sibling before the sidebar.
        var parentCtl = cur;
        while (parentCtl && parentCtl.parentNode) {
            if (parentCtl.classList && (parentCtl.classList.contains('setting-ctl')
                || parentCtl.classList.contains('parental-actions'))) break;
            parentCtl = parentCtl.parentNode;
        }
        if (parentCtl && parentCtl.classList
            && (parentCtl.classList.contains('setting-ctl') || parentCtl.classList.contains('parental-actions'))
            && parentCtl.querySelectorAll('.focusable').length > 1) {
            // Move to a genuine LEFT neighbour within the group. Spatial's mid-axis
            // filter rejects a vertical stack's above/below siblings (same column),
            // so the sync stack finds nothing and returns false (Left -> sidebar). A
            // horizontal pair (parental Enable/Disable) finds its left partner:
            // Left from Disable -> Enable; Left from Enable -> none -> sidebar.
            if (Focus.focusNearestInContainer(parentCtl, 'left')) return true;
        }
        return false;
    }

    /* --- Live TV section --- */
    function handleHomeNav(cur, dir) {
        var heroPlay = document.getElementById('heroPlay');
        var recentGrid = document.getElementById('channelRowRecent');
        var recentHas = recentGrid && recentGrid.querySelector('.focusable');
        var inRecent = recentGrid && recentGrid.contains(cur);

        // Same-row left/right within a grid; no wrap to the previous/next row.
        function sameRowSibling(which) {
            var sib = (which === 'next') ? Focus.nextVisibleSibling(cur) : Focus.prevVisibleSibling(cur);
            if (!sib) return false;
            var a = cur.getBoundingClientRect();
            var b = sib.getBoundingClientRect();
            if (Math.abs(a.top - b.top) < 20) { Focus.focus(sib); return true; }
            return false;
        }

        // Nearest .ch-card strictly below srcCard within container, ignoring
        // everything else (specifically each card's own .cw-remove-glyph).
        // Needed because Focus.focusNearestInContainer searches ALL
        // .focusable descendants — with a remove-glyph now living inside
        // every Continue Watching card, that generic search found the
        // CURRENT card's own glyph as the nearest match below it (same card,
        // so physically closer than any real card in the next row), which
        // broke row-1 -> row-2 navigation entirely. Caught by actually
        // testing a multi-row Continue Watching list, not assumed.
        function findCardBelow(srcCard, container) {
            if (!srcCard) return null;
            var srcRect = srcCard.getBoundingClientRect();
            var srcMidY = srcRect.top + srcRect.height / 2;
            var srcMidX = srcRect.left + srcRect.width / 2;
            var cards = container.querySelectorAll('.ch-card');
            // Pass 1: find the nearest ROW below (minimum top among qualifying cards).
            var nearestTop = Infinity;
            for (var i = 0; i < cards.length; i++) {
                if (cards[i] === srcCard) continue;
                var r = cards[i].getBoundingClientRect();
                if (r.top < srcMidY) continue; // must be clearly below, not same row
                if (r.top < nearestTop) nearestTop = r.top;
            }
            if (nearestTop === Infinity) return null;
            // Pass 2: within that row, the column closest to the source's own
            // column — same alignment behaviour as real spatial nav, not just
            // whichever card happens to be vertically nearest overall.
            var best = null, bestDx = Infinity;
            for (var j = 0; j < cards.length; j++) {
                var r2 = cards[j].getBoundingClientRect();
                if (Math.abs(r2.top - nearestTop) > 2) continue;
                var dx = Math.abs((r2.left + r2.width / 2) - srcMidX);
                if (dx < bestDx) { bestDx = dx; best = cards[j]; }
            }
            return best;
        }

        // Remove-glyph has focus: RIGHT/UP always return to its own parent
        // card first (never spatial-nav to a different card/row — the glyph
        // is a child of the card, not a sibling of it in channelRowRecent,
        // so sameRowSibling/focusNearestInContainer below would look at the
        // wrong set of elements if reached directly from the glyph). LEFT is
        // handled the same way in handleContentLeft above.
        if (cur && cur.classList && cur.classList.contains('cw-remove-glyph') && (dir === 'right' || dir === 'up')) {
            var glyphParentCard = cur.closest ? cur.closest('.ch-card') : null;
            if (glyphParentCard) { Focus.focus(glyphParentCard); window._navHandled = true; return; }
        }

        // Left is handled earlier by handleContentLeft (same-row prev / col-0 ->
        // rail), so only right/up/down reach here.
        if (dir === 'right') {
            if (inRecent) { sameRowSibling('next'); window._navHandled = true; return; }
            return;
        }
        if (dir === 'down') {
            if (cur === heroPlay) {
                if (recentHas) { Focus.focusFirstIn(recentGrid); return; }
                return;
            }
            if (inRecent) {
                // Mirrors the established playlist-card / content-type-chip
                // pattern exactly (see handleContentLeft's 'playlists'
                // branch and the block below it): DOWN from the CARD itself
                // always goes straight to that card's own remove-glyph,
                // UNCONDITIONALLY — not just on the last row. The first version of
                // this fix only made the glyph reachable on the
                // final row, inconsistent with every other "card with an
                // interactive sub-control" pattern already in this app.
                // DOWN from the GLYPH then searches for the next real row
                // (findCardBelow below) exactly like the chip pattern's
                // "down from the LAST chip goes to the next card" — safe to
                // use a generic/explicit card search here specifically
                // because nothing else sits below the glyph within its own
                // card (it's the last thing in the card), so there is no
                // same-card competing candidate the way there was when this
                // hop was attempted directly from the card.
                if (cur.classList && cur.classList.contains('ch-card')) {
                    var ownGlyph = cur.querySelector('.cw-remove-glyph');
                    if (ownGlyph) { Focus.focus(ownGlyph); return; }
                    // No glyph on this card (shouldn't happen in Continue
                    // Watching, kept as a safe fallback): behave as before.
                    if (!Focus.focusNearestInContainer(recentGrid, 'down')) return;
                    return;
                }
                if (cur.classList && cur.classList.contains('cw-remove-glyph')) {
                    var glyphCard = cur.closest ? cur.closest('.ch-card') : null;
                    var cardBelow = glyphCard ? findCardBelow(glyphCard, recentGrid) : null;
                    if (cardBelow) { Focus.focus(cardBelow); return; }
                    return; // last row: DOWN from the glyph is a dead end, same as before
                }
                return;
            }
            return;
        }
        if (dir === 'up') {
            if (inRecent) {
                if (Focus.focusNearestInContainer(recentGrid, 'up')) return;
                if (heroPlay) { Focus.focus(heroPlay); return; }
                return;
            }
            return;
        }
    }

    /* --- Grid section (Favorites, Search results) --- */
    /* ---- Shared card-grid navigation ----
     * One handler for the screens that are "an optional header row (tabs or
     * search field) + an optional left column list + a card grid", with the same
     * edge rules everywhere. Returns true if it moved/owned the keypress.
     *
     * opts = {
     *   gridId,            // required: the card grid container id
     *   sidebarKey,        // required: nav-rail focus key for left-from-col-0
     *   headerSelector,    // optional: a header row above the grid (e.g. tabs)
     *   colListId,         // optional: a left column list (categories)
     *   colFilterId,       // optional: filter/search field tied to colList
     *   searchFieldId,     // optional: search field above the grid (in grid col)
     *   reentryCatAttr     // optional: data-attr on colList marking the loaded cat
     * }
     *
     * Edge rules (written once):
     *  - grid left/right: same-row prev/next sibling only (|top-top|<20), no wrap;
     *    left from column 0 -> colList (if present) else sidebarKey; a same-row
     *    dead-end sets _navHandled so the geometric fallback can't re-wrap.
     *  - grid up: geometry; off the top row -> header (or search/colFilter) else
     *    sidebar/stay.
     *  - grid down: geometry.
     *  - header left/right: sibling; header down -> grid.
     */
    function handleCardGridNav(cur, dir, opts) {
        var grid = document.getElementById(opts.gridId);
        if (!grid) return false;
        var header = opts.headerSelector ? document.querySelector(opts.headerSelector) : null;
        var colList = opts.colListId ? document.getElementById(opts.colListId) : null;
        var inGrid = grid.contains(cur);
        var inHeader = header && header.contains(cur);

        function sameRowSibling(which) {
            var sib = (which === 'next') ? Focus.nextVisibleSibling(cur) : Focus.prevVisibleSibling(cur);
            if (!sib) return false;
            var a = cur.getBoundingClientRect();
            var b = sib.getBoundingClientRect();
            if (Math.abs(a.top - b.top) < 20) { Focus.focus(sib); return true; }
            return false;
        }

        if (inHeader) {
            // Header row (e.g. tabs). Use spatial nav scoped to the header: it
            // finds the adjacent tab by geometry and returns false at the ends
            // (so LEFT off the first tab falls through to the nav rail). By default
            // left is not consumed unless the section opts into horizontal header
            // nav; right moves along the tabs unless explicitly disabled.
            if (dir === 'left') {
                if (opts.headerHorizontal && header && Focus.spatial('left', header)) return true;
                return false;
            }
            if (dir === 'right') {
                if (opts.headerHorizontal !== false && header && Focus.spatial('right', header)) return true;
                return false;
            }
            if (dir === 'down') { Focus.focusFirstIn(grid); return true; }
            if (dir === 'up') { return false; } // fall through to spatial fallback
            return true;
        }

        if (inGrid) {
            if (dir === 'right') {
                sameRowSibling('next');
                window._navHandled = true; // deliberate dead-end at last column
                return true;
            }
            if (dir === 'left') {
                if (sameRowSibling('prev')) return true;
                // Column 0: go to the left column list if present, else the rail.
                if (colList) {
                    var loaded = opts.reentryCatAttr ? colList.getAttribute(opts.reentryCatAttr) : null;
                    var target = loaded ? colList.querySelector('.panel-cat-item[data-cat="' + loaded + '"]') : null;
                    if (target && Focus.isVisible(target)) Focus.focus(target);
                    else Focus.focusFirstIn(colList);
                } else {
                    Focus.focusKey(opts.sidebarKey);
                }
                window._navHandled = true;
                return true;
            }
            if (dir === 'down') { Focus.focusNearestInContainer(grid, 'down'); return true; }
            if (dir === 'up') {
                var moved = Focus.focusNearestInContainer(grid, 'up');
                if (moved) return true;
                // Off the top row: header, else a search field, else stay.
                if (header) { Focus.focusFirstIn(header); return true; }
                if (opts.searchFieldId) {
                    var sf = document.getElementById(opts.searchFieldId);
                    if (sf) { Focus.focus(sf); return true; }
                }
                return true;
            }
        }
        return false;
    }

    function handleFavoritesNav(cur, dir) {
        // Migrated to the shared card-grid handler: header = the .fav-tabs row,
        // grid = #favGrid, left-from-column-0 -> nav-fav rail. (No left column.)
        // If it doesn't consume the key, leave focus untouched so the dispatch's
        // geometric spatial fallback runs (matches the old tabs-up behaviour).
        handleCardGridNav(cur, dir, {
            gridId: 'favGrid',
            sidebarKey: 'nav-fav',
            headerSelector: '.fav-tabs'
        });
    }

    /* --- Categories section --- */
    function handleLiveCardNav(cur, dir) {
        var bar = document.getElementById('liveCardBar');
        var gridEl = document.getElementById('liveChList');
        var topMini = document.getElementById('liveTopMiniPlayer');
        var topMiniExpand = document.getElementById('liveTopMiniExpand');
        var inBar = bar && bar.contains(cur);
        var inGrid = gridEl && gridEl.contains(cur);
        var inTopMini = topMini && topMini.contains(cur);

        // Top section (kept in full for card view): mini player expand/close plus
        // the Earlier/Now/Later EPG time controls, same left/right row as List view.
        // The only card-view difference is DOWN, which enters the action bar (there
        // is no manager header or search row below the mini player here).
        if (inTopMini) {
            var mfk = cur.getAttribute('data-focus-key') || '';
            if (dir === 'down') {
                if (bar && bar.querySelector('.focusable')) {
                    if (!Focus.spatial('down', bar)) Focus.focusFirstIn(bar);
                    window._navHandled = true; return true;
                }
                if (gridEl && gridEl.querySelector('.focusable')) { Focus.focusFirstIn(gridEl); window._navHandled = true; return true; }
                return true;
            }
            if (dir === 'left') {
                if (mfk === 'live-top-mini-expand') { Focus.focusKey('nav-livetv'); window._navHandled = true; return true; }
                if (mfk === 'live-top-mini-close') { Focus.focusKey('live-top-mini-expand'); window._navHandled = true; return true; }
                if (mfk === 'epg-time-prev') { Focus.focusKey('live-top-mini-close'); window._navHandled = true; return true; }
                if (mfk === 'epg-time-now') { Focus.focusKey('epg-time-prev'); window._navHandled = true; return true; }
                if (mfk === 'epg-time-next') { Focus.focusKey('epg-time-now'); window._navHandled = true; return true; }
                window._navHandled = true; return true;
            }
            if (dir === 'right') {
                if (mfk === 'live-top-mini-expand') { Focus.focusKey('live-top-mini-close'); window._navHandled = true; return true; }
                if (mfk === 'live-top-mini-close') { Focus.focusKey('epg-time-prev'); window._navHandled = true; return true; }
                if (mfk === 'epg-time-prev') { Focus.focusKey('epg-time-now'); window._navHandled = true; return true; }
                if (mfk === 'epg-time-now') { Focus.focusKey('epg-time-next'); window._navHandled = true; return true; }
                window._navHandled = true; return true;
            }
            if (dir === 'up') {
                // Up from the EPG time controls returns to the mini expand button;
                // from the mini controls themselves there's nothing above.
                if (mfk === 'epg-time-prev' || mfk === 'epg-time-now' || mfk === 'epg-time-next') {
                    if (Focus.focusKey('live-top-mini-expand')) { window._navHandled = true; return true; }
                }
                window._navHandled = true; return true;
            }
            return true;
        }

        if (inBar) {
            if (dir === 'left') {
                if (Focus.spatial('left', bar)) { window._navHandled = true; return true; }
                return false; // sidebar
            }
            if (dir === 'right') { Focus.spatial('right', bar); window._navHandled = true; return true; }
            if (dir === 'up') {
                // Up from the bar goes to the mini player expand button.
                if (topMiniExpand && !topMini.classList.contains('hidden')) { Focus.focus(topMiniExpand); }
                window._navHandled = true; return true;
            }
            if (dir === 'down') {
                if (gridEl && gridEl.querySelector('.focusable')) {
                    if (!Focus.spatial('down', gridEl)) Focus.focusFirstIn(gridEl);
                }
                window._navHandled = true; return true;
            }
            return true;
        }

        var alphaEl = gridEl && gridEl.parentNode ? gridEl.parentNode.querySelector('.alpha-bar') : null;
        var inAlpha = alphaEl && alphaEl.contains(cur);

        if (inAlpha) {
            if (dir === 'up') { Focus.spatial('up', alphaEl); window._navHandled = true; return true; }
            if (dir === 'down') { Focus.spatial('down', alphaEl); window._navHandled = true; return true; }
            if (dir === 'left') {
                if (!(gridEl && Focus.focusNearestInContainer(gridEl, 'left'))) {
                    if (gridEl && gridEl.querySelector('.focusable')) Focus.focusFirstIn(gridEl);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'right') { window._navHandled = true; return true; } // dead-end (rightmost)
            return true;
        }

        if (inGrid) {
            if (dir === 'up') {
                // Spatial up within the grid; off the top row, go to the action bar.
                if (!Focus.spatial('up', gridEl)) {
                    if (bar) Focus.spatial('up', bar) || Focus.focusFirstIn(bar);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'down') { Focus.spatial('down', gridEl); window._navHandled = true; return true; }
            if (dir === 'left') {
                if (Focus.spatial('left', gridEl)) { window._navHandled = true; return true; }
                return false; // sidebar (no category column)
            }
            if (dir === 'right') {
                // Move right within the grid only if a card sits on the same row;
                // otherwise land on the alphabetical jump bar (if present).
                if (gridRightSameRow(gridEl)) { window._navHandled = true; return true; }
                if (alphaEl && alphaEl.querySelector('.focusable')) {
                    if (!Focus.focusNearestInContainer(alphaEl, 'right')) Focus.focusFirstIn(alphaEl);
                    window._navHandled = true; return true;
                }
                window._navHandled = true; return true;
            }
            return true;
        }

        return false; // not in a card-view zone — let the caller fall through
    }

    function handleLiveTvNav(cur, dir) {
        // Card view has its own nav (action bar over a channel grid, mini player
        // above). Route there first; fall through only if focus is somewhere the
        // card handler doesn't own.
        var liveSec = document.querySelector('section[data-section-content="livetv"]');
        if (liveSec && liveSec.getAttribute('data-view-mode') === 'card') {
            if (handleLiveCardNav(cur, dir)) return;
        }
        var catListEl = document.getElementById('liveCatList');
        var chListEl = document.getElementById('liveChList');
        var searchField = document.getElementById('liveSearchField');
        var catFilter = document.getElementById('liveCatFilter');
        var manageBtn = document.getElementById('liveTvManageCats');
        var contentManageBtn = document.getElementById('liveTvManageContent');
        var topMini = document.getElementById('liveTopMiniPlayer');
        var topMiniExpand = document.getElementById('liveTopMiniExpand');
        var topMiniVisible = topMini && !topMini.classList.contains('hidden');
        var inTopMini = topMini && topMini.contains(cur);

        // Mini player + EPG control-row navigation: deterministic row, no wrap.
        if (inTopMini) {
            var mfk = cur.getAttribute('data-focus-key') || '';
            if (dir === 'left') {
                if (mfk === 'live-top-mini-expand') { Focus.focusKey('nav-livetv'); return; }
                if (mfk === 'live-top-mini-close') { Focus.focusKey('live-top-mini-expand'); return; }
                if (mfk === 'epg-time-prev') { Focus.focusKey('live-top-mini-close'); return; }
                if (mfk === 'epg-time-now') { Focus.focusKey('epg-time-prev'); return; }
                if (mfk === 'epg-time-next') { Focus.focusKey('epg-time-now'); return; }
                return;
            }
            if (dir === 'right') {
                if (mfk === 'live-top-mini-expand') { Focus.focusKey('live-top-mini-close'); return; }
                if (mfk === 'live-top-mini-close') { Focus.focusKey('epg-time-prev'); return; }
                if (mfk === 'epg-time-prev') { Focus.focusKey('epg-time-now'); return; }
                if (mfk === 'epg-time-now') { Focus.focusKey('epg-time-next'); return; }
                if (mfk === 'epg-time-next') { return; }
                return;
            }
            if (dir === 'down') {
                if (mfk === 'live-top-mini-expand' || mfk === 'live-top-mini-close') {
                    // Down from the mini player controls
                    // goes to Manage Locks (was Manage Categories).
                    if (contentManageBtn) { Focus.focus(contentManageBtn); return; }
                    if (manageBtn) { Focus.focus(manageBtn); return; }
                    if (catFilter) { Focus.focus(catFilter); return; }
                    return;
                }
                if (searchField) { Focus.focus(searchField); return; }
                if (chListEl && chListEl.querySelector('.focusable')) { Focus.focusFirstIn(chListEl); return; }
                return;
            }
            if (dir === 'up') {
                // Up from the mini player expand/stop buttons goes to the EPG time
                // control row, landing on the earliest (leftmost) button
                // epg-time-prev. Without this branch the press fell through to the
                // bare return below and default spatial nav sent focus down into
                // the channel content rows instead. The epg-time-* keys sit in the
                // same #liveTopMini container, so they are only reachable while the
                // row exists — guard on their presence and otherwise stay put.
                if (mfk === 'live-top-mini-expand' || mfk === 'live-top-mini-close') {
                    if (Focus.focusKey('epg-time-prev')) { return; }
                    return;
                }
                // Up from the EPG time controls themselves: nothing above them in
                // this row, so hold focus rather than falling through.
                if (mfk === 'epg-time-prev' || mfk === 'epg-time-now' || mfk === 'epg-time-next') {
                    return;
                }
                return;
            }
            return;
        }

        // Categories column collapse arrow (Left is handled in handleContentLeft).
        var catsToggle = document.getElementById('liveCatsToggle');
        var catsBox = document.getElementById('liveCats');
        var catsCollapsedNav = !!(catsBox && catsBox.classList.contains('cats-collapsed'));
        if (catsToggle && cur === catsToggle) {
            window._navHandled = true;
            if (dir === 'right') { if (contentManageBtn) Focus.focus(contentManageBtn); else if (searchField) Focus.focus(searchField); return; }
            if (dir === 'up') { if (topMiniVisible && topMiniExpand) Focus.focus(topMiniExpand); return; }
            if (dir === 'down') { if (!catsCollapsedNav && catFilter) Focus.focus(catFilter); return; }
            return;
        }

        // Category manager button in Live TV header
        if (cur === manageBtn) {
            if (dir === 'down' && catFilter) { Focus.focus(catFilter); return; }
            if (dir === 'up' && topMiniVisible && topMiniExpand) { Focus.focus(topMiniExpand); return; }
            if (dir === 'left') { Focus.focusKey('nav-livetv'); return; }
            if (dir === 'right') { if (catsToggle && Focus.isVisible(catsToggle)) Focus.focus(catsToggle); else if (contentManageBtn) Focus.focus(contentManageBtn); else if (searchField) Focus.focus(searchField); return; }
            return;
        }

        if (cur === contentManageBtn) {
            // NOTE: 'left' is NOT handled here. handleContentLeft() runs first for
            // left presses and now performs the Manage Locks -> Manage hop itself
            // (it must, because 'left' returns immediately after that call). A
            // left branch here would be dead code.
            if (dir === 'down' && searchField) { Focus.focus(searchField); return; }
            // Up from Manage Locks goes to the mini player
            // expand button (was epg-time-prev).
            if (dir === 'up') {
                if (topMiniVisible && topMiniExpand) { Focus.focus(topMiniExpand); return; }
                Focus.focusKey('epg-time-prev'); return;
            }
            if (dir === 'right') { return; }
            return;
        }

        // Up from search/filter goes to the nearest logical header control.
        if (cur === searchField && dir === 'up') {
            if (contentManageBtn) { Focus.focus(contentManageBtn); return; }
            if (topMiniVisible) { Focus.focusKey('epg-time-prev'); return; }
            return;
        }
        if (cur === catFilter && dir === 'up') {
            if (manageBtn) { Focus.focus(manageBtn); return; }
            if (topMiniVisible && topMiniExpand) { Focus.focus(topMiniExpand); return; }
            return;
        }

        // Category filter field
        if (cur === catFilter) {
            if (dir === 'down' && catListEl) { Focus.focusFirstIn(catListEl); return; }
            if (dir === 'right' && searchField) { Focus.focus(searchField); return; }
            return;
        }

        // Search field at top of channel list
        if (cur === searchField) {
            if (dir === 'down' && chListEl) { Focus.focusFirstIn(chListEl); return; }
            if (dir === 'left' && catsCollapsedNav && catsToggle) { Focus.focus(catsToggle); return; }
            if (dir === 'left' && catFilter) { Focus.focus(catFilter); return; }
            if (dir === 'left' && catListEl) { Focus.focusFirstIn(catListEl); return; }
            if (dir === 'right') { window._navHandled = true; return; } // no-op: search field is rightmost; don't drift to EPG time controls
            return;
        }

        var inCats = catListEl && catListEl.contains(cur);
        // EPG time controls navigation
        var epgControls = document.getElementById('liveEpgControlsSide');
        if (epgControls && epgControls.contains(cur)) {
            var fk = cur.getAttribute('data-focus-key') || '';
            if (dir === 'left') {
                if (fk === 'epg-time-next') { Focus.focusKey('epg-time-now'); return; }
                if (fk === 'epg-time-now') { Focus.focusKey('epg-time-prev'); return; }
                if (fk === 'epg-time-prev') { Focus.focusKey('live-top-mini-close'); return; }
                return;
            }
            if (dir === 'right') {
                if (fk === 'epg-time-prev') { Focus.focusKey('epg-time-now'); return; }
                if (fk === 'epg-time-now') { Focus.focusKey('epg-time-next'); return; }
                if (fk === 'epg-time-next') { return; }
                return;
            }
            if (dir === 'down') {
                if (contentManageBtn) { Focus.focus(contentManageBtn); return; }
                if (searchField) { Focus.focus(searchField); return; }
                if (chListEl && chListEl.querySelector('.focusable')) { Focus.focusFirstIn(chListEl); return; }
                return;
            }
            if (dir === 'up') {
                var topExpand = document.getElementById('liveTopMiniExpand');
                if (topExpand) { Focus.focus(topExpand); return; }
            }
            return;
        }

        var inChannels = chListEl && chListEl.contains(cur);

        if (!inCats && !inChannels) {
            if (catListEl) {
                var fc = catListEl.querySelector('.focused');
                if (fc) { cur = fc; inCats = true; }
            }
            if (!inCats && chListEl) {
                var fc2 = chListEl.querySelector('.focused');
                if (fc2) { cur = fc2; inChannels = true; }
            }
            if (!inCats && !inChannels) {
                if (catListEl) Focus.focusFirstIn(catListEl);
                return;
            }
        }

        if (inCats) {
            if (dir === 'up') {
                var moved = Focus.moveSibling('prev');
                if (!moved && catFilter) { Focus.focus(catFilter); }
                window._navHandled = true;
                return;
            }
            if (dir === 'down') { Focus.moveSibling('next'); window._navHandled = true; return; }
            if (dir === 'right') {
                if (chListEl && chListEl.querySelector('.focusable')) { Focus.focusFirstIn(chListEl); return; }
                if (searchField && Focus.isVisible(searchField)) { Focus.focus(searchField); }
                return;
            }
            return;
        }

        if (inChannels) {
            var chFk = cur.getAttribute ? (cur.getAttribute('data-focus-key') || '') : '';
            if (chFk === 'live-next' && dir === 'down') { window._navHandled = true; return; }
            if (chFk === 'live-prev' && dir === 'up') { var timePrev = document.getElementById('epgTimePrevSide'); if (timePrev) { Focus.focus(timePrev); return; } return; }
            if (chFk === 'live-prev' && dir === 'down') { var firstPageRow = chListEl ? chListEl.querySelector('.live-epg-row.focusable') : null; if (firstPageRow) { Focus.focus(firstPageRow); return; } }
            if (chFk === 'live-next' && dir === 'up') { var rows = chListEl ? chListEl.querySelectorAll('.live-epg-row.focusable') : []; if (rows && rows.length) { Focus.focus(rows[rows.length - 1]); return; } }
            if (dir === 'up') {
                var moved = Focus.moveSibling('prev');
                if (!moved && searchField && Focus.isVisible(searchField)) {
                    Focus.focus(searchField);
                }
                // Dead-end (or handled): consume the key so the universal
                // spatial fallback in handleArrow doesn't jump to a category.
                window._navHandled = true;
                return;
            }
            if (dir === 'down') {
                Focus.moveSibling('next');
                // Whether or not there was a next row, consume the key — a dead
                // end at the last row must NOT fall through to the spatial
                // fallback (which would jump focus to a category by geometry).
                window._navHandled = true;
                return;
            }
            if (dir === 'left') {
                if (catListEl) {
                    var loadedCat = catListEl.getAttribute('data-cat-loaded');
                    var target = loadedCat ? catListEl.querySelector('.panel-cat-item[data-cat="' + loadedCat + '"]') : null;
                    if (target && Focus.isVisible(target)) {
                        Focus.focus(target);
                    } else {
                        Focus.focusFirstIn(catListEl);
                    }
                }
                return;
            }
            if (dir === 'right') { window._navHandled = true; return; } // No action on right in channel list
            return;
        }
    }

    /* --- VOD (Movies / Series) navigation --- */
    /* Is the given Movies/Series section currently in card view? */
    function isVodCardView(section) {
        var sec = document.querySelector('section[data-section-content="' + section + '"]');
        return !!(sec && sec.getAttribute('data-view-mode') === 'card');
    }

    /* Unified, fully-spatial D-pad nav for the Movies/Series CARD view.
     *
     * Card view has THREE focusable zones and NO category column (the category
     * pane is display:none in card mode — the category filter is a button in the
     * action bar): the action bar (#..CardBar), the poster grid (#..List holding
     * .vod-grid), and the info rail (#..Info). Movement is spatial everywhere
     * (Focus.spatial == directional-projection scoring), replacing the old
     * moveSibling/prevVisibleSibling walks. Only the zone-boundary hops are
     * explicit; within a zone geometry decides.
     *
     *   bar:  left  -> spatial in bar; off the first button -> sidebar (nav-*)
     *         right -> spatial in bar; off the last -> dead-end
     *         down  -> grid (spatial nearest below the current bar button)
     *         up    -> dead-end
     *   grid: up    -> spatial up; off the top row -> action bar
     *         down  -> spatial down (dead-end at the last row)
     *         left  -> spatial left; at column 0 -> sidebar (no category column)
     *         right -> spatial right; off the last column -> info rail if it
     *                  scrolls, else dead-end
     *   info: up/down scroll the synopsis; left -> grid
     *
     * Returns true if it consumed the press (caller should stop). Sets
     * _navHandled so the dispatcher's spatial fallback can't re-wrap a
     * deliberate dead-end. */
    function gridRightSameRow(gridEl) {
        // Try a spatial right move, but only keep it if it lands on the SAME row as
        // the current card. Off-axis spatial matches (a card on another row) would
        // otherwise swallow the keypress and block reaching the alpha bar from a
        // short last row (e.g. a single card at column 0). Returns true if it moved
        // to a same-row card; false if the caller should fall through (to the bar).
        var curEl = Focus.current && Focus.current();
        if (!curEl || !gridEl) return false;
        var beforeTop = curEl.getBoundingClientRect().top;
        if (!Focus.spatial('right', gridEl)) return false;
        var afterEl = Focus.current && Focus.current();
        if (!afterEl) return false;
        var afterTop = afterEl.getBoundingClientRect().top;
        if (Math.abs(afterTop - beforeTop) <= 8) return true; // same row: accept
        // Landed on a different row — undo by restoring focus, report "no move".
        Focus.focus(curEl);
        return false;
    }

    function handleVodCardNav(cur, dir, section) {
        var bar = document.getElementById((section === 'series' ? 'series' : 'movie') + 'CardBar');
        var gridEl = document.getElementById((section === 'series' ? 'series' : 'movie') + 'List');
        var infoEl = document.getElementById((section === 'series' ? 'series' : 'movie') + 'Info');
        var alphaEl = gridEl && gridEl.parentNode ? gridEl.parentNode.querySelector('.alpha-bar') : null;
        var navKey = (section === 'series') ? 'nav-series' : 'nav-movies';
        var inBar = bar && bar.contains(cur);
        var inGrid = gridEl && gridEl.contains(cur);
        var inInfo = infoEl && (cur === infoEl || infoEl.contains(cur));
        var inAlpha = alphaEl && alphaEl.contains(cur);

        if (inAlpha) {
            if (dir === 'up') { Focus.spatial('up', alphaEl); window._navHandled = true; return true; }
            if (dir === 'down') { Focus.spatial('down', alphaEl); window._navHandled = true; return true; }
            if (dir === 'left') {
                // Back into the grid, nearest card on the anchor's row.
                if (!(gridEl && Focus.focusNearestInContainer(gridEl, 'left'))) {
                    if (gridEl && gridEl.querySelector('.focusable')) Focus.focusFirstIn(gridEl);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'right') {
                // Continue to the info panel if it has scrollable content.
                if (infoEl) {
                    var abody = infoEl.querySelector('.vod-info-body');
                    if (abody && abody.scrollHeight > abody.clientHeight + 4) { abody.scrollTop = 0; Focus.focus(infoEl); }
                }
                window._navHandled = true; return true;
            }
            return true;
        }

        if (inBar) {
            if (dir === 'left') {
                // Spatial left within the bar; nothing to the left of the first
                // button, so fall through to the sidebar (return false).
                if (Focus.spatial('left', bar)) { window._navHandled = true; return true; }
                return false;
            }
            if (dir === 'right') {
                Focus.spatial('right', bar); // dead-ends by geometry at the last button
                window._navHandled = true; return true;
            }
            if (dir === 'down') {
                // Into the grid: pick the card nearest below the current bar button
                // (spatial, so it lands under the button's column, not always col 0).
                if (gridEl && gridEl.querySelector('.focusable')) {
                    if (!Focus.spatial('down', gridEl)) Focus.focusFirstIn(gridEl);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'up') { window._navHandled = true; return true; }
            return true;
        }

        if (inGrid) {
            if (dir === 'up') {
                // Spatial up within the grid; off the top row, go to the action bar.
                if (!Focus.spatial('up', gridEl)) {
                    if (bar) Focus.spatial('up', bar) || Focus.focusFirstIn(bar);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'down') {
                Focus.spatial('down', gridEl); // dead-ends by geometry at the last row
                window._navHandled = true; return true;
            }
            if (dir === 'left') {
                // Spatial left within the grid; at column 0 nothing is to the left,
                // so fall through to the sidebar (there is no category column).
                if (Focus.spatial('left', gridEl)) { window._navHandled = true; return true; }
                return false;
            }
            if (dir === 'right') {
                // Move right within the grid only if a card sits on the same row;
                // otherwise (e.g. a lone card on a short last row) go to the
                // alphabetical jump bar, then the info rail.
                if (gridRightSameRow(gridEl)) { window._navHandled = true; return true; }
                if (alphaEl && alphaEl.querySelector('.focusable')) {
                    if (!Focus.focusNearestInContainer(alphaEl, 'right')) Focus.focusFirstIn(alphaEl);
                    window._navHandled = true; return true;
                }
                if (infoEl) {
                    var body2 = infoEl.querySelector('.vod-info-body');
                    if (body2 && body2.scrollHeight > body2.clientHeight + 4) { body2.scrollTop = 0; Focus.focus(infoEl); }
                }
                window._navHandled = true; return true;
            }
            return true;
        }

        // Play button in the info panel: down -> synopsis (panel body, scrollable),
        // up -> stays, left/back handled globally (return to card).
        var playBtn = document.getElementById((section === 'series' ? 'series' : 'movie') + 'InfoPlay');
        if (playBtn && cur === playBtn) {
            if (dir === 'down' && infoEl) { Focus.focus(infoEl); if (typeof updateVodScrollHint === 'function') updateVodScrollHint(infoEl); window._navHandled = true; return true; }
            if (dir === 'up') { window._navHandled = true; return true; }
            if (dir === 'right') { window._navHandled = true; return true; }
            // left falls through to the global pinned-card return.
            return false;
        }

        if (inInfo) {
            var scrollEl2 = infoEl.querySelector('.vod-info-body') || infoEl;
            if (dir === 'up' || dir === 'down') {
                var atTopNow = scrollEl2.scrollTop <= 2;
                // At the top, UP returns to the Play button rather than no-op.
                if (dir === 'up' && atTopNow && playBtn) {
                    Focus.focus(playBtn); window._navHandled = true; return true;
                }
                var step2 = Math.max(80, Math.floor(scrollEl2.clientHeight * 0.6));
                scrollEl2.scrollTop += (dir === 'down' ? step2 : -step2);
                if (typeof updateVodScrollHint === 'function') updateVodScrollHint(infoEl);
                window._navHandled = true; return true;
            }
            if (dir === 'left') {
                // Return to the exact card that was pinned via OK, so focus lands
                // where the user started. Fall back to nearest/jump-bar otherwise.
                if (window._vodPinnedCard && document.body.contains(window._vodPinnedCard)) {
                    Focus.focus(window._vodPinnedCard);
                    window._vodPinnedCard = null;
                    window._navHandled = true; return true;
                }
                // Land on the jump bar if present (it sits between panel and grid),
                // else the card adjacent to the info panel.
                if (alphaEl && alphaEl.querySelector('.focusable')) {
                    if (!Focus.focusNearestInContainer(alphaEl, 'left')) Focus.focusFirstIn(alphaEl);
                    window._navHandled = true; return true;
                }
                if (!(gridEl && Focus.focusNearestInContainer(gridEl, 'left'))) {
                    if (gridEl && gridEl.querySelector('.focusable')) Focus.focusFirstIn(gridEl);
                }
                window._navHandled = true; return true;
            }
            if (dir === 'right') { window._navHandled = true; return true; }
            return true;
        }

        return false; // focus somewhere unexpected — let the caller fall through
    }

    function handleVodNav(cur, dir, catListId, itemListId, searchFieldId, catFilterId) {
        var catListEl = document.getElementById(catListId);
        var itemListEl = document.getElementById(itemListId);
        var searchField = document.getElementById(searchFieldId);
        var catFilter = catFilterId ? document.getElementById(catFilterId) : null;

        // ===== Card view: action bar over a poster grid (+ info rail) =====
        // Fully spatial, no category column. Left is normally intercepted by
        // handleContentLeft before this runs; the delegate handles up/down/right
        // (and left too, harmlessly, for completeness).
        var section = (catListId === 'seriesCatList') ? 'series' : 'movies';
        if (isVodCardView(section)) {
            if (handleVodCardNav(cur, dir, section)) return;
            // Fall through only if focus is somewhere unexpected in card view.
        }

        var manageBtn = catListId === 'movieCatList' ? document.getElementById('movieManageCats') :
                        catListId === 'seriesCatList' ? document.getElementById('seriesManageCats') : null;
        var contentManageBtn = catListId === 'movieCatList' ? document.getElementById('movieManageContent') :
                        catListId === 'seriesCatList' ? document.getElementById('seriesManageContent') : null;

        if (cur === manageBtn) {
            if (dir === 'down' && catFilter) { Focus.focus(catFilter); return; }
            if (dir === 'right') { if (contentManageBtn) Focus.focus(contentManageBtn); else if (searchField) Focus.focus(searchField); return; }
            return;
        }
        if (cur === contentManageBtn) {
            // NOTE: 'left' is NOT handled here. handleContentLeft() runs first for
            // left presses and now performs the Manage Locks -> Manage hop itself
            // (it must, because 'left' returns immediately after that call). A
            // left branch here would be dead code.
            if (dir === 'down' && searchField) { Focus.focus(searchField); return; }
            if (dir === 'up') { window._navHandled = true; return; }
            if (dir === 'right') { return; }
            return;
        }

        // Category filter
        if (cur === catFilter) {
            if (dir === 'up' && manageBtn) { Focus.focus(manageBtn); return; }
            if (dir === 'down' && catListEl) { Focus.focusFirstIn(catListEl); return; }
            if (dir === 'right' && searchField) { Focus.focus(searchField); return; }
            return;
        }

        if (cur === searchField) {
            if (dir === 'up' && contentManageBtn) { Focus.focus(contentManageBtn); return; }
            if (dir === 'down' && itemListEl) { Focus.focusFirstIn(itemListEl); return; }
            if (dir === 'left' && catFilter) { Focus.focus(catFilter); return; }
            if (dir === 'left' && catListEl) { Focus.focusFirstIn(catListEl); return; }
            return;
        }

        var inCats = catListEl && catListEl.contains(cur);
        var inItems = itemListEl && itemListEl.contains(cur);
        var infoEl = catListId === 'movieCatList' ? document.getElementById('movieInfo') :
                     catListId === 'seriesCatList' ? document.getElementById('seriesInfo') : null;

        // Info panel focused: up/down scroll the SYNOPSIS (the inner .vod-info-body
        // that scrolls beneath the pinned poster — not .panel-info itself, which no
        // longer scrolls). Left returns to the movie/series ITEMS column (not the
        // side menu). Right is a dead-end. The whole panel is the focus target; we
        // scroll its inner body.
        if (infoEl && (cur === infoEl || infoEl.contains(cur))) {
            var scrollEl = infoEl.querySelector('.vod-info-body') || infoEl;
            if (dir === 'up' || dir === 'down') {
                var step = Math.max(80, Math.floor(scrollEl.clientHeight * 0.6));
                scrollEl.scrollTop += (dir === 'down' ? step : -step);
                if (typeof updateVodScrollHint === 'function') updateVodScrollHint(infoEl);
                window._navHandled = true;
                return;
            }
            // NOTE: 'left' is not handled here — handleContentLeft() intercepts left
            // from the main content area BEFORE this switch runs and sends focus to
            // the items column. Right is a dead-end.
            window._navHandled = true;
            return;
        }

        if (inCats) {
            if (dir === 'up') {
                var moved = Focus.moveSibling('prev');
                if (!moved && catFilter) { Focus.focus(catFilter); }
                window._navHandled = true;
                return;
            }
            if (dir === 'down') { Focus.moveSibling('next'); window._navHandled = true; return; }
            if (dir === 'right') {
                if (itemListEl && itemListEl.querySelector('.focusable')) { Focus.focusFirstIn(itemListEl); return; }
                if (searchField && Focus.isVisible(searchField)) { Focus.focus(searchField); return; }
            }
            return;
        }

        if (inItems) {
            if (dir === 'up') {
                var moved = Focus.moveSibling('prev');
                if (!moved && searchField) Focus.focus(searchField);
                // Consume the key so a dead-end at the first row can't fall
                // through to the spatial fallback (which would jump to a
                // category by geometry). Mirrors handleLiveTvNav.
                window._navHandled = true;
                return;
            }
            if (dir === 'down') {
                Focus.moveSibling('next');
                // Dead-end at the last row: consume the key whether or not a next
                // row existed, so it does NOT fall through to the spatial
                // fallback and jump back to a category. Mirrors handleLiveTvNav.
                window._navHandled = true;
                return;
            }
            if (dir === 'left') {
                if (catListEl) {
                    var loadedCat = catListEl.getAttribute('data-cat-loaded');
                    var target = loadedCat ? catListEl.querySelector('.panel-cat-item[data-cat="' + loadedCat + '"]') : null;
                    if (target && Focus.isVisible(target)) Focus.focus(target);
                    else Focus.focusFirstIn(catListEl);
                }
                return;
            }
            if (dir === 'right') {
                // Move into the info panel so its synopsis can be scrolled — but only
                // when the inner text body actually overflows (the panel itself no
                // longer scrolls; the pinned-poster layout scrolls .vod-info-body).
                // No overflow → nothing to read by scrolling, so stay put.
                var body = infoEl && infoEl.querySelector('.vod-info-body');
                if (body && body.scrollHeight > body.clientHeight + 4) {
                    body.scrollTop = 0;
                    Focus.focus(infoEl);
                    window._navHandled = true;
                }
                return;
            }
            return;
        }

        // Fallback
        if (catListEl) Focus.focusFirstIn(catListEl);
    }

    /* --- Search section --- */
    function handleSearchNav(cur, dir) {
        var field = document.getElementById('searchField');
        // The search field sits above the grid (acts as the header). Down enters
        // the results grid; everything else from the field is left to the
        // dispatch (sidebar / spatial).
        if (cur === field) {
            var results = document.getElementById('searchResults');
            if (dir === 'down' && results) Focus.focusFirstIn(results);
            return;
        }
        // Results grid: shared card-grid handler. searchField is the up-off-top
        // target; left from column 0 -> nav-search rail. (Left is normally
        // intercepted earlier by handleContentLeft, which delegates to the same
        // handler — this covers any non-left grid movement.)
        handleCardGridNav(cur, dir, {
            gridId: 'searchResults',
            sidebarKey: 'nav-search',
            searchFieldId: 'searchField'
        });
    }

    /* handleEpgNav() removed — it queried #epgBody, which was
     * the body of the standalone EPG screen that no longer exists. The
     * function had no callers in this file or elsewhere. */

    /* --- Playlists section --- */
    function handlePlaylistsNav(cur, dir) {
        var section = document.querySelector('.content-section[data-section-content="playlists"]');
        var plList = document.getElementById('plList');
        var sectionMeta = section ? section.querySelector('.section-meta') : null;

        // Check if we're in a modal (action sheet)
        var modal = document.getElementById('modalLayer');
        if (modal && !modal.classList.contains('hidden') && modal.contains(cur)) {
            if (dir === 'right' || dir === 'down') { Focus.moveSibling('next'); return; }
            if (dir === 'left' || dir === 'up')   { Focus.moveSibling('prev'); return; }
            return;
        }

        var inButtons = sectionMeta && sectionMeta.contains(cur);
        var inList = plList && plList.contains(cur);
        var epgInput = document.getElementById('setEpgManage');
        var inEpg = epgInput && (cur === epgInput);

        if (inEpg) {
            if (dir === 'up') {
                if (plList && plList.children.length) { Focus.focusLastIn(plList); }
                else if (sectionMeta) { Focus.focusFirstIn(sectionMeta); }
                return;
            }
            // down/left/right are dead-ends here; block movement so the geometric
            // fallback doesn't send RIGHT to the top action buttons.
            window._navHandled = true;
            return;
        }

        if (inList) {
            // Cards contain focusable content chips (Xtream) UNDER the details.
            // Because the chips sit inside the card's box, pure spatial nav
            // can't reach them from the card (a down-candidate must start below
            // the source's bottom edge, and the chips are above it). So handle
            // the card<->chip hops explicitly, and use spatial for everything
            // else (chip<->chip, card<->card, into the EPG/buttons).
            var curCard = cur.classList && cur.classList.contains('pl-card') ? cur : null;
            var curChip = cur.classList && cur.classList.contains('pl-ct-check') ? cur : null;

            if (curCard) {
                var chipsInCard = curCard.querySelectorAll('.pl-ct-check');
                if (dir === 'down' && chipsInCard.length) { Focus.focus(chipsInCard[0]); return; }
                if (dir === 'down') {
                    // No chips on this card (M3U): go to next card, else EPG.
                    if (!Focus.spatial('down', '#plList') && epgInput) Focus.focus(epgInput);
                    return;
                }
                if (dir === 'up') {
                    if (!Focus.spatial('up', '#plList') && sectionMeta) Focus.focusFirstIn(sectionMeta);
                    return;
                }
                return;
            }

            if (curChip) {
                if (dir === 'left') {
                    // LEFT is handled in handleContentLeft (prev chip / sidebar at
                    // the first). If we somehow reach here, do nothing.
                    window._navHandled = true; return;
                }
                if (dir === 'right') {
                    // Step to the next chip in the same card; at the LAST chip
                    // (EPG) this is a no-op (block movement) rather than escaping.
                    var chipCard = curChip;
                    while (chipCard && !(chipCard.classList && chipCard.classList.contains('pl-card'))) chipCard = chipCard.parentNode;
                    if (chipCard) {
                        var siblings = chipCard.querySelectorAll('.pl-ct-check');
                        for (var ci = 0; ci < siblings.length; ci++) {
                            if (siblings[ci] === curChip) {
                                if (ci + 1 < siblings.length) { Focus.focus(siblings[ci + 1]); return; }
                                break;
                            }
                        }
                    }
                    window._navHandled = true; return; // last chip -> no-op
                }
                if (dir === 'up') {
                    // Back up to this chip's own card.
                    var ownCard = curChip;
                    while (ownCard && !(ownCard.classList && ownCard.classList.contains('pl-card'))) ownCard = ownCard.parentNode;
                    if (ownCard) { Focus.focus(ownCard); return; }
                    return;
                }
                if (dir === 'down') {
                    // Down from a chip goes to the next card (or EPG control).
                    if (!Focus.spatial('down', '#plList') && epgInput) Focus.focus(epgInput);
                    return;
                }
                return;
            }

            // Fallback for anything else in the list.
            if (!Focus.spatial(dir, '#plList')) {
                if (dir === 'down' && epgInput) Focus.focus(epgInput);
                else if (dir === 'up' && sectionMeta) Focus.focusFirstIn(sectionMeta);
            }
            return;
        }
        if (inButtons) {
            // dir is the physical direction (no RTL flip any more — layout is LTR in
            // both languages). Right moves to the visually-right button, or dead-ends
            // if none; Left moves to the visually-left button, or falls through so the
            // dispatcher routes Left to the sidebar (which sits on the left in both
            // languages now). Spatial nav scores by visual geometry, so this is correct
            // for Arabic and LTR alike with no special-casing.
            if (dir === 'right') {
                if (!Focus.spatial('right', sectionMeta)) window._navHandled = true;
                return;
            }
            if (dir === 'left') {
                if (Focus.spatial('left', sectionMeta)) return;
                return;
            }
            if (dir === 'down') {
                if (plList && plList.children.length) { Focus.focusFirstIn(plList); return; }
                if (epgInput) { Focus.focus(epgInput); return; }
            }
            return;
        }
        // Fallback: focus first card, then buttons
        if (plList && plList.children.length) { Focus.focusFirstIn(plList); return; }
        if (sectionMeta) Focus.focusFirstIn(sectionMeta);
    }

    /* --- Settings section --- */
    function handleSettingsNav(cur, dir) {
        /* Explicit data-focus-{dir} override. This MUST
         * be checked first because the settings nav uses its own
         * row-based traversal (further down) that bypasses
         * focusNearestInContainer entirely. The attribute override
         * mechanism in focus.js only fires inside
         * focusNearestInContainer, so without this check, settings nav
         * never consulted the override.
         *
         * Symptom this fixes: pressing Up on Wipe All Data was supposed
         * to jump to Delete Cloud Account (via data-focus-up attribute),
         * but instead landed on Push to Cloud — because the row-based
         * code below grabs the FIRST focusable in the previous row,
         * which is syncPushBtn. The override was never read. */
        if (cur && cur.getAttribute) {
            var overrideKey = cur.getAttribute('data-focus-' + dir);
            if (overrideKey) {
                if (overrideKey === '__none__') { window._navHandled = true; return; } // dead-end: block movement (and stop the geometric fallback re-navigating)
                var target = document.querySelector('.focusable[data-focus-key="' + overrideKey + '"]');
                if (target && Focus.isVisible(target)) {
                    Focus.focus(target);
                    return;
                }
            }
        }

        var parentalActions = document.querySelector('.content-section[data-section-content="parental"] .parental-actions');
        if (parentalActions && parentalActions.contains(cur)) {
            // Left never arrives here: dispatch routes Left through handleContentLeft
            // (before the section switch), which returns false for these buttons so
            // focus goes to the sidebar — the normal Left-from-content behaviour.
            if (dir === 'right') {
                // Move to a genuine right neighbour (Enable -> Disable). On Disable
                // there is none: dead-end here rather than letting the geometric
                // fallback drop focus to the next setting row.
                if (!Focus.spatial('right', parentalActions)) window._navHandled = true;
                return;
            }
            if (dir === 'down') {
                // First setting that can actually take focus. While parental
                // controls are off the three selects are disabled; the old
                // querySelector picked the disabled first one anyway, so the
                // remote could still land on (and open) App Launch Lock.
                var parentalSettings = document.querySelectorAll('.content-section[data-section-content="parental"] .setting-row .focusable');
                for (var ps = 0; ps < parentalSettings.length; ps++) {
                    if (Focus.isVisible(parentalSettings[ps])) { Focus.focus(parentalSettings[ps]); return; }
                }
                // Nothing focusable below (all disabled): stay on the buttons.
                window._navHandled = true;
            }
            return;
        }
        // Check if we're inside a multi-button control (sync actions)
        var parentCtl = cur;
        while (parentCtl && parentCtl.parentNode) {
            if (parentCtl.classList && parentCtl.classList.contains('setting-ctl')) break;
            parentCtl = parentCtl.parentNode;
        }
        var isMulti = parentCtl && parentCtl.classList && parentCtl.classList.contains('setting-ctl') && parentCtl.querySelectorAll('.focusable').length > 1;

        // Try navigating within a complex control first. ALL four directions use
        // spatial nav (focusNearestInContainer): it honours an explicit
        // data-focus-{dir} override first, then falls back to the geometric
        // nearest focusable in that direction. This handles both layouts without
        // special-casing: a horizontal pair (e.g. parental enable/disable) finds
        // its neighbour to the side, and a vertical stack (e.g. the sync action
        // buttons) has nothing left/right so the press is a natural dead-end — no
        // "__none__" sentinel required. Previously left/right used moveSibling,
        // which walked the DOM sibling order regardless of on-screen direction and
        // slid a vertical stack up/down on a left/right press.
        if (isMulti) {
            // Pure spatial within the control. The sync action buttons are a single
            // vertical column now (no more 2x2 grid, no data-focus chains): up/down
            // move to the adjacent button by geometry; left/right have no in-column
            // neighbour so spatial returns false — Left then falls through to the
            // sidebar (handleContentLeft) and Right dead-ends (nothing to the right
            // in the single-column settings layout). Down off the last button falls
            // to the settings row-traversal below (lands on the next row).
            var moved = Focus.spatial(dir, parentCtl);
            if (moved) return;
        }

        // Jump to next/prev setting-row
        if (dir === 'down' || dir === 'up') {
            var row = cur;
            while (row && row.parentNode) {
                if (row.classList && row.classList.contains('setting-row')) break;
                row = row.parentNode;
            }
            if (row && row.classList && row.classList.contains('setting-row')) {
                var targetRow = dir === 'down' ? row.nextElementSibling : row.previousElementSibling;
                if (dir === 'up' && !targetRow && getActiveSection && getActiveSection() === 'parental') {
                    var parentalBtns = document.querySelector('.content-section[data-section-content="parental"] .parental-actions');
                    if (parentalBtns && parentalBtns.querySelector('.focusable')) { Focus.focusFirstIn(parentalBtns); return; }
                }
                while (targetRow) {
                    if (targetRow.classList && targetRow.classList.contains('setting-row')) {
                        var focusable = targetRow.querySelector('.focusable');
                        if (focusable && Focus.isVisible(focusable)) {
                            Focus.focus(focusable);
                            return;
                        }
                    }
                    targetRow = dir === 'down' ? targetRow.nextElementSibling : targetRow.previousElementSibling;
                }
            }
            return;
        }

        // Dropdown SELECT handler
        if (cur && cur.tagName === 'SELECT' && (dir === 'left' || dir === 'right')) {
            var idx = cur.selectedIndex;
            var len = cur.options.length;
            cur.selectedIndex = dir === 'right' ? (idx + 1) % len : (idx - 1 + len) % len;
            try {
                var evt = document.createEvent('Event');
                evt.initEvent('change', true, true);
                cur.dispatchEvent(evt);
            } catch (e) {}
        }
    }

    /* Channel up/down: player = channel jump, EPG = page, elsewhere = ignore */
    var lastLivePageAt = 0;
    function handleChannelUpDown(delta) {
        // Channel up/down is only for the player and the guide/EPG screens.
        // If a modal or the virtual keyboard is open over the guide, do
        // nothing — otherwise paging the EPG underneath rebuilds the guide DOM
        // and yanks focus out of the open modal.
        var modalOpen = (function () {
            var ml = document.getElementById('modalLayer');
            if (ml && !ml.classList.contains('hidden') && ml.children && ml.children.length) return true;
            var vk = document.getElementById('vkeyboard');
            if (vk && !vk.classList.contains('hidden')) return true;
            return false;
        })();
        if (modalOpen) return;
        var screen = activeScreenId();
        if (screen === 'player') {
            // With the info overlay open, don't change channel (matches dpad
            // up/down). The overlay is for interacting with the current channel;
            // a CH+/- press while it's up should not zap the channel underneath.
            var ovl = document.getElementById('infoOverlay');
            if (ovl && ovl.classList.contains('show')) return;
            jumpChannel(delta);
            return;
        }
        if (screen === 'home') {
            var section = document.querySelector('.content-section.active');
            var name = section ? section.getAttribute('data-section-content') : null;
            if (name === 'epg' || name === 'livetv') {
                // Channel UP = previous page (scroll up visually)
                // Channel DOWN = next page (scroll down visually)
                var nowPageAt = Date.now();
                if (nowPageAt - lastLivePageAt < 450) return;
                lastLivePageAt = nowPageAt;
                var prevKey = name === 'livetv' ? 'live-prev' : 'epg-prev';
                var nextKey = name === 'livetv' ? 'live-next' : 'epg-next';
                if (delta > 0) {
                    var prevBtn = document.querySelector('[data-focus-key="' + prevKey + '"]');
                    if (prevBtn) { prevBtn.click(); return; }
                }
                if (delta < 0) {
                    var nextBtn = document.querySelector('[data-focus-key="' + nextKey + '"]');
                    if (nextBtn) { nextBtn.click(); return; }
                }
                return;
            }
        }
        // All other screens: ignore channel up/down
    }

    /* OK press handling */

    function focusFirstResultAfterCategory(sectionName, attempts) {
        var listId = sectionName === 'livetv' ? 'liveChList' : sectionName === 'movies' ? 'movieList' : sectionName === 'series' ? 'seriesList' : '';
        if (!listId) return;
        // Only move focus while it's still on a category item — never yank focus
        // the user has already moved.
        var cur = Focus.current();
        if (!(cur && cur.classList && cur.classList.contains('panel-cat-item'))) return;
        var list = document.getElementById(listId);
        if (list && list.querySelector('.media-row.focusable, .ch-card.focusable, .live-epg-row.focusable')) {
            Focus.focusFirstIn(list);
            return;
        }
        if (attempts < 40) setTimeout(function () { focusFirstResultAfterCategory(sectionName, attempts + 1); }, 150);
    }

    function handleOk(ev) {
        var screen = activeScreenId();

        // One-shot guard: after backing out of a player modal we keep focus on
        // the opener for visibility. Instead of fully swallowing the next OK
        // (which forced a second press to do anything), consume it to suppress the
        // opener re-click but still bring the overlay up in this same press, so the
        // user isn't left pressing OK twice.
        if (window._swallowNextOk) {
            window._swallowNextOk = false;
            // Only swallow if this OK came almost immediately after the close — that's
            // the accidental opener re-click we want to suppress. A deliberate reopen
            // a moment later should pass through (otherwise it needs a second press).
            var armedAt = window._swallowNextOkAt || 0;
            window._swallowNextOkAt = 0;
            if ((Date.now() - armedAt) < 400) {
                if (activeScreenId() === 'player' && !state.miniOpen) {
                    Player.showOverlay();
                    Player.refreshOverlayContent();
                }
                return;
            }
            // Otherwise fall through and handle this OK normally.
        }

        // PRIORITY 0: Virtual keyboard (can sit on top of a modal). If a vk key is
        // focused, OK activates that key and must NEVER fall through to the player
        // (which would toggle play/pause while the user is typing). handleArrow and
        // handleBack already check the vkeyboard first; handleOk must too.
        var vkEl = document.getElementById('vkeyboard');
        if (vkEl && !vkEl.classList.contains('hidden')) {
            var vkFocused = Focus.current();
            if (vkFocused && vkEl.contains(vkFocused)) {
                try { vkFocused.click(); } catch (e) {}
                return;
            }
        }

        // PRIORITY: Modal/picker over player
        var modalLayer = document.getElementById('modalLayer');
        if (modalLayer && !modalLayer.classList.contains('hidden')) {
            var cm = Focus.current();
            if (cm && modalLayer.contains(cm)) {
                try { cm.click(); } catch (e) {}
                return;
            }
            // Focus lost/escaped the modal (e.g. a re-render replaced the focused
            // node): recover into the modal rather than acting on the player behind
            // it. Don't activate anything — just restore focus.
            var firstF = modalLayer.querySelector('.focusable');
            if (firstF) { Focus.focus(firstF); return; }
        }

        // Player screen
        if (screen === 'player' && !state.miniOpen) {
            var c = Focus.current();
            var overlayEl = document.getElementById('infoOverlay');
            var overlayShown = overlayEl && overlayEl.classList.contains('show');
            if (c && c.classList && (c.classList.contains('info-action') || c.classList.contains('transport-btn'))) {
                // If focus is on an overlay control but the overlay is hidden (e.g.
                // we just closed a modal and focus was restored to its opener), OK
                // should bring the overlay BACK rather than activating an invisible
                // control (which reopened the just-closed modal). Show + re-focus.
                if (!overlayShown) {
                    Player.showOverlay();
                    Player.refreshOverlayContent();
                    return;
                }
                window._lastOverlayFocusKey = c.getAttribute('data-focus-key');
                try { c.click(); } catch (e) {}
                // If a modal was opened by the click, don't refresh overlay
                var ml = document.getElementById('modalLayer');
                if (ml && !ml.classList.contains('hidden')) return;
                Player.showOverlay();
                Player.refreshOverlayContent();
                return;
            }
            // Overlay closed: OK just opens the overlay with the play button
            // focused (a highlight, not a press). It does NOT pause — so if the
            // user does nothing the overlay auto-hides while the video keeps
            // playing. A deliberate second OK on the focused play button pauses.
            Player.showOverlay();
            Player.refreshOverlayContent();
            return;
        }

        var c = Focus.current();
        if (!c) return;

        // Poster card (Movies/Series card view): OK pins the card and jumps focus
        // to the info panel so its full synopsis is readable from any card/column
        // with the D-pad. The panel already tracks the focused card's data. Play /
        // View Episodes then happen via OK on the panel; left or back returns to the
        // pinned card. (Replaces the old details modal — same reach, no extra
        // surface, instant.) List view is unaffected — its rows play/open on OK.
        if (c.classList && c.classList.contains('vod-card')) {
            var okSection = getActiveSection ? getActiveSection() : null;
            if (okSection === 'movies' || okSection === 'series') {
                var okPfx = (okSection === 'series' ? 'series' : 'movie');
                var okInfoEl = document.getElementById(okPfx + 'Info');
                var okPlayBtn = document.getElementById(okPfx + 'InfoPlay');
                if (okInfoEl && okPlayBtn) {
                    window._vodPinnedCard = c;                 // return target for left/back
                    var okBody = okInfoEl.querySelector('.vod-info-body');
                    if (okBody) okBody.scrollTop = 0;
                    Focus.focus(okPlayBtn);                    // land on the visible action
                    if (typeof updateVodScrollHint === 'function') updateVodScrollHint(okInfoEl);
                    return;
                }
            }
        }

        // OK on the info panel or its Play button: play the pinned movie / open its
        // episodes, reusing the card's own open callback (Xtream and Stalker).
        var okInfoNow = document.getElementById('movieInfo');
        var okSeriesInfoNow = document.getElementById('seriesInfo');
        var okPlayNow = document.getElementById('movieInfoPlay');
        var okSeriesPlayNow = document.getElementById('seriesInfoPlay');
        if (c === okPlayNow || c === okSeriesPlayNow ||
            (okInfoNow && (c === okInfoNow || okInfoNow.contains(c))) ||
            (okSeriesInfoNow && (c === okSeriesInfoNow || okSeriesInfoNow.contains(c)))) {
            var pinned = window._vodPinnedCard;
            if (pinned && typeof pinned._vodOpen === 'function') { pinned._vodOpen(); return; }
        }

        if (c.tagName === 'SELECT') {
            var okSelIdx = c.selectedIndex;
            c.selectedIndex = (okSelIdx + 1) % c.options.length;
            try {
                var evt = document.createEvent('Event');
                evt.initEvent('change', true, true);
                c.dispatchEvent(evt);
            } catch (e) {}
            return;
        }

        if (c.tagName === 'INPUT') {
            // Readonly search fields: open app virtual keyboard
            if (c.hasAttribute('readonly')) {
                UI.openVKeyboard(c);
                return;
            }
            // Regular inputs: trigger native keyboard
            c.focus();
            try {
                var clickEvt = new MouseEvent('click', { bubbles: true });
                c.dispatchEvent(clickEvt);
            } catch (e) {
                try { c.click(); } catch (e2) {}
            }
            return;
        }

        var wasLiveCat = c.classList && c.classList.contains('panel-cat-item');
        var sectionBeforeOk = getActiveSection ? getActiveSection() : null;
        if (wasLiveCat && (sectionBeforeOk === 'livetv' || sectionBeforeOk === 'movies' || sectionBeforeOk === 'series')) {
            var catName = c._catName || c.getAttribute('data-cat') || '';
            if (window.Access && Parental.isCategoryLocked(sectionBeforeOk, catName) && !Access.isUnlocked()) {
                Access.requirePin(T('ui_unlock_category'), function (ok) {
                    if (!ok) return;
                    window._focusContentAfterCatLoad = sectionBeforeOk;
                    try { c.click(); } catch (e1) {}
                    setTimeout(function () { focusFirstResultAfterCategory(sectionBeforeOk, 0); }, 80);
                });
                return;
            }
        }
        if (wasLiveCat && (sectionBeforeOk === 'livetv' || sectionBeforeOk === 'movies' || sectionBeforeOk === 'series')) {
            // Set BEFORE click so a synchronous (cached) render inside click()
            // sees the flag too; async renders see it when they finish.
            window._focusContentAfterCatLoad = sectionBeforeOk;
        }
        try { c.click(); } catch (e) {}
        if (wasLiveCat && (sectionBeforeOk === 'livetv' || sectionBeforeOk === 'movies' || sectionBeforeOk === 'series')) {
            // Polled fallback for any render path that doesn't call the consumer.
            setTimeout(function () { focusFirstResultAfterCategory(sectionBeforeOk, 0); }, 80);
        }
    }

    /* Long-press OK = toggle favorite */
    function handleOkLong() {
        var screen = activeScreenId();
        var c = Focus.current();

        // Player screen: toggle favorite on current channel
        if (screen === 'player' && !state.miniOpen) {
            var cur = Player.currentChannel();
            if (cur) doToggleFavoriteChannel(cur);
            return;
        }

        // Channel card or category channel row
        if (c && c.classList && (c.classList.contains('ch-card') || c.classList.contains('media-row') || c.classList.contains('live-epg-row'))) {
            doToggleFavorite(c);
            return;
        }
        // Poster card (Movies/Series card view). Cards carry _vodData directly.
        if (c && c.classList && c.classList.contains('vod-card')) {
            var favCh = favChannelFromVodCard(c);
            if (favCh) doToggleFavoriteChannel(favCh);
            return;
        }
        // Mini-ch in player
        if (c && c.classList && c.classList.contains('mini-ch')) {
            var miniId = c.getAttribute('data-focus-key');
            if (miniId) {
                var chId = miniId.replace('mini-', '');
                var list = UI.getChannels();
                for (var i = 0; i < list.length; i++) {
                    if (list[i].id === chId) { doToggleFavoriteChannel(list[i]); return; }
                }
            }
            return;
        }
    }

    /* Build a favorite channel object from a poster card (.vod-card). The card
     * carries the raw stream on _vodData and its type on _vodType. We construct
     * the SAME play URL the list view uses (renderVodList) so the fav key (url)
     * matches — a star set from card view shows in list view and vice-versa. */
    function favChannelFromVodCard(card) {
        var data = card._vodData;
        var vt = card._vodType || card.getAttribute('data-ch-type') || '';
        // The card's _vodType is the SECTION name ('movies'/'series'); the favorite
        // model uses content types ('vod'/'series'). Map so toggleFavorite doesn't
        // normalise an unrecognised 'movies' down to 'live'.
        var type = (vt === 'series') ? 'series' : 'vod';
        if (!data) return null;
        var pl = null;
        try {
            var plId = Store.getActivePlaylistId();
            var pls = Store.getPlaylists ? Store.getPlaylists() : [];
            for (var i = 0; i < pls.length; i++) { if (pls[i].id === plId) { pl = pls[i]; break; } }
        } catch (e) {}
        var url = '';
        if (pl && pl.host && type !== 'series' && data.stream_id) {
            url = pl.host.replace(/\/$/, '') + '/movie/' +
                encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' +
                data.stream_id + '.' + (data.container_extension || 'mp4');
        }
        // Series have no single stream URL; key on a stable id so the fav still
        // toggles and shows a star (same scheme list view falls back to).
        var id = (type === 'series' ? 'series-' : 'vod-') + (data.stream_id || data.series_id || data.id || data.name || '');
        return {
            id: id,
            name: data.name || data.title || '',
            url: url,
            logo: data.stream_icon || data.cover || data.logo || '',
            playlistId: pl ? pl.id : (Store.getActivePlaylistId ? Store.getActivePlaylistId() : ''),
            playlistName: pl ? pl.name : (card.getAttribute('data-playlist-name') || ''),
            category: type === 'series' ? 'Series' : 'Movies',
            type: type
        };
    }

    function doToggleFavorite(cardEl) {
        var id = cardEl.getAttribute('data-ch-id');
        var list = UI.getChannels();
        var ch = null;
        for (var i = 0; i < list.length; i++) if (list[i].id === id) { ch = list[i]; break; }
        // If not a live channel, build from DOM
        if (!ch && id) {
            var nameEl = cardEl.querySelector('.media-name') || cardEl.querySelector('.ch-name') || cardEl.querySelector('.live-epg-ch-name');
            var cardType = cardEl.getAttribute('data-ch-type') || '';
            var section = document.querySelector('.content-section.active');
            var secName = section ? section.getAttribute('data-section-content') : '';
            var resolvedType = cardType || (secName === 'movies' ? 'vod' : secName === 'series' ? 'series' : 'live');
            ch = {
                id: id,
                name: nameEl ? nameEl.textContent : '',
                url: cardEl.getAttribute('data-url') || '',
                logo: '',
                type: resolvedType,
                playlistName: cardEl.getAttribute('data-playlist-name') || '',
                playlistId: cardEl.getAttribute('data-playlist-id') || '',
                category: resolvedType === 'vod' ? 'Movies' : resolvedType === 'series' ? 'Series' : ''
            };
        }
        if (ch) doToggleFavoriteChannel(ch);
    }

    function doToggleFavoriteChannel(ch) {
        var added = Store.toggleFavorite(ch);
        UI.refreshFavStars();
        UI.toast(added ? '\u2605 Added to favorites' : 'Removed from favorites', 'ok');

        // Auto-refresh fav icons on visible cards matching this channel
        var chId = ch.id || '';
        var chUrl = ch.url || '';
        var cards = document.querySelectorAll('.ch-card, .media-row, .live-epg-row');
        for (var ci = 0; ci < cards.length; ci++) {
            var cardId = cards[ci].getAttribute('data-ch-id') || '';
            var cardUrl = cards[ci].getAttribute('data-url') || '';
            // Same id/title can exist in another playlist: only touch this playlist's cards.
            var cardPl = cards[ci].getAttribute('data-playlist-id') || '';
            if (cardPl && ch.playlistId && cardPl !== ch.playlistId) continue;
            if ((chId && (cardId === chId || cardUrl === chId)) || (chUrl && (cardUrl === chUrl || cardId === chUrl))) {
                var existingStar = cards[ci].querySelector('.fav-mark, .media-fav');
                if (added && !existingStar) {
                    var star = document.createElement('div');
                    var starIsCardBadge = !(cards[ci].classList.contains('media-row') || cards[ci].classList.contains('live-epg-row'));
                    star.className = starIsCardBadge ? 'fav-mark' : 'media-fav';
                    // .fav-mark (card badge) uses a real SVG star, not the
                    // Unicode U+2605 character — see ui.js's STAR_SVG comment
                    // for why (font-metric centering varies by platform;
                    // measured off-centre on real devices).
                    // .media-fav (plain row text) is unaffected and keeps
                    // the Unicode glyph, since it never showed the problem
                    // and isn't a tight circular badge subject to the same
                    // centering issue.
                    if (starIsCardBadge && window.UI && UI.starSvgMarkup) star.innerHTML = UI.starSvgMarkup();
                    else star.textContent = '\u2605';
                    if (cards[ci].classList.contains('live-epg-row')) {
                        var starParent = cards[ci].querySelector('.live-epg-ch');
                        if (starParent) starParent.appendChild(star);
                        else cards[ci].appendChild(star);
                    } else {
                        cards[ci].appendChild(star);
                    }
                } else if (!added && existingStar) {
                    existingStar.parentNode.removeChild(existingStar);
                }
            }
        }

        var section = document.querySelector('.content-section.active');
        var sname = section ? section.getAttribute('data-section-content') : null;
        if (sname === 'home') {
            // (No hero/row rebuild here — toggling a favorite must not change the
            // hero. The star was already updated by refreshFavStars.)
            var curFocus = Focus.current();
            if (!curFocus || !document.body.contains(curFocus)) {
                var recentRow = document.getElementById('channelRowRecent');
                var heroPlay = document.getElementById('heroPlay');
                if (recentRow && recentRow.querySelector('.focusable')) Focus.focusFirstIn(recentRow);
                else if (heroPlay) Focus.focus(heroPlay);
            }
        }
        else if (sname === 'favorites') UI.renderFavorites();
    }

    function handleBack(ev) {
        // Crash-trail diagnostic overlay: if it's up, BACK dismisses it and nothing
        // else. Handled here (not via a separate listener) because Remote's keydown
        // handler runs first, so a separate listener would let the exit prompt fire
        // before the overlay closed on one fast BACK press.
        if (window._crashTrailKill) { window._crashTrailKill(); return; }
        // Exit dialog
        var exitDlg = $('#exitDialog');
        if (exitDlg && !exitDlg.classList.contains('hidden')) { hideExitDialog(); return; }
        // VKeyboard first (may be on top of a modal)
        var vk = $('#vkeyboard');
        if (vk && !vk.classList.contains('hidden')) { UI.closeVKeyboard(); return; }
        // Filter-picker overlay stacked on top of a manager modal: Back removes only
        // the overlay and returns to the manager, not the whole modal.
        if (window._pickOverlayCancel) { window._pickOverlayCancel(); return; }
        // Modal
        var modal = $('#modalLayer');
        if (modal && !modal.classList.contains('hidden')) {
            UI.closeModal();
            // On the player screen, closeModal restores focus to the button that
            // opened the modal (e.g. the scale button). Keep that focus (the user
            // expects to land back on the control they invoked) but swallow the
            // VERY NEXT OK so it doesn't immediately re-click the opener and
            // reopen the picker — the old "modal returns after back then ok" loop.
            // A direction press clears the guard naturally on the next handled key.
            if (activeScreenId() === 'player') {
                window._swallowNextOk = true;
                window._swallowNextOkAt = Date.now();
            }
            return;
        }
        var screen = activeScreenId();
        // Info panel (entered by OK-pinning a card): Back returns to the pinned card,
        // mirroring left. Only when focus is in the panel and a pin is set.
        var backCur = Focus.current();
        var mInfo = document.getElementById('movieInfo');
        var sInfo = document.getElementById('seriesInfo');
        if (backCur && ((mInfo && (backCur === mInfo || mInfo.contains(backCur))) ||
                        (sInfo && (backCur === sInfo || sInfo.contains(backCur))))) {
            if (window._vodPinnedCard && document.body.contains(window._vodPinnedCard)) {
                Focus.focus(window._vodPinnedCard);
                window._vodPinnedCard = null;
                return;
            }
        }
        if (screen === 'player') {
            // Close overlay first if visible
            var overlay = $('#infoOverlay');
            if (state.miniOpen) { closeMini(); return; }
            if (overlay && overlay.classList.contains('show')) {
                Player.hideOverlay();
                Focus.blur();
                return;
            }
            exitPlayer();
            return;
        }
        if (screen === 'manualEntry') {
            if (Store.getPlaylists().length) {
                UI.showScreen('home');
                UI.showSection('playlists');
                setTimeout(function () {
                    if (window._lastPlaylistFocusEl && document.body.contains(window._lastPlaylistFocusEl)) {
                        Focus.focus(window._lastPlaylistFocusEl);
                    }
                }, 150);
            } else {
                goOnboarding();
            }
            return;
        }
        if (screen === 'onboarding') {
            if (Store.getPlaylists().length) {
                UI.showScreen('home');
                UI.showSection('playlists');
                setTimeout(function () {
                    if (window._lastPlaylistFocusEl && document.body.contains(window._lastPlaylistFocusEl)) {
                        Focus.focus(window._lastPlaylistFocusEl);
                    }
                }, 150);
                return;
            }
            exitOrConfirm();
            return;
        }
        if (screen === 'home') {
            if (window.LiveTopMiniPlayer && LiveTopMiniPlayer.isActive && LiveTopMiniPlayer.isActive()) {
                var mfk = LiveTopMiniPlayer.lastFocusKey ? LiveTopMiniPlayer.lastFocusKey() : null;
                LiveTopMiniPlayer.stop();
                setTimeout(function () {
                    if (mfk && Focus.focusKey(mfk)) return;
                    var liveList = document.getElementById('liveChList');
                    if (liveList && liveList.querySelector('.focusable')) Focus.focusFirstIn(liveList);
                }, 80);
                return;
            }
            // General Back: walk the focus chain (see focus.js), which remembers where
            // focus came from across every screen and modal. The side menu is the
            // root: from there Back is the exit prompt handled below, never a chain
            // step. The screen-specific handling that follows is only the fallback
            // for when there is no chain to walk.
            var chainCur = Focus.current();
            if (!(chainCur && isInSidebar(chainCur)) && Focus.back && Focus.back()) return;

            var active = document.querySelector('.content-section.active');
            var sname = active ? active.getAttribute('data-section-content') : null;

            // If in channel list of a guide screen, go back to category list
            if (sname === 'livetv' || sname === 'movies' || sname === 'series') {
                var cur = Focus.current();
                var catListIds = { livetv: 'liveCatList', movies: 'movieCatList', series: 'seriesCatList' };
                var chListIds = { livetv: 'liveChList', movies: 'movieList', series: 'seriesList' };
                var catListEl = document.getElementById(catListIds[sname]);
                var chListEl = document.getElementById(chListIds[sname]);

                if (chListEl && cur && chListEl.contains(cur)) {
                    // In channel/movie/series list — go back to category list
                    if (catListEl) {
                        var loadedCat = catListEl.getAttribute('data-cat-loaded');
                        var target = loadedCat ? catListEl.querySelector('.panel-cat-item[data-cat="' + loadedCat + '"]') : null;
                        if (target) Focus.focus(target);
                        else Focus.focusFirstIn(catListEl);
                    }
                    return;
                }
                // In category list — focus the sidebar nav item for this section
                if (catListEl && cur && (catListEl.contains(cur) || cur.classList.contains('cat-filter'))) {
                    var navKeyMap2 = { livetv: 'nav-livetv', movies: 'nav-movies', series: 'nav-series' };
                    Focus.focusKey(navKeyMap2[sname] || ('nav-' + sname));
                    return;
                }
            }

            if (sname && sname !== 'home') {
                var cur3 = Focus.current();
                var inSidebar = false;
                if (cur3) {
                    var sp = cur3.parentNode;
                    while (sp && sp !== document.body) {
                        if (sp.classList && sp.classList.contains('sidebar')) { inSidebar = true; break; }
                        sp = sp.parentNode;
                    }
                }
                if (inSidebar) {
                    // Use LG system exit
                    try {
                        if (typeof webOSSystem !== 'undefined' && webOSSystem.platformBack) { webOSSystem.platformBack(); return; }
                    } catch (e) {}
                    try {
                        if (typeof webOS !== 'undefined' && webOS.platformBack) { webOS.platformBack(); return; }
                    } catch (e) {}
                    showExitDialog();
                    return;
                }
                var navKeyMap = {
                    home: 'nav-home',
                    livetv: 'nav-livetv', movies: 'nav-movies', series: 'nav-series',
                    search: 'nav-search', playlists: 'nav-pl', settings: 'nav-settings', parental: 'nav-parental',
                    favorites: 'nav-fav', epg: 'nav-epg'
                };
                var navKey2 = navKeyMap[sname] || ('nav-' + sname);
                Focus.focusKey(navKey2);
                return;
            }
            // On live/home — system exit
            try {
                if (typeof webOSSystem !== 'undefined' && webOSSystem.platformBack) {
                    webOSSystem.platformBack();
                    return;
                }
            } catch (e) {}
            try {
                if (typeof webOS !== 'undefined' && webOS.platformBack) {
                    webOS.platformBack();
                    return;
                }
            } catch (e) {}
            exitOrConfirm();
            return;
        }
    }

    /* Exit the app */
    function tryExitApp() {
        // Android TV / Google TV (WebView shell): the native shell exposes
        // AndroidBridge.exitApp(), which finishes the host Activity. Google Play
        // requires the D-pad/Back button at the app root to exit the app, so
        // this must be the first branch on Android.
        try {
            if (typeof AndroidBridge !== 'undefined' && AndroidBridge && AndroidBridge.exitApp) {
                AndroidBridge.exitApp();
                return;
            }
        } catch (e) {}
        // Tizen: direct exit
        try {
            if (typeof tizen !== 'undefined' && tizen.application) {
                tizen.application.getCurrentApplication().exit();
                return;
            }
        } catch (e) {}
        // WebOS: window.close() terminates without system prompt
        try { window.close(); return; } catch (e) {}
        // Fallback
        try {
            if (typeof webOSSystem !== 'undefined' && webOSSystem.platformBack) {
                webOSSystem.platformBack();
                return;
            }
        } catch (e) {}
    }

    function handleMenu() {
        // From player: open favorites
        if (activeScreenId() === 'player') {
            exitPlayer();
            UI.showSection('favorites');
            return;
        }
        // Else: focus sidebar
        var nav = document.querySelector('.nav-btn[data-section="settings"]');
        if (nav) Focus.focus(nav);
    }

    function handleYellow() {
        var screen = activeScreenId();
        var c = Focus.current();
        var ch = null;

        // Player screen: always use the current playing channel
        if (screen === 'player' && !state.miniOpen) {
            ch = Player.currentChannel();
            if (ch) {
                var added = Store.toggleFavorite(ch);
                UI.refreshFavStars();
                UI.toast(added ? '\u2605 Added to favorites' : 'Removed from favorites', 'ok');
                // Refresh overlay if visible to show updated fav status
                Player.refreshOverlayContent();
            }
            return;
        }

        // Channel card or category channel row (live TV or VOD)
        if (c && c.classList && (c.classList.contains('ch-card') || c.classList.contains('media-row') || c.classList.contains('live-epg-row'))) {
            var id = c.getAttribute('data-ch-id');
            // Try live TV channels first
            var list = UI.getChannels();
            for (var i = 0; i < list.length; i++) if (list[i].id === id) { ch = list[i]; break; }
            // If not found in live channels, build from data attributes (VOD/series)
            if (!ch && id) {
                var itemName = c.querySelector('.media-name') || c.querySelector('.ch-name') || c.querySelector('.live-epg-ch-name');
                var cardType2 = c.getAttribute('data-ch-type') || '';
                var section2 = document.querySelector('.content-section.active');
                var secName = section2 ? section2.getAttribute('data-section-content') : '';
                var rType = cardType2 || (secName === 'movies' ? 'vod' : secName === 'series' ? 'series' : 'live');
                ch = {
                    id: id,
                    name: itemName ? itemName.textContent : '',
                    url: c.getAttribute('data-url') || '',
                    logo: '',
                    type: rType,
                    playlistName: c.getAttribute('data-playlist-name') || '',
                    playlistId: c.getAttribute('data-playlist-id') || '',
                    category: rType === 'vod' ? 'Movies' : rType === 'series' ? 'Series' : ''
                };
            }
        }
        // Poster card (Movies/Series card view)
        else if (c && c.classList && c.classList.contains('vod-card')) {
            ch = favChannelFromVodCard(c);
        }
        // Mini channel item in player
        else if (c && c.classList && c.classList.contains('mini-ch')) {
            var miniId = c.getAttribute('data-focus-key');
            if (miniId) {
                var chId = miniId.replace('mini-', '');
                var list2 = UI.getChannels();
                for (var j = 0; j < list2.length; j++) if (list2[j].id === chId) { ch = list2[j]; break; }
            }
        }

        if (!ch) return;

        var added2 = Store.toggleFavorite(ch);
        UI.refreshFavStars();
        UI.toast(added2 ? '\u2605 Added to favorites' : 'Removed from favorites', 'ok');

        var section = document.querySelector('.content-section.active');
        var sname = section ? section.getAttribute('data-section-content') : null;
        if (sname === 'home') {
            // (No hero rebuild on favorite toggle — see refreshFavStars above.)
            // Refocus within Continue Watching, else the hero.
            var recentRow = document.getElementById('channelRowRecent');
            var heroPlay = document.getElementById('heroPlay');
            if (recentRow && recentRow.querySelector('.focusable')) {
                Focus.focusFirstIn(recentRow);
            } else if (heroPlay) {
                Focus.focus(heroPlay);
            }
        }
        else if (sname === 'favorites') UI.renderFavorites();
    }

    function handleBlue() {
        var screen = activeScreenId();
        if (screen !== 'home') return;
        var c = Focus.current();
        if (!c) return;
        // Continue Watching card: BLUE removes it from Continue Watching.
        if (c.classList && c.classList.contains('ch-card')) {
            var recentRow = document.getElementById('channelRowRecent');
            if (recentRow && recentRow.contains(c)) {
                var key = c.getAttribute('data-ch-id') || c.getAttribute('data-url');
                if (!key) return;
                var nameEl = c.querySelector('.ch-name');
                var ch = { id: c.getAttribute('data-ch-id'), url: c.getAttribute('data-url') || '', name: nameEl ? nameEl.textContent : '' };
                UI.confirmRemoveFromCW(ch, function () {
                    UI.renderHome();
                    // Refocus the CW row (or hero if the row is now empty).
                    var row = document.getElementById('channelRowRecent');
                    var hero = document.getElementById('heroPlay');
                    if (row && row.querySelector('.focusable')) Focus.focusFirstIn(row);
                    else if (hero) Focus.focus(hero);
                });
                return;
            }
        }
        // Note: BLUE previously opened the Category/Content Manager on
        // Live/Movies/Series category items, but there was no on-screen hint for
        // it, so it was poor UX (a hidden action). Removed. The Category Manager
        // is still reachable via the visible "Manage" button on each category panel.
    }


    /* Channel +/- in player */
    /* Channel up/down. The first press after a pause starts the stream at once. Presses
     * that follow within ZAP_BURST_MS are grouped: each one moves the target along the
     * list, but the stream only starts for the channel you stop on (ZAP_SETTLE_MS after
     * the last press). Starting and cancelling a stream per press made the player queue
     * up connections (providers allow only one or two per account and some drop the
     * account for it) and left the player busy with a channel you had already left. */
    var ZAP_BURST_MS = 600;
    var ZAP_SETTLE_MS = 250;
    var zapLastAt = 0;
    var zapTimer = 0;
    var zapPending = null;
    function jumpChannel(delta) {
        var list = UI.getChannels();
        if (!list.length) return;
        var base = zapPending || Player.currentChannel();
        var idx = -1;
        if (base) for (var i = 0; i < list.length; i++) if (list[i].id === base.id) { idx = i; break; }
        var next = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
        if (activeScreenId() !== 'player') UI.showScreen('player');
        var now = Date.now();
        var inBurst = !!zapTimer || (now - zapLastAt) < ZAP_BURST_MS;
        zapLastAt = now;
        if (zapTimer) { clearTimeout(zapTimer); zapTimer = 0; }
        if (!inBurst) { zapPending = null; Player.play(list[next]); return; }
        zapPending = list[next];
        try { if (Player.showBusy) Player.showBusy(); } catch (eZb) {}
        zapTimer = setTimeout(function () {
            var target = zapPending;
            zapTimer = 0;
            zapPending = null;
            zapLastAt = Date.now();
            if (target) Player.play(target);
        }, ZAP_SETTLE_MS);
    }

    /* Digit channel jump (e.g. 0,0,1 -> chan 1) */
    function handleDigit(n) {
        // If a text input is focused, type into it
        var c = Focus.current();
        if (c && (c.tagName === 'INPUT' || c.tagName === 'TEXTAREA')) {
            // Native typing already handled; do nothing
            return;
        }
        state.digitBuffer += '' + n;
        if (state.digitTimer) clearTimeout(state.digitTimer);
        state.digitTimer = setTimeout(function () {
            var num = parseInt(state.digitBuffer, 10);
            state.digitBuffer = '';
            if (isNaN(num)) return;
            var list = UI.getChannels();
            for (var i = 0; i < list.length; i++) {
                if (list[i].number === num) {
                    if (activeScreenId() !== 'player') UI.showScreen('player');
                    Player.play(list[i]);
                    return;
                }
            }
        }, 1500);
    }

    /* ========== Player helpers ========== */
    function exitPlayer() {
        var cur = Player.currentChannel();
        var isVodLike = cur && (cur.type === 'vod' || cur.type === 'series' ||
            (cur.type === 'stalker' && (cur.stalkerKind === 'vod' || cur.stalkerKind === 'series')));
        if (isVodLike) {
            try {
                var pos = Player.getPosition();
                if (pos && pos.currentTime > 10 && pos.duration > 0) {
                    // Continue Watching for Stalker VOD was broken: player.js's play() only re-resolves
                    // a fresh Stalker stream URL when channel.url is falsy
                    // (tokens are ephemeral — see that function's own comment).
                    // But right before playback starts, it does
                    // "channel.url = url" on the SAME object cur now points
                    // at — so cur.url here is that one-time resolved URL, not
                    // empty. Saving it as-is meant a resumed Continue Watching
                    // card carried a non-empty (but already-expired) url,
                    // which made the !channel.url gate skip the resolve step
                    // entirely and try to play the stale token directly.
                    // Xtream has no equivalent bug: its url is genuinely
                    // stable and meant to be reused, which is exactly why
                    // Xtream seemed fine while only Stalker was broken. Cleared here so a resumed Stalker VOD/series
                    // item re-resolves exactly like a fresh play.
                    var isStalkerVodLike = cur.type === 'stalker' && (cur.stalkerKind === 'vod' || cur.stalkerKind === 'series');
                    Store.addVodHistory({
                        id: cur.id, name: cur.name, url: isStalkerVodLike ? '' : cur.url, logo: cur.logo,
                        type: cur.type, category: cur.category, playlistId: cur.playlistId,
                        playlistName: cur.playlistName, timestamp: Date.now(),
                        progress: pos.currentTime / pos.duration,
                        currentTime: pos.currentTime, duration: pos.duration,
                        // Stalker/MAG content resolves its stream per-play from these,
                        // so a resumed Stalker item can rebuild its URL.
                        stalkerKind: cur.stalkerKind, stalkerCmd: cur.stalkerCmd,
                        stalkerId: cur.stalkerId, stalkerGenreId: cur.stalkerGenreId,
                        stalkerEpisode: cur.stalkerEpisode
                    });
                }
            } catch (e) {}
        }
        Player.stop();
        closeMini();
        UI.showScreen('home');
        try { if (window.UI && UI.refreshVodProgressBars) UI.refreshVodProgressBars(); } catch (e2) {}

        // Check if episode modal was suspended
        if (UI.restoreSuspendedModal && UI.restoreSuspendedModal()) {
            window._lastSectionBeforePlayer = null;
            return;
        }

        // Restore section — memory handles focus
        var prevSection = window._lastSectionBeforePlayer || 'home';
        window._lastSectionBeforePlayer = null;
        UI.showSection(prevSection);

        // Returning from fullscreen Live TV should restore focus to the originating row only.
        // Do not auto-restart the mini player stream.
        setTimeout(function () {
            if (prevSection === 'livetv' && window.LiveTopMiniPlayer &&
                LiveTopMiniPlayer.currentChannel && LiveTopMiniPlayer.currentChannel()) {
                if (LiveTopMiniPlayer.prepareAfterFullReturn) LiveTopMiniPlayer.prepareAfterFullReturn();
                var lk = window._liveTvReturnFocusKey || (LiveTopMiniPlayer.lastFocusKey ? LiveTopMiniPlayer.lastFocusKey() : null);
                window._liveTvReturnFocusKey = null;
                if (lk) {
                    setTimeout(function () {
                        var ok = Focus.focusKey(lk);
                        if (!ok) {
                            var cl = document.getElementById('liveChList');
                            if (cl) Focus.focusFirstIn(cl);
                        }
                    }, 120);
                }
            }
        }, 120);
    }


    function openMini() {
        var m = $('#miniChannels');
        if (!m) return;
        UI.refreshMiniChannels(true);
        m.classList.add('show');
        state.miniOpen = true;
        Focus.pushScope(m);
        setTimeout(function () {
            var cur = Player.currentChannel();
            if (cur) {
                var found = Focus.focusKey('mini-' + cur.id);
                if (!found) Focus.focusFirstIn(m);
            } else {
                Focus.focusFirstIn(m);
            }
        }, 100);
    }
    function closeMini() {
        var m = $('#miniChannels');
        if (!m) return;
        m.classList.remove('show');
        if (state.miniOpen) Focus.popScope();
        state.miniOpen = false;
        state.miniClosedAt = Date.now();
    }

    /* ========== Public ========== */
    function ready() {
        if (state.booted) return;
        state.booted = true;
        boot();
    }

    return {
        ready: ready,
        updateEpgSummary: updateEpgSummary,
        activatePlaylist: activatePlaylist,
        playlistNeedsCreds: playlistNeedsCreds,
        setPlaylistContent: setPlaylistContent,
        setPlaylistEpg: setPlaylistEpg,
        deletePlaylist: deletePlaylist,
        refreshPlaylist: refreshPlaylist,
        refreshPlaylistEpg: refreshPlaylistEpg,
        editPlaylist: openManualEntryForEdit,
        goHome: goHome,
        goOnboarding: goOnboarding,
        closeMini: closeMini,
        updateCardCatName: updateCardCatName,
        updateLiveCardCatName: updateLiveCardCatName,
        isCatalogIndexing: function () { return !!state.catalogIndexing; },
        applyVideoScale: applyVideoScale
    };
})();

// Auto-boot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.ready(); });
} else {
    App.ready();
}
