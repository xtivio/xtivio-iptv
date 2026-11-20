/* zksync.js — Zero-knowledge credential sync.
 *
 * The default sync mode strips provider credentials from the cloud entirely
 * (see cloudsync.js "shell"). This module implements the OPT-IN alternative:
 * encrypt the secret fields under a key derived from a user-chosen SYNC
 * PASSPHRASE that is never transmitted and never stored — so the server (and
 * anyone with Firebase access) holds only ciphertext it cannot decrypt. That is
 * what makes it zero-knowledge, as opposed to the old uid/email-derived
 * "obfuscation" whose key was derivable from server-known data.
 *
 * Threat model / properties:
 *   - The passphrase never leaves the device and is never persisted. The derived
 *     AES-GCM key lives ONLY in memory for the session (module-scoped var); it is
 *     dropped on reset()/reload. The user re-enters the passphrase each session
 *     when sync first needs it.
 *   - Because nothing but the user holds the passphrase, a forgotten passphrase
 *     means the synced credentials are permanently undecryptable BY DESIGN. There
 *     is no recovery — a reset would require server-held key material, which would
 *     break the guarantee. The setup UI warns about this explicitly.
 *   - A VERIFIER token (a known constant encrypted under the key) is stored in the
 *     cloud so a wrong passphrase is detected up front (its decrypt fails / does
 *     not match) instead of silently producing garbage credentials.
 *
 * Independence from crypto.js: this module derives and holds its OWN key. It must
 * never reuse the uid/email-derived obfuscation key, or the ZK guarantee would
 * collapse back to server-derivable.
 */
var ZKSync = (function () {
    'use strict';

    // Session-only derived key. Never persisted. Null until unlock().
    var zkKey = null;
    // The salt used to derive zkKey, needed to re-derive on another device. It is
    // NOT secret (a salt only prevents precomputation), so it is stored in the
    // cloud alongside the verifier. Base64 string.
    var zkSaltB64 = null;

    // A fixed known plaintext for the verifier. Encrypting this under the key and
    // storing the ciphertext lets a later unlock confirm the passphrase: decrypt
    // the stored verifier and check it equals this constant.
    var VERIFIER_PLAINTEXT = 'xtivio-zk-verify-v1';

    // PBKDF2 iterations. Higher than the obfuscation path (100k) because this key
    // guards real secrets against an offline attacker who has the ciphertext.
    var ZK_ITERATIONS = 310000;

    function hasWebCrypto() {
        return typeof window !== 'undefined' && window.crypto && window.crypto.subtle &&
            typeof window.crypto.subtle.deriveKey === 'function';
    }

    function strToBytes(s) {
        return new TextEncoder().encode(s);
    }
    function bytesToStr(bytes) {
        return new TextDecoder().decode(bytes);
    }
    function bytesToB64(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Derive an AES-GCM key from the passphrase + salt. Returns Promise<CryptoKey>.
    function deriveKey(passphrase, saltBytes) {
        return window.crypto.subtle.importKey(
            'raw', strToBytes(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
        ).then(function (baseKey) {
            return window.crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: saltBytes, iterations: ZK_ITERATIONS, hash: 'SHA-256' },
                baseKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        });
    }

    function encryptWith(key, plaintext) {
        if (plaintext == null) plaintext = '';
        var iv = window.crypto.getRandomValues(new Uint8Array(12));
        return window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv }, key, strToBytes(String(plaintext))
        ).then(function (cipherBuf) {
            var cipher = new Uint8Array(cipherBuf);
            var combined = new Uint8Array(iv.length + cipher.length);
            combined.set(iv, 0); combined.set(cipher, iv.length);
            return 'zk1:' + bytesToB64(combined);
        });
    }

    function decryptWith(key, ciphertext) {
        if (typeof ciphertext !== 'string' || ciphertext.indexOf('zk1:') !== 0) {
            return Promise.reject(new Error('zk: not a zk1 ciphertext'));
        }
        var combined = b64ToBytes(ciphertext.substring(4));
        if (combined.length < 13) return Promise.reject(new Error('zk: ciphertext too short'));
        var iv = combined.subarray(0, 12);
        var cipher = combined.subarray(12);
        return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipher)
            .then(function (buf) { return bytesToStr(new Uint8Array(buf)); });
    }

    /* setupNewPassphrase(passphrase) -> Promise<{ salt, verifier }>
     * First-time setup on the device that turns ZK on. Generates a fresh random
     * salt, derives the key (held session-only), and produces the verifier token
     * to store in the cloud. Caller persists {salt, verifier} to the cloud sync
     * root; they are not secret. */
    function setupNewPassphrase(passphrase) {
        if (!hasWebCrypto()) return Promise.reject(new Error('zk: WebCrypto unavailable'));
        if (!passphrase) return Promise.reject(new Error('zk: empty passphrase'));
        var saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        return deriveKey(passphrase, saltBytes).then(function (key) {
            return encryptWith(key, VERIFIER_PLAINTEXT).then(function (verifier) {
                zkKey = key;
                zkSaltB64 = bytesToB64(saltBytes);
                return { salt: zkSaltB64, verifier: verifier };
            });
        });
    }

    /* unlock(passphrase, saltB64, verifier) -> Promise<boolean>
     * On a device pulling ZK-synced data, re-derive the key from the entered
     * passphrase + the cloud-stored salt, then confirm against the verifier.
     * Resolves true on success (key held for the session), false on a wrong
     * passphrase. Rejects only on a crypto/environment error. */
    function unlock(passphrase, saltB64, verifier) {
        if (!hasWebCrypto()) return Promise.reject(new Error('zk: WebCrypto unavailable'));
        if (!passphrase || !saltB64 || !verifier) return Promise.resolve(false);
        var saltBytes;
        try { saltBytes = b64ToBytes(saltB64); } catch (e) { return Promise.resolve(false); }
        return deriveKey(passphrase, saltBytes).then(function (key) {
            return decryptWith(key, verifier).then(function (plain) {
                if (plain === VERIFIER_PLAINTEXT) {
                    zkKey = key;
                    zkSaltB64 = saltB64;
                    return true;
                }
                return false;
            })['catch'](function () {
                // Decrypt failure = wrong passphrase (GCM auth tag mismatch).
                return false;
            });
        });
    }

    function isUnlocked() { return zkKey !== null; }

    function getSalt() { return zkSaltB64; }

    // Drop the session key (sign-out / disabling ZK / reload).
    function lock() { zkKey = null; zkSaltB64 = null; }

    /* encryptFields(obj, fields) -> Promise<obj clone with fields encrypted>
     * Requires unlock(). Used by push to encrypt the secret playlist fields. */
    function encryptFields(obj, fields) {
        if (!zkKey) return Promise.reject(new Error('zk: locked'));
        var out = {};
        var k;
        for (k in obj) { if (obj.hasOwnProperty(k)) out[k] = obj[k]; }
        var chain = Promise.resolve();
        fields.forEach(function (f) {
            if (out[f] != null && out[f] !== '') {
                chain = chain.then(function () {
                    return encryptWith(zkKey, String(out[f])).then(function (enc) { out[f] = enc; });
                });
            }
        });
        return chain.then(function () { return out; });
    }

    /* decryptFields(obj, fields) -> Promise<obj clone with fields decrypted>
     * Requires unlock(). Used by pull. A field that isn't zk1-prefixed is left
     * as-is (e.g. a shell that had no cred for that field). */
    function decryptFields(obj, fields) {
        if (!zkKey) return Promise.reject(new Error('zk: locked'));
        var out = {};
        var k;
        for (k in obj) { if (obj.hasOwnProperty(k)) out[k] = obj[k]; }
        var chain = Promise.resolve();
        fields.forEach(function (f) {
            if (typeof out[f] === 'string' && out[f].indexOf('zk1:') === 0) {
                chain = chain.then(function () {
                    return decryptWith(zkKey, out[f]).then(function (dec) { out[f] = dec; });
                });
            }
        });
        return chain.then(function () { return out; });
    }

    return {
        setupNewPassphrase: setupNewPassphrase,
        unlock: unlock,
        lock: lock,
        isUnlocked: isUnlocked,
        getSalt: getSalt,
        encryptFields: encryptFields,
        decryptFields: decryptFields,
        hasWebCrypto: hasWebCrypto
    };
})();
