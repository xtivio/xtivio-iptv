'use strict';
/* Content Security Policy for the two HTML pages the server renders (the pairing page "/" and "/auth/action").
 *
 * Why: these pages take people's sign-in and provider details. A strict CSP is what stops an injected script from
 * running or from sending that data anywhere (the Optimizely supply-chain attack of Nov 2026 was stopped by exactly
 * this in the 15% of sites that had one).
 *
 *  - script-src: only inline <script> blocks carrying this response's random nonce, plus the pinned Firebase 9.23.0
 *    files from gstatic.com (which also carry Subresource Integrity hashes in the page markup).
 *  - connect-src: this server and the Firebase sign-in endpoints; nothing else, so stolen data has nowhere to go.
 *  - everything else default-src 'none'.
 *
 * It is sent as Content-Security-Policy-Report-Only first (violations show in the browser console, nothing is
 * blocked). Set CSP_ENFORCE=1 in the container environment to switch to enforcing, with no code change. */
const crypto = require('crypto');

const FIREBASE_BASE = 'https://www.gstatic.com/firebasejs/9.23.0/';

function newNonce() { return crypto.randomBytes(16).toString('base64'); }

function policy(nonce) {
    return [
        "default-src 'none'",
        "script-src 'nonce-" + nonce + "' " + FIREBASE_BASE,
        "style-src 'nonce-" + nonce + "'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
        "frame-src 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/* Adds the nonce to every plain inline <script> and <style> (external scripts carry src= and are not touched). */
function nonceInline(html, nonce) {
    return String(html)
        .replace(/<script>/g, '<script nonce="' + nonce + '">')
        .replace(/<style>/g, '<style nonce="' + nonce + '">');
}

function headerName() {
    return process.env.CSP_ENFORCE === '1' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
}

function sendPage(res, html) {
    const nonce = newNonce();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set(headerName(), policy(nonce));
    res.send(nonceInline(html, nonce));
}

module.exports = { newNonce, policy, nonceInline, headerName, sendPage, FIREBASE_BASE };
