/* app-parental.js - Parental lock cluster (key derivation, item/category lock checks, player access gate, parental-controls UI, category & content-lock managers). Augments window.Parental. ES5 only. */
var Parental = (function () {
    'use strict';

    function getItemLockKey(item) {
        if (!item) return '';
        var plId = item.playlistId || Store.getActivePlaylistId();
        var type = item.type || 'live';
        if (type === 'movie' || type === 'vod') type = 'movies';
        if (type === 'series') type = 'series';
        if (type !== 'movies' && type !== 'series') type = 'live';
        return plId + ':' + type + ':' + (item.category || '');
    }

    function getItemContentLockKey(item) {
        var plId, type, id;
        if (!item) return '';
        plId = item.playlistId || Store.getActivePlaylistId();
        type = item.type || 'live';
        if (type === 'movie' || type === 'vod') type = 'movies';
        if (type === 'series') type = 'series';
        if (type !== 'movies' && type !== 'series') type = 'live';
        id = item.seriesId || item.parentSeriesId || item.stream_id || item.series_id || item.id || item.url || item.name || '';
        if (!id) return '';
        return plId + ':' + type + ':item:' + id;
    }

    function isContentItemLocked(item) {
        var locks = Store.raw.get('parentalItemLocks', {}) || {};
        var key = getItemContentLockKey(item);
        return !!(key && locks[key]);
    }

    function isItemLocked(item) {
        var locks = Store.raw.get('parentalLocks', {}) || {};
        var key = getItemLockKey(item);
        return !!(key && locks[key]) || isContentItemLocked(item);
    }

    function getCategoryLockKey(sectionName, catName) {
        var type = sectionName === 'movies' ? 'movies' : sectionName === 'series' ? 'series' : 'live';
        var plId = Store.getActivePlaylistId();
        if (!catName || catName === '__all__') return '';
        return plId + ':' + type + ':' + catName;
    }

    function isCategoryLocked(sectionName, catName) {
        var locks = Store.raw.get('parentalLocks', {}) || {};
        var key = getCategoryLockKey(sectionName, catName);
        return !!(key && locks[key]);
    }

    function wrapPlayerAccessGate() {
        if (!window.Player || !Player.play || Player._parentalWrapped) return;
        var originalPlay = Player.play;
        Player.play = function (item) {
            if (window.Access && isItemLocked(item) && !Access.isUnlocked()) {
                Access.requirePin(T('pc_unlock_content'), function (ok) {
                    if (ok) originalPlay.call(Player, item);
                });
                return;
            }
            var r = originalPlay.call(Player, item);
            // Explicitly (re)apply the saved video scale
            // when playback starts. Relying only on the loadedmetadata/
            // playing listeners left the video in its raw (filled) state
            // on this WebOS engine until the user manually re-picked a
            // mode (the video started filled and only corrected after a
            // manual selection). Stagger a few retries because videoWidth
            // isn't known immediately on HLS/TS start.
            try {
                var st = Store.getSettings ? Store.getSettings() : null;
                var sc = (st && st.videoScale) ? st.videoScale : 'contain';
                App.applyVideoScale(sc);
                setTimeout(function () { App.applyVideoScale(sc); }, 400);
                setTimeout(function () { App.applyVideoScale(sc); }, 1200);
            } catch (e) {}
            return r;
        };
        Player._parentalWrapped = true;
    }

    function renderParentalControls() {
        var c = window.Access ? Access.cfg() : { enabled:false, startup:'off', protectActions:'on' };
        var status = document.getElementById('parentalStatus');
        if (status) status.textContent = c.enabled ? T('pc_on') : T('pc_off');
        var navIc = document.getElementById('parentalNavIcon');
        if (navIc) {
            // Inline-SVG approach. Was: navIc.src = …
            // Now: toggle .parental-on class which swaps the visible
            // child <svg> via CSS.
            if (c.enabled) navIc.className = (navIc.className || '').replace(/\s*parental-on/g, '') + ' parental-on';
            else navIc.className = (navIc.className || '').replace(/\s*parental-on/g, '');
        }
        var startup = document.getElementById('parentalStartup');
        if (startup) startup.value = c.startup || 'off';
        var actions = document.getElementById('parentalProtectActions');
        if (actions) actions.value = c.protectActions || 'on';
        var restrict = document.getElementById('parentalRestrictPlayback');
        // Migration: restrictPlayback was previously folded into protectActions,
        // so when it's unset, fall back to the old protectActions value — existing
        // users keep the playback behaviour they had until they change it.
        if (restrict) restrict.value = restrictPlaybackValue(c);

        // App Launch Lock, Restrict
        // Playback and Protected Actions have no effect at all while parental
        // controls are off — app.js's playback gate and every guardedParentalChange
        // consumer only act when Access.isEnabled() is true — but nothing on
        // screen said so. Grey all three out and explain why while off; the
        // control itself gets the native disabled attribute, which also
        // removes it from D-pad focus (focus.js isVisible()) and blocks touch.
        setPcLocked(startup, !c.enabled);
        setPcLocked(restrict, !c.enabled);
        setPcLocked(actions, !c.enabled);
    }

    function setPcLocked(selectEl, locked) {
        if (!selectEl) return;
        var row = selectEl.closest ? selectEl.closest('.setting-row') : null;
        if (!row) { for (var p = selectEl.parentNode; p; p = p.parentNode) { if (p.classList && p.classList.contains('setting-row')) { row = p; break; } } }
        selectEl.disabled = !!locked;
        if (row) row.classList[locked ? 'add' : 'remove']('pc-locked');
        var desc = row ? row.querySelector('.setting-desc') : null;
        if (!desc) return;
        var hint = desc.querySelector('.pc-lock-hint');
        if (locked) {
            if (!hint) {
                hint = document.createElement('div');
                hint.className = 'pc-lock-hint';
                desc.appendChild(hint);
            }
            hint.textContent = T('pc_locked_hint');
        } else if (hint) {
            hint.parentNode.removeChild(hint);
        }
    }

    /* Effective Restrict Playback value, defaulting to the legacy protectActions
     * value when the dedicated field hasn't been set yet. */
    function restrictPlaybackValue(c) {
        if (c.restrictPlayback === 'on' || c.restrictPlayback === 'off') return c.restrictPlayback;
        return (c.protectActions === 'off') ? 'off' : 'on';
    }

    function wireParentalControls() {
        var en = document.getElementById('parentalEnable');
        if (en) en.addEventListener('click', function () { Access.setPinFlow(); });
        var dis = document.getElementById('parentalDisable');
        if (dis) dis.addEventListener('click', function () {
            if (!Access.isEnabled()) { UI.toast(T('parental_controls_already_off'), 'ok'); return; }
            Access.requirePinStrict(T('pc_disable'), function (ok) {
                if (!ok) return;
                var c = Access.cfg(); c.enabled = false; c.pinHash = ''; c.pinSalt = ''; if (c.pin) delete c.pin; Access.save(c); Access.lock(); renderParentalControls(); if (UI.refreshLockIndicators) UI.refreshLockIndicators(); UI.toast(T('parental_controls_disabled'), 'ok');
            });
        });
        function guardedParentalChange(selectEl, applyFn) {
            if (!selectEl) return;
            selectEl._lastValue = selectEl.value;
            selectEl.addEventListener('focus', function () { selectEl._lastValue = selectEl.value; });
            selectEl.addEventListener('change', function () {
                var oldVal = selectEl._lastValue;
                var newVal = selectEl.value;
                if (Access.isEnabled()) {
                    // Revert the visible value until the PIN is confirmed, so an
                    // unauthorised change never appears applied.
                    selectEl.value = oldVal;
                    Access.requirePinStrict(T('pc_unlock_settings'), function (ok) {
                        if (!ok) return;
                        // PIN OK: restore the value the user picked, THEN apply.
                        // (Previously applyFn ran against the reverted old value,
                        // so the setting could never actually change.)
                        selectEl.value = newVal;
                        selectEl._lastValue = newVal;
                        applyFn();
                    });
                    return;
                }
                applyFn();
                selectEl._lastValue = selectEl.value;
            });
        }
        var startup = document.getElementById('parentalStartup');
        guardedParentalChange(startup, function () { var c = Access.cfg(); c.startup = startup.value; Access.save(c); renderParentalControls(); });
        var act = document.getElementById('parentalProtectActions');
        guardedParentalChange(act, function () { var c = Access.cfg(); c.protectActions = act.value; Access.save(c); renderParentalControls(); });
        var restrict = document.getElementById('parentalRestrictPlayback');
        guardedParentalChange(restrict, function () { var c = Access.cfg(); c.restrictPlayback = restrict.value; Access.save(c); renderParentalControls(); });
        renderParentalControls();
    }

    /* Two-line filter button label: "Filter:" on line 1, the current value on
     * line 2. Two lines so the button fits the 165px column at the 26px minimum
     * font while keeping the "Filter:" prefix. Built as nodes (not innerHTML) so a
     * translated string can't inject markup. */
    function setFilterLabel(btn, value) {
        while (btn.firstChild) btn.removeChild(btn.firstChild);
        var l1 = document.createElement('span');
        l1.className = 'lock-mgr-filter-l1';
        l1.textContent = (typeof T === 'function' ? T('filter') : 'Filter') + ':';
        var l2 = document.createElement('span');
        l2.className = 'lock-mgr-filter-l2';
        l2.textContent = value;
        btn.appendChild(l1);
        btn.appendChild(l2);
    }

    /* Column-header cell. Built as a node (not innerHTML) so the label is plain
     * text and cannot be affected by markup in a translated string. */
    function headCell(cls, text) {
        var sp = document.createElement('span');
        sp.className = cls;
        sp.textContent = text;
        return sp;
    }

    function openCategoryManager(sectionName) {
        var type = sectionName === 'movies' ? 'movies' : sectionName === 'series' ? 'series' : 'live';
        var plId = Store.getActivePlaylistId();
        var hidden = Store.getHiddenCategories(plId, type);
        var locks = Store.raw.get('parentalLocks', {}) || {};

        var catListId = sectionName === 'movies' ? 'movieCatList' : sectionName === 'series' ? 'seriesCatList' : 'liveCatList';
        var catListEl = document.getElementById(catListId);
        var allNames = [];
        // Card view has no DOM category column — the categories live in UI's
        // in-memory card state. Prefer that; fall back to the DOM column for list
        // view. Movies/series use getVodCardCategories; live uses getLiveCardCategories.
        var cardCats = null;
        if ((sectionName === 'movies' || sectionName === 'series') && UI.getVodCardCategories) {
            cardCats = UI.getVodCardCategories(sectionName);
        } else if (sectionName === 'livetv' && UI.getLiveCardCategories) {
            var liveSecM = document.querySelector('section[data-section-content="livetv"]');
            if (liveSecM && liveSecM.getAttribute('data-view-mode') === 'card') {
                cardCats = UI.getLiveCardCategories();
            }
        }
        if (cardCats && cardCats.length) {
            for (var ci = 0; ci < cardCats.length; ci++) {
                var ccn = cardCats[ci]._catName || cardCats[ci].name || '';
                if (ccn && ccn !== '__all__' && allNames.indexOf(ccn) < 0) allNames.push(ccn);
            }
        } else if (catListEl) {
            var items = catListEl.querySelectorAll('.panel-cat-item');
            for (var i = 0; i < items.length; i++) {
                var cn = items[i]._catName || items[i].getAttribute('data-cat') || '';
                if (cn && cn !== '__all__' && allNames.indexOf(cn) < 0) allNames.push(cn);
            }
        }
        for (var hk in hidden) { if (hidden.hasOwnProperty(hk) && allNames.indexOf(hk) < 0) allNames.push(hk); }
        for (var lk0 in locks) {
            if (locks.hasOwnProperty(lk0) && lk0.indexOf(plId + ':' + type + ':') === 0) {
                var lockName = lk0.substring((plId + ':' + type + ':').length);
                if (lockName && allNames.indexOf(lockName) < 0) allNames.push(lockName);
            }
        }
        function cleanseName(n) {
            var raw = String(n || '');
            // Movies and Series: drop the provider's "VOD |", "SER -", "SRS:" ... prefix
            // exactly as the category columns do, so a category reads the same here.
            // Display, search and default sort only; the raw name stays the key for
            // hidden/locked/order, so saved settings are unaffected.
            if ((type === 'movies' || type === 'series') && UI.vodCleanseCategoryName) {
                raw = UI.vodCleanseCategoryName(raw);
            }
            var s = Util.decodeHtmlEntities(raw.replace(/^\s+|^\|+|\s+$/g, ''));
            // Strip decorative/tofu glyphs (superscripts, symbol boxes) the same
            // way channel names are cleansed, so the lock-manager category list
            // matches the rest of the app instead of showing raw provider tags.
            return Util.cleanseDisplayName ? Util.cleanseDisplayName(s) : s;
        }
        // Default sort (Latin-first, case-insensitive) is
        // the baseline. We KEEP this as defaultOrder so Reset can
        // restore it. Then, if a user has previously saved a custom
        // order, we use that as the initial state instead.
        // Stalker: the portal's "All" leads the default order (same rule as the Live TV list in ui.js).
        var stalkerAll = (type === 'live' && UI.isStalkerMode && UI.isStalkerMode() && UI.getStalkerAllTitle)
            ? cleanseName(UI.getStalkerAllTitle()).toLowerCase() : '';
        function defaultSort(arr) {
            return arr.slice(0).sort(function (a, b) {
                var na = cleanseName(a).toLowerCase(), nb = cleanseName(b).toLowerCase();
                if (stalkerAll) {
                    var aIsAll = na === stalkerAll, bIsAll = nb === stalkerAll;
                    if (aIsAll !== bIsAll) return aIsAll ? -1 : 1;
                }
                var aL = /^[a-z0-9]/.test(na), bL = /^[a-z0-9]/.test(nb);
                if (aL && !bL) return -1; if (!aL && bL) return 1;
                return na < nb ? -1 : na > nb ? 1 : 0;
            });
        }
        // Movies / Series / Live TV: a Sort button replaces Reverse. It sets how the CATEGORIES are ordered and, for
        // dated Movies / Series (Xtream, Stalker), the items inside them (saved on Apply). Live and M3U offer
        // Alphabetically, Reverse and Provider order; channels inside a Live category keep the provider's order.
        var plObj = null;
        try { var plAll = Store.getPlaylists() || []; for (var pi = 0; pi < plAll.length; pi++) if (String(plAll[pi].id) === String(plId)) plObj = plAll[pi]; } catch (ePl) {}
        var hasSort = (type === 'movies' || type === 'series' || type === 'live') && !!Store.getItemSort;
        // Newest / Oldest need provider dates: only Movies and Series on Xtream and Stalker have them.
        var datedSort = (type === 'movies' || type === 'series') && !!plObj && (plObj.type === 'xtream' || plObj.type === 'stalker');
        var sortModes = datedSort ? ['az', 'za', 'provider', 'newest', 'oldest'] : ['az', 'za', 'provider'];
        var sortMode = hasSort ? Store.getItemSort(plId, type) : 'az';
        // The category order a sort mode gives: alphabetical, its reverse, or the provider's own order (Newest and
        // Oldest also keep the provider's category order: categories carry no date).
        function orderForMode(mode) {
            var az = defaultSort(allNames);
            if (mode === 'za') {
                // Reverse alphabetical; the Stalker portal's "All" still leads (same rule as the default order).
                var lead = (stalkerAll && az.length && cleanseName(az[0]).toLowerCase() === stalkerAll) ? az.slice(0, 1) : [];
                return lead.concat(az.slice(lead.length).reverse());
            }
            if (mode === 'provider' || mode === 'newest' || mode === 'oldest') {
                var pn = (UI.getProviderCategoryNames && UI.getProviderCategoryNames(type)) || [];
                var present = {}, seenN = {}, out = [], q;
                for (q = 0; q < allNames.length; q++) present[allNames[q]] = true;
                for (q = 0; q < pn.length; q++) if (present[pn[q]] && !seenN[pn[q]]) { seenN[pn[q]] = true; out.push(pn[q]); }
                for (q = 0; q < az.length; q++) if (!seenN[az[q]]) { seenN[az[q]] = true; out.push(az[q]); }
                return out;
            }
            return az;
        }
        var defaultOrder = hasSort ? orderForMode(sortMode) : defaultSort(allNames);
        // Current display order: starts as the saved custom order (if any)
        // or the default. Mutated by per-row reorder buttons + Reverse.
        var currentOrder = (Store.applyCustomCategoryOrder)
            ? Store.applyCustomCategoryOrder(plId, type, defaultOrder)
            : defaultOrder.slice(0);
        // Per-row state lives in this map (keyed by category name) so
        // re-rendering after reorder preserves the visible/locked toggles.
        var rowState = {};
        for (var sn = 0; sn < allNames.length; sn++) {
            var nm = allNames[sn];
            rowState[nm] = {
                checked: !hidden[nm],
                locked: !!locks[plId + ':' + type + ':' + nm]
            };
        }

        var wrap = document.createElement('div');
        wrap.className = 'cat-mgr-wrap lock-panel-wrap';
        var tools = document.createElement('div');
        tools.className = 'cat-mgr-tools lock-panel-tools';

        function makeBtn(key, text) {
            var b = document.createElement('button');
            b.className = 'btn focusable';
            b.setAttribute('tabindex', '-1');
            b.setAttribute('data-focus-key', key);
            b.textContent = text;
            return b;
        }
        var showAll = makeBtn('catmgr-showall', T('pc_show_all'));
        var hideAll = makeBtn('catmgr-hideall', T('pc_hide_all'));
        var lockAll = makeBtn('catmgr-lockall', T('pc_lock_all'));
        var unlockAll = makeBtn('catmgr-unlockall', T('pc_unlock_all'));
        // New global sort controls
        var resetBtn = makeBtn('catmgr-reset', T('pc_reset_order'));
        var reverseBtn = makeBtn('catmgr-reverse', T('pc_reverse'));
        var sortBtn = hasSort ? makeBtn('catmgr-sort', T('pc_sort')) : null;
        var applyBtn = makeBtn('catmgr-apply', T('apply'));
        var cancelBtn = makeBtn('catmgr-cancel', T('cancel'));
        function sortLabel(m) {
            return m === 'za' ? T('pc_sort_reverse') : m === 'provider' ? T('pc_sort_provider') : m === 'newest' ? T('pc_sort_newest') : m === 'oldest' ? T('pc_sort_oldest') : T('pc_sort_alpha');
        }
        if (sortBtn) {
            sortBtn.addEventListener('click', function () {
                var labels = [], cur = 0;
                for (var si2 = 0; si2 < sortModes.length; si2++) { labels.push(sortLabel(sortModes[si2])); if (sortModes[si2] === sortMode) cur = si2; }
                UI.openListPicker({ overlay: true,
                    title: T('pc_sort_title'),
                    items: labels,
                    selected: cur,
                    onSelect: function (idx) {
                        sortMode = sortModes[idx] || 'az';
                        // The categories re-order at once (a manual arrangement is replaced, as Reset Order does).
                        defaultOrder = orderForMode(sortMode);
                        currentOrder = defaultOrder.slice(0);
                        renderRows();
                        setTimeout(function () { Focus.focusKey('catmgr-sort'); }, 120);
                    }
                });
            });
        }
        tools.appendChild(showAll); tools.appendChild(hideAll); tools.appendChild(lockAll); tools.appendChild(unlockAll);
        if (sortBtn) { tools.appendChild(sortBtn); tools.appendChild(resetBtn); } else { tools.appendChild(resetBtn); tools.appendChild(reverseBtn); }
        tools.appendChild(applyBtn); tools.appendChild(cancelBtn);

        var header = document.createElement('div');
        header.className = 'cat-mgr-header lock-panel-header';
        // Added "Order" column header for the reorder
        // arrow buttons (⇈ ↑ ↓ ⇊). Width is reserved in CSS.
        header.appendChild(headCell('cat-mgr-name-head', T('pc_col_category')));
        header.appendChild(headCell('cat-mgr-col-head', T('pc_col_visible')));
        header.appendChild(headCell('cat-mgr-col-head', T('pc_col_locked')));
        header.appendChild(headCell('cat-mgr-col-head cat-mgr-order-head', T('pc_col_order')));

        // Search + filter bar, laid out to LINE UP with the columns above: the
        // search fills the Name column; the Visible filter sits under the Visible
        // column; the Locked filter under the Locked column; a spacer under Order.
        var filterBar = document.createElement('div');
        filterBar.className = 'lock-mgr-filterbar cat-mgr-filterbar';
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'lock-mgr-search cat-mgr-filter-name field focusable';
        searchInput.setAttribute('tabindex', '-1');
        searchInput.setAttribute('data-focus-key', 'catmgr-search');
        searchInput.setAttribute('placeholder', T('search_placeholder'));
        searchInput.setAttribute('readonly', 'readonly'); // block native TV keyboard
        searchInput.addEventListener('click', function () { if (UI.openVKeyboard) UI.openVKeyboard(searchInput); });
        var visFilterBtn = document.createElement('button');
        visFilterBtn.className = 'lock-mgr-filter-btn cat-mgr-filter-col btn focusable';
        visFilterBtn.setAttribute('tabindex', '-1');
        visFilterBtn.setAttribute('data-focus-key', 'catmgr-filter-visible');
        var lockFilterBtn = document.createElement('button');
        lockFilterBtn.className = 'lock-mgr-filter-btn cat-mgr-filter-col btn focusable';
        lockFilterBtn.setAttribute('tabindex', '-1');
        lockFilterBtn.setAttribute('data-focus-key', 'catmgr-filter-locked');
        var orderSpacer = document.createElement('div');
        orderSpacer.className = 'cat-mgr-filter-order-spacer';
        filterBar.appendChild(searchInput);
        filterBar.appendChild(visFilterBtn);
        filterBar.appendChild(lockFilterBtn);
        filterBar.appendChild(orderSpacer);

        var listCol = document.createElement('div');
        listCol.id = 'catMgrList';
        listCol.className = 'cat-mgr-list lock-panel-list';
        var rows = [];

        // Delegated row-focus highlighting. Previously every row attached its own
        // focus+blur listeners to all 6 of its buttons (~12 per row, ~4200 on a
        // 356-row provider) — a large chunk of the modal's synchronous open cost.
        // One delegated pair on the list container does the same job: on focusin,
        // find the button's row and light it (clearing any other lit row); on
        // focusout, clear it only if focus didn't move to another button in the
        // SAME row. focusin/focusout bubble (unlike focus/blur), so delegation
        // works and relatedTarget tells us where focus is going.
        function rowOf(el) {
            while (el && el !== listCol) {
                if (el.className && (' ' + el.className + ' ').indexOf(' cat-mgr-row ') > -1) return el;
                el = el.parentNode;
            }
            return null;
        }
        listCol.addEventListener('focusin', function (e) {
            var row = rowOf(e.target);
            if (!row) return;
            var lit = listCol.querySelectorAll('.row-focused');
            for (var li = 0; li < lit.length; li++) {
                if (lit[li] !== row) lit[li].classList.remove('row-focused');
            }
            row.classList.add('row-focused');
        });
        listCol.addEventListener('focusout', function (e) {
            var row = rowOf(e.target);
            if (!row) return;
            // If focus is moving to another control within the same row, keep the
            // highlight; otherwise clear it.
            var to = e.relatedTarget;
            if (to && rowOf(to) === row) return;
            row.classList.remove('row-focused');
        });

        function updateToggle(btn, on, rowClass, row) {
            btn.textContent = on ? '\u2713' : '';
            if (on) btn.classList.add('on'); else btn.classList.remove('on');
            if (row) { if (on) row.classList.add(rowClass); else row.classList.remove(rowClass); }
        }

        // Row reorder helpers. Reordering is for the whole list only: while a search or
        // filter is on the order buttons are disabled (see buildRow), so these never run
        // on a filtered view. The category name being moved is found by its position in
        // currentOrder, so the same name stays in focus after the re-render.
        function moveRel(name, dir) {
            if (isFiltered()) return;
            var idx = currentOrder.indexOf(name);
            if (idx < 0) return;
            var last = currentOrder.length - 1;
            if ((dir === 'top' || dir === 'up') && idx === 0) return;
            if ((dir === 'down' || dir === 'bottom') && idx === last) return;
            currentOrder.splice(idx, 1);
            if (dir === 'top') currentOrder.unshift(name);
            else if (dir === 'up') currentOrder.splice(idx - 1, 0, name);
            else if (dir === 'down') currentOrder.splice(idx + 1, 0, name);
            else currentOrder.push(name);
            renderRows(name);
        }
        function moveToTop(name) { moveRel(name, 'top'); }
        function moveUp(name) { moveRel(name, 'up'); }
        function moveDown(name) { moveRel(name, 'down'); }
        function moveToBottom(name) { moveRel(name, 'bottom'); }

        // Reorder-button chevron SVGs. Built ONCE here rather than re-declared
        // inside the per-row loop — with a few hundred categories the old
        // per-row rebuild created these four strings hundreds of times on every
        // render, which added to open time.
        //
        // The unicode double-arrows (U+21C8/U+21CA) don't render on WebOS 6.5
        // (blank/tofu), so we use inline SVG <polyline> chevrons instead:
        // currentColor so the focused-state colour applies; explicit points so
        // there's nothing to mis-render on Chromium 79.
        var SVG_OPEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
        var CHEV_UP_SINGLE   = SVG_OPEN + '<polyline points="6 15 12 9 18 15"></polyline></svg>';
        var CHEV_DOWN_SINGLE = SVG_OPEN + '<polyline points="6 9 12 15 18 9"></polyline></svg>';
        var CHEV_UP_DOUBLE   = SVG_OPEN + '<polyline points="6 12 12 6 18 12"></polyline><polyline points="6 18 12 12 18 18"></polyline></svg>';
        var CHEV_DOWN_DOUBLE = SVG_OPEN + '<polyline points="6 6 12 12 18 6"></polyline><polyline points="6 12 12 18 18 12"></polyline></svg>';

        // Build all DOM rows from currentOrder. If focusName is given,
        // focus its first reorder button after rendering (so keyboard
        // users can keep hammering up/down without re-finding the row).
        // Build a single category row element. Shared by the synchronous
        // renderRows (used on reorder, where an immediate full rebuild is fine
        // because it touches focus retention right away) and the chunked initial
        // fill (renderRowsChunked), which spreads the build across frames so the
        // modal can paint immediately instead of waiting for all ~356 rows.
        // ---- Search / filter state + view derivation (category manager) ----
        var PAGE_SIZE = 50;
        var pageStart = 0;
        var searchText = '';
        var visFilter = 'all';  // 'all' | 'shown' | 'hidden'
        var lockFilter = 'all'; // 'all' | 'locked' | 'unlocked'

        function isFiltered() {
            return !!(searchText.trim()) || visFilter !== 'all' || lockFilter !== 'all';
        }
        function viewOrder() {
            var q = searchText.trim().toLowerCase();
            var out = [];
            for (var i = 0; i < currentOrder.length; i++) {
                var nm = currentOrder[i];
                var st = rowState[nm] || { checked: true, locked: false };
                if (visFilter === 'shown' && !st.checked) continue;
                if (visFilter === 'hidden' && st.checked) continue;
                if (lockFilter === 'locked' && !st.locked) continue;
                if (lockFilter === 'unlocked' && st.locked) continue;
                if (q && cleanseName(nm).toLowerCase().indexOf(q) === -1) continue;
                out.push(nm);
            }
            return out;
        }
        function visFilterLabel() {
            if (visFilter === 'shown') return T('pc_filter_shown');
            if (visFilter === 'hidden') return T('pc_filter_hidden');
            return T('pc_filter_all');
        }
        function lockFilterLabel() {
            if (lockFilter === 'locked') return T('pc_filter_locked');
            if (lockFilter === 'unlocked') return T('pc_filter_unlocked');
            return T('pc_filter_all');
        }

        searchInput.addEventListener('input', function () {
            searchText = searchInput.value || '';
            pageStart = 0;
            renderRows();
        });
        visFilterBtn.addEventListener('click', function () {
            var vals = ['all', 'shown', 'hidden'];
            var cur = vals.indexOf(visFilter); if (cur < 0) cur = 0;
            UI.openListPicker({ overlay: true,
                title: T('pc_col_visible'),
                items: [T('pc_filter_all'), T('pc_filter_shown'), T('pc_filter_hidden')],
                selected: cur,
                onSelect: function (idx) { visFilter = vals[idx]; pageStart = 0; renderRows(); setTimeout(function () { Focus.focusKey('catmgr-filter-visible'); }, 120); }
            });
        });
        lockFilterBtn.addEventListener('click', function () {
            var vals = ['all', 'locked', 'unlocked'];
            var cur = vals.indexOf(lockFilter); if (cur < 0) cur = 0;
            UI.openListPicker({ overlay: true,
                title: T('pc_col_locked'),
                items: [T('pc_filter_all'), T('pc_filter_locked'), T('pc_filter_unlocked')],
                selected: cur,
                onSelect: function (idx) { lockFilter = vals[idx]; pageStart = 0; renderRows(); setTimeout(function () { Focus.focusKey('catmgr-filter-locked'); }, 120); }
            });
        });

        function buildRow(name, idx, total) {
            var st = rowState[name] || { checked: true, locked: false };
            var row = document.createElement('div');
            row.className = 'cat-mgr-row';
            var nameEl = document.createElement('span');
            nameEl.className = 'cat-mgr-name';
            var nameText = document.createElement('span');
            nameText.className = 'cat-mgr-name-text';
            nameText.textContent = cleanseName(name);
            nameEl.appendChild(nameText);
            var vis = document.createElement('button');
            vis.className = 'mgr-check cat-mgr-visible-check focusable';
            vis.setAttribute('tabindex','-1');
            vis.setAttribute('data-focus-key','catmgr-vis-' + idx);
            var lock = document.createElement('button');
            lock.className = 'mgr-check cat-mgr-lock-check focusable';
            lock.setAttribute('tabindex','-1');
            lock.setAttribute('data-focus-key','catmgr-lock-' + idx);

            var orderBox = document.createElement('span');
            orderBox.className = 'cat-mgr-order-box';
            /* Order buttons are always rendered so the ORDER column stays populated (greyed while filtered). */
            var topBtn = document.createElement('button');
            topBtn.className = 'cat-mgr-order-btn focusable';
            topBtn.setAttribute('tabindex','-1');
            topBtn.setAttribute('data-focus-key','catmgr-top-' + idx);
            topBtn.innerHTML = CHEV_UP_DOUBLE;
            topBtn.title = T('pc_move_top');
            var upBtn = document.createElement('button');
            upBtn.className = 'cat-mgr-order-btn focusable';
            upBtn.setAttribute('tabindex','-1');
            upBtn.setAttribute('data-focus-key','catmgr-up-' + idx);
            upBtn.innerHTML = CHEV_UP_SINGLE;
            upBtn.title = T('pc_move_up');
            var downBtn = document.createElement('button');
            downBtn.className = 'cat-mgr-order-btn focusable';
            downBtn.setAttribute('tabindex','-1');
            downBtn.setAttribute('data-focus-key','catmgr-down-' + idx);
            downBtn.innerHTML = CHEV_DOWN_SINGLE;
            downBtn.title = T('pc_move_down');
            var botBtn = document.createElement('button');
            botBtn.className = 'cat-mgr-order-btn focusable';
            botBtn.setAttribute('tabindex','-1');
            botBtn.setAttribute('data-focus-key','catmgr-bot-' + idx);
            botBtn.innerHTML = CHEV_DOWN_DOUBLE;
            botBtn.title = T('pc_move_bottom');
            if (isFiltered()) {
                /* Reordering a filtered subset is not offered: the column stays under its
                 * header but greyed. Clear the search / filters to reorder. */
                topBtn.disabled = true; upBtn.disabled = true; downBtn.disabled = true; botBtn.disabled = true;
                topBtn.classList.add('disabled'); upBtn.classList.add('disabled');
                downBtn.classList.add('disabled'); botBtn.classList.add('disabled');
            } else {
            // idx / total are positions in the list; disable the buttons that cannot move
            // any further (feedback that the row is at an end).
            if (idx === 0) { topBtn.disabled = true; upBtn.disabled = true; topBtn.classList.add('disabled'); upBtn.classList.add('disabled'); }
            if (idx === total - 1) { downBtn.disabled = true; botBtn.disabled = true; downBtn.classList.add('disabled'); botBtn.classList.add('disabled'); }
            }
            orderBox.appendChild(topBtn); orderBox.appendChild(upBtn);
            orderBox.appendChild(downBtn); orderBox.appendChild(botBtn);

            row.appendChild(nameEl); row.appendChild(vis); row.appendChild(lock); row.appendChild(orderBox);
            row._catName = name; row._visBtn = vis; row._lockBtn = lock;
            updateToggle(vis, st.checked, 'checked', row);
            updateToggle(lock, st.locked, 'locked', row);
            // Row-focus highlighting is handled by the delegated focusin/focusout
            // listeners on listCol (see above), not by per-button listeners.
            vis.addEventListener('click', function () {
                st.checked = !st.checked;
                updateToggle(vis, st.checked, 'checked', row);
            });
            lock.addEventListener('click', function () {
                st.locked = !st.locked;
                updateToggle(lock, st.locked, 'locked', row);
            });
            topBtn.addEventListener('click', function () { moveToTop(name); });
            upBtn.addEventListener('click', function () { moveUp(name); });
            downBtn.addEventListener('click', function () { moveDown(name); });
            botBtn.addEventListener('click', function () { moveToBottom(name); });
            return row;
        }

        function restoreFocusToMovedRow(focusName) {
            if (!focusName) return;
            var newIdx = viewOrder().indexOf(focusName);
            if (newIdx < 0) return;
            // The moved item may now be on a different page (move-to-top/bottom):
            // switch to its page and rebuild before focusing. The index is the
            // position in the visible list, which is what the row keys use.
            var wantPage = Math.floor(newIdx / PAGE_SIZE) * PAGE_SIZE;
            if (wantPage !== pageStart) {
                pageStart = wantPage;
                renderRows(); // rebuild on the correct page (no focusName -> no recursion)
            }
            setTimeout(function () {
                var pageIdx = newIdx; // buildRow keys use the position in the visible list
                var keys = ['catmgr-up-' + pageIdx, 'catmgr-down-' + pageIdx, 'catmgr-top-' + pageIdx, 'catmgr-bot-' + pageIdx];
                for (var k = 0; k < keys.length; k++) {
                    var b = document.querySelector('[data-focus-key="' + keys[k] + '"]');
                    if (b && !b.disabled) { Focus.focusKey(keys[k]); return; }
                }
            }, 30);
        }

        // ---- A-Z jump strip (shown when the visible list needs more than one page) ----
        // One button per leading letter that has items; selecting it opens the page
        // holding that letter's first category and focuses that row, so a category
        // can be found by letter and then reordered from there.
        var alphaStrip = document.createElement('div');
        alphaStrip.className = 'cat-mgr-alpha';
        var ALPHA_ORDER = ['#num', 'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z', '#'];
        function buildAlphaStrip(view) {
            Util.empty(alphaStrip);
            if (view.length <= PAGE_SIZE || !UI.alphaBucket) { alphaStrip.style.display = 'none'; return; }
            alphaStrip.style.display = '';
            var first = {};
            for (var i = 0; i < view.length; i++) {
                var bk = UI.alphaBucket(cleanseName(view[i]));
                if (first[bk] === undefined) first[bk] = i;
            }
            var made = [];
            for (var k = 0; k < ALPHA_ORDER.length; k++) {
                (function (bucket) {
                    if (first[bucket] === undefined) return;
                    var b = Util.el('div', { 'class': 'cat-mgr-alpha-btn focusable', 'tabindex': '-1',
                        'data-focus-key': 'catmgr-alpha-' + bucket,
                        'text': bucket === '#num' ? '0-9' : bucket });
                    b.addEventListener('click', function () {
                        var vi = first[bucket];
                        pageStart = Math.floor(vi / PAGE_SIZE) * PAGE_SIZE;
                        renderRows();
                        setTimeout(function () { Focus.focusKey('catmgr-vis-' + vi); }, 30);
                    });
                    alphaStrip.appendChild(b);
                    made.push(b);
                })(ALPHA_ORDER[k]);
            }
            // D-pad: Left/Right walk the letters (dead end at both ends so focus cannot leak
            // into the toolbar), Down enters the first row of the page.
            for (var m = 0; m < made.length; m++) {
                made[m].setAttribute('data-focus-left', m > 0 ? made[m - 1].getAttribute('data-focus-key') : '__none__');
                made[m].setAttribute('data-focus-right', m < made.length - 1 ? made[m + 1].getAttribute('data-focus-key') : '__none__');
                made[m].setAttribute('data-focus-down', 'catmgr-vis-' + pageStart);
            }
        }

        // Synchronous full rebuild — used by reorder and the bulk toggles, where
        // the row set is already on screen and an immediate rebuild + focus
        // retention is what the user expects.
        function renderRows(focusName) {
            if (!document.getElementById('catMgrList')) return;
            setFilterLabel(visFilterBtn, visFilterLabel());
            setFilterLabel(lockFilterBtn, lockFilterLabel());
            var view = viewOrder();
            if (pageStart >= view.length) pageStart = Math.max(0, (Math.ceil(view.length / PAGE_SIZE) - 1) * PAGE_SIZE);
            buildAlphaStrip(view);
            Util.empty(listCol);
            rows = [];
            if (!view.length) {
                listCol.appendChild(Util.el('div', { 'class': 'search-empty', 'text': T('no_visible_items_to_manage_select') }));
                return;
            }
            if (pageStart > 0) {
                var prev = Util.el('div', { 'class': 'lock-mgr-page-btn focusable', 'tabindex': '-1', 'data-focus-key': 'catmgr-prevpage',
                    'text': (T('previous')) + ' ' + Math.min(PAGE_SIZE, pageStart) + ' ' + (T('items')) });
                prev.addEventListener('click', function () { pageStart = Math.max(0, pageStart - PAGE_SIZE); renderRows(); setTimeout(function () { Focus.focusKey('catmgr-vis-' + pageStart); }, 60); });
                listCol.appendChild(prev);
            }
            var end = Math.min(pageStart + PAGE_SIZE, view.length);
            var frag = document.createDocumentFragment();
            for (var ci = pageStart; ci < end; ci++) {
                // idx = position in the visible list (view); unfiltered that is the position in
                // the whole list, so reorder keys and first/last disabling line up.
                var row = buildRow(view[ci], ci, view.length);
                rows.push(row); frag.appendChild(row);
            }
            listCol.appendChild(frag);
            if (end < view.length) {
                var remaining = view.length - end;
                var next = Util.el('div', { 'class': 'lock-mgr-page-btn focusable', 'tabindex': '-1', 'data-focus-key': 'catmgr-nextpage',
                    'text': (T('next')) + ' ' + Math.min(PAGE_SIZE, remaining) + ' ' + (T('items')) + ' (' + remaining + ' ' + (T('remaining')) + ')' });
                next.addEventListener('click', function () { pageStart = end; renderRows(); setTimeout(function () { Focus.focusKey('catmgr-vis-' + pageStart); }, 60); });
                listCol.appendChild(next);
            }
            linkRowsToStrip();
            if (focusName) restoreFocusToMovedRow(focusName);
        }

        // Up from the top of the list must reach the A-Z strip (the default spatial move
        // skips past it to the search field). Each control in the first row (or the
        // "previous page" button when there is one) links up to the letter nearest in
        // x, measured after layout.
        function linkRowsToStrip() {
            var btns = alphaStrip.querySelectorAll('.cat-mgr-alpha-btn');
            var fbs = filterBar.querySelectorAll('.focusable');
            var fi;
            if (!btns.length || alphaStrip.style.display === 'none') {
                for (fi = 0; fi < fbs.length; fi++) fbs[fi].removeAttribute('data-focus-down');
                return;
            }
            setTimeout(function () {
                // Down from the search / filter row lands on the nearest letter.
                var fc = [];
                for (var bj = 0; bj < btns.length; bj++) { var fr = btns[bj].getBoundingClientRect(); fc.push(fr.left + fr.width / 2); }
                for (fi = 0; fi < fbs.length; fi++) {
                    var fr2 = fbs[fi].getBoundingClientRect(), fx = fr2.left + fr2.width / 2, fb = 0, fd = 1e9;
                    for (var fj = 0; fj < fc.length; fj++) { var dd = Math.abs(fc[fj] - fx); if (dd < fd) { fd = dd; fb = fj; } }
                    fbs[fi].setAttribute('data-focus-down', btns[fb].getAttribute('data-focus-key'));
                }
                var top = listCol.querySelector('.lock-mgr-page-btn') || listCol.querySelector('.cat-mgr-row');
                if (!top || top.getAttribute('data-focus-key') === 'catmgr-nextpage') top = listCol.querySelector('.cat-mgr-row');
                if (!top) return;
                var prevPage = listCol.firstChild && listCol.firstChild.getAttribute &&
                    listCol.firstChild.getAttribute('data-focus-key') === 'catmgr-prevpage' ? listCol.firstChild : null;
                var src = prevPage ? [prevPage] : top.querySelectorAll('.focusable');
                var centers = [];
                for (var b = 0; b < btns.length; b++) {
                    var br = btns[b].getBoundingClientRect();
                    centers.push(br.left + br.width / 2);
                }
                for (var i = 0; i < src.length; i++) {
                    var sr = src[i].getBoundingClientRect(), cx = sr.left + sr.width / 2, best = 0, bd = 1e9;
                    for (var c = 0; c < centers.length; c++) {
                        var d = Math.abs(centers[c] - cx);
                        if (d < bd) { bd = d; best = c; }
                    }
                    src[i].setAttribute('data-focus-up', btns[best].getAttribute('data-focus-key'));
                }
            }, 0);
        }

        // With pagination only one 50-row page is built at open, so the old
        // across-frames chunking is unnecessary — render page 1 directly. Kept as
        // a named function so the existing open path / onDone contract is intact.
        function renderRowsChunked(onDone) {
            pageStart = 0;
            renderRows();
            if (onDone) onDone();
        }

        showAll.addEventListener('click', function () {
            for (var n in rowState) if (rowState.hasOwnProperty(n)) rowState[n].checked = true;
            renderRowsChunked();
        });
        hideAll.addEventListener('click', function () {
            for (var n in rowState) if (rowState.hasOwnProperty(n)) rowState[n].checked = false;
            renderRowsChunked();
        });
        lockAll.addEventListener('click', function () {
            for (var n in rowState) if (rowState.hasOwnProperty(n)) rowState[n].locked = true;
            renderRowsChunked();
        });
        unlockAll.addEventListener('click', function () {
            for (var n in rowState) if (rowState.hasOwnProperty(n)) rowState[n].locked = false;
            renderRowsChunked();
        });
        // Reset puts categories back into the default
        // Latin-first sort. The Apply handler will save this (or rather,
        // it'll detect that currentOrder matches defaultOrder and clear
        // the saved custom order entirely).
        resetBtn.addEventListener('click', function () {
            currentOrder = defaultOrder.slice(0);
            renderRows();
            UI.toast(T('order_reset_to_default'), null);
        });
        // Reverse flips the current display order.
        // Composes with whatever the user has done — if they've already
        // moved rows around, those positions stay relative to each
        // other, just reversed.
        reverseBtn.addEventListener('click', function () {
            currentOrder.reverse();
            renderRows();
        });
        applyBtn.addEventListener('click', function () {
            // Detect whether the pending changes would ADD or REMOVE any
            // category lock, compared with the state when the modal opened.
            // Visibility and ordering are never gated — only lock changes.
            var addsLock = false, removesLock = false;
            for (var dn in rowState) {
                if (!rowState.hasOwnProperty(dn)) continue;
                var dk = plId + ':' + type + ':' + dn;
                var wasLocked = !!locks[dk];
                var nowLocked = !!rowState[dn].locked;
                if (nowLocked && !wasLocked) addsLock = true;
                if (!nowLocked && wasLocked) removesLock = true;
            }

            function commit() {
                // Save hidden/lock state for every row that still exists.
                var saveLocks = Store.raw.get('parentalLocks', {}) || {};
                for (var n in rowState) {
                    if (!rowState.hasOwnProperty(n)) continue;
                    Store.setHiddenCategory(plId, type, n, !rowState[n].checked);
                    var lk = plId + ':' + type + ':' + n;
                    if (rowState[n].locked) saveLocks[lk] = true; else delete saveLocks[lk];
                }
                Store.raw.set('parentalLocks', saveLocks);
                // Save (or clear) custom order. If the user
                // ended up exactly at the default order — e.g. opened the
                // modal, did nothing, pressed Apply — we DON'T want to
                // freeze the order, so we clear any saved order. This way a
                // future addition of a new category gets a normal Latin-
                // first slot rather than being shoved to the end.
                if (Store.setCustomCategoryOrder) {
                    var isDefault = currentOrder.length === defaultOrder.length;
                    if (isDefault) {
                        for (var di = 0; di < currentOrder.length; di++) {
                            if (currentOrder[di] !== defaultOrder[di]) { isDefault = false; break; }
                        }
                    }
                    Store.setCustomCategoryOrder(plId, type, isDefault ? null : currentOrder);
                }
                if (hasSort && Store.getItemSort(plId, type) !== sortMode) {
                    Store.setItemSort(plId, type, sortMode);
                    if (UI.clearItemCaches) UI.clearItemCaches();   // lists already loaded keep the old order otherwise
                }
                if (window.Access && Access.lock) Access.lock();
                if (UI.refreshLockIndicators) UI.refreshLockIndicators();
                UI.closeModal(); UI.showSection(sectionName, true);
            }

            // Adding a lock with parental controls off: the lock is harmless
            // until controls are enabled, so SAVE it first (commit), then
            // prompt to enable. Saving first means the user's selections are
            // never lost — if they enable, the locks immediately take effect;
            // if they cancel the prompt, the locks persist (dormant) and show
            // as ticked next time, rather than silently vanishing.
            if (addsLock && window.Access && !Access.isEnabled()) {
                commit();
                UI.openModal({
                    title: T('pc_enable_title'),
                    body: T('pc_enable_body'),
                    okText: T('pc_enable'),
                    cancelText: T('pc_not_now'),
                    cancelClass: 'btn focusable',
                    onOk: function () { if (Access.setPinFlow) Access.setPinFlow(); }
                });
                // This modal opens from within the manager modal's own handler;
                // the scope hand-off can leave focus stranded on the old layer, so
                // explicitly move focus into the new modal's buttons.
                setTimeout(function () {
                    var ml = document.getElementById('modalLayer');
                    var okB = document.getElementById('modalOk');
                    if (okB) { try { Focus.focus(okB); return; } catch (e) {} }
                    if (ml) { try { Focus.focusFirstIn(ml); } catch (e2) {} }
                }, 60);
                return;
            }
            // Removing a lock while controls are on and locked requires the
            // PIN — otherwise anyone could open the manager and unlock.
            if (removesLock && window.Access && Access.isEnabled()) {
                Access.requirePinStrict(T('pc_unlock_remove_locks'), function (ok) {
                    if (!ok) return;
                    commit();
                });
                return;
            }
            commit();
        });
        cancelBtn.addEventListener('click', function () { UI.closeModal(); });

        wrap.appendChild(tools); wrap.appendChild(header); wrap.appendChild(filterBar); wrap.appendChild(alphaStrip); wrap.appendChild(listCol);
        UI.openModal({ title: T('pc_manage_categories'), bodyEl: wrap, cancelText: false });
        var modal = document.getElementById('modalLayer');
        if (modal) {
            var actions = modal.querySelector('.modal-actions');
            if (actions) actions.style.display = 'none';
            var card = modal.querySelector('.modal-card');
            if (card) card.classList.add('lock-mgr-modal-card');
        }
        Util.removeDefaultModalOk();
        // The modal shell (toolbar + column headers + empty list) is now on
        // screen; fill the rows in chunks so a large provider (~356 categories)
        // doesn't block the modal's first paint on the whole row build. Focus
        // goes to a toolbar button (always present, not row-dependent).
        renderRowsChunked();
        setTimeout(function () { Focus.focusKey('catmgr-showall'); }, 100);
    }

    function openContentLockManager(sectionName) {
        var type = sectionName === 'movies' ? 'movies' : sectionName === 'series' ? 'series' : 'live';
        var plId = Store.getActivePlaylistId();
        var locks = Store.raw.get('parentalItemLocks', {}) || {};
        var items = [];
        var listEl = null;
        var rows, i, row, id, chs, ch, data, item;

        function cleanseText(v) {
            var s = Util.decodeHtmlEntities(String(v || '').replace(/^\s+|\s+$/g, ''));
            return Util.cleanseDisplayName ? Util.cleanseDisplayName(s) : s;
        }
        function makeKey(it) {
            var rawId = it.seriesId || it.parentSeriesId || it.stream_id || it.series_id || it.id || it.url || it.name || '';
            return plId + ':' + type + ':item:' + rawId;
        }
        function findChannelById(cid) {
            var list = UI.getChannels ? UI.getChannels() : [];
            for (var a = 0; a < list.length; a++) {
                if (list[a].id === cid || list[a].url === cid) return list[a];
            }
            return null;
        }

        if (sectionName === 'livetv') {
            // Use the ACTIVE CATEGORY's full channel list — not the guide DOM, which only
            // holds the current ~50-row page, so previously only that page was lockable.
            // Falls back to the paginated rows, then the whole channel list, if needed.
            var liveList = (UI.getLiveCatChannels ? UI.getLiveCatChannels() : []) || [];
            if (liveList.length) {
                for (i = 0; i < liveList.length; i++) {
                    ch = liveList[i];
                    items.push({ id: ch.id || ch.url || ('live-' + i), name: ch.name || '', number: ch.number || 0, logo: ch.logo || '', category: ch.category || '', type: 'live', playlistId: ch.playlistId || plId, raw: ch });
                }
            }
            if (!items.length) {
                listEl = document.getElementById('liveChList');
                rows = listEl ? listEl.querySelectorAll('.live-epg-row[data-ch-id]') : [];
                for (i = 0; i < rows.length; i++) {
                    id = rows[i].getAttribute('data-ch-id');
                    ch = findChannelById(id);
                    if (ch) items.push({ id: ch.id || ch.url || id, name: ch.name || '', number: ch.number || 0, logo: ch.logo || '', category: ch.category || '', type: 'live', playlistId: ch.playlistId || plId, raw: ch });
                }
            }
            if (!items.length && UI.getChannels) {
                chs = UI.getChannels();
                for (i = 0; i < chs.length; i++) {
                    ch = chs[i];
                    items.push({ id: ch.id || ch.url || ('live-' + i), name: ch.name || '', number: ch.number || 0, logo: ch.logo || '', category: ch.category || '', type: 'live', playlistId: ch.playlistId || plId, raw: ch });
                }
            }
        } else {
            // Card view holds .vod-card elements (not .media-row) and only the
            // in-memory card state has the FULL current-category list (the DOM is
            // paginated). Prefer the card state; fall back to the list-view DOM
            // rows. This also makes every item in the category lockable, not just
            // the currently-paged ones.
            var cardItems = ((sectionName === 'movies' || sectionName === 'series') && UI.getVodCardItems)
                ? UI.getVodCardItems(sectionName) : null;
            if (cardItems && cardItems.length) {
                for (i = 0; i < cardItems.length; i++) {
                    data = cardItems[i];
                    if (!data) continue;
                    id = data.stream_id || data.series_id || data.id || data.name || data.title || ('item-' + i);
                    items.push({
                        id: sectionName === 'movies' ? ('vod-' + id) : ('series-' + id),
                        stream_id: data.stream_id || '',
                        series_id: data.series_id || '',
                        seriesId: data.series_id || '',
                        name: data.name || data.title || '',
                        number: i + 1,
                        logo: data.stream_icon || data.cover || data.logo || '',
                        category: data.category_name || '',
                        type: sectionName === 'movies' ? 'vod' : 'series',
                        playlistId: plId,
                        raw: data
                    });
                }
            } else {
                listEl = document.getElementById(sectionName === 'movies' ? 'movieList' : 'seriesList');
                rows = listEl ? listEl.querySelectorAll('.media-row[data-stream-id]') : [];
                for (i = 0; i < rows.length; i++) {
                    row = rows[i];
                    data = row._vodData || null;
                    if (!data) continue;
                    id = data.stream_id || data.series_id || row.getAttribute('data-stream-id') || data.name || data.title || ('item-' + i);
                    item = {
                        id: sectionName === 'movies' ? ('vod-' + id) : ('series-' + id),
                        stream_id: data.stream_id || '',
                        series_id: data.series_id || '',
                        seriesId: data.series_id || '',
                        name: data.name || data.title || '',
                        number: i + 1,
                        logo: data.stream_icon || data.cover || '',
                        category: data.category_name || '',
                        type: sectionName === 'movies' ? 'vod' : 'series',
                        playlistId: plId,
                        raw: data
                    };
                    items.push(item);
                }
            }
        }
        // Lock state lives on the ITEM model (single source of truth), not on the
        // DOM row — so it survives paging away, searching, and filtering, and
        // Apply reads every item regardless of what's currently rendered.
        for (var si = 0; si < items.length; si++) {
            items[si]._lockKey = makeKey(items[si]);
            items[si]._locked = !!locks[items[si]._lockKey];
        }

        var wrap = document.createElement('div');
        wrap.className = 'content-lock-wrap lock-panel-wrap';
        var tools = document.createElement('div');
        tools.className = 'content-lock-tools lock-panel-tools';
        function makeBtn(key, text) {
            var b = document.createElement('button');
            b.className = 'btn focusable';
            b.setAttribute('tabindex', '-1');
            b.setAttribute('data-focus-key', key);
            b.textContent = text;
            return b;
        }
        var lockAll = makeBtn('contentlock-lockall', T('pc_lock_all'));
        var unlockAll = makeBtn('contentlock-unlockall', T('pc_unlock_all'));
        var applyBtn = makeBtn('contentlock-apply', T('apply'));
        var cancelBtn = makeBtn('contentlock-cancel', T('cancel'));
        tools.appendChild(lockAll); tools.appendChild(unlockAll); tools.appendChild(applyBtn); tools.appendChild(cancelBtn);

        var header = document.createElement('div');
        header.className = 'content-lock-header lock-panel-header';
        header.appendChild(headCell('content-lock-name-head cat-mgr-name-head content-head-left', T('pc_col_content')));
        header.appendChild(headCell('content-lock-col-head cat-mgr-col-head', T('pc_col_locked')));

        // Search + filter bar (sits under the header row). Search narrows the
        // DISPLAYED items; the Locked filter (all / locked / unlocked) is a
        // find-aid for toggling individuals. Neither changes what Lock All /
        // Unlock All act on — those always act on the whole list.
        var filterBar = document.createElement('div');
        filterBar.className = 'lock-mgr-filterbar content-lock-filterbar';
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'lock-mgr-search cat-mgr-filter-name field focusable';
        searchInput.setAttribute('tabindex', '-1');
        searchInput.setAttribute('data-focus-key', 'contentlock-search');
        searchInput.setAttribute('placeholder', T('search_placeholder'));
        // Readonly blocks the LG/Tizen native system keyboard (the app-wide pattern);
        // our on-screen vkeyboard still opens on OK/click and writes into the field.
        searchInput.setAttribute('readonly', 'readonly');
        // Use the app's on-screen keyboard (TV remote), not the native one. Open it
        // on activation (click / OK press), NOT on focus — otherwise navigating onto
        // the field with the D-pad would pop the keyboard uninvited.
        searchInput.addEventListener('click', function () { if (UI.openVKeyboard) UI.openVKeyboard(searchInput); });
        var lockFilterBtn = document.createElement('button');
        lockFilterBtn.className = 'lock-mgr-filter-btn cat-mgr-filter-col btn focusable';
        lockFilterBtn.setAttribute('tabindex', '-1');
        lockFilterBtn.setAttribute('data-focus-key', 'contentlock-filter-locked');
        filterBar.appendChild(searchInput);
        filterBar.appendChild(lockFilterBtn);

        var listCol = document.createElement('div');
        listCol.id = 'contentLockList';
        listCol.className = 'content-lock-list lock-panel-list';
        var lockRows = [];

        // Delegated row-focus highlighting (same approach as the category
        // manager): one focusin/focusout pair on the list instead of focus+blur
        // on every row's lock button, so a 200-item list doesn't attach hundreds
        // of listeners up front. focusin/focusout bubble, so delegation works.
        function clRowOf(el) {
            while (el && el !== listCol) {
                if (el.className && (' ' + el.className + ' ').indexOf(' content-lock-row ') > -1) return el;
                el = el.parentNode;
            }
            return null;
        }
        listCol.addEventListener('focusin', function (e) {
            var line = clRowOf(e.target);
            if (!line) return;
            var lit = listCol.querySelectorAll('.row-focused');
            for (var li = 0; li < lit.length; li++) {
                if (lit[li] !== line) lit[li].classList.remove('row-focused');
            }
            line.classList.add('row-focused');
        });
        listCol.addEventListener('focusout', function (e) {
            var line = clRowOf(e.target);
            if (!line) return;
            var to = e.relatedTarget;
            if (to && clRowOf(to) === line) return;
            line.classList.remove('row-focused');
        });

        function updateLock(btn, on, line) {
            btn.textContent = on ? '\u2713' : '';
            if (on) { btn.classList.add('on'); line.classList.add('locked'); }
            else { btn.classList.remove('on'); line.classList.remove('locked'); }
        }

        function buildLockRow(it, idx) {
            var line = document.createElement('div');
            line.className = 'content-lock-row media-row';
            var info = document.createElement('div');
            info.className = 'media-info';
            var nameEl = document.createElement('div');
            nameEl.className = 'media-name';
            nameEl.textContent = (it.number ? Util.pad(it.number, 3) + '  ' : '') + cleanseText(it.name || T('pc_untitled'));
            info.appendChild(nameEl);
            var lock = document.createElement('button');
            lock.className = 'mgr-check cat-mgr-lock-check focusable content-lock-check';
            lock.setAttribute('tabindex', '-1');
            lock.setAttribute('data-focus-key', 'contentlock-row-' + idx);
            line.appendChild(info);
            line.appendChild(lock);
            line._item = it;            // row points at its model item
            line._lockBtn = lock;
            updateLock(lock, !!it._locked, line);
            // Toggle writes to the MODEL (it._locked), not the row — so the state
            // is correct when this row is later reused for another page/filter.
            lock.addEventListener('click', function () {
                it._locked = !it._locked;
                updateLock(lock, it._locked, line);
                // If a "locked/unlocked" filter is active, a toggled row may no
                // longer belong in the current view — re-render so it drops out.
                if (lockFilter !== 'all') renderPage();
            });
            return line;
        }

        // ---- Pagination + search/filter over the item model ----
        var PAGE_SIZE = 50;
        var pageStart = 0;
        var searchText = '';
        var lockFilter = 'all'; // 'all' | 'locked' | 'unlocked'

        function viewItems() {
            var q = searchText.trim().toLowerCase();
            var out = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (lockFilter === 'locked' && !it._locked) continue;
                if (lockFilter === 'unlocked' && it._locked) continue;
                if (q && (it.name || '').toLowerCase().indexOf(q) === -1) continue;
                out.push(it);
            }
            return out;
        }

        function lockFilterLabel() {
            if (lockFilter === 'locked') return T('pc_filter_locked') || 'Locked';
            if (lockFilter === 'unlocked') return T('pc_filter_unlocked') || 'Unlocked';
            return T('pc_filter_all') || 'All';
        }

        function renderPage() {
            if (!document.getElementById('contentLockList')) return;
            setFilterLabel(lockFilterBtn, lockFilterLabel());
            var view = viewItems();
            if (pageStart >= view.length) pageStart = Math.max(0, (Math.ceil(view.length / PAGE_SIZE) - 1) * PAGE_SIZE);
            listCol.innerHTML = '';
            lockRows = [];
            if (!view.length) {
                listCol.appendChild(Util.el('div', { 'class': 'search-empty', 'text': T('no_visible_items_to_manage_select') }));
                return;
            }
            // Prev page control
            if (pageStart > 0) {
                var prev = Util.el('div', {
                    'class': 'lock-mgr-page-btn focusable', 'tabindex': '-1',
                    'data-focus-key': 'contentlock-prevpage',
                    'text': (T('previous') || 'Previous ') + Math.min(PAGE_SIZE, pageStart) + ' ' + (T('items') || 'items')
                });
                prev.addEventListener('click', function () { pageStart = Math.max(0, pageStart - PAGE_SIZE); renderPage(); Focus.focusKey('contentlock-row-0'); });
                listCol.appendChild(prev);
            }
            var end = Math.min(pageStart + PAGE_SIZE, view.length);
            var frag = document.createDocumentFragment();
            for (var r = pageStart; r < end; r++) {
                var line = buildLockRow(view[r], r - pageStart);
                lockRows.push(line); frag.appendChild(line);
            }
            listCol.appendChild(frag);
            // Next page control
            if (end < view.length) {
                var remaining = view.length - end;
                var next = Util.el('div', {
                    'class': 'lock-mgr-page-btn focusable', 'tabindex': '-1',
                    'data-focus-key': 'contentlock-nextpage',
                    'text': (T('next') || 'Next ') + Math.min(PAGE_SIZE, remaining) + ' ' + (T('items') || 'items') + ' (' + remaining + ' ' + (T('remaining') || 'remaining') + ')'
                });
                next.addEventListener('click', function () { pageStart = end; renderPage(); Focus.focusKey('contentlock-row-0'); });
                listCol.appendChild(next);
            }
        }

        searchInput.addEventListener('input', function () {
            searchText = searchInput.value || '';
            pageStart = 0;
            renderPage();
        });
        lockFilterBtn.addEventListener('click', function () {
            var opts = [T('pc_filter_all'), T('pc_filter_locked'), T('pc_filter_unlocked')];
            var vals = ['all', 'locked', 'unlocked'];
            var cur = vals.indexOf(lockFilter); if (cur < 0) cur = 0;
            UI.openListPicker({ overlay: true,
                title: T('filter'),
                items: opts,
                selected: cur,
                onSelect: function (idx) {
                    lockFilter = vals[idx];
                    pageStart = 0;
                    renderPage();
                    setTimeout(function () { Focus.focusKey('contentlock-filter-locked'); }, 120);
                }
            });
        });

        function fillLockRows() { renderPage(); }

        // Apply a locked state to every row WITHOUT blocking on the whole list. The list can
        // Lock All / Unlock All act on the WHOLE list (all items of this manager —
        // e.g. all live, or all movies), always — never just the filtered view.
        // This supports "lock everything, then unlock a few" and per-content-type
        // locking (which the global Restrict Playback can't express). It's a pure
        // MODEL loop (no DOM), so it's fast even at tens of thousands of items;
        // only the visible page is re-rendered afterward.
        function setAllLocked(state) {
            for (var k = 0; k < items.length; k++) items[k]._locked = state;
            renderPage();
        }

        lockAll.addEventListener('click', function () { setAllLocked(true); });
        unlockAll.addEventListener('click', function () { setAllLocked(false); });
        applyBtn.addEventListener('click', function () {
            // Detect ADD/REMOVE of any content lock vs the state at open — over the
            // whole MODEL, not the visible rows.
            var addsLock = false, removesLock = false;
            for (var d = 0; d < items.length; d++) {
                var wasLocked = !!locks[items[d]._lockKey];
                var nowLocked = !!items[d]._locked;
                if (nowLocked && !wasLocked) addsLock = true;
                if (!nowLocked && wasLocked) removesLock = true;
            }

            function commit() {
                var saveLocks = Store.raw.get('parentalItemLocks', {}) || {};
                for (var c = 0; c < items.length; c++) {
                    if (items[c]._locked) saveLocks[items[c]._lockKey] = true;
                    else delete saveLocks[items[c]._lockKey];
                }
                Store.raw.set('parentalItemLocks', saveLocks);
                if (window.Access && Access.lock) Access.lock();
                UI.closeModal();
                if (UI.refreshLockIndicators) UI.refreshLockIndicators();
                UI.toast(T('content_locks_updated'), 'ok');
            }

            // Save first, then prompt — so the user's lock selections are
            // never lost if they enable controls (or cancel the prompt).
            if (addsLock && window.Access && !Access.isEnabled()) {
                commit();
                UI.openModal({
                    title: T('pc_enable_title'),
                    body: T('pc_enable_body'),
                    okText: T('pc_enable'),
                    cancelText: T('pc_not_now'),
                    cancelClass: 'btn focusable',
                    onOk: function () { if (Access.setPinFlow) Access.setPinFlow(); }
                });
                // This modal opens from within the manager modal's own handler;
                // the scope hand-off can leave focus stranded on the old layer, so
                // explicitly move focus into the new modal's buttons.
                setTimeout(function () {
                    var ml = document.getElementById('modalLayer');
                    var okB = document.getElementById('modalOk');
                    if (okB) { try { Focus.focus(okB); return; } catch (e) {} }
                    if (ml) { try { Focus.focusFirstIn(ml); } catch (e2) {} }
                }, 60);
                return;
            }
            if (removesLock && window.Access && Access.isEnabled()) {
                Access.requirePinStrict(T('pc_unlock_remove_locks'), function (ok) {
                    if (!ok) return;
                    commit();
                });
                return;
            }
            commit();
        });
        cancelBtn.addEventListener('click', function () { UI.closeModal(); });

        wrap.appendChild(tools); wrap.appendChild(header); wrap.appendChild(filterBar); wrap.appendChild(listCol);
        UI.openModal({ title: sectionName === 'livetv' ? T('pc_manage_channel_locks') : (sectionName === 'movies' ? T('pc_manage_movie_locks') : T('pc_manage_series_locks')), bodyEl: wrap, cancelText: false });
        var modal = document.getElementById('modalLayer');
        if (modal) {
            var actions = modal.querySelector('.modal-actions');
            if (actions) actions.style.display = 'none';
            var card = modal.querySelector('.modal-card');
            if (card) { card.classList.add('lock-mgr-modal-card'); card.classList.add('content-lock-modal-card'); }
        }
        Util.removeDefaultModalOk();
        // Shell is up; fill the rows in chunks so open isn't blocked on the build.
        fillLockRows();
        setTimeout(function () { Focus.focusKey('contentlock-lockall'); }, 100);
    }

    return {
        isCategoryLocked: isCategoryLocked,
        wrapPlayerAccessGate: wrapPlayerAccessGate,
        openCategoryManager: openCategoryManager,
        openContentLockManager: openContentLockManager,
        renderParentalControls: renderParentalControls,
        wireParentalControls: wireParentalControls
    };
})();
window.Parental = Parental;
