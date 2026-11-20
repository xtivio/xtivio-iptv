/* i18n — string table lookup for the app UI.
 *
 * Design notes.
 *
 * ONE LANGUAGE RESIDENT AT A TIME. The string tables are separate files
 * (assets/lang/xx.js) and only the ACTIVE one is loaded. Keeping 20 tables in
 * memory would be a few hundred KB of strings on a device where the whole app is
 * already fighting the heap ceiling for the search index. Each table registers
 * itself by calling I18n.register(code, table) when its script runs.
 *
 * ENGLISH IS ALWAYS PRESENT and acts as the fallback. It is bundled rather than
 * lazily fetched, so a missing/failed language file degrades to readable English
 * instead of showing raw keys.
 *
 * MISSING KEYS return the key itself in DEBUG, and the English string otherwise.
 * A missing translation must never render as an empty string — a blank button is
 * worse than an untranslated one.
 *
 * PLACEHOLDERS use {name} and are substituted from an object:
 *
 *     T('playlist_items', { name: 'Strong', n: 1234 })
 *     -> "Strong: 1234 items"
 *
 * This exists because a large share of the app's strings are built by
 * concatenation (pl.name + ': ' + total + ' items'), which cannot be a plain key
 * lookup: word order differs between languages, so the variable parts must be
 * addressable by name rather than by position in a concatenation.
 *
 * RTL. Arabic (and any other RTL language) sets dir="rtl" on <html>, which makes the
 * browser resolve Arabic bidi/shaping. The LAYOUT stays LTR (see rtl.css: #app forces
 * direction:ltr); only text is right-to-left / right-aligned. This keeps one layout
 * skeleton (and its generated 720 overrides) as the single source of truth for both
 * directions, instead of a mirrored layout that had to be re-synced by hand.
 */
var I18n = (function () {
    'use strict';

    var TABLES = {};        // code -> { key: string }
    var current = 'en';
    var FALLBACK = 'en';

    // Languages the app ships. rtl:true drives the dir attribute + rtl.css.
    // native is what appears in the Settings picker — a user looking for their
    // own language scans for the native name, not the English one.
    var LANGUAGES = [
        { code: 'en',    name: 'English',            native: 'English' },
        { code: 'es',    name: 'Spanish',            native: 'Espa\u00f1ol' },
        { code: 'pt',    name: 'Portuguese',         native: 'Portugu\u00eas \u2013 Portugal' },
        { code: 'pt-BR', name: 'Portuguese',         native: 'Portugu\u00eas \u2013 Brasil' },
        { code: 'fr',    name: 'French',             native: 'Fran\u00e7ais' },
        { code: 'de',    name: 'German',             native: 'Deutsch' },
        { code: 'it',    name: 'Italian',            native: 'Italiano' },
        { code: 'nl',    name: 'Dutch',              native: 'Nederlands' },
        { code: 'pl',    name: 'Polish',             native: 'Polski' },
        { code: 'ro',    name: 'Romanian',           native: 'Rom\u00e2n\u0103' },
        { code: 'tr',    name: 'Turkish',            native: 'T\u00fcrk\u00e7e' },
        { code: 'ar',    name: 'Arabic',             native: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', rtl: true },
        { code: 'ru',    name: 'Russian',            native: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },
        { code: 'el',    name: 'Greek',              native: '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac' },
        { code: 'sv',    name: 'Swedish',            native: 'Svenska' },
        { code: 'da',    name: 'Danish',             native: 'Dansk' },
        { code: 'no',    name: 'Norwegian',          native: 'Norsk' },
        { code: 'cs',    name: 'Czech',              native: '\u010ce\u0161tina' },
        { code: 'hu',    name: 'Hungarian',          native: 'Magyar' },
        { code: 'bg',    name: 'Bulgarian',          native: '\u0411\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438' },
        { code: 'sr',    name: 'Serbian',            native: '\u0421\u0440\u043f\u0441\u043a\u0438' },
        { code: 'mk',    name: 'Macedonian',         native: '\u041c\u0430\u043a\u0435\u0434\u043e\u043d\u0441\u043a\u0438' },
        { code: 'sq',    name: 'Albanian',           native: 'Shqip' }
    ];

    function isRtl(code) {
        for (var i = 0; i < LANGUAGES.length; i++) {
            if (LANGUAGES[i].code === code) return !!LANGUAGES[i].rtl;
        }
        return false;
    }

    function getLanguages() { return LANGUAGES.slice(); }

    /* A language file calls this when it loads. Kept trivial so a table can be a
     * plain object literal with no build step. */
    function register(code, table) {
        if (!code || !table) return;
        TABLES[code] = table;
    }

    function has(code) { return !!TABLES[code]; }

    /* Substitute {name} placeholders. Left alone if no vars are supplied, so a
     * string containing literal braces is not mangled by an accidental call. */
    function interpolate(str, vars) {
        if (!vars || typeof str !== 'string') return str;
        return str.replace(/\{(\w+)\}/g, function (whole, key) {
            return vars.hasOwnProperty(key) ? String(vars[key]) : whole;
        });
    }

    /* The lookup used everywhere. Resolution order:
     *   active language -> English -> the key itself
     *
     * Returning the KEY rather than '' on a total miss is deliberate: an
     * untranslated label is recoverable and obvious in testing, an empty one is a
     * silent hole in the UI. */
    function t(key, vars) {
        var table = TABLES[current];
        var str = table && table.hasOwnProperty(key) ? table[key] : null;
        if (str == null) {
            var fb = TABLES[FALLBACK];
            str = fb && fb.hasOwnProperty(key) ? fb[key] : null;
        }
        if (str == null) {
            if (window.console && APP_CONFIG && APP_CONFIG.DEBUG) {
                Log.log('[i18n] missing key: ' + key);
            }
            str = key;
        }
        return interpolate(str, vars);
    }

    /* Apply a language. Sets <html lang> and <html dir>. dir="rtl" drives Arabic text
     * bidi/shaping (and native form-control/text-selection direction); the layout stays
     * LTR (rtl.css scopes RTL to text only). The CSS keys off [dir="rtl"], not a class,
     * so it also reaches native controls. */
    function setLanguage(code) {
        if (!code || !TABLES[code]) code = FALLBACK;
        current = code;
        try {
            var html = document.documentElement;
            html.setAttribute('lang', code);
            html.setAttribute('dir', isRtl(code) ? 'rtl' : 'ltr');
        } catch (e) {}
        return current;
    }

    function getLanguage() { return current; }

    /* Translate static markup.
     *
     * The persistent UI chrome (side menu, settings labels/hints, buttons, panel
     * headers, input placeholders) lives as literal text in index.html and so never
     * passed through t() — which is why selecting a language used to leave most of
     * the screen in English while toasts translated correctly.
     *
     * Elements opt in with:
     *   data-i18n="key"              -> sets textContent
     *   data-i18n-placeholder="key"  -> sets the placeholder attribute
     *
     * Call after DOM ready and again whenever the language changes. Safe to call
     * repeatedly: it always writes from the table, never from current contents, so
     * it can't compound. Missing keys fall back to English then to the key itself
     * via t(), so a gap shows up as English rather than an empty element.
     */
    function applyStatic(root) {
        var scope = root || document;
        if (!scope.querySelectorAll) return;
        var i, els;
        els = scope.querySelectorAll('[data-i18n]');
        for (i = 0; i < els.length; i++) {
            var k = els[i].getAttribute('data-i18n');
            if (k) setOwnText(els[i], t(k));
        }
        els = scope.querySelectorAll('[data-i18n-placeholder]');
        for (i = 0; i < els.length; i++) {
            var pk = els[i].getAttribute('data-i18n-placeholder');
            if (pk) els[i].setAttribute('placeholder', t(pk));
        }
    }

    /* Replace only an element's OWN text, never its child elements.
     *
     * Using el.textContent = value destroys every child node. This once
     * deleted all the settings hints: .setting-label carried data-i18n AND
     * contained a nested .setting-desc, so translating the label removed the
     * hint from the DOM entirely. It would also have removed a focusable button
     * from the category panel header, breaking remote nav.
     *
     * So: write into the first text node if there is one, otherwise insert a text
     * node at the front, and leave all element children untouched. Markup should
     * still tag leaf elements where possible — this is the safety net, not a
     * licence to tag containers.
     */
    function setOwnText(el, value) {
        var n;
        for (n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3 && n.nodeValue && n.nodeValue.replace(/^\s+|\s+$/g, '') !== '') {
                n.nodeValue = value;
                return;
            }
        }
        // No existing non-empty text node: add one before any children.
        var tn = el.ownerDocument.createTextNode(value);
        if (el.firstChild) el.insertBefore(tn, el.firstChild);
        else el.appendChild(tn);
    }

    return {
        register: register,
        has: has,
        t: t,
        setLanguage: setLanguage,
        getLanguage: getLanguage,
        getLanguages: getLanguages,
        isRtl: isRtl,
        applyStatic: applyStatic
    };
})();

/* Short global alias. Used ~360 times across the app, so the terseness is worth
 * it — T('key') reads far better inline than I18n.t('key'). */
function T(key, vars) { return I18n.t(key, vars); }
