/* polyfills.js - ES5 safety polyfills for older WebOS/Tizen browsers */
(function () {
    'use strict';

    // Array.prototype.indexOf
    if (!Array.prototype.indexOf) {
        Array.prototype.indexOf = function (searchElement, fromIndex) {
            var k;
            if (this == null) throw new TypeError('"this" is null');
            var o = Object(this);
            var len = o.length >>> 0;
            if (len === 0) return -1;
            var n = fromIndex | 0;
            if (n >= len) return -1;
            k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);
            for (; k < len; k++) {
                if (k in o && o[k] === searchElement) return k;
            }
            return -1;
        };
    }

    // Array.prototype.forEach
    if (!Array.prototype.forEach) {
        Array.prototype.forEach = function (callback, thisArg) {
            var T, k;
            if (this == null) throw new TypeError(' this is null');
            var O = Object(this);
            var len = O.length >>> 0;
            if (typeof callback !== "function") throw new TypeError(callback + ' is not a function');
            if (arguments.length > 1) T = thisArg;
            k = 0;
            while (k < len) {
                if (k in O) callback.call(T, O[k], k, O);
                k++;
            }
        };
    }

    // Array.prototype.map
    if (!Array.prototype.map) {
        Array.prototype.map = function (callback, thisArg) {
            var T, A, k;
            if (this == null) throw new TypeError('this is null');
            var O = Object(this);
            var len = O.length >>> 0;
            if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
            if (arguments.length > 1) T = thisArg;
            A = new Array(len);
            k = 0;
            while (k < len) {
                var kValue, mappedValue;
                if (k in O) {
                    kValue = O[k];
                    mappedValue = callback.call(T, kValue, k, O);
                    A[k] = mappedValue;
                }
                k++;
            }
            return A;
        };
    }

    // Array.prototype.filter
    if (!Array.prototype.filter) {
        Array.prototype.filter = function (func, thisArg) {
            if (this == null) throw new TypeError('this is null');
            var t = Object(this);
            var len = t.length >>> 0;
            if (typeof func !== 'function') throw new TypeError(func + ' is not a function');
            var res = [];
            var c = thisArg;
            for (var i = 0; i < len; i++) {
                if (i in t) {
                    var val = t[i];
                    if (func.call(c, val, i, t)) res.push(val);
                }
            }
            return res;
        };
    }

    // String.prototype.trim
    if (!String.prototype.trim) {
        String.prototype.trim = function () {
            return this.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, '');
        };
    }

    // Object.keys
    if (!Object.keys) {
        Object.keys = function (obj) {
            if (obj !== Object(obj)) throw new TypeError('Object.keys called on a non-object');
            var keys = [];
            for (var p in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, p)) keys.push(p);
            }
            return keys;
        };
    }

    // Date.now
    if (!Date.now) {
        Date.now = function () { return new Date().getTime(); };
    }

    // requestAnimationFrame fallback
    if (!window.requestAnimationFrame) {
        window.requestAnimationFrame = function (cb) {
            return setTimeout(function () { cb(Date.now()); }, 16);
        };
    }
    if (!window.cancelAnimationFrame) {
        window.cancelAnimationFrame = function (id) { clearTimeout(id); };
    }

    // console fallback
    if (!window.console) {
        window.console = { log: function () {}, error: function () {}, warn: function () {}, info: function () {} };
    }

    // Minimal Promise shim (only if missing)
    if (typeof Promise === 'undefined') {
        window.Promise = function (executor) {
            var self = this;
            self._state = 'pending';
            self._value = null;
            self._cbs = [];

            function resolve(val) {
                if (self._state !== 'pending') return;
                self._state = 'fulfilled';
                self._value = val;
                for (var i = 0; i < self._cbs.length; i++) self._cbs[i].onFulfilled(val);
            }
            function reject(err) {
                if (self._state !== 'pending') return;
                self._state = 'rejected';
                self._value = err;
                for (var i = 0; i < self._cbs.length; i++) self._cbs[i].onRejected(err);
            }
            self.then = function (onFul, onRej) {
                return new Promise(function (res, rej) {
                    function handleFulfilled(value) {
                        try {
                            if (typeof onFul === 'function') {
                                var r = onFul(value);
                                if (r && typeof r.then === 'function') r.then(res, rej);
                                else res(r);
                            } else res(value);
                        } catch (e) { rej(e); }
                    }
                    function handleRejected(reason) {
                        try {
                            if (typeof onRej === 'function') {
                                var r = onRej(reason);
                                if (r && typeof r.then === 'function') r.then(res, rej);
                                else res(r);
                            } else rej(reason);
                        } catch (e) { rej(e); }
                    }
                    if (self._state === 'fulfilled') setTimeout(function () { handleFulfilled(self._value); }, 0);
                    else if (self._state === 'rejected') setTimeout(function () { handleRejected(self._value); }, 0);
                    else self._cbs.push({ onFulfilled: handleFulfilled, onRejected: handleRejected });
                });
            };
            self['catch'] = function (onRej) { return self.then(null, onRej); };

            try { executor(resolve, reject); } catch (e) { reject(e); }
        };
        window.Promise.resolve = function (v) { return new Promise(function (r) { r(v); }); };
        window.Promise.reject = function (e) { return new Promise(function (_, r) { r(e); }); };
        window.Promise.all = function (arr) {
            return new Promise(function (res, rej) {
                var results = [];
                var remaining = arr.length;
                if (remaining === 0) return res([]);
                for (var i = 0; i < arr.length; i++) {
                    (function (idx) {
                        Promise.resolve(arr[idx]).then(function (val) {
                            results[idx] = val;
                            if (--remaining === 0) res(results);
                        }, rej);
                    })(i);
                }
            });
        };
    }

    // CustomEvent for TV browsers
    if (typeof window.CustomEvent !== 'function') {
        window.CustomEvent = function (event, params) {
            params = params || { bubbles: false, cancelable: false, detail: undefined };
            var evt = document.createEvent('CustomEvent');
            evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
            return evt;
        };
    }

    // Element.prototype.matches
    if (!Element.prototype.matches) {
        Element.prototype.matches = Element.prototype.msMatchesSelector ||
                                    Element.prototype.webkitMatchesSelector;
    }

    // Element.prototype.closest
    if (!Element.prototype.closest) {
        Element.prototype.closest = function (s) {
            var el = this;
            do {
                if (el.matches && el.matches(s)) return el;
                el = el.parentElement || el.parentNode;
            } while (el !== null && el.nodeType === 1);
            return null;
        };
    }

    // classList shim (for very old TVs)
    if (!('classList' in document.createElement('_'))) {
        (function () {
            var reg = function (c) { return new RegExp('(\\s|^)' + c + '(\\s|$)'); };
            var add = function (cls) { if (!this.contains(cls)) this.el.className += ' ' + cls; };
            var remove = function (cls) { this.el.className = this.el.className.replace(reg(cls), ' '); };
            var toggle = function (cls) { this.contains(cls) ? this.remove(cls) : this.add(cls); };
            var contains = function (cls) { return reg(cls).test(this.el.className); };
            Object.defineProperty(Element.prototype, 'classList', {
                get: function () {
                    var self = this;
                    return {
                        el: self,
                        add: add.bind({ el: self, contains: contains.bind({ el: self }) }),
                        remove: remove.bind({ el: self }),
                        toggle: toggle.bind({ el: self }),
                        contains: contains.bind({ el: self })
                    };
                }
            });
        })();
    }
})();
