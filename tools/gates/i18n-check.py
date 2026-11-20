#!/usr/bin/env python3
"""i18n-check.py — gate for static-markup translation coverage.

HISTORY / WHY A PARSER:
The first version of this gate used the same regex as the 427 tagger:
    <tag ...>TEXT</tag>
That only matches elements whose ENTIRE content is one text node. Real markup
nests — e.g.

    <div class="setting-label">Performance Mode
        <div class="setting-desc">Lite reduces work on slower TVs...</div>
    </div>

...so every settings label and every hint was invisible to both the tagger AND
the gate. The gate passed while ~50 strings stayed English on screen (reported
from device: headings translated, descriptions did not). A checker that shares
its blind spot with the thing it checks is worse than no checker, because it
manufactures false confidence.

This version walks the DOM with html.parser and inspects EVERY text node
regardless of nesting depth.

Checks:
 1. every data-i18n / data-i18n-placeholder key resolves in en.js
 2. no untagged English text node anywhere in the tree
 3. no untagged translatable placeholder

Run: python3 tools/i18n-check.py    (exit 0 clean, 1 problems)
"""
from html.parser import HTMLParser
import re
import sys

# Elements the app rewrites at runtime — translating them statically would be
# pointless (immediately overwritten) or would fight the app.
RUNTIME_IDS = {
    'splashStatus', 'pairUrl', 'pairExpires', 'channelCountChip',
}
# Never translate.
BRAND = {'Xtivio'}
# Placeholder values that are examples, not prose.
SKIP_PH = ('http://', 'https://', '00:1A:79', 'example.com')

VOID = {'br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'area', 'base'}
SKIP_TAGS = {'script', 'style', 'title'}


class Checker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.untagged = []
        self.keys = set()
        self.ph_missing = []
        self.destructive = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        # A data-i18n element that CONTAINS an element child is destructive:
        # applyStatic writes the element's own text, and markup that relies on a
        # container being translated will lose meaning. In 430 tagging
        # .setting-label (which nests .setting-desc) deleted every settings hint
        # via textContent, and would have removed a focusable button from the
        # category panel header. Tag the leaf, not the container.
        if self.stack:
            ptag, pd = self.stack[-1]
            if 'data-i18n' in pd and tag not in VOID:
                self.destructive.append(
                    (pd.get('data-i18n'), pd.get('class', ''), tag, d.get('class', '')))
        for a in ('data-i18n', 'data-i18n-placeholder'):
            if d.get(a):
                self.keys.add(d[a])
        if 'placeholder' in d:
            val = d['placeholder']
            if (not any(s in val for s in SKIP_PH)
                    and 'data-i18n-placeholder' not in d):
                self.ph_missing.append(val)
        if tag not in VOID:
            self.stack.append((tag, d))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        while self.stack and self.stack[-1][0] != tag:
            self.stack.pop()
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        text = data.strip()
        if not text or not re.search(r'[A-Za-z]{2}', text):
            return
        if not self.stack:
            return
        tag, d = self.stack[-1]
        if tag in SKIP_TAGS:
            return
        if 'data-i18n' in d:
            return
        if d.get('id') in RUNTIME_IDS:
            return
        if text in BRAND:
            return
        self.untagged.append((tag, d.get('class', ''), text[:70]))


def main():
    html = open('index.html', encoding='utf-8').read()
    en = open('assets/lang/en.js', encoding='utf-8').read()

    c = Checker()
    c.feed(html)
    status = 0

    missing = sorted(k for k in c.keys if ("'" + k + "':") not in en)
    if missing:
        status = 1
        print("i18n-check: data-i18n keys with no en.js entry:")
        for k in missing:
            print("    " + k)

    if c.untagged:
        status = 1
        print("i18n-check: untranslated text in index.html "
              "(add data-i18n=\"key\" + the key to EVERY assets/lang/*.js):")
        for tag, cls, text in c.untagged:
            print("    <%s class=%r> %s" % (tag, cls, text))

    if c.destructive:
        status = 1
        print("i18n-check: data-i18n on a container that has element children "
              "(tag the leaf text instead — translating a container deletes "
              "its children):")
        for key, pcls, ctag, ccls in c.destructive:
            print("    key=%s  parent.class=%r  ->  child <%s class=%r>"
                  % (key, pcls, ctag, ccls))

    if c.ph_missing:
        status = 1
        print("i18n-check: untranslated placeholders:")
        for v in c.ph_missing:
            print("    " + v)

    print("i18n-check: clean" if status == 0 else "\ni18n-check: FAILED")
    return status


if __name__ == '__main__':
    sys.exit(main())
