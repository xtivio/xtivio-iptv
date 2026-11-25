/* remote.js - WebOS + Tizen + Titan OS TV remote keycode mapping
 *
 * Translates raw keydown events into semantic events:
 *   up, down, left, right, ok, back, play, pause, stop, menu, info,
 *   red, green, yellow, blue, 0..9, channel_up, channel_down
 *
 * Public API:
 *   Remote.init()
 *   Remote.on(name, cb)       -> register handler
 *   Remote.off(name, cb)
 *   Remote.emit(name, ev)
 *
 * Tizen requires registerKey() for color buttons, ChannelUp/Down etc.
 *
 * Titan OS (Philips / JVC) mostly follows the HTML5 keycode spec, so it shares
 * the arrows, Enter, digits, colours, play/pause/stop and PageUp/Down mappings
 * already present. Its notable differences, all handled below:
 *   - Back is BRAND-SPECIFIC: 8 (Philips) vs 461 (JVC). Both already mean
 *     'back' here, so no brand detection via the Titan SDK is needed.
 *   - Fast Forward reports as "MediaTrackNext", not "MediaFastForward".
 *   - Digits report as "Numpad0".."Numpad9", not "0".."9".
 *   - Their docs spell red as "ColorFORed" (letter O) where Tizen/WebOS use
 *     "ColorF0Red" (zero); both are mapped.
 * Titan swallows system keys (Settings, Source, Ambilight, branded app
 * buttons) before they reach the app, so there is nothing to map for those.
 * Listening on keydown only (see init) also satisfies Titan's guidance to avoid
 * binding keydown+keyup and double-firing.
 */
var Remote = (function () {
    'use strict';

    /* ---- Keycode tables ---- */

    // Standard browser + WebOS share most codes for arrows/enter/back.
    // WebOS-specific: 461 = Back. Color/play/etc map below.
    var KEY_MAP = {
        // Arrows
        37: 'left', 38: 'up', 39: 'right', 40: 'down',
        // OK / Enter
        13: 'ok',
        // Back (browser BackSpace + WebOS 461 + Tizen 10009)
        8: 'back',
        27: 'back',
        461: 'back',
        10009: 'back',
        // Numerics
        48: '0', 49: '1', 50: '2', 51: '3', 52: '4',
        53: '5', 54: '6', 55: '7', 56: '8', 57: '9',
        96: '0', 97: '1', 98: '2', 99: '3', 100: '4',
        101: '5', 102: '6', 103: '7', 104: '8', 105: '9',
        // Media keys (HTML5 spec)
        415: 'play',         // VK_PLAY
        19:  'pause',        // VK_PAUSE
        413: 'stop',         // VK_STOP
        10252: 'play_pause', // Tizen play/pause toggle
        // Color buttons (Tizen / WebOS)
        403: 'red',
        404: 'green',
        405: 'yellow',
        406: 'blue',
        // Channel up/down - multiple mappings for different remotes
        427: 'channel_up',
        428: 'channel_down',
        33:  'channel_up',   // PageUp (common mapping on newer remotes)
        34:  'channel_down', // PageDown
        166: 'channel_up',   // alternate VK_CHANNEL_UP
        167: 'channel_down', // alternate VK_CHANNEL_DOWN
        // Titan OS (Philips / JVC and other Titan sets). Most Titan codes are
        // already covered above because they follow the HTML5 keycode spec —
        // arrows 37-40, Enter 13, digits 48-57, colours 403-406, play 415,
        // pause 19, stop 413, PageUp/Down 33/34 all match. Titan's Back is
        // BRAND-SPECIFIC: 8 on Philips, 461 on JVC. Both already map to 'back'
        // (8 as browser Backspace, 461 as the WebOS Back), so no brand detection
        // is needed here — the same semantic event is emitted either way.
        // These three are the genuine additions:
        179: 'play_pause',   // VK_PLAY_PAUSE (normalised to 'play' below)
        417: 'fast_fwd',     // VK_FAST_FWD
        412: 'rewind',       // VK_REWIND
        // Info / Menu
        457: 'info',
        18:  'menu',         // Alt
        82:  'menu',         // r as menu fallback for desktop testing (also
                             //   Android KEYCODE_MENU forwards here from the shell)
        // Android TV / Google TV (WebView shell).
        // The native shell (MainActivity dispatchKeyEvent) translates Android
        // KeyEvent codes into the browser keyCodes this map already understands,
        // so most D-pad/OK/media keys arrive as 37-40 / 13 / 415 etc. above and
        // need no new entries. The genuinely Android-specific case is BACK:
        // Android KEYCODE_BACK (4) is delivered to the WebView as keyCode 4 when
        // the shell forwards it as a synthetic keydown, so map it to 'back'.
        // (When the shell instead handles BACK natively it calls
        // AndroidBridge.onBack()/history — either way 'back' semantics hold.)
        4:   'back',
        // Some Android WebView builds surface the D-pad centre as 23
        // (KEYCODE_DPAD_CENTER) rather than Enter(13); map it to 'ok'.
        23:  'ok'
    };

    // Keys to silently ignore (no console warning)
    var IGNORE_KEYS = { 1536: true, 1537: true }; // WebOS magic remote pointer/cursor keys

    // Map by code/key strings (some platforms emit string key)
    var KEY_NAME_MAP = {
        'ArrowLeft': 'left', 'ArrowRight': 'right',
        'ArrowUp': 'up', 'ArrowDown': 'down',
        'Enter': 'ok',
        'Backspace': 'back', 'Escape': 'back', 'XF86Back': 'back',
        'MediaPlay': 'play', 'MediaPause': 'pause', 'MediaStop': 'stop',
        'MediaPlayPause': 'play_pause',
        'ColorF0Red': 'red', 'ColorF1Green': 'green',
        'ColorF2Yellow': 'yellow', 'ColorF3Blue': 'blue',
        // Titan OS documents the red button as "ColorFORed" — letter O rather
        // than the zero used by the Tizen/WebOS "ColorF0Red". That is likely a
        // typo in their docs, but mapping BOTH costs nothing and means the red
        // button works whichever spelling the device actually emits.
        'ColorFORed': 'red',
        // Titan media keys. Note Titan reports Fast Forward as
        // "MediaTrackNext" (not MediaFastForward) — a real difference from
        // Tizen, so both names are mapped.
        'MediaRewind': 'rewind',
        'MediaFastForward': 'fast_fwd',
        'MediaTrackNext': 'fast_fwd',
        'MediaTrackPrevious': 'rewind',
        // Titan emits digits as Numpad0..Numpad9 rather than "0".."9".
        'Numpad0': '0', 'Numpad1': '1', 'Numpad2': '2', 'Numpad3': '3',
        'Numpad4': '4', 'Numpad5': '5', 'Numpad6': '6', 'Numpad7': '7',
        'Numpad8': '8', 'Numpad9': '9',
        'ChannelUp': 'channel_up', 'ChannelDown': 'channel_down',
        'PageUp': 'channel_up', 'PageDown': 'channel_down',
        'Info': 'info'
    };

    // Tizen-only key names that require explicit registration.
    // 'Exit' is deliberately NOT registered: Samsung's terminating-applications
    // guide says not to register the Return/Exit key long-press, because the
    // platform uses it to force-terminate the app. Registering it would hand the
    // key to the app, which does nothing with it, so a long press would stop
    // closing the app. Return itself (10009) needs no registration.
    var TIZEN_REGISTER_KEYS = [
        'MediaPlay', 'MediaPause', 'MediaStop', 'MediaPlayPause',
        'MediaFastForward', 'MediaRewind',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
        'ChannelUp', 'ChannelDown', 'Info',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    ];

    /* ---- Listener registry ---- */
    var LISTENERS = {};

    function on(name, cb) {
        if (!LISTENERS[name]) LISTENERS[name] = [];
        LISTENERS[name].push(cb);
    }
    function off(name, cb) {
        if (!LISTENERS[name]) return;
        for (var i = 0; i < LISTENERS[name].length; i++) {
            if (LISTENERS[name][i] === cb) { LISTENERS[name].splice(i, 1); return; }
        }
    }
    function emit(name, ev) {
        if (!LISTENERS[name]) return;
        for (var i = 0; i < LISTENERS[name].length; i++) {
            try { LISTENERS[name][i](ev); } catch (e) { Util.logErr('Remote.emit ' + name, e); }
        }
    }

    /* ---- Tizen feature-detection registration ---- */
    function registerTizenKeys() {
        try {
            if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
            // getSupportedKeys is required to know what we're allowed to register
            var supported = [];
            try { supported = tizen.tvinputdevice.getSupportedKeys() || []; } catch (e) {}
            var supportedNames = {};
            for (var i = 0; i < supported.length; i++) {
                if (supported[i] && supported[i].name) supportedNames[supported[i].name] = true;
            }
            for (var j = 0; j < TIZEN_REGISTER_KEYS.length; j++) {
                var k = TIZEN_REGISTER_KEYS[j];
                if (!supportedNames[k]) continue;
                try { tizen.tvinputdevice.registerKey(k); }
                catch (e) { Util.logErr('Tizen registerKey failed for ' + k, e); }
            }
            Util.log('Tizen keys registered');
        } catch (e) {
            Util.logErr('registerTizenKeys', e);
        }
    }

    /* ---- Event handler ---- */
    function handleKeydown(ev) {
        // A physical keyboard types into the on-screen keyboard's field (see UI.vkPhysicalKey).
        try { if (window.UI && UI.vkPhysicalKey && UI.vkPhysicalKey(ev)) return; } catch (ePk) {}
        var name = null;
        if (ev.keyCode != null && KEY_MAP[ev.keyCode]) name = KEY_MAP[ev.keyCode];
        else if (ev.key && KEY_NAME_MAP[ev.key]) name = KEY_NAME_MAP[ev.key];
        else if (ev.keyIdentifier && KEY_NAME_MAP[ev.keyIdentifier]) name = KEY_NAME_MAP[ev.keyIdentifier];

        // Treat play_pause as 'play' (player can toggle)
        if (name === 'play_pause') name = 'play';

        // Fast-forward / rewind (Titan OS 417 / 412, and the Tizen media keys)
        // are mapped onto the SAME events the player already uses for seeking:
        // left/right already call Player.seekRelative() when the player is open.
        // Emitting a distinct 'fast_fwd'/'rewind' event would be dead — nothing
        // in the app listens for those names — so the buttons would appear to do
        // nothing. Normalising here means the transport keys work on day one
        // without touching the player's key handling.
        if (name === 'fast_fwd') name = 'right';
        else if (name === 'rewind') name = 'left';

        // Log unrecognized keys so user can report remote keycodes
        if (!name) {
            if (!IGNORE_KEYS[ev.keyCode] && window.console && console.log) {
                Log.log('[Remote] unmapped key: keyCode=' + ev.keyCode + ' key="' + ev.key + '" code="' + ev.code + '"');
            }
            return;
        }

        // Don't intercept text typing in real text inputs
        var t = ev.target;
        var isTyping = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') &&
                       t.type !== 'checkbox' && t.type !== 'radio';
        // For text fields: allow typing (don't preventDefault) but still emit
        // back/up/down/left/right/ok for navigation.
        if (isTyping && (name === '0' || name === '1' || name === '2' || name === '3' ||
            name === '4' || name === '5' || name === '6' || name === '7' || name === '8' || name === '9')) {
            return; // let the keystroke type
        }
        // Smart text field navigation:
        // - backspace: if field is empty, treat as 'back' navigation; otherwise let input handle it
        // - left: if cursor at position 0, navigate left; otherwise let input handle it
        // - right: if cursor at end, navigate right; otherwise let input handle it
        // - up/down/ok: always navigate
        if (isTyping) {
            var val = t.value || '';
            var curPos = t.selectionStart != null ? t.selectionStart : val.length;
            var curEnd = t.selectionEnd != null ? t.selectionEnd : val.length;

            if (name === 'back') {
                if (val.length === 0) {
                    // Empty field: treat backspace as navigation back
                    ev.preventDefault();
                } else {
                    // Has content: let backspace delete normally
                    return;
                }
            }
            if (name === 'left') {
                if (curPos === 0 && curEnd === 0) {
                    // At start: navigate left (to sidebar etc)
                    ev.preventDefault();
                } else {
                    return; // move cursor within text
                }
            }
            if (name === 'right') {
                if (curPos >= val.length) {
                    // At end: navigate right
                    ev.preventDefault();
                } else {
                    return; // move cursor within text
                }
            }
            // Up/down/ok always navigate away
            if (name === 'ok' || name === 'up' || name === 'down') {
                ev.preventDefault();
            }
        } else {
            ev.preventDefault();
        }

        emit(name, ev);
        emit('any', { name: name, ev: ev });
    }

    function init() {
        registerTizenKeys();
        document.addEventListener('keydown', handleKeydown, true);
        Util.log('Remote initialized');
    }

    return {
        init: init,
        on: on,
        off: off,
        emit: emit,
        _KEY_MAP: KEY_MAP   // for debugging
    };
})();
