/* catchup-screen.js - the Catch-up page: channels that keep an archive (left, with filter and sort), the past
 * programmes of the selected channel (right, one tab per day). Programmes are fetched from the provider when a channel
 * is opened (Catchup.parseTable does the reading, Catchup.makeItem builds what the player plays). ES5. */
var CatchupScreen = (function () {
    'use strict';

    var PAGE = 200;                       // channel rows drawn at a time
    var SORT_KEY = 'catchupSort';
    var EMPTY_KEY = 'catchupEmpty';       // channels that opened with no past programmes, per source (Catchup.isEmptyIn)
    var emptyMap = null;
    var state = {
        chans: [], src: null, n: -1, pid: null,     // every archive channel of the open source
        view: [], rendered: null,                   // filtered + sorted list, and the list the DOM shows
        filter: '', sort: 'default', shown: PAGE, showHidden: false, hiddenN: 0, dirty: false, slotMode: false,
        selId: null, loadedFor: '', seq: 0,
        days: [], day: 0
    };

    function $id(id) { return document.getElementById(id); }
    function T2(key, fb) { try { var v = T(key); if (v && v !== key) return v; } catch (e) {} return fb; }
    // Provider tags such as raised letters or symbol boxes have no glyph on some TVs (tofu): same cleanse as the other lists.
    function cl(s) { var t = String(s || ''); return (window.Util && Util.cleanseDisplayName) ? Util.cleanseDisplayName(t) : t; }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function mk(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }
    function isActive() {
        var s = document.querySelector('.content-section.active');
        return !!(s && s.getAttribute('data-section-content') === 'catchup');
    }
    function activePid() { try { return Store.getActivePlaylistId ? Store.getActivePlaylistId() : null; } catch (e) { return null; } }

    function loadSort() {
        var v = null;
        try { v = Store.raw.get(SORT_KEY, null); } catch (e) {}
        state.sort = (v === 'az' || v === 'za') ? v : 'default';
    }
    function saveSort() { try { Store.raw.set(SORT_KEY, state.sort); } catch (e) {} }

    function getEmpty() {
        if (emptyMap) return emptyMap;
        var m = null;
        try { m = Store.raw.get(EMPTY_KEY, null); } catch (e) {}
        emptyMap = Catchup.pruneEmpty(m);
        return emptyMap;
    }
    function saveEmpty() { try { Store.raw.set(EMPTY_KEY, emptyMap || {}); } catch (e) {} }
    function isEmpty(ch) { return Catchup.isEmptyIn(getEmpty(), ch); }
    /* For the guide: show the archive icon only on channels the Catch-up page lists. */
    function isListed(ch) { return !!(window.Catchup && Catchup.supports(ch) && !isEmpty(ch)); }

    /* ---------- data ---------- */
    /* Archive channels of the open source. Re-read when the channel list or the open source changed; a change of
     * source also drops the selection, the programme panel and the cached programme lists (they belong to the old one). */
    function collect() {
        var all = [];
        try { all = (UI.isStalkerMode && UI.isStalkerMode()) ? (UI.getStalkerChannels() || []) : (UI.getChannels() || []); } catch (e) {}
        var pid = activePid();
        if (state.pid !== pid) {
            state.pid = pid; state.src = null; state.selId = null; state.loadedFor = ''; state.seq++;
            state.filter = ''; state.shown = PAGE; state.days = []; state.showHidden = false;
            try { Catchup.forget(); } catch (eF) {}
        }
        if (state.src === all && state.n === all.length) return state.chans;
        var out = [];
        for (var i = 0; i < all.length; i++) if (Catchup.supports(all[i])) out.push(all[i]);
        state.src = all; state.n = all.length; state.chans = out;
        state.shown = PAGE;
        return out;
    }

    function buildView() {
        var list = state.chans, out = [], f = state.filter.toLowerCase(), i, hid = 0;
        for (i = 0; i < list.length; i++) {
            var gone = isEmpty(list[i]);
            if (gone) hid++;
            // the channel that is open stays in the list, so the row does not vanish under the user
            if (gone && !state.showHidden && list[i].id !== state.selId) continue;
            if (f && String(list[i].name || '').toLowerCase().indexOf(f) < 0) continue;
            out.push(list[i]);
        }
        state.hiddenN = hid;
        if (state.sort !== 'default') {
            out.sort(function (a, b) {
                var x = String(a.name || '').toLowerCase(), y = String(b.name || '').toLowerCase();
                return x < y ? -1 : (x > y ? 1 : 0);
            });
            if (state.sort === 'za') out.reverse();
        }
        state.view = out;
        return out;
    }

    /* Side-menu entry: only when the open source has something to replay. Cheap; called when the channel list changes. */
    function refreshNav() {
        var btn = $id('navCatchup');
        if (!btn) return;
        var live = true;
        try {
            var aid = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
            if (aid && Store.getPlaylistContentTypes) live = Store.getPlaylistContentTypes(aid).live !== false;
        } catch (eCt) {}
        var has = live && collect().length > 0;
        btn.style.display = has ? '' : 'none';
        if (isActive()) {
            if (!has && window.UI && UI.showSection) { try { UI.showSection('home', true); } catch (e) {} }
            else if (state.rendered !== state.chans || !$id('cuChans').children.length) resetPage();
        }
    }

    function playlistOf(ch) {
        var pls = [];
        try { pls = Store.getPlaylists() || []; } catch (e) {}
        for (var i = 0; i < pls.length; i++) if (pls[i].id === ch.playlistId) return pls[i];
        return null;
    }
    function archiveLabel(ch) {
        if (Number(ch.archiveHours) > 0) return T2('cu_archive_h', '{n} h').replace('{n}', String(ch.archiveHours));
        return T2('cu_archive', '{n} d').replace('{n}', String(ch.archiveDays));
    }

    /* ---------- channel column ---------- */
    function renderChannels() {
        var host = $id('cuChans');
        if (!host) return;
        var list = buildView();
        updateTools();
        state.rendered = state.chans;
        host.innerHTML = '';
        if (!state.chans.length) { host.appendChild(mk('div', 'cu-empty', T2('cu_empty', 'No channels with catch-up in your sources.'))); return; }
        if (!list.length) { host.appendChild(mk('div', 'cu-empty', T2('cu_no_match', 'No channels match.'))); return; }
        var n = Math.min(list.length, state.shown);
        for (var i = 0; i < n; i++) host.appendChild(chanRow(list[i], i));
        if (n < list.length) host.appendChild(moreRow(list.length - n));
        host.scrollTop = 0;
    }
    function moreRow(left) {
        var more = mk('div', 'cu-row focusable');
        more.setAttribute('tabindex', '-1');
        more.setAttribute('data-focus-key', 'cu-more');
        more.setAttribute('data-cu-more', '1');
        more.appendChild(mk('div', 'cu-name', '+ ' + left));
        more.addEventListener('click', showMore);
        return more;
    }
    function chanRow(ch, i) {
        var row = mk('div', 'cu-row cu-chan focusable' + (ch.id === state.selId ? ' cu-sel' : '') + (isEmpty(ch) ? ' cu-dim' : ''));
        row.setAttribute('tabindex', '-1');
        row.setAttribute('data-focus-key', 'cu-c-' + i);
        row.setAttribute('data-cu-i', String(i));
        row.appendChild(mk('div', 'cu-name', cl(ch.name)));
        row.appendChild(mk('div', 'cu-days', archiveLabel(ch)));
        row.addEventListener('click', function () { openChannel(i, true); });
        return row;
    }
    function showMore() {
        var host = $id('cuChans'), list = state.view;
        var from = state.shown;
        state.shown = Math.min(list.length, state.shown + PAGE);
        var more = host.querySelector('[data-cu-more]');
        if (more) host.removeChild(more);
        for (var i = from; i < state.shown; i++) host.appendChild(chanRow(list[i], i));
        if (state.shown < list.length) host.appendChild(moreRow(list.length - state.shown));
        var first = host.querySelector('[data-cu-i="' + from + '"]');
        if (first && window.Focus) Focus.focus(first);
    }
    function markSelected() {
        var rows = document.querySelectorAll('#cuChans .cu-chan');
        for (var i = 0; i < rows.length; i++) {
            var ch = state.view[parseInt(rows[i].getAttribute('data-cu-i'), 10)];
            if (ch && ch.id === state.selId) rows[i].classList.add('cu-sel');
            else rows[i].classList.remove('cu-sel');
        }
    }
    function updateTools() {
        var f = $id('cuFilter'), s = $id('cuSort'), h = $id('cuHidden');
        if (h) {
            if (state.hiddenN > 0) {
                h.style.display = '';
                h.textContent = (state.showHidden ? T2('cu_hide_empty', 'Hide empty ({n})') : T2('cu_show_hidden', 'Show hidden ({n})')).replace('{n}', String(state.hiddenN));
            } else { h.style.display = 'none'; }
        }
        if (f && f.value !== state.filter) f.value = state.filter;
        if (s) {
            var lbl = state.sort === 'az' ? T2('pc_sort_alpha', 'Alphabetically') : state.sort === 'za' ? T2('pc_sort_reverse', 'Reverse') : '';
            s.textContent = T2('pc_sort', 'Sort') + (lbl ? ': ' + lbl : '');
        }
    }

    /* ---------- programme column ---------- */
    function clearProgs(msg) {
        state.days = []; state.day = 0;
        var tabs = $id('cuDays'); if (tabs) tabs.innerHTML = '';
        var host = $id('cuProgs');
        if (host) { host.innerHTML = ''; if (msg) host.appendChild(mk('div', 'cu-empty', msg)); }
    }

    function openChannel(i, focusProgs) {
        var ch = state.view[i];
        if (!ch) return;
        state.selId = ch.id; markSelected();
        var head = $id('cuProgHead');
        if (head) head.textContent = cl(ch.name);
        var hit = Catchup.cached(ch);
        if (hit) { state.loadedFor = ch.id; showProgs(ch, hit, focusProgs); return; }
        var seq = ++state.seq;
        state.loadedFor = '';
        clearProgs(T2('cu_loading', 'Loading programmes…'));
        fetchProgs(ch).then(function (progs) {
            if (seq !== state.seq) return;                      // another channel (or source) was opened meanwhile
            if (!(ch.type === 'm3u' && progs.length && progs[0].slot)) Catchup.remember(ch, progs);   // hourly slots only because the guide was not ready yet: ask again next time
            state.loadedFor = ch.id;
            learn(ch, progs);
            showProgs(ch, progs, focusProgs);
        }, function () {
            if (seq !== state.seq) return;
            clearProgs(T2('cu_error', 'Could not load programmes. Please try again.'));
        });
    }

    /* A channel that answered with no programmes is remembered as empty (and hidden next time the list is drawn); one
     * that now has programmes is taken off the list again. A failed request is not an answer and changes nothing. */
    function learn(ch, progs) {
        var was = isEmpty(ch), map = getEmpty();
        if (!progs.length && !was) { Catchup.markEmptyIn(map, ch); saveEmpty(); state.dirty = true; }     // the list is redrawn next time the page opens
        else if (progs.length && was) { Catchup.unmarkEmptyIn(map, ch); saveEmpty(); state.dirty = true; }
    }

    /* The provider's past programmes for one channel (a Promise of Catchup programme objects). */
    function fetchProgs(ch) {
        var pl = playlistOf(ch);
        if (!pl) return Promise.reject(new Error('no playlist'));
        if (ch.type === 'stalker') {
            return Api.stalkerArchive(pl, ch.stalkerId, ch.archiveHours).then(function (json) {
                return Catchup.parseStalker(json, ch.archiveHours);
            });
        }
        if (ch.type === 'm3u') return m3uProgs(ch);
        return Api.xtreamEpgTable(pl.host, pl.user, pl.pass, ch.streamId).then(function (json) {
            var progs = Catchup.parseTable(json, ch.archiveDays);
            return progs.length ? progs : slotFallback(ch, pl);
        });
    }

    /* Playlist channels have no provider table: the past programmes come from the guide the app already loaded for the
     * channel (read in the background on first use, so it is asked a few times), and a channel without guide rows is offered
     * by the hour like an Xtream one. */
    function devOffsetSec() { return -new Date().getTimezoneOffset() * 60; }
    function epgPast(ch) {
        return new Promise(function (resolve) {
            var tries = 0;
            (function look() {
                var now = new Date().getTime(), list = [];
                try { list = Epg.getProgrammesBetween(ch.playlistId, ch.tvgId || ch.epgId, now - Number(ch.archiveDays) * 86400000 - 600000, now) || []; } catch (e) {}
                if (!list.length && ch.xmltvId) { try { list = Epg.getProgrammesBetween(ch.playlistId, ch.xmltvId, now - Number(ch.archiveDays) * 86400000 - 600000, now) || []; } catch (e2) {} }
                if (list.length || ++tries >= 10) { resolve(list); return; }
                setTimeout(look, 200);
            })();
        });
    }
    function m3uProgs(ch) {
        return epgPast(ch).then(function (list) {
            var now = new Date().getTime(), out = [], oldest = now - Number(ch.archiveDays) * 86400000 - 600000;
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                if (!p || !(p.stop > p.start) || p.stop > now - 60000 || p.start < oldest) continue;
                out.push({ title: String(p.title || ''), startTs: Math.floor(p.start / 1000), stopTs: Math.floor(p.stop / 1000), offSec: null });
            }
            out.sort(function (a, b) { return b.startTs - a.startTs; });
            var slots = Catchup.buildSlots(now, ch.archiveDays, devOffsetSec(), slotTitle);
            if (!out.length) return slots;
            // The guide usually covers fewer days than the archive keeps: the older days are offered by the hour.
            var from = out[out.length - 1].startTs;
            for (var k = 0; k < slots.length; k++) { if (slots[k].stopTs <= from) out.push(slots[k]); }
            return out;
        });
    }
    function m3uKinds() { var m = null; try { m = Store.raw.get('catchupM3uKind', null); } catch (e) {} return (m && typeof m === 'object') ? m : {}; }
    function playM3u(ch, prog) {
        var kinds = m3uKinds();
        try { UI.toast(T2('loading', 'Loading\u2026'), null); } catch (e0) {}
        var io = function (u) { return Util.xhr({ method: 'GET', url: u, timeout: 8000, maxBytes: 262144, truncateAt: true }); };
        Catchup.resolveM3U(ch, prog, io, new Date().getTime(), devOffsetSec(), kinds[ch.playlistId] || '').then(function (r) {
            if (!r) { try { UI.toast(T2('cu_error', 'Could not load programmes. Please try again.'), 'err'); } catch (e1) {} return; }
            if (r.how !== 'unknown' && kinds[ch.playlistId] !== r.id) {
                kinds[ch.playlistId] = r.id;
                try { Store.raw.set('catchupM3uKind', kinds); } catch (e2) {}
            }
            var item = Catchup.makeM3uItem(ch, prog, r.url);
            if (item) { try { UI.tryPlay(item); } catch (e3) {} }
        }, function () { try { UI.toast(T2('cu_error', 'Could not load programmes. Please try again.'), 'err'); } catch (e4) {} });
    }

    /* No guide rows for this channel: offer its recordings by the hour when the provider really has them. One test request
     * (a slot two hours back) decides: a playlist means the hours are offered, an empty answer or an error status means
     * there is no recording (the channel is then remembered as empty). A request that cannot be judged (blocked, offline)
     * still offers the hours. Needs the provider's clock from the login answer; without it nothing is offered. */
    var offCache = {};
    function providerOffset(pl) {
        var c = offCache[pl.id], now = new Date().getTime();
        if (c && (now - c.at) < 6 * 3600 * 1000) return Promise.resolve(c.off);
        return Api.xtreamAuth(pl.host, pl.user, pl.pass).then(function (body) {
            var off = Catchup.offsetFromServerInfo(body && body.server_info);
            if (off !== null) offCache[pl.id] = { at: now, off: off };
            return off;
        });
    }
    function slotTitle(a, b) {
        var x = new Date(a * 1000), y = new Date(b * 1000);
        return pad2(x.getHours()) + ':' + pad2(x.getMinutes()) + ' - ' + pad2(y.getHours()) + ':' + pad2(y.getMinutes());
    }
    function slotFallback(ch, pl) {
        return providerOffset(pl).then(function (off) {
            if (off === null) return [];
            var slots = Catchup.buildSlots(new Date().getTime(), ch.archiveDays, off, slotTitle);
            if (!slots.length) return [];
            var test = Catchup.buildUrl(pl, ch, slots[Math.min(1, slots.length - 1)], 0, 'm3u8');
            if (!test) return [];
            return Util.xhr({ method: 'GET', url: test, timeout: 15000, maxBytes: 65536, truncateAt: true }).then(function (r) {
                return Catchup.playlistLooksValid(r && r.body) ? slots : [];
            }, function (e) {
                return (e && e.status >= 400) ? [] : slots;
            });
        }, function () { return []; });
    }

    /* Split the programmes into days (device-local dates), newest day first, and show the newest day. */
    function showProgs(ch, progs, focusFirst) {
        var now = new Date().getTime(), days = [], lastKey = '', cur = null;
        for (var i = 0; i < progs.length; i++) {
            var d = new Date(progs[i].startTs * 1000), key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
            if (key !== lastKey) {
                lastKey = key;
                cur = { label: Catchup.dayLabel(progs[i].startTs * 1000, now, dayT, dayLoc), progs: [] };
                days.push(cur);
            }
            cur.progs.push(progs[i]);
        }
        state.days = days; state.day = 0;
        state.curCh = ch;
        state.slotMode = !!(progs.length && progs[0].slot);
        renderDays();
        renderDay(focusFirst);
    }
    function dayT(k) { return T2(k, k === 'cu_today' ? 'Today' : 'Yesterday'); }
    function dayLoc(d) { return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }

    function renderDays() {
        var tabs = $id('cuDays');
        if (!tabs) return;
        tabs.innerHTML = '';
        if (state.days.length < 2) return;                      // one day needs no tabs
        for (var i = 0; i < state.days.length; i++) {
            (function (idx) {
                var b = mk('button', 'btn focusable' + (idx === state.day ? ' active' : ''), state.days[idx].label);
                b.setAttribute('tabindex', '-1');
                b.setAttribute('data-focus-key', 'cu-d-' + idx);
                b.addEventListener('click', function () { selectDay(idx, true); });
                tabs.appendChild(b);
            })(i);
        }
    }
    function selectDay(idx, keepTab) {
        state.day = idx;
        var bs = document.querySelectorAll('#cuDays .btn');
        for (var i = 0; i < bs.length; i++) { if (i === idx) bs[i].classList.add('active'); else bs[i].classList.remove('active'); }
        renderDay(false);
        if (keepTab && bs[idx] && window.Focus) Focus.focus(bs[idx]);
    }

    function renderDay(focusFirst) {
        var host = $id('cuProgs');
        if (!host) return;
        host.innerHTML = '';
        host.scrollTop = 0;
        var ch = state.curCh, day = state.days[state.day];
        if (!day) { host.appendChild(mk('div', 'cu-empty', T2('cu_none', 'No past programmes available for this channel.'))); return; }
        var pl = playlistOf(ch), first = null;
        if (state.slotMode) host.appendChild(mk('div', 'cu-note', T2('cu_slots_note', 'No guide for this channel. Recordings are listed by the hour; some hours may have none.')));
        for (var i = 0; i < day.progs.length; i++) {
            (function (prog, idx) {
                var d = new Date(prog.startTs * 1000);
                var row = mk('div', 'cu-row cu-prog focusable');
                row.setAttribute('tabindex', '-1');
                row.setAttribute('data-focus-key', 'cu-p-' + idx);
                row.appendChild(mk('div', 'cu-ptime', pad2(d.getHours()) + ':' + pad2(d.getMinutes())));
                row.appendChild(mk('div', 'cu-ptitle', cl(prog.title)));
                row.addEventListener('click', function () { playProg(ch, pl, prog); });
                host.appendChild(row);
                if (!first) first = row;
            })(day.progs[i], i);
        }
        if (focusFirst && first && window.Focus && isActive()) Focus.focus(first);
    }

    function playProg(ch, pl, prog) {
        if (ch.type === 'm3u') { playM3u(ch, prog); return; }
        var item = ch.type === 'stalker' ? Catchup.makeStalkerItem(ch, prog) : Catchup.makeItem(pl, ch, prog, 0);
        if (!item) { try { UI.toast(T2('cu_error', 'Could not load programmes. Please try again.'), 'err'); } catch (e) {} return; }
        try { UI.tryPlay(item); } catch (e2) {}
    }

    /* ---------- page lifecycle ---------- */
    function resetPage() {
        collect();
        state.selId = null; state.loadedFor = ''; state.seq++;
        updateTools();
        renderChannels();
        var hd = $id('cuProgHead'); if (hd) hd.textContent = '';
        clearProgs(state.chans.length ? T2('cu_pick', 'Select a channel to see its past programmes.') : '');
    }

    /* Open the page on a given channel (guide shortcut). */
    function openFor(ch) {
        UI.showSection('catchup', true);
        collect();
        state.filter = ''; updateTools();
        buildView();
        var idx = -1, i;
        for (i = 0; i < state.view.length; i++) if (state.view[i].id === ch.id) { idx = i; break; }
        if (idx < 0 && isEmpty(ch)) {           // asked for by name: show it even though it was hidden as empty
            state.showHidden = true; buildView();
            for (i = 0; i < state.view.length; i++) if (state.view[i].id === ch.id) { idx = i; break; }
        }
        if (idx < 0) return;
        if (idx >= state.shown) state.shown = Math.min(state.view.length, idx + 1);
        renderChannels();
        openChannel(idx, false);
        var row = document.querySelector('#cuChans [data-cu-i="' + idx + '"]');
        if (row && window.Focus) Focus.focus(row);
    }

    function enter() {
        bindOnce();
        loadSort();
        refreshNav();
        var before = state.rendered;
        collect();
        if (state.dirty || before !== state.chans || !$id('cuChans').children.length) { state.dirty = false; resetPage(); }
        else { updateTools(); markSelected(); }
    }

    function applyFilterFromField() {
        var f = $id('cuFilter');
        var v = f ? f.value : '';
        if (v === state.filter) return;
        state.filter = v; state.shown = PAGE;
        renderChannels(); markSelected();
    }
    function openSort() {
        var items = [T2('pc_sort_provider', 'Provider order'), T2('pc_sort_alpha', 'Alphabetically'), T2('pc_sort_reverse', 'Reverse')];
        var modes = ['default', 'az', 'za'];
        UI.openListPicker({
            title: T2('pc_sort_title', 'Sort by'), items: items, selected: modes.indexOf(state.sort),
            onSelect: function (idx) {
                state.sort = modes[idx] || 'default'; saveSort(); state.shown = PAGE;
                updateTools(); renderChannels(); markSelected();
                var s = $id('cuSort'); if (s && window.Focus) Focus.focus(s);
            }
        });
    }
    function toggleHidden() {
        state.showHidden = !state.showHidden; state.shown = PAGE;
        renderChannels(); markSelected();
        var h = $id('cuHidden'); if (h && window.Focus) Focus.focus(h);
    }
    var bound = false;
    function bindOnce() {
        if (bound) return; bound = true;
        var f = $id('cuFilter'), s = $id('cuSort'), h = $id('cuHidden');
        if (h) h.addEventListener('click', toggleHidden);
        if (f) {
            f.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (UI.openVKeyboard) UI.openVKeyboard(f); });
            f.addEventListener('input', applyFilterFromField);
        }
        if (s) s.addEventListener('click', openSort);
    }

    /* ---------- d-pad ---------- */
    function zoneOf(cur) {
        if (!cur) return null;
        if (cur.id === 'cuFilter' || cur.id === 'cuSort' || cur.id === 'cuHidden') return 'tools';
        if (!cur.classList) return null;
        if (cur.classList.contains('cu-prog')) return 'progs';
        if (cur.parentNode && cur.parentNode.id === 'cuDays') return 'days';
        if (cur.classList.contains('cu-chan') || cur.getAttribute('data-cu-more')) return 'chans';
        return null;
    }
    function rowsOf(sel) {
        var all = document.querySelectorAll(sel), out = [];
        for (var i = 0; i < all.length; i++) if (all[i].offsetWidth || all[i].offsetHeight) out.push(all[i]);
        return out;
    }
    function idx(arr, el) { for (var i = 0; i < arr.length; i++) if (arr[i] === el) return i; return -1; }
    function focusEl(el) { if (el && window.Focus) { Focus.focus(el); return true; } return false; }
    function selectedChanRow() {
        var rows = rowsOf('#cuChans .cu-chan');
        for (var i = 0; i < rows.length; i++) if (rows[i].classList.contains('cu-sel')) return rows[i];
        return rows[0] || null;
    }

    /* True = key handled. False (left from the channel list or filter) hands focus to the side menu. */
    function nav(cur, dir) {
        bindOnce();
        var z = zoneOf(cur);
        var chans = rowsOf('#cuChans .cu-row'), progs = rowsOf('#cuProgs .cu-prog'), days = rowsOf('#cuDays .btn');
        var i;
        if (!z) { focusEl($id('cuFilter') || chans[0]); return true; }
        if (z === 'tools') {
            var stack = rowsOf('.cu-tools .focusable'), ti = idx(stack, cur);       // filter, sort, hidden: one under the other
            if (dir === 'left') return false;
            if (dir === 'down') { if (ti < stack.length - 1) focusEl(stack[ti + 1]); else focusEl(chans[0]); return true; }
            if (dir === 'up') { if (ti > 0) focusEl(stack[ti - 1]); return true; }
            return true;                                      // right: nothing there
        }
        if (z === 'chans') {
            i = idx(chans, cur);
            if (dir === 'down') { if (i < chans.length - 1) focusEl(chans[i + 1]); return true; }
            if (dir === 'up') { if (i > 0) focusEl(chans[i - 1]); else { var tl = rowsOf('.cu-tools .focusable'); focusEl(tl[tl.length - 1] || $id('cuFilter')); } return true; }
            if (dir === 'left') return false;
            if (dir === 'right') {
                var ci = cur.getAttribute('data-cu-i');
                if (ci !== null) {
                    var ch = state.view[parseInt(ci, 10)];
                    if (ch && state.loadedFor === ch.id && progs.length) focusEl(progs[0]);
                    else openChannel(parseInt(ci, 10), true);
                }
                return true;
            }
        }
        if (z === 'days') {
            i = idx(days, cur);
            if (dir === 'left') { if (i > 0) focusEl(days[i - 1]); else focusEl(selectedChanRow()); return true; }
            if (dir === 'right') { if (i < days.length - 1) focusEl(days[i + 1]); return true; }
            if (dir === 'down' || dir === 'up') {
                /* the tabs can wrap onto several rows: Up/Down move between rows (nearest column), Down from the last row enters the programmes */
                var top = cur.offsetTop, cx = cur.offsetLeft + cur.offsetWidth / 2, best = null, bestTop = null, bd = 0, j, t, d;
                for (j = 0; j < days.length; j++) {
                    t = days[j].offsetTop;
                    if (dir === 'down' ? t > top + 2 : t < top - 2) {
                        if (bestTop === null || (dir === 'down' ? t < bestTop - 2 : t > bestTop + 2)) { bestTop = t; best = null; }
                        if (Math.abs(t - bestTop) <= 2) {
                            d = Math.abs(days[j].offsetLeft + days[j].offsetWidth / 2 - cx);
                            if (!best || d < bd) { best = days[j]; bd = d; }
                        }
                    }
                }
                if (best) focusEl(best);
                else if (dir === 'down') focusEl(progs[0]);
                return true;
            }
            return true;
        }
        if (z === 'progs') {
            i = idx(progs, cur);
            if (dir === 'down') { if (i < progs.length - 1) focusEl(progs[i + 1]); return true; }
            if (dir === 'up') {
                if (i > 0) focusEl(progs[i - 1]);
                else if (days.length) focusEl(days[state.day] || days[0]);
                return true;
            }
            if (dir === 'left') { focusEl(selectedChanRow()); return true; }
            if (dir === 'right') return true;
        }
        return true;
    }

    return { enter: enter, nav: nav, refreshNav: refreshNav, openFor: openFor, isListed: isListed, _state: state };
})();
