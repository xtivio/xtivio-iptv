/* crypto.js — log redaction helper.
 *
 * HISTORY: this file used to hold an AES-GCM + PBKDF2 "obfuscation" layer that
 * encrypted playlist credentials before cloud sync. That was fully superseded by
 * zksync.js (real zero-knowledge, passphrase-derived key, never sent to the
 * server). CloudSync's push path now has three branches — ZK on+unlocked, ZK on
 * but locked, ZK off (shell-strip) — and none of them call this module. The whole
 * encrypt/decrypt/init/reset/isReady API had zero callers, so it was removed
 * rather than left to imply a second, weaker crypto scheme during store review.
 *
 * What remains is the one piece still in use: scrubUrl(), which redacts
 * credentials out of URLs before they reach debug logs. It is pure string work —
 * no WebCrypto, no keys, no storage. Called from epg.js and player.js.
 *
 * If credential-at-rest encryption is ever needed again, use ZKSync — do not
 * revive this.
 */
var Crypto = (function () {
    'use strict';

    // Classify an EPG URL as sensitive (carries provider credentials) vs a
    // shareable public guide link. Used to decide cloud-sync behaviour: a
    // sensitive URL must never sync in normal (shell) mode — only encrypted under
    // zero-knowledge — because it would otherwise sit in the cloud in the clear
    // with the user's provider credentials. A credential-free .xml/.xml.gz link
    // is safe to sync as a cross-device preference.
    //
    // Sensitive markers:
    //   - username= or password= query parameters (the Xtream xmltv.php form)
    //   - known provider endpoints (xmltv.php / player_api.php / get.php)
    //   - embedded path credentials (…/live|movie|series/<user>/<pass>/… or a
    //     bare …/<user>/<pass>/<streamid> pair), matched the same way scrubUrl does
    // A URL is treated as sensitive if scrubbing it would change it (i.e. it
    // contained something scrubUrl redacts), OR it hits a provider endpoint.
    function isSensitiveEpgUrl(url) {
        if (!url || typeof url !== 'string') return false;
        var u = url.replace(/^\s+|\s+$/g, '');
        if (!u) return false;
        // Provider API endpoints always carry (or imply) credentials.
        if (/\/(xmltv|player_api|get)\.php(\?|$)/i.test(u)) return true;
        // Any credential markers scrubUrl would redact -> sensitive.
        if (scrubUrl(u) !== u) return true;
        return false;
    }

    function scrubUrl(url) {
        if (!url || typeof url !== 'string') return url;
        var out = url
            .replace(/([?&])username=[^&]*/gi, '$1username=[REDACTED]')
            .replace(/([?&])password=[^&]*/gi, '$1password=[REDACTED]');
        // Stalker / MAG credentials and secrets, carried as query params on the
        // portal/stream URL (e.g. .../play/movie.php?mac=00:1A:79:..&play_token=..
        // &sn=..&type=movie). These identify/authenticate the device and MUST NOT
        // appear in logs or screenshots. Redact each known-sensitive param value.
        out = out
            .replace(/([?&])mac=[^&]*/gi, '$1mac=[REDACTED]')
            .replace(/([?&])(play_token|token)=[^&]*/gi, '$1$2=[REDACTED]')
            .replace(/([?&])(sn|sn2|serial)=[^&]*/gi, '$1$2=[REDACTED]')
            .replace(/([?&])(device_id|device_id2|dev_id|deviceid)=[^&]*/gi, '$1$2=[REDACTED]')
            .replace(/([?&])(stb_lang|stb_type|prehash|signature|sig|auth|password)=[^&]*/gi, '$1$2=[REDACTED]');
        // Bare MAC address anywhere in the URL (path form, not just a param),
        // e.g. .../stalker/00:1A:79:AA:BB:CC/... — redact the MAC pattern.
        out = out.replace(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/g, '[MAC]');
        // Typed path form: /<type>/<user>/<pass>/<rest> where type is a known
        // Xtream stream prefix. Redact the user+pass path segments.
        out = out.replace(
            /\/(live|movie|series)\/[^/]+\/[^/]+\//gi,
            '/$1/[REDACTED]/[REDACTED]/'
        );
        // Bare stream form: most Xtream live URLs have NO type segment —
        // host/<user>/<pass>/<streamid>[.ext] (this is what the player actually
        // streams). The typed rule above misses it, so the credentials would
        // otherwise appear in player debug logs. Match a two-segment user/pass
        // pair immediately before a final stream-id segment (digits, optionally
        // with an extension like .m3u8/.ts) at the end of the path/URL, and
        // redact the pair. Anchored to the stream-id + end so it doesn't touch
        // unrelated multi-segment paths.
        out = out.replace(
            /\/[^/]+\/[^/]+\/(\d+(?:\.[A-Za-z0-9]+)?)(?=$|[?#])/g,
            '/[REDACTED]/[REDACTED]/$1'
        );
        return out;
    }

    return {
        scrubUrl: scrubUrl,
        isSensitiveEpgUrl: isSensitiveEpgUrl
    };
})();
