#!/usr/bin/env node
/* css-invisible-text.js — MANDATORY pre-package gate.
 *
 * WHY THIS EXISTS
 * A dedup pass merged the column-header cells (.cat-mgr-col-head /
 * .content-lock-col-head) into the same rule as the interactive checkbox cells,
 * which set `color: transparent` to hide the raw checkbox glyph. Result: the
 * CATEGORY / CONTENT / VISIBLE / LOCKED / ORDER headings rendered as empty boxes
 * in the Category and Lock managers, in every language. It shipped because the
 * dedup was reasoned about rather than measured, and because css-dupcheck only
 * looks for repeated selectors, not for changed computed values.
 *
 * The specific failure mode was a TRAILING COMMA left on a selector list, which
 * silently welded those selectors onto the following block.
 *
 * WHAT IT CHECKS
 * Any selector that names a *-head / *-header / *-label / *-title element must not
 * live in a rule that sets `color: transparent` (or an equivalent invisible-text
 * trick). Those classes exist to show text; making that text invisible is always
 * a bug, never an intent.
 *
 * Run: node tools/css-invisible-text.js   (exit 0 clean, 1 problems)
 * Needs css-tree: npm install css-tree --no-save
 */
var fs = require('fs');
var path = require('path');

var csstree;
try {
    csstree = require('css-tree');
} catch (e) {
    console.log('css-invisible-text: css-tree not installed — run:');
    console.log('    npm install css-tree --no-save');
    process.exit(1);
}

/* Selector fragments that denote something whose whole job is to display text. */
var TEXT_BEARING = /(-head\b|-header\b|-label\b|-title\b|-name-head\b|-colhead\b)/;

/* Declarations that make text invisible. */
function hidesText(decl, value) {
    if (decl === 'color' && /transparent|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(value)) return true;
    if (decl === 'font-size' && /^0(px|em|rem)?$/.test(value.trim())) return true;
    return false;
}

var files = fs.readdirSync('assets/css').filter(function (f) { return /\.css$/.test(f); });
var problems = [];

files.forEach(function (f) {
    var full = path.join('assets/css', f);
    var ast;
    try {
        ast = csstree.parse(fs.readFileSync(full, 'utf8'), { positions: true });
    } catch (e) {
        console.log('css-invisible-text: parse failed for ' + full + ': ' + e.message);
        process.exit(1);
    }
    csstree.walk(ast, {
        visit: 'Rule',
        enter: function (node) {
            var sel = csstree.generate(node.prelude);
            var offenders = sel.split(',').filter(function (s) { return TEXT_BEARING.test(s); });
            if (!offenders.length) return;
            csstree.walk(node.block, {
                visit: 'Declaration',
                enter: function (d) {
                    var val = csstree.generate(d.value);
                    if (hidesText(d.property, val)) {
                        problems.push({
                            file: full,
                            line: node.loc ? node.loc.start.line : '?',
                            sel: offenders.map(function (s) { return s.trim(); }).join(', '),
                            decl: d.property + ': ' + val
                        });
                    }
                }
            });
        }
    });
});

if (problems.length) {
    console.log('css-invisible-text: text-bearing selectors given invisible text.');
    console.log('  A heading/label class is in the same rule as a hide-the-glyph');
    console.log('  declaration — usually a trailing comma welding two selector lists.');
    console.log('');
    problems.forEach(function (p) {
        console.log('    ' + p.file + ':' + p.line);
        console.log('        selector : ' + p.sel);
        console.log('        sets     : ' + p.decl);
    });
    console.log('');
    console.log('css-invisible-text: FAILED');
    process.exit(1);
}

console.log('css-invisible-text: clean');
process.exit(0);
