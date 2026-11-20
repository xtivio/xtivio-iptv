#!/usr/bin/env node
/*
 * Boot smoke-test gate.
 *
 * The 16 static gates check syntax, CSS, and i18n — but none of them actually LOAD
 * the JS and evaluate the module IIFEs, so a reference to a name that doesn't exist
 * at the scope where it's used (e.g. exporting a function that's actually declared
 * nested inside another function) passes every static check and then throws
 * "X is not defined" at boot on-device, taking the whole app down.
 *
 * That is exactly what happened when UI tried to export updateLiveNowBar, which was
 * declared inside renderLiveInner and invisible at module scope. This gate would have
 * caught it: it evaluates each module IIFE under lightweight browser stubs and fails
 * if any throws a ReferenceError / "not defined" / "of undefined" at load time.
 *
 * It is deliberately shallow — it does NOT exercise UI flows, only the top-level
 * module evaluation and the public export objects. That's enough to catch the
 * boot-killing class (undefined references, bad export wiring) without needing a
 * real DOM.
 */
'use strict';
var fs = require('fs');

function makeEl() {
  var el = {
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
    appendChild: function () {}, removeChild: function () {}, insertBefore: function () {},
    setAttribute: function () {}, removeAttribute: function () {}, getAttribute: function () { return null; },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    style: {}, dataset: {}, children: [], childNodes: [], focus: function () {}, blur: function () {},
    closest: function () { return null; }, contains: function () { return false; }, cloneNode: function () { return makeEl(); }
  };
  return el;
}

function freshGlobals() {
  var doc = {
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return makeEl(); },
    createElementNS: function () { return makeEl(); },
    createTextNode: function () { return {}; },
    createDocumentFragment: function () { return makeEl(); },
    addEventListener: function () {}, removeEventListener: function () {},
    body: makeEl(), documentElement: makeEl(), head: makeEl(),
    cookie: '', readyState: 'complete'
  };
  var g = global;
  function set(k, v) { try { g[k] = v; } catch (e) { try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } catch (e2) {} } }
  set('window', g);
  set('document', doc);
  set('navigator', { userAgent: 'smoke', language: 'en' });
  set('location', { href: 'file:///smoke', protocol: 'file:', search: '', hash: '' });
  set('localStorage', { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  set('setTimeout', function () { return 0; });
  set('clearTimeout', function () {});
  set('setInterval', function () { return 0; });
  set('clearInterval', function () {});
  set('requestAnimationFrame', function () { return 0; });
  set('cancelAnimationFrame', function () {});
  set('XMLHttpRequest', function () { return { open: function () {}, send: function () {}, setRequestHeader: function () {} }; });
  set('fetch', function () { return Promise.resolve({ json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); } }); });
  set('console', console);
  // DOM constructors that polyfills / feature-detects reference at load.
  function Ctor() {}
  Ctor.prototype = {};
  set('Element', Ctor);
  set('HTMLElement', Ctor);
  set('Node', Ctor);
  set('Event', Ctor);
  set('CustomEvent', Ctor);
  set('NodeList', Ctor);
  set('Promise', global.Promise);
  set('T', function (k) { return k; });
  set('Log', { log: function () {}, warn: function () {}, error: function () {}, enabled: function () { return false; } });
  return g;
}

// Load order mirrors index.html's <script> order for the app modules we can smoke
// without a real DOM. Vendor blobs and deeply DOM-bound modules are skipped.
var LOAD_ORDER = [
  'polyfills.js', 'config.js', 'util.js', 'idb.js', 'store.js',
  'portal-net.js', 'stalker-direct.js',
  'epg.js', 'focus.js', 'player.js', 'live-top-mini.js', 'ui.js', 'ui-modal.js'
];

function main() {
  var g = freshGlobals();
  var failures = [];
  for (var i = 0; i < LOAD_ORDER.length; i++) {
    var name = LOAD_ORDER[i];
    var path = 'assets/js/' + name;
    if (!fs.existsSync(path)) { continue; }
    var src = fs.readFileSync(path, 'utf8');
    try {
      // eval in global scope so top-level `var X` becomes a global, as in a browser.
      (0, eval)(src);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      // We only care about the boot-killing class here: undefined references and bad
      // property access at load. Other errors (missing DOM nodes, etc.) are expected
      // under stubs and are ignored so the gate stays low-noise.
      if (/is not defined|of undefined|is not a function/.test(msg)) {
        // "is not a function" can be a stub gap; keep only if it names an app symbol,
        // not one of our intentionally-partial stubs.
        failures.push(name + ': ' + msg);
      }
    }
  }
  // Verify the key public namespaces actually got defined (i.e. their IIFE completed).
  var expect = ['UI', 'Store', 'Epg', 'Focus', 'Player'];
  for (var j = 0; j < expect.length; j++) {
    if (typeof g[expect[j]] === 'undefined') {
      failures.push('namespace ' + expect[j] + ' is undefined after load (its IIFE threw)');
    }
  }
  if (failures.length) {
    console.log('boot-smoke-check: module load errors (would break boot on-device):');
    for (var k = 0; k < failures.length; k++) { console.log('    ' + failures[k]); }
    process.exit(1);
  }
  console.log('boot-smoke-check: clean (all module IIFEs evaluated, namespaces defined)');
}

main();
