/* server.js - Pairing relay for Xtivio
 *
 * The TV app polls this server with a short pairing code; a separate web
 * page (or phone) posts a playlist payload against that code; the TV
 * receives it on its next poll.
 *
 * Endpoints (the TV-facing contract is fixed by api.js on the TV side):
 *   POST   /api/pair               { deviceId, ttl } -> { code, expiresAt }
 *   GET    /api/pair/:code         -> { status: 'pending'|'completed', payload? }
 *   DELETE /api/pair/:code         -> 204 (consume / close the session)
 *
 * Phone/web client uses:
 *   GET    /api/pair/:code/info    -> { exists: true, status, expiresAt } (no payload, no deviceId)
 *   POST   /api/pair/:code/submit  { type, name, url|host, user?, pass?, epgUrl? }
 *                                  -> { ok: true }
 *   POST   /api/upload             body: file text, X-Filename hdr -> { url, expiresInSec }
 *   GET    /uploads/:token         -> raw playlist
 *
 * Sessions and uploads live in memory with TTL. A janitor sweeps expired
 * entries every 30 seconds. For multi-instance deployments swap this for
 * Redis.
 */

'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
// Single source of truth for the reported version — avoids the recurring
// stale-version bug where the /healthz string lagged the package version.
const pkg = require('./package.json');

const PORT = parseInt(process.env.PORT || '9595', 10);
const HOST = process.env.HOST || '0.0.0.0';

/* V9 TTL changes.
 * Pairing code: 5min → 2min. A pairing code is exposed on-screen and
 *   sniffable from the network if the TV is on a hostile LAN. 2min is
 *   long enough for a relaxed scan-and-type, short enough that an
 *   exposed code is dead by the time anyone could exploit it.
 * Hard ceiling 5min (was 30min) — clients can't request longer TTLs.
 * Completed grace 60s unchanged — TV polls every ~2s so one more poll
 *   after completion is plenty.
 * Custom token (minted by Firebase Admin) — Firebase fixes this at 1hr;
 *   not configurable server-side. Reducing pair TTL to 2min effectively
 *   limits the window in which a minted token can be retrieved by the TV. */
const DEFAULT_TTL_MS = 2 * 60 * 1000;        // 2 minutes (was 5)
const MAX_TTL_MS = 5 * 60 * 1000;            // hard ceiling (was 30)
const COMPLETED_GRACE_MS = 60 * 1000;
const JANITOR_INTERVAL_MS = 30 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

// Single source of truth for the Firebase web config injected into BOTH
// server-rendered pages (landing + auth-action). It is emitted as a JS literal
// string and interpolated into each page's inline <script>. The values come from
// the deployment, not the source: set FIREBASE_WEB_CONFIG to the JSON object from
// your Firebase console (Project settings > Your apps > Web app), or put that JSON
// in firebase-web-config.json next to this file. The apiKey is a public web key,
// not a secret (see README security notes). Without a config the pages still load
// but sign-in is unavailable.
function loadFirebaseWebConfig() {
  let raw = process.env.FIREBASE_WEB_CONFIG || '';
  if (!raw) {
    try { raw = fs.readFileSync(path.join(__dirname, 'firebase-web-config.json'), 'utf8'); }
    catch (e) { raw = ''; }
  }
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    console.warn('FIREBASE_WEB_CONFIG is not valid JSON; sign-in disabled');
    return {};
  }
}
const FIREBASE_WEB_CONFIG = loadFirebaseWebConfig();
// "<" is escaped so a value can never close the inline script block.
const FIREBASE_CFG_JS = JSON.stringify(FIREBASE_WEB_CONFIG).replace(/</g, '\\u003c');

// Version of the pairing-payload contract. Sent alongside every completed
// payload so the TV app can refuse a payload it doesn't understand (a payload
// older or newer than it supports) — defensive against a compromised or buggy
// server even though this one is self-hosted. Bump when the payload shape
// changes in a way the app must gate on.
const PAYLOAD_SCHEMA_VERSION = 1;

// ---- Upload limits ----
// 5 min, same ceiling as a pairing code. The hosted-file endpoint is no longer used
// by the pairing page (v24) or the app, and an uploaded file can contain credentials,
// so it should not outlive a pairing session by much.
const UPLOAD_TTL_MS = 5 * 60 * 1000;
const UPLOAD_MAX_SIZE = 5 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
let uploadBytesUsed = 0;

/* CORS allowlist for browser callers. TV apps connect
 * with no Origin (file:// or appid://), which we allow unconditionally.
 * Browser origins must be in this list to get CORS headers; mismatches
 * silently get no headers (browser then blocks the request — fail-safe
 * default). Add your own domains with CORS_ALLOWED_ORIGINS (comma separated).
 *
 * Note: the pairing portal itself is served BY this server and calls the
 * API with relative paths (same-origin), so it never depends on this list.
 * This list only matters for a browser on a DIFFERENT origin. */
const CORS_ALLOWED_ORIGINS = [
    'http://localhost:9595',
    'http://localhost:3000',
    'http://127.0.0.1:9595'
].concat((process.env.CORS_ALLOWED_ORIGINS || '').split(',')
    .map(function (o) { return o.trim(); }).filter(Boolean));

// ---- Firebase Admin SDK ----
// We use the Admin SDK strictly to mint custom tokens. The browser does the
// real auth work (createUserWithEmailAndPassword / signInWithEmailAndPassword
// / sendEmailVerification); we take the resulting ID token, verify it, then
// hand the TV a custom token that signInWithCustomToken() can consume.
//
// The service-account JSON is loaded ONCE at boot. If it's missing or
// malformed we log a clear warning and leave the auth endpoint DISABLED but
// still start the server — playlists pairing and file upload keep working.
let firebaseAdmin = null;
let firebaseAuthReady = false;
let firebaseInitError = null;
(function initFirebaseAdmin() {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        || path.join(__dirname, 'firebase-service-account.json');
    if (!fs.existsSync(saPath)) {
        firebaseInitError = 'service account file not found at ' + saPath;
        console.warn('[firebase] ' + firebaseInitError + ' — auth endpoint will return 503.');
        console.warn('[firebase] Drop a service-account JSON at that path (see README) and restart to enable sign-in / sign-up via the pairing page.');
        return;
    }
    let serviceAccount;
    try {
        serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    } catch (e) {
        firebaseInitError = 'service account JSON parse failed: ' + e.message;
        console.warn('[firebase] ' + firebaseInitError + ' — auth endpoint will return 503.');
        return;
    }
    try {
        // Lazy-require so a missing firebase-admin package doesn't kill the
        // whole process — server still pairs playlists, just no auth.
        // eslint-disable-next-line global-require
        // firebase-admin 14 dropped the namespaced API (admin.credential / admin.auth()), so use the modular
        // entry points and keep a tiny wrapper so the routes below can keep calling firebaseAdmin.auth().
        const fbApp = require('firebase-admin/app');
        const fbAuth = require('firebase-admin/auth');
        fbApp.initializeApp({ credential: fbApp.cert(serviceAccount) });
        firebaseAdmin = { auth: function () { return fbAuth.getAuth(); } };
        firebaseAuthReady = true;
        console.log('[firebase] Admin SDK ready (project=' + (serviceAccount.project_id || '?') + ')');
    } catch (e) {
        firebaseInitError = 'admin SDK init failed: ' + (e && e.message);
        console.warn('[firebase] ' + firebaseInitError + ' — auth endpoint will return 503.');
        firebaseAdmin = null;
    }
})();

const app = express();

/* Security hardening.
 *
 * 1. trust proxy: needed for express-rate-limit + correct X-Forwarded-*
 *    handling when running behind Caddy / nginx / Cloudflare. Without
 *    this, every request looks like it's from the local proxy IP and
 *    rate-limiting is useless. Value `1` = trust ONE hop (your reverse
 *    proxy); don't use `true` which trusts arbitrary chains.
 * 2. helmet: standard security headers (X-Frame-Options, no-sniff,
 *    referrer policy, etc.). CSP is set to a permissive value because
 *    the embedded landing page uses inline scripts; tightening CSP is
 *    its own project.
 * 3. CORS: allowlist of browser origins, no-Origin requests pass
 *    through (TV apps have no Origin).
 * 4. Rate limiters: applied per-route below.
 * 5. Body parsers: same as v8 (JSON 64kb, text up to UPLOAD_MAX_SIZE). */
app.set('trust proxy', 1);
app.disable('x-powered-by');

const helmet = require('helmet');
const pageCsp = require('./page-csp');
app.use(helmet({
    // helmet's CSP stays off: the two HTML pages send their own per-request, nonce-based policy (page-csp.js);
    // the JSON API needs none.
    contentSecurityPolicy: false,
    // crossOriginEmbedderPolicy off — would break <img> from external
    // hosts (images may come from other hosts).
    crossOriginEmbedderPolicy: false,
    // CrossOriginResourcePolicy MUST be disabled. The API serves
    // cross-origin callers (TV apps at file:// / appid://). CORP
    // same-origin blocks the response before CORS even evaluates —
    // clients saw ERR_BLOCKED_BY_RESPONSE on every /api/pair request.
    // CORP and CORS are different things; CORP gates delivery, CORS
    // gates reads. CORS configured below handles cross-origin properly;
    // CORP was redundant and overly strict.
    crossOriginResourcePolicy: false,
    // crossOriginOpenerPolicy is fine to leave at default; doesn't
    // affect API responses.
}));

app.use(cors({
    origin: function (origin, callback) {
        // No-origin requests: TV apps (file:// or appid:// have no Origin
        // per spec, and many native HTTP clients omit it). Allow them —
        // there's no way to distinguish "TV app" from "malicious script"
        // at this layer anyway; the actual auth happens at the pairing
        // code level (random 6-char codes, 2min TTL, one-time use).
        if (!origin) return callback(null, true);
        // Origin: "null" (the literal string). Android's WebView — and any
        // file:// / opaque-origin context — does NOT omit Origin; it sends
        // the string "null". That's the Android TV app calling in (it loads
        // from file:///android_asset/web/), so treat it exactly like a
        // no-origin TV request and allow it. Without this, Android pairing/
        // stalker calls silently get no CORS headers and the WebView blocks
        // them. Same security reasoning as above: the pairing code is the
        // real gate, not the Origin. (Requests are not credentialed — no
        // cookies — so echoing this back is safe.)
        if (origin === 'null') return callback(null, true);
        if (CORS_ALLOWED_ORIGINS.indexOf(origin) >= 0) return callback(null, true);
        // Mismatch: pass false (cors lib will omit headers, browser will
        // block). DON'T throw — that returns 500 to the client which
        // leaks info. Silent failure is safer.
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Filename'],
    maxAge: 600 // cache preflight for 10min
}));

// Global JSON parser stays small (64kb) for every endpoint EXCEPT the pairing
// submit, which has its own larger parser (an uploaded M3U is embedded in the
// payload). Skipping here avoids the global parser rejecting the big body first.
var globalJson = express.json({ limit: '64kb' });
app.use(function (req, res, next) {
    if (req.method === 'POST' && /^\/api\/pair\/[^/]+\/submit$/.test(req.path)) return next();
    return globalJson(req, res, next);
});
app.use(express.text({
    type: ['text/plain', 'text/*', 'application/octet-stream'],
    limit: UPLOAD_MAX_SIZE
}));

/* Per-route rate limiters.
 *
 * Numbers chosen to fit normal usage:
 *   - Pairing create: 10/min — one user creates ~1 code per attempt;
 *     10 covers manual retries without enabling code exhaustion.
 *   - Pairing poll:   120/min — TV polls every 2s = 30/min legit, plus
 *     headroom for slow polls and multiple devices behind one NAT.
 *   - Pairing submit: 20/min — one submit per pair; 20 covers retries.
 *   - Pairing info:   60/min — phone may refresh; 60 is generous.
 *   - Mint:           10/min — one mint per sign-in; 10 covers retries.
 *   - Upload:         5/min  — uploads are expensive (file storage).
 *   - Subtitles:      30/min — per-VOD-open lookups; one user might
 *     open the picker 30 times in a movie session.
 *   - Subtitle file:  60/min — one fetch per chosen language.
 *
 * Failures return 429 with Retry-After. Skip on failed-CORS preflights
 * (those never reach the route handler anyway).
 * standardHeaders + legacyHeaders=false uses RFC-compliant
 * RateLimit-* headers. */
const rateLimit = require('express-rate-limit');
function limiter(maxPerMin, label) {
    return rateLimit({
        windowMs: 60 * 1000,
        max: maxPerMin,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Rate limit exceeded. Try again shortly.', limit: label },
        // Keyed by IP; behind a proxy uses X-Forwarded-For thanks to
        // trust proxy = 1. Don't key by deviceId — clients control that
        // field and could rotate to evade limits.
        skip: function (req) {
            // Skip OPTIONS preflight so browsers can negotiate freely
            return req.method === 'OPTIONS';
        }
    });
}
const limPairCreate = limiter(10, 'pair-create');
const limPairPoll = limiter(120, 'pair-poll');
const limPairSubmit = limiter(20, 'pair-submit');
const limPairInfo = limiter(60, 'pair-info');
const limMint = limiter(10, 'mint');
const limUpload = limiter(5, 'upload');
// ============== In-memory session store ==============
// code -> { deviceId, status, payload, createdAt, expiresAt, completedAt }
const sessions = new Map();

// ============== In-memory upload store ==============
// token -> { body, filename, contentType, createdAt }
const uploads = new Map();

function genCode() {
    const buf = crypto.randomBytes(CODE_LEN);
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
        s += CODE_CHARS[buf[i] % CODE_CHARS.length];
    }
    return s;
}

function freshCode() {
    // Avoid collision; a few tries is plenty given 32^6 = ~1B space.
    for (let i = 0; i < 8; i++) {
        const c = genCode();
        if (!sessions.has(c)) return c;
    }
    return genCode() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function genUploadToken() {
    return crypto.randomBytes(16).toString('hex');
}

function uploadContentType(filename) {
    const lower = (filename || '').toLowerCase();
    if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (lower.endsWith('.m3u')) return 'audio/x-mpegurl';
    if (lower.endsWith('.pls')) return 'audio/x-scpls';
    return 'text/plain; charset=utf-8';
}

const ALLOWED_UPLOAD_EXTS = ['.m3u', '.m3u8', '.pls', '.txt'];
function hasAllowedExt(name) {
    const n = (name || '').toLowerCase();
    return ALLOWED_UPLOAD_EXTS.some(ext => n.endsWith(ext));
}

/* Defence-in-depth for the X-Filename header on the
 * upload endpoint. The filename is used in:
 *   - the upload session record (for content-disposition on download)
 *   - log lines
 *   - eventual content-type inference (via extension)
 * It is NOT used to construct a filesystem path — uploads live in
 * memory and are served by random token. Still, a malicious filename
 * like '../../etc/passwd\x00.m3u' could mislead log analysis or
 * (if a future change writes the file to disk) escape the upload
 * dir. We:
 *   - decode percent-encoding ONCE (already done in handler)
 *   - reject control characters and null bytes
 *   - reduce to the basename (no slashes, no backslashes)
 *   - cap length to 200 chars
 *   - require it to still match an allowed extension after stripping
 * Returns the cleaned filename, or null if it can't be made safe. */
function sanitizeFilename(raw) {
    if (typeof raw !== 'string' || !raw.length) return null;
    // Reject ANY non-printable (incl. null \x00 which truncates in some C-level APIs)
    if (/[\x00-\x1F\x7F]/.test(raw)) return null;
    // Strip path separators — keep only the basename
    let name = raw.replace(/\\/g, '/').split('/').pop() || '';
    // Strip leading dots that could create "hidden" files on unix
    name = name.replace(/^\.+/, '');
    // Truncate
    if (name.length > 200) name = name.slice(-200);
    if (!name.length) return null;
    if (!hasAllowedExt(name)) return null;
    return name;
}

function janitor() {
    const now = Date.now();
    let removed = 0;
    for (const [code, s] of sessions) {
        if (s.status === 'completed') {
            if (now - s.completedAt > COMPLETED_GRACE_MS) {
                sessions.delete(code);
                removed++;
            }
        } else if (now > s.expiresAt) {
            sessions.delete(code);
            removed++;
        }
    }
    let uploadsRemoved = 0;
    for (const [token, u] of uploads) {
        if (now - u.createdAt > UPLOAD_TTL_MS) {
            // Decrement by the same UTF-8 byte count used when incrementing, so
            // the accounting can't drift. Fall back to a byte recompute for any
            // record written before this field existed.
            uploadBytesUsed -= (typeof u.byteLen === 'number')
                ? u.byteLen
                : Buffer.byteLength(u.body || '', 'utf8');
            uploads.delete(token);
            uploadsRemoved++;
        }
    }
    if (uploadBytesUsed < 0) uploadBytesUsed = 0;
    if (removed || uploadsRemoved) {
        console.log(`[janitor] removed ${removed} sessions, ${uploadsRemoved} uploads; ${sessions.size} sessions / ${uploads.size} uploads remain`);
    }
}
setInterval(janitor, JANITOR_INTERVAL_MS).unref();

// ============== Validation ==============
// Shared validator for the optional __auth piggyback.
// Returns an error string or null. Permissive on size (4 KB is plenty for
// a Firebase custom token, which is a signed JWT ~700-1200 chars).
function validateAuthSub(a) {
    if (a === undefined || a === null) return null;
    if (typeof a !== 'object') return 'must be an object';
    if (typeof a.customToken !== 'string' || !a.customToken) return 'customToken required';
    if (a.customToken.length > 4096) return 'customToken too large';
    if (a.email !== undefined && typeof a.email !== 'string') return 'email must be string';
    if (a.uid !== undefined && typeof a.uid !== 'string') return 'uid must be string';
    return null;
}

function validatePayload(p) {
    if (!p || typeof p !== 'object') return 'payload required';

    // Optional __auth piggyback on any payload. The browser
    // signs in via Firebase, exchanges the ID token for a custom token via
    // /api/mint-custom-token, and bundles the result here. The TV's pair
    // handler will sign in first, then process the rest of the payload
    // (which may be the empty "just sign in" payload, a playlist, an EPG
    // update, etc.).
    const authErr = validateAuthSub(p.__auth);
    if (authErr) return '__auth: ' + authErr;

    // Special: action='sync-only' is the "I just want to push my session
    // to the TV" submit — must carry __auth, must not carry anything else.
    if (p.action === 'sync-only') {
        if (!p.__auth) return 'sync-only requires __auth';
        return null;
    }

    // Legacy alias. The earlier draft used this action name
    // on its own; new code uses __auth on any payload (or action='sync-only'
    // when there is no other payload). Accepted for backwards compatibility.
    if (p.action === 'sync-customtoken-signin') {
        if (typeof p.customToken !== 'string' || !p.customToken) return 'customToken required';
        if (p.customToken.length > 4096) return 'customToken too large';
        if (p.email && typeof p.email !== 'string') return 'email must be string';
        return null;
    }

    // EPG-only payload from the "External EPG" tab.
    // Up to 3 URLs (each empty or http(s)) + an override flag. All-blank
    // is valid — it clears the TV's EPG slots, matching the in-app modal.
    if (p.action === 'set-external-epg') {
        if (!Array.isArray(p.externalEpgUrls)) return 'externalEpgUrls must be an array';
        if (p.externalEpgUrls.length > 3) return 'externalEpgUrls must have at most 3 entries';
        for (var i = 0; i < p.externalEpgUrls.length; i++) {
            var u = p.externalEpgUrls[i];
            if (typeof u !== 'string') return 'externalEpgUrls[' + i + '] must be string';
            if (u && !/^https?:\/\//i.test(u)) return 'externalEpgUrls[' + i + '] must be http(s) or empty';
        }
        if (p.externalEpgOverride && p.externalEpgOverride !== 'on' && p.externalEpgOverride !== 'off') {
            return 'externalEpgOverride must be "on" or "off"';
        }
        // Optional per-URL Basic-auth, index-aligned with externalEpgUrls.
        if (p.externalEpgAuth !== undefined) {
            if (!Array.isArray(p.externalEpgAuth)) return 'externalEpgAuth must be an array';
            if (p.externalEpgAuth.length > 3) return 'externalEpgAuth must have at most 3 entries';
            for (var ai = 0; ai < p.externalEpgAuth.length; ai++) {
                var a = p.externalEpgAuth[ai];
                if (a === null) continue;
                if (typeof a !== 'object') return 'externalEpgAuth[' + ai + '] must be object or null';
                if (a.user !== undefined && typeof a.user !== 'string') return 'externalEpgAuth[' + ai + '].user must be string';
                if (a.pass !== undefined && typeof a.pass !== 'string') return 'externalEpgAuth[' + ai + '].pass must be string';
                if ((typeof a.user === 'string' && a.user.length > 512) || (typeof a.pass === 'string' && a.pass.length > 512)) return 'externalEpgAuth[' + ai + '] too long';
            }
        }
        return null;
    }

    // Existing playlist payload validation.
    if (p.type !== 'm3u' && p.type !== 'xtream' && p.type !== 'stalker') return 'type must be m3u, xtream, or stalker';
    if (typeof p.name !== 'string' || !p.name.trim()) return 'name required';
    if (p.type === 'm3u') {
        // An M3U playlist is delivered one of two ways:
        //   - inline content: the uploaded file text embedded in the payload
        //     (preferred for uploads — the TV gets the file, no server URL), or
        //   - url: a remote M3U the TV fetches itself (user-entered URL).
        // Require exactly the data for one of these.
        var hasContent = typeof p.content === 'string' && p.content.length > 0;
        var hasUrl = typeof p.url === 'string' && /^https?:\/\//i.test(p.url);
        if (!hasContent && !hasUrl) return 'm3u requires content or an http(s) url';
        if (hasContent) {
            if (p.content.length > UPLOAD_MAX_SIZE) return 'content too large (max 5 MB)';
            if (p.url !== undefined && typeof p.url !== 'string') return 'url must be string';
        }
        if (p.epgUrl && typeof p.epgUrl !== 'string') return 'epgUrl must be string';
        // Optional Basic-auth credentials (playlist URL + EPG URL), each a string.
        var authKeys = ['authUser', 'authPass', 'epgAuthUser', 'epgAuthPass'];
        for (var ak = 0; ak < authKeys.length; ak++) {
            var akv = p[authKeys[ak]];
            if (akv !== undefined && typeof akv !== 'string') return authKeys[ak] + ' must be string';
            if (typeof akv === 'string' && akv.length > 512) return authKeys[ak] + ' too long';
        }
    } else if (p.type === 'stalker') {
        // Stalker/MAG portal: portal URL + MAC address. Some portals also
        // require the box serial number and device ID — optional here.
        if (typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url)) return 'url must be http(s)';
        if (typeof p.mac !== 'string' || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(p.mac)) {
            return 'mac must be AA:BB:CC:DD:EE:FF';
        }
        if (p.serial !== undefined && p.serial !== null) {
            if (typeof p.serial !== 'string') return 'serial must be a string';
            if (p.serial.length > 64) return 'serial too long';
        }
        if (p.deviceId !== undefined && p.deviceId !== null) {
            if (typeof p.deviceId !== 'string') return 'deviceId must be a string';
            if (p.deviceId.length > 128) return 'deviceId too long';
        }
        if (p.stbModel !== undefined && p.stbModel !== null && p.stbModel !== '') {
            if (typeof p.stbModel !== 'string') return 'stbModel must be a string';
            if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(p.stbModel)) return 'stbModel: letters, digits, space . _ - only (max 32)';
        }
    } else {
        if (typeof p.host !== 'string' || !/^https?:\/\//i.test(p.host)) return 'host must be http(s)';
        if (typeof p.user !== 'string' || !p.user) return 'user required';
        if (typeof p.pass !== 'string' || !p.pass) return 'pass required';
    }
    // Optional contentTypes. If present, must be a plain object with
    // boolean live/movies/series fields and at least one true. Unknown
    // keys are tolerated — the TV's Store.setContentTypes ignores them.
    if (p.contentTypes !== undefined) {
        if (!p.contentTypes || typeof p.contentTypes !== 'object' || Array.isArray(p.contentTypes)) {
            return 'contentTypes must be an object';
        }
        var ct = p.contentTypes;
        if (typeof ct.live !== 'boolean') return 'contentTypes.live must be boolean';
        if (typeof ct.movies !== 'boolean') return 'contentTypes.movies must be boolean';
        if (typeof ct.series !== 'boolean') return 'contentTypes.series must be boolean';
        if (!ct.live && !ct.movies && !ct.series) return 'contentTypes: at least one must be true';
    }
    // Optional epgEnabled: per-playlist EPG toggle. Boolean (or absent). When
    // false, the TV won't load a guide for the paired playlist. Absent = the
    // TV's default (enabled).
    if (p.epgEnabled !== undefined && typeof p.epgEnabled !== 'boolean') {
        return 'epgEnabled must be boolean';
    }
    return null;
}

function looksLikeCode(c) {
    return typeof c === 'string' && c.length >= 4 && c.length <= 16 && /^[A-Z0-9]+$/.test(c);
}

// Mask identifiers before they reach logs. Covers MAC addresses (12 hex with
// optional : or - separators) and bare 12+-hex tokens by keeping only the
// first and last couple of characters, and partially masks email local-parts.
// Keeps logs useful for correlation without writing full identifiers to disk.
function redactId(v) {
    if (v == null) return v;
    var s = String(v);
    // email: keep first char of local part + domain
    var at = s.indexOf('@');
    if (at > 0) {
        var local = s.slice(0, at);
        var dom = s.slice(at);
        return (local.length <= 1 ? local : local[0] + '***') + dom;
    }
    // MAC or 12+-hex identifier: strip separators, keep head/tail
    var hex = s.replace(/[:\-]/g, '');
    if (/^[0-9A-Fa-f]{12,}$/.test(hex)) {
        return s.slice(0, 2) + '…' + s.slice(-2);
    }
    return s;
}

// ============== Routes ==============

// Health. Internal-only: this endpoint exposes operational detail (session
// counts, upload bytes, init errors, cache stats) that shouldn't be world-
// reachable. It's meant to be hit locally from the VPS itself, so it's gated to
// loopback / private-network source addresses. Anything else gets a 404 (not a
// 403) so the endpoint's existence isn't advertised to the public internet.
// Note: this trusts the socket peer address, not proxy headers, so a public
// reverse proxy must not be configured to forward /healthz to this app.
function isInternalRequest(req) {
    var ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
    // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1).
    var m = ip.indexOf('::ffff:');
    if (m === 0) ip = ip.slice(7);
    if (ip === '::1' || ip === '127.0.0.1') return true;      // loopback
    if (ip.indexOf('127.') === 0) return true;                // loopback /8
    if (ip.indexOf('10.') === 0) return true;                 // private /8
    if (ip.indexOf('192.168.') === 0) return true;            // private /16
    // private 172.16.0.0 - 172.31.255.255
    var p172 = ip.match(/^172\.(\d+)\./);
    if (p172) { var oct = parseInt(p172[1], 10); if (oct >= 16 && oct <= 31) return true; }
    // unique-local IPv6 (fc00::/7)
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
    return false;
}

app.get('/healthz', (req, res) => {
    if (!isInternalRequest(req)) return res.status(404).end();
    res.json({
        ok: true,
        version: pkg.version,
        sessions: sessions.size,
        uploads: uploads.size,
        uploadBytesUsed,
        firebaseAuthReady,
        firebaseInitError: firebaseAuthReady ? null : firebaseInitError,
        uptime: process.uptime()
    });
});

// 1. TV requests a new pairing code
app.post('/api/pair', limPairCreate, (req, res) => {
    const body = req.body || {};
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : null;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    let ttl = parseInt(body.ttl, 10);
    if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_TTL_MS;
    if (ttl > MAX_TTL_MS) ttl = MAX_TTL_MS;

    const code = freshCode();
    const now = Date.now();
    const session = {
        deviceId,
        status: 'pending',
        payload: null,
        createdAt: now,
        expiresAt: now + ttl,
        completedAt: 0,
        consumed: false  // One-time read flag
    };
    sessions.set(code, session);

    console.log(`[pair] new code=${code} ttl=${ttl}`);
    res.json({ code, expiresAt: session.expiresAt });
});

// 2. TV polls for completion.
// The FIRST GET after completion returns the payload
// AND marks the session as consumed. Subsequent GETs return 410.
// This is defence against an attacker who somehow obtains the code
// AFTER pairing completes but BEFORE the 60s grace expiry — they
// shouldn't be able to read the credentials a second time.
app.get('/api/pair/:code', limPairPoll, (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!looksLikeCode(code)) return res.status(400).json({ error: 'bad code' });
    const s = sessions.get(code);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status !== 'completed' && Date.now() > s.expiresAt) {
        sessions.delete(code);
        return res.status(410).json({ error: 'expired' });
    }
    if (s.status === 'completed') {
        if (s.consumed) {
            // Already read once — payload is gone (we cleared it after
            // first read). Tell the client politely.
            return res.status(410).json({ error: 'already consumed' });
        }
        // First read of a completed session: deliver payload, then
        // immediately clear it so it can't be replayed. We keep the
        // session shell around briefly (consumed=true) so a duplicate
        // poll gets a clean 410 rather than a confusing 404.
        const payload = s.payload;
        s.payload = null;
        s.consumed = true;
        // Schedule deletion of the consumed shell after one janitor cycle.
        setTimeout(() => { sessions.delete(code); }, JANITOR_INTERVAL_MS);
        return res.json({ status: 'completed', payload: payload, payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION });
    }
    res.json({ status: 'pending' });
});

// 3. TV closes the session after consuming the payload
app.delete('/api/pair/:code', limPairPoll, (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!looksLikeCode(code)) return res.status(400).json({ error: 'bad code' });
    sessions.delete(code);
    res.status(204).end();
});

// 4. Phone/web client checks if a code is valid before showing a form
app.get('/api/pair/:code/info', limPairInfo, (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!looksLikeCode(code)) return res.status(400).json({ error: 'bad code' });
    const s = sessions.get(code);
    if (!s) return res.status(404).json({ exists: false });
    if (s.status !== 'completed' && Date.now() > s.expiresAt) {
        sessions.delete(code);
        return res.status(410).json({ exists: false, error: 'expired' });
    }
    res.json({
        exists: true,
        status: s.status,
        expiresAt: s.expiresAt
    });
});

// 5. Phone/web client submits the playlist payload
// Dedicated body parser for the pairing-submit route ONLY. An uploaded M3U is
// embedded directly in the payload (no hosted URL on the TV), so this single
// route must accept a body large enough for a 5 MB file plus JSON overhead.
// The GLOBAL json limit stays at 64kb so every other endpoint keeps a small
// attack surface.
const pairSubmitJson = express.json({ limit: '6mb' });

app.post('/api/pair/:code/submit', limPairSubmit, pairSubmitJson, async (req, res) => {
    const code = (req.params.code || '').toUpperCase();
    if (!looksLikeCode(code)) return res.status(400).json({ error: 'bad code' });
    const s = sessions.get(code);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (Date.now() > s.expiresAt) {
        sessions.delete(code);
        return res.status(410).json({ error: 'expired' });
    }
    if (s.status === 'completed') return res.status(409).json({ error: 'already completed' });

    const payload = req.body;
    const err = validatePayload(payload);
    if (err) return res.status(400).json({ error: err });

    s.payload = payload;
    s.status = 'completed';
    s.completedAt = Date.now();

    console.log(`[pair] code=${code} completed type=${payload.type}`);
    res.json({ ok: true });
});

// 5b. Mint a Firebase custom token from a verified ID token.
// Phone/web flow:
//   1. Browser does signInWithEmailAndPassword / createUserWithEmailAndPassword
//      via Firebase Web SDK (same project as the TV app).
//   2. Browser POSTs { idToken } here.
//   3. We verify the ID token via firebase-admin (rejects if email not
//      verified — we enforce verification before issuing a token).
//   4. We mint a short-lived custom token bound to the same UID and return it.
//   5. Browser bundles that custom token into the pair-submit payload as
//      { action: 'sync-customtoken-signin', customToken, email }.
//   6. TV polls, receives it, calls firebase.auth().signInWithCustomToken().
//
// Custom tokens are valid for 1 hour by default; the TV uses it once to
// sign in then never needs it again (the resulting session is long-lived).
app.post('/api/mint-custom-token', limMint, (req, res) => {
    if (!firebaseAuthReady || !firebaseAdmin) {
        return res.status(503).json({
            error: 'Auth is not configured on this server.',
            detail: firebaseInitError || 'firebase-admin not initialised'
        });
    }
    const body = req.body || {};
    const idToken = typeof body.idToken === 'string' ? body.idToken : null;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    firebaseAdmin.auth().verifyIdToken(idToken, true /* checkRevoked */)
        .then((decoded) => {
            // Belt-and-braces — also require email_verified=true. The browser
            // shouldn't even reach this endpoint until verification, but a
            // tampered client could try.
            if (decoded.email && decoded.email_verified !== true) {
                return res.status(403).json({
                    error: 'Email not verified. Check your inbox and click the verification link before pairing.',
                    code: 'email-not-verified'
                });
            }
            return firebaseAdmin.auth().createCustomToken(decoded.uid).then((customToken) => {
                console.log(`[auth] minted custom token uid=${decoded.uid} email=${redactId(decoded.email) || '?'}`);
                res.json({ customToken, uid: decoded.uid, email: decoded.email || null });
            });
        })
        .catch((err) => {
            // Common shapes: auth/argument-error (bad token), auth/id-token-expired,
            // auth/id-token-revoked, auth/invalid-id-token. We surface a brief
            // message; the browser shows it but doesn't expose the internals.
            const code = (err && err.code) || 'auth/verify-failed';
            const msg = (err && err.message) || 'Failed to verify token.';
            console.warn(`[auth] verifyIdToken failed: ${code} — ${msg}`);
            res.status(401).json({ error: msg, code });
        });
});

// 6. File upload (phone/web client uploads a .m3u/.m3u8/.pls/.txt; server
//    holds it under a UUID and returns a public URL the TV can fetch).
//
// //   - rate limited (5/min/IP)
//   - X-Filename sanitized via sanitizeFilename()
//   - reject if Content-Type isn't a known text/octet form
//   - reject empty body and over-limit body explicitly
//   - reject if sanitized filename can't be made safe
app.post('/api/upload', limUpload, (req, res) => {
    // Filename: percent-decode the header, then run through sanitizer.
    // If anything looks off (path traversal, control chars, missing
    // extension after stripping) we refuse rather than guess.
    let rawFilename = 'playlist.m3u';
    if (req.headers['x-filename']) {
        try {
            rawFilename = decodeURIComponent(req.headers['x-filename']);
        } catch (e) {
            return res.status(400).json({ error: 'Bad X-Filename encoding.' });
        }
    }
    const filename = sanitizeFilename(rawFilename);
    if (!filename) {
        return res.status(400).json({ error: 'Bad filename. Use a plain name ending in .m3u, .m3u8, .pls, or .txt.' });
    }

    // Content-type sanity check. Our text body parser accepts text/* and
    // application/octet-stream; reject anything else BEFORE reading body.
    const ct = (req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    const okContentTypes = ct.startsWith('text/') || ct === 'application/octet-stream' || ct === '';
    if (!okContentTypes) {
        return res.status(415).json({ error: 'Unsupported Content-Type. Send text/plain or application/octet-stream.' });
    }

    if (uploadBytesUsed >= UPLOAD_MAX_BYTES) {
        return res.status(507).json({ error: 'Server upload quota full; try again later.' });
    }

    // express.text() puts the body in req.body as a string. If middleware
    // ran but the request was empty or wrong content-type, req.body may be
    // {} (the JSON parser's default) so guard against that.
    const body = typeof req.body === 'string' ? req.body : '';
    if (!body || !body.length) {
        return res.status(400).json({ error: 'Empty file.' });
    }
    const byteLen = Buffer.byteLength(body, 'utf8');
    if (byteLen > UPLOAD_MAX_SIZE) {
        return res.status(413).json({ error: 'File too large (max 5 MB).' });
    }

    const token = genUploadToken();
    uploads.set(token, {
        body,
        filename,
        contentType: uploadContentType(filename),
        createdAt: Date.now(),
        // Store the exact byte count used for the quota increment, so the
        // janitor decrements by the same value. Decrementing by body.length
        // (UTF-16 code units) instead diverges from this UTF-8 byte count for
        // multibyte content, drifting uploadBytesUsed upward over time.
        byteLen: byteLen
    });
    uploadBytesUsed += byteLen;

    // Honour reverse-proxy headers so the public URL is correct behind
    // Caddy / nginx / Cloudflare.
    const proto = req.headers['x-forwarded-proto']
        || (req.connection && req.connection.encrypted ? 'https' : req.protocol)
        || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
    const publicUrl = `${proto}://${host}/uploads/${token}`;

    console.log(`[upload] token=${token} bytes=${byteLen}`);
    res.json({ url: publicUrl, expiresInSec: Math.floor(UPLOAD_TTL_MS / 1000) });
});

// 7. Serve a hosted upload by token.
app.get('/uploads/:token', (req, res) => {
    const token = req.params.token;
    if (!token || !/^[a-f0-9]+$/i.test(token)) return res.status(400).send('Bad token');
    const u = uploads.get(token);
    if (!u) return res.status(404).send('Not Found');
    res.set({
        'Content-Type': u.contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.send(u.body);
});

// 8. Funnel landing page so users hitting the pair server root in a
//    browser get an explainer about accounts, the pairing form, and the
//    legal disclaimer. Single self-contained HTML/CSS/JS, no external
//    assets, mirrors the layout of the static (vps-server-static) build.
app.get('/', (req, res) => {
    const codeFromQuery = (req.query.code || '').toString()
        .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    pageCsp.sendPage(res, landingHtml(codeFromQuery, { authReady: firebaseAuthReady }));
});

// Custom Firebase auth-action handler. When the user
// clicks the link in their verification email, Firebase routes them to
// the "action URL" configured in Firebase Console → Authentication →
// Templates → Customize action URL. We point that at this endpoint
// instead of the default <project>.firebaseapp.com page, so users see
// a branded confirmation page on the pairing-server domain that
// matches the rest of the funnel.
//
// Query params Firebase appends:
//   mode      - "verifyEmail" | "resetPassword" | "recoverEmail"
//   oobCode   - one-time action code
//   apiKey    - the project API key (we ignore; we already have ours)
//   continueUrl - optional, where to send the user after success
//
// All the verification work happens in the BROWSER via Firebase Web
// SDK — server only renders the HTML shell. This avoids needing
// firebase-admin to handle action codes (which it can't anyway —
// applyActionCode is a client-side API).
app.get('/auth/action', (req, res) => {
    pageCsp.sendPage(res, authActionHtml());
});

function landingHtml(prefilledCode, opts) {
    opts = opts || {};
    var authReady = !!opts.authReady;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair your device — Xtivio</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0d1a;color:#e0e0e0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:20px;accent-color:#3ad1ff}
.container{width:100%;max-width:460px;margin:24px auto}
.screen[hidden]{display:none!important}
.card{background:#141824;border-radius:20px;padding:40px 36px;border:1px solid rgba(255,255,255,0.06);position:relative}
.logo{width:48px;height:48px;display:flex;align-items:center;justify-content:center;margin-bottom:24px}.logo img{width:100%;height:100%;object-fit:contain;display:block}
h1{font-size:26px;font-weight:700;color:#fff;margin-bottom:8px}
h2.sync-heading{font-size:14px;font-weight:700;color:#aab;text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 12px}
.sub{color:#888;font-size:14px;line-height:1.5;margin-bottom:24px}
.back-link{position:absolute;top:18px;right:18px;background:transparent;border:0;color:#7c8aaa;font-size:13px;cursor:pointer;padding:6px 10px;border-radius:8px;transition:color .15s,background .15s;font-family:inherit}
.back-link:hover,.back-link:focus{color:#cfd6ea;background:rgba(58,209,255,0.10);outline:none}
.cta-list{display:block;margin-bottom:24px}
.cta{position:relative;display:block;width:100%;text-align:left;background:#1e2234;border:1px solid #2a2f3f;border-radius:12px;padding:16px 18px;margin-bottom:10px;color:#e0e0e0;cursor:pointer;transition:border-color .15s,background .15s,transform .1s;font-family:inherit}
.cta:hover,.cta:focus{border-color:#3ad1ff;background:#232845;outline:none;box-shadow:0 0 0 2px rgba(58,209,255,0.3)}
.cta:active{transform:translateY(1px)}
.cta-title{display:block;font-size:16px;font-weight:600;color:#fff;margin-bottom:4px}
.cta-sub{display:block;font-size:13px;color:#888;line-height:1.4}
/* "Recommended" / primary CTA uses a left-edge accent
 * bar instead of a purple-tinted border. Previously .cta-primary
 * always carried a purple border which made it look focused even
 * when it wasn't, competing with the actual :focus state (user saw
 * "two items have highlight at the same time"). Focus state now
 * stays unique to the keyboard-focused item via box-shadow above. */
.cta-primary{border-color:#2a2f3f;background:#1e2234;padding-left:22px}
.cta-primary::before{content:"";position:absolute;left:0;top:50%;margin-top:-14px;width:3px;height:28px;background:#3ad1ff;border-radius:0 3px 3px 0}
.cta-primary:hover,.cta-primary:focus{border-color:#3ad1ff;background:#232845}
/* Disabled-state CTA shown on the landing page when the
 * server has no Firebase service account loaded — sign-in/sign-up would
 * 503, so we render an inert tile explaining the state rather than a
 * clickable button that would fail. */
.cta-disabled{display:block;width:100%;text-align:left;background:rgba(255,138,90,0.05);border:1px solid rgba(255,138,90,0.20);border-radius:12px;padding:16px 18px;margin-bottom:10px;color:#cfd6ea;cursor:default}
.cta-disabled .cta-title{color:#ff8a5a}
.sync-list{list-style:none;margin:0 0 20px;padding:0}
.sync-list li{position:relative;padding:8px 0 8px 24px;font-size:14px;line-height:1.45;color:#cfd6ea;border-bottom:1px solid rgba(255,255,255,0.04)}
.sync-list li:last-child{border-bottom:0}
.sync-list li::before{content:"\\2713";position:absolute;left:4px;top:8px;color:#35d0a0;font-weight:700}
.sync-list li strong{color:#fff;font-weight:600}
.note{background:rgba(58,209,255,0.06);border:1px solid rgba(58,209,255,0.20);color:#b9d4e8;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.5;margin:16px 0 24px}
.note em{color:#fff;font-style:normal;font-weight:600}
.field-group{margin-bottom:16px}
.field-group label{display:block;font-size:13px;color:#aaa;margin-bottom:6px;font-weight:500}
.field-group .optional{color:#666;font-weight:400}
/* The previous selector list was
 * .field-group input[type="text"],[type="url"],[type="password"]
 * which missed type="email" (used by the sign-up + sign-in forms) and
 * type="tel"/"search"/anything else — those inputs fell back to the
 * browser's default white, thin box. Switching to :not([type="file"])
 * catches every input that should look like a styled field, including
 * future ones. The file-input branch below is unchanged. */
.field-group input:not([type="file"]){width:100%;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;color:#fff;font-size:15px;transition:border-color .2s;font-family:inherit;box-sizing:border-box}
.field-group input:not([type="file"]):focus{border-color:#3ad1ff;outline:none;box-shadow:0 0 0 3px rgba(58,209,255,0.2)}
.field-group input::placeholder{color:#555}
.field-group select{width:100%;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;color:#fff;font-size:15px;font-family:inherit;box-sizing:border-box}
.field-group select:focus{border-color:#3ad1ff;outline:none;box-shadow:0 0 0 3px rgba(58,209,255,0.2)}
.field-group input[type="file"]{width:100%;padding:10px 0;color:#cfd6ea;font-size:14px;font-family:inherit}
.field-group input[type="file"]::file-selector-button{background:#1e2234;border:1px solid #2a2f3f;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;margin-right:12px;font-family:inherit;font-size:14px}
.field-group input[type="file"]::file-selector-button:hover{border-color:#3ad1ff}
/* Password reveal toggle. Wraps the input so the eye
 * button can sit absolutely positioned at the right edge. The input
 * itself has padding-right inflated to make room for the icon. */
.pass-wrap{position:relative}
.pass-wrap input[type="password"],
.pass-wrap input[type="text"]{padding-right:44px}
.pass-toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;background:transparent;border:1px solid transparent;border-radius:6px;color:rgba(255,255,255,0.55);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.pass-toggle:hover{color:#fff;background:rgba(58,209,255,0.10)}
.pass-toggle:focus{outline:1px solid rgba(58,209,255,0.7);color:#fff}
.pass-toggle svg{width:20px;height:20px}
.auth-toggle{display:flex;align-items:center;gap:8px;font-size:14px;color:#c9d1e0;margin:2px 0 10px;cursor:pointer}
.auth-toggle input{width:auto;margin:0}
.auth-fields{padding-left:12px;border-left:2px solid #2a2f3f;margin:0 0 10px}
.auth-fields[hidden]{display:none}
.hint{margin-top:6px;font-size:12px;color:#666;line-height:1.4}
.file-chosen{margin-top:8px;font-size:13px;color:#35d0a0;word-break:break-all}
.tabs{display:flex;gap:8px;margin-bottom:20px}
.tab{flex:1;padding:10px;text-align:center;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;cursor:pointer;color:#aaa;font-size:14px;font-weight:500;transition:all .2s;font-family:inherit}
.tab:hover{border-color:#3ad1ff;color:#ccc}
.tab.active{background:#1e2234;border-color:#2a2f3f;color:#fff;position:relative}
.tab.active::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:3px;background:#3ad1ff;border-radius:3px 3px 0 0}
.panel{display:none}.panel.active{display:block}
.type-select-group{margin-bottom:20px}
.type-select{width:100%;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;color:#fff;font-size:15px;font-family:inherit;cursor:pointer;accent-color:#3ad1ff}
.type-select:focus{outline:none;border-color:#3ad1ff}
.panel-intro{color:#8c95ad;font-size:13px;line-height:1.5;margin-bottom:20px;padding:12px 14px;background:rgba(58,209,255,0.05);border-left:3px solid rgba(58,209,255,0.35);border-radius:0 6px 6px 0}
.panel-intro em{color:#cfd6ea;font-style:normal;font-weight:600}
.toggle-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;margin-bottom:8px;cursor:pointer}
.toggle-row input[type="checkbox"]{flex:0 0 auto;width:18px;height:18px;margin-top:2px;accent-color:#3ad1ff;cursor:pointer}
.toggle-label{display:flex;flex-direction:column;gap:2px}
.toggle-title{font-size:14px;font-weight:600;color:#fff}
.toggle-sub{font-size:12px;color:#8c95ad;line-height:1.4}
.ct-section{padding:20px 0;margin:8px 0 16px 0;border-top:1px solid #2a2f3f}
.ct-section.hidden{display:none}
.ct-section-title{font-size:15px;font-weight:600;color:#fff;margin:0 0 6px 0}
.ct-section-sub{font-size:13px;color:#8c95ad;line-height:1.5;margin:0 0 14px 0}
.btn-primary{width:100%;padding:14px;background:linear-gradient(180deg,#35355a 0%,#262544 100%);border:1px solid rgba(124,92,255,0.45);border-radius:10px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px;transition:transform .15s,box-shadow .15s;font-family:inherit}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(124,92,255,0.25)}
.btn-primary:active{transform:translateY(0)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
.msg{margin-top:16px;padding:12px 16px;border-radius:10px;font-size:14px;line-height:1.4;scroll-margin-top:24px;scroll-margin-bottom:24px}
.msg.hidden{display:none}
.msg.ok{background:rgba(53,208,160,0.12);color:#35d0a0;border:1px solid rgba(53,208,160,0.2)}
.msg.err{background:rgba(255,85,102,0.12);color:#ff5566;border:1px solid rgba(255,85,102,0.2)}
.disclaimer{margin-top:24px;font-size:12px;color:#555;line-height:1.5;text-align:center}
/* Min-width:0 stops the input's intrinsic min-content
 * width from bursting past width:100% of its parent when letter-spacing
 * is applied to a wide value like "ABC123". Tighter letter-spacing also
 * helps on narrow phones.
 * Explicitly set the dark background/border/color too.
 * The previous CSS relied on the .field-group input[type="text"] rule,
 * but the <input> in markup didn't carry an explicit type attribute,
 * and attribute selectors don't match implicit defaults — so the field
 * was rendering with the browser's default white background. Now also
 * explicit on type="text" in the markup. */
#code{text-transform:uppercase;letter-spacing:2px;text-align:center;font-size:22px;min-width:0;max-width:100%;display:block;width:100%;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;color:#fff;font-family:inherit;box-sizing:border-box}
#code:focus{border-color:#3ad1ff;outline:none;box-shadow:0 0 0 3px rgba(58,209,255,0.2)}
#code::placeholder{color:#555}
.auth-banner{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;background:rgba(53,208,160,0.08);border:1px solid rgba(53,208,160,0.25);color:#cfeadc;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.4;margin-bottom:18px}
/* HTML's [hidden] attribute is supposed to give
 * display:none, but the user-agent stylesheet rule [hidden]{display:none}
 * has the same specificity as our .auth-banner{display:flex} above and
 * since author rules win over UA rules, [hidden] was being ignored.
 * Result: the banner was visible by default on every page load, even
 * for users who had never signed in. Explicit override needed. Same
 * reason .screen[hidden] needs its own rule at line ~525. */
.auth-banner[hidden]{display:none !important}
.auth-banner-text{flex:1;min-width:160px}
.auth-banner strong{color:#fff;font-weight:600;word-break:break-all}
.btn-secondary{width:100%;padding:12px;background:transparent;border:1px solid #2a2f3f;border-radius:10px;color:#cfd6ea;font-size:14px;font-weight:500;cursor:pointer;margin-top:8px;transition:border-color .15s,background .15s;font-family:inherit}
.btn-secondary:hover,.btn-secondary:focus{border-color:#3ad1ff;background:rgba(58,209,255,0.06);outline:none}
.btn-secondary:disabled{opacity:.5;cursor:not-allowed}
.link-btn{background:transparent;border:0;color:#3ad1ff;font-size:13px;cursor:pointer;padding:0;text-decoration:underline;font-family:inherit}
.link-btn:hover,.link-btn:focus{color:#3ad1ff;outline:none}
.forgot-row{margin-top:14px;text-align:center}
@media (max-width:480px){.card{padding:28px 22px}h1{font-size:22px}.back-link{top:12px;right:12px}.cta{padding:14px 16px}}
</style>
<!-- Firebase Web SDK 9.x compat builds, same version as
     the app loads. Compat API matches what cloudsync.js on the TV
     uses (firebase.auth(), etc.) so we keep one mental model. -->
<script defer src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js" integrity="sha384-ajMUFBUFMCyjh8uxJg6bkGcKe9RTolyjwbxB3yES0QQMenP3Oztj/W9vA2SJPcIh" crossorigin="anonymous"></script>
<script defer src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js" integrity="sha384-xD1t9dGSVKobUztxDkv6xUI0H4AnFz0NxwlgDJJ7FDlblG9xxr1Z9iauCZuJYj6p" crossorigin="anonymous"></script>
</head>
<body>
<div class="container">

  <!-- ============== SCREEN: landing ============== -->
  <section class="card screen" data-screen-id="landing">
    <div class="logo"><img src="data:image/png;base64,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" alt="Xtivio"></div>
    <h1>Pair your device</h1>
    <p class="sub">Send a playlist from this device to your Xtivio app.</p>

    <div class="cta-list">
      ${authReady ? `
      <button class="cta cta-primary" data-go="account-create">
        <span class="cta-title">Create an account</span>
        <span class="cta-sub">Sync your library across devices &mdash; free and optional</span>
      </button>
      <button class="cta" data-go="account-signin">
        <span class="cta-title">I already have an account</span>
        <span class="cta-sub">Sign in on your device to restore your data</span>
      </button>
      ` : `
      <div class="cta cta-disabled" aria-disabled="true">
        <span class="cta-title">Accounts temporarily unavailable</span>
        <span class="cta-sub">Sign-in is offline on this server. You can still pair playlists below. Account features will return shortly.</span>
      </div>
      `}
      <button class="cta" data-go="pair">
        <span class="cta-title">${authReady ? 'Continue without an account' : 'Pair your device'}</span>
        <span class="cta-sub">Send a playlist now &mdash; nothing is stored on our servers</span>
      </button>
    </div>

    <p class="disclaimer">This service does not provide any content, channels or subscriptions. Users must supply their own IPTV playlists.</p>
  </section>

  <!-- ============== SCREEN: account-create ============== -->
  <section class="card screen" data-screen-id="account-create" hidden>
    <button class="back-link" data-go="landing">&larr; Back</button>
    <div class="logo"><img src="data:image/png;base64,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" alt="Xtivio"></div>
    <h1>Create a free account</h1>
    <p class="sub">An account unlocks cloud sync across every device you sign in on &mdash; phone, tablet, TV or any other device.</p>

    <h2 class="sync-heading">What gets synced</h2>
    <ul class="sync-list">
      <li><strong>Playlists</strong> &mdash; every M3U, Xtream, and Stalker playlist you've added</li>
      <li><strong>External EPG sources</strong> &mdash; your XMLTV URLs</li>
      <li><strong>Favorites</strong> &mdash; channels you've starred</li>
      <li><strong>Watch history &amp; VOD progress</strong> &mdash; resume movies and series where you left off</li>
      <li><strong>Hidden categories</strong> &mdash; whatever you've tidied away</li>
      <li><strong>Parental controls</strong> &mdash; PIN and protected actions</li>
      <li><strong>App settings</strong> &mdash; player preferences and layout choices</li>
    </ul>

    <h2 class="sync-heading">Sign up</h2>
    <div class="field-group"><label for="su_email">Email</label><input type="email" id="su_email" autocomplete="email" placeholder="you@example.com"></div>
    <div class="field-group"><label for="su_pass">Password</label><div class="pass-wrap"><input type="password" id="su_pass" autocomplete="new-password" placeholder="At least 8 characters"><button type="button" class="pass-toggle" data-pass-target="su_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="field-group"><label for="su_pass2">Confirm password</label><div class="pass-wrap"><input type="password" id="su_pass2" autocomplete="new-password" placeholder="Repeat password"><button type="button" class="pass-toggle" data-pass-target="su_pass2" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <button class="btn-primary" id="signupBtn">Create account</button>
    <div id="suMsg" class="msg hidden" role="status" aria-live="polite"></div>

    <p class="note">
      We'll send a verification email after sign-up. You must verify your email
      before you can pair with your Xtivio device. Sign-up also works directly
      on the device at <em>Settings &rarr; Cloud Sync</em> &mdash; the same email
      and password work in both places.
    </p>
  </section>

  <!-- ============== SCREEN: account-signin ============== -->
  <section class="card screen" data-screen-id="account-signin" hidden>
    <button class="back-link" data-go="landing">&larr; Back</button>
    <div class="logo"><img src="data:image/png;base64,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" alt="Xtivio"></div>
    <h1>Sign in to your account</h1>
    <p class="sub">Restore your synced library on this device, then pair to your device.</p>

    <div class="field-group"><label for="si_email">Email</label><input type="email" id="si_email" autocomplete="email" placeholder="you@example.com"></div>
    <div class="field-group"><label for="si_pass">Password</label><div class="pass-wrap"><input type="password" id="si_pass" autocomplete="current-password" placeholder="Your password"><button type="button" class="pass-toggle" data-pass-target="si_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <button class="btn-primary" id="signinBtn">Sign in</button>
    <div id="siMsg" class="msg hidden" role="status" aria-live="polite"></div>

    <p class="hint forgot-row">
      Forgot your password?
      <button type="button" class="link-btn" id="forgotBtn">Send reset email</button>
    </p>
  </section>

  <!-- ============== SCREEN: verify-email ============== -->
  <section class="card screen" data-screen-id="verify-email" hidden>
    <button class="back-link" data-go="landing">&larr; Back</button>
    <div class="logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABTCAYAAABgdgI7AAA4d0lEQVR42uV9d5xU5dX/95znuVO2L7tL71Wq9CLKulhQFGNhVmPsJprYkqivGqMOiyn2Fks0RiWWwAxYAjYUlxUUEhsqLEUQFkFAYGHZMjP33uc5vz/uLPJGMNa8ed/f/XzGgWHXmTnnPKd8z/ecC/zri0D0pT+QEFEACP8fXXHEWUTom/7u58L9V8IHBEDhgFPPPA7G5lsRCwBM4mt2zMdrVr3dtOwftcQMuf56RlWV/b8u/EQsoSqTlQYAJg+cXJGbl9/NWutAUMhACAqKmcHMABgWPqxYy5YbZi2dlQSwLYaYSiJpvkwBJCKgnJxORz/4yAuHT5k8OJLyoJSCMIGsgUOMbes+9hY/M++eBbfE4wCaY4mESlZW2qzi/k9dMcRUQhKWiKQn2g26/Kzr75h81OSjCtsUQCDQSoOYAAaIsxKwgIjAuBZaNOY8l9x86cO/OLoJTbXxeJwPqICYiEoSmTF/emzu4T8++/j8lPXyMxl2QBClICIQsYhEI4o8F+8k5qybefsfztq1YsmbrBTsyScrJJPm/4jsqbq8WlXUVPgA+PJDL7vypKNOmn7o6MPDsL51lScIASwsUAAxCSAQC8AQ4AO20RKaRUKhiPPoC49v/f3zd01cs/PdVQdSAJFSIsY4xy5+c1nP8eP6RHamOTfsKJHAM7VKVrkZKdRk2hZGdO0bb5mFM2deu/TeO+4E4JXHq3VNVYX533waYrGYenrO08ZYg4HRgaOu+NEVN58y/uSKgvxCpNJNhkBKKwekACgBKQR/BgOWID4BKQvJCPyMD/bgOYU5ztWP/XrRLQt/N4EP8L4y1fcVAG/Tmg3bNeBEiiKmOZ2RjLVIESMFQgpAyglTPWm9tj5lu4wZxWdfd93NP3poxqt64LhRNVUVPisliMXU/0qrj1frZDJpjDU5v5j4ixsfuOq+Jecee25Fro766fpmcTxHOUaDLYGFwMIgUYCvgAwBLQAaBeQSSBiKHQhDIWWljVPSDgAOKJjaKhBkIT6betYbTS4fVNajW9/c9oWU8sR3XY8NCK4ArhAMCKIV7U5nCOGQGTVmRI+egwed25LfztmytGYpamvd8ni1rquZ8b/iJCRiCTVn5Rz72MLH7NiyscfcdM5Nf/npDy44rU+HPtRS32zJktbsEIECX08AmEAgiCeQlAApAC6BLGVPAyAWEGuFdYjf+HDJllfXz3/gSyyzRlBVRdi1def2V+Y9vnFj/VYvkjOyoGePAlcraUqlBGASBArwhSCskfaF96Rc26tvd3XwuNHl4e79jlm1dv2aujk3f0yKgalTFWpr/yMVEUecFyYW8qCqQUYg7atOnn7PFT+64rajDzmqIzzHzzR7KkShIHAyQLrV3RDgZoWeBsgjwBIgDBICfAF8gViBGCOaHby18u3Gl9e/+IesAuIM1BzoY7HIQlx16g/eXj/z8Rn1Rheo4sJRJb27kXji+65PpJkgAohASMMqRS2NKckLh82Q8cM79x4y9CwbLi3Z9NbiGtTWurFEQtUmk/9xVn/JyktsVbJKYqNOPee2i2574qzJ5x7erqiD3dOQEhgoLQqB1QfWTj4gaQSCzwDwKRC4BBYPI4APiCsQP3hAxCo4PPedl5Yt3rzwL58HYWbgS/L4WCKhZp92mhFrocYdNnHUTy+9qc+UE0blRsPINLQYZq1YOZDAOMAAHFhETcZ2Ks5hrzmNRYlnal+9+95Lmle8WS0iRJWV/D+dKcUR52kyTYhI8tC+/+/O+/Udx0886Zju7TqhcZfv24zRDhRYACaATeBaJGVBHkAgBOk+ASQABXWriASnIKsAoywyxpX8kjx5unqu+8unLx9Rl/loJQFA/hHH9m1c8OKaQNCikpV0oDyeyqurVU1FhQ8g1Pfy664efPzkazpVjMtJNcH39zQpcSLkKg0jgFgBxCIkGSnKC5l2uVrXLfnQLEkmf7fizhunE+BPiMd1TVWV/z8RZBMJ4cpKMgCcc8b87NJTJ/3whooxhxWmMzDpljSFoVgTg4nAFpAWAZoBpAVKAkETI/vcqiGBQEAgwBBsOqgFPN9DND/iL9+6Wl/75LSj526Z+UoillAEAGUX/HJBwdjhet1NN1+INctXgQjlN9xwYMHEYoqeftqIMXC69Rk69uprbut7yslH6JIiNNVnjOtBecpBGowMAWItHLiIsrHt2uQCDS384XN/e33pAw//Am8veO/ffRpisZiaM2eOsdZiQMHY0edXXnDHCeOnjG9bUIrdu13jMKlwiKEJgCXYFsDuATgFKAMoCh5EAJEEzyp77JVk83hAPIK1AmMMHFZ+s/H0tX+94Z77am/7ebw8rqtqqnwSEWoz6bTOxZdeuC7aoY1peGTWnZvu//29AD4VEaJp0+gAbonK49WqpqrCB4AeP7708vaVsWkdyw/Lz6SM3dPkwWPNGcvwLSAEKBJExUVRlE1BQVh9WrPUXfPUX+PbHr3nNgB+eXW1rqn4XusGloQQBVbf5idHXXXV5PIT/2vMwHGcboDxUy7nRDWFFEEM4DVb+HuCNNIxBE0EDYECQZG0Jj8gFuzNiFjAKjj9IgKjDKw1JqcgV938t/veuOalS46ojlebimx9REgkFCorDQ475ehhf7zn5eJO7bAzMXfb7gWLqupm3fFHAJItqPZ/GuJxpt/8xooxAAp6d/3dTbeWnHz8iapHF6R2pkzGhQKFYQWwAmgiRMhHvvJMWVGO8hp3Y/Nzc2tW/+GPVZkVb1YTM+SUU77zKjqwuOk+IDhqyA+mHF/+w5snjjqpf4RDkmr2JEzgEAf5e2YP4DUJ2Ac0CzQTNAEagIJAE6CIkEUdQJTN5wVgHZwICwGUhW89m1uQy88seWnTyU+dPFaxu/k6ex1XITBqhWRSEK/W+MvVHyETKSsbf+jo0t4H5bUdOvy4/N6jD9+9ctuKtXOnbyJW+08ha2oEIiiPx/XG1+fvaFjw/Kz69Tvf06RHhvr0LvVDIfFTaSuW2YAhRmA8hucqTu9xxYlETNtDhvUsGDn87ObSTkWpxa8tRW1tCtXVGjO+fd0Qi8XUihUrUHFuhQ0h1PfKc2+7feqkC28e3e/wsnST8k3GUxGlyG8hNG4F6jdZpHcB2JtKtuI5CP4jgFhCNry1vhT8XQL4wRrAwiIjGSnIzzPvrluFqlm/PX2jV/vuYRNu0DPqqsw/o6EUSwgnKyk86K7Eu91PPqWvaXa90oJIqP71t/3aZ2b/fn3i5ukA/C8P0nGOyzRUEVkAuWW//O30winH/UIPP5i9Bs+XFl8RhUgsg33A8SwixkckIqa4c4TTjk8fzH1++Y6H7r0GC199HszANz8NFI9Xq6rg5PLUiRdfNnHsCdcNP+jIEr+JjaQ8yg0r9lsETduBTIOAXMBRhJAiOArQDKisS9FEcDhwo5ooeD3rglhRUBGJgImgBLAwCOcqryWTcX4168ZbHlp109UXjHjQeeidC71/hpv3BlbMmW30gGNGjr3tlr+XHTRIIpt2Iq+0RPmpZqyd98KyZYk51zZ+OOtFIsKECTfompoDBemEwpzTDKxF+OCJFSU/+dlNRZOOHS25uTC7MkYZpZRlIAOwR3CsIMJphMocf3c3R39auwJ75v7tT6n4tf8FoAEiCkRfGWHdN8j2KR192KlTf/qbcSMnTyjQ7eDuShvJsPL3aDRtN/CaAEcoK/hA6JoJigOX4ygBM6AVAuFmXRKzQClAI8h8FAOsAGYLthYwZApyQuqulx588arFPz1BYiKU/OJ3+LwSrq2VET950Nn84p2bRBd73UYfcpTWUePvbOIwRUyXIYM7lvYb/iMd7dbrsw9eXlRXV9MUF+GaKhBQ898FU5sUiBASosy953zc+EJyhrtLiwrnj8vr3tVhIz63+BQWTcoA4gJuxoHbYJm3pmxhh87IKx8/wh029JRMumE1fnTmWjADs2YFLvNLLhGhyspKKyJFpx17/d2nV/7XXeXjju0RUnl+aneamnYyf7ZBsGsLwW9mKBCYsjDCXrdCQVHZ6oIkeG3ff5fWn896KiiBChGstsiQZwuKo5Rc8vzOi+afd4Jiuyu+Yhrtz4D+GxSx5Z15EhNRS046cmlOca+R7ceM6NfcAksp0pndrm3TplQ6DztkaJsBR5xhKXfHc2cdtwxUI+XlcV1XV/NFwSSrAiBu9Wo/8/7ChQ2LPngFEj3Iad+1e6Qgj3STaygDJssQF5A0w7ia/HqXnIz1C4YOKgsNGX6m6da1rffaK39HMtkMEUZV1X6/TDwe54qKChkz4IQTLpg6PRE76YKjO3buzKl61+yoE711raKdnzJMirNuhEAS+AErkvXzrTL/XAm2VfgisBLkLlYEQgShIDpzNIjEnhUpyI3a5Z+sUne9cMsJ61tWLJsps1QSyf0WuF/AgmoBokWL/M01z77afuChZ7Xp3TfP3ZUWLYpbmgy5rvXbdO9ZWNZ71ElOQZ/h295b8k5d3Ys7RISqamu/GKRra4PTEK/WeP63nzQvfnqGX++nwn7u+NyuPUIwbNCcgbhMvkewHgGeAprAsidjc0rboWDc2NFq3NjTUhzdLLEfrCAiQTyuUVOz90uVl8f1jBlV5oSjL7jm6ktueXjMyHEljXvE3fFxijetcHjbBoZJMzQICgSyrZFz32cKrN9mA2/2BEjr34WC12zwlcCAQKCiBM4TeNqFo7VJ+66+44Xb73563aMPPDjiQefsLWcfsND8IhhXUyPlE27QdRtrGs1u2dL+4DGnUG6hcZvBLkKwnnBmd1o4UmA7DBzZv02/Q84zqsPuK84+8i3U1soBUc+aGRbxOGPhQsmcPmnxnjc/fFZJpFteftt+OreY0i3WmIwlJURkCGIYgCZJecS+NYWDBxTnjxgeky79DkotmPc2amp2xURUbdYFnlN3OGqwEMMGvLZrx5aG0q2fhAY2bmqvNq5gm2kyFNJEJAjwGytZAcvnmYylvYhlq9CNtGY5gcVbIYiVrL4I1gLkCHQRwZKFL9bmRsLqkQWJpXcuuvLMREzk7FdHfmkCsV80tK6uxpbHq/Wyv1zxPvI7D+kwdvxAr1mM9oWtzzAIkZ/22TalTWm33uGO/UYdF2079Ij6Lbs/WjcvvoGIgdgBUtaqKiAe1/aVp7bteueZp8zmhjXwQiNzSnsW+45DvusbAMwqKG6s0oAIozEl0ZJiWzpu1JDI0PGx5rTa8OEZJ9WCagTxuK6pqTJAFZavWbr9zffnzv5o2dY3vT1qaEle7/Z50Qh5nmvEB4thiAHEZK3YBlb9uVKCj2paXZH9vPmErN+3EgjfwEKXAjYk8NJWisNRem7pCy1XPveTcqZMff8VQjWoka+tAACoq+mOuCyk5JRJr5b2HH9eh349cuzuFlGWyRoGiwIbZmlOSU44x3ToP7hHmy5jzoMzOFq/bu5S1NZmYglRtcmq/SDdNTZIWRfSvAt/8OH2fzw5I9QS5bAqHhYq7RD2LBsSnyhEBEKAPobCpFo81i2eyT+4X2FozOhTuXO/AS2vzfsANTXboRRwww2MmoUQmca/uP60dSs+S87wd0ZTEV0wpjS/c9j6yvomBQKRGMoqIutSbJAQfp7TZ4MMUfCcjQ8mW1AaD0AhwIWCtO9KfkHUrtiwmh+Yd9dJn6TefmfCP+X7X1sBQI3U1A5kWvlkc8tuf1XbgSNPDxeWGbfFMFsG+UGXh+GQZCxTi2tKy9pT+z4jDs1tO2ZqqpHq3n7wlFUHPA2okZqqKkEsobBydsvujxe80rxs7d9yVGhIXttu3blNDrlkjGJhrRjCDAoAF/b3ZCSvpI0tmDBisFN++BkUKQ6l31nyNmpqXMShqyoqTAwxtZJWuRtTCxbVbnr76bBxepVEOvTNVcWUdjPGWLD1CNYHrMm6FSGI8OdBGAQQgmCL4KRYIogHmLBAlzH8DBDmkGnxmvSDL9510/y6P/0xEUuo21645CvVLl/eKqxNSiyRUP+4+/pVyOvRtvPwMWNsixhtDCsBSAhiGRAGg9hvcckR8dv26FdW1GX4D1Woe5cdH7/0OmprUweMDbVJAUCxmKhly87atnPF7EepKdQcyc0fnd+9c44NKUO+S0oRiQZ8VmClCKkM+74YZ2CvnLzDDquwfQYfn/pky2rMeuJjiHAtVgALFyIWS6hltfdsr61/7snUrsymiI6MLcrpm++ntfieJxZC1gLW0N5Am5U6iII/CyT4rtQaGyx0OwARA+OKH404+pnXHn/2z+9c85MHL3jbOfvxo74yuvsViEVCsQQ4WUnh8Tc8XzvgsMndUptbLFmHPV9DLIGNQEyQ0mnfgzWetaEcuB74k2UvrV3/xhMXb9/w5HwihkydqZDl1Oy/+RNg80C3g/qe87sH8iYfd7juVAg/bXxhqxFh2DBDIgStfJBNS7owz7il0LuWvOc3JGfd6t1787VZxphCJVkgThKfBqoiC6DzsT3u+12fsmPObBfuCd91fcDXmpy9qamjAK0JWgmUCooyJkDr4LToAkGkHWBMxhbk5fI/VtVsve7p00dLfPNmqpoG4Ktzo75Cs7wKtRjItHK2u7vJr23b6+Af5ZW2t36LZbIEmIB6IUYgBgiOtSKbyhDS4he071da3G7AGZFoz+LtdS8vRW0yFYuJqq2t2q/bq6qqCirplQ9v37ns6cdTn/k7VSQ6JDyge5HNVRaeKwgR2RDgKYYNOcS+z9LgWtups+JDxh0WGTDg2PSm7e/hnvM3BxhWKVfdX2ljSKhamt2wdtfzz9S3bHorHI4MLon07MCcI8a4FkIc5JayD0iTjQEqANgkJIiUMtKuhYOI+WTXepm1+NazPm188x8rygZybe0lX4uY9tXYCrVJKY/H9Zq/3veROO3yuww/5FDxlc+ez/AAawnWCMQHxADGJxiPYVzhdJNnQ9FSLuk8Zmxhu6NOs+m8lX9/c/JaCphLdKD3y7ZC5VfnTvr7zlcene1zhxxuWzbK6VdKGWLfmAyJYvKZA6KYUsTplChybNGo4V1Khow8h0q6cMubry5Fba0XF+H7qwYJAErERD34zmlrPtg28y8RyXFDlHNYYbSrBsi3lCEiJkaAaoIk6BYyQZQgUiZAxAdYeS77zjOLH7hv4dp77rpgxAXO469e87UbS1+ZLlJXUyOxREItmv6zJTmdDj6xbZ+B7dw9nhWPybhBRoGsKxIjsH7AiSFh8l0rvkumpLRHm8KygWc6od5lOzY//0bQwj6QG8yehvK4xiev72p5a968hjW7lxnl9KNenTv5pVHKuL4hMUyKQUQIK4dyDNhp9ExRl05O6ajRFblDhh6bbvBXvXLOaRuICeUT4vq2F1qD9Gp37Z5Xaz6rX/6qUKR7XqR771yVT9b4PshjIYYFAyqIA6oQ0IWMjOuZ3HBYV9cmF/916SVnJGKCa1494RvB51+Lr1MLMK1cmd7T2Ly0TedB5+UUd0K60SfrgwLrzyrCBieBLAVpnq+IxbKfydhoThvp3HnMmOKCISfu2Lp+jutubq4KoIUDad5CQDERtfzCk1Y2v/zU42mPWnRe/rhQ365hQ2zhunCISYPAxAgTsWpKi6Md227YoE4dBw85N7dTv47bFr74bl1dTYOIcGXVCgDVKC+v1u+v/83GVbufftxtVpvFx9i2eb3zlQqJZzNilCLLDAkJou0Eru9LjorirZWLGh995crjPar/LLlCvoiHfdUO0df66WTSTJjwmm748Pl31la//BvXdRUi2ogYiLWwWRcEHyATlPFkgzexvgYjzI5t5Kj1vW4lxxzUrnT0SCKSWCzxrz6HJIkMYgkF5pb0Q7/93bYfnjos9eDDL+vd2zlUGiUW6yvfQxgChxlOJExhXxS2pWyb3v3tmMsvvWBK8tWl3WKXnU5ElqnKlsfjqqamws8ynfFWw2//9PiGI4YsrPvDvZ80rSQK5bAvYlKuK8gVuNaFMmFTt30nz1s2++JGrFozdepM9XWC7rc6AUGVPEPK49X63YfPWBRqM3hK+4MGdTJNriGPWTyG+ALKnoLWZgZalQEghy30dib7SUa2bq2evTP1j1UDa2Nci6R8lVjUirLiyV/saF4w9wm7s3FlbiR3bFH/3sVOSFunOSUhEDms4ChGrlKUk3Ypx7Om18F9ivoOH35KXreBg9a+8vayupq5O0SE76+9nyorK2054nojvb5nbdOLL25r2FItKjIsL9qtYyQvShzOWEmFje+TfmnZX/7w97obbo6XV+v7Xzj+W3XuvhFlsK6mO4gWma2bG5aWdR12TmHbTjrT5ANGEbzA6kkCVlgA7QYlf4gETr0PZ5uWULPw5vrXn96eWVI7EF9RAfuirAGuRJnYlOX1iRl/4UhBu/y2bYeV9GxHyocfSmc4RyvkKEYeK+QT2Gl0pV1JkRkybuigHoeNP22PLsxcctKkpbW1tZJIiLotWWEBUHl5tX5/3TXrV+6c+XC6OdLihPLGti3uGo6EmV9f8eJ7c5effnosJvb+F3p8ayr+N+Rs1kgsNkvVvnXTFs+0Nx0HjjrKUSHDGZfhM8SogJIntBdLdwCE6wXhzT6iRglcn9bX1yR2ut9AAZ/jSoJEQmHO7OaGhS8/27x601s6nHNwu9692+fnhoXSKSkAUR4rRFkhl5k45bFKGdO/f7e84aNHHdu236CKT9Zu2jLjjxd8RMwBG2TGuX42SJtPW157o/bTVc/mOGUjtpsNhbPfuX6StVu2rlixgoHab62AbzXV0tqsH3nqX94ccuSZ4xo3NxnbGFYmowOOkgiMBNyZUAMh/JFBxPfgKGW9VJprNladtKbhjmdjSKgkKr/NUaaYCCeJDICcfpdUXdf/+Mm/6jtuJFSj5zspo3IiDjlghAFExSKU8SQ/L2Kj+VC1b78jC5/92+PP3TX9SgDbRYQp6MChHNW6BhU+gCiAUgCfBEzC72YQhb/NL9dULbREjA9fvPvMzR/+PRUuyoMVK46SbBUZVI8RnxDeJAi1BEeOjcCKBZH9rpgP2SAdU8Tcsvre+LWvXnbJYWtnPPlWvjW6XXGEwm7GaM8FZzEeDjnkpl2V2u6aIUNH4OLrrz/r2hnPvTvgqNMvJiKbHT+iQPhxJqJUIHyh70r438IF/XdX9MF79+wkv3BnaY9RU8LhHBMyaWZhwChoC4Q/sQh/FrT+WHwoy+JbjzY0vf5EfXrpR9/IBe03SAfNn/J4tf7o6d9uWPni00+kGv2GQsc5pFv/PmEFbW2qBSFWpIgRIkKYmU3KJ23ZHDysf9G48vGTo0VdOp84cdzfYrGEqq1NIptiUmD5Fd8pZ0l9+++clFhM1OJXJ70VivY+rHOPEb1t2hj2FSvD0DsAZ6NA+8HMDlkDtizGurSxadHjO9NL1n1nCtibJMywiMUUrVrtfvLOojffeHb+nFAo2qVdWVn/0g5l5Kc8CQHkEIPBUKzAVtg2ttguZW38/oOGjNpYt82fN+famqwSZC9j/Ltmin0X/5NkshIiQrWLHv/Z5jUfNLETUciIRJt9RDZaOM0MdgHOAOwB7FkiY8GM748TmkwasYbK43EN99PViWkXn/jIDb+e8s5Lr32aGwkTRCx8G0DRftB4UeTwtq1NqqAox46uOPbHADBnzmnfK12Sv6Nvayork+w2vv7R5lVzLknt2ubnibbOVhfhPQacEUgmoHJLmgA3IDnZoGL4Pi8J+K1xToioD+Y/Ne+eH58/8YNFSxrDeQ4830oAIgqsIXiiYFlzSwro2bdHh9IOvUZYa4F4nP/DFQAkk5U2HheuXTp9liNLd+R6UGqbLyEfYD+ojmEEMABlH0z63zTSWmUriUw8sTzkuhtWb/n448chYIIYMgbWBowIC4KQgu/DtuvcMdxnyJApAYUd//kKiMfjqqqKbPnx511ybnxM+36HWCPNDmlhKAmCTTDeIEEmIgQrPuPfeNVvWUDMDNZ52yCAQyQKn7OZFSGgqlhAKwXWOgcAFv6nu6B4PM7Tpk0zALpOqjz1Rs5rLz0rfO440oHbQgiHAlqfo4KHYoIiBRJx/k2yp3i8Wv/h5z/PWGs7ti0NX1wYhiiI1lrBUQRFgAOBtgYhDf5s86eZ5ctX/xUAar7HkarvRAEDB04jIpLTLr3p9yOPPDKS2exacRV1O1YBhYD4Aq0QKEEDjmbRoiCejXzvoo/FFCslVVUVfn7bQeMuvfOvL40/7pi26d0GIe0Qc6AAhwWafADGj+SCVy5btaGh7oP3RIS+z7kF/vbfL6ZOPVWZwaMnHVZ+wkmnuyk2OuWr+rUCXULodjShJSNBASbZ8SUmKCGIL9/r+Gp5vFojmTTWmJzDf/iLG69+4KHFx5912uB0s7HWk6DjTgRGMHRuCKawTY5+fcEyvPBM8soszfF7dZP6O7AwSDJJh5143h1tevWVhs88UjscuPUMUUCb4YTCZRbpWiCUGzS+GYCyBOf7Cm6xmJJEwhKR36bb8LGTf/LzB8unTh1SnJ8jO7e4VpNisIL1Ac0W1hqbm+vAtVrNTry8a84jj5y3/B9z5gGg5OfWT7FYjJPf8Wn4VgrI7oUwhx9/0WUjDp80smWHb+xOUplPGCEwrAjgAB0nMNbVCUwKUKHgKJAVZEmA363ss5+JiHDYGdf+asRxJ/+mz+gRnGqCn2nIqLyQYj/LfmYxCCsyhcWOWrNyPeY//dxzM++b9kugYX0sllBErWlynIHpNhD+d4cDfUsFBLlxJNKz68hJU38bihTazGd72P00B2hhuFn6rNcE6BJC6WjBlvkWUSEoDQh5UEQt353o4ywyDURk2nQaMWb8+VfcPOSo48pz8wtkxyeuDRPpkKPR5HFAOTeeLcwLQUWg5s99eePcxx69snbJrCQRMHVqQiWzzI19wLiC/l1PHbVyY9WCAA8i+R+NAYnEQEpWVppJZ150V/9RFXnN2zLifhYhaWCQBcQTWI8gLiG1B8jvR4j2EKRdwFhLvniwrNLfja+Pa6DKEpEdcewlV0y6+r43Bh3/w/KMV+A3bssQW83GMqwleK6BsewXFYV4S916/uvddz9+84XHDK9dMispIiwS50D4cRYI1aDCz3X6Dzx57PwXj57w+1e7tT33JIAkFkuo/zEFBIH3VDN42HEnjJt44knUDF92kDLbNMgLxvXJB+AKyBVQGkj7QMkwBSq0sAIQEQT22y15iseZWKGmqspvW9xz8PGX/uWVMWdOv61dvzGqabNrnLTRDjlBN44J4npSkKv93BD0Gy88v+GPVdefOvPuX5xFTDuzLscCVRKDKKDKEkiG6SsvPaLs0cUHdTrqkLKCHmbcoAsfBIZ1TCRiFvj2FfI3cUEUiyWQTFKbQyade2/XLr0ktaWFsdOBdhkCAYsEzOF9+sPGA7gNoc0woOltARuCeEzfPM6KSlaREUCNPqHq133GH3NVSZ/RuS0ZGLvD5bxcpRgMRQK2BiGCKSgNq60bN+qlf0vOnPvQlZcB2J4QUZVENrD6hCKcZpIg09U5bsSA8Nn3tOXDD0FzGdwW32jPYMjQMWX17tUPE9HkWEw4uT/u6/epgHi8WlVWkn/klBtuHFN+Yhe7Bz52s9aZLHEpS2JlCxgjYCGIBZQh+L5FXg+G3Q7sXi9QMPxNfD3Rb2wySaZduxPGDD/l3Ps7jztmuM8R1H/mmkiIFEcURBgKArieRAvDVimovz//ytbX5/7lVx+9+cRjxIypp8xUlUGgpRhEJUFGgNxROb+7vCeO/HUbMzLcJL5JZVKc3qNUbtTA+sYfNfIHx37y2a+uSibplvLyal1TU+H/W1xQLBZT06dP9PsOrBx/2NGVFxZo5Uu9r2xjCEyqlc66d8oE2a4YIyjz2QICi4JuEMn3radd+nonL3ANIsYZecQtNx164S2vdzvsxOGptDburrQ47ChAQwzgZ3yIb01uYZg+qdusnv3TH2f8+VdHD//ozSceSyREibWUTFaaGBKKQJIEmZ7qpxMnRZ5/YwhfNL3A7x9uSqUMXKXCFKHGOgZSYXieUWU5ETNh/Ck35uZOGLxo0RE+8M3X8fDXdT0iEh01fvK9B/UdqGh3irhJiP2g6c4AyAaAm/gALIEMgUwwQUgQ+C1i8wsjHG7fws2yYxcADMCKf5FRxBQRSzJJpqysfGjFj+a8NvSky68u7Nov1LQzY7UryiGH9q4H833rRBxjWKs3Xpi/9bm7rj+5+pGfnUNEW8rL4zq7ngCB1VcagZSNLnjg9qH5Vy7oRJMPTqcjfsqyKCeiHGZEIgTazdjzMZBb6JDvt2DkoBGhY4785WPW2nA8nhB8w/buV/6l8vK4rqmp8keOvOCCM8+/7cGygnyfm1M606jhZzRsduLEegJjaK8CAp6QgTUe2Co/ByG9pm6Z+/c1L1y7cN2v7wbi9kvyaiovr1bZI54zetxvr+0y9NirS/sP0y2uNSQ+k9YkTIASWBiEIuxHC5Vu3rIBa5c8P2PxXy+5BsDWREJUZXa8NoaEmo1TjUDQK3TxCX1Dp9zRXlX08n1YY1woq5k5wK9YCUgTSBFsxKDbJEFuTwMxylAY6rnn/nBv9ZuXX9oqn+9LASwiQpRX9rML5tQeOnZSsWn0YFxmP02wJpgYsUZgfMB6CFZ1WQBiQMaz+RIFXPA/1jy3au47fzjv0/SCJcGY24Hy6c+Z0t07n1jee+iZt3cZPGUEch1xM65QiNk6DKuz4+rWs+H8EBQL17338vrlC578+bbVT8wlJkw9ZVZrXk8xCCeD9KB0XOixWzvTkefkUye41veJrWbKEgoUQakAw2IFsBNsRnHaG3SaBFhHEM5z/J2Nn+iZyatPWLNm5typU/e+z3ergERMVGWSzKTD7rjvxON+flGYPZ8MaS8dCgSfFb71BcYjWDfbZfJ9OAp+gRPSOzZtxKKPnv7zvFW//CWAxi8LXvv8mzNm8M1VZb0mX5PTdRD5At9xMlpHNTzNIAcg9iEMk1PoqObPtmDV4lkPf/DKL68GUB8X4SoiCaw+ppKYbQBBL3XpD/rQ6be0o7F9PYERtJCiEDMROLvxRGmCVtn5YAZYE5QDeD6QO8Ci3SECz2ZsXmkuvfXe/I8ffWzSYBHJUPb9vrMsKB6P86nT2fQqPWn4wf2mXGT3sM2I0UQhmOwglSDIeKwHSAowLiBexkadKMiIfnvdglWLlz15+Ye7Hn2RiXGKnKKS+xV+nAXThGrI75R/zNiePc+/s6jj5LEe5cie7RkbzVPakgPjEVgBcDMSztVW8rRa/+GST1ZXP3HplpX3P9ea4VT9U4YDIH8C3XtnGU08Pyr90WJbfCZoBwp7Fx1RdiYgu4APioJFfByMMSkG9qwSRDsIcno53LDDNUOHHN3rmKPv/zMRnR6PV+uqqorvbkAjHheuqiL7w6Oe/MeoIaePclMZGwkpVuDsBEm2vWgA3wVMxoI98XMcR2/duRZvr5t7z/O1l/8aQFP2JO1v4n1f16AO7vWba0qLT7xehwaGm33X17mkI0UMJ4/g5BF0xCCSKyZc5Kjdjbux7v3n//bus2dcAGDbvqsU9vX1XSMnj++Jsx/q4o4fkBZYwwQHDjM0WBSIGVrxXktXWsAsIB2gt0wEyg4Viy+wbQ06HsWQiEFuXshPyTb91Mz4jz9Y9uCfYzFRyeRXa7fqfxV4q6rIP7TvFRcN6j55lJ8yPkDa9wIYV2XXtIglkBiQeFJEjmFy9HvrX1k3f9nDV65pSDxLxJgqM1Xlfj5UDDE1G3NMEmTaFk0c0i/v0j8X50wauTsVRarFN05YafIAL02gEKDSruhw2ITD0J+uWbJt5dI5v/v4g9vvaV2fkKwkf19cCEDJyNBtv2krFT+NSG/soZTvEOsQHBBUsOFKETQxlGoVfOvagWAFDanP9wIBAgoR3F2M+hWCDoco+G6LKitrZ46cePatn9S9M3/OHPWVyVv0L8AtyaN2bc+ZMnt1386HFaSkCawcgnWgEKxwYQ4YuGSsKaCQatq+BYuXv/zoUyvPvRrA9uyCCv9fWH10XLtbrikLHXMlZQbnNFgYm++yzVHBm+QAnGsRzrMmvzikgJ3YtunFOW+88qtrgE1r97X61hMLAAfnXlFZ6h16U4k5socxJB61iMOKFSkE+yNDUKSyLicACZXKrpzRgZsjta8Sgg9uVQDH+cqg4wRBYQ+B+DBF7UPqxfkPLf3rXy88JLso5F/uPqIDW38QCI8bcevsI0decUq6xRgOQ4kiEBhsAYZAcVpytGOV56j317xR//bK5y56c9uts1qtfv+Uw5gizDYCQZ+8iyYMjE69o4QPG7Ezo9FsXUsRxSZC8MMECQM26oqTp20kX6ldjUu2bfl07uV1q3//FBEwYcK+6V+AUubgoBGHd77qhvxth55gvBL4BEMkSgHgLBeISUFJCJoVlM5uPHEC4bcKHtln1pJdkSWg1p1wOlhJwyWCroczQmGLcA77iKb1kzOm3VK96NarY7HEv8yK9lvBxZBQL26cYvqW/PDEI4dfXBUOFxjxrQI0rE8Bq0FcsPgmh3K4fncjL3x/1rzHll409ZPmlxYlYqKSK6ahdj/7EcpRretwlQFQfEjhw/EBoR/9ucgM67i9yTeuGCLlsBABzFDaQinXRMIR9rCTP90y94n3/nHF6Q07n1kcjwsvXAiqy87ixuPCNTUkx0669o4zTrrh0REDK/qF83LNZ7ta0NIC5YhGSDlgOGBoKNJQSsHRFFh9VgGfB10C6WwJrynYipXd2sQKYA1wKJiJExKUdhVAXMoryjFFpe3Gbdiw9sU3l9y6OTZ1qqr9kp7y/iphGhCPiYg4Yw8+9fftS3qK76ZIsYZYgGBhbUaUaD8qUVW7/s3dTy/5zc+eXnbOFKLNa8vL4zrr6+WfXVoMompQ4bfLP2pMRZuFr3XX51/juT3sFr/FwhGlSBEsgQXQKoOIMqaAI2rX7vcb13x0xxm1K354JrCyLhub9lfAEWvJ10V5Ih0iKDk0gnFnFNOQYwsRaq+Q9g1gGBEOIawchDQHvWoFaC2BkFkCl5NdPxYs4xMguyOUlAAhgBxAhQjhXELqM6Bxm0UkR1Nql0f9+gzRh088/2GxNhKLJb7U03zhBMTL47pqRoUp73NVfNzw808xnmNgSAU7QQ1IfJPvRNlvSfGS5c8ueOLNS0/Y2PD8KyJC06YJ1+1nOjwGUbWosLWokgEFN13Ty7nssTw7qnOz5/s+GcUIkU/BLQiYfIi4Nkoh4bCojXtqli7b8PsfNDQ/siCw8s+tft+rpqZKAKGPPjrybyveff+1aF7+kOIO7TrpskLK6U6m2xDNBW0V3LRFpiFYMxwKASpb5TJl94Fqys6ktlp/dkGrDk4EawKFBMohaAdQUUA7QDoF5JZpRPKIxYrp1rt/hz31VHTLrROfj8fjumafxSJfooA4v77xRtOhZOxBR4y48pEip5uTybisoElsRqJa2WIdUWvr3s4seO/R6S+sufQnBvX15eVxfe65FfaL3Mk4CxaiEmRLQ0P7HBy+/7EO9rSLVEtnnfHSlsBKLMPY7CQ6+XBg/AKJqiavjlY1zImvqI+da7FmWzniekZNhflyfmYV4nHheS+fV/feh8k/uRk3E4kUjOrYpVtURWEKulrqMjxMeR2A5rRBy56gN601IEFcDqxeI3A7+vPtuNTqdrKuh53sKXAIOhrwnIwnaNPFgnWGcnMipqS0y9hP1m97a84zD6yOxWL7dUX0BYw9SfakcffNGzfgosnpphajNRQsTGEoR7Wk9+DDj+e99sKy26/a4b37jogQ0bT90rX34fzzgMjt/9WBJl6X4w3Na/LThshnYoeEg9yaAVj2bETnUK5l2uq/sXy1++Rl2/BAdQBXTPtalPBYLKYSQVNeHHQZeMppN9x08Ijjj29T1B7Gz/ikWEuTg88+sNj6toW7mRFiggoD0ALobP4f2kcJrcJ3EKTD2deUBlQ4UISwRdu+FiU9GOkWsQVtNNUsenHrHbdPPlhEdgRZ1H+HXvTnwTGuk0nyD+7845MGtDt5cnqPMVYyzCrXj0RDes2n/2h4Z/Uz0xevv+mO1hqBiPaTXsaUBDc5MG1wzICBoYsfLFQTD82kc9BgWowiUUKAgQsRgvEMHIT94tI87an1WN2w+O733bOuAZCOQVQQ8r/eGstkMmmIKAAQX69aMXPmT6bUrb3ovHETTprep/+RndIpGM9PU9GwEBf0Vdj5ocVn71qkdweryxzNYCdL53OClTRw9nFFDrKuSUAO7V1dz5qw+1MgVEyI5hE3N2RM+YSjO9RtuOV+IooFVTL+2/ehz5ljQlVVFP7xxBfeOajTsf12724y+QV5TrO3HSu3zn/2uaW3/dp1l9VKXPgA4/gUdIiC8r9/6XWXdZcTf1vUPCK3Hq7vWii2iixZiLgwYmENbH6bHOS3I96Rqlny0e4nrtm0+5HXA6bOTIVvNzWz1w0mEtMoC0F3r5z6x+v7DzzmvI7tu6Fhl+cbA50T1bCNwPY1FtvXWqARiIQVVITAjmQfn8eBVq6l0kEgVjqIJawBsEWk2KJtbwZMBuFQyN/RuF0/9Mf4T997/08P/jNqSsGRDfLVIwZNu/7o4b+Yzi6nnZxI5KNt7za8v/7ZXy6uvenRfSHp/VazNMeIWLTNnzSuV/sf39E25+ixnCmAqU8b8bXyhOH7AmMsfHggLaZtt1xlitZhU3111VsrfjIdgM2yEL7z5a3l5XH9+uvTfRHB6IOuOG7EoSfeNWjY+N7iizQ1uKLZ4XCE4DcLdq7zsWeTgDyFUJihnMDqWQfMMlFBXcDZE6GcLN1SC1gRBD7yOwG5xQw340lJu4i8905Ny313/mzQHnd1nbXX762S6XPYt1v3i4+ZuXx4p3GRbZ9t4Q+2vzh//rs3/aLe/Wjll1n9Pnh90agBt/xXWf4x1+TrwZxugpFMhpUfIvEEGU/gswVFM5JXFrZ57R318c4FK2s/euSy+k+fepWIIXKKAr7X9cWcSEjraWg75Zi7rj54aPkvu3YdSnt2+8Z6wuGIonAYMM0WuzYZNO0gkM/Q2WxJOOuaOHBDzNksSgWbE6EkWGEZsSjqyIjkWGjHM8Ulueq5px/6+0N/vvDweLzab62SVSx2MVdWDrKnjrz70fL+xw9euf7tzKJVT103b/kVP02Z+h3l5XF97owvZh+xWEKtXDnHbtjwmO3d9dTjRw6+dXanjmecSNQeru9ZFqMIiqwIbMhCl/jI62xM8cBclsIWXvvxrGeWLDn5+FTjhyvLy6v1hg2PyXcxdfgvLkkmqyT47LObVq99af62jVtfiYZDQ7t279MppzBEYjKWCBQp0CjpyijqSOAQ4JuAQq0c2tugaa2WudX9KEApAquA9WhJkJPP0AyGaL9n34O67trRLI8+9rMFrakpAcCRA24/94gBpz2ydtOCBbOW3nFZE5bVfkmGs6/VF4wd+fCN7TtWXBbSPdHQ4PqUEa1FBzPCFiDyoXN9yS8L21AbpTZtWt60avkz1234+Ia7A6v/rnz91+8G7rM9PXLsxBt/N+7QEy7ue9CQULoFxnddDocVOU5QHzQ3CnZ/KmjcAfg+QBwsVmEOgjErgnICIE9xkKKStshvAxQUMZg9KSkLmzVrPpA7bv7VkWvrXnx96tSpigDQ6N6/ej0/FJ2/oPaGG0FA+YTWHWz4gtXPnn2qERH06fqj43oNOP+OgtKKvs2NsF5LCmwVS0YFg9oUZA+RHM/kl0bZ5TStW/fS4veW3vIzz1uyPAuaCf6Hb/ATi8XU7NlB/OpQdMhhU068+M5x46eMKCjIR9Me34BIsWIoJ1jd1LwH2LFF0LQ7aLcq3RqEsw8H0ErAToAhOSFBUSkhN9+HYs+2Kc3l556dtemmm04bJCJ7WokMGoB3YKuPczw+DVmUsfiQCffe2b7rMWfrcC+0NBofntUQzrYiASGBIlciuY7JKXT0Z/Ur/LUfzbth3fJrfr9v0Md/zrVvBsdHH3rVrw4/MnZN/8Ej85ob4WfSntIhRcQBZkQiaGoQ7NwOpJsBRQzHCYSvHEA7ElTJTuCaIjkG+UUEx7EgIlNQxOqRB377/GOP33A87Wvd+xNKLJZQydmVBgIMHHjZ+b0POrWqpNMhnVoysG6LC8WaxSJoxFuAxQPBN9GcHOVKGnXrXljy/rJHr0g3zlvyZYXbf8K17900cpzBw8844+e3HzL+5MPzCorRuNs1rDi4Qx4FAJ4VoKVZ0FAvcNME1oRQCNChAFtS2YqZlSCaA4SigDHWlpU59Nqrz6y/cdrJvWifdFQOAFcLMLjnxCOvuq/7QccdQ04xWpqNT2I1M8NkKf5MBjAeNCk/HHL0lq0rW9atfvk3tct/eQsA820JTP/Oa990e+KhV1515NE/uH7IsEPzUi3w0ylXhcKKSBiS3eVkAbSkBC1NQU9cOwG8QVnhkwr6JqEwQcTY4mKHX1swZ8VtN08ddOA76WVPRL+h103t3+f4Rzp0HZOfcq3JZDJMCFErkEoKUGSh4Nqc3Ki4rqhVH7yy5IN3H724oWHme//pVv8V2Na20Ok/7EfnXHVz+ZFTjiouLkFLkzEioogUjAlasq0Nm3QGyKRbA3WALwWBThDSBIixRUWaX69JrLjj9tMG8YEzhJgFigu79Bh7b+f+Y/KbUp5nfKOUcgj8+X5lggsHrgnnR3nrzo1q6Rt/umlR9aTDGxpmvjdixINOwBL433iDz4BtHS+P6wZv5Xv3/+ncY//8x/iF77396o42pUoVFmmrtG8jEYtQOLvqXgkK8oGytkCbEkEoLNmb+QCwgO8LXM9AaZLmdEPel/SE40TMFsgJM3NeqgWGjMes2PpC2TsH+SAyCDkR6BCrVbU1H3/w9ycvrP/sT3uLqnf+aVf+/8arqqaqtcdsieih+dV/fumn5955yxGTjj+1W4/OaGwwJuO5FEx9AiZL+HY0ITdXIAAyGQGzAbOHkjaFdtvWLXrtqvfvOGBHLNgBkVC1tU815ReP1u3aDZwYzc1lx9EUjmgKhRSFI5oiuQ6lva204u0nn1j8SuwHqeZ3/51F1b/xCvbXlZfH9caNr+16+715sz9eu3OFGIzu2ad3m6KiMIXDmqJRTdEcRZGoorATPOflK8rL15Sb61BpSYR21m/lROLBK+a/fNtdsda7KB24XywASIYM/e1NhW27nWD8jFXKYfFdkIQtwmHetvWd3615/+Yn/vVO0P8zFwVxjSyAvNhJ109r16HDsWKsJeLsckuLAFBkkFIgJrBoo0Ih9f6Hbz264JW7b43H47rqq9y+66vcNVr2rpv9/+eKxRKKvuF4Qzwue2Pv/wPW3QpseKLI6wAAAABJRU5ErkJggg==" alt="Xtivio"></div>
    <h1>Check your email</h1>
    <p class="sub">We sent a verification link to <strong id="verifyEmailAddr">your email</strong>. Click the link to verify, then come back here.</p>

    <p class="note">
      You must verify your email before you can pair with your Xtivio device.
      If you don't see the email, check your spam folder or use the resend
      button below.
    </p>

    <button class="btn-primary" id="verifyContinueBtn">I've verified &mdash; continue to pair</button>
    <button class="btn-secondary" id="verifyResendBtn">Resend verification email</button>
    <div id="vMsg" class="msg hidden" role="status" aria-live="polite"></div>
  </section>

  <!-- ============== SCREEN: pair (the actual form) ============== -->
  <section class="card screen" data-screen-id="pair" hidden>
    <button class="back-link" data-go="landing">&larr; Back</button>
    <div class="logo"><img src="data:image/png;base64,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" alt="Xtivio"></div>
    <h1>Pair your device</h1>
    <p class="sub">Enter the pairing code shown on your device screen and a playlist source.</p>

    <!-- Visible when signed in. Lets the user see whose
         account will be handed to the device and gives them a one-tap sign-out
         if they don't want to share that session. Hidden by JS when no
         user is signed in (the "continue without account" path). -->
    <div class="auth-banner" id="authBanner" hidden>
      <span class="auth-banner-text">Signed in as <strong id="authBannerEmail"></strong>. The device will inherit this session when you pair.</span>
      <button type="button" class="link-btn" id="authSignOutBtn">Sign out</button>
    </div>

    <div class="field-group">
      <label for="code">Pairing Code</label>
      <input id="code" type="text" value="${prefilledCode}" placeholder="ABC123" maxlength="16" autocomplete="off">
    </div>

    <!-- Sync-only submit. Visible only when the user
         is signed in on the landing page (JS shows/hides based on auth
         state). Lets the user hand their Firebase session to the device
         WITHOUT also pushing a new playlist — useful when they just
         want the device to pull their existing cloud-synced data.
         Styled as btn-primary to match Send to device; margin-bottom adds
         breathing room before the playlist form. -->
    <button class="btn-primary" id="submitSyncOnly" hidden style="margin-bottom:20px">Just sign in (no new playlist)</button>

    <div class="field-group type-select-group">
      <label for="typeSelect">Playlist type</label>
      <select id="typeSelect" class="type-select">
        <option value="m3u">M3U URL</option>
        <option value="file">Upload File</option>
        <option value="xtream">Xtream</option>
        <option value="stalker">Stalker / MAG Portal</option>
        <option value="epg">External EPG</option>
      </select>
    </div>

    <div class="panel active" data-p="m3u">
      <div class="field-group"><label for="m_name">Playlist Name</label><input type="text" id="m_name" placeholder="My Playlist"></div>
      <div class="field-group"><label for="m_url">M3U URL</label><input type="text" inputmode="url" id="m_url" placeholder="http://example.com/playlist.m3u"></div>
      <label class="auth-toggle"><input type="checkbox" id="m_auth"> This URL requires a login</label>
      <div class="auth-fields" id="m_auth_fields" hidden>
        <div class="field-group"><label for="m_auth_user">Username</label><input type="text" id="m_auth_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="m_auth_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="m_auth_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="m_auth_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
      <div class="field-group"><label for="m_epg">EPG URL <span class="optional">(optional)</span></label><input type="text" inputmode="url" id="m_epg" placeholder="http://example.com/epg.xml"></div>
      <label class="auth-toggle"><input type="checkbox" id="m_epg_auth"> EPG URL requires a login</label>
      <div class="auth-fields" id="m_epg_auth_fields" hidden>
        <div class="field-group"><label for="m_epg_auth_user">Username</label><input type="text" id="m_epg_auth_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="m_epg_auth_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="m_epg_auth_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="m_epg_auth_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
    </div>

    <div class="panel" data-p="file">
      <div class="field-group"><label for="f_name">Playlist Name</label><input type="text" id="f_name" placeholder="My Playlist"></div>
      <div class="field-group">
        <label for="f_input">Playlist file</label>
        <input type="file" id="f_input" accept=".m3u,.m3u8,.pls,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,audio/mpegurl,audio/x-scpls,text/plain">
        <p class="hint">Accepted: .m3u, .m3u8, .pls, .txt &mdash; up to 5&nbsp;MB. The file is held on the pairing server briefly so your device can fetch it.</p>
        <p class="file-chosen" id="f_chosen" hidden></p>
      </div>
      <div class="field-group"><label for="f_epg">EPG URL <span class="optional">(optional)</span></label><input type="url" id="f_epg" placeholder="http://example.com/epg.xml"></div>
      <label class="auth-toggle"><input type="checkbox" id="f_epg_auth"> EPG URL requires a login</label>
      <div class="auth-fields" id="f_epg_auth_fields" hidden>
        <div class="field-group"><label for="f_epg_auth_user">Username</label><input type="text" id="f_epg_auth_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="f_epg_auth_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="f_epg_auth_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="f_epg_auth_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
    </div>

    <div class="panel" data-p="xtream">
      <div class="field-group"><label for="x_name">Playlist Name</label><input type="text" id="x_name" placeholder="My Xtream"></div>
      <div class="field-group"><label for="x_host">Server URL</label><input type="url" id="x_host" placeholder="http://server.com:8080"></div>
      <div class="field-group"><label for="x_user">Username</label><input type="text" id="x_user" autocomplete="off"></div>
      <div class="field-group"><label for="x_pass">Password</label><div class="pass-wrap"><input type="password" id="x_pass" autocomplete="off"><button type="button" class="pass-toggle" data-pass-target="x_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    </div>

    <div class="panel" data-p="stalker">
      <div class="field-group"><label for="s_name">Playlist Name</label><input type="text" id="s_name" placeholder="My Portal"></div>
      <div class="field-group"><label for="s_url">Portal URL</label><input type="url" id="s_url" placeholder="http://portal.example.com/c"></div>
      <div class="field-group"><label for="s_mac">MAC Address</label><input type="text" id="s_mac" placeholder="00:1A:79:XX:XX:XX" autocomplete="off" maxlength="17"></div>
      <div class="field-group"><label for="s_serial">Serial Number <span class="optional">(optional)</span></label><input type="text" id="s_serial" placeholder="Only if your portal requires it" autocomplete="off" maxlength="64"></div>
      <div class="field-group"><label for="s_devid">Device ID <span class="optional">(optional)</span></label><input type="text" id="s_devid" placeholder="Only if your portal requires it" autocomplete="off" maxlength="128"></div>
      <div class="field-group"><label for="s_model">STB model <span class="optional">(optional)</span></label><select id="s_model"><option value="">Default (MAG200)</option><option>MAG200</option><option>MAG250</option><option>MAG254</option><option>MAG256</option><option>MAG270</option><option>MAG322</option><option>MAG324</option><option>MAG420</option><option>AuraHD</option></select></div>
      <div class="field-group"><label for="s_model_custom">Custom model <span class="optional">(optional, overrides the list)</span></label><input type="text" id="s_model_custom" placeholder="Only if your provider named another model" autocomplete="off" maxlength="32"></div>
      <p class="hint">Stalker/MAG portals authenticate by MAC address. Most need only the MAC; some also require the box's Serial Number and Device ID — leave those blank unless your provider gave them to you. The portal supplies its own guide; to use your own instead, add it via the External EPG option.</p>
    </div>

    <!--
      External EPG tab. Mirrors the in-app "Manage EPG Sources" modal:
      up to 3 XMLTV URLs and an override toggle. Sent as an EPG-only
      payload to the device (no playlist), which applies it to the
      currently active playlist. Requires an app version that supports
      action: 'set-external-epg'.
    -->
    <div class="panel" data-p="epg">
      <p class="panel-intro">
        Set the external XMLTV sources on your device (up to 3). External
        sources load <em>after</em> the provider EPG and fill missing
        programme data only &mdash; unless you enable override, in
        which case they replace the provider EPG entirely.
      </p>
      <div class="field-group"><label for="e_url1">External EPG URL 1</label><input type="url" id="e_url1" placeholder="http://example.com/epg.xml"></div>
      <label class="auth-toggle"><input type="checkbox" id="e_auth1"> This URL requires a login</label>
      <div class="auth-fields" id="e_auth1_fields" hidden>
        <div class="field-group"><label for="e_auth1_user">Username</label><input type="text" id="e_auth1_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="e_auth1_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="e_auth1_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="e_auth1_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
      <div class="field-group"><label for="e_url2">External EPG URL 2 <span class="optional">(optional)</span></label><input type="url" id="e_url2" placeholder="http://example.com/epg.xml"></div>
      <label class="auth-toggle"><input type="checkbox" id="e_auth2"> This URL requires a login</label>
      <div class="auth-fields" id="e_auth2_fields" hidden>
        <div class="field-group"><label for="e_auth2_user">Username</label><input type="text" id="e_auth2_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="e_auth2_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="e_auth2_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="e_auth2_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
      <div class="field-group"><label for="e_url3">External EPG URL 3 <span class="optional">(optional)</span></label><input type="url" id="e_url3" placeholder="http://example.com/epg.xml"></div>
      <label class="auth-toggle"><input type="checkbox" id="e_auth3"> This URL requires a login</label>
      <div class="auth-fields" id="e_auth3_fields" hidden>
        <div class="field-group"><label for="e_auth3_user">Username</label><input type="text" id="e_auth3_user" autocomplete="off" placeholder="username"></div>
        <div class="field-group"><label for="e_auth3_pass">Password</label>
          <div class="pass-wrap"><input type="password" id="e_auth3_pass" autocomplete="off" placeholder="password"><button type="button" class="pass-toggle" data-pass-target="e_auth3_pass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
        </div>
      </div>
      <label class="toggle-row" for="e_override">
        <input type="checkbox" id="e_override">
        <span class="toggle-label">
          <span class="toggle-title">Override provider EPG</span>
          <span class="toggle-sub">When on, external sources take precedence over the provider EPG instead of just filling gaps.</span>
        </span>
      </label>
      <p class="hint">Leave URL fields blank to clear those slots on the device.</p>
    </div>

    <!--
      Content-types selection. Shown for all playlist tabs (m3u / file /
      xtream); hidden when the user is on the External EPG tab since
      that path does not create a playlist. Sent as a contentTypes
      field in the submitted payload and applied by the device at activation.
    -->
    <div class="ct-section" id="ctSection">
      <h3 class="ct-section-title">Choose what to show</h3>
      <p class="ct-section-sub">Pick the content categories you want in your app. You can change this later in Settings on your device.</p>
      <label class="toggle-row" for="ct_live">
        <input type="checkbox" id="ct_live" checked>
        <span class="toggle-label">
          <span class="toggle-title">Live TV</span>
          <span class="toggle-sub">Channels with EPG (electronic program guide).</span>
        </span>
      </label>
      <label class="toggle-row" for="ct_movies">
        <input type="checkbox" id="ct_movies" checked>
        <span class="toggle-label">
          <span class="toggle-title">Movies</span>
          <span class="toggle-sub">Video-on-demand films (Xtream & Stalker portals).</span>
        </span>
      </label>
      <label class="toggle-row" for="ct_series">
        <input type="checkbox" id="ct_series" checked>
        <span class="toggle-label">
          <span class="toggle-title">Series</span>
          <span class="toggle-sub">TV shows with seasons/episodes (Xtream & Stalker portals).</span>
        </span>
      </label>
    </div>

    <!--
      Per-playlist EPG toggle. Separate from content-types: it controls
      whether the device loads a programme guide for this playlist, not which
      content sections show. Sent as the epgEnabled boolean in the payload
      and applied by the device at activation. Defaults to enabled.
    -->
    <div class="ct-section" id="epgSection">
      <h3 class="ct-section-title">TV guide (EPG)</h3>
      <p class="ct-section-sub">Load the programme guide for this playlist. Turn off on slow devices or very large guides — channels still work, just without now/next info. You can change this later on your device.</p>
      <label class="toggle-row" for="pl_epg">
        <input type="checkbox" id="pl_epg" checked>
        <span class="toggle-label">
          <span class="toggle-title">Enable EPG</span>
          <span class="toggle-sub">Fetch and show programme data for this playlist.</span>
        </span>
      </label>
    </div>

    <button class="btn-primary" id="submit">Send to device</button>
    <div id="msg" class="msg hidden" role="status" aria-live="polite"></div>

    <p class="disclaimer">This service does not provide any content, channels or subscriptions. Users must supply their own IPTV playlists.</p>
  </section>
</div>

<script>
(function(){
  'use strict';
  var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  var ALLOWED_EXTS = ['.m3u','.m3u8','.pls','.txt'];

  // ---- Firebase config ----
  // Same project as the TV app's assets/js/config.js.
  // Mirroring it here lets the pairing page sign users into the same
  // Firebase Auth instance. The apiKey is not a secret — see the README's
  // security notes section. Config comes from the single FIREBASE_CFG_JS source.
  var FIREBASE_CFG = ${FIREBASE_CFG_JS};

  // ---- Helpers ----
  function $(id){ return document.getElementById(id); }

  function showInlineMsg(el, text, isOk){
    if (!el) return;
    el.textContent = text;
    el.className = 'msg ' + (isOk ? 'ok' : 'err');
    try { el.scrollIntoView({behavior:'smooth', block:'center'}); }
    catch(e) { try { el.scrollIntoView(false); } catch(_) {} }
  }
  function hideInlineMsg(el){ if (el) el.className = 'msg hidden'; }

  // Translate raw Firebase errors into user-friendly text. Firebase's
  // default messages are wordy and lead with auth/error-code.
  function friendlyAuthError(err){
    var code = err && err.code;
    switch (code) {
      case 'auth/email-already-in-use': return 'That email is already registered. Try signing in instead.';
      case 'auth/invalid-email': return "That doesn't look like a valid email address.";
      case 'auth/weak-password': return 'Password is too weak. Use at least 8 characters.';
      case 'auth/missing-password': return 'Please enter a password.';
      case 'auth/user-not-found': return 'No account with that email. Create one first?';
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
      case 'auth/invalid-login-credentials':
        return 'Wrong email or password.';
      case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes and try again.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      case 'auth/unauthorized-domain': return 'This domain is not authorised for sign-in in Firebase. Add it in Firebase Console.';
      case 'auth/operation-not-allowed': return 'Email/password sign-in is not enabled in Firebase.';
      default: return (err && err.message) || 'Sign-in failed.';
    }
  }

  // ---- Firebase init ----
  var auth = null;
  var currentUser = null;
  function initFirebase(){
    if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') {
      console.warn('[firebase] SDK not loaded yet; retrying in 200ms');
      setTimeout(initFirebase, 200);
      return;
    }
    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CFG);
      }
      auth = firebase.auth();
      auth.onAuthStateChanged(function(u){
        currentUser = u || null;
        updateAuthUi();
      });
    } catch (e) {
      console.error('[firebase] init failed:', e);
    }
  }
  initFirebase();

  // ---- Auth banner on the pair screen ----
  // Only show the banner if we have BOTH a verified user
  // AND a non-empty email. Earlier code showed the banner with a blank
  // email (rendering "Signed in as . The TV will inherit...") when the
  // currentUser snapshot lacked an email field — typically right after
  // sign-up, before user.reload() repopulates the profile. We also
  // proactively reload once on banner-show to refresh stale snapshots.
  var bannerReloadInFlight = false;
  function updateAuthUi(){
    var banner = $('authBanner');
    var emailEl = $('authBannerEmail');
    var syncOnlyBtn = $('submitSyncOnly');
    if (!banner || !emailEl) return;
    var rawEmail = currentUser && currentUser.email ? String(currentUser.email).trim() : '';
    // Require @ in the email AND minimum length to guard
    // against garbage values like '.' or single chars that previously
    // rendered as "Signed in as ." with an effectively blank banner.
    var emailLooksReal = rawEmail.length >= 3 && rawEmail.indexOf('@') > 0;
    var email = emailLooksReal ? rawEmail : '';
    var verified = !!(currentUser && currentUser.emailVerified);
    if (verified && email) {
      banner.removeAttribute('hidden');
      emailEl.textContent = email;
      // Reveal sign-in-only button when signed in.
      if (syncOnlyBtn) syncOnlyBtn.removeAttribute('hidden');
    } else {
      banner.setAttribute('hidden', '');
      emailEl.textContent = '';
      // Hide sign-in-only button when not signed in.
      if (syncOnlyBtn) syncOnlyBtn.setAttribute('hidden', '');
      // If we have a user but no usable email yet (Firebase profile not
      // fully loaded), trigger a single reload to repopulate. Guard
      // against re-entry so we don't loop.
      if (currentUser && !email && !bannerReloadInFlight && currentUser.reload) {
        bannerReloadInFlight = true;
        currentUser.reload().then(function () {
          bannerReloadInFlight = false;
          updateAuthUi();
        })['catch'](function () { bannerReloadInFlight = false; });
      }
    }
  }

  // ---- Sign-up handler ----
  var suMsg = $('suMsg');
  var suBtn = $('signupBtn');
  if (suBtn) suBtn.addEventListener('click', function(){
    hideInlineMsg(suMsg);
    if (!auth) { showInlineMsg(suMsg, 'Firebase not initialised — refresh the page.', false); return; }
    var email = ($('su_email').value || '').trim();
    var p1 = $('su_pass').value || '';
    var p2 = $('su_pass2').value || '';
    if (!email || email.indexOf('@') < 1) { showInlineMsg(suMsg, 'Enter a valid email.', false); return; }
    if (p1.length < 8) { showInlineMsg(suMsg, 'Password must be at least 8 characters.', false); return; }
    if (p1 !== p2) { showInlineMsg(suMsg, "Passwords don't match.", false); return; }
    suBtn.disabled = true; suBtn.textContent = 'Creating account...';
    auth.createUserWithEmailAndPassword(email, p1)
      .then(function(cred){
        return cred.user.sendEmailVerification().then(function(){
          var addr = $('verifyEmailAddr');
          if (addr) addr.textContent = email;
          go('verify-email');
        });
      })
      ['catch'](function(err){
        showInlineMsg(suMsg, friendlyAuthError(err), false);
      })
      .then(function(){
        suBtn.disabled = false; suBtn.textContent = 'Create account';
      });
  });

  // ---- Sign-in handler ----
  var siMsg = $('siMsg');
  var siBtn = $('signinBtn');
  if (siBtn) siBtn.addEventListener('click', function(){
    hideInlineMsg(siMsg);
    if (!auth) { showInlineMsg(siMsg, 'Firebase not initialised — refresh the page.', false); return; }
    var email = ($('si_email').value || '').trim();
    var pass = $('si_pass').value || '';
    if (!email || !pass) { showInlineMsg(siMsg, 'Enter your email and password.', false); return; }
    siBtn.disabled = true; siBtn.textContent = 'Signing in...';
    auth.signInWithEmailAndPassword(email, pass)
      .then(function(cred){
        if (!cred.user.emailVerified) {
          var addr = $('verifyEmailAddr');
          if (addr) addr.textContent = email;
          go('verify-email');
          return;
        }
        go('pair');
      })
      ['catch'](function(err){
        showInlineMsg(siMsg, friendlyAuthError(err), false);
      })
      .then(function(){
        siBtn.disabled = false; siBtn.textContent = 'Sign in';
      });
  });

  // ---- Forgot password ----
  var forgotBtn = $('forgotBtn');
  if (forgotBtn) forgotBtn.addEventListener('click', function(){
    hideInlineMsg(siMsg);
    if (!auth) { showInlineMsg(siMsg, 'Firebase not initialised — refresh the page.', false); return; }
    var email = ($('si_email').value || '').trim();
    if (!email) { showInlineMsg(siMsg, 'Enter your email above, then press Send reset email.', false); return; }
    auth.sendPasswordResetEmail(email)
      .then(function(){ showInlineMsg(siMsg, 'Reset email sent (if the address exists in our system).', true); })
      ['catch'](function(err){ showInlineMsg(siMsg, friendlyAuthError(err), false); });
  });

  // ---- Verify email screen ----
  var vMsg = $('vMsg');
  var vContinue = $('verifyContinueBtn');
  if (vContinue) vContinue.addEventListener('click', function(){
    hideInlineMsg(vMsg);
    if (!auth || !auth.currentUser) {
      showInlineMsg(vMsg, 'No active session. Sign in again.', false);
      return;
    }
    vContinue.disabled = true; vContinue.textContent = 'Checking...';
    auth.currentUser.reload()
      .then(function(){
        if (auth.currentUser && auth.currentUser.emailVerified) {
          go('pair');
        } else {
          showInlineMsg(vMsg, 'Not verified yet. Click the link in your email, then try again.', false);
        }
      })
      ['catch'](function(err){
        showInlineMsg(vMsg, friendlyAuthError(err), false);
      })
      .then(function(){
        vContinue.disabled = false; vContinue.textContent = "I've verified — continue to pair";
      });
  });
  var vResend = $('verifyResendBtn');
  if (vResend) vResend.addEventListener('click', function(){
    hideInlineMsg(vMsg);
    if (!auth || !auth.currentUser) {
      showInlineMsg(vMsg, 'No active session. Sign in again.', false);
      return;
    }
    vResend.disabled = true; vResend.textContent = 'Sending...';
    auth.currentUser.sendEmailVerification()
      .then(function(){ showInlineMsg(vMsg, 'Verification email resent.', true); })
      ['catch'](function(err){ showInlineMsg(vMsg, friendlyAuthError(err), false); })
      .then(function(){ vResend.disabled = false; vResend.textContent = 'Resend verification email'; });
  });

  // ---- Sign out from pair-screen banner ----
  var signOutBtn = $('authSignOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', function(){
    if (!auth) return;
    auth.signOut().then(function(){
      hideMsg();
      showMsg('Signed out. Continuing without an account — the device will keep its own session if it has one.', true);
    });
  });

  // ---- Mint a fresh custom token for the signed-in user ----
  // Returns Promise<{customToken, email, uid}>. Caller bundles into __auth.
  function getCustomTokenForCurrentUser(){
    if (!auth || !auth.currentUser) return Promise.reject(new Error('not signed in'));
    if (!auth.currentUser.emailVerified) return Promise.reject(new Error('email not verified'));
    return auth.currentUser.getIdToken(true).then(function(idToken){
      return fetch('/api/mint-custom-token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({idToken: idToken})
      }).then(function(r){
        return r.json().then(function(j){ return {ok:r.ok, j:j}; });
      }).then(function(o){
        if (!o.ok) throw new Error((o.j && o.j.error) || 'Failed to mint custom token');
        return o.j;
      });
    });
  }

  // ---- Screen routing ----
  var screens = document.querySelectorAll('.screen');
  function go(id){
    for (var i = 0; i < screens.length; i++) {
      var s = screens[i];
      if (s.getAttribute('data-screen-id') === id) s.removeAttribute('hidden');
      else s.setAttribute('hidden','');
    }
    window.scrollTo({top:0, behavior:'auto'});
    if (id === 'pair') {
      updateAuthUi();
      var c = $('code');
      if (c) { try { c.focus(); } catch(e) {} }
    }
  }
  var triggers = document.querySelectorAll('[data-go]');
  for (var n = 0; n < triggers.length; n++) {
    (function(el){
      el.addEventListener('click', function(ev){
        ev.preventDefault();
        go(el.getAttribute('data-go'));
      });
    })(triggers[n]);
  }

  // ---- Tab switching ----
  var typeSelect = $('typeSelect');
  var panels = document.querySelectorAll('.panel');
  function applyTabState(tab) {
    for (var k = 0; k < panels.length; k++) panels[k].classList.toggle('active', panels[k].getAttribute('data-p') === tab);
    var btnEl = $('submit');
    if (btnEl) btnEl.textContent = (tab === 'epg') ? 'Apply EPG sources to device' : 'Send to device';
    // Content-types picker + per-playlist EPG toggle apply only to Xtream and
    // Stalker, which expose a real live/movies/series split. M3U (URL or
    // uploaded file) is a single flat list, and the EPG tab creates no playlist
    // — so hide both pickers for m3u, upload, and epg.
    var showCt = (tab === 'xtream' || tab === 'stalker');
    var ct = $('ctSection');
    if (ct) ct.classList.toggle('hidden', !showCt);
    var epgSec = $('epgSection');
    if (epgSec) epgSec.classList.toggle('hidden', !showCt);
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', function(){ applyTabState(typeSelect.value); });
    applyTabState(typeSelect.value);
  }

  // M3U "requires login" toggles reveal their username/password fields.
  function wireAuthToggle(chkId, fieldsId) {
    var chk = $(chkId), fields = $(fieldsId);
    if (!chk || !fields) return;
    chk.addEventListener('change', function () {
      if (chk.checked) fields.removeAttribute('hidden');
      else fields.setAttribute('hidden', '');
    });
  }
  wireAuthToggle('m_auth', 'm_auth_fields');
  wireAuthToggle('m_epg_auth', 'm_epg_auth_fields');
  wireAuthToggle('e_auth1', 'e_auth1_fields');
  wireAuthToggle('e_auth2', 'e_auth2_fields');
  wireAuthToggle('e_auth3', 'e_auth3_fields');
  wireAuthToggle('f_epg_auth', 'f_epg_auth_fields');

  // ---- File chooser feedback ----
  var fInput = $('f_input');
  var fChosen = $('f_chosen');
  // The file is read the moment it is chosen. A phone browser can lose access to a chosen file
  // while the page stays open for a long time, and reading it only at send time then failed with
  // a raw "The operation was aborted."
  var pickedFile = null;
  if (fInput) fInput.addEventListener('change', function(){
    var f = fInput.files && fInput.files[0];
    pickedFile = null;
    if (!f) { fChosen.setAttribute('hidden',''); fChosen.textContent = ''; return; }
    fChosen.textContent = 'Selected: ' + f.name + ' (' + Math.round(f.size/1024) + ' KB)';
    fChosen.removeAttribute('hidden');
    var pf = { name: f.name, size: f.size, text: null, failed: false, ready: null };
    pf.ready = f.text().then(function (t) { pf.text = t; }, function () { pf.failed = true; });
    pickedFile = pf;
  });

  // ---- Pair-screen message display ----
  function showMsg(text, isOk){
    var el = $('msg');
    el.textContent = text;
    el.className = 'msg ' + (isOk ? 'ok' : 'err');
    try { el.scrollIntoView({behavior:'smooth', block:'center'}); }
    catch(e) { el.scrollIntoView(false); }
  }
  function hideMsg(){ $('msg').className = 'msg hidden'; }

  function hasAllowedExt(name){
    var n = (name || '').toLowerCase();
    for (var i = 0; i < ALLOWED_EXTS.length; i++) {
      if (n.indexOf(ALLOWED_EXTS[i], n.length - ALLOWED_EXTS[i].length) !== -1) return true;
    }
    return false;
  }

  /* Read the three content-type checkboxes. Returns the contentTypes
   * object the TV's Store.setContentTypes accepts, or null if the user
   * has unchecked all three (the at-least-one rule). Defaults to all
   * enabled if any checkbox element is missing — the form stays
   * forgiving of DOM changes. */
  function readContentTypes(){
    var l = $('ct_live'), m = $('ct_movies'), s = $('ct_series');
    var live   = l ? !!l.checked : true;
    var movies = m ? !!m.checked : true;
    var series = s ? !!s.checked : true;
    if (!live && !movies && !series) return null;
    return { live: live, movies: movies, series: series };
  }

  /* Read the per-playlist EPG toggle. Defaults to enabled if the element is
   * missing. Returns a boolean for the payload's epgEnabled field. */
  function readEpgEnabled(){
    var e = $('pl_epg');
    return e ? !!e.checked : true;
  }

  var btn = $('submit');
  btn.addEventListener('click', function(){
    hideMsg();
    var code = ($('code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { showMsg('Enter the code shown on your device.', false); return; }

    var which = $('typeSelect').value;

    function lock(label){ btn.disabled = true; btn.textContent = label; }
    function unlock(){
      btn.disabled = false;
      btn.textContent = (which === 'epg') ? 'Apply EPG sources to device' : 'Send to device';
    }

    // If the user is signed in (and verified), mint a fresh custom token
    // first and bundle it under __auth. The TV will sign in BEFORE
    // applying the primary payload.
    function sendPayload(body, successMsg){
      function postIt(finalBody){
        fetch('/api/pair/' + encodeURIComponent(code) + '/submit', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(finalBody)
        })
        .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
        .then(function(o){
          unlock();
          if (o.ok) {
            showMsg(successMsg || 'Sent! Your device should pick it up shortly.', true);
            $('code').value = '';
          } else {
            showMsg((o.j && o.j.error) || 'Failed.', false);
          }
        })
        ['catch'](function(){ unlock(); showMsg('Network error.', false); });
      }
      if (currentUser && currentUser.emailVerified) {
        lock('Authorising session...');
        getCustomTokenForCurrentUser().then(function(authBundle){
          body.__auth = { customToken: authBundle.customToken, email: authBundle.email, uid: authBundle.uid };
          lock('Sending...');
          postIt(body);
        })['catch'](function(err){
          unlock();
          showMsg('Could not authorise your session: ' + (err && err.message ? err.message : 'unknown'), false);
        });
      } else {
        postIt(body);
      }
    }

    if (which === 'm3u') {
      var url = $('m_url').value.trim();
      if (!url) { showMsg('Please enter an M3U URL.', false); return; }
      lock('Sending...');
      var m3uPayload = {
        type: 'm3u',
        name: $('m_name').value.trim() || 'Playlist',
        url: url,
        epgUrl: $('m_epg').value.trim() || ''
      };
      // Optional Basic-auth for the playlist URL and (separately) the EPG URL.
      if ($('m_auth') && $('m_auth').checked) {
        var au = ($('m_auth_user').value || '').trim();
        var ap = $('m_auth_pass').value || '';
        if (au || ap) { m3uPayload.authUser = au; m3uPayload.authPass = ap; }
      }
      if ($('m_epg_auth') && $('m_epg_auth').checked) {
        var eu = ($('m_epg_auth_user').value || '').trim();
        var ep = $('m_epg_auth_pass').value || '';
        if (eu || ep) { m3uPayload.epgAuthUser = eu; m3uPayload.epgAuthPass = ep; }
      }
      sendPayload(m3uPayload, 'Playlist sent! Your device should pick it up shortly.');
      return;
    }

    if (which === 'xtream') {
      var host = $('x_host').value.trim();
      var xuser = $('x_user').value.trim();
      var pass = $('x_pass').value.trim();
      if (!host || !xuser || !pass) { showMsg('Please fill in all Xtream fields.', false); return; }
      var ctX = readContentTypes();
      if (!ctX) { showMsg('Pick at least one content type.', false); return; }
      lock('Sending...');
      sendPayload({
        type: 'xtream',
        name: $('x_name').value.trim() || 'Xtream',
        host: host, user: xuser, pass: pass,
        contentTypes: ctX,
        epgEnabled: readEpgEnabled()
      }, 'Playlist sent! Your device should pick it up shortly.');
      return;
    }

    if (which === 'stalker') {
      var sUrl = $('s_url').value.trim();
      var sMac = $('s_mac').value.trim();
      if (!sUrl || !sMac) { showMsg('Please enter the portal URL and MAC address.', false); return; }
      if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(sMac)) {
        showMsg('MAC must be in the form AA:BB:CC:DD:EE:FF.', false); return;
      }
      var ctS = readContentTypes();
      if (!ctS) { showMsg('Pick at least one content type.', false); return; }
      var sModel = ($('s_model_custom').value.trim() || $('s_model').value).trim();
      if (sModel && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(sModel)) {
        showMsg('Model: letters, digits, space . _ - only (max 32).', false); return;
      }
      lock('Sending...');
      var sPayload = {
        type: 'stalker',
        name: $('s_name').value.trim() || 'Portal',
        url: sUrl,
        mac: sMac,
        serial: $('s_serial').value.trim(),
        deviceId: $('s_devid').value.trim(),
        contentTypes: ctS,
        epgEnabled: readEpgEnabled()
      };
      if (sModel) sPayload.stbModel = sModel;
      sendPayload(sPayload, 'Portal sent! Your device should pick it up shortly.');
      return;
    }

    if (which === 'epg') {
      var urls = [
        ($('e_url1').value || '').trim(),
        ($('e_url2').value || '').trim(),
        ($('e_url3').value || '').trim()
      ];
      for (var u = 0; u < urls.length; u++) {
        if (urls[u] && !/^https?:\\/\\//i.test(urls[u])) {
          showMsg('External EPG URL ' + (u + 1) + ' must start with http:// or https://', false);
          return;
        }
      }
      var override = $('e_override').checked ? 'on' : 'off';
      // Per-URL Basic-auth, index-aligned with urls. null when a row's toggle is off.
      function epgRowAuth(n) {
        var chk = $('e_auth' + n);
        if (!chk || !chk.checked) return null;
        var uu = ($('e_auth' + n + '_user').value || '').trim();
        var pp = $('e_auth' + n + '_pass').value || '';
        return (uu || pp) ? { user: uu, pass: pp } : null;
      }
      var externalEpgAuth = [epgRowAuth(1), epgRowAuth(2), epgRowAuth(3)];
      lock('Applying...');
      sendPayload({
        action: 'set-external-epg',
        externalEpgUrls: urls,
        externalEpgAuth: externalEpgAuth,
        externalEpgOverride: override
      }, 'EPG sources applied! Your device will reload programme data shortly.');
      return;
    }

    // file upload — embed the file's TEXT directly in the payload so the TV
    // stores it locally and never fetches a URL from this server.
    var f = fInput.files && fInput.files[0];
    if (!f) { showMsg('Choose a playlist file (.m3u, .m3u8, .pls, or .txt).', false); return; }
    if (!hasAllowedExt(f.name)) { showMsg('Unsupported file type. Use .m3u, .m3u8, .pls, or .txt.', false); return; }
    if (f.size > MAX_UPLOAD_BYTES) { showMsg('File too large (max 5 MB).', false); return; }
    lock('Reading...');
    var pf = (pickedFile && pickedFile.name === f.name && pickedFile.size === f.size) ? pickedFile : null;
    var readP = pf ? pf.ready.then(function () { return pf.failed ? f.text() : pf.text; }) : f.text();
    readP.then(function (text) {
      if (!text || !text.length) { unlock(); showMsg('That file is empty.', false); return; }
      lock('Sending...');
      var filePayload = {
        type: 'm3u',
        name: $('f_name').value.trim() || f.name.replace(/\.[^.]+$/, '') || 'Playlist',
        content: text,
        epgUrl: $('f_epg').value.trim() || ''
      };
      if ($('f_epg_auth') && $('f_epg_auth').checked) {
        var eu = ($('f_epg_auth_user').value || '').trim();
        var ep = $('f_epg_auth_pass').value || '';
        if (eu || ep) { filePayload.epgAuthUser = eu; filePayload.epgAuthPass = ep; }
      }
      sendPayload(filePayload, 'Playlist sent! Your device should pick it up shortly.');
    }, function () {
      // The file can no longer be read (the browser dropped access to it): ask for it again.
      unlock();
      pickedFile = null;
      try { fInput.value = ''; fChosen.setAttribute('hidden',''); fChosen.textContent = ''; } catch (eClr) {}
      showMsg('Could not read that file. Please choose it again, then press Send.', false);
    })['catch'](function (err) {
      unlock();
      showMsg((err && err.message) || 'Could not read that file.', false);
    });
  });

  /* "Just sign in (no new playlist)" handler.
   * Sends a sync-only payload — the server's __auth piggyback (added by
   * sendPayload when the user is signed in) carries the Firebase custom
   * token; the TV receives action='sync-only', signs in, and prompts
   * the user whether to pull cloud data.
   *
   * Separate from the main submit because we don't want a playlist
   * field to be required, and we want a distinct lock/unlock state
   * (different button text). */
  var syncOnlyBtn = $('submitSyncOnly');
  if (syncOnlyBtn) syncOnlyBtn.addEventListener('click', function () {
    hideMsg();
    var code = ($('code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { showMsg('Enter the code shown on your device.', false); return; }
    if (!currentUser || !currentUser.emailVerified) {
      showMsg('You must be signed in to use this option.', false);
      return;
    }
    syncOnlyBtn.disabled = true;
    syncOnlyBtn.textContent = 'Authorising session...';
    getCustomTokenForCurrentUser().then(function (authBundle) {
      syncOnlyBtn.textContent = 'Sending...';
      var body = {
        action: 'sync-only',
        __auth: {
          customToken: authBundle.customToken,
          email: authBundle.email,
          uid: authBundle.uid
        }
      };
      return fetch('/api/pair/' + encodeURIComponent(code) + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (o) {
      syncOnlyBtn.disabled = false;
      syncOnlyBtn.textContent = 'Just sign in (no new playlist)';
      if (o.ok) {
        showMsg('Sign-in sent! Your device will pick it up shortly.', true);
        $('code').value = '';
      } else {
        showMsg((o.j && o.j.error) || 'Failed.', false);
      }
    })['catch'](function (err) {
      syncOnlyBtn.disabled = false;
      syncOnlyBtn.textContent = 'Just sign in (no new playlist)';
      showMsg((err && err.message) || 'Network error.', false);
    });
  });

  /* Password visibility toggle. One delegated click
   * handler covers every .pass-toggle on the page (sign-up, sign-in,
   * Xtream form). Toggles the input's type between password and text
   * and swaps the eye icon. Operates on whatever input the toggle's
   * data-pass-target attribute names. */
  var EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_CLOSED_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  document.addEventListener('click', function (e) {
    var btn = e.target;
    while (btn && btn !== document.body && !(btn.classList && btn.classList.contains('pass-toggle'))) {
      btn = btn.parentNode;
    }
    if (!btn || !btn.classList || !btn.classList.contains('pass-toggle')) return;
    e.preventDefault();
    var id = btn.getAttribute('data-pass-target');
    if (!id) return;
    var input = document.getElementById(id);
    if (!input) return;
    var revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';
    btn.innerHTML = revealed ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    btn.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
  });

  if ($('code').value) go('pair');
})();
</script>
</body>
</html>`;
}

// HTML for /auth/action — Firebase email verification +
// password reset + email-recovery landing page. All work happens in the
// browser using Firebase Web SDK 9.x compat builds (same version as the
// landing page and TV app). The page reads the oobCode + mode from
// query params, calls the right Firebase method, and renders a styled
// success/error result with a "back to pairing" button.
function authActionHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify your email — Xtivio</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0d1a;color:#e0e0e0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:20px;accent-color:#3ad1ff}
.container{width:100%;max-width:460px;margin:24px auto}
.card{background:#141824;border-radius:20px;padding:40px 36px;border:1px solid rgba(255,255,255,0.06)}
.logo{width:48px;height:48px;display:flex;align-items:center;justify-content:center;margin-bottom:24px}.logo img{width:100%;height:100%;object-fit:contain;display:block}
h1{font-size:26px;font-weight:700;color:#fff;margin-bottom:8px}
.sub{color:#888;font-size:14px;line-height:1.5;margin-bottom:24px}
.status{margin:20px 0;padding:16px 18px;border-radius:10px;font-size:15px;line-height:1.45}
.status.ok{background:rgba(53,208,160,0.10);border:1px solid rgba(53,208,160,0.25);color:#9ddcc0}
.status.err{background:rgba(255,85,102,0.10);border:1px solid rgba(255,85,102,0.25);color:#ff8c98}
.status.loading{background:rgba(58,209,255,0.06);border:1px solid rgba(58,209,255,0.20);color:#b9d4e8}
.status strong{color:#fff;font-weight:600}
.btn-primary{width:100%;padding:14px;background:linear-gradient(180deg,#35355a 0%,#262544 100%);border:1px solid rgba(124,92,255,0.45);border-radius:10px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px;transition:transform .15s,box-shadow .15s;font-family:inherit}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(124,92,255,0.25)}
.btn-primary:active{transform:translateY(0)}
.btn-secondary{width:100%;padding:12px;background:transparent;border:1px solid #2a2f3f;border-radius:10px;color:#cfd6ea;font-size:14px;font-weight:500;cursor:pointer;margin-top:8px;transition:border-color .15s;font-family:inherit}
.btn-secondary:hover,.btn-secondary:focus{border-color:#3ad1ff;outline:none}
.field-group{margin-bottom:16px}
.field-group label{display:block;font-size:13px;color:#aaa;margin-bottom:6px;font-weight:500}
.field-group input{width:100%;padding:12px 14px;background:#1e2234;border:1px solid #2a2f3f;border-radius:10px;color:#fff;font-size:15px;font-family:inherit;box-sizing:border-box}
.field-group input:focus{border-color:#3ad1ff;outline:none;box-shadow:0 0 0 3px rgba(58,209,255,0.2)}
/* Password reveal toggle (same as main landing page) */
.pass-wrap{position:relative}
.pass-wrap input{padding-right:44px}
.pass-toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;background:transparent;border:1px solid transparent;border-radius:6px;color:rgba(255,255,255,0.55);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.pass-toggle:hover{color:#fff;background:rgba(58,209,255,0.10)}
.pass-toggle:focus{outline:1px solid rgba(58,209,255,0.7);color:#fff}
.pass-toggle svg{width:20px;height:20px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(58,209,255,0.25);border-top-color:#3ad1ff;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:480px){.card{padding:28px 22px}h1{font-size:22px}}
</style>
<script defer src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js" integrity="sha384-ajMUFBUFMCyjh8uxJg6bkGcKe9RTolyjwbxB3yES0QQMenP3Oztj/W9vA2SJPcIh" crossorigin="anonymous"></script>
<script defer src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js" integrity="sha384-xD1t9dGSVKobUztxDkv6xUI0H4AnFz0NxwlgDJJ7FDlblG9xxr1Z9iauCZuJYj6p" crossorigin="anonymous"></script>
</head>
<body>
<div class="container">
  <div class="card">
    <div class="logo"><img src="data:image/png;base64,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" alt="Xtivio"></div>
    <h1 id="actionTitle">Working&hellip;</h1>
    <p class="sub" id="actionSub">Please wait while we process your request.</p>

    <div id="actionStatus" class="status loading"><span class="spinner"></span>Loading&hellip;</div>

    <!-- Password reset has an extra step: collect a new password.
         Hidden until needed. -->
    <div id="resetForm" hidden>
      <div class="field-group">
        <label for="newPass">New password</label>
        <div class="pass-wrap">
          <input type="password" id="newPass" placeholder="At least 8 characters" autocomplete="new-password">
          <button type="button" class="pass-toggle" data-pass-target="newPass" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
      </div>
      <div class="field-group">
        <label for="newPass2">Confirm password</label>
        <div class="pass-wrap">
          <input type="password" id="newPass2" placeholder="Repeat password" autocomplete="new-password">
          <button type="button" class="pass-toggle" data-pass-target="newPass2" aria-label="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
      </div>
      <button class="btn-primary" id="resetSubmit">Set new password</button>
    </div>

    <div id="actionButtons" hidden>
      <button class="btn-primary" id="actionContinue">Back to pairing</button>
    </div>
  </div>
</div>

<script>
(function(){
  'use strict';

  // Same Firebase config as the landing page, from the single FIREBASE_CFG_JS
  // source so the two pages can never drift into different projects.
  var FIREBASE_CFG = ${FIREBASE_CFG_JS};

  function $(id){ return document.getElementById(id); }

  function getParam(name){
    var qs = (location.search || '').replace(/^\\?/, '').split('&');
    for (var i = 0; i < qs.length; i++) {
      var kv = qs[i].split('=');
      if (decodeURIComponent(kv[0] || '') === name) {
        return decodeURIComponent(kv[1] || '');
      }
    }
    return '';
  }

  function setStatus(text, kind, html){
    var el = $('actionStatus');
    if (!el) return;
    el.className = 'status ' + (kind || 'loading');
    if (html) el.innerHTML = text;
    else el.textContent = text;
  }

  function setHeader(title, sub){
    var t = $('actionTitle'); if (t) t.textContent = title;
    var s = $('actionSub'); if (s) s.textContent = sub;
  }

  function showButtons(){
    var b = $('actionButtons'); if (b) b.removeAttribute('hidden');
  }

  function friendlyError(err){
    var code = err && err.code;
    switch (code) {
      case 'auth/expired-action-code': return 'This link has expired. Request a new one from the pairing page.';
      case 'auth/invalid-action-code': return 'This link is invalid or has already been used. Request a new one if needed.';
      case 'auth/user-disabled': return 'This account has been disabled.';
      case 'auth/user-not-found': return 'No account exists for this link.';
      case 'auth/weak-password': return 'Password is too weak. Use at least 8 characters.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      default: return (err && err.message) || 'Something went wrong.';
    }
  }

  function init(){
    if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function') {
      setTimeout(init, 200);
      return;
    }
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CFG);
    } catch (e) {
      setStatus('Firebase failed to initialise: ' + (e && e.message), 'err');
      return;
    }

    var auth = firebase.auth();
    var mode = getParam('mode');
    var oobCode = getParam('oobCode');

    // The "Back to pairing" button — wired up regardless of mode.
    var cont = $('actionContinue');
    if (cont) cont.addEventListener('click', function(){ location.href = '/'; });

    if (!oobCode) {
      setHeader('Missing code', 'This page should be opened from the link in your email.');
      setStatus('No verification code in the URL.', 'err');
      showButtons();
      return;
    }

    if (mode === 'verifyEmail') {
      setHeader('Verifying your email', 'Hold on while we confirm the link.');
      auth.applyActionCode(oobCode).then(function(){
        setHeader('Email verified', 'Thanks! You can now sign in and pair your device.');
        setStatus('Your email has been verified.', 'ok');
        showButtons();
      })['catch'](function(err){
        setHeader('Verification failed', 'Something went wrong with that link.');
        setStatus(friendlyError(err), 'err');
        showButtons();
      });
      return;
    }

    if (mode === 'resetPassword') {
      setHeader('Reset your password', 'Choose a new password below.');
      setStatus('Verifying reset code\\u2026', 'loading');
      auth.verifyPasswordResetCode(oobCode).then(function(email){
        setStatus('Setting a new password for ' + email, 'loading');
        $('resetForm').removeAttribute('hidden');
        $('actionStatus').setAttribute('hidden', '');
        $('resetSubmit').addEventListener('click', function(){
          var p1 = $('newPass').value;
          var p2 = $('newPass2').value;
          if (!p1 || p1.length < 8) {
            $('actionStatus').removeAttribute('hidden');
            setStatus('Password must be at least 8 characters.', 'err');
            return;
          }
          if (p1 !== p2) {
            $('actionStatus').removeAttribute('hidden');
            setStatus('Passwords don\\u2019t match.', 'err');
            return;
          }
          $('resetSubmit').disabled = true;
          $('resetSubmit').textContent = 'Setting\\u2026';
          auth.confirmPasswordReset(oobCode, p1).then(function(){
            $('resetForm').setAttribute('hidden', '');
            $('actionStatus').removeAttribute('hidden');
            setHeader('Password updated', 'You can now sign in with your new password.');
            setStatus('Password reset successful.', 'ok');
            showButtons();
          })['catch'](function(err){
            $('actionStatus').removeAttribute('hidden');
            setStatus(friendlyError(err), 'err');
            $('resetSubmit').disabled = false;
            $('resetSubmit').textContent = 'Set new password';
          });
        });
      })['catch'](function(err){
        setHeader('Link invalid', 'This reset link can\\u2019t be used.');
        setStatus(friendlyError(err), 'err');
        showButtons();
      });
      return;
    }

    if (mode === 'recoverEmail') {
      setHeader('Restoring your email', 'Reverting a recent email change.');
      auth.checkActionCode(oobCode).then(function(info){
        return auth.applyActionCode(oobCode).then(function(){
          setHeader('Email restored', 'Your account email has been changed back.');
          setStatus('Restored to ' + (info && info.data && info.data.email ? info.data.email : 'previous address') + '.', 'ok');
          showButtons();
        });
      })['catch'](function(err){
        setHeader('Restore failed', 'This link could not be applied.');
        setStatus(friendlyError(err), 'err');
        showButtons();
      });
      return;
    }

    // Unknown mode
    setHeader('Unknown action', 'This URL is missing or has an unrecognised action.');
    setStatus('mode="' + mode + '" is not supported.', 'err');
    showButtons();
  }

  /* Password visibility toggle — same delegate as the
   * main landing page. Applies to newPass / newPass2 on the reset-
   * password mode of this action page. */
  var EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_CLOSED_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  document.addEventListener('click', function (e) {
    var btn = e.target;
    while (btn && btn !== document.body && !(btn.classList && btn.classList.contains('pass-toggle'))) {
      btn = btn.parentNode;
    }
    if (!btn || !btn.classList || !btn.classList.contains('pass-toggle')) return;
    e.preventDefault();
    var id = btn.getAttribute('data-pass-target');
    if (!id) return;
    var input = document.getElementById(id);
    if (!input) return;
    var revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';
    btn.innerHTML = revealed ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    btn.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
  });

  init();
})();
</script>
</body>
</html>`;
}

// ============== Boot ==============
const server = app.listen(PORT, HOST, () => {
    console.log(`Xtivio pair server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
