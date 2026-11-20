/* ui-modal.js - modal / dialog / virtual-keyboard layer. Augments window.UI. */
(function () {
    'use strict';

    var $ = Util.$, $$ = Util.$$, el = Util.el;

    function openListPicker(opts) {
        var layer = $('#modalLayer');
        if (!layer) return;
        var overlay = !!(opts && opts.overlay);
        var curFocus = Focus.current();
        var openerKey = null;
        if (curFocus) {
            // In OVERLAY mode the picker stacks on top of an existing modal (e.g. a
            // parental manager opened from a "Manage" button) and restores focus to
            // its own opener (the filter button) locally via openerKey on close.
            // It must NOT overwrite window._lastModalOpener*, because those record
            // what opened the UNDERLYING modal — the thing closeModal() returns focus
            // to when the manager itself closes. Clobbering them with the filter
            // button (which is destroyed when the manager closes) is exactly why a
            // double-back after using a filter lost focus: closeModal tried to
            // restore a button that no longer existed. Only the non-overlay path
            // (which wipes the whole layer) should record the opener here.
            var fk0 = curFocus.getAttribute('data-focus-key');
            if (fk0) openerKey = fk0;
            if (!overlay) {
                window._lastModalOpenerEl = curFocus;
                if (fk0) window._lastModalOpenerKey = fk0;
            }
        }
        var host, card;
        if (overlay) {
            // Stack ON TOP of the current modal (e.g. a parental manager) instead of
            // replacing it: a full-layer scrim that holds the picker card. Removing
            // just this node on select/back leaves the underlying modal in the DOM,
            // so its state and focus survive. The normal path wipes the whole layer
            // (layer.innerHTML=''), which would destroy the manager.
            window._modalOnCancel = null;
            host = document.createElement('div');
            host.className = 'modal-pick-overlay';
            card = document.createElement('div'); card.className = 'modal-card modal-pick-card';
        } else {
            window._modalOnCancel = null;
            layer.innerHTML = '';
            host = layer;
            card = document.createElement('div'); card.className = 'modal-card modal-pick-card';
        }
        card.style.maxWidth = '94vw';
        // opts.widthPx: a wider card for long labels (Sports event picker); default stays 760.
        card.style.width = 'calc(' + (opts.widthPx || 760) + 'px * var(--ui-scale, 1))';
        var titleEl = document.createElement('div'); titleEl.className = 'modal-title';
        titleEl.textContent = opts.title || T('md_select');
        card.appendChild(titleEl);
        var listEl = document.createElement('div'); listEl.className = 'modal-body-text';
        listEl.className += ' modal-pick-list';
        if (opts.wrapRows) listEl.className += ' modal-pick-wrap';     // long labels wrap onto several lines instead of being cut
        var items = opts.items || [];
        var selected = opts.selected || 0;

        function closeOverlay() {
            if (host && host.parentNode) host.parentNode.removeChild(host);
            window._pickOverlayCancel = null;
            if (openerKey) setTimeout(function () { Focus.focusKey(openerKey); }, 0);
        }

        // Optional inline filter (type-to-narrow). Used by the card-view category
        // pickers so a long category list is quickly searchable. The input sits
        // above the list; typing rebuilds the rows, matching a case-insensitive
        // substring against each item label. Rows keep their ORIGINAL index so
        // onSelect(idx) still refers to the right category.
        var filterInput = null;
        if (opts.filterable) {
            filterInput = document.createElement('input');
            filterInput.type = 'text';
            // Match the list-view category filter: same classes (background/focus
            // highlight), readonly so the native TV keyboard never fires, and a
            // focus-key so it's a normal focusable node in the picker.
            filterInput.className = 'field focusable cat-filter modal-pick-filter';
            filterInput.setAttribute('readonly', 'readonly');
            filterInput.setAttribute('tabindex', '-1');
            filterInput.setAttribute('data-focus-key', 'pick-filter');
            filterInput.setAttribute('placeholder', opts.filterPlaceholder || (T('ui_ph_filter_categories') || 'Filter…'));
            card.appendChild(filterInput);
        }

        function buildRows(filterText) {
            listEl.innerHTML = '';
            var ft = (filterText || '').toLowerCase();
            var firstKey = null;
            for (var i = 0; i < items.length; i++) {
                if (ft && String(items[i]).toLowerCase().indexOf(ft) === -1) continue;
                (function (idx) {
                    var row = document.createElement('button');
                    row.className = 'btn focusable';
                    row.setAttribute('tabindex', '-1');
                    row.setAttribute('data-focus-key', 'pick-' + idx);
                    var isLocked = opts.locked && opts.locked[idx];
                    row.textContent = (idx === selected ? '\u2713 ' : '  ') + items[idx];
                    if (isLocked) {
                        row.className += ' modal-pick-locked';
                        if (UI.makeLockGlyph) {
                            var lg = UI.makeLockGlyph();
                            lg.className = 'lock-glyph pick-lock-glyph';
                            row.appendChild(lg);
                        }
                    }
                    row.className = (row.className ? row.className + ' ' : '') + 'modal-pick-row';
                    row.addEventListener('click', function () {
                        if (overlay) { closeOverlay(); if (opts.onSelect) opts.onSelect(idx); }
                        else { closeModal(); if (opts.onSelect) opts.onSelect(idx); }
                    });
                    listEl.appendChild(row);
                    if (firstKey === null) firstKey = 'pick-' + idx;
                })(i);
            }
            return firstKey;
        }

        buildRows('');
        card.appendChild(listEl);
        if (overlay) {
            host.appendChild(card);
            layer.appendChild(host);
            host._overlayCancel = closeOverlay;
            window._pickOverlayCancel = closeOverlay;
        } else {
            layer.appendChild(card);
        }
        layer.classList.remove('hidden');
        if (filterInput) {
            filterInput.addEventListener('input', function () {
                buildRows(filterInput.value);
            });
            // Pressing OK on the filter opens the on-screen keyboard; it writes back
            // into the field and dispatches 'input', which rebuilds the rows. The
            // native keyboard never fires (field is readonly).
            filterInput.addEventListener('click', function () {
                if (UI.openVKeyboard) { try { UI.openVKeyboard(filterInput, filterInput); } catch (e) {} }
            });
        }
        // Focus the first category (or the selected one) on open — NOT the filter,
        // so the user lands in the list and can start navigating immediately.
        setTimeout(function () {
            var firstRow = listEl.querySelector('.modal-pick-row');
            var selKey = 'pick-' + selected;
            if (listEl.querySelector('[data-focus-key="' + selKey + '"]')) Focus.focusKey(selKey);
            else if (firstRow) Focus.focus(firstRow);
        }, 100);
    }

    /* Subtitle picker modal.
     *
     * Lifecycle:
     *   1. User clicks the subtitle button in the player overlay.
     *      Player.isVod() is checked upstream (app.js); only reached
     *      for movies/series.
     *   2. We open the modal immediately with a "Loading…" placeholder
     *      so the user sees instant feedback even if the network round-
     *      trip to Wyzie is slow.
     *   3. Subs.fetchForItem(channel) runs in the background. The
     *      result is cached per item so subsequent opens are instant.
     *   4. On resolve we replace the body with a list of available
     *      languages plus an explicit "Off" entry at the top.
     *   5. Clicking a language:
     *        - calls Subs.loadTrack(option) to fetch + convert
     *        - calls Player.setSubtitleTrack(blobUrl, label, lang)
     *        - persists the language as the user's preference
     *        - closes the modal
     *      Clicking "Off":
     *        - calls Player.clearSubtitles()
     *        - persists 'off' as the preference (auto-load will skip
     *          subtitles on next VOD play until the user picks again)
     *   6. On Wyzie error or empty result: shows "No subtitles found"
     *      and offers a Close button.
     *
     * Race protection: if the user closes the modal before Wyzie
     * responds, we check that the modal is still open before mutating
     * its body. (Modal stack rebuilds on each open so a stale callback
     * would write into a closed/replaced modal otherwise.) */
    /* Four-column subtitle wizard. All columns are always visible and fill in as
     * the user progresses:
     *   1 Title     — title/ID status + "Search by title" (for no-ID items).
     *   2 Language  — Off, common languages, "Type code". Selecting fetches ONLY
     *                 that language (backend-scoped) into column 3.
     *   3 Subtitles — results for the selected language. Selecting loads the track.
     *   4 Offset    — sync offset controls for the loaded subtitle (Stage C).
     * Per-title last language is remembered; reopening shows its cached results. */
    function openSubtitlePicker(channel) {
        var layer = $('#modalLayer');
        if (!layer) return;
        if (!window.Subs) { toast(T('sub_module_unavailable'), null); return; }
        window._modalOnCancel = null;
        var curFocus = Focus.current();
        if (curFocus) {
            window._lastModalOpenerEl = curFocus;
            var fk = curFocus.getAttribute('data-focus-key');
            if (fk) window._lastModalOpenerKey = fk;
        }
        layer.innerHTML = '';
        layer._subSavedSig = null;
        layer._subResolvedKey = null;
        var card = document.createElement('div'); card.className = 'modal-card';
        card.style.width = 'calc(1400px * var(--ui-scale, 1))';
        card.style.maxWidth = '94vw';
        var titleEl = document.createElement('div'); titleEl.className = 'modal-title';
        titleEl.textContent = T('subtitles');
        card.appendChild(titleEl);

        var wrap = document.createElement('div'); wrap.className = 'sub4-wrap';
        var colTitle = mkCol(false);
        var colLang = mkCol(false);
        var colSubs = mkCol(false);
        colSubs.className += ' sub4-search-col';
        var colOff = mkCol(true);
        wrap.appendChild(colTitle);
        wrap.appendChild(colLang);
        wrap.appendChild(colSubs);
        wrap.appendChild(colOff);
        card.appendChild(wrap);
        layer.appendChild(card);
        layer.classList.remove('hidden');
        try { Focus.popScope(); } catch (e) {}
        Focus.pushScope(layer);

        var openToken = {};
        layer._subPickerToken = openToken;

        var state = { lang: null, options: null, reason: null, loadedLang: null, loadedUrl: null, offsetMs: 0, _syncAudioT: null, _syncSubT: null };

        function mkCol(last) {
            var c = document.createElement('div');
            c.className = 'sub4-col' + (last ? ' sub4-last' : '');
            return c;
        }

        // ---- Column 1: Title ----
        function renderTitle() {
            Util.empty(colTitle);
            colTitle.appendChild(makeSubHeaderEl('sub4-colhead', T('sub_col_title')));
            var ik = Subs._itemKey ? Subs._itemKey(channel) : null;
            var info = document.createElement('div'); info.className = 'sub4-info';
            var name = (channel && (channel.name || channel.title)) || T('sub_this_title');
            if (ik && (ik.imdb || ik.tmdb)) {
                info.textContent = name + '\u2014 ID ' + (ik.imdb || ik.tmdb);
            } else {
                info.textContent = name + ' \u2014 ' + T('sub_no_metadata_use_search');
            }
            colTitle.appendChild(info);

            var searchRow = makeRow('sub4-row', T('sub_search_by_title'), false, 'subt-search');
            searchRow.addEventListener('click', function () {
                // Language is mandatory before searching. If none chosen, send the
                // user to the Language column rather than searching all languages.
                if (!state.lang) {
                    toast(T('pick_a_language_first'), null);
                    Util.empty(colSubs);
                    colSubs.appendChild(makeSubHeaderEl('sub4-colhead', T('subtitles')));
                    var hint = document.createElement('div');
                    hint.className = 'sub4-empty';
                    hint.textContent = T('pick_a_language_first');
                    colSubs.appendChild(hint);
                    Focus.focusKey('sublang-en');
                    return;
                }
                openManualSubSearch(layer, card, colSubs, channel);
            });
            colTitle.appendChild(searchRow);

            var cancelRow = makeRow('sub4-row', T('close'), false, 'subt-cancel');
            cancelRow.addEventListener('click', function () { closeModal(); });
            colTitle.appendChild(cancelRow);
        }

        // ---- Column 2: Language ----
        function renderLang() {
            Util.empty(colLang);
            colLang.appendChild(makeSubHeaderEl('sub4-colhead', T('sub_col_language')));

            var langs = defaultLangList();
            // If a custom (typed) language is selected and isn't in the common
            // list, surface it as its own row so it shows a tick and stays
            // selectable.
            if (state.lang) {
                var inList = false;
                for (var c = 0; c < langs.length; c++) { if (langs[c][0] === state.lang) { inList = true; break; } }
                if (!inList) {
                    var customRow = makeRow('sub4-row', langLabel(state.lang), true, 'sublang-' + state.lang);
                    (function (lc) {
                        customRow.addEventListener('click', function () { selectLang(lc); });
                    })(state.lang);
                    colLang.appendChild(customRow);
                }
            }
            for (var i = 0; i < langs.length; i++) {
                (function (code, name) {
                    // Tick the language that is currently SELECTED in the wizard.
                    var sel = (code === state.lang);
                    var row = makeRow('sub4-row', name, sel, 'sublang-' + code);
                    row.addEventListener('click', function () { selectLang(code); });
                    colLang.appendChild(row);
                })(langs[i][0], langs[i][1]);
            }

            var typeRow = makeRow('sub4-row', T('sub_type_code'), false, 'sublang-type');
            typeRow.addEventListener('click', function () { openSubLangTypeIn(colSubs, selectLang); });
            colLang.appendChild(typeRow);
        }

        // Select a language: fetch ONLY that language into column 3. Keeps focus on
        // the chosen language row (re-render destroys the old node, so re-focus).
        function selectLang(code) {
            if (!code) return;
            state.lang = code; layer._subLang = code;
            state.options = null; state.reason = null;
            if (Subs.setLastLang) Subs.setLastLang(channel, code);
            renderLang();
            Focus.focusKey('sublang-' + code);
            Util.empty(colSubs);
            colSubs.appendChild(makeSubHeaderEl('sub4-colhead', langLabel(code) + ' subtitles'));
            var loading = document.createElement('div');
            loading.className = 'modal-pick-loading';
            loading.textContent = T('finding');
            colSubs.appendChild(loading);
            Subs.fetchForItem(channel, { language: code }).then(function (result) {
                if (layer._subPickerToken !== openToken) return;
                state.options = result.options || [];
                state.reason = result.reason || 'ok';
                // Persist via the single-record cache. For items that already carry
                // an ID, that ID is the resolved key (stable across playlists).
                if (state.options.length && Subs.saveOne) {
                    var ikNow = Subs._itemKey ? Subs._itemKey(channel) : null;
                    var rk = ikNow ? (ikNow.tmdb ? ('tmdb:' + ikNow.tmdb) : (ikNow.imdb ? ('imdb:' + ikNow.imdb) : null)) : null;
                    Subs.saveOne(channel, code, state.options, rk);
                }
                renderSubs();
                if (state.options.length) {
                    setTimeout(function () { Focus.focusKey('subres-0'); }, 40);
                }
            });
        }

        // ---- Column 3: Subtitles ----
        function renderSubs() {
            Util.empty(colSubs);
            var activeLang = (Player && Player.getActiveSubtitleLanguage)
                ? Player.getActiveSubtitleLanguage() : null;
            colSubs.appendChild(makeSubHeaderEl('sub4-colhead', T('subtitles')));

            // Off ticks only when subtitles are genuinely off: nothing playing,
            // nothing loaded this session, AND no language is being browsed. While a
            // language is selected, Off must NOT tick (only the language ticks).
            var subtitleActive = (activeLang != null) || (state.loadedLang != null);
            var offTicked = !subtitleActive && !state.lang;
            var offRow = makeRow('sub4-row', T('sub_off'), offTicked, 'subres-off');
            offRow.setAttribute('data-focus-up', '__none__');
            offRow.addEventListener('click', function () {
                if (Player.clearSubtitles) Player.clearSubtitles();
                if (Store.setPreferredSubLang) Store.setPreferredSubLang('off');
                state.loadedLang = null; state.loadedUrl = null; state.offsetMs = 0;
                renderSubs(); renderOffset();
                toast(T('subtitles_off'), 'ok');
                Focus.focusKey('subres-off');
            });
            colSubs.appendChild(offRow);

            if (!state.lang) {
                var hint = document.createElement('div');
                hint.className = 'sub4-empty';
                hint.textContent = T('pick_a_language_to_search');
                colSubs.appendChild(hint);
                return;
            }
            if (state.options == null) {
                var l = document.createElement('div'); l.className = 'modal-pick-loading';
                l.textContent = T('finding'); colSubs.appendChild(l); return;
            }
            if (!state.options.length) {
                var msg;
                if (state.reason === 'no-id') msg = 'No ID — use Search by title.';
                else if (state.reason === 'not-configured') msg = T('sub_search_not_configured');
                else if (state.reason === 'error') msg = T('sub_server_error');
                else msg = 'No ' + langLabel(state.lang) + ' subtitles.';
                var e = document.createElement('div'); e.className = 'sub4-empty';
                e.textContent = msg; colSubs.appendChild(e); return;
            }
            // Pre-filter to the selected language so focus-key indices are
            // sequential (subres-0 is always the first VISIBLE row). Rendering with
            // the raw array index left gaps when an entry was filtered out, so
            // subres-0 sometimes didn't exist and focus never landed on the list.
            var shown = [];
            for (var si = 0; si < state.options.length; si++) {
                var o = state.options[si];
                if (state.lang && o.language !== state.lang) continue;
                shown.push(o);
            }
            if (!shown.length) {
                var none = document.createElement('div'); none.className = 'sub4-empty';
                none.textContent = T('no') + ' ' + langLabel(state.lang) + ' subtitles.';
                colSubs.appendChild(none); return;
            }
            // CHOKE POINT: any time a non-empty result list is shown for a language,
            // persist it. This catches every path that presents results (manual
            // search, language selection, reopen-restore) so the list is always
            // cached for the next reopen. Skip if we just restored this exact list.
            if (state.lang && shown.length && Subs.saveOne) {
                var sig = state.lang + '#' + shown.length + '#' + (shown[0] && shown[0].url);
                if (layer._subSavedSig !== sig) {
                    layer._subSavedSig = sig;
                    try {
                        Subs.saveOne(channel, state.lang, state.options, layer._subResolvedKey || null, state.loadedUrl || null);
                    } catch (eSave) {
                    }
                }
            }
            for (var i = 0; i < shown.length; i++) {
                (function (opt, idx, isLast) {
                    var label = opt.languageName;
                    if (opt.variant && opt.variant > 1) label += ' (' + opt.variant + ')';
                    var isActive = (state.loadedUrl && opt.url === state.loadedUrl);
                    var row = makeRow('sub4-row', label, isActive, 'subres-' + idx);
                    // Last row is the bottom of the column: dead-end Down so focus
                    // can't fall into a neighbouring column/list.
                    if (isLast) row.setAttribute('data-focus-down', '__none__');
                    row.addEventListener('click', function () {
                        var allRows = colSubs.querySelectorAll('button');
                        for (var ri = 0; ri < allRows.length; ri++) allRows[ri].disabled = true;
                        row.textContent = T('loading_3');
                        Subs.loadTrack(opt).then(function (result) {
                            if (Player.setSubtitleTrack) Player.setSubtitleTrack(result.blobUrl, label, opt.language, result.vttText);
                            if (Store.setPreferredSubLang) Store.setPreferredSubLang(opt.language);
                            state.loadedLang = opt.language;
                            // Keep the saved offset if re-loading the SAME subtitle
                            // that was previously loaded; reset to 0 for a new one.
                            if (state.loadedUrl !== opt.url) state.offsetMs = 0;
                            state.loadedUrl = opt.url;
                            if (Player.setSubtitleOffset && state.offsetMs) Player.setSubtitleOffset(state.offsetMs);
                            // Persist the WHOLE results list now — selecting a
                            // subtitle is the one action we know happened, so saving
                            // here guarantees the list is cached for reopen no matter
                            // how it was fetched. Keyed by item + (if known) resolved
                            // ID. Also stamp the loaded url so reopen can re-tick it.
                            if (Subs.saveOne && state.options && state.options.length) {
                                Subs.saveOne(channel, state.lang, state.options, layer._subResolvedKey || null, opt.url, state.offsetMs);
                            }
                            toast(T('subtitles_2') + ' ' + label, 'ok');
                            renderSubs(); renderOffset();
                            Focus.focusKey('suboff-plus');
                        })['catch'](function () {
                            toast(T('sub_failed_load'), null);
                            renderSubs();
                        });
                    });
                    colSubs.appendChild(row);
                })(shown[i], i, i === shown.length - 1);
            }
        }

        // ---- Column 4: Offset (sync) ----
        function renderOffset() {
            Util.empty(colOff);
            colOff.appendChild(makeSubHeaderEl('sub4-colhead', T('sub_col_offset')));
            if (!state.loadedLang) {
                var e = document.createElement('div'); e.className = 'sub4-empty';
                e.textContent = T('load_a_subtitle_to_adjust_sync');
                colOff.appendChild(e);
                return;
            }
            var val = document.createElement('div'); val.className = 'sub4-offval';
            val.textContent = (state.offsetMs >= 0 ? '+' : '') + (state.offsetMs / 1000).toFixed(1) + 's';
            colOff.appendChild(val);

            function persistOffset() {
                if (Subs.saveOne && state.options && state.options.length && state.lang) {
                    Subs.saveOne(channel, state.lang, state.options, layer._subResolvedKey || null, state.loadedUrl || null, state.offsetMs);
                }
            }
            function bump(deltaMs) {
                state.offsetMs += deltaMs;
                if (Player.setSubtitleOffset) Player.setSubtitleOffset(state.offsetMs);
                persistOffset();
                renderOffset();
                Focus.focusKey(deltaMs > 0 ? 'suboff-plus' : 'suboff-minus');
            }
            var plusBig = makeRow('sub4-row', '+0.5s (text later)', false, 'suboff-plus');
            plusBig.addEventListener('click', function () { bump(500); });
            colOff.appendChild(plusBig);
            var plusSm = makeRow('sub4-row', '+0.1s', false, 'suboff-plus2');
            plusSm.addEventListener('click', function () { bump(100); });
            colOff.appendChild(plusSm);
            var minusSm = makeRow('sub4-row', '\u22120.1s', false, 'suboff-minus2');
            minusSm.addEventListener('click', function () { bump(-100); });
            colOff.appendChild(minusSm);
            var minusBig = makeRow('sub4-row', '\u22120.5s (text earlier)', false, 'suboff-minus');
            minusBig.addEventListener('click', function () { bump(-500); });
            colOff.appendChild(minusBig);
            var reset = makeRow('sub4-row', T('sub_reset'), false, 'suboff-reset');
            reset.addEventListener('click', function () {
                state.offsetMs = 0;
                if (Player.setSubtitleOffset) Player.setSubtitleOffset(0);
                persistOffset();
                renderOffset(); Focus.focusKey('suboff-reset');
            });
            colOff.appendChild(reset);

            // ---- Stage C: easy two-button sync ----
            // Two independent buttons: one tags the moment you HEAR a line of
            // dialogue, the other tags the moment you SEE that same line in the
            // subtitle. Press them in EITHER order (the subtitle may appear before
            // or after the audio). Once both are tagged we compute the shift:
            //   delta = audioTime - subTime
            // Positive delta => subtitle is running early, so delay it (the renderer
            // looks up cues at currentTime - offset, so a positive offset delays).
            // Negative delta => subtitle is late, so advance it. Folded into the
            // running offset. No pausing — playback continues throughout.
            var syncHint = document.createElement('div');
            syncHint.className = 'sub4-syncnote';

            function syncStatusText() {
                var a = state._syncAudioT != null;
                var s = state._syncSubT != null;
                if (a && !s) return T('sub_audio_tagged_hint');
                if (s && !a) return T('sub_sub_tagged_hint');
                return T('sub_tag_hint');
            }

            function applyQuickSyncIfReady() {
                if (state._syncAudioT == null || state._syncSubT == null) {
                    syncHint.textContent = syncStatusText();
                    return;
                }
                var deltaMs = Math.round((state._syncAudioT - state._syncSubT) * 1000);
                state._syncAudioT = null;
                state._syncSubT = null;
                state.offsetMs += deltaMs;
                if (Player.setSubtitleOffset) Player.setSubtitleOffset(state.offsetMs);
                persistOffset();
                toast(T('sub_synced') + ' ' + (deltaMs >= 0 ? '+' : '') + (deltaMs / 1000).toFixed(1) + 's', 'ok');
                renderOffset();
                Focus.focusKey('suboff-sync-audio');
            }

            function tagNow(which) {
                if (!Player.getPosition) { toast(T('sub_sync_unavailable'), null); return; }
                var now = Player.getPosition().currentTime || 0;
                if (which === 'audio') state._syncAudioT = now;
                else state._syncSubT = now;
                var both = (state._syncAudioT != null && state._syncSubT != null);
                applyQuickSyncIfReady();
                if (!both) {
                    // Only one tagged so far: re-render to reflect the tagged state and
                    // keep focus on the button just pressed so the user can tag the other.
                    renderOffset();
                    Focus.focusKey(which === 'audio' ? 'suboff-sync-audio' : 'suboff-sync-sub');
                }
            }

            var audioBtn = makeRow('sub4-row sub4-sync', (state._syncAudioT != null ? T('sub_audio_tagged') : T('sub_tag_audio')), state._syncAudioT != null, 'suboff-sync-audio');
            audioBtn.addEventListener('click', function () { tagNow('audio'); });
            colOff.appendChild(audioBtn);

            var subBtn = makeRow('sub4-row sub4-sync', (state._syncSubT != null ? T('sub_sub_tagged') : T('sub_tag_sub')), state._syncSubT != null, 'suboff-sync-sub');
            subBtn.addEventListener('click', function () { tagNow('sub'); });
            colOff.appendChild(subBtn);

            syncHint.textContent = syncStatusText();
            colOff.appendChild(syncHint);

            /* The 'Easy sync: tag the audio and the subtitle' intro is gone. It said
             * the same thing as the live status line below it (sub4-syncnote, which
             * already reads 'Tag the audio and the subtitle for the same line'), so
             * the panel showed the same instruction twice — once statically and once
             * as the thing that actually updates as you tag. Keeping the one that
             * responds to the user is the useful half. */
        }

        layer._subRenderSubs = function (options, reason, resolvedKey) {
            // Manual search injects results here. A language is required before
            // searching (enforced at the Search button), so state.lang is set.
            var lang = state.lang;
            state.options = options || [];
            state.reason = reason || 'ok';
            // Cache under the RESOLVED ID key (stable across playlists) when manual
            // search resolved one — the provider title is arbitrary and differs per
            // playlist for the same film. Also remember provider->resolved so this
            // provider item can find the shared cache on reopen without re-resolving.
            if (state.options.length && lang) {
                // Bulletproof single-record save (results + lang + resolved key).
                if (Subs.saveOne) Subs.saveOne(channel, lang, state.options, resolvedKey || null);
                // Also keep the resolved-ID provider mapping for cross-playlist reuse.
                if (resolvedKey) {
                    if (Subs.setResolvedKey) Subs.setResolvedKey(channel, resolvedKey);
                    layer._subResolvedKey = resolvedKey;
                }
            }
            renderLang();
            renderSubs();
            if (state.options.length) setTimeout(function () { Focus.focusKey('subres-0'); }, 40);
        };

        renderTitle();
        renderLang();
        renderSubs();
        renderOffset();

        // Reopen: restore via the bulletproof single-record cache first (one key,
        // results+lang together). Then older fallbacks for pre-existing entries.
        var found = Subs.loadOne ? Subs.loadOne(channel) : null;
        if (!found) {
            var resolvedKey = Subs.getResolvedKey ? Subs.getResolvedKey(channel) : null;
            if (resolvedKey && Subs.findAnyCachedByKey) {
                var byId = Subs.findAnyCachedByKey(resolvedKey);
                if (byId) { found = byId; layer._subResolvedKey = resolvedKey; }
            }
            if (!found && Subs.findAnyCached) found = Subs.findAnyCached(channel);
        }
        if (found && found.resolvedKey) layer._subResolvedKey = found.resolvedKey;
        var dbgIk = Subs._itemKey ? Subs._itemKey(channel) : null;
        Log.log('[subs] OPEN ikKey=' + (dbgIk ? dbgIk.key : 'null') + ' restored=' + (found ? (found.lang + ':' + found.options.length) : 'none'));
        var last = found ? found.lang : null;
        var cached = found ? found.options : null;
        if (last && cached && cached.length) {
            state.lang = last; layer._subLang = last; state.options = cached; state.reason = 'ok';
            if (found.loadedUrl) {
                state.loadedUrl = found.loadedUrl;
                // A subtitle was previously selected for this item — restore the
                // loaded-language marker so the Offset column shows (it's gated on
                // loadedLang), with the persisted offset value.
                state.loadedLang = last;
            }
            if (typeof found.offsetMs === 'number') state.offsetMs = found.offsetMs;
            renderLang(); renderSubs(); renderOffset();
        }

        // Focus the target language deterministically. Do it now (renders are done)
        // and again shortly after, because the focus-refresh timer can null a
        // freshly-set focus if it briefly considers the element not yet laid out.
        // Focus target: if a subtitle is already loaded for this item, land on the
        // Offset column so the user can adjust sync straight away. Otherwise focus
        // the (restored or default) language.
        var focusTarget = state.loadedLang ? 'suboff-plus' : (last ? ('sublang-' + last) : 'sublang-en');
        function settleFocus() {
            if (!Focus.focusKey(focusTarget)) {
                // Fallback: first focusable in the modal.
                var f = layer.querySelector('.focusable');
                if (f) Focus.focus(f);
            }
        }
        settleFocus();
        setTimeout(settleFocus, 50);
        setTimeout(settleFocus, 150);
    }

    function defaultLangList() {
        // English is always first; the rest are sorted alphabetically by name.
        var rest = [
            ['es', 'Spanish'], ['fr', 'French'],
            ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
            ['ar', 'Arabic'], ['ru', 'Russian'], ['nl', 'Dutch'],
            ['tr', 'Turkish'], ['pl', 'Polish']
        ];
        rest.sort(function (a, b) { return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0); });
        return [['en', 'English']].concat(rest);
    }

    function langLabel(code) {
        if (!code) return '';
        var list = defaultLangList();
        for (var i = 0; i < list.length; i++) if (list[i][0] === code) return list[i][1];
        if (window.Subs && Subs.langName) return Subs.langName(code, null);
        return code.toUpperCase();
    }

    /* Type a 2-letter language code (readonly → in-app vkeyboard), painting into
     * the given column; on submit, call onPick(code). */
    function openSubLangTypeIn(col, onPick) {
        Util.empty(col);
        col.appendChild(makeSubHeaderEl('sub4-colhead', T('sub_type_code_head')));
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'field focusable login-field';
        inp.id = 'subLangCode';
        inp.setAttribute('tabindex', '-1');
        inp.setAttribute('data-focus-key', 'sublang-input');
        inp.setAttribute('placeholder', T('ui_ph_lang_code_hint'));
        inp.setAttribute('readonly', 'readonly');
        inp.setAttribute('maxlength', '2');
        inp.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (UI.openVKeyboard) UI.openVKeyboard(inp);
        });
        col.appendChild(inp);
        var note = makeSubNote(''); note.style.display = 'none'; col.appendChild(note);
        var goBtn = makeRow('sub4-row', 'Search', false, 'sublang-go');
        goBtn.addEventListener('click', function () {
            var code = (inp.value || '').toLowerCase().replace(/[^a-z]/g, '');
            if (code.length !== 2) { note.style.display = ''; note.textContent = T('enter_a_2_letter_code'); return; }
            onPick(code);
        });
        col.appendChild(goBtn);
        setTimeout(function () { Focus.focusKey('sublang-input'); }, 60);
    }

    function makeSubHeaderEl(cls, text) {
        var h = document.createElement('div');
        h.className = cls;
        h.textContent = text;
        return h;
    }
    function makeRow(cls, label, active, focusKey) {
        var row = document.createElement('button');
        row.className = 'btn focusable ' + cls;
        row.setAttribute('tabindex', '-1');
        row.setAttribute('data-focus-key', focusKey);
        row.textContent = (active ? '\u2713 ' : '   ') + label;
        return row;
    }

    function openManualSubSearch(layer, card, listEl, channel) {
        Util.empty(listEl);
        var isSeries = !!(channel && (channel.type === 'series' ||
                          channel.season != null || channel.series_id || channel.seriesId ||
                          (channel.stream_type && String(channel.stream_type).indexOf('series') >= 0) ||
                          (channel.type === 'stalker' && channel.stalkerKind === 'series')));

        function makeInput(id, placeholder, focusKey, isNumeric) {
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'field focusable login-field';
            inp.id = id;
            inp.setAttribute('tabindex', '-1');
            inp.setAttribute('data-focus-key', focusKey);
            inp.setAttribute('placeholder', placeholder);
            // readonly so the native LG/Tizen system keyboard never appears — text
            // is entered only via the in-app vkeyboard (same pattern as all other
            // fields in the app). inputmode hints the numeric vkeyboard layout.
            inp.setAttribute('readonly', 'readonly');
            if (isNumeric) inp.setAttribute('inputmode', 'numeric');
            inp.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                if (UI.openVKeyboard) UI.openVKeyboard(inp);
            });
            return inp;
        }

        var titleInp = makeInput('subManualTitle', T('sub_ph_title'), 'subm-title', false);
        listEl.appendChild(titleInp);
        var yearInp = makeInput('subManualYear', T('sub_ph_year'), 'subm-year', true);
        listEl.appendChild(yearInp);
        var seasonInp = null, epInp = null;
        if (isSeries) {
            seasonInp = makeInput('subManualSeason', T('ui_season'), 'subm-season', true);
            listEl.appendChild(seasonInp);
            epInp = makeInput('subManualEpisode', T('ui_episode'), 'subm-episode', true);
            listEl.appendChild(epInp);
        }

        var statusNote = makeSubNote('');
        statusNote.style.display = 'none';
        listEl.appendChild(statusNote);

        var searchBtn = document.createElement('button');
        searchBtn.className = 'btn focusable modal-pick-row subm-action';
        searchBtn.setAttribute('tabindex', '-1');
        searchBtn.setAttribute('data-focus-key', 'subm-search');
        searchBtn.textContent = T('search_2');
        searchBtn.addEventListener('click', function () {
            var title = (titleInp.value || '').replace(/^\s+|\s+$/g, '');
            if (!title) { statusNote.style.display = ''; statusNote.textContent = T('enter_a_title_to_search'); return; }
            statusNote.style.display = '';
            statusNote.textContent = T('searching');
            searchBtn.disabled = true;
            var terms = {
                title: title,
                year: (yearInp.value || '').replace(/[^0-9]/g, ''),
                type: isSeries ? 'tv' : 'movie',
                season: seasonInp ? (seasonInp.value || '').replace(/[^0-9]/g, '') : null,
                episode: epInp ? (epInp.value || '').replace(/[^0-9]/g, '') : null
            };
            Subs.searchManual(terms, layer._subLang || null).then(function (result) {
                if (layer._subPickerToken !== undefined && layer.classList.contains('hidden')) return;
                if (result.reason === 'not-configured') {
                    statusNote.textContent = T('subtitle_search_is_not_configured_on');
                    searchBtn.disabled = false;
                    return;
                }
                if (!result.options || !result.options.length) {
                    statusNote.textContent = (result.reason === 'no-match')
                        ? T('sub_no_match')
                        : T('sub_none_found');
                    searchBtn.disabled = false;
                    return;
                }
                // Re-render the picker with the manual results. Pass the resolved
                // ID key so caching uses the stable ID, not the provider title.
                if (layer._subRenderSubs) layer._subRenderSubs(result.options, "ok", result.resolvedKey || null);
            });
        });
        listEl.appendChild(searchBtn);

        var backBtn = document.createElement('button');
        backBtn.className = 'btn focusable modal-pick-row subm-action';
        backBtn.setAttribute('tabindex', '-1');
        backBtn.setAttribute('data-focus-key', 'subm-back');
        backBtn.textContent = T('cancel');
        backBtn.addEventListener('click', function () { closeModal(); });
        listEl.appendChild(backBtn);

        setTimeout(function () { Focus.focusKey('subm-title'); }, 60);
    }

    /* Language chooser — shown first when the subtitle picker opens. The user
     * must choose ONE language; we then fetch only that language (never "all").
     * Includes Off, the common list, and a "Type a language code" entry for
     * anything not listed. */

    function makeSubNote(text) {
        var n = document.createElement('div');
        n.className = (n.className ? n.className + ' ' : '') + 'modal-pick-note';
        n.textContent = text;
        return n;
    }


    /* Called by Player.play() for VOD items. If the
     * user has a saved preference, look it up in Wyzie's catalog for
     * this item and auto-load it. 'off' is a real preference value
     * meaning "don't auto-load anything". null / empty means user has
     * never picked — we fall back to browser locale once.
     *
     * Wyzie now uses 2-letter ISO 639-1 codes (was
     * 3-letter). navigator.language is BCP-47 ("en-US") which we
     * already shorten to "en" — that's now directly Wyzie-compatible
     * so the 3-letter mapping table is gone. */
    function autoLoadSubtitlesForItem(item) {
        if (!window.Subs || !window.Player) return;
        if (!Player.isVod || !Player.isVod()) return;
        // Per-title last language (set when the user searched this title) wins, so
        // an item re-loads the language they last chose for it. Else the global
        // saved preference; else the browser locale.
        var perTitle = Subs.getLastLang ? Subs.getLastLang(item) : null;
        var pref = perTitle || (Store.getPreferredSubLang ? Store.getPreferredSubLang() : null);
        if (pref === 'off') return;
        // First run: pick 2-letter code from browser locale.
        if (!pref) {
            pref = ((navigator.language || 'en').split('-')[0] || 'en').toLowerCase();
        }
        // Stored preferences from earlier patches may be 3-letter; if
        // we see one we still try it, but pref-matching against the
        // 2-letter results won't find it. The user can re-pick a
        // language once and the new 2-letter code gets saved.
        if (pref.length === 3) {
            // Best-effort map of the most common 3-letter→2-letter
            // codes so users with old prefs still get auto-load.
            var compat = {
                eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
                ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', chi: 'zh', zho: 'zh',
                jpn: 'ja', kor: 'ko', hin: 'hi', tur: 'tr', nld: 'nl', pol: 'pl',
                swe: 'sv', dan: 'da', fin: 'fi', nor: 'no', cze: 'cs', ces: 'cs',
                ell: 'el', gre: 'el', heb: 'he', hun: 'hu', ron: 'ro', rum: 'ro',
                ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', bul: 'bg', hrv: 'hr',
                srp: 'sr', slo: 'sk', slk: 'sk', slv: 'sl', cat: 'ca'
            };
            pref = compat[pref] || pref;
        }
        Subs.fetchForItem(item, (pref && /^[a-z]{2}$/.test(pref)) ? { language: pref } : null).then(function (result) {
            /* Result is now {options, reason, resolvedKey}. */
            var options = (result && result.options) || [];
            if (!options.length) return;
            // If the provider supplied a real ID, cache these results under it so the
            // same film on another provider (resolved via manual search to the same
            // ID) reuses them instead of a fresh Wyzie call.
            if (result.resolvedKey && Subs.saveOne) {
                try { Subs.saveOne(item, pref, options, result.resolvedKey, null); } catch (eSave) {}
            }
            var match = null;
            for (var i = 0; i < options.length; i++) {
                if (options[i].language === pref) { match = options[i]; break; }
            }
            if (!match) return; // user's preferred language not available
            Subs.loadTrack(match).then(function (result) {
                if (Player.setSubtitleTrack) {
                    Player.setSubtitleTrack(result.blobUrl, match.languageName, match.language, result.vttText);
                }
            })['catch'](function () { /* silent failure on auto-load */ });
        });
    }

    function openActionSheet(opts) {
        opts = opts || {};
        var layer = $('#modalLayer');
        if (!layer) return;
        /* Rebuild the modal layer from scratch, same
         * pattern as openModal. Previously openActionSheet looked up
         * #modalTitle / #modalBody / .modal-actions via querySelector
         * — but a prior openModal() call would have wiped those out
         * (via layer.innerHTML = '') and rebuilt with its own
         * structure. After that, openActionSheet would early-return
         * silently because actions was null. Symptom: clicking a
         * playlist card after any other modal interaction did nothing.
         * Fix: build our own DOM here too, identical layout to openModal. */
        try { Focus.popScope(); } catch (e) {}
        layer.innerHTML = '';
        var card = document.createElement('div'); card.className = 'modal-card action-sheet-card';
        var titleEl = document.createElement('div'); titleEl.id = 'modalTitle'; titleEl.className = 'modal-title';
        var bodyEl = document.createElement('div'); bodyEl.id = 'modalBody'; bodyEl.className = 'modal-body-text';
        var actions = document.createElement('div'); actions.className = 'modal-actions action-sheet-actions';
        card.appendChild(titleEl);
        card.appendChild(bodyEl);
        card.appendChild(actions);
        layer.appendChild(card);

        titleEl.textContent = opts.title || '';
        bodyEl.textContent = opts.body || '';

        var items = opts.items || [];
        for (var i = 0; i < items.length; i++) {
            (function (it, idx) {
                var btn = el('button', {
                    'class': 'btn focusable' + (it.style === 'danger' ? ' danger' : ''),
                    'text': it.label || ('Option ' + (idx + 1)),
                    'tabindex': '-1',
                    'data-focus-key': 'action-' + idx
                });
                btn.addEventListener('click', function () {
                    closeModal();
                    if (it.onClick) it.onClick();
                });
                actions.appendChild(btn);
            })(items[i], i);
        }
        // Always add a Cancel if not suppressed
        if (opts.cancel !== false) {
            var cancelBtn = el('button', {
                'class': 'btn focusable',
                'text': opts.cancelText || T('cancel'),
                'tabindex': '-1',
                'data-focus-key': 'action-cancel'
            });
            cancelBtn.addEventListener('click', function () { closeModal(); });
            actions.appendChild(cancelBtn);
        }
        layer.classList.remove('hidden');
        Focus.pushScope(layer);
    }

    /* ===== Modal ===== */
    function openModal(opts) {
        opts = opts || {};
        window._modalOnCancel = null; // Clear any stale onCancel from previous modal
        var curFocus = Focus.current();
        if (curFocus) {
            window._lastModalOpenerEl = curFocus;
            var fk = curFocus.getAttribute('data-focus-key');
            if (fk) window._lastModalOpenerKey = fk;
        }
        var layer = $('#modalLayer');
        if (!layer) return;

        // ALWAYS rebuild the modal DOM from scratch on
        // every open. Previously we only rebuilt if the standard
        // titleEl/bodyEl/actionsEl were missing — which left stale DOM
        // around when a different modal builder (e.g. buildLoginModal,
        // showLoginPrompt) had taken over the layer with its own
        // structure. Symptom: after pressing back from the sign-in
        // modal, opening Manage Playlists would briefly flash the old
        // sign-in form before settling. Rebuilding unconditionally
        // makes openModal a single source of truth for the standard
        // title/body/actions layout. Also clears any in-flight focus
        // scope from the previous modal's own scope handling.
        try { Focus.popScope(); } catch (e) {}
        layer.innerHTML = '';
        var card = document.createElement('div'); card.className = 'modal-card' + (opts.cardClass ? ' ' + opts.cardClass : '');
        var titleEl = document.createElement('div'); titleEl.id = 'modalTitle'; titleEl.className = 'modal-title';
        var bodyEl = document.createElement('div'); bodyEl.id = 'modalBody'; bodyEl.className = 'modal-body-text';
        var actionsEl = document.createElement('div'); actionsEl.className = 'modal-actions';
        card.appendChild(titleEl);
        card.appendChild(bodyEl);
        card.appendChild(actionsEl);
        layer.appendChild(card);

        if (titleEl) titleEl.textContent = opts.title || 'Confirm';
        if (bodyEl) {
            if (opts.bodyEl && opts.bodyEl.nodeType) {
                Util.empty(bodyEl);
                bodyEl.appendChild(opts.bodyEl);
            } else {
                bodyEl.textContent = opts.body || '';
            }
        }

        Util.empty(actionsEl);
        try { actionsEl.style.display = 'flex'; } catch (e) {}

        if (opts.okText !== false) {
            var okBtn = el('button', {
                'class': 'btn focusable',
                'text': opts.okText || 'OK',
                'tabindex': '-1',
                'id': 'modalOk',
                'data-focus-key': 'modal-ok'
            });
            okBtn.addEventListener('click', function () {
                closeModal();
                if (opts.onOk) opts.onOk();
            });
            actionsEl.appendChild(okBtn);
        }

        if (opts.cancelText !== false) {
            var cancelBtn = el('button', {
                'class': opts.cancelClass || 'btn focusable',
                'text': opts.cancelText || T('cancel'),
                'tabindex': '-1',
                'id': 'modalCancel',
                'data-focus-key': 'modal-cancel'
            });
            cancelBtn.addEventListener('click', function () {
                if (opts.onCancel) opts.onCancel();
                closeModal();
            });
            actionsEl.appendChild(cancelBtn);
        }

        layer.classList.remove('hidden');
        Focus.pushScope(layer);
    }
    function closeModal() {
        var layer = $('#modalLayer');
        if (!layer) return;
        layer.classList.add('hidden');
        try { Focus.popScope(); } catch (e) {}
        suspendedModalFocusKey = null;
        var onCancel = window._modalOnCancel;
        window._modalOnCancel = null;
        if (onCancel) try { onCancel(); } catch (e) {}
        // After the close animation has a chance to
        // complete, empty the layer's DOM so any stale form / input /
        // listener from the closed modal can't leak into the next open
        // — a sign-in form could briefly reappear in a
        // later modal. openModal also rebuilds, but clearing on close
        // makes the visible state consistent before any next open.
        setTimeout(function () {
            // Only clear if the layer is still hidden (i.e. nothing
            // re-opened in the meantime).
            if (layer.classList.contains('hidden')) {
                try { layer.innerHTML = ''; } catch (e) {}
            }
        }, 200);
        setTimeout(function () {
            // If something reopened a modal within this window, the layer is no
            // longer hidden — abort the restore so we don't steal focus from the
            // freshly opened modal (caused a 'press OK twice' on quick reopen).
            if (!layer.classList.contains('hidden')) return;
            var openerEl = window._lastModalOpenerEl;
            var openerKey = window._lastModalOpenerKey;
            window._lastModalOpenerEl = null;
            window._lastModalOpenerKey = null;

            if (window._lastSeriesFocusKey) {
                Focus.focusKey(window._lastSeriesFocusKey);
                window._lastSeriesFocusKey = null;
                return;
            }
            if (openerEl && document.body.contains(openerEl) && Focus.isVisible(openerEl)) {
                Focus.focus(openerEl);
                return;
            }
            if (openerKey) {
                Focus.focusKey(openerKey);
                return;
            }
            var section = document.querySelector('.content-section.active');
            if (section) Focus.focusFirstIn(section);
        }, 150);
    }

    /* ===== Toast ===== */
    var toastTimer = null;
    var toastSticky = false;
    function toastDone() {
        var t = $('#toast');
        toastSticky = false;
        if (!t) return;
        t.className = 'toast hidden';
        t.style.display = '';
        t.style.transform = '';
        t.style.willChange = '';
    }
    /* opts.sticky: a progress toast that stays up until another toast replaces it or toastHide() is called
     * (long guide / catalogue loads, so it does not look stalled). Safety: it hides itself 30 s after
     * the last update, so a load that dies without a final toast cannot leave it up for ever; the
     * caller refreshes it while work is going on. */
    function toast(msg, type, opts) {
        var t = $('#toast');
        if (!t) return;
        t.textContent = msg || '';
        // Force GPU compositing layer to punch through video plane
        t.style.display = 'block';
        t.style.zIndex = '99999';
        t.style.transform = 'translateX(-50%) translateY(0) translateZ(0)';
        t.style.willChange = 'opacity, transform';
        toastSticky = !!(opts && opts.sticky);
        t.className = 'toast show' + (type ? ' ' + type : '') + (toastSticky ? ' busy' : '');
        // Force reflow so TV browser paints immediately
        void t.offsetHeight;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(toastDone, toastSticky ? 30000 : 3000);
    }
    /* Hides a sticky toast only; a normal toast (for example "loaded") that replaced it is left alone. */
    function toastHide() {
        if (!toastSticky) return;
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        toastDone();
    }

    /* ===== Virtual on-screen keyboard ===== */
    var vkTarget = null;
    var vkReturnFocus = null;
    var vkIsCaps = false;
    var vkCapsLock = false;
    var vkLastCapsTap = 0;
    var vkSymMode = false;
    var vkShowPassword = false;
    // Cursor position within vkTarget's value. Updated by
    // LEFT/RIGHT keys; insert + delete operations happen at this position
    // rather than always at end of string. Saves the user retyping from
    // the omitted-letter point to fix a typo.
    var vkCursorPos = 0;

    var VK_LAYOUT_ALPHA = [
        ['1','2','3','4','5','6','7','8','9','0','BACK'],
        ['q','w','e','r','t','y','u','i','o','p','CLEAR'],
        ['a','s','d','f','g','h','j','k','l','@','PREV'],
        ['z','x','c','v','b','n','m','.','-','_', 'NEXT'],
        // LEFT/RIGHT inserted around SPACE for cursor movement
        ['CAPS','SYM','LEFT','SPACE','RIGHT','DONE']
    ];

    var VK_LAYOUT_SYM = [
        ['!','@','#','$','%','^','&','*','(',')', 'BACK'],
        ['+','=','\\','|','[',']','{','}','<','>', 'CLEAR'],
        [';',':','\'','"',',','.','/','?','~','`', 'PREV'],
        ['http://','https://','www.','.com','.net','.org','.tv','.m3u', 'NEXT'],
        ['CAPS','ABC','LEFT','SPACE','RIGHT','DONE']
    ];

    /* Touch layouts: the right-hand column is split into two half-width icon keys
     * (Copy|Paste, Del|Clear, Prev|Next) and Done becomes one double-height key
     * spanning the two rows below, so there are no gaps. SPACER keeps the bottom row
     * the same width as the rest (Done overhangs into it). TVs keep the layouts above. */
    var VK_LAYOUT_ALPHA_T = [
        ['1','2','3','4','5','6','7','8','9','0','COPY','PASTE'],
        ['q','w','e','r','t','y','u','i','o','p','BACK','CLEAR'],
        ['a','s','d','f','g','h','j','k','l','@','PREV','NEXT'],
        ['z','x','c','v','b','n','m','.','-','_','DONE'],
        ['CAPS','SYM','LEFT','SPACE','RIGHT','SPACER']
    ];
    var VK_LAYOUT_SYM_T = [
        ['!','@','#','$','%','^','&','*','(',')','COPY','PASTE'],
        ['+','=','\\','|','[',']','{','}','<','>','BACK','CLEAR'],
        [';',':','\'','"',',','.','/','?','~','`','PREV','NEXT'],
        ['http://','https://','www.','.com','.net','.org','.tv','.m3u','DONE'],
        ['CAPS','ABC','LEFT','SPACE','RIGHT','SPACER']
    ];
    var VK_ICON_SVG = {
        COPY:  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
        PASTE: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h6"/>',
        BACK:  '<path d="M21 5H9l-6 7 6 7h12z"/><path d="M13 9.5l5 5M18 9.5l-5 5"/>',
        CLEAR: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
        PREV:  '<path d="M12 19V5M5 12l7-7 7 7"/>',
        NEXT:  '<path d="M12 5v14M5 12l7 7 7-7"/>',
        DONE:  '<path d="M4 12.5l5 5L20 6.5"/>'
    };
    function vkIconLabel(ch) {
        switch (ch) {
            case 'COPY':  return T('vk_copy');
            case 'PASTE': return T('vk_paste');
            case 'BACK':  return T('vk_del');
            case 'CLEAR': return T('vk_clear');
            case 'PREV':  return T('vk_prev');
            case 'NEXT':  return T('vk_next');
            case 'DONE':  return T('vk_done');
        }
        return '';
    }

    /* Function, not a constant object: this module loads before the language is
     * resolved, so a literal map would bake in English. Looked up per render
     * instead. The glyphs (arrows, check, A-up, #+=) are language-neutral and stay
     * as-is; only the words are translated. ABC stays ABC — it names the Latin
     * letter layout, which is what that key switches to regardless of UI language. */
    function vkLabel(ch) {
        switch (ch) {
            case 'BACK':  return '\u2190 ' + T('vk_del');
            case 'CLEAR': return T('vk_clear');
            case 'CAPS':  return 'A\u2191';
            case 'SPACE': return T('vk_space');
            case 'PREV':  return '\u2191 ' + T('vk_prev');
            case 'NEXT':  return '\u2193 ' + T('vk_next');
            case 'DONE':  return T('vk_done');   // the tick is drawn, see below
            case 'SYM':   return '#+=';
            case 'ABC':   return 'ABC';
            case 'LEFT':  return '\u25C0';
            case 'RIGHT': return '\u25B6';
        }
        return null;
    }

    function buildVKeyboard() {
        var vk = $('#vkeyboard');
        if (!vk) return;
        Util.empty(vk);

        // Preview bar: shows current field label and value
        var preview = el('div', { 'class': 'vk-preview', 'id': 'vkPreview' });
        var contentWrap = el('div', { 'class': 'vk-preview-content' });
        var previewLabel = el('div', { 'class': 'vk-preview-label', 'id': 'vkPreviewLabel', 'text': '' });
        var previewValue = el('div', { 'id': 'vkPreviewValue', 'text': '' });
        // Click-to-position the caret (LG Magic Remote pointer).
        //
        // The value is rendered as [span:before][span.vk-caret][span:after], with
        // no per-character elements, so we cannot simply listen on a character.
        // Instead hit-test the click x against the text: walk the character
        // offsets and pick the one whose boundary is nearest the pointer, using a
        // Range's client rect to measure. Range measurement is used rather than
        // canvas measureText because it accounts for the element's real font,
        // letter-spacing and any wrapping without having to reconstruct the font
        // string — and it is reliable on the Chromium 79 baseline.
        //
        // Password fields render a masked value, but the mask is 1:1 with the raw
        // characters, so an offset found against the masked text indexes the raw
        // value at the same position. No special-casing needed.
        previewValue.addEventListener('click', function (e) {
            try {
                var pos = vkOffsetFromPoint(previewValue, e.clientX);
                if (pos === null) return;
                vkCursorPos = pos;
                vkClampCursor();
                updateVkPreview();
            } catch (eC) {}
        });
        contentWrap.appendChild(previewLabel);
        contentWrap.appendChild(previewValue);
        preview.appendChild(contentWrap);
        if (vkTarget && vkTarget._isPassword) {
            var toggleBtn = document.createElement('button');
            toggleBtn.className = 'vk-toggle-pass focusable';
            toggleBtn.id = 'vkTogglePass';
            toggleBtn.setAttribute('tabindex', '-1');
            toggleBtn.setAttribute('data-focus-key', 'vk-toggle-pass');
            var eyeOpen = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            var eyeClosed = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
            toggleBtn.innerHTML = vkShowPassword ? eyeClosed : eyeOpen;
            toggleBtn.addEventListener('click', function () {
                vkShowPassword = !vkShowPassword;
                toggleBtn.innerHTML = vkShowPassword ? eyeClosed : eyeOpen;
                updateVkPreview();
            });
            preview.appendChild(toggleBtn);
        }
        vk.appendChild(preview);
        updateVkPreview();

        var vkTouch = vkClipboardKeysWanted();
        var layout = vkTouch ? (vkSymMode ? VK_LAYOUT_SYM_T : VK_LAYOUT_ALPHA_T)
                             : (vkSymMode ? VK_LAYOUT_SYM : VK_LAYOUT_ALPHA);
        for (var r = 0; r < layout.length; r++) {
            var row = el('div', { 'class': 'vk-row' });
            for (var c = 0; c < layout[r].length; c++) {
                (function (ch) {
                    if (ch === 'SPACER') { row.appendChild(el('div', { 'class': 'vk-spacer' })); return; }
                    var iconKey = vkTouch && VK_ICON_SVG[ch];
                    var cls = 'vk-key focusable';
                    /* CAPS, SYM, LEFT, RIGHT are now
                     * the same 68px width as normal letter keys per
                     * user request. Only the top-row trailing keys
                     * (BACK / CLEAR / PREV / NEXT / ABC) and DONE
                     * stay .wide. SPACE alone is .xwide. */
                    var isWideAction = (ch === 'BACK' || ch === 'CLEAR' ||
                                        ch === 'PREV' || ch === 'NEXT' ||
                                        ch === 'DONE');
                    if (iconKey) cls += (ch === 'DONE') ? ' vk-done-tall' : ' vk-icon';
                    else if (ch === 'SPACE') cls += ' xwide';
                    else if (isWideAction) cls += ' wide';
                    // Protocol keys are longer than a normal key ("https://" is 8
                    // chars); give them a wider fixed width so the label fits.
                    else if (ch.indexOf('://') !== -1) cls += ' urlkey';
                    var label = vkLabel(ch) || (vkIsCaps && ch.length === 1 ? ch.toUpperCase() : ch);
                    if (ch === 'CAPS' && vkCapsLock) label = 'A⇧ LOCK';
                    var key = el('div', {
                        'class': cls,
                        'tabindex': '-1',
                        'text': label,
                        'data-focus-key': 'vk-' + ch
                    });
                    if (iconKey) {
                        // Static markup only (no user text). Label is for screen readers.
                        key.textContent = '';
                        key.setAttribute('aria-label', vkIconLabel(ch));
                        key.insertAdjacentHTML('afterbegin',
                            '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
                            'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + VK_ICON_SVG[ch] + '</svg>');
                    } else if (ch === 'DONE') {
                        // The check mark is drawn as an SVG, not the U+2713 glyph: that
                        // glyph is missing from the UI font, so each device substitutes
                        // a symbol font and it came out much larger than the arrows on
                        // the Del / Prev / Next keys. A drawn tick is the same size
                        // everywhere. Static markup only (no user text).
                        key.insertAdjacentHTML('afterbegin',
                            '<svg class="vk-tick" viewBox="0 0 16 16" aria-hidden="true">' +
                            '<path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" ' +
                            'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
                    }
                    key.addEventListener('click', function () { handleVKey(ch); });
                    row.appendChild(key);
                })(layout[r][c]);
            }
            vk.appendChild(row);
        }
    }

    function updateVkPreview() {
        var label = $('#vkPreviewLabel');
        var value = $('#vkPreviewValue');
        if (!label || !value || !vkTarget) return;
        // data-vk-label: title the keyboard with the field's own label (placeholders can be identical or just an example).
        var own = '';
        if (vkTarget.hasAttribute('data-vk-label')) {
            var lb = vkTarget.previousElementSibling;
            if (lb && lb.tagName === 'LABEL') own = String(lb.textContent || '').replace(/^\s+|\s+$/g, '');
        }
        var fieldName = own || vkTarget.getAttribute('placeholder') ||
                        vkTarget.getAttribute('aria-label') ||
                        vkTarget.getAttribute('name') || 'Field';
        label.textContent = fieldName.toUpperCase();
        // Build the preview as three spans: before cursor,
        // the cursor itself (blinking |), and after cursor. For passwords
        // the visible chars are bullets unless the eye toggle is on.
        var raw = vkGetRawValue();
        var displayVal;
        if (vkTarget._isPassword && !vkShowPassword) {
            displayVal = '';
            for (var mi = 0; mi < raw.length; mi++) displayVal += '\u2022';
        } else {
            displayVal = raw;
        }
        vkClampCursor();
        // Clear value el and rebuild — avoids stale "(empty)" text + cursor markup.
        Util.empty(value);
        if (!raw.length) {
            // Empty field: still show cursor at position 0 + placeholder hint.
            var caretEmpty = el('span', { 'class': 'vk-caret' });
            value.appendChild(caretEmpty);
            var hint = el('span', { 'class': 'vk-empty-hint', 'text': T('empty') });
            value.appendChild(hint);
        } else {
            var before = displayVal.slice(0, vkCursorPos);
            var after = displayVal.slice(vkCursorPos);
            if (before) value.appendChild(el('span', { 'text': before }));
            value.appendChild(el('span', { 'class': 'vk-caret' }));
            if (after) value.appendChild(el('span', { 'text': after }));
        }
    }

    // Helpers that abstract away the password vs plain
    // distinction so cursor logic doesn't need to fork on every op.
    // For password fields the "value" is in vkTarget._realValue and the
    // visible vkTarget.value holds the masked form (rebuilt via _maskFn).
    /* Map a pointer x-coordinate to a character offset within the preview value.
     *
     * Used by the click-to-position-caret handler (LG Magic Remote). The value is
     * rendered as up to three spans — [before][caret][after] — so there are no
     * per-character elements to hit-test against directly. Instead we walk the
     * concatenated text and measure each character boundary with a Range, picking
     * the boundary nearest the pointer.
     *
     * Measuring via Range (rather than a canvas measureText) means we inherit the
     * element's real font, weight and letter-spacing without reconstructing a font
     * string, and it works on the Chromium 79 baseline.
     *
     * The caret span itself is zero-width (border-left only), so it does not skew
     * the measurement. Returns null when there is no text to position within.
     */
    function vkOffsetFromPoint(valueEl, clientX) {
        if (!valueEl) return null;
        // Gather the text nodes in document order, skipping the caret (which has
        // no text) and the "(empty)" hint span.
        var nodes = [];
        var total = 0;
        var kids = valueEl.childNodes;
        for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid.nodeType !== 1) continue;
            if (kid.className && String(kid.className).indexOf('vk-caret') !== -1) continue;
            if (kid.className && String(kid.className).indexOf('vk-empty-hint') !== -1) continue;
            var tn = kid.firstChild;
            if (tn && tn.nodeType === 3 && tn.nodeValue.length) {
                nodes.push(tn);
                total += tn.nodeValue.length;
            }
        }
        if (!total) return 0;   // empty field: caret goes to position 0

        // Walk every character boundary (0..total) and keep the closest one.
        var best = 0;
        var bestDist = Infinity;
        var offset = 0;
        var range = document.createRange();
        for (var n = 0; n < nodes.length; n++) {
            var node = nodes[n];
            var len = node.nodeValue.length;
            for (var c = 0; c <= len; c++) {
                range.setStart(node, c);
                range.setEnd(node, c);
                var rect = range.getBoundingClientRect();
                // A collapsed range can report a zero rect in some engines; skip
                // those rather than treating x=0 as a real boundary.
                if (!rect || (rect.left === 0 && rect.right === 0 && rect.top === 0)) continue;
                var d = Math.abs(rect.left - clientX);
                if (d < bestDist) {
                    bestDist = d;
                    best = offset + c;
                }
            }
            offset += len;
        }
        return best;
    }

    function vkGetRawValue() {
        if (!vkTarget) return '';
        if (vkTarget._isPassword) return vkTarget._realValue || '';
        return vkTarget.value || '';
    }
    function vkSetRawValue(v) {
        if (!vkTarget) return;
        if (vkTarget._isPassword) {
            vkTarget._realValue = v;
            if (vkTarget._maskFn) vkTarget._maskFn();
        } else {
            vkTarget.value = v;
        }
    }
    function vkClampCursor() {
        var len = vkGetRawValue().length;
        if (vkCursorPos < 0) vkCursorPos = 0;
        if (vkCursorPos > len) vkCursorPos = len;
    }

    function handleVKey(ch) {
        if (!vkTarget) return;
        if (ch === 'CAPS') {
            var nowMs = new Date().getTime();
            if (nowMs - vkLastCapsTap < 650) {
                vkCapsLock = !vkCapsLock;
                vkIsCaps = vkCapsLock;
            } else {
                vkCapsLock = false;
                vkIsCaps = !vkIsCaps;
            }
            vkLastCapsTap = nowMs;
            buildVKeyboard();
            setTimeout(function () { if (window.Focus && Focus.focusKey) Focus.focusKey('vk-CAPS'); }, 50);
            return;
        }
        if (ch === 'SYM') {
            vkSymMode = true;
            buildVKeyboard();
            setTimeout(function () { var vk = $('#vkeyboard'); if (vk) Focus.focusFirstIn(vk); }, 50);
            return;
        }
        if (ch === 'ABC') {
            vkSymMode = false;
            buildVKeyboard();
            setTimeout(function () { var vk = $('#vkeyboard'); if (vk) Focus.focusFirstIn(vk); }, 50);
            return;
        }
        // Cursor movement keys. Cursor is rendered in
        // the preview value as a blinking | between chars. Updates the
        // preview without modifying the underlying value.
        if (ch === 'LEFT') {
            vkClampCursor();
            if (vkCursorPos > 0) vkCursorPos--;
            updateVkPreview();
            return;
        }
        if (ch === 'RIGHT') {
            vkClampCursor();
            if (vkCursorPos < vkGetRawValue().length) vkCursorPos++;
            updateVkPreview();
            return;
        }
        if (ch === 'BACK') {
            // Backspace at cursor position (deletes the
            // char immediately BEFORE the cursor), not always at end.
            vkClampCursor();
            if (vkCursorPos === 0) return;
            var raw = vkGetRawValue();
            vkSetRawValue(raw.slice(0, vkCursorPos - 1) + raw.slice(vkCursorPos));
            vkCursorPos--;
            fireInput(vkTarget); updateVkPreview(); return;
        }
        if (ch === 'CLEAR') {
            vkSetRawValue('');
            vkCursorPos = 0;
            fireInput(vkTarget); updateVkPreview(); return;
        }
        if (ch === 'SPACE') {
            vkInsertAtCursor(' ');
            fireInput(vkTarget); updateVkPreview(); return;
        }
        if (ch === 'DONE') { closeVKeyboard(); return; }
        if (ch === 'PASTE') { vkPaste(); return; }
        if (ch === 'COPY') { vkCopy(); return; }
        if (ch === 'NEXT' || ch === 'PREV') {
            navigateField(ch === 'NEXT' ? 1 : -1);
            return;
        }
        var add = vkIsCaps && ch.length === 1 ? ch.toUpperCase() : ch;
        vkInsertAtCursor(add);
        if (vkIsCaps && !vkCapsLock && ch.length === 1) {
            vkIsCaps = false;
            buildVKeyboard();
            setTimeout(function () { if (window.Focus && Focus.focusKey) Focus.focusKey('vk-' + ch); }, 20);
        }
        fireInput(vkTarget);
        updateVkPreview();
    }

    // Insert string at cursor position and advance cursor
    // by the inserted length. Handles password fields transparently.
    /* Clipboard keys. Android WebView often refuses navigator.clipboard, so the
     * native bridge is tried first and the web API / execCommand are fallbacks. */
    function vkClipboardKeysWanted() {
        try { return !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (e) { return false; }
    }
    function vkClipText(done) {
        var b = window.AndroidBridge;
        if (b && typeof b.getClipboardText === 'function') {
            try { done(String(b.getClipboardText() || '')); return; } catch (e) {}
        }
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(function (t) { done(t || ''); }, function () { done(null); });
            return;
        }
        done(null);
    }
    function vkPaste() {
        vkClipText(function (t) {
            if (!vkTarget) return;
            if (t === null) { toast(T('vk_clip_fail'), 'err'); return; }
            // One-line fields: drop line breaks and tabs, trim the ends (a
            // stray space or newline is the usual reason a pasted login fails).
            t = t.replace(/[\r\n\t]+/g, ' ').replace(/^\s+|\s+$/g, '');
            if (!t) { toast(T('vk_clip_empty'), 'err'); return; }
            var max = parseInt(vkTarget.getAttribute('maxlength'), 10);
            if (max > 0) {
                var room = max - vkGetRawValue().length;
                if (room <= 0) return;
                t = t.slice(0, room);
            }
            vkInsertAtCursor(t);
            fireInput(vkTarget); updateVkPreview();
        });
    }
    /* ---- Long-press a text field (touch only): small Paste / Copy / Clear menu, like a native field ----
     * Works on the field itself without opening the keyboard. The click that follows the long press is
     * swallowed so the keyboard does not open underneath. Not used with a remote (Mobile.isTouch() false). */
    function fldGet(i) { return i._isPassword ? (i._realValue || '') : (i.value || ''); }
    function fldSet(i, v) {
        if (i._isPassword) { i._realValue = v; if (i._maskFn) i._maskFn(); } else { i.value = v; }
        fireInput(i);
    }
    var fieldMenuEl = null, fieldMenuTimer = null, fieldMenuAuto = null, fieldMenuSwallowUntil = 0;
    function closeFieldMenu() {
        if (fieldMenuAuto) { clearTimeout(fieldMenuAuto); fieldMenuAuto = null; }
        if (fieldMenuEl && fieldMenuEl.parentNode) fieldMenuEl.parentNode.removeChild(fieldMenuEl);
        fieldMenuEl = null;
    }
    function fieldMenuPaste(input) {
        vkClipText(function (t) {
            if (t === null) { toast(T('vk_clip_fail'), 'err'); return; }
            t = t.replace(/[\r\n\t]+/g, ' ').replace(/^\s+|\s+$/g, '');
            if (!t) { toast(T('vk_clip_empty'), 'err'); return; }
            var cur = fldGet(input), max = parseInt(input.getAttribute('maxlength'), 10);
            if (max > 0) { t = t.slice(0, Math.max(0, max - cur.length)); if (!t) return; }
            fldSet(input, cur + t);
        });
    }
    function fieldMenuCopy(input) {
        var text = fldGet(input);
        if (!text) return;
        var prev = vkTarget; vkTarget = input;       // vkCopy works on the keyboard's target
        try { vkCopy(); } finally { vkTarget = prev; }
    }
    function openFieldMenu(input, kbMode) {
        closeFieldMenu();
        var hasText = !!fldGet(input);
        var anchor = input;
        if (kbMode) { var pv = document.getElementById('vkPreview'); if (pv) anchor = pv; }
        var m = document.createElement('div');
        m.className = 'field-menu';
        function add(label, fn) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'field-menu-btn'; b.textContent = label;
            b.setAttribute('tabindex', '-1');
            b.addEventListener('touchstart', function (e) { e.stopPropagation(); }, true);
            b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeFieldMenu(); fn(input); });
            m.appendChild(b);
        }
        // From the keyboard's own text bar the keyboard is the editor: use its paste / copy / clear so the caret and preview follow.
        add(T('vk_paste'), kbMode ? function () { vkPaste(); } : fieldMenuPaste);
        if (hasText) {
            add(T('vk_copy'), kbMode ? function () { vkCopy(); } : fieldMenuCopy);
            add(T('vk_clear'), kbMode ? function () { vkSetRawValue(''); vkCursorPos = 0; fireInput(vkTarget); updateVkPreview(); } : function (i) { fldSet(i, ''); });
        }
        document.body.appendChild(m);
        var r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
        var top = r.top - mh - 8; if (top < 8) top = r.bottom + 8;
        var left = r.left + 12; if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8; if (left < 8) left = 8;
        m.style.top = top + 'px'; m.style.left = left + 'px';
        fieldMenuEl = m;
        fieldMenuAuto = setTimeout(closeFieldMenu, 8000);
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (eV) {}
    }
    function installFieldMenu() {
        var sx = 0, sy = 0;
        // The keyboard's text bar counts as the field it is editing (touch: long press there = same menu).
        function inBar(t) { return !!(t && t.closest && t.closest('#vkPreview') && !t.closest('.vk-toggle-pass') && vkTarget); }
        function fieldOf(t) {
            if (inBar(t)) return vkTarget;
            return (t && t.closest) ? t.closest('input.field, textarea.field') : null;
        }
        function fire(f, bar) {
            if (fieldMenuTimer) { clearTimeout(fieldMenuTimer); fieldMenuTimer = null; }
            if (fieldMenuEl) return;
            fieldMenuSwallowUntil = Date.now() + 1500;
            openFieldMenu(f, bar);
        }
        document.addEventListener('touchstart', function (e) {
            if (fieldMenuEl && !(e.target.closest && e.target.closest('.field-menu'))) closeFieldMenu();
            if (!vkClipboardKeysWanted() || (e.touches && e.touches.length !== 1)) return;
            var f = fieldOf(e.target);
            if (!f || f.disabled || f.type === 'checkbox' || f.type === 'radio' || f.type === 'file') return;
            if (fieldMenuTimer) clearTimeout(fieldMenuTimer);
            sx = e.touches[0].screenX; sy = e.touches[0].screenY;
            // Shorter than Android's own ~500 ms long-press, which cancels the touch.
            var bar = inBar(e.target);
            fieldMenuTimer = setTimeout(function () { fire(f, bar); }, 380);
        }, true);
        function cancel() { if (fieldMenuTimer) { clearTimeout(fieldMenuTimer); fieldMenuTimer = null; } }
        document.addEventListener('touchmove', function (e) {
            if (!fieldMenuTimer || !e.touches || !e.touches.length) return;
            // Slop in device pixels (screenX/Y), so a scaled page does not make it tiny.
            var d = 24 * (window.devicePixelRatio || 1);
            if (Math.abs(e.touches[0].screenX - sx) > d || Math.abs(e.touches[0].screenY - sy) > d) cancel();
        }, true);
        document.addEventListener('touchend', cancel, true);
        // touchcancel is NOT a cancel: the browser sends it when its own long-press kicks in.
        document.addEventListener('scroll', function () { cancel(); closeFieldMenu(); }, true);
        // the click after a long press must not open the keyboard
        document.addEventListener('click', function (e) {
            if (Date.now() < fieldMenuSwallowUntil && fieldOf(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); fieldMenuSwallowUntil = 0; }
        }, true);
        // Extra trigger: if the browser's long-press arrives first, use it.
        document.addEventListener('contextmenu', function (e) {
            var f = fieldOf(e.target);
            if (!f || !vkClipboardKeysWanted()) return;
            e.preventDefault();
            if (!fieldMenuEl) fire(f, inBar(e.target));
        }, true);
    }
    installFieldMenu();

    function vkCopy() {
        if (!vkTarget) return;
        var isPw = !!vkTarget._isPassword;
        var text = vkGetRawValue();
        if (!text) return;
        var okCopy = false;
        var b = window.AndroidBridge;
        if (b && typeof b.setClipboardText === 'function') {
            try { b.setClipboardText(text, isPw); okCopy = true; } catch (e) {}
        }
        if (!okCopy && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            okCopy = true;
        }
        if (!okCopy) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                okCopy = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (e2) {}
        }
        toast(T(okCopy ? (isPw ? 'vk_copied_password' : 'vk_copied') : 'vk_clip_fail'), okCopy ? 'ok' : 'err');
    }

    function vkInsertAtCursor(s) {
        vkClampCursor();
        var raw = vkGetRawValue();
        vkSetRawValue(raw.slice(0, vkCursorPos) + s + raw.slice(vkCursorPos));
        vkCursorPos += s.length;
    }

    function navigateField(delta) {
        if (!vkTarget) return;
        /* Only fields that share the target's own container take part: the open modal, else the
         * section/screen the field lives in. Never the whole app (a Search-screen keyboard used to
         * step into unrelated hidden screens' fields). */
        var scope = null, modal = document.getElementById('modalLayer');
        if (modal && !modal.classList.contains('hidden') && modal.contains(vkTarget)) scope = modal;
        if (!scope && vkTarget.closest) scope = vkTarget.closest('.content-section') || vkTarget.closest('.screen');
        if (!scope) return;
        var inputs = [], all = scope.querySelectorAll('input.field, textarea.field');
        for (var i = 0; i < all.length; i++) {
            var f = all[i], vis = (f.offsetWidth || f.offsetHeight), p = f;
            while (vis && p && p !== scope) {
                if (p.classList && (p.classList.contains('hidden') || (p.classList.contains('tab-panel') && !p.classList.contains('active')))) { vis = false; break; }
                p = p.parentNode;
            }
            if (vis || f === vkTarget) inputs.push(f);
        }
        var curIdx = -1;
        for (var j = 0; j < inputs.length; j++) {
            if (inputs[j] === vkTarget) { curIdx = j; break; }
        }
        if (curIdx < 0 || inputs.length < 2) return;      // nothing else on this screen to step to
        var nextIdx = curIdx + delta;
        if (nextIdx < 0) nextIdx = inputs.length - 1;
        if (nextIdx >= inputs.length) nextIdx = 0;
        vkTarget = inputs[nextIdx];
        Focus.focus(vkTarget);
        setTimeout(function () { openVKeyboard(vkTarget); }, 50);
    }
    function fireInput(input) {
        try {
            var ev = document.createEvent('Event');
            ev.initEvent('input', true, true);
            input.dispatchEvent(ev);
        } catch (e) {}
    }

    function openVKeyboard(targetInput, returnFocusEl) {
        UI.vkOpenedAt = Date.now();
        vkTarget = targetInput || null;
        // Where focus goes when the keyboard closes. Defaults to the target input,
        // but callers whose input is not focusable-visible (e.g. the card-view
        // search field, which is display:none — search is launched from the action
        // bar button) pass a visible element to avoid losing focus on Back.
        vkReturnFocus = returnFocusEl || null;
        vkShowPassword = false;
        // Cursor starts at end of current value. If the
        // underlying input has its own selection (e.g. user tapped mid-
        // string in a browser that respects selectionStart on readonly),
        // try to honour that; otherwise fall back to end-of-string.
        vkCursorPos = 0;
        if (vkTarget) {
            try {
                var sel = vkTarget.selectionStart;
                if (typeof sel === 'number' && sel >= 0) vkCursorPos = sel;
                else vkCursorPos = vkGetRawValue().length;
            } catch (e) { vkCursorPos = vkGetRawValue().length; }
        }
        var vk = $('#vkeyboard');
        if (!vk) return;
        buildVKeyboard();
        vk.classList.remove('hidden');
        // Make the keyboard the active focus scope. Without this, when the
        // keyboard is opened over a modal (e.g. the EPG sources field), the
        // modal's scope stays active and focusKey('vk-q') — which searches the
        // active scope — can't find the keys (they live outside the modal
        // layer), so focus stays stuck on the input. closeVKeyboard pops it.
        if (Focus.pushScope) Focus.pushScope(vk);
        // pushScope focuses the first focusable (the '1' key); move straight to
        // 'q' here so the user never sees focus land on '1' first.
        if (Focus.focusKey) Focus.focusKey('vk-q');
        // Scroll the target input into the visible area above the keyboard
        if (vkTarget) {
            setTimeout(function () {
                try {
                    var inputRect = vkTarget.getBoundingClientRect();
                    var vkRect = vk.getBoundingClientRect();
                    // If the input is below the keyboard top, scroll it up
                    if (inputRect.bottom > vkRect.top - 20) {
                        var scrollParent = vkTarget.closest('.modal-wrap') || vkTarget.closest('.screen');
                        if (scrollParent) {
                            var offset = inputRect.bottom - (vkRect.top - 40);
                            scrollParent.scrollTop += offset;
                        }
                    }
                } catch (e) {}
            }, 50);
        }
    }
    function closeVKeyboard() {
        var vk = $('#vkeyboard');
        if (!vk) return;
        vk.classList.add('hidden');
        // Pop the keyboard scope pushed in openVKeyboard so the scope beneath
        // (e.g. the modal that owns the input) becomes active again before we
        // restore focus to the target field.
        if (Focus.popScope) Focus.popScope();
        // Restore focus: prefer the caller's visible return element (the target
        // input may be hidden, e.g. card-view search), else the target itself.
        var restore = vkReturnFocus || vkTarget;
        if (restore && (!Focus.isVisible || Focus.isVisible(restore))) {
            try { Focus.focus(restore); } catch (e) {}
        } else if (vkTarget) {
            try { Focus.focus(vkTarget); } catch (e) {}
        }
        vkTarget = null;
        vkReturnFocus = null;
    }

    /* Close the keyboard because the user is LEAVING the screen/section it belongs
     * to (sidebar tap, opening a result, switching screens). Unlike closeVKeyboard()
     * this does not hand focus back to the search field: the destination owns focus,
     * and returning it to the field of the section being left would pull the user
     * back or strand focus on a hidden input. The keyboard is global (outside every
     * screen), so nothing else would ever hide it. Returns true if one was open. */
    function dismissVKeyboard() {
        var vk = $('#vkeyboard');
        if (!vk || vk.classList.contains('hidden')) return false;
        vk.classList.add('hidden');
        if (Focus.popScope) Focus.popScope();
        vkTarget = null;
        vkReturnFocus = null;
        return true;
    }

    var suspendedModalFocusKey = null;

    function suspendModalForPlayback(focusKeyToRestore) {
        var layer = $('#modalLayer');
        if (layer) layer.classList.add('hidden');
        suspendedModalFocusKey = focusKeyToRestore;
    }

    function restoreSuspendedModal() {
        if (!suspendedModalFocusKey) return false;
        var layer = $('#modalLayer');
        // Only restore if the layer still has modal content. closeModal()
        // clears innerHTML (after its close timeout) and resets the
        // suspended key; if the modal was genuinely closed there is
        // nothing to restore, and re-showing an empty/stale layer is the
        // bug where a closed Subtitles modal reappeared on player OK.
        if (layer && layer.children && layer.children.length > 0) {
            layer.classList.remove('hidden');
            Focus.pushScope(layer);
            var keyToFocus = suspendedModalFocusKey;
            suspendedModalFocusKey = null;
            setTimeout(function () { Focus.focusKey(keyToFocus); }, 150);
            return true;
        }
        // Nothing to restore — clear stale state so it can't fire later.
        suspendedModalFocusKey = null;
        return false;
    }

    UI.openListPicker = openListPicker;
    UI.openSubtitlePicker = openSubtitlePicker;
    UI.autoLoadSubtitlesForItem = autoLoadSubtitlesForItem;
    UI.openActionSheet = openActionSheet;
    UI.openModal = openModal;
    UI.closeModal = closeModal;
    UI.toast = toast;
    UI.toastHide = toastHide;
    UI.toastIsSticky = function () { return toastSticky; };
    UI.openVKeyboard = openVKeyboard;
    UI.closeVKeyboard = closeVKeyboard;
    UI.dismissVKeyboard = dismissVKeyboard;
    UI.suspendModalForPlayback = suspendModalForPlayback;
    UI.restoreSuspendedModal = restoreSuspendedModal;
})();
