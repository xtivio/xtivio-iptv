/* backup.js - local Backup and Restore (Android first).
 *
 * One JSON file holds playlists (with their logins), favourites, watch history, recent channels, settings,
 * category order and hidden categories, and the parental settings. Channel lists, EPG and image caches are
 * not saved: they download again. An optional password encrypts the whole file (AES-GCM, key from PBKDF2).
 * Nothing leaves the device unless the user chooses where to put the file; no cloud account is involved.
 *
 * File access goes through AndroidBridge.backup* (BackupIo.kt): the system file picker, or the visible
 * folder Download/Xtivio for boxes that have no picker. Results come back to XtivioBackup._onNative.
 */
var XtivioBackup = (function () {
    'use strict';

    var FORMAT = 'xtivio-backup';
    var VERSION = 1;
    var ITER = 200000;
    // Store keys that make up a backup. deviceId, pairing state and every cache are left out on purpose.
    var KEYS = ['playlists', 'playlistTombstones', 'activePlaylistId', 'favorites', 'favTombstones', 'settings',
        'vodHistory', 'recentChannels', 'lastChannel', 'preferredSubLang', 'hiddenCats', 'customCatOrder',
        'parental', 'parentalLocks', 'parentalItemLocks'];

    // Settings that belong to this device or to its cloud account: never saved, never overwritten by a restore.
    var SETTINGS_SKIP = ['perfCrashMarker', 'perfCrashCount', 'perfMode', 'sync', 'zkEnabled', 'zkSalt', 'zkVerifier'];

    /* ---------------- small helpers ---------------- */
    function bridge() { return (typeof window !== 'undefined' && window.AndroidBridge) ? window.AndroidBridge : null; }
    function isAvailable() { var b = bridge(); return !!(b && typeof b.backupCaps === 'function'); }
    function hasCrypto() {
        return typeof window !== 'undefined' && window.crypto && window.crypto.subtle && typeof window.crypto.subtle.deriveKey === 'function' &&
            typeof TextEncoder !== 'undefined' && typeof TextDecoder !== 'undefined';
    }
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function fileName(d) {
        d = d || new Date();
        return 'xtivio-backup-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + '.json';
    }
    function bytesToB64(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function b64ToBytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function isObj(o) { return !!o && typeof o === 'object' && !(o instanceof Array); }
    function copy(o) { return JSON.parse(JSON.stringify(o)); }

    /* ---------------- build / parse ---------------- */
    function collect() {
        var data = {}, n = 0;
        for (var i = 0; i < KEYS.length; i++) {
            var v = null;
            try { v = Store.raw.get(KEYS[i], null); } catch (e) { v = null; }
            if (KEYS[i] === 'settings' && isObj(v)) { v = copy(v); for (var s = 0; s < SETTINGS_SKIP.length; s++) delete v[SETTINGS_SKIP[s]]; }
            if (v !== null && v !== undefined) { data[KEYS[i]] = v; n++; }
        }
        var pls = data.playlists instanceof Array ? data.playlists.length : 0;
        var favs = data.favorites instanceof Array ? data.favorites.length : 0;
        return {
            format: FORMAT, version: VERSION,
            app: (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.APP_VERSION) || '',
            created: new Date().toISOString(),
            counts: { playlists: pls, favorites: favs },
            data: data
        };
    }

    function deriveKey(password, salt) {
        var c = window.crypto.subtle;
        return c.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey']).then(function (base) {
            return c.deriveKey({ name: 'PBKDF2', salt: salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        });
    }

    /* build(password) -> Promise<string>. An empty password gives a plain file. */
    function build(password) {
        var obj = collect();
        if (!password) return Promise.resolve(JSON.stringify(obj));
        if (!hasCrypto()) return Promise.reject(new Error('nocrypto'));
        var salt = window.crypto.getRandomValues(new Uint8Array(16));
        var iv = window.crypto.getRandomValues(new Uint8Array(12));
        return deriveKey(password, salt).then(function (key) {
            return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
        }).then(function (buf) {
            return JSON.stringify({
                format: FORMAT, version: VERSION, encrypted: true, kdf: 'PBKDF2-SHA256', iter: ITER,
                app: obj.app, created: obj.created, counts: obj.counts,
                salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(buf))
            });
        });
    }

    /* inspect(text) -> { ok, encrypted, info } or { ok:false, code } without needing the password. */
    function inspect(text) {
        var o;
        try { o = JSON.parse(text); } catch (e) { return { ok: false, code: 'badfile' }; }
        if (!isObj(o) || o.format !== FORMAT) return { ok: false, code: 'badfile' };
        if (typeof o.version !== 'number' || o.version > VERSION) return { ok: false, code: 'newer' };
        return { ok: true, encrypted: o.encrypted === true, info: { app: o.app || '', created: o.created || '', counts: o.counts || {} }, obj: o };
    }

    /* open(text, password) -> Promise<backup object>. Rejects with Error(code): badfile, newer, password, nocrypto. */
    function open(text, password) {
        var r = inspect(text);
        if (!r.ok) return Promise.reject(new Error(r.code));
        var o = r.obj;
        if (!r.encrypted) {
            if (!isObj(o.data)) return Promise.reject(new Error('badfile'));
            return Promise.resolve(o);
        }
        if (!hasCrypto()) return Promise.reject(new Error('nocrypto'));
        if (!password) return Promise.reject(new Error('password'));
        var salt, iv, data;
        try { salt = b64ToBytes(o.salt); iv = b64ToBytes(o.iv); data = b64ToBytes(o.data); } catch (e) { return Promise.reject(new Error('badfile')); }
        return deriveKey(password, salt).then(function (key) {
            return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
        }).then(function (buf) {
            var inner;
            try { inner = JSON.parse(new TextDecoder().decode(new Uint8Array(buf))); } catch (e) { throw new Error('badfile'); }
            if (!isObj(inner) || inner.format !== FORMAT || !isObj(inner.data)) throw new Error('badfile');
            return inner;
        }, function () { throw new Error('password'); });
    }

    /* ---------------- apply ---------------- */
    function itemKey(e) {
        if (e && typeof e === 'object') return String(e.key != null ? e.key : (e.id != null ? e.id : (e.url || ''))) + '|' + String(e.playlistId || '');
        return String(e);
    }
    function unionList(local, incoming, keyFn, cap) {
        var out = (local instanceof Array ? local : []).slice(), seen = {}, added = 0, i;
        for (i = 0; i < out.length; i++) seen[keyFn(out[i])] = true;
        if (incoming instanceof Array) {
            for (i = 0; i < incoming.length; i++) {
                var k = keyFn(incoming[i]);
                if (!seen[k]) { seen[k] = true; out.push(incoming[i]); added++; }
            }
        }
        if (cap && out.length > cap) out = out.slice(0, cap);
        return { list: out, added: added };
    }
    function fillObject(local, incoming) {
        var out = isObj(local) ? copy(local) : {};
        if (isObj(incoming)) { for (var k in incoming) { if (Object.prototype.hasOwnProperty.call(incoming, k) && !(k in out)) out[k] = incoming[k]; } }
        return out;
    }

    /* apply(backupObject, 'replace' | 'merge') -> { playlists, favorites } counts of what came in. Synchronous. */
    function apply(bk, mode) {
        var d = bk.data || {}, res = { playlists: 0, favorites: 0 }, i, k;
        if (mode === 'replace') {
            for (i = 0; i < KEYS.length; i++) {
                k = KEYS[i];
                if (k === 'settings' && isObj(d[k])) {
                    var ns = copy(d[k]), ls = Store.raw.get('settings', null), q;
                    for (q = 0; q < SETTINGS_SKIP.length; q++) delete ns[SETTINGS_SKIP[q]];
                    if (isObj(ls)) { for (q = 0; q < SETTINGS_SKIP.length; q++) { if (SETTINGS_SKIP[q] in ls) ns[SETTINGS_SKIP[q]] = ls[SETTINGS_SKIP[q]]; } }
                    Store.raw.set(k, ns);
                } else if (k in d) Store.raw.set(k, d[k]); else Store.raw.del(k);
            }
            res.playlists = d.playlists instanceof Array ? d.playlists.length : 0;
            res.favorites = d.favorites instanceof Array ? d.favorites.length : 0;
            return res;
        }
        // merge: nothing the user already has is removed or changed, except that a playlist or favourite they
        // deleted earlier comes back when the backup holds it.
        var lp = Store.raw.get('playlists', []), pm = unionList(lp, d.playlists, function (p) { return String(p && p.id); });
        if (pm.added) {
            Store.raw.set('playlists', pm.list);
            var ids = {};
            for (i = 0; i < pm.list.length; i++) ids[String(pm.list[i] && pm.list[i].id)] = true;
            var pt = Store.raw.get('playlistTombstones', []);
            if (pt instanceof Array) Store.raw.set('playlistTombstones', pt.filter(function (t) { return !(t && ids[String(t.id)] && isIncoming(d.playlists, t.id)); }));
        }
        res.playlists = pm.added;
        var fm = unionList(Store.raw.get('favorites', []), d.favorites, itemKey);
        if (fm.added) {
            Store.raw.set('favorites', fm.list);
            var ft = Store.raw.get('favTombstones', []);
            if (ft instanceof Array) Store.raw.set('favTombstones', ft.filter(function (t) { return !(t && isIncomingFav(d.favorites, t.key)); }));
        }
        res.favorites = fm.added;
        var vm = unionList(Store.raw.get('vodHistory', []), d.vodHistory, itemKey, 20);
        if (vm.added) Store.raw.set('vodHistory', vm.list);
        var rm = unionList(Store.raw.get('recentChannels', []), d.recentChannels, itemKey, 10);
        if (rm.added) Store.raw.set('recentChannels', rm.list);
        var fills = ['settings', 'hiddenCats', 'customCatOrder', 'parentalLocks', 'parentalItemLocks'];
        for (i = 0; i < fills.length; i++) {
            if (isObj(d[fills[i]])) Store.raw.set(fills[i], fillObject(Store.raw.get(fills[i], null), d[fills[i]]));
        }
        var single = ['activePlaylistId', 'lastChannel', 'preferredSubLang'];
        for (i = 0; i < single.length; i++) {
            var cur = Store.raw.get(single[i], null);
            if ((cur === null || cur === '' || cur === undefined) && d[single[i]] != null) Store.raw.set(single[i], d[single[i]]);
        }
        var par = Store.raw.get('parental', null);
        if ((!par || !par.pin) && isObj(d.parental)) Store.raw.set('parental', d.parental);
        return res;
    }
    function isIncoming(list, id) {
        if (!(list instanceof Array)) return false;
        for (var i = 0; i < list.length; i++) { if (list[i] && String(list[i].id) === String(id)) return true; }
        return false;
    }
    function isIncomingFav(list, key) {
        if (!(list instanceof Array)) return false;
        for (var i = 0; i < list.length; i++) { if (list[i] && String(list[i].key) === String(key)) return true; }
        return false;
    }

    /* ---------------- Android transport ---------------- */
    var pending = {}, seq = 0;
    function call(method, a, b) {
        return new Promise(function (resolve) {
            var br = bridge();
            if (!br || typeof br[method] !== 'function') { resolve({ ok: false, code: 'unavailable' }); return; }
            var id = 'b' + (++seq) + '_' + Date.now();
            pending[id] = resolve;
            try {
                if (method === 'backupSave' || method === 'backupSaveFolder') br[method](id, a, b);
                else if (method === 'backupRead') br[method](id, a);
                else br[method](id);
            } catch (e) { delete pending[id]; resolve({ ok: false, code: 'io' }); }
        });
    }
    function onNative(id, res) {
        var f = pending[id];
        if (!f) return;
        delete pending[id];
        f(res || { ok: false, code: 'io' });
    }
    function caps() {
        var br = bridge();
        if (!br || typeof br.backupCaps !== 'function') return { picker: false, files: 'none', folder: '' };
        try { return JSON.parse(br.backupCaps()); } catch (e) { return { picker: false, files: 'none', folder: '' }; }
    }

    return {
        FORMAT: FORMAT, VERSION: VERSION, KEYS: KEYS,
        isAvailable: isAvailable, hasCrypto: hasCrypto, caps: caps, fileName: fileName,
        build: build, inspect: inspect, open: open, apply: apply,
        savePicker: function (name, text) { return call('backupSave', name, text); },
        saveFolder: function (name, text) { return call('backupSaveFolder', name, text); },
        pickFile: function () { return call('backupPick'); },
        listFolder: function () { return call('backupList'); },
        readFile: function (id) { return call('backupRead', id); },
        askAccess: function () { return call('backupAskAccess'); },
        _onNative: onNative
    };
})();
