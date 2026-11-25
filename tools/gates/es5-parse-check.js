#!/usr/bin/env node
/* es5-parse-check.js — MANDATORY pre-package gate (the 20th).
 *
 * WHY THIS EXISTS
 * es5-check.sh is a grep: it only knows backticks, "=>", and const/let. It does
 * not see classes, destructuring, spread, default parameters, for...of, optional
 * chaining (?.), nullish coalescing (??), async/await, generators, getters in
 * object-spread form, etc. — all of which break the older Chromium builds this
 * app ships to (webOS / Tizen). This gate asks a real JavaScript parser
 * (acorn, ecmaVersion 5) instead of pattern-matching, so ANY syntax newer than
 * ES5 is a failure no matter how it is spelled.
 *
 * WHAT IT PARSES
 *   - every *.js file under assets/ (js/, lang/, and anything added later),
 *     INCLUDING the vendored hls.min.js / pako_inflate.min.js — they must be
 *     ES5 too, since they are executed on the same TVs;
 *   - every inline <script> block in index.html (no src attribute; JSON /
 *     template script types are skipped). Inline blocks are not reachable by a
 *     per-file check, so they were uncovered before.
 *
 * SYNTAX ONLY. This does not prove that runtime APIs (Promise, Array.prototype
 * .includes, Object.assign, String.prototype.padStart ...) exist on the target
 * engine; polyfills.js is the place for those.
 *
 * It cannot pass vacuously: acorn missing, or zero scripts found, is a FAILURE.
 *
 * Run from the WEB ROOT (app/src/main/assets/web):
 *     node es5-parse-check.js
 * Needs acorn:  npm install acorn --no-save   (or NODE_PATH=<dir with acorn>)
 * Exit 0 = clean, 1 = problems.
 */
var fs = require('fs');
var path = require('path');

var acorn;
try {
    acorn = require('acorn');
} catch (e) {
    console.log('es5-parse-check: FAILED - acorn not installed — run:');
    console.log('    npm install acorn --no-save');
    process.exit(1);
}

function walk(dir, out) {
    fs.readdirSync(dir).forEach(function (name) {
        var full = path.join(dir, name);
        var st = fs.statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.js$/.test(name)) out.push(full);
    });
    return out;
}

if (!fs.existsSync('assets') || !fs.existsSync('index.html')) {
    console.log('es5-parse-check: FAILED - run from the web root (needs ./assets and ./index.html)');
    process.exit(1);
}

var targets = [];   // { label, src, lineOffset }
walk('assets', []).sort().forEach(function (f) {
    targets.push({ label: f, src: fs.readFileSync(f, 'utf8'), lineOffset: 0 });
});

var html = fs.readFileSync('index.html', 'utf8');
var re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
var m, inline = 0;
while ((m = re.exec(html)) !== null) {
    var attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    var typeM = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (typeM && !/^(text|application)\/(javascript|ecmascript)$/i.test(typeM[1])) continue;
    if (!m[2].trim()) continue;
    inline++;
    var before = html.slice(0, m.index + m[0].indexOf('>') + 1);
    targets.push({
        label: 'index.html <script> #' + inline,
        src: m[2],
        lineOffset: before.split('\n').length - 1
    });
}

if (targets.length === 0) {
    console.log('es5-parse-check: FAILED - no scripts found to parse; refusing to report clean');
    process.exit(1);
}

var problems = [];
targets.forEach(function (t) {
    try {
        acorn.parse(t.src, { ecmaVersion: 5, locations: true });
    } catch (e) {
        var line = (e.loc ? e.loc.line : 0) + t.lineOffset;
        var col = e.loc ? e.loc.column + 1 : 0;
        var msg = String(e.message).replace(/\s*\(\d+:\d+\)\s*$/, '');
        problems.push(t.label + ':' + line + ':' + col + ': ' + msg);
    }
});

if (problems.length) {
    console.log('es5-parse-check: FAILED - ' + problems.length + ' file(s)/block(s) contain syntax newer than ES5:');
    problems.slice(0, 30).forEach(function (p) { console.log('    ' + p); });
    if (problems.length > 30) console.log('    ... and ' + (problems.length - 30) + ' more');
    process.exit(1);
}
console.log('es5-parse-check: clean (' + targets.length + ' scripts parsed as ES5: ' +
    (targets.length - inline) + ' files + ' + inline + ' inline blocks)');
