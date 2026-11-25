/* ui.js - Rendering for all sections (channel rows, grids, categories,
 *         search, Live TV guide, playlists, vkeyboard, modals, toast).
 *
 * Public API:
 *   UI.init()
 *   UI.setChannels(list)            // full normalized channel list
 *   UI.renderHome()
 *   UI.renderFavorites()
 *   UI.renderCategories()
 *   UI.renderSearch(query)
 *   UI.renderPlaylists()
 *   UI.renderHeroFromChannel(ch)
 *   UI.openModal({title, body, okText, cancelText, onOk, onCancel})
 *   UI.closeModal()
 *   UI.toast(msg, type)             // type: 'ok'|'err'|null
 *   UI.openVKeyboard(targetInput)
 *   UI.closeVKeyboard()
 *   UI.setActivePlaylistChip(name, count)
 *   UI.refreshMiniChannels()        // for the in-player mini list
 */
var UI = (function () {
    'use strict';

    /* Number of poster items to reveal per "show more" step in the VOD/series
     * lists. Comes from the performance policy (Lite reveals fewer per step to
     * cut the poster-loading burst on weak devices). Falls back to 50. */
    function pageStep() {
        try {
            if (typeof PerfConfig !== 'undefined') {
                var n = PerfConfig.get('pageSize');
                if (n) return n;
            }
        } catch (e) {}
        return 50;
    }

    // Side-clock interval id, so a re-init can clear the prior ticker.
    var clockTimer = null;

    var $ = Util.$, $$ = Util.$$, el = Util.el;
    var ALL_CHANNELS = [];           // current playlist's channels
    var SEARCH_DEBOUNCED = null;

    var channelMap = null; // built on setChannels for O(1) lookup

    function setChannels(list) {
        var changed = list !== ALL_CHANNELS;
        ALL_CHANNELS = list || [];
        channelMap = null; // lazy rebuild
        if (changed) {
            CACHED_BUCKETS = null;
            CACHED_BUCKETS_REF = null;
            CACHED_LIVE_ONLY = null;
            CACHED_LIVE_ONLY_REF = null;
        }
    }
    function getChannels() { return ALL_CHANNELS; }

    /* Live-only view of the current playlist: excludes entries sniffed as VOD
     * or series (type 'movies'/'series', e.g. from an m3u_plus export) so they
     * don't clutter Live categories/channels. Cached and invalidated together
     * with the bucket cache (both key off the ALL_CHANNELS reference). */
    var CACHED_LIVE_ONLY = null;
    var CACHED_LIVE_ONLY_REF = null;
    function liveOnlyChannels() {
        if (CACHED_LIVE_ONLY && CACHED_LIVE_ONLY_REF === ALL_CHANNELS) return CACHED_LIVE_ONLY;
        var out = [];
        var hasVod = false;
        for (var i = 0; i < ALL_CHANNELS.length; i++) {
            var c = ALL_CHANNELS[i];
            if (c.type === 'movies' || c.type === 'series') { hasVod = true; continue; }
            out.push(c);
        }
        // If nothing was filtered, reuse the original array so bucketByCategory's
        // reference-equality cache still hits (no needless rebucket for the common
        // all-live playlist).
        CACHED_LIVE_ONLY = hasVod ? out : ALL_CHANNELS;
        CACHED_LIVE_ONLY_REF = ALL_CHANNELS;
        return CACHED_LIVE_ONLY;
    }

    /* Collect resident M3U items of a given sniffed kind ('movies'|'series')
     * for the active playlist, for the M3U Movies/Series render paths. */
    function m3uVodItems(kind) {
        var out = [];
        for (var i = 0; i < ALL_CHANNELS.length; i++) {
            if (ALL_CHANNELS[i].type === kind) out.push(ALL_CHANNELS[i]);
        }
        return out;
    }

    function ensureChannelMap() {
        if (channelMap) return;
        channelMap = {};
        for (var i = 0; i < ALL_CHANNELS.length; i++) {
            var ch = ALL_CHANNELS[i];
            if (ch.id) channelMap[ch.id] = ch;
            if (ch.url && !channelMap[ch.url]) channelMap[ch.url] = ch;
        }
    }

    function findChannelByKey(key) {
        ensureChannelMap();
        if (channelMap[key]) return channelMap[key];
        return null;
    }

    function normalizeLockName(v) {
        return String(v || '').replace(/^VOD\s*[-–—:]\s*/i, '').replace(/^SRS\s*[-–—:]\s*/i, '').replace(/^SERIES\s*[-–—:]\s*/i, '').replace(/^\s+|\s+$/g, '');
    }

    function getUiLockKey(type, catName, plId) {
        var t = type || 'live';
        if (t === 'vod' || t === 'movie') t = 'movies';
        if (t !== 'movies' && t !== 'series') t = 'live';
        if (!catName || catName === '__all__') return '';
        return (plId || Store.getActivePlaylistId()) + ':' + t + ':' + normalizeLockName(catName);
    }

    function getUiItemLockKey(item) {
        var t, rawId;
        if (!item) return '';
        t = item.type || 'live';
        // Stalker items carry type 'stalker'; classify by stalkerKind so their
        // lock key matches what the content-lock manager saves ('movies'/'series'),
        // otherwise the key would fall through to 'live' and the lock wouldn't
        // enforce at playback time.
        if (t === 'stalker') t = (item.stalkerKind === 'series') ? 'series' : (item.stalkerKind === 'vod') ? 'movies' : 'live';
        if (t === 'vod' || t === 'movie') t = 'movies';
        if (t !== 'movies' && t !== 'series') t = 'live';
        rawId = item.seriesId || item.parentSeriesId || item.stream_id || item.series_id || item.id || item.url || item.name || '';
        if (!rawId) return '';
        return (item.playlistId || Store.getActivePlaylistId()) + ':' + t + ':item:' + rawId;
    }

    function isUiCategoryLocked(type, catName, plId) {
        var locks = Store.raw.get('parentalLocks', {}) || {};
        var key = getUiLockKey(type, catName, plId);
        return !!(key && locks[key]);
    }

    function isUiContentLocked(item) {
        var locks = Store.raw.get('parentalItemLocks', {}) || {};
        var key = getUiItemLockKey(item);
        return !!(key && locks[key]);
    }

    function isUiItemLocked(item) {
        if (!item) return false;
        // Map a Stalker item's type to its content kind so the category-lock
        // check matches the key the manager saved (movies/series, not 'live').
        var catType = item.type || 'live';
        if (catType === 'stalker') catType = (item.stalkerKind === 'series') ? 'series' : (item.stalkerKind === 'vod') ? 'movies' : 'live';
        return isUiCategoryLocked(catType, item.category || '', item.playlistId || Store.getActivePlaylistId()) || isUiContentLocked(item);
    }

    function requireUiUnlock(reason, cb) {
        if (window.Access && Access.isEnabled && !Access.isUnlocked()) {
            Access.requirePin(reason || T('pc_unlock_content'), function (ok) { if (ok && cb) cb(); });
            return false;
        }
        if (cb) cb();
        return true;
    }
    // Cached favorites set for fast lookup. Keys are scoped by playlist
    // (scope + FAV_JOIN + name/id/url) so a favorite in one playlist never lights
    // the star on the same title in another. Entries with no playlist are stored
    // under the empty scope and match everywhere (pre-1.0.3 data).
    var favSet = null;
    var FAV_JOIN = '\u0001';
    function ensureFavSet() {
        if (favSet) return;
        favSet = {};
        var favs = Store.getFavorites();
        for (var i = 0; i < favs.length; i++) {
            var f = favs[i];
            var sc = (f.playlistId || '') + FAV_JOIN;
            var base = Store.favBase ? Store.favBase(f) : f.key;
            if (base) favSet[sc + base] = true;
            if (f.url) favSet[sc + f.url] = true;
            if (f.name) favSet[sc + f.name] = true;
            // VOD/series cards and rows check by the composite id 'movies-<id>' /
            // 'series-<id>'. Store that too so a fav set from the info panel or the
            // other view still lights the star here. type is 'live'|'vod'|'series'.
            if (f.type === 'vod' || f.type === 'series') {
                var pfx = (f.type === 'series') ? 'series-' : 'movies-';
                // The stored id may be 'vod-<sid>' or 'series-<sid>'; also derive
                // the section-prefixed form the DOM uses.
                if (f.id) {
                    favSet[sc + f.id] = true;
                    var sid = String(f.id).replace(/^(vod|movies|series)-/, '');
                    if (sid) favSet[sc + pfx + sid] = true;
                }
            }
        }
    }
    // Is any of the given keys a favorite in playlist plId (default: the active one)?
    function favHas(plId, a, b, c) {
        ensureFavSet();
        var sc = (plId || Store.getActivePlaylistId() || '') + FAV_JOIN;
        var keys = [a, b, c];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!k) continue;
            if (favSet[sc + k] || favSet[FAV_JOIN + k]) return true;
        }
        return false;
    }
    function invalidateFavSet() { favSet = null; }

    /* If a category was just opened via OK, app.js sets
     * window._focusContentAfterCatLoad to the section name. A content renderer
     * calls this right after it appends its rows to move focus onto the first
     * row immediately — eliminating the race where a fixed-delay focus attempt
     * fired into the empty list before render and did nothing (the "needed a
     * second OK" bug). Only acts if focus is still on the category. */
    function consumeContentFocusFlag(sectionName, listEl) {
        // Rows just rendered — refresh lock glyphs for this list (cheap, glyph
        // only). Covers every content render path (all playlist types).
        try { refreshLockIndicators(); } catch (e) {}
        if (!listEl) return;
        if (window._focusContentAfterCatLoad !== sectionName) return;
        var cur = window.Focus && Focus.current ? Focus.current() : null;
        if (!(cur && cur.classList && cur.classList.contains('panel-cat-item'))) {
            // Focus already moved off the category; don't yank it. Clear the flag.
            window._focusContentAfterCatLoad = null;
            return;
        }
        var firstRow = listEl.querySelector('.media-row.focusable, .ch-card.focusable, .vod-card.focusable, .live-epg-row.focusable');
        if (firstRow) {
            window._focusContentAfterCatLoad = null;
            Focus.focus(firstRow);
        }
    }

    /* In CARD view the category column (.panel-cats) is display:none, but the
     * per-screen category auto-activate leaves focus on the now-hidden category
     * item. Focus stranded on an invisible node makes every D-pad press a no-op
     * (the dispatcher can't navigate out of it). Move focus onto the action bar's
     * first button so the user lands somewhere usable (the grid is one Down away).
     * Shared by every VOD/series category-render path (Xtream + Stalker, Movies +
     * Series) so all of them behave identically. section is 'movies' | 'series';
     * catListEl is the (hidden) category column. Only acts in card view, and only
     * when focus is still on/absent-from the hidden column (never yanks focus the
     * user has already moved elsewhere). */
    function landCardFocusOnBar(section, catListEl) {
        var vmSection = (section === 'series') ? 'series' : (section === 'livetv') ? 'live' : 'movies';
        if (!(Store.getViewMode && Store.getViewMode(vmSection) === 'card')) return;
        var barId = (section === 'series') ? 'seriesCardBar' : (section === 'livetv') ? 'liveCardBar' : 'movieCardBar';
        var barEl = document.getElementById(barId);
        if (!barEl || !barEl.querySelector('.focusable')) return;
        var curF = window.Focus && Focus.current ? Focus.current() : null;
        var focusInHiddenCats = curF && catListEl && catListEl.contains(curF);
        if (focusInHiddenCats || !curF) {
            Focus.focusFirstIn(barEl);
        }
    }

    /* Strip provider prefixes ("VOD - ", "SRS - ", "SERIES - ") and leading
     * junk from a VOD/series category name. Shared by the Xtream and Stalker
     * VOD paths so both clean up identically. Returns the display name. */
    function vodCleanseCategoryName(s) {
        var out = String(s || '')
            .replace(/^(?:VOD|SRS|SER|SERIES)\s*[-–—:|]+\s*/i, '')
            .replace(/[\u0000-\u001F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
            .replace(/^[\s\|\-\u00A0]+/, '')
            .trim();
        // Strip decorative superscript/symbol/tofu glyphs so category rows match
        // the cleansing every channel/series name gets (providers tag categories
        // with raised "4K 3840P", "Dolby Vision" in modifier letters, etc., which
        // the WebOS 10 font renders as tiny superscripts or boxes).
        return Util.cleanseDisplayName ? Util.cleanseDisplayName(out) : out;
    }
    /* One sort key for every category list, identical to the Manage Categories
     * sort (app-parental.js defaultSort): VOD prefix stripped for movies/series,
     * entities decoded, decorative glyphs/flags removed, lower-cased. Lists and the
     * manager must share it or a flag-prefixed name sorts after the plain ones in
     * the list but alphabetically in the manager. */
    function catSortKey(type, raw) {
        var r = String(raw || '');
        if (type === 'movies' || type === 'series') r = vodCleanseCategoryName(r);
        var t = (Util.decodeHtmlEntities ? Util.decodeHtmlEntities(r.replace(/^\s+|^\|+|\s+$/g, '')) : r.replace(/^\s+|^\|+|\s+$/g, ''));
        if (Util.cleanseDisplayName) t = Util.cleanseDisplayName(t);
        return t.toLowerCase();
    }
    /* Plain-language text for a failed Stalker call, shown after the "Failed to load ...:" prefix.
     * Never shows a bare number or "?": no status at all means the request never reached the
     * server (network drop, timeout, app just resumed). The server's own words are used only for
     * refusals the portal names itself (blocked, limit, denied, nothing to play). */
    function stalkerErrText(e) {
        var status = e && e.status;
        var b = e && e.body;
        if (typeof b === 'string') { try { b = JSON.parse(b); } catch (ePs) { b = null; } }
        var code = b && b.code;
        if ((code === 'blocked' || code === 'limit' || code === 'denied' || code === 'nothing') && b.error) return String(b.error);
        if (!status) return T('stalker_err_network');
        if (status === 401 || code === 'auth') return T('stalker_err_session');
        if (status === 429 || status === 503) return T('stalker_err_busy');
        if (status === 504) return T('stalker_err_network');
        return T('stalker_err_generic');
    }
    /* ---- item order inside a Movies / Series category (Manage Categories > Sort) ---- */
    /* Provider date to milliseconds: unix seconds or ms, or "YYYY-MM-DD HH:MM:SS". 0 = no usable date. */
    function parseAddedTs(v) {
        if (v == null || v === '') return 0;
        if (typeof v === 'number') return v > 0 ? (v < 1e11 ? v * 1000 : v) : 0;
        var s = String(v).replace(/^\s+|\s+$/g, '');
        if (/^\d{9,13}$/.test(s)) { var n = Number(s); return n < 1e11 ? n * 1000 : n; }
        var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
        if (!m || Number(m[1]) < 1971) return 0;
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    }
    function vodItemTs(it) {
        if (!it) return 0;
        if (it.addedTs > 0) return it.addedTs;
        return parseAddedTs(it.added) || parseAddedTs(it.last_modified);
    }
    function vodNameKey(it) {
        return String((it && (it.name || it.title)) || '').replace(/^[\s\u00A0\u200B-\u200F]+/, '').toLowerCase().trim();
    }
    /* Sorts items IN PLACE by the playlist's saved mode. 'provider' leaves the provider's order; a date
     * mode on a list with no dates at all also leaves it; items without a date go last. */
    function sortVodItems(items, type, pl) {
        var mode = (Store.getItemSort && pl) ? Store.getItemSort(pl.id, type) : 'az';
        if (!items || items.length < 2 || mode === 'provider') return items;
        if (mode === 'newest' || mode === 'oldest') {
            var dec = [], any = false, i;
            for (i = 0; i < items.length; i++) { var t = vodItemTs(items[i]); if (t) any = true; dec.push({ it: items[i], i: i, t: t }); }
            if (!any) return items;
            dec.sort(function (a, b) {
                if (!a.t !== !b.t) return a.t ? -1 : 1;
                if (a.t !== b.t) return mode === 'newest' ? b.t - a.t : a.t - b.t;
                return a.i - b.i;
            });
            for (i = 0; i < dec.length; i++) items[i] = dec[i].it;
            return items;
        }
        items.sort(function (a, b) {
            var na = vodNameKey(a), nb = vodNameKey(b);
            var r = na < nb ? -1 : na > nb ? 1 : 0;
            return mode === 'za' ? -r : r;
        });
        return items;
    }
    function clearItemCaches() {
        if (stalkerVodState) stalkerVodState.itemsByCat = {};
        if (stalkerSeriesState) stalkerSeriesState.itemsByCat = {};
    }
    /* Categories of Movies / Series follow the same Sort setting as the items (Manage Categories > Sort):
     * Alphabetically and Reverse sort them; Provider order, Newest and Oldest keep the provider's own
     * category order (categories carry no date). The provider's order is remembered for the manager. */
    var providerCatNames = { movies: [], series: [], live: [] };
    /* Same for a plain list of category keys given in the provider's own order (Live TV on every source, M3U
     * Movies / Series). Records that order for the manager and returns the keys in the saved Sort mode's order. */
    function orderNamesByMode(names, type, plId) {
        providerCatNames[type] = names.slice(0);
        var mode = (Store.getItemSort && plId) ? Store.getItemSort(plId, type) : 'az';
        var out = names.slice(0);
        if (mode === 'provider') return out;
        out.sort(function (a, b) {
            var r = catKeyCmp(catSortKey(type, a), catSortKey(type, b));
            return mode === 'za' ? -r : r;
        });
        return out;
    }
    function orderCatsByMode(cats, titleOf, type, pl) {
        var seen = {}, names = [], i;
        for (i = 0; i < cats.length; i++) {
            var n = vodCleanseCategoryName(titleOf(cats[i]));
            if (!seen[n]) { seen[n] = true; names.push(n); }
        }
        providerCatNames[type] = names;
        var mode = (Store.getItemSort && pl) ? Store.getItemSort(pl.id, type) : 'az';
        if (mode === 'provider' || mode === 'newest' || mode === 'oldest') return;
        cats.sort(function (a, b) {
            var r = catKeyCmp(catSortKey(type, titleOf(a)), catSortKey(type, titleOf(b)));
            return mode === 'za' ? -r : r;
        });
    }
    function catKeyCmp(na, nb) {
        var aL = /^[a-z0-9]/.test(na), bL = /^[a-z0-9]/.test(nb);
        if (aL && !bL) return -1;
        if (!aL && bL) return 1;
        return na < nb ? -1 : na > nb ? 1 : 0;
    }
    /* Strip the provider content-type prefix ("VOD - ", "SER - ", "SERIES - ",
     * "SRS - ") from a MOVIE/SERIES title, then apply the standard display cleanse.
     * The hero and Continue Watching showed raw "VOD - Title" because they used the
     * plain cleanse (which only removes tofu/emoji, not these prefixes). */
    function vodCleanseItemName(s) {
        var out = String(s || '').replace(/^(?:VOD|SER|SERIES|SRS)\s*[-–—:|]\s*/i, '');
        return Util.cleanseDisplayName ? Util.cleanseDisplayName(out) : out;
    }
    /* Format a provider rating as plain "N/10" text. Providers send a bare number
     * (0-10) with no source, so we don't attribute IMDb/TMDB — and we drop the old
     * star glyph (it collided with the favorite star). Returns '' for missing,
     * zero, or non-numeric values so absent ratings don't render as "0/10". */
    function formatRating(raw) {
        if (raw == null || raw === '') return '';
        var s = String(raw).trim();
        var m = s.match(/\d+(?:\.\d+)?/);
        if (!m) return '';
        var n = parseFloat(m[0]);
        if (!(n > 0)) return '';
        // Some feeds send an already-"/10" string; normalize to one decimal max.
        var val = (Math.round(n * 10) / 10);
        return val + '/10';
    }
    function refreshFavStars() {
        invalidateFavSet();
        ensureFavSet();
        // Update star on channel cards (home screen cards use .fav-mark)
        var cards = document.querySelectorAll('.ch-card, .vod-card');
        for (var i = 0; i < cards.length; i++) {
            var id = cards[i].getAttribute('data-ch-id');
            var url = cards[i].getAttribute('data-url') || '';
            var hasFav = favHas(cards[i].getAttribute('data-playlist-id'), id, url);
            var existingStar = cards[i].querySelector('.fav-mark');
            if (hasFav && !existingStar) {
                cards[i].appendChild((function(){var fm=el('div',{'class':'fav-mark'});fm.innerHTML=STAR_SVG;return fm;})());
            } else if (!hasFav && existingStar) {
                existingStar.parentNode.removeChild(existingStar);
            }
        }
        // Update star on live TV guide channel rows + VOD/series rows
        var rows = document.querySelectorAll('.media-row, .live-epg-row');
        for (var j = 0; j < rows.length; j++) {
            var rid = rows[j].getAttribute('data-ch-id');
            var rname = rows[j]._vodData ? rows[j]._vodData.name : '';
            // Also check by URL for live TV channels
            var rurl = '';
            var foundCh = findChannelByKey(rid);
            if (foundCh) rurl = foundCh.url || '';
            var hasFav2 = favHas(rows[j].getAttribute('data-playlist-id') || (foundCh && foundCh.playlistId), rid, rurl, rname);
            var existingStar2 = rows[j].querySelector('.media-fav');
            if (hasFav2 && !existingStar2) {
                var starParent = rows[j].classList.contains('live-epg-row') ? rows[j].querySelector('.live-epg-ch') : rows[j];
                if (!starParent) starParent = rows[j];
                starParent.appendChild(el('div', { 'class': 'media-fav', 'text': '\u2605' }));
            } else if (!hasFav2 && existingStar2) {
                existingStar2.parentNode.removeChild(existingStar2);
            }
        }
    }

    /* Padlock glyph shown on locked rows/categories (outline style, matching the
     * reference). Closed shackle + rounded body with a keyhole, in currentColor. */
    var LOCK_SHIELD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="14.8" r="1.4"/><path d="M12 16.2v2.3"/></svg>';

    /* The favourite star on a card
     * sits visibly off-centre within its circular badge (more empty space
     * above than below). Measured precisely before changing anything:
     * within the 38px circle, 11px of empty space above the star's painted
     * ink vs 8px below — real, not assumed. Root cause is a well-known
     * cross-platform quirk, not a CSS bug: a Unicode glyph (U+2605) is
     * positioned by the FONT's own internal line-box metrics (ascent/
     * descent/baseline), which commonly sit the glyph off the visual
     * center of its em box, and that offset varies by font — so a CSS nudge
     * tuned for this sandbox's font stack could easily be wrong on
     * Android/webOS/Tizen's different system fonts. Switched to a real SVG
     * instead, the same fix already used for the lock shield above (which
     * measured correctly centered, 4px/4px, for exactly this reason) — an
     * SVG's viewBox coordinates are deterministic and don't depend on any
     * particular font's metrics, so centering is guaranteed identical on
     * every platform. fill="currentColor" so it still tracks .fav-mark's
     * existing color (gold) with no CSS change needed there.
     */
    var STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';

    function makeLockGlyph() {
        var g = el('div', { 'class': 'lock-glyph' });
        g.innerHTML = LOCK_SHIELD_SVG;
        return g;
    }

    /* Remove-from-Continue-Watching glyph (removal was BLUE-key
     * only, and Android TV remotes have no colour keys at all — there was no
     * way to remove a card on Android). Same outline style as the lock
     * shield above (currentColor stroke, no fill) for visual consistency.
     * Built as its own focusable element (not a hover-reveal) specifically
     * so plain D-pad + OK reaches it on every platform; see
     * handleHomeNav's 'down' case in app.js for how focus gets here, and
     * screens.css for the 75x75 hit-area hack (matches the mini-player
     * expand/stop buttons). */
    var REMOVE_X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    /* Long-press-to-favourite (there was no way to add favourites
     * on Android touch: favouriting was previously reachable only via the
     * YELLOW remote key or the player overlay's #infoFavBtn, neither of
     * which exists on a touch-only device with no colour keys, same root
     * cause as the earlier Continue Watching remove-glyph bug). Deliberately
     * a GESTURE, not another permanent visible glyph — a card can already
     * carry a lock shield, a favourite star, and (on Continue Watching) a
     * remove X; a fourth always-on badge was judged more clutter than this
     * app's cards should carry. Gated on Mobile.isTouch() so the listeners
     * aren't attached at all on pure-TV hardware with no touchscreen, where
     * they would never fire anyway. Attached once, generically, in
     * makeChannelCard/makeVodCard rather than per-screen, so every card
     * context gets it consistently — Home, Favorites, Live TV, catalog
     * browsing, Continue Watching, search results.
     * Reuses Store.toggleFavorite + UI.refreshFavStars exactly as the
     * existing YELLOW-key/#infoFavBtn paths already do, rather than
     * duplicating that logic — the ch/item object is already available
     * directly via closure here, so (unlike handleYellow's generic
     * Focus.current()-based path) there's no need to reconstruct it from
     * DOM data- attributes. */
    var LONG_PRESS_FAVORITE_MS = 550;
    var LONG_PRESS_MOVE_TOLERANCE_PX = 12;
    function attachLongPressFavorite(card, ch) {
        if (!ch) return;
        try { if (!window.Mobile || !Mobile.isTouch || !Mobile.isTouch()) return; } catch (eMT) { return; }
        var timer = null;
        var startX = 0, startY = 0;
        var fired = false;

        function clearTimer() {
            if (timer) { clearTimeout(timer); timer = null; }
        }

        card.addEventListener('touchstart', function (ev) {
            if (!ev.touches || ev.touches.length !== 1) { clearTimer(); return; }
            fired = false;
            startX = ev.touches[0].clientX;
            startY = ev.touches[0].clientY;
            clearTimer();
            timer = setTimeout(function () {
                timer = null;
                fired = true;
                var added = false;
                try { added = Store.toggleFavorite(ch); } catch (eTF) { return; }
                try { refreshFavStars(); } catch (eRF) {}
                try { if (window.navigator && navigator.vibrate) navigator.vibrate(30); } catch (eV) {}
                try {
                    if (window.UI && UI.toast) {
                        UI.toast(added ? ('\u2605 ' + (T('ui_added_to_favorites') || 'Added to favorites'))
                                       : (T('ui_removed_from_favorites') || 'Removed from favorites'), 'ok');
                    }
                } catch (eT) {}
            }, LONG_PRESS_FAVORITE_MS);
        }, { passive: true });

        card.addEventListener('touchmove', function (ev) {
            if (!timer || !ev.touches || !ev.touches.length) return;
            var dx = ev.touches[0].clientX - startX;
            var dy = ev.touches[0].clientY - startY;
            if ((dx * dx + dy * dy) > (LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX)) clearTimer();
        }, { passive: true });

        card.addEventListener('touchend', function (ev) {
            clearTimer();
            if (fired) {
                // Swallow the synthetic click a touchend would otherwise
                // produce — a long-press toggles favourite status, it must
                // not ALSO play/open the item it was pressed on.
                ev.preventDefault();
                fired = false;
            }
        });
        card.addEventListener('touchcancel', clearTimer);
    }

    /* Long-press on list rows (.media-row for Movies/Series/Stalker lists,
     * .live-epg-row for Live TV). Cards get their own listener in
     * attachLongPressFavorite; rows are built in five places, so one delegated
     * listener covers them all. The favorite is built the same way the YELLOW key
     * builds it for a focused row (app.js handleYellow), so a title favorited by
     * long-press, by YELLOW or from the player is the same favorite. */
    function favChFromRow(row) {
        var id = row.getAttribute('data-ch-id');
        if (!id) return null;
        var ch = findChannelByKey(id);
        if (ch) return ch;
        var nameEl = row.querySelector('.media-name') || row.querySelector('.ch-name') || row.querySelector('.live-epg-ch-name');
        var cardType = row.getAttribute('data-ch-type') || '';
        var section = document.querySelector('.content-section.active');
        var secName = section ? section.getAttribute('data-section-content') : '';
        var rType = cardType || (secName === 'movies' ? 'vod' : secName === 'series' ? 'series' : 'live');
        return {
            id: id,
            name: nameEl ? nameEl.textContent : '',
            url: row.getAttribute('data-url') || '',
            logo: '',
            type: rType,
            playlistName: row.getAttribute('data-playlist-name') || '',
            playlistId: row.getAttribute('data-playlist-id') || '',
            category: rType === 'vod' ? 'Movies' : rType === 'series' ? 'Series' : ''
        };
    }
    function initRowLongPressFavorite() {
        var timer = null, fired = false, startX = 0, startY = 0;
        function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
        function rowOf(t) {
            while (t && t !== document) {
                if (t.classList && (t.classList.contains('media-row') || t.classList.contains('live-epg-row'))) return t;
                t = t.parentNode;
            }
            return null;
        }
        document.addEventListener('touchstart', function (ev) {
            clearTimer();
            fired = false;
            if (!ev.touches || ev.touches.length !== 1) return;
            try { if (!window.Mobile || !Mobile.isTouch || !Mobile.isTouch()) return; } catch (eMT) { return; }
            var row = rowOf(ev.target);
            if (!row) return;
            startX = ev.touches[0].clientX;
            startY = ev.touches[0].clientY;
            timer = setTimeout(function () {
                timer = null;
                var ch = favChFromRow(row);
                if (!ch) return;
                fired = true;
                var added = false;
                try { added = Store.toggleFavorite(ch); } catch (eTF) { return; }
                try { refreshFavStars(); } catch (eRF) {}
                try { if (window.navigator && navigator.vibrate) navigator.vibrate(30); } catch (eV) {}
                try {
                    UI.toast(added ? ('\u2605 ' + (T('ui_added_to_favorites') || 'Added to favorites'))
                                   : (T('ui_removed_from_favorites') || 'Removed from favorites'), 'ok');
                } catch (eT) {}
            }, LONG_PRESS_FAVORITE_MS);
        }, { passive: true });
        document.addEventListener('touchmove', function (ev) {
            if (!timer || !ev.touches || !ev.touches.length) return;
            var dx = ev.touches[0].clientX - startX, dy = ev.touches[0].clientY - startY;
            if ((dx * dx + dy * dy) > (LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX)) clearTimer();
        }, { passive: true });
        document.addEventListener('touchend', function (ev) {
            clearTimer();
            if (fired) {
                // Don't let the synthetic click also play/open the pressed row.
                if (ev.cancelable) ev.preventDefault();
                fired = false;
            }
        });
        document.addEventListener('touchcancel', function () { clearTimer(); fired = false; });
    }
    initRowLongPressFavorite();

    function makeRemoveCWGlyph(ch) {
        var g = el('div', {
            'class': 'cw-remove-glyph focusable',
            'tabindex': '-1',
            'data-focus-key': 'cwrm-' + (ch.id || ch.url || ''),
            'title': T('ui_remove_from_cw') || 'Remove from Continue Watching'
        });
        g.innerHTML = REMOVE_X_SVG;
        g.addEventListener('click', function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation(); // don't also trigger the card's own play-on-click
            // Same refocus behaviour as the BLUE-key path in app.js's
            // handleBlue(), so removal looks and feels identical regardless
            // of which input reached it: refocus the row (now one shorter),
            // or the hero if Continue Watching is now empty.
            confirmRemoveFromCW(ch, function () {
                renderHome();
                var row = document.getElementById('channelRowRecent');
                var hero = document.getElementById('heroPlay');
                if (row && row.querySelector('.focusable')) Focus.focusFirstIn(row);
                else if (hero) Focus.focus(hero);
            });
        });
        return g;
    }
    function setLockGlyph(elm, locked, parentForGlyph) {
        var host = parentForGlyph || elm;
        // Scope to direct children (no :scope selector — not safe on old WebOS).
        var existing = null;
        var searchIn = host;
        for (var c = 0; c < searchIn.children.length; c++) {
            if (searchIn.children[c].className === 'lock-glyph') { existing = searchIn.children[c]; break; }
        }
        if (locked && !existing) {
            host.appendChild(makeLockGlyph());
        } else if (!locked && existing) {
            existing.parentNode.removeChild(existing);
        }
        // Marker so CSS can offset a coexisting favorite star (on cards the star
        // and padlock both sit top-right and would otherwise overlap).
        if (host.classList) {
            if (locked) host.classList.add('has-lock');
            else host.classList.remove('has-lock');
        }
    }

    /* Parental controls must be ENABLED for any lock glyph to show. When
     * disabled, all glyphs are removed regardless of stored lock state. */
    function parentalActive() {
        return !!(window.Access && Access.isEnabled && Access.isEnabled());
    }

    /* Sweep all visible categories + content rows and add/remove the lock glyph
     * to match current Store lock state. Called on render and after any lock
     * change or parental enable/disable, so indicators stay live without
     * reopening the view. Glyph-only (never rebuilds lists), so focus/nav are
     * untouched. Applies to every playlist type (the lock helpers are
     * type-agnostic). */
    function refreshLockIndicators() {
        var active = parentalActive();
        var plId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;

        // Categories: each .panel-cat-item carries _catName; its section decides
        // the lock type (live/movies/series).
        var catItems = document.querySelectorAll('.panel-cat-item');
        for (var i = 0; i < catItems.length; i++) {
            var it = catItems[i];
            var locked = false;
            if (active && it._catName) {
                var sec = sectionTypeForElement(it);
                if (sec) locked = isUiCategoryLocked(sec, it._catName, plId);
            }
            setLockGlyph(it, locked, it);
        }

        // Content rows: live guide rows, VOD/series rows, channel cards, poster cards.
        var rows = document.querySelectorAll('.media-row, .live-epg-row, .ch-card, .vod-card');
        for (var j = 0; j < rows.length; j++) {
            var row = rows[j];
            var lockedRow = false;
            if (active) {
                var itemObj = lockItemFromRow(row);
                // Only the per-ITEM lock badges a row. A locked CATEGORY hides its
                // items until unlocked (handled at render/navigation time) rather
                // than stamping a shield on every child, so don't use the combined
                // isUiItemLocked here (that also returns true for category locks).
                if (itemObj) lockedRow = isUiContentLocked(itemObj);
            }
            // Place the glyph on the inner label for guide rows so it sits with
            // the channel name; on the row itself otherwise.
            var host = row.classList.contains('live-epg-row') ? (row.querySelector('.live-epg-ch') || row) : row;
            setLockGlyph(row, lockedRow, host);
        }
    }

    /* Which lock type (live/movies/series) applies to an element, from the
     * content-section it lives in. */
    function sectionTypeForElement(elm) {
        var p = elm;
        while (p && p.getAttribute) {
            var s = p.getAttribute('data-section-content');
            if (s) {
                if (s === 'livetv' || s === 'home') return 'live';
                if (s === 'movies') return 'movies';
                if (s === 'series') return 'series';
                return null;
            }
            p = p.parentNode;
        }
        return null;
    }

    /* Build a minimal item object good enough for isUiItemLocked from a rendered
     * row, across all row kinds/playlist types. */
    function lockItemFromRow(row) {
        var sec = sectionTypeForElement(row);
        var plId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
        if (row._vodData) {
            // VOD / series row (Xtream + Stalker). type from section; the lock
            // key helper normalizes vod/movie/series. Series carry series_id, not
            // stream_id — pass both (and the seriesId aliases the key helper
            // checks first) so a locked series is recognised on re-render.
            var vd = row._vodData;
            var sid = vd.stream_id || vd.series_id || vd.id || '';
            return {
                type: sec === 'series' ? 'series' : 'movies',
                stream_id: vd.stream_id,
                series_id: vd.series_id,
                seriesId: vd.series_id || vd.seriesId,
                parentSeriesId: vd.parentSeriesId || vd.series_id,
                id: sid,
                stalkerKind: vd.stalkerKind,
                category: vd.category_name || vd.category || '',
                playlistId: plId
            };
        }
        // Live channel row/card: look up the channel by its id for url/category.
        var id = row.getAttribute('data-ch-id');
        if (!id) return null;
        var ch = findChannelByKey(id);
        if (ch) return ch;
        // Fallback for cards whose channel isn't resident (e.g. Continue Watching,
        // which mixes live + movies + series via makeChannelCard). Use the card's
        // own data-ch-type so a locked movie/series isn't mis-keyed as live.
        var cardType = row.getAttribute('data-ch-type') || 'live';
        var lockType = (cardType === 'vod' || cardType === 'movie' || cardType === 'movies') ? 'movies'
                     : (cardType === 'series') ? 'series' : 'live';
        return { type: lockType, id: id, url: row.getAttribute('data-url') || '', category: '', playlistId: plId };
    }

    function makeChannelCard(ch, opts) {
        opts = opts || {};
        ensureFavSet();
        var fav = favHas(ch.playlistId, ch.id, ch.url);
        var card = el('div', {
            'class': 'ch-card focusable',
            'tabindex': '-1',
            'data-focus-key': 'ch-' + ch.id,
            'data-ch-id': ch.id,
            'data-url': ch.url || '',
            'data-ch-type': (ch.type === 'stalker'
                ? ((ch.stalkerKind === 'series') ? 'series' : (ch.stalkerKind === 'vod') ? 'movies' : 'live')
                : (ch.type || 'live')),
            'data-stalker-kind': ch.stalkerKind || '',
            'data-playlist-name': ch.playlistName || '',
            'data-playlist-id': ch.playlistId || ''
        });
        // Simple text-based logo (no image loading - much faster on slow TVs)
        var logoWrap = el('div', { 'class': 'ch-logo-wrap' });
        logoWrap.appendChild(el('div', { 'class': 'ch-logo-fallback', 'text': (ch.name || '?').charAt(0).toUpperCase() }));
        if (ch.logo) {
            card.setAttribute('data-logo', ch.logo);
        }
        card.appendChild(logoWrap);

        var info = el('div', { 'class': 'ch-info' });
        // Content type badge. movie/series always show their type here; live
        // shows a "LIVE" label in the SAME slot when liveLabelInline is set (e.g.
        // search results), so every kind's label lines up in the same position.
        // Live channels from a SOURCE carry the source's type, not 'live':
        // Xtream/m3u live channels are type 'xtream' (see parser.js fromXtream),
        // Stalker/MAG are type 'stalker' (+ stalkerKind). None of those matched the
        // live branch below, so a favorited live channel showed NO badge on
        // Home/Favorites (search dodged it only by forcing liveLabelInline).
        // Normalize source types to the movie/series/live buckets the rest of
        // ui.js uses (mirrors getUiLockKey): stalker -> stalkerKind bucket; a bare
        // source type with no vod/series kind is a live channel.
        var kind = ch.type;
        if (kind === 'stalker') {
            kind = (ch.stalkerKind === 'series') ? 'series'
                 : (ch.stalkerKind === 'vod') ? 'movie'
                 : 'live';
        } else if (kind === 'xtream' || kind === 'm3u') {
            // These source types are only ever produced for LIVE channels here;
            // Xtream VOD/series are built by separate loaders as 'movies'/'series'.
            kind = 'live';
        }
        var typeLabel = '';
        if (kind === 'vod' || kind === 'movie' || kind === 'movies') typeLabel = T('badge_movie');
        else if (kind === 'series') typeLabel = T('badge_series');
        else if (opts.liveLabelInline || kind === 'live' || kind === 'channel' || !kind) typeLabel = T('badge_live');
        // Optional category shown beside the type badge / number. Used in search
        // results so the same title appearing under different categories (often
        // different languages, e.g. an English vs Arabic vs French copy) can be
        // told apart. Only rendered when a searchCategory is present, so normal
        // grids (already grouped under a category header) are unaffected.
        var catText = ch.searchCategory || '';
        if (typeLabel) {
            if (catText) {
                var badgeRow = el('div', { 'class': 'ch-badge-row' });
                badgeRow.appendChild(el('span', { 'class': 'ch-type-badge', 'text': typeLabel }));
                badgeRow.appendChild(el('span', { 'class': 'ch-cat-label', 'text': catText }));
                info.appendChild(badgeRow);
            } else {
                info.appendChild(el('div', { 'class': 'ch-type-badge', 'text': typeLabel }));
            }
        } else if (catText) {
            var badgeRow2 = el('div', { 'class': 'ch-badge-row' });
            badgeRow2.appendChild(el('span', { 'class': 'ch-num', 'text': Util.pad(ch.number || 0, 3) }));
            badgeRow2.appendChild(el('span', { 'class': 'ch-cat-label', 'text': catText }));
            info.appendChild(badgeRow2);
        } else {
            info.appendChild(el('div', { 'class': 'ch-num', 'text': Util.pad(ch.number || 0, 3) }));
        }
        var cardName = (kind === 'vod' || kind === 'movie' || kind === 'movies' || kind === 'series')
            ? vodCleanseItemName(ch.name || '')
            : (Util.cleanseDisplayName ? Util.cleanseDisplayName(ch.name) : (ch.name || ''));
        info.appendChild(el('div', { 'class': 'ch-name', 'text': cardName }));
        if (ch.playlistName) {
            info.appendChild(el('div', { 'class': 'ch-playlist-label', 'text': ch.playlistName }));
        }
        card.appendChild(info);

        if (fav) card.appendChild((function(){var fm=el('div',{'class':'fav-mark'});fm.innerHTML=STAR_SVG;return fm;})());

        // Remove-from-Continue-Watching glyph — only on cards the caller
        // explicitly marks (the Continue Watching row itself), never on the
        // same card template reused elsewhere (Favorites, Live TV channel
        // lists, search), where there is nothing to "remove" in this sense.
        if (opts.showRemoveFromCW) {
            card.classList.add('has-remove-glyph');
            card.appendChild(makeRemoveCWGlyph(ch));
        }

        // Progress bar for VOD content
        if (ch.progress && ch.progress > 0.01 && ch.progress < 0.99) {
            var progWrap = el('div', { 'class': 'ch-progress' });
            var progFill = el('div', { 'class': 'ch-progress-fill' });
            progFill.style.width = Math.round(ch.progress * 100) + '%';
            progWrap.appendChild(progFill);
            card.appendChild(progWrap);
        }

        card.addEventListener('click', function () {
            if (ch && ch.type === 'series' && ch._seriesData && ch._seriesPlaylist) {
                showSeriesEpisodes(ch._seriesData, ch._seriesPlaylist);
                return;
            }
            tryPlay(ch);
        });
        attachLongPressFavorite(card, ch);

        return card;
    }

    /* Portrait poster card for on-demand content (Movies / Series), used by the
     * card view. Deliberately a sibling of makeChannelCard rather than a branch of
     * it: the channel card is landscape logo + number + live badge, the VOD card is
     * a portrait poster + title + year/rating, and forcing both through one function
     * made it unreadable. Shared PATTERNS are reused though: the poster loads lazily
     * through the same data-logo attribute that lazyLoadLogo() reads (so the existing
     * focus-driven image loader handles it with no extra wiring), a first-letter
     * fallback shows until the poster loads (and stays if it 404s, since the swap is
     * onload-only), a fav star and a progress bar mirror the row/channel versions.
     *
     * item is the object renderVodList builds (name, logo, year, rating, stream_id or
     * series_id, plot, ...); type is 'movies' or 'series'. onOpen, if given, is called
     * with (item) on click; otherwise the card self-routes (series -> episode list via
     * the caller-provided handler is required, so onOpen is expected for series). */
    function makeVodCard(item, type, opts) {
        opts = opts || {};
        item = item || {};
        var isSeries = (type === 'series');
        var vodId = (isSeries ? 'series-' : 'movies-') + (item.stream_id || item.series_id || item.id || '');
        var name = (Util.cleanseDisplayName ? Util.cleanseDisplayName(item.name || item.title || '') : (item.name || item.title || ''));
        var poster = item.logo || item.cover || item.stream_icon || '';

        var card = el('div', {
            'class': 'vod-card focusable',
            'tabindex': '-1',
            'data-focus-key': type + '-card-' + (item.stream_id || item.series_id || item.id || '0'),
            'data-ch-id': vodId,
            'data-ch-type': isSeries ? 'series' : 'vod',
            'data-playlist-name': (item.playlistName || ''),
            'data-playlist-id': (item.playlistId || ''),
            // Drives the fallback: 'yes' hides the title-text tile (the poster carries
            // the title, Stremio-style); 'no' shows it. lazyLoadLogo only swaps the
            // poster in on a real onload, so a 404 leaves this 'no' and the title
            // stays visible — a posterless item is still identifiable.
            'data-has-poster': poster ? 'yes' : 'no'
        });

        // The poster fills the whole tile. Its URL rides on data-logo so the shared
        // focus-driven lazyLoadLogo() loads it; no separate observer. A title-text
        // fallback tile sits underneath and shows only when data-has-poster is 'no'
        // (no URL, or the load failed). No year/rating meta: IPTV provider metadata is
        // usually wrong or missing, so a clean poster beats surfacing bad data.
        var posterWrap = el('div', { 'class': 'vod-card-poster-wrap' });
        var fallback = el('div', { 'class': 'vod-card-fallback' });
        fallback.appendChild(el('div', { 'class': 'vod-fallback-title', 'text': name || '?' }));
        posterWrap.appendChild(fallback);
        if (poster) card.setAttribute('data-logo', poster);
        card.appendChild(posterWrap);

        // Fav star (top-right, on its own scrim so it reads on any poster).
        ensureFavSet();
        if (favHas(item.playlistId, vodId, item.name)) {
            card.appendChild((function(){var fm=el('div',{'class':'fav-mark'});fm.innerHTML=STAR_SVG;return fm;})());
        }

        // Progress bar pinned to the bottom edge (movies only; series progress is
        // per-episode). This is the one reliable "meta" — it is from local watch
        // history, not the provider.
        if (!isSeries) {
            var histSnap = (typeof getVodHistoryMatch === 'function') ? getVodHistoryMatch(item) : null;
            if (histSnap && histSnap.progress > 0.01 && histSnap.progress < 0.98) {
                var progWrap = el('div', { 'class': 'vod-card-progress' });
                var progFill = el('div', { 'class': 'vod-card-progress-fill' });
                progFill.style.width = Math.round(histSnap.progress * 100) + '%';
                progWrap.appendChild(progFill);
                card.appendChild(progWrap);
            }
        }

        // Touch: same problem the list view had (see renderVodList's
        // vodTouchGate comment) — Focus's own capture-phase click handler
        // moves selection (and paints the info panel) in the same tap that
        // used to call onOpen() immediately, so a card could never actually
        // be previewed before playing. Cards view already has a real,
        // TV-remote-proven two-step flow for this (see handleOk in app.js):
        // OK on a card pins it and jumps focus to the panel's own Play
        // button, rather than playing straight away — reproduce exactly
        // that on a first tap, so playing happens via the panel's Play
        // button (already wired to _vodOpen via handleOk's keyup path,
        // click support added alongside this in wireVodInfoPanelButtons)
        // instead of a second tap on the card itself.
        var touchGate = false;
        try { touchGate = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eTg) {}
        card.addEventListener('click', function () {
            if (touchGate && !card._wasFocusedPreTap) {
                var section = isSeries ? 'series' : 'movie';
                var infoEl = document.getElementById(section + 'Info');
                var playBtn = document.getElementById(section + 'InfoPlay');
                if (infoEl && playBtn) {
                    window._vodPinnedCard = card;
                    var bodyEl = infoEl.querySelector('.vod-info-body');
                    if (bodyEl) bodyEl.scrollTop = 0;
                    if (window.Focus && Focus.focus) Focus.focus(playBtn);
                    return;
                }
            }
            if (opts.onOpen) { opts.onOpen(item); return; }
        });
        if (touchGate) {
            card.addEventListener('touchstart', function () {
                card._wasFocusedPreTap = !!(window.Focus && Focus.current && Focus.current() === card);
            }, true);
        }

        // Built directly from item/type/vodId already in scope here, rather
        // than routing through app.js's favChannelFromVodCard (which reads
        // card._vodData — attached externally, after this function returns,
        // inconsistently shaped per call site, and keyed with a DIFFERENT
        // id prefix scheme ("vod-"/"series-") than this card's own
        // data-ch-id ("movies-"/"series-", set as vodId above). Using that
        // mismatched id here would desync UI.refreshFavStars()'s dynamic
        // update, which matches cards by data-ch-id.
        var favCh = {
            id: vodId, name: name, url: '', logo: poster,
            playlistId: item.playlistId || (Store.getActivePlaylistId ? Store.getActivePlaylistId() : ''),
            playlistName: item.playlistName || opts.playlistName || '',
            category: isSeries ? 'Series' : 'Movies',
            type: isSeries ? 'series' : 'vod'
        };
        attachLongPressFavorite(card, favCh);

        return card;
    }

    // Lazy logo loader: load images only when cards are focused. Serves both the
    // channel card (.ch-logo-wrap / .ch-logo) and the VOD poster card
    // (.vod-card-poster-wrap / .vod-card-poster); it picks the wrapper the card actually has.
    function lazyLoadLogo(card) {
        var logoUrl = card.getAttribute('data-logo');
        if (!logoUrl) return;
        card.removeAttribute('data-logo');
        var wrap = card.querySelector('.ch-logo-wrap');
        var imgClass = 'ch-logo';
        if (!wrap) {
            wrap = card.querySelector('.vod-card-poster-wrap');
            imgClass = 'vod-card-poster';
        }
        if (!wrap) {
            wrap = card.querySelector('.live-epg-logo');      // Live TV list row (logos setting)
            imgClass = 'live-epg-logo-img';
        }
        if (!wrap) return;
        var img = new Image();
        img.className = imgClass;
        ImageLoader.load(img, logoUrl, {
            isPoster: true,
            onload: function () {
                wrap.innerHTML = '';
                wrap.appendChild(img);
            },
            onerror: function () {
                // Poster URL was present (so the title/letter fallback was hidden)
                // but the image didn't load — 404, dead URL, or posters disabled in
                // Lite. Reveal the fallback so the tile isn't left blank. Covers both
                // VOD poster cards (title tile) and channel cards (letter tile).
                var vc = card;
                if (vc && vc.setAttribute) vc.setAttribute('data-has-poster', 'no');
                // Channel cards show their letter fallback whenever the logo img is
                // absent, so simply not appending an <img> is enough there.
            }
        });
    }

    // Warm the posters for the initially-visible cards in a freshly built grid.
    // Without this, posters load only when a card is focused (see the Focus.onChange
    // handler), so every visible card past the focused one and its two neighbours
    // sits blank until navigated onto — a poster URL is present so the title-text
    // fallback is (correctly) hidden, leaving an empty tile. Loading the first screen
    // of cards up front fixes that; focus-driven loading still covers the rest on
    // scroll. count defaults to 18 (three rows of six, a viewport-plus margin on both
    // canvases). Kept deliberately simple; Phase 5b generalises neighbour preload.
    function warmInitialCards(container, count) {
        if (!container) return;
        var cards = container.querySelectorAll('.vod-card, .ch-card');
        var n = Math.min(cards.length, count || 18);
        for (var i = 0; i < n; i++) lazyLoadLogo(cards[i]);
    }

    // Touch / mouse scrolling never moves D-pad focus, so cards past the first screen kept
    // their poster address unused (only the first 18 loaded). One passive scroll listener
    // (scroll events do not bubble, so it listens in the capture phase) loads every card
    // that is on screen, or within one screen of it, whatever scrolled it. Also runs after
    // a resize and when the app comes back to the front.
    var posterScrollTimer = null;
    function loadVisiblePosters() {
        posterScrollTimer = null;
        var vh = 0;
        try { vh = window.innerHeight || document.documentElement.clientHeight || 0; } catch (e) {}
        if (!vh) return;
        var nodes = document.querySelectorAll('.vod-card[data-logo], .ch-card[data-logo], .live-epg-row[data-logo]');
        var loaded = 0;
        for (var i = 0; i < nodes.length && loaded < 60; i++) {
            var r;
            try { r = nodes[i].getBoundingClientRect(); } catch (e2) { continue; }
            if (!r || (!r.width && !r.height)) continue;
            if (r.bottom >= -vh && r.top <= vh * 2) { lazyLoadLogo(nodes[i]); loaded++; }
        }
    }
    function schedulePosterScan() {
        if (posterScrollTimer) return;
        posterScrollTimer = setTimeout(loadVisiblePosters, 150);
    }
    try {
        document.addEventListener('scroll', schedulePosterScan, true);
        window.addEventListener('resize', schedulePosterScan, false);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) schedulePosterScan(); }, false);
    } catch (e) {}

    // Phase 5B: grid-aware neighborhood warming. When focus lands on a card, warm
    // the posters within "radius" rows AND columns in every direction, so the row
    // you are about to scroll into (up/down) is ready, not just the linear DOM
    // neighbors. Column count is inferred from geometry (cards sharing the focused
    // card's top row, until the x-position wraps back to/left of the start). Radius
    // scales with PerfConfig (normal 2, lite 1) so weak devices warm less.
    function warmAroundCard(card) {
        if (!card || !card.parentNode) return;
        var siblings = card.parentNode.querySelectorAll('.vod-card, .ch-card');
        if (!siblings.length) return;
        var radius = 2;
        try {
            if (window.PerfConfig && PerfConfig.get) {
                var r = PerfConfig.get('warmRadius');
                if (typeof r === 'number' && r >= 0) radius = r;
            }
        } catch (e) {}
        // Find the focused card's index in the sibling list.
        var idx = -1, list = [];
        for (var i = 0; i < siblings.length; i++) { list.push(siblings[i]); if (siblings[i] === card) idx = i; }
        if (idx < 0) { lazyLoadLogo(card); return; }

        // Infer columns per row from geometry: count cards on the same visual row
        // as the FIRST card (same top within tolerance) until the row wraps.
        var cols = inferGridColumns(list);
        if (cols < 1) cols = 1;

        var focusRow = Math.floor(idx / cols);
        var focusCol = idx % cols;
        for (var rr = -radius; rr <= radius; rr++) {
            for (var cc = -radius; cc <= radius; cc++) {
                var tr = focusRow + rr, tc = focusCol + cc;
                if (tr < 0 || tc < 0 || tc >= cols) continue;
                var ti = tr * cols + tc;
                if (ti >= 0 && ti < list.length) lazyLoadLogo(list[ti]);
            }
        }
    }

    // Infer the number of columns in a wrapped card grid from element geometry:
    // the run of cards sharing the first card's top edge (within tolerance) before
    // the layout wraps to the next row. Falls back to a sane default if geometry
    // isn't measurable yet (e.g. display:none), so warming still does something.
    function inferGridColumns(list) {
        if (!list || !list.length) return 1;
        var first = list[0];
        var top0;
        try { top0 = first.getBoundingClientRect().top; } catch (e) { return 6; }
        var cols = 0;
        for (var i = 0; i < list.length; i++) {
            var t;
            try { t = list[i].getBoundingClientRect().top; } catch (e2) { break; }
            if (Math.abs(t - top0) <= 8) cols++;
            else break;
        }
        return cols > 0 ? cols : 6;
    }

    // True for on-demand content: native VOD/series AND Stalker/MAG vod/series
    // (which carry type 'stalker' with a stalkerKind). Used for resume prompts and
    // hero-card routing so Stalker movies/episodes behave like other VOD.
    // M3U entries sniffed as movies carry type 'movies' (the Movies section lists them by it). The player, the VOD
    // history and the resume logic know 'vod', so the item that is played (and saved to history) is a copy typed 'vod'.
    // Without it the player showed the live-TV controls: no Speed, no subtitles, no seek, a Channels button.
    function vodPlayItem(ch) {
        if (!ch || (ch.type !== 'movies' && ch.type !== 'movie')) return ch;
        var c = {}, k;
        for (k in ch) { if (Object.prototype.hasOwnProperty.call(ch, k)) c[k] = ch[k]; }
        c.type = 'vod';
        return c;
    }

    function isVodContent(ch) {
        if (!ch) return false;
        if (ch.type === 'vod' || ch.type === 'series' || ch.type === 'movies' || ch.type === 'movie') return true;
        if (ch.type === 'stalker' && (ch.stalkerKind === 'vod' || ch.stalkerKind === 'series')) return true;
        return false;
    }

    function tryPlay(ch) {
        ch = vodPlayItem(ch);
        // Two playback gates, both satisfied by a PIN that opens the short content
        // unlock window (NOT canProtected(), which is the always-strict per-action
        // gate for settings/playlists and can never be satisfied by unlocking — it
        // was the cause of an infinite tryPlay→requirePin→tryPlay recursion):
        //  1. "Restrict Playback" (protectActions on) gates ALL playback.
        //  2. Content locks (category/item) gate specific locked content.
        if (window.Access && Access.isEnabled && Access.isEnabled() && !Access.isUnlocked()) {
            var restrictAll = Access.isPlaybackRestricted && Access.isPlaybackRestricted();
            var itemLocked = isUiItemLocked(ch);
            if (restrictAll || itemLocked) {
                Access.requirePin(T('ui_unlock_playback'), function (ok) {
                    if (ok) { Access.unlock(); tryPlay(ch); }
                });
                return;
            }
        }
        if (window.App && App.closeMini) App.closeMini();

        var activeS = document.querySelector('.content-section.active');
        var sName = activeS ? activeS.getAttribute('data-section-content') : '';

        // Live TV: first OK = mini preview, second OK = fullscreen
        var isStalkerLive = ch && ch.type === 'stalker' && ch.stalkerKind !== 'vod' && ch.stalkerKind !== 'series';
        if (sName === 'livetv' && ch && (!ch.type || ch.type === 'live' || ch.type === 'xtream' || ch.type === 'm3u' || isStalkerLive)) {
            var curMini = window.LiveTopMiniPlayer && LiveTopMiniPlayer.currentChannel ? LiveTopMiniPlayer.currentChannel() : null;
            Store.setLastChannel(ch);
            if (curMini && curMini.id === ch.id && LiveTopMiniPlayer.isActive && LiveTopMiniPlayer.isActive()) {
                doPlay(ch, false);
                return;
            }
            if (window.LiveTopMiniPlayer && LiveTopMiniPlayer.play) {
                var originKey = null;
                try {
                    var cf = window.Focus && Focus.current ? Focus.current() : null;
                    originKey = cf && cf.getAttribute ? cf.getAttribute('data-focus-key') : null;
                } catch (e) {}
                LiveTopMiniPlayer.play(ch);
                function focusMiniExpandIfStillSafe() {
                    var curF = window.Focus && Focus.current ? Focus.current() : null;
                    var curKey = curF && curF.getAttribute ? curF.getAttribute('data-focus-key') : null;
                    // See keepExpandFocusIfSafe in live-top-mini.js: a live channel
                    // row (gch-*) OR a live card-view tile (ch-*) is the launch
                    // origin and always safe to advance from. Needed because after a
                    // parental unlock the captured originKey can be null while focus
                    // sits on the launch tile. Both grids feed the same tryPlay path.
                    if (!curKey || curKey === originKey || curKey === 'live-top-mini-expand' || curKey.indexOf('gch-') === 0 || curKey.indexOf('ch-') === 0) {
                        if (window.Focus && Focus.focusKey) Focus.focusKey('live-top-mini-expand');
                    }
                }
                // Mini-expand focus did not land for
                // Stalker live channels, though it did for Xtream: it wasn't actually broken by device
                // — the 120ms/420ms retries above were tuned against Xtream's
                // effectively-immediate playback. Stalker channels carry no direct
                // url (resolved per-play, downstream — see live-top-mini.js's own
                // comment on this), which on a real portal can genuinely take
                // longer than 420ms. focusKey() requires the expand button to
                // already be visible (isVisible() check in focus.js) — if the
                // mini player's own UI hasn't finished coming up yet by either
                // retry, both silently no-op and focus is left exactly where it
                // started: on the channel row. A second OK press there re-enters
                // tryPlay's "already mini-active" branch above and goes straight
                // to doPlay() — a different path that never runs
                // LiveTopMiniPlayer.play()'s own _lastFocusBeforeMini capture,
                // which plausibly explains the second symptom (back
                // landing on the first row instead of the origin row) as a
                // downstream consequence of this same root cause, not a separate
                // bug — genuinely worth confirming both resolve together, not
                // fully confirmed here.
                // Fix: also listen for Player's own 'ready' state event (fired
                // once a stream has actually started — see player.js's
                // fireStateEvent), the same real-signal approach already used
                // elsewhere in this file for the mini-bounds-tracking fix,
                // instead of only widening the guess. Kept the two timeouts as a
                // safety net (harmless, redundant with focusKey's own idempotent
                // check) in case 'ready' never fires for some other reason.
                var miniReadyListener = null;
                if (window.Player && Player.onStateEvent && Player.offStateEvent) {
                    miniReadyListener = function (type) {
                        if (type === 'ready') {
                            focusMiniExpandIfStillSafe();
                            Player.offStateEvent(miniReadyListener);
                        }
                    };
                    Player.onStateEvent(miniReadyListener);
                    // Don't leak the listener forever if 'ready' never comes
                    // (e.g. the stream errors out instead) — same window as the
                    // last timeout retry below, plus a small margin.
                    setTimeout(function () {
                        if (miniReadyListener && Player.offStateEvent) Player.offStateEvent(miniReadyListener);
                    }, 3000);
                }
                setTimeout(focusMiniExpandIfStillSafe, 120);
                setTimeout(focusMiniExpandIfStillSafe, 420);
            }
            return;
        }

        // VOD with saved progress: ask resume or restart
        if (isVodContent(ch) && ch.currentTime && ch.currentTime > 30) {
            var mins = Math.floor(ch.currentTime / 60);
            showResumePrompt(ch, mins);
            return;
        }

        doPlay(ch, false);
    }

    // Confirm + remove an item from Continue Watching (vod/series/live). onDone is
    // called after a successful removal so the caller can refresh the view.
    function confirmRemoveFromCW(ch, onDone) {
        var key = ch && (ch.id || ch.url);
        if (!key) return;
        var body = el('div', { 'class': 'resume-modal-body' });
        var name = (ch.name || ch.title || 'this title');
        body.appendChild(el('div', { 'class': 'modal-body', 'text': T('remove') + name + '" from Continue Watching?' }));
        var actions = el('div', { 'class': 'resume-modal-actions' });
        var yes = el('button', { 'class': 'btn focusable', 'tabindex': '-1', 'data-focus-key': 'cwrm-yes', 'text': T('remove_2') });
        var no = el('button', { 'class': 'btn focusable', 'tabindex': '-1', 'data-focus-key': 'cwrm-no', 'text': T('cancel') });
        yes.addEventListener('click', function () {
            if (Store.removeFromContinueWatching) Store.removeFromContinueWatching(key, ch && ch.playlistId);
            UI.closeModal();
            if (onDone) onDone();
        });
        no.addEventListener('click', function () { UI.closeModal(); });
        actions.appendChild(yes);
        actions.appendChild(no);
        body.appendChild(actions);
        UI.openModal({ title: T('ui_remove_cw_title'), bodyEl: body, cancelText: false });
        var card = document.querySelector('#modalLayer .modal-card');
        if (card) card.classList.add('resume-modal-card');
        var ok = document.getElementById('modalOk');
        if (ok && ok.parentNode) ok.parentNode.removeChild(ok);
        setTimeout(function () { Focus.focusKey('cwrm-no'); }, 100); // default to Cancel (safer)
    }

    function showResumePrompt(ch, mins) {
        var body = el('div', { 'class': 'resume-modal-body' });
        body.appendChild(el('div', { 'class': 'modal-body', 'text': T('you_watched') + mins + ' minutes previously.' }));
        var actions = el('div', { 'class': 'resume-modal-actions' });
        var resumeBtn = el('button', { 'class': 'btn focusable', 'tabindex': '-1', 'data-focus-key': 'resume-yes', 'data-focus-down': 'resume-remove', 'text': T('resume') });
        var restartBtn = el('button', { 'class': 'btn focusable', 'tabindex': '-1', 'data-focus-key': 'resume-no', 'data-focus-down': 'resume-remove', 'text': T('start_over') });
        resumeBtn.addEventListener('click', function () { UI.closeModal(); doPlay(ch, true); });
        restartBtn.addEventListener('click', function () { ch.currentTime = 0; ch.progress = 0; UI.closeModal(); doPlay(ch, false); });
        var removeBtn = el('button', { 'class': 'btn focusable resume-remove-btn', 'tabindex': '-1', 'data-focus-key': 'resume-remove', 'data-focus-up': 'resume-no', 'text': T('remove_from_continue_watching') });
        removeBtn.addEventListener('click', function () {
            UI.closeModal();
            confirmRemoveFromCW(ch, function () {
                var homeScreen = document.getElementById('home');
                if (homeScreen && homeScreen.classList.contains('active')) renderHome();
            });
        });
        actions.appendChild(resumeBtn);
        actions.appendChild(restartBtn);
        body.appendChild(actions);
        body.appendChild(removeBtn);
        UI.openModal({ title: T('ui_resume_title'), bodyEl: body, cancelText: false });
        var resumeCard = document.querySelector('#modalLayer .modal-card');
        if (resumeCard) resumeCard.classList.add('resume-modal-card');
        var ok = document.getElementById('modalOk');
        if (ok && ok.parentNode) ok.parentNode.removeChild(ok);
        setTimeout(function () { Focus.focusKey('resume-yes'); }, 100);
    }

    function doPlay(ch, shouldResume) {
        ch = vodPlayItem(ch);
        // Playback restriction gate (mirrors tryPlay). Uses the content unlock
        // window — NOT canProtected() (always-strict for settings; can never be
        // satisfied by unlocking, which caused an infinite doPlay→requirePin loop
        // and blocked playback even after a correct PIN).
        if (window.Access && Access.isEnabled && Access.isEnabled() && !Access.isUnlocked()) {
            var restrict = Access.isPlaybackRestricted && Access.isPlaybackRestricted();
            var locked = isUiItemLocked(ch);
            if (restrict || locked) {
                Access.requirePin(T('ui_unlock_playback'), function (ok) {
                    if (ok) { Access.unlock(); doPlay(ch, shouldResume); }
                });
                return;
            }
        }
        // Save to VOD history
        if (isVodContent(ch)) {
            // Same fix as app.js's exitPlayer(), same reason: Stalker's url
            // is a one-time resolved, ephemeral token (player.js's play()
            // only re-resolves when channel.url is falsy) — never persist it
            // for Stalker VOD/series, or a later resume skips re-resolving
            // and tries the already-expired token directly. Xtream's url is
            // genuinely stable and is meant to be kept as-is.
            var isStalkerVodLikeDP = ch.type === 'stalker' && (ch.stalkerKind === 'vod' || ch.stalkerKind === 'series');
            Store.addVodHistory({
                id: ch.id, name: ch.name, url: isStalkerVodLikeDP ? '' : ch.url, logo: ch.logo,
                type: ch.type, category: ch.category, playlistId: ch.playlistId,
                playlistName: ch.playlistName, timestamp: Date.now(),
                progress: ch.progress || 0,
                currentTime: ch.currentTime || 0,
                duration: ch.duration || 0,
                // Stalker/MAG content resolves its stream per-play from these.
                stalkerKind: ch.stalkerKind, stalkerCmd: ch.stalkerCmd,
                stalkerId: ch.stalkerId, stalkerGenreId: ch.stalkerGenreId,
                stalkerEpisode: ch.stalkerEpisode
            });
        }
        // Snapshot memory before heading to player
        var activeS = document.querySelector('.content-section.active');
        if (activeS) {
            var sName = activeS.getAttribute('data-section-content');
            window._lastSectionBeforePlayer = sName;
            var curFocused = Focus.current();
            if (curFocused && curFocused.getAttribute && curFocused.getAttribute('data-focus-key')) {
                SECTION_FOCUS_MEMORY[sName] = curFocused.getAttribute('data-focus-key');
            }
        }
        if (window.LiveTopMiniPlayer && LiveTopMiniPlayer.suspend) {
            LiveTopMiniPlayer.suspend();
        }

        showScreen('player');
        Player.play(ch);
        // Resume from saved position
        if (shouldResume && ch.currentTime && ch.currentTime > 10) {
            setTimeout(function () {
                var vid = document.querySelector('#videoEl');
                if (vid) {
                    try { vid.currentTime = ch.currentTime; } catch (e) {}
                }
            }, 1500);
        }
        // Apply saved video scale
        if (window.App && App.applyVideoScale) {
            setTimeout(function () {
                var st = Store.getSettings();
                App.applyVideoScale(st.videoScale || 'contain');
            }, 500);
        }
    }

    /* ===== Home section (dashboard) =====
       (Historically named "Live" — this renders the HOME screen: hero, Continue
       Watching, favourites row and quick category grid. The Live TV guide is
       renderCategories()/renderLiveChannels().) */
    function renderHome() {
        var rowRecent = $('#channelRowRecent');
        var catGrid = $('#quickCatGrid');
        var recentBlock = $('#recentBlock');

        // --- Continue Watching (live channels + movies + series combined) ---
        if (rowRecent) {
            Util.empty(rowRecent);
            var recents = Store.getRecentChannels();
            var vodHistory = Store.getVodHistory();
            // Merge all into one list, sorted by most recent. VOD/series history is
            // pushed FIRST so that if a title also sits in live "recents" (it was
            // played, so setLastChannel recorded it too), the correctly-typed
            // movie/series entry wins de-duplication below — otherwise the live-typed
            // copy showed a "LIVE" badge on a movie.
            var combined = [];
            for (var vi = 0; vi < vodHistory.length; vi++) {
                vodHistory[vi]._ts = vodHistory[vi].timestamp || (Date.now() - vi * 1000);
                combined.push(vodHistory[vi]);
            }
            for (var r = 0; r < recents.length; r++) {
                var rch = findChannelByKey(recents[r].id || recents[r].url) || recents[r];
                if (!rch.number) rch.number = r + 1;
                rch._ts = recents[r].timestamp || (Date.now() - r * 1000);
                combined.push(rch);
            }
            // Sort by timestamp descending
            combined.sort(function (a, b) { return (b._ts || 0) - (a._ts || 0); });
            // Deduplicate by id, preferring the movie/series-typed copy over a
            // live-typed one for the same title (a played VOD is in both lists).
            var seen = {};
            var unique = [];
            for (var ci = 0; ci < combined.length && unique.length < 15; ci++) {
                // Dedup key: normalized title SCOPED BY PLAYLIST. The same played
                // VOD appears in both vodHistory (movie/series-typed) and recents
                // (live-typed) with DIFFERENT ids, so an id key leaves both in — but
                // a title-only key is too broad: the same title in two different
                // playlists (two same-named sources, or one source added twice) must
                // stay as separate cards, one per playlist. So key on title + the
                // playlist's unique id. Fall back to id/url when either is missing.
                var rawName = combined[ci].name || combined[ci].title || '';
                var normName = vodCleanseItemName(rawName).toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
                var plScope = combined[ci].playlistId || '';
                var ck = normName ? (normName + '::' + plScope) : (combined[ci].id || combined[ci].url);
                var cType = combined[ci].type;
                var cKind = combined[ci].stalkerKind;
                var isVodType = (cType === 'vod' || cType === 'series' ||
                    (cType === 'stalker' && (cKind === 'vod' || cKind === 'series')));
                if (!seen.hasOwnProperty(ck)) {
                    seen[ck] = unique.length; // remember slot
                    unique.push(combined[ci]);
                } else if (isVodType) {
                    // Replace a previously-kept live-typed entry with the typed one.
                    var slot = seen[ck];
                    var prev = unique[slot];
                    var prevIsVod = (prev && (prev.type === 'vod' || prev.type === 'series' ||
                        (prev.type === 'stalker' && (prev.stalkerKind === 'vod' || prev.stalkerKind === 'series'))));
                    if (prev && !prevIsVod) unique[slot] = combined[ci];
                }
            }
            if (unique.length === 0) {
                if (recentBlock) recentBlock.style.display = 'none';
            } else {
                if (recentBlock) recentBlock.style.display = '';
                for (var ui = 0; ui < unique.length; ui++) {
                    // Hydrate VOD/series (incl. Stalker) with latest history for progress bars.
                    var uType = unique[ui].type;
                    var uIsVod = (uType === 'vod' || uType === 'series' ||
                        (uType === 'stalker' && (unique[ui].stalkerKind === 'vod' || unique[ui].stalkerKind === 'series')));
                    if (uIsVod) {
                        applyVodHistoryToItem(unique[ui]);
                    }
                    rowRecent.appendChild(makeChannelCard(unique[ui], { showRemoveFromCW: true }));
                }
            }
        }

        // --- Home hero ---
        var lastCh = Store.getLastChannel();
        renderHeroFromChannel(Player.currentChannel() || lastCh || ALL_CHANNELS[0]);

        // Stamp lock shields on the freshly-rendered cards (per-item content locks).
        // Other render paths sweep at their tail; home did not, so a locked channel
        // in Continue Watching showed no shield until some later sweep ran.
        try { refreshLockIndicators(); } catch (e) {}
    }

    var CACHED_BUCKETS = null;
    var CACHED_BUCKETS_REF = null; // reference to the array that was bucketed

    function bucketByCategory(list, callback) {
        // Synchronous fast path if cached
        if (CACHED_BUCKETS && CACHED_BUCKETS_REF === list) {
            if (callback) callback(CACHED_BUCKETS);
            return CACHED_BUCKETS;
        }
        // If no callback, do it sync (small lists)
        if (!callback || list.length < 3000) {
            var out = {};
            for (var i = 0; i < list.length; i++) {
                var c = list[i].category || 'Uncategorized';
                if (!out[c]) out[c] = [];
                out[c].push(list[i]);
            }
            CACHED_BUCKETS = out;
            CACHED_BUCKETS_REF = list;
            if (callback) callback(out);
            return out;
        }
        // Async chunked for large lists
        var out2 = {};
        var idx = 0;
        var CHUNK = 3000;
        function processChunk() {
            var end = Math.min(idx + CHUNK, list.length);
            for (; idx < end; idx++) {
                var cat = list[idx].category || 'Uncategorized';
                if (!out2[cat]) out2[cat] = [];
                out2[cat].push(list[idx]);
            }
            if (idx < list.length) {
                setTimeout(processChunk, 0);
            } else {
                CACHED_BUCKETS = out2;
                CACHED_BUCKETS_REF = list;
                callback(out2);
            }
        }
        setTimeout(processChunk, 0);
        return null; // async - result via callback
    }

    var _lastHeroCh = null;

    // updateLiveNowBar is declared INSIDE renderLiveInner (it closes over that scope's
    // liveEpgOffset / currentCatChannels / getEpgWindow), so it isn't visible at module
    // scope. renderLiveInner assigns it here on each run so the mini player and the module
    // export can reach the current instance without breaking those closures.
    var _updateLiveNowBarFn = null;
    var _liveShiftEpgFn = null;   // moves the Live TV guide window by whole hours (set by renderLiveInner, used by the remote's Left/Right hold)
    // The channel the user last focused in the guide. Used only as a fallback on a no-arg
    // refresh when focus momentarily isn't on a row (so the box keeps showing the row the
    // user was on rather than jumping). Note: the France 3 / France Inter mismatch was NOT
    // caused here — it was the focus handler resolving the row by ch.id, which is not unique
    // across a 21k-channel list; that now resolves by the row's unique index.
    var _lastNowBarFocusCh = null;
    function updateLiveNowBar(focusedCh, forcePlaying) {
        if (_updateLiveNowBarFn) _updateLiveNowBarFn(focusedCh, forcePlaying);
    }
    // Re-render the hero card's now/next. Called by the EPG re-render hook when a
    // channel's programmes finish loading from IndexedDB (async), so the guide
    // line fills in without waiting for the next navigation. Cheap: just re-runs
    // the hero render for the last channel shown.
    function refreshEpgNowNext() {
        try { if (_lastHeroCh) renderHeroFromChannel(_lastHeroCh); } catch (e) {}
    }

    // Module-scope wrapper: re-render the live guide rows when async EPG data fills in.
    // Delegates to the closure handle established by the live screen (null until then).
    function refreshLiveEpgRows() {
        try { if (liveRefreshEpgRows) liveRefreshEpgRows(); } catch (e) {}
    }

    function renderHeroFromChannel(ch) {
        _lastHeroCh = ch || _lastHeroCh;
        var t = $('#heroTitle'), s = $('#heroSub'), lbl = $('#heroLabel');
        if (!ch) {
            if (t) t.textContent = T('select_a_channel_to_begin');
            if (s) s.textContent = '';
            if (lbl) lbl.textContent = T('now_watching');
            return;
        }
        if (t) {
            var heroType = ch.type === 'stalker' ? ch.stalkerKind : ch.type;
            var heroName = (heroType === 'vod' || heroType === 'series')
                ? vodCleanseItemName(ch.name || '')
                : Util.cleanseDisplayName(ch.name || '');
            t.textContent = heroName;
        }
        // Label: show content type
        if (lbl) {
            var lt = ch.type;
            if (lt === 'stalker') lt = ch.stalkerKind; // map stalker to its kind
            if (lt === 'vod') lbl.textContent = T('last_watched_movie');
            else if (lt === 'series') lbl.textContent = T('last_watched_series');
            else lbl.textContent = T('now_watching');
        }
        var nn = stalkerNowNext(ch.playlistId, ch);
        if (s) {
            if (nn.now) {
                s.textContent = Util.cleanseDisplayName(nn.now.title) + (nn.now.start ? ' (' + Util.formatTimeRange(new Date(nn.now.start), new Date(nn.now.stop)) + ')' : '');
            } else {
                var cat = ch.category || '';
                if (cat === 'VOD') cat = T('ui_movies');
                else cat = vodCleanseCategoryName(cat);
                s.textContent = cat + (ch.playlistName ? ' • ' + Util.cleanseDisplayName(ch.playlistName) : '');
            }
        }
    }

    /* ===== Favorites grid ===== */
    var activeFavType = 'live';

    function renderFavorites() {
        var grid = $('#favGrid');
        if (!grid) return;

        // Wire tab clicks
        var tabs = document.querySelectorAll('[data-fav-type]');
        for (var ti = 0; ti < tabs.length; ti++) {
            (function (tab) {
                tab.onclick = function () {
                    activeFavType = tab.getAttribute('data-fav-type');
                    for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
                    tab.classList.add('active');
                    renderFavGrid(grid);
                };
            })(tabs[ti]);
        }

        renderFavGrid(grid);
    }

    function resetFavoritesToLive() {
        activeFavType = 'live';
        var tabs = document.querySelectorAll('[data-fav-type]');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-fav-type') === 'live') tabs[i].classList.add('active');
            else tabs[i].classList.remove('active');
        }
    }

    function renderFavGrid(grid) {
        Util.empty(grid);
        var favs = Store.getFavorites();
        var filtered = [];
        for (var i = 0; i < favs.length; i++) {
            var entry = favs[i];
            // Normalize: anything that isn't vod or series is live
            var type = entry.type;
            if (type !== 'vod' && type !== 'series') type = 'live';
            if (type === activeFavType) {
                filtered.push(entry);
            }
        }
        if (!filtered.length) {
            var msg = activeFavType === 'live' ? T('ui_no_fav_channels') :
                      activeFavType === 'vod' ? T('ui_no_fav_movies') : T('ui_no_fav_series');
            grid.appendChild(el('div', { 'class': 'search-empty', 'text': msg + ' ' + T('ui_long_press_to_add') }));
            return;
        }
        for (var j = 0; j < filtered.length; j++) {
            var entry2 = filtered[j];
            var favBaseKey = Store.favBase ? Store.favBase(entry2) : entry2.key;
            var ch = findChannelByKey(favBaseKey) || findChannelByKey(entry2.url);
            // The channel list is the active playlist's; never reuse a channel that
            // belongs to a different playlist than this favorite.
            if (ch && ch.playlistId && entry2.playlistId && ch.playlistId !== entry2.playlistId) ch = null;
            ch = ch || {
                id: favBaseKey, name: entry2.name, url: entry2.url || '', logo: entry2.logo || '',
                category: entry2.category || '', playlistId: entry2.playlistId || '', playlistName: entry2.playlistName || '',
                number: j + 1
            };
            // Always use the stored type and playlistName
            ch.type = entry2.type || ch.type || 'live';
            if (entry2.playlistName) ch.playlistName = entry2.playlistName;
            // Restore Stalker identity so the badge + lock glyph resolve correctly
            // (a Stalker fav is stored with its resolved type plus origType/kind).
            if (entry2.origType === 'stalker') {
                ch.type = 'stalker';
                ch.stalkerKind = entry2.stalkerKind || (entry2.type === 'series' ? 'series' : entry2.type === 'vod' ? 'vod' : 'live');
                if (entry2.stalkerCmd) ch.stalkerCmd = entry2.stalkerCmd;
                if (entry2.stalkerId) ch.stalkerId = entry2.stalkerId;
                // The lock was keyed by the Stalker item id; prefer it for the card
                // id so refreshLockIndicators builds the matching key.
                if (entry2.id) ch.id = entry2.id;
            }
            grid.appendChild(makeChannelCard(ch));
        }
        // Stamp lock shields (per-item content locks) on the freshly-built cards —
        // the favorites render path didn't sweep, so locked channels showed none.
        try { refreshLockIndicators(); } catch (e) {}
    }

    /* ===== Stalker lazy mode =====
     * For Stalker playlists the live screen works differently: categories are
     * the portal's GENRES (loaded upfront), and a genre's channels are fetched
     * only when the user opens it (then cached in-memory for the session). This
     * avoids loading tens of thousands of channels upfront (portal-ban risk).
     * Kept as a separate path so Xtream/M3U behaviour is untouched. */
    var stalkerState = null; // { pl, genres:[], channelsByGenre:{} } or null
    var stalkerLoadToken = 0; // increments per genre open; stale loads are ignored

    function setStalkerMode(pl) {
        stalkerState = { pl: pl, genres: [], channelsByGenre: {} };
        resetStalkerEpgThrottles(pl.id);
        setChannels([]); // live screen starts empty; genres drive categories
    }
    function isStalkerMode() { return !!stalkerState; }
    /* Every Stalker live channel loaded this session (all genres opened so far), de-duplicated by
     * id, for read-only consumers such as Sports matching. Makes NO portal request: it only
     * reflects what the user has already opened. Rebuilt only when the loaded total changes. */
    var stalkerAllCache = { n: -1, list: [] };
    function getStalkerChannels() {
        if (!stalkerState) return [];
        if (stalkerState.all && stalkerState.all.list.length) return stalkerState.all.list;   // whole portal list is loaded
        var by = stalkerState.channelsByGenre, n = 0, g;
        for (g in by) if (by.hasOwnProperty(g)) n += (by[g] || []).length;
        if (!n) return [];
        if (stalkerAllCache.n === n && stalkerAllCache.pl === stalkerState.pl.id) return stalkerAllCache.list;
        var seen = {}, out = [], i, arr;
        for (g in by) {
            if (!by.hasOwnProperty(g)) continue;
            arr = by[g] || [];
            for (i = 0; i < arr.length; i++) {
                if (seen.hasOwnProperty(arr[i].id)) continue;
                seen[arr[i].id] = 1; out.push(arr[i]);
            }
        }
        stalkerAllCache = { n: n, pl: stalkerState.pl.id, list: out };
        return out;
    }
    function clearStalkerMode() { stalkerState = null; }

    function setStalkerGenres(pl, genres) {
        if (!stalkerState || stalkerState.pl.id !== pl.id) {
            stalkerState = { pl: pl, genres: [], channelsByGenre: {} };
        }
        stalkerState.genres = genres || [];
    }

    /* Render the genre list as the live category column. Called by renderHome
     * when in Stalker mode instead of the channel-bucketing path. */
    function renderStalkerCategories() {
        var catListEl = $('#liveCatList');
        var chListEl = $('#liveChList');
        if (!catListEl || !chListEl || !stalkerState) return;

        // Establish the shared guide channel-render closure (liveRenderChannels)
        // bound to the real channel column, by running renderLiveInner once with
        // no buckets. It clears the columns; we then render genre categories over
        // the empty category list. This lets Stalker channels render through the
        // exact same code as Xtream/M3U.
        renderLiveInner(catListEl, chListEl, {});

        Util.empty(catListEl); Util.empty(chListEl);

        var genres = stalkerState.genres;
        if (!genres.length) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
            return;
        }

        // Match the Xtream/M3U live category behaviour so the category and
        // content-lock managers work for Stalker live too: each item carries
        // _catName (the manager reads this — without it the manager fell back to
        // the numeric genre id), hidden categories are skipped, the saved custom
        // order is applied, and category locks prompt for a PIN. type key 'live'.
        var TYPE = 'live';
        var plId = Store.getActivePlaylistId();
        var hiddenCats = Store.getHiddenCategories ? Store.getHiddenCategories(plId, TYPE) : {};

        // Give each genre a display name and sort it the SAME way the category
        // manager does (Util cleanse: strip leading whitespace AND a leading
        // pipe, then Latin-first). Both paths must use identical cleanse+sort or
        // the on-screen order and the Manage Categories order disagree.
        var glist = genres.slice(0);
        function liveCleanse(n) {
            return (Util.decodeHtmlEntities ? Util.decodeHtmlEntities(String(n || '')) : String(n || ''))
                .replace(/^\s+|^\|+|\s+$/g, '');
        }
        for (var gi = 0; gi < glist.length; gi++) glist[gi]._clean = liveCleanse(glist[gi].title);
        var liveSortMode = Store.getItemSort ? Store.getItemSort(plId, TYPE) : 'az';
        for (var gp = 0; gp < glist.length; gp++) glist[gp]._pi = gp;
        var provNames = [];
        for (var gq = 0; gq < glist.length; gq++) if (provNames.indexOf(glist[gq]._clean) < 0) provNames.push(glist[gq]._clean);
        providerCatNames.live = provNames;
        glist.sort(function (a, b) {
            // The portal's "All" (id '*') always leads the default order; a saved custom order still wins.
            var aAll = String(a.id) === '*', bAll = String(b.id) === '*';
            if (aAll !== bAll) return aAll ? -1 : 1;
            if (liveSortMode === 'provider') return a._pi - b._pi;
            var r = catKeyCmp(catSortKey('live', a.title), catSortKey('live', b.title));
            return liveSortMode === 'za' ? -r : r;
        });

        // Apply the user's saved custom order (Manage Categories), keyed by name.
        if (Store.applyCustomCategoryOrder) {
            var byName = {};
            var defaultOrderNames = [];
            for (var ci = 0; ci < glist.length; ci++) {
                var cn = glist[ci]._clean;
                if (!byName[cn]) { byName[cn] = glist[ci]; defaultOrderNames.push(cn); }
            }
            var reordered = Store.applyCustomCategoryOrder(plId, TYPE, defaultOrderNames);
            var newG = [];
            for (var ri = 0; ri < reordered.length; ri++) {
                if (byName[reordered[ri]]) newG.push(byName[reordered[ri]]);
            }
            if (newG.length === glist.length) glist = newG;
        }

        // ===== Stalker CARD view: no DOM genre column =====
        // Build the same in-memory category model the Xtream path uses, but each
        // entry carries a loader that lazy-fetches its channels (openStalkerGenre),
        // which renders through the shared card grid. No hidden column; matches the
        // movies/series + Xtream-live card refactor.
        if (Store.getViewMode && Store.getViewMode('live') === 'card') {
            var sCats = [];
            for (var sgi = 0; sgi < glist.length; sgi++) {
                (function (g) {
                    var catName = g._clean || g.title || 'Unknown';
                    if (hiddenCats[catName]) return;
                    sCats.push({
                        gid: g.id,
                        name: catName,
                        // Cross-protocol inconsistency (the same data on the same screen
                        // showed differently for Xtream and Stalker): this used
                        // to display catName (g._clean, the leading-pipe-
                        // stripped SORT/dedup key) instead of the raw title.
                        // Xtream's own equivalent card path — and its list
                        // sidebar below — always displays the RAW name through
                        // cleanseDisplayName (which strips decorative Unicode/
                        // emoji junk, never a plain "|"), and only ever uses a
                        // stripped key internally for sorting. catName/_clean
                        // still exists and is unchanged for its real purpose —
                        // hiding, ordering, agreeing with Manage Categories —
                        // just no longer doubles as what the user sees.
                        display: Util.cleanseDisplayName ? Util.cleanseDisplayName(g.title || catName) : (g.title || catName),
                        channels: stalkerState.channelsByGenre[g.id] || [],
                        loader: function () { openStalkerGenre(g, null, catListEl, chListEl); }
                    });
                })(glist[sgi]);
            }
            liveCardState = { cats: sCats, currentName: null };
            if (sCats.length) {
                var startCat = sCats[0];                           // open the portal's "All" first, like other Stalker players
                for (var sci = 0; sci < sCats.length; sci++) if (String(sCats[sci].gid) === '*') { startCat = sCats[sci]; break; }
                liveCardState.currentName = startCat.name;
                startCat.loader();
                if (window.App && App.updateLiveCardCatName) App.updateLiveCardCatName();
            }
            landCardFocusOnBar('livetv', catListEl);
            return; // no DOM genre column in card view
        }

        var firstShown = null, allShown = null, allGenre = null;
        for (var i = 0; i < glist.length; i++) {
            (function (g, idx) {
                var catName = g._clean || g.title || 'Unknown';
                if (hiddenCats[catName]) return; // skip hidden categories
                var item = el('div', {
                    'class': 'panel-cat-item focusable',
                    'tabindex': '-1',
                    'data-cat': g.id,
                    'data-focus-key': 'gcat-' + idx
                });
                // Same as the card-view path above — display the raw
                // title (matching Xtream's own sidebar convention), not the
                // stripped catName/_clean sort key. _catName below stays as
                // the cleansed key; it's read elsewhere for hide/lock lookups
                // keyed the same way Manage Categories keys them, unrelated to
                // what's actually shown here.
                item.textContent = Util.cleanseDisplayName ? Util.cleanseDisplayName(g.title || catName) : (g.title || catName);
                item._catName = catName;
                item.addEventListener('click', function () {
                    if (typeof isUiCategoryLocked === 'function' && isUiCategoryLocked(TYPE, catName, plId)) {
                        requireUiUnlock(T('ui_unlock_category'), function () { item.click(); });
                        return;
                    }
                    openStalkerGenre(g, item, catListEl, chListEl);
                });
                catListEl.appendChild(item);
                if (!firstShown) firstShown = item;
                if (String(g.id) === '*') { allShown = item; allGenre = g; }
            })(glist[i], i);
        }
        if (firstShown) firstShown.classList.add('active');
        else catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
        // Open the portal's "All" straight away, like other Stalker players (its channels come from the
        // one whole-list load; nothing is fetched per genre when that has succeeded).
        if (allShown) openStalkerGenre(allGenre, allShown, catListEl, chListEl);
    }

    /* ===== Stalker: load the WHOLE portal list (like other Stalker players) =====
     * One streamed request (server get_all_channels), or, when the portal has no such action, a walk
     * over the paged '*' genre. Every genre is then derived locally from the one list (no per-genre
     * portal calls), the list is cached for an instant next launch, and live channels are added to
     * the global search index. If the load fails, everything falls back to the old per-genre loading. */
    function stalkerCatName(title) {
        return (Util.decodeHtmlEntities ? Util.decodeHtmlEntities(String(title || '')) : String(title || '')).replace(/^\s+|^\|+|\s+$/g, '');
    }
    /* Split the list into per-genre arrays on the shared state. Hidden categories stay out of "All". */
    function stalkerApplyAll(st, list) {
        var genres = st.genres || [], byG = {}, hidden = {}, visible = [], i, g, gid;
        var hiddenCats = {};
        try { hiddenCats = (Store.getHiddenCategories && Store.getHiddenCategories(st.pl.id, 'live')) || {}; } catch (eH) {}
        for (i = 0; i < genres.length; i++) {
            g = genres[i];
            if (String(g.id) !== '*') byG[g.id] = [];
            if (hiddenCats[stalkerCatName(g.title)]) hidden[g.id] = 1;
        }
        for (i = 0; i < list.length; i++) {
            var c = list[i];
            gid = c.stalkerGenreId;
            if (byG.hasOwnProperty(gid)) byG[gid].push(c);
            if (!hidden.hasOwnProperty(gid)) visible.push(c);
        }
        for (gid in byG) if (byG.hasOwnProperty(gid)) st.channelsByGenre[gid] = byG[gid];
        st.channelsByGenre['*'] = visible;
        st.all.list = list;
    }
    /* Put the live channels into the global search index. Nothing else builds the index for a Stalker
     * playlist, so the first call resets it (dropping a previous playlist's entries) and marks it ready;
     * without that Search silently fell back to the channels of the one genre on screen. Later calls only
     * add what is new (addItems skips ids it has already seen). */
    function stalkerIndexForSearch(st, list) {
        try {
            if (typeof GlobalSearch === 'undefined') return;
            if (!st.all.indexed) { st.all.indexed = true; GlobalSearch.buildIndex({ channels: [], movies: [], series: [] }); }
            if (GlobalSearch.addItems) GlobalSearch.addItems('live', list, st.pl.name);
        } catch (eS) {}
    }
    var stalkerAllCfg = { retryScale: 1 };      // tests shrink the waits; production leaves it at 1
    function startStalkerLoadAll(pl) {
        var st = stalkerState;
        if (!st || st.pl.id !== pl.id || st.all) return;          // not Stalker, switched away, or already started
        var a = st.all = { list: [], loading: true, done: false, paged: false, failed: false, hydrated: false, onDone: null, shown: 0 };
        function current() { return stalkerState === st; }
        var titleById = {}, gi;
        for (gi = 0; gi < (st.genres || []).length; gi++) titleById[st.genres[gi].id] = st.genres[gi].title;
        var pseudo = { id: '*', title: 'Live', titleById: titleById };

        function wake() { var cb = a.onDone; a.onDone = null; if (cb) cb(); }
        // The genre on screen may be showing a partial/old list: draw it again from the final data.
        function refreshOpen() {
            var l = st.lastOpen;
            if (!l || !l.catListEl || !document.body.contains(l.catListEl)) return;
            var have = st.channelsByGenre[l.genre.id];
            if (have && have.length === a.shown) return;           // nothing new to show: leave focus alone
            st.lastOpen = null;
            openStalkerGenre(l.genre, l.itemEl, l.catListEl, l.chListEl);
        }
        function complete(list) {
            if (!current()) return;
            stalkerApplyAll(st, list);
            a.done = true; a.loading = false; a.failed = false;
            stalkerIndexForSearch(st, list);
            try { if (Store.cacheChannelsAsync) Store.cacheChannelsAsync(st.pl.id, list); } catch (eC) {}
            if (a.onDone) wake(); else refreshOpen();
        }
        function fail() {
            if (!current()) return;
            a.loading = false; a.failed = true;
            wake();                                               // a waiting genre falls back to its own fetch
        }

        // 1) instant start from the last saved copy (refreshed from the network below)
        try {
            if (Store.readCachedChannelsAsync) {
                Store.readCachedChannelsAsync(st.pl.id).then(function (cached) {
                    if (!current() || a.done || a.list.length || !cached || !cached.length || cached[0].type !== 'stalker') return;
                    stalkerApplyAll(st, cached);
                    a.hydrated = true; a.shown = (st.channelsByGenre['*'] || []).length;
                    stalkerIndexForSearch(st, cached);
                    wake();
                })['catch'](function () {});
            }
        } catch (eR) {}

        // 2) paged walk (portal without get_all_channels)
        function paged() {
            if (!current()) return;
            a.paged = true;
            var acc = [], start = 1;
            wake();                                               // a genre waiting on the single request may use its own fetch meanwhile
            (function next(retries) {
                Api.stalkerChannelsPage(pl, '*', 100, start).then(function (res) {
                    if (!current()) return;
                    var more = mapStalkerChannels(pl, (res && res.channels) || [], pseudo);
                    for (var k = 0; k < more.length; k++) acc.push(more[k]);
                    if (res && res.nextPage && more.length) { start = res.nextPage; setTimeout(function () { next(3); }, 400 * stalkerAllCfg.retryScale); }
                    else if (acc.length) complete(acc);
                    else fail();
                })['catch'](function (e) {
                    if (!current()) return;
                    var status = e && e.status;
                    if (retries > 0 && (status === 429 || status === 503 || status === 504 || !status)) {
                        setTimeout(function () { next(retries - 1); }, 1500 * (4 - retries) * stalkerAllCfg.retryScale);
                        return;
                    }
                    fail();
                });
            })(3);
        }

        // 3) the single streamed request
        (function viaAll(retries) {
            Api.stalkerChannelsAll(pl).then(function (res) {
                if (!current()) return;
                var raw = (res && res.channels) || [];
                if (res && !res.unsupported && raw.length) complete(mapStalkerChannels(pl, raw, pseudo));
                else paged();
            })['catch'](function (e) {
                if (!current()) return;
                var status = e && e.status;
                if (status === 401 || status === 400) { fail(); return; }
                if (retries > 0 && (status === 429 || status === 503)) {      // server busy / rate limit: wait and retry
                    setTimeout(function () { viaAll(retries - 1); }, 3000 * (4 - retries) * stalkerAllCfg.retryScale);
                    return;
                }
                paged();                                                        // dropped stream, timeout, 5xx: use the gentler paged walk
            });
        })(3);
    }

    /* Open a genre: fetch its channels (cached after first time), then render
     * them into the channel column. Shows a loading state while fetching. */
    function openStalkerGenre(genre, itemEl, catListEl, chListEl) {
        var items = catListEl.querySelectorAll('.panel-cat-item');
        for (var j = 0; j < items.length; j++) items[j].classList.remove('active');
        if (itemEl) itemEl.classList.add('active');
        // Record the loaded category (its data-cat = genre.id) so left-from-content
        // returns focus here, like the Xtream/M3U paths do.
        if (catListEl) catListEl.setAttribute('data-cat-loaded', genre.id);

        var title = $('#liveCatTitle');
        var count = $('#liveCatCount');
        // NOTE: #liveCatTitle does not exist anywhere in index.html or the
        // CSS — $('#liveCatTitle') returns null, so the "if (title)" guard
        // below is always false and this line never actually runs.
        // Vestigial/dead code, not a real display path — confirmed while
        // investigating the leading-"|" inconsistency (that turned out to be
        // genuinely cross-protocol, in the .panel-cat-item sidebar/card
        // rendering above, not here — see the fix there instead). Left
        // as-is rather than removed outright, since deleting dead code
        // wasn't what was asked and it's harmless either way.
        if (title) title.textContent = genre._clean || genre.title;

        // Mark this as the latest requested genre. Each fetch carries this token
        // and only renders if it's still current — so rapid clicking between
        // categories can't pile up overlapping renders, and only the genre the
        // user actually landed on loads (others are abandoned, easing the shared
        // rate-limit bucket).
        stalkerLoadToken = (stalkerLoadToken || 0) + 1;
        var myToken = stalkerLoadToken;

        stalkerState.lastOpen = { genre: genre, itemEl: itemEl, catListEl: catListEl, chListEl: chListEl };

        var cached = stalkerState.channelsByGenre[genre.id];
        if (cached) {
            if (count) count.textContent = cached.length + ' channels';
            if (stalkerState.all) stalkerState.all.shown = cached.length;
            setChannels(cached);
            if (liveRenderChannels) liveRenderChannels(cached);
            return;
        }

        // The whole portal list is on its way (one request): wait for it instead of asking the
        // portal genre by genre. A failed load, or the paged walk, lets this genre fetch itself below.
        var allSt = stalkerState.all;
        if (allSt && allSt.loading && !allSt.paged && !allSt.done) {
            Util.empty(chListEl);
            chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_channels') }));
            if (count) count.textContent = '…';
            allSt.onDone = function () {
                if (!stalkerState || myToken !== stalkerLoadToken) return;
                stalkerState.lastOpen = null;
                openStalkerGenre(genre, itemEl, catListEl, chListEl);
            };
            return;
        }

        Util.empty(chListEl);
        chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_channels') }));
        if (count) count.textContent = '…';

        // Stop any EPG batch dedupe state from a previously-opened genre so it
        // doesn't block this genre's own batch from firing once its channels load.
        stalkerEpgBatchInFlight = {};

        fetchStalkerChannels(stalkerState.pl, genre, count, chListEl, 3, myToken);
    }

    /* Fetch a genre's channels. retriesLeft allows several backed-off retries
     * on a rate-limit (the /channels and /epg endpoints share one bucket, so a
     * 429 is expected when the user clicks quickly). token is the load token
     * from openStalkerGenre: if a newer genre has since been requested, this
     * fetch's result is abandoned (no render, no toast) so stale loads can't
     * stack up or fight for the bucket. Backoff grows with each retry. */
    function fetchStalkerChannels(pl, genre, count, chListEl, retriesLeft, token) {
        Api.stalkerChannels(pl, genre.id).then(function (res) {
            if (!stalkerState || stalkerState.pl.id !== pl.id) return; // switched away
            if (token && token !== stalkerLoadToken) return;           // superseded by a newer click
            var raw = (res && res.channels) || [];
            var channels = mapStalkerChannels(pl, raw, genre);
            stalkerState.channelsByGenre[genre.id] = channels;
            if (count) count.textContent = channels.length + ' channels';
            setChannels(channels);
            if (liveRenderChannels) liveRenderChannels(channels);
            loadStalkerEpgForPage(channels, genre.id);
        })['catch'](function (e) {
            if (token && token !== stalkerLoadToken) return;           // superseded — stay silent
            var status = e && e.status;
            var transient = (status === 429 || status === 503 || status === 504 || !status);
            if (retriesLeft > 0 && transient) {
                // Escalating backoff: more breathing room each attempt so a burst
                // of rapid clicks settles instead of hammering the bucket.
                var delay = 900 + (3 - retriesLeft) * 700;
                setTimeout(function () {
                    if (!stalkerState || stalkerState.pl.id !== pl.id) return;
                    if (token && token !== stalkerLoadToken) return;
                    if (!isGenreActive(genre.id)) return;
                    fetchStalkerChannels(pl, genre, count, chListEl, retriesLeft - 1, token);
                }, delay);
                return;
            }
            Util.empty(chListEl);
            chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_channels_try_again') }));
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_channels') + ' ' + stalkerErrText(e), 'err')
        });
    }

    /* Map server stalker channel objects to the app channel model. No direct
     * URL — the player resolves it per-play via Api.stalkerResolve. */
    /* Stalker channels carry a portal-native identifier (tvgId/epgId, the
     * portal's own numeric id — see mapStalkerChannels) that the portal's
     * own get_short_epg data is injected/keyed under, and separately an
     * xmltvId for matching an external XMLTV EPG source when the portal
     * provides one and the user has configured one. Try the native portal
     * identifier first (fast, in-memory, unchanged from before this
     * existed); only if that comes back completely empty AND the channel
     * has an xmltvId, retry via that — lets a configured external EPG
     * serve a Stalker channel the portal itself has no data for right now,
     * without changing the primary lookup or its priority for any channel,
     * Stalker or otherwise. Safe to call for non-Stalker channels too
     * (ch.xmltvId is simply undefined there, so the fallback never fires).
     */
    function stalkerNowNext(playlistId, ch) {
        var nn = Epg.getNowNext(playlistId, ch.tvgId || ch.epgId);
        if ((!nn || (!nn.now && !nn.next)) && ch.xmltvId) {
            var nn2 = Epg.getNowNext(playlistId, ch.xmltvId);
            if (nn2 && (nn2.now || nn2.next)) return nn2;
        }
        return nn;
    }

    /* Same fallback shape as stalkerNowNext, for the scrolled-guide-window
     * lookup (Epg.getProgrammesBetween) rather than the live now/next one —
     * kept separate because the two Epg functions have different
     * signatures and empty-result shapes ([] vs {now,next}), not because
     * the reasoning differs. */
    function stalkerProgrammesBetween(playlistId, ch, winStart, winEnd) {
        var list = Epg.getProgrammesBetween(playlistId, ch.tvgId || ch.epgId, winStart, winEnd);
        if ((!list || !list.length) && ch.xmltvId) {
            var list2 = Epg.getProgrammesBetween(playlistId, ch.xmltvId, winStart, winEnd);
            if (list2 && list2.length) return list2;
        }
        return list;
    }

    function mapStalkerChannels(pl, channels, genre) {
        var out = [], hasArch = false;
        for (var i = 0; i < channels.length; i++) {
            var c = channels[i];
            out.push({
                id: pl.id + ':' + c.id,
                name: c.name || ('Channel ' + c.id),
                url: '',
                logo: c.logo || '',
                category: (genre.titleById && genre.titleById[c.genreId]) || genre.title || 'Live',
                tvgId: String(c.id),   // key for injected short-EPG
                epgId: String(c.id),
                // Separate from tvgId/epgId deliberately — those
                // two stay the portal's own internal numeric id (unchanged,
                // still what get_short_epg injection/lookup key off, zero
                // regression risk), because an external XMLTV feed's
                // <channel id="..."> values will essentially never
                // coincidentally match that internal number. This carries
                // the portal's own external-EPG-matching id (now forwarded
                // by the server — see stalker.js) so a fallback lookup can
                // actually align against an external XMLTV source when one
                // is configured. Empty when the portal doesn't provide one.
                xmltvId: c.xmltvId ? String(c.xmltvId) : '',
                number: c.number || (i + 1),
                playlistId: pl.id,
                playlistName: pl.name,
                type: 'stalker',
                stalkerId: c.id,
                stalkerCmd: c.cmd,
                stalkerGenreId: c.genreId || genre.id,
                archiveHours: Number(c.archiveHours) > 0 ? Number(c.archiveHours) : 0
            });
            if (c.archiveHours > 0) hasArch = true;
        }
        // The Catch-up menu entry appears once a loaded list holds an archive channel.
        if (hasArch) setTimeout(function () { try { if (window.CatchupScreen) CatchupScreen.refreshNav(); } catch (eCu) {} }, 60);
        return out;
    }

    /* Fetch short-EPG for a page of Stalker channels and inject into the Epg
     * store, then re-render so programme blocks appear.
     *
     * REWORKED (was a per-channel queue, one request per channel, paced with a
     * gap + backoff to avoid bursting the server's rate limit): the real
     * constraint turned out to be a hard 30-requests-PER-MINUTE budget shared
     * across every Stalker list-type call (genres/channels/vod/series/epg —
     * see stalker-routes.js's limList), not a request-RATE limit. A single
     * genre's EPG alone could need up to STALKER_EPG_PAGE (50) requests —
     * no amount of client-side pacing fits that under 30/min, since the limit
     * caps total COUNT per window, not how fast they're spaced. Confirmed by
     * cross-checking the pairing server's own source: earlier gap/backoff
     * tuning (multiple rounds) was solving the wrong dimension entirely.
     * Fixed at the source instead: one POST to /api/stalker/epg/batch per
     * page, server-side fetching each channel from the PORTAL (unaffected by
     * our own per-IP limiter, which only gates app->server) and returning
     * them all in one response. A 50-channel page now costs 1 request against
     * the 30/min budget instead of 50. Bounded to the visible page and
     * de-duplicated via stalkerState.epgFetched, same as before. Failures are
     * silent — blank programme strips are acceptable. */
    // Was 30, capping each fetch to the first 30 channels of
    // whatever array was passed in — harmless back when this only ran once
    // per genre-open, but now that renderLiveChannels re-triggers this on
    // every page render (see that call site), it needs to cover a whole
    // page's worth, not less than it. Must match (or exceed) CAT_PAGE_SIZE
    // in renderLiveInner (currently 50) — that constant lives in a
    // different function's local scope and can't be referenced directly
    // from here, so keep these two in sync by hand if either changes.
    var STALKER_EPG_PAGE = 50;
    var stalkerEpgBatchInFlight = {};   // playlistId|genreId -> true, dedupes concurrent batch calls for the same page
    var stalkerEpgBatchFailedAt = {};   // same key -> Date.now() of the last batch failure
    var STALKER_EPG_BATCH_COOLDOWN_MS = 5000; // don't retry a failed page's batch faster than this
    // A batch where EVERY channel genuinely errored (the server's actionFailed
    // flag: the provider's EPG action was down or broken) is NOT a final answer
    // the way "this channel has no programmes" is, so its channels are un-marked
    // and retried on a later render. Longer cooldown than a network failure,
    // so a portal whose EPG action is permanently broken isn't hit with a full
    // page of requests on every render, while one that recovers is picked up
    // within a minute of the next render.
    var STALKER_EPG_ACTION_FAILED_COOLDOWN_MS = 60000;
    var stalkerEpgActionFailedAt = {}; // playlistId|genreId -> Date.now()

    // Activating or refreshing a playlist means "try again": drop any retry
    // cooldowns for it so a source refresh isn't held back by a previous failure.
    function resetStalkerEpgThrottles(plId) {
        var prefix = plId + '|', k;
        for (k in stalkerEpgBatchFailedAt) if (stalkerEpgBatchFailedAt.hasOwnProperty(k) && k.indexOf(prefix) === 0) delete stalkerEpgBatchFailedAt[k];
        for (k in stalkerEpgActionFailedAt) if (stalkerEpgActionFailedAt.hasOwnProperty(k) && k.indexOf(prefix) === 0) delete stalkerEpgActionFailedAt[k];
    }

    // "Guide unavailable" toast. Shown at most once per session per playlist,
    // and it resets on app restart (in-memory) and on playlist change
    // (the flags live on stalkerState, which is recreated whenever a
    // playlist is (re)activated). Nothing is persisted: EPG being down can
    // be a temporary provider outage, so no claim is made that this
    // provider has no guide, and there is no permanent "seen" flag.
    //
    // Trigger: the pairing server's actionFailed flag (stalker.js
    // getShortEpgBatch) is true only when EVERY channel in a batch genuinely
    // ERRORED. Channels that simply have no programme data (routine on real
    // playlists) never set it. Requires 2 consecutive fully-failed batches so
    // a single transient blip doesn't trigger it, and any batch that is not a
    // full failure resets the streak. Skipped when EPG is turned off for the
    // playlist, and when an external EPG is already configured.
    var STALKER_EPG_TOAST_STREAK = 2;

    function maybeToastEpgUnavailable(pl) {
        try {
            if (!stalkerState || stalkerState.pl.id !== pl.id) return;
            if (Store.getPlaylistEpgEnabled && !Store.getPlaylistEpgEnabled(pl.id)) return;
            if (stalkerState.epgToastShown) return;
            if ((stalkerState.epgFailStreak || 0) < STALKER_EPG_TOAST_STREAK) return;
            if (window.Epg && Epg.hasEpgSource && Epg.hasEpgSource(pl)) return;
            stalkerState.epgToastShown = true;
            if (window.UI && UI.toast) UI.toast(T('ap_epg_unavailable_toast'));
        } catch (eToast) {}
    }

    function loadStalkerEpgForPage(channels, genreId) {
        if (!stalkerState || !channels || !channels.length) return;
        if (!stalkerState.epgFetched) stalkerState.epgFetched = {};
        var pl = stalkerState.pl;
        if (Store.getPlaylistEpgEnabled && !Store.getPlaylistEpgEnabled(pl.id)) return;

        var batch = channels.slice(0, STALKER_EPG_PAGE);
        var need = [];
        for (var i = 0; i < batch.length; i++) {
            if (!stalkerState.epgFetched[batch[i].stalkerId]) need.push(batch[i]);
        }
        if (!need.length) return;

        var cooldownKey = pl.id + '|' + genreId;
        if (stalkerEpgBatchInFlight[cooldownKey]) return; // already fetching this page
        var failedAt = stalkerEpgBatchFailedAt[cooldownKey];
        if (failedAt && (Date.now() - failedAt) < STALKER_EPG_BATCH_COOLDOWN_MS) return;
        var actionFailedAt = stalkerEpgActionFailedAt[cooldownKey];
        if (actionFailedAt && (Date.now() - actionFailedAt) < STALKER_EPG_ACTION_FAILED_COOLDOWN_MS) return;

        stalkerEpgBatchInFlight[cooldownKey] = true;
        var ids = [];
        var byId = {};
        for (var j = 0; j < need.length; j++) {
            // Marked BEFORE the request fires, same in-flight-dedupe convention
            // as the old per-channel queue — stops a concurrent render
            // re-batching the same channels while this request is outstanding.
            stalkerState.epgFetched[need[j].stalkerId] = true;
            ids.push(need[j].stalkerId);
            byId[need[j].stalkerId] = need[j];
        }

        Api.stalkerEpgBatch(pl, ids).then(function (res) {
            delete stalkerEpgBatchInFlight[cooldownKey];
            if (!stalkerState || stalkerState.pl.id !== pl.id) return;
            var map = (res && res.epg) || {};
            var gotAny = false;
            for (var id in map) {
                if (!map.hasOwnProperty(id) || !byId[id]) continue;
                var progs = normalizeStalkerEpg(map[id]);
                if (progs.length) {
                    Epg.setChannelProgrammes(pl.id, byId[id].tvgId, progs);
                    gotAny = true;
                }
                // An empty-but-present entry is a real, final answer (this channel
                // genuinely has no EPG right now) and stays marked fetched. This is
                // routine — most real playlists have partial EPG coverage — and is
                // NOT by itself any signal that the portal's EPG is broken; see
                // actionFailed below for the actual reliable signal for that.
            }
            if (gotAny) scheduleStalkerEpgRerender(genreId);
            if (res && res.actionFailed) {
                // Every channel errored: not a final answer. Un-mark them so a
                // later render retries (after the cooldown) instead of treating
                // a provider outage as "no EPG" for the rest of the session.
                for (var u = 0; u < ids.length; u++) delete stalkerState.epgFetched[ids[u]];
                stalkerEpgActionFailedAt[cooldownKey] = Date.now();
                stalkerState.epgFailStreak = (stalkerState.epgFailStreak || 0) + 1;
                maybeToastEpgUnavailable(pl);
            } else {
                delete stalkerEpgActionFailedAt[cooldownKey];
                stalkerState.epgFailStreak = 0;
            }
        })['catch'](function () {
            delete stalkerEpgBatchInFlight[cooldownKey];
            // The whole batch request failed (429/timeout/network) — clear every
            // channel in it so a later call can retry, but record the failure so
            // this exact page isn't immediately re-batched by the very next
            // render (any other genre's activity, a focus change, etc.).
            if (stalkerState && stalkerState.epgFetched) {
                for (var k = 0; k < ids.length; k++) delete stalkerState.epgFetched[ids[k]];
            }
            stalkerEpgBatchFailedAt[cooldownKey] = Date.now();
        });
    }

    // Re-render the active genre at most once every ~1.5s while EPG trickles in,
    // so blocks appear progressively without re-rendering (and dropping focus)
    // on every single channel's EPG arrival.
    var stalkerEpgRerenderTimer = null;
    function scheduleStalkerEpgRerender(genreId) {
        if (stalkerEpgRerenderTimer) return;
        stalkerEpgRerenderTimer = setTimeout(function () {
            stalkerEpgRerenderTimer = null;
            if (stalkerState && stalkerState.channelsByGenre[genreId] &&
                liveRenderChannels && isGenreActive(genreId)) {
                // Row focus was lost when EPG data filled in: liveRenderChannels
                // does a full Util.empty() + rebuild-from-scratch of every row, with
                // no focus-preservation of its own — reasonable for an intentional
                // navigation (genre switch, pagination), but THIS call is a SILENT
                // BACKGROUND re-render nobody asked for (EPG data trickling in while
                // the user is just browsing). Losing focus to that is disorienting.
                // Capture the currently-focused row's key beforehand and restore it
                // afterward, if it still exists post-rebuild. Scoped to just this
                // call site, not a change to liveRenderChannels itself — its other
                // (intentional-navigation) callers already handle their own focus.
                var focusKeyBefore = null;
                try {
                    var curEl = window.Focus && Focus.current ? Focus.current() : null;
                    if (curEl && curEl.getAttribute) focusKeyBefore = curEl.getAttribute('data-focus-key');
                } catch (eFk) {}
                liveRenderChannels(stalkerState.channelsByGenre[genreId]);
                if (focusKeyBefore && window.Focus && Focus.focusKey) {
                    try { Focus.focusKey(focusKeyBefore); } catch (eFk2) {}
                }
            }
        }, 1500);
    }

    // Is this genre the one currently shown? (avoids re-rendering a genre the
    // user has navigated away from while its EPG trickles in).
    function isGenreActive(genreId) {
        var catListEl = $('#liveCatList');
        if (!catListEl) return false;
        var active = catListEl.querySelector('.panel-cat-item.active');
        return !!(active && String(active.getAttribute('data-cat')) === String(genreId));
    }

    /* The server's short-EPG returns [{title,start,stop,desc}] with epoch
     * SECONDS; the guide store expects {start,stop,title} in epoch MILLIS. */
    function normalizeStalkerEpg(list) {
        if (!list || !list.length) return [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            var start = Number(e.start) || 0;
            var stop = Number(e.stop) || 0;
            if (start < 1e12) start *= 1000; // seconds -> ms
            if (stop < 1e12) stop *= 1000;
            if (!start || !stop || stop <= start) continue;
            out.push({ start: start, stop: stop, title: e.title || '', desc: e.desc || '' });
        }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    /* ===== Stalker VOD (Movies screen) =====
     * Mirrors the live genre path: categories load upfront (cheap), a category's
     * items load only when opened (then cached for the session). Items map to a
     * channel object with type:'stalker' + stalkerKind:'vod' + the base64 cmd;
     * the player resolves a fresh URL per-play via Api.stalkerVodResolve. Kept
     * separate from the Xtream renderVodScreen path so neither disturbs the other.
     * The portal exposes no TMDB/IMDB ids, so the info panel shows basic data
     * only (poster/year/plot) and subtitle id-lookup is skipped. */
    var stalkerVodState = null; // { pl, cats:[], itemsByCat:{} } or null

    /* Unified Movies/Series search + category-filter context. Both the Xtream
     * (renderVodScreen) and Stalker (renderStalkerVod) paths set the active
     * context here per render; the input listeners (bound once per field) read
     * from it and re-render via the context's own renderer. This makes the
     * search/filter behave identically regardless of playlist type, and avoids
     * stacking a fresh listener on every screen render. Keyed by screen type. */
    var vodSearchCtx = { movies: null, series: null };

    function setVodSearchCtx(type, ctx) {
        vodSearchCtx[type === 'series' ? 'series' : 'movies'] = ctx;
        wireVodSearch(type);
    }

    /* Bind the search + category-filter listeners for a Movies/Series screen
     * once. Each fires against whatever context is currently active for that
     * screen type, so switching playlists (Xtream <-> Stalker) just swaps the
     * context — no rebinding, no stale-closure stacking. */
    function wireVodSearch(type) {
        var isSeries = (type === 'series');
        var searchId = isSeries ? 'seriesSearchField' : 'movieSearchField';
        var filterId = isSeries ? 'seriesCatFilter' : 'movieCatFilter';
        var key = isSeries ? 'series' : 'movies';

        var searchInput = document.getElementById(searchId);
        if (searchInput && !searchInput._vodWired) {
            searchInput._vodWired = true;
            var dbnc = null;
            searchInput.addEventListener('input', function () {
                if (dbnc) clearTimeout(dbnc);
                dbnc = setTimeout(function () {
                    var ctx = vodSearchCtx[key];
                    if (!ctx) return;
                    var items = ctx.getItems() || [];
                    var query = (searchInput.value || '').toLowerCase().trim();
                    if (!query) { ctx.render(items); return; }
                    var results = [];
                    for (var i = 0; i < items.length && results.length < 200; i++) {
                        var nm = items[i].name || items[i].title || '';
                        if (matchesSearch(nm, query)) results.push(items[i]);
                    }
                    ctx.render(results);
                }, 400);
            });
            searchInput.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(searchInput); });
        }

        var catFilter = document.getElementById(filterId);
        if (catFilter && !catFilter._vodWired) {
            catFilter._vodWired = true;
            catFilter.addEventListener('input', function () {
                var ctx = vodSearchCtx[key];
                if (!ctx) return;
                var q = (catFilter.value || '').toLowerCase().trim();
                var its = ctx.catListEl.querySelectorAll('.panel-cat-item, .cat-item');
                for (var fi = 0; fi < its.length; fi++) {
                    var text = (its[fi].textContent || '').toLowerCase();
                    its[fi].style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
                }
            });
            catFilter.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(catFilter); });
        }
    }

    function renderStalkerVod(catListEl, chListEl, pl) {
        Util.empty(catListEl); Util.empty(chListEl);
        if (!stalkerVodState || stalkerVodState.pl.id !== pl.id) {
            stalkerVodState = { pl: pl, cats: [], itemsByCat: {} };
        }
        catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_categories') }));
        // Register this screen's search/filter context (Movies). getItems returns
        // the open category's items; render re-renders the list. Same contract the
        // Xtream path uses, so search/filter behave identically.
        setVodSearchCtx('movies', {
            catListEl: catListEl,
            getItems: function () { return (stalkerVodState && stalkerVodState.currentItems) || []; },
            render: function (items) { chListEl._showCount = 0; renderStalkerVodItems(chListEl, items, pl); }
        });
        fetchStalkerVodCategories(catListEl, chListEl, pl, true);
    }

    function fetchStalkerVodCategories(catListEl, chListEl, pl, allowRetry) {
        Api.stalkerVodCategories(pl).then(function (res) {
            if (!isStalkerVodActive(pl)) return;
            var cats = (res && res.categories) || [];
            stalkerVodState.cats = cats;
            renderStalkerVodCategories(catListEl, chListEl, pl, cats);
        })['catch'](function (e) {
            if (!isStalkerVodActive(pl)) return;
            var status = e && e.status;
            // Same transient handling as item loads: retry once (including on a
            // status-less network blip) before surfacing any error, so the
            // first-load "HTTP ?" alert doesn't fire when a retry recovers.
            var transient = (status === 429 || status === 503 || status === 504 || !status);
            if (allowRetry && transient) {
                setTimeout(function () {
                    if (!isStalkerVodActive(pl)) return;
                    fetchStalkerVodCategories(catListEl, chListEl, pl, false);
                }, 1200);
                return;
            }
            Util.empty(catListEl);
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_categories_try_again') }));
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_vod_categories') + ' ' + stalkerErrText(e), 'err')
        });
    }

    function renderStalkerVodCategories(catListEl, chListEl, pl, cats) {
        Util.empty(catListEl);
        if (!cats.length) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
            return;
        }

        // Give each category a cleansed display name (prefix-stripped), then run
        // the same sort/custom-order/hidden pipeline the Xtream Movies path uses,
        // so Stalker behaves identically. type key is 'movies' (Movies screen).
        var TYPE = 'movies';
        for (var c = 0; c < cats.length; c++) cats[c]._clean = vodCleanseCategoryName(cats[c].title);

        // Alphabetical, Latin-first (same rule as Xtream categories).
        orderCatsByMode(cats, function (c) { return c.title; }, 'movies', pl);

        // Apply the user's saved custom order (Manage Categories), keyed by the
        // cleansed name — exactly as the Xtream path does.
        var plId = Store.getActivePlaylistId();
        if (Store.applyCustomCategoryOrder) {
            var byName = {};
            var defaultOrderNames = [];
            for (var ci = 0; ci < cats.length; ci++) {
                var cn = cats[ci]._clean;
                if (!byName[cn]) { byName[cn] = cats[ci]; defaultOrderNames.push(cn); }
            }
            var reordered = Store.applyCustomCategoryOrder(plId, TYPE, defaultOrderNames);
            var newCats = [];
            for (var ri = 0; ri < reordered.length; ri++) {
                if (byName[reordered[ri]]) newCats.push(byName[reordered[ri]]);
            }
            if (newCats.length === cats.length) cats = newCats;
        }

        var hidden = Store.getHiddenCategories ? Store.getHiddenCategories(plId, TYPE) : {};
        var firstShown = null;

        // NOTE: duplicate-named categories are NOT collapsed on the Stalker path.
        // The Xtream path merges duplicates by fetching all their ids and unioning
        // the content (see renderVodScreen), but Stalker loads content per-genre
        // lazily and fetching multiple genres per row risks the MAC-ban problem
        // the lazy loader exists to avoid. A keep-first dedup would silently drop
        // titles that live only in the second copy (provider duplicates overlap
        // but aren't identical), which is worse than showing two rows. So leave
        // Stalker as-is until a genre-safe merge is built (tracked in KNOWN-ITEMS).

        // ===== Card view: no DOM category column (Stalker VOD) =====
        if (Store.getViewMode && Store.getViewMode('movies') === 'card') {
            var cardCatsV = [];
            for (var cvi = 0; cvi < cats.length; cvi++) {
                var cvName = cats[cvi]._clean || cats[cvi].title || 'Unknown';
                if (hidden[cvName]) continue;
                cardCatsV.push({ id: cats[cvi].id, name: cvName, _catName: cvName, _raw: cats[cvi] });
            }
            vodCardState.movies = { pl: pl, type: 'movies', stalker: true, cats: cardCatsV, currentCatId: null, currentItems: [], catListEl: catListEl };
            setVodSearchCtx('movies', {
                catListEl: catListEl,
                getItems: function () { return (stalkerVodState && stalkerVodState.currentItems) || []; },
                render: function (items) { chListEl._showCount = 0; renderStalkerVodItems(chListEl, items, pl); }
            });
            if (cardCatsV.length) loadVodCategoryCard('movies', cardCatsV[0], chListEl, pl, 'movies');
            else { Util.empty(chListEl); chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') })); }
            if (window.App && App.updateCardCatName) App.updateCardCatName('movies');
            landCardFocusOnBar('movies', null);
            return;
        }

        for (var i = 0; i < cats.length; i++) {
            (function (cat, idx) {
                var catName = cat._clean || cat.title || 'Unknown';
                if (hidden[catName]) return; // respect hidden categories
                var item = el('div', {
                    'class': 'panel-cat-item focusable',
                    'tabindex': '-1',
                    'data-cat': cat.id,
                    'data-focus-key': 'svodcat-' + idx
                });
                item.textContent = vodCleanseCategoryName(catName);
                item._catName = catName;
                item.addEventListener('click', function () {
                    // Honour category lock, same as the Xtream path.
                    if (typeof isUiCategoryLocked === 'function' && isUiCategoryLocked(TYPE, catName, plId)) {
                        requireUiUnlock(T('ui_unlock_category'), function () { item.click(); });
                        return;
                    }
                    openStalkerVodCategory(cat, item, catListEl, chListEl, pl);
                });
                catListEl.appendChild(item);
                if (!firstShown) firstShown = item;
            })(cats[i], i);
        }

        if (!firstShown) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
            return;
        }
        // Auto-open the first visible category so the screen isn't empty on entry.
        firstShown.classList.add('active');
        try { firstShown.click(); } catch (e) {}
        try { refreshLockIndicators(); } catch (e) {}
    }

    /* Open a VOD category: fetch its items (cached after first open), then render
     * them into the movie list column. Shows a loading state while fetching, and
     * retries once on a transient rate-limit (shared bucket, same as live). */
    function openStalkerVodCategory(cat, itemEl, catListEl, chListEl, pl) {
        var items = catListEl.querySelectorAll('.panel-cat-item');
        for (var j = 0; j < items.length; j++) items[j].classList.remove('active');
        if (itemEl) itemEl.classList.add('active');
        if (catListEl) catListEl.setAttribute('data-cat-loaded', cat.id);

        var cached = stalkerVodState.itemsByCat[cat.id];
        if (cached) {
            chListEl._showCount = 0;
            stalkerVodState.currentItems = cached;
            renderStalkerVodItems(chListEl, cached, pl);
            return;
        }
        Util.empty(chListEl);
        chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading') }));
        fetchStalkerVodItems(pl, cat, chListEl, true);
    }

    function fetchStalkerVodItems(pl, cat, chListEl, allowRetry) {
        Api.stalkerVodItems(pl, cat.id).then(function (res) {
            if (!isStalkerVodActive(pl) || !isStalkerVodCatActive(cat.id)) return;
            var raw = (res && res.items) || [];
            var mapped = mapStalkerVodItems(pl, raw, cat);
            stalkerVodState.itemsByCat[cat.id] = mapped;
            stalkerVodState.currentItems = mapped;
            chListEl._showCount = 0;
            renderStalkerVodItems(chListEl, mapped, pl);
            if (typeof GlobalSearch !== 'undefined') {
                GlobalSearch.addItems('movie', mapped, pl.name);
            }
        })['catch'](function (e) {
            var status = e && e.status;
            // Retry once on a transient failure. A status-less error (network
            // blip / aborted fetch — status undefined) is treated as transient
            // too: that was the source of the spurious "HTTP ?" alert that
            // appeared even though a retry would have succeeded. We only
            // surface an error toast if the retry ALSO fails.
            var transient = (status === 429 || status === 503 || status === 504 || !status);
            if (allowRetry && transient) {
                setTimeout(function () {
                    if (!isStalkerVodActive(pl) || !isStalkerVodCatActive(cat.id)) return;
                    fetchStalkerVodItems(pl, cat, chListEl, false);
                }, 1200);
                return;
            }
            Util.empty(chListEl);
            chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_try_again') }));
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_items') + ' ' + stalkerErrText(e), 'err')
        });
    }

    /* Map server stalker VOD objects to play-ready channel items. No direct URL —
     * resolved per-play via Api.stalkerVodResolve using stalkerCmd. */
    function mapStalkerVodItems(pl, list, cat) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            out.push({
                id: pl.id + ':vod:' + v.id,
                name: v.name || ('Movie ' + v.id),
                title: v.name || '',
                url: '',
                logo: v.logo || '',
                stream_icon: v.logo || '',
                category: (cat && cat.title) || 'Movies',
                number: 0,
                playlistId: pl.id,
                playlistName: pl.name,
                type: 'stalker',
                stalkerKind: 'vod',
                stalkerCmd: v.cmd || '',
                // Some portals list containers (a movie that must be opened down to its file): the
                // server tries the cmd first and, only if it has nothing to play, opens this row.
                stalkerOpenId: v.id,
                year: v.year || '',
                rating: v.rating || '',
                plot: v.plot || '',
                addedTs: parseAddedTs(v.added)
            });
        }
        // Order from the playlist's Sort setting (default A-Z, matching the Xtream movie list).
        sortVodItems(out, 'movies', pl);
        return out;
    }

    /* Render a page of mapped VOD items into the movie list, reusing the same
     * media-row markup, info-panel focus tracking, history progress bar and
     * paging as the Xtream movie list — but playing through the stalker path. */
    function renderStalkerVodItems(listEl, items, pl) {
        if (Store.getViewMode && Store.getViewMode('movies') === 'card') {
            renderStalkerCards(listEl, items, pl, 'movies');
            return;
        }
        var PAGE_SIZE = pageStep();
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + PAGE_SIZE, items.length);
        listEl._showCount = showCount;

        for (var i = 0; i < showCount; i++) {
            (function (item, idx) {
                var row = el('div', {
                    'class': 'media-row focusable',
                    'tabindex': '-1',
                    'data-focus-key': 'svod-' + idx,
                    'data-ch-id': item.id,
                    'data-stream-id': item.id,
                    'data-ch-type': 'vod',
                    'data-playlist-name': pl.name || '',
                    'data-playlist-id': pl.id || ''
                });
                var info = el('div', { 'class': 'media-info' });
                info.appendChild(el('div', { 'class': 'media-name', 'text': (Util.cleanseDisplayName ? Util.cleanseDisplayName(item.name) : item.name) }));
                var meta = item.year ? item.year : formatRating(item.rating);
                if (meta) info.appendChild(el('div', { 'class': 'media-meta', 'text': meta }));
                row.appendChild(info);

                ensureFavSet();
                if (favHas(pl && pl.id, item.id, item.name)) {
                    row.appendChild(el('div', { 'class': 'media-fav', 'text': '\u2605' }));
                }

                // Info panel uses the shared VOD data shape (name/year/plot/logo).
                // stream_id + category_name are included so the content-lock
                // manager (which reads .media-row[data-stream-id] rows and keys
                // by stream_id) picks up Stalker items the same as Xtream ones.
                row._vodData = { name: item.name, title: item.name, year: item.year, rating: item.rating, plot: item.plot, stream_icon: item.logo, stream_id: item.id, category_name: item.category, _detailFetched: true };
                row._vodType = 'movies';

                var histSnap = getVodHistoryMatch(item);
                if (histSnap && histSnap.progress > 0.01 && histSnap.progress < 0.98) {
                    appendVodProgressBar(row, histSnap);
                }

                // Found while checking whether the earlier "first tap
                // previews, second tap plays" fix covers every playlist type —
                // it didn't cover this one. Xtream movies/series (renderVodList)
                // and Stalker's own card view (renderStalkerCards, which reuses
                // the shared makeVodCard factory) already had this; Stalker's
                // OWN list view never did — this row played immediately on
                // every tap, with no preview step and no touch gate at all,
                // unlike every other list/card combination. Mirrors
                // renderVodList's identical mechanism exactly: first tap on an
                // unselected row (touch only) pins it and moves focus to the
                // shared info panel's Play button instead of playing straight
                // away.
                row._vodOpen = function () {
                    applyVodHistoryToItem(item);
                    tryPlay(item);
                };
                var svodTouchGate = false;
                try { svodTouchGate = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eStg) {}
                if (svodTouchGate) {
                    row.addEventListener('touchstart', function () {
                        row._wasFocusedPreTap = !!(window.Focus && Focus.current && Focus.current() === row);
                    }, true);
                }
                row.addEventListener('click', function () {
                    if (svodTouchGate && !row._wasFocusedPreTap) {
                        window._vodPinnedCard = row;
                        var infoEl = document.getElementById('movieInfo');
                        var playBtn = document.getElementById('movieInfoPlay');
                        if (infoEl) {
                            var bodyEl = infoEl.querySelector('.vod-info-body');
                            if (bodyEl) bodyEl.scrollTop = 0;
                        }
                        if (playBtn && window.Focus && Focus.focus) Focus.focus(playBtn);
                        return;
                    }
                    row._vodOpen();
                });
                listEl.appendChild(row);
            })(items[i], i);
        }

        // Update the info panel as focus moves over rows (basic data only).
        if (!listEl._svodFocusBound) {
            listEl._svodFocusBound = true;
            Focus.onChange(function (prev, curr) {
                if (!curr || !curr._vodData) return;
                var activeSection = document.querySelector('.content-section.active');
                if (!activeSection || activeSection.getAttribute('data-section-content') !== 'movies') return;
                updateVodInfoPanel(curr._vodData, 'movies', pl);
            });
        }

        if (showCount < items.length) {
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': 'svod-more',
                'text': T('load_more') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderStalkerVodItems(listEl, items, pl);
                var btn = listEl.querySelector('[data-focus-key="svod-more"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag('movies', listEl);
    }

    /* Card-mode renderer for Stalker VOD and series (the card sibling of
     * renderStalkerVodItems / renderStalkerSeriesItems). One function for both kinds
     * since only the click route differs: a movie plays, a series opens its Stalker
     * season browser (with the same content-lock check the list path applies). Items
     * already carry id/name/logo/year, which makeVodCard reads directly. Each card
     * stashes _vodData so the shared info-panel focus handler (bound below) updates the
     * panel identically to the list rows. */
    function renderStalkerCards(listEl, items, pl, kind) {
        var isSeries = (kind === 'series');
        var PAGE_SIZE = pageStep();
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + PAGE_SIZE, items.length);
        listEl._showCount = showCount;

        var grid = el('div', { 'class': 'vod-grid' });

        for (var i = 0; i < showCount; i++) {
            (function (item) {
                var card = makeVodCard(item, kind, {
                    onOpen: function () {
                        if (isSeries) {
                            if (typeof isUiItemLocked === 'function' && isUiItemLocked({ type: 'stalker', stalkerKind: 'series', id: item.id, category: item.category, playlistId: pl.id }) && window.Access && !Access.isUnlocked()) {
                                requireUiUnlock(T('ui_unlock_series'), function () { openStalkerSeriesSeasons(item, pl); });
                                return;
                            }
                            openStalkerSeriesSeasons(item, pl);
                        } else {
                            applyVodHistoryToItem(item);
                            tryPlay(item);
                        }
                    }
                });
                // Same info-panel payload the list rows attach, so focus-driven panel
                // updates work in card mode too.
                card._vodData = { name: item.name, title: item.name, year: item.year, rating: item.rating, plot: item.plot, stream_icon: item.logo, stream_id: item.id, category_name: item.category, _detailFetched: true };
                card._vodType = kind;
                // Let the details modal reuse the same open/play path (Stalker).
                card._vodOpen = function () {
                    if (isSeries) {
                        if (typeof isUiItemLocked === 'function' && isUiItemLocked({ type: 'stalker', stalkerKind: 'series', id: item.id, category: item.category, playlistId: pl.id }) && window.Access && !Access.isUnlocked()) {
                            requireUiUnlock(T('ui_unlock_series'), function () { openStalkerSeriesSeasons(item, pl); });
                            return;
                        }
                        openStalkerSeriesSeasons(item, pl);
                    } else {
                        applyVodHistoryToItem(item);
                        tryPlay(item);
                    }
                };
                grid.appendChild(card);
            })(items[i]);
        }

        listEl.appendChild(grid);

        // Warm the initially-visible posters (see warmInitialCards / renderVodCards).
        warmInitialCards(grid, 18);

        // Info panel follows focus over cards (bind once per list element per kind).
        var boundFlag = isSeries ? '_sseriesCardFocusBound' : '_svodCardFocusBound';
        if (!listEl[boundFlag]) {
            listEl[boundFlag] = true;
            Focus.onChange(function (prev, curr) {
                if (!curr || !curr._vodData) return;
                var activeSection = document.querySelector('.content-section.active');
                if (!activeSection || activeSection.getAttribute('data-section-content') !== kind) return;
                updateVodInfoPanel(curr._vodData, kind, pl);
            });
        }

        if (showCount < items.length) {
            var moreKey = isSeries ? 'sseries-more' : 'svod-more';
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': moreKey,
                'text': T('load_more') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderStalkerCards(listEl, items, pl, kind);
                var btn = listEl.querySelector('[data-focus-key="' + moreKey + '"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag(kind, listEl);
        try { refreshLockIndicators(); } catch (eLk) {}

        // Alphabetical jump bar (same as Xtream VOD). Stalker paginates via
        // "load more", so a jump target beyond the current page expands showCount
        // to cover it, re-renders, then focuses the target card.
        buildAlphaAnchors(listEl, items, pl, kind, {
            onJump: function (idx) {
                var step = pageStep();
                var need = Math.min(items.length, (Math.floor(idx / step) + 1) * step);
                if ((listEl._showCount || 0) < need) {
                    listEl._showCount = Math.max(0, need - step); // render adds the final step
                    renderStalkerCards(listEl, items, pl, kind);
                }
                var target = items[idx];
                var sid = target && (target.stream_id || target.series_id || target.id || '0');
                var key = kind + '-card-' + sid;
                setTimeout(function () {
                    var elc = listEl.querySelector('[data-focus-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
                    if (elc) { Focus.focus(elc); try { elc.scrollIntoView({ block: 'center' }); } catch (e) {} }
                    else if (Focus.focusKey) Focus.focusKey(key);
                }, 40);
            }
        });
    }

    function isStalkerVodActive(pl) {
        return !!(stalkerVodState && pl && stalkerVodState.pl.id === pl.id);
    }
    function isStalkerVodCatActive(catId) {
        // Card view has no DOM category column — the active category lives in the
        // in-memory card state instead.
        if (Store.getViewMode && Store.getViewMode('movies') === 'card') {
            var stv = vodCardState.movies;
            return !!(stv && String(stv.currentCatId) === String(catId));
        }
        var catListEl = $('#movieCatList');
        if (!catListEl) return false;
        var active = catListEl.querySelector('.panel-cat-item.active');
        return !!(active && String(active.getAttribute('data-cat')) === String(catId));
    }

    /* ===== Stalker Series (Series screen) =====
     * Three-level drill-down confirmed against the portal: categories → series
     * rows → seasons (each season carries a base64 cmd + an array of episode
     * NUMBERS). Playing an episode resolves from the season cmd + episode number
     * via the player's stalkerKind:'series' path. Mirrors the Stalker VOD path
     * for categories/items (lazy per-category load, cleanse/sort/hide/lock,
     * unified search context) and reuses the same season/episode modal styling
     * as the Xtream series browser. */
    var stalkerSeriesState = null; // { pl, cats:[], itemsByCat:{}, currentItems:[] }

    function renderStalkerSeries(catListEl, chListEl, pl) {
        Util.empty(catListEl); Util.empty(chListEl);
        if (!stalkerSeriesState || stalkerSeriesState.pl.id !== pl.id) {
            stalkerSeriesState = { pl: pl, cats: [], itemsByCat: {}, currentItems: [] };
        }
        catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_categories') }));
        setVodSearchCtx('series', {
            catListEl: catListEl,
            getItems: function () { return (stalkerSeriesState && stalkerSeriesState.currentItems) || []; },
            render: function (items) { chListEl._showCount = 0; renderStalkerSeriesItems(chListEl, items, pl); }
        });
        fetchStalkerSeriesCategories(catListEl, chListEl, pl, true);
    }

    function fetchStalkerSeriesCategories(catListEl, chListEl, pl, allowRetry) {
        Api.stalkerSeriesCategories(pl).then(function (res) {
            if (!isStalkerSeriesActive(pl)) return;
            var cats = (res && res.categories) || [];
            stalkerSeriesState.cats = cats;
            renderStalkerSeriesCategories(catListEl, chListEl, pl, cats);
        })['catch'](function (e) {
            if (!isStalkerSeriesActive(pl)) return;
            var status = e && e.status;
            var transient = (status === 429 || status === 503 || status === 504 || !status);
            if (allowRetry && transient) {
                setTimeout(function () {
                    if (!isStalkerSeriesActive(pl)) return;
                    fetchStalkerSeriesCategories(catListEl, chListEl, pl, false);
                }, 1200);
                return;
            }
            Util.empty(catListEl);
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_categories_try_again') }));
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_series_categories') + ' ' + stalkerErrText(e), 'err')
        });
    }

    function renderStalkerSeriesCategories(catListEl, chListEl, pl, cats) {
        Util.empty(catListEl);
        if (!cats.length) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
            return;
        }
        var TYPE = 'series';
        for (var c = 0; c < cats.length; c++) cats[c]._clean = vodCleanseCategoryName(cats[c].title);
        orderCatsByMode(cats, function (c) { return c.title; }, 'series', pl);
        var plId = Store.getActivePlaylistId();
        if (Store.applyCustomCategoryOrder) {
            var byName = {};
            var defOrder = [];
            for (var ci = 0; ci < cats.length; ci++) {
                var cn = cats[ci]._clean;
                if (!byName[cn]) { byName[cn] = cats[ci]; defOrder.push(cn); }
            }
            var reordered = Store.applyCustomCategoryOrder(plId, TYPE, defOrder);
            var newCats = [];
            for (var ri = 0; ri < reordered.length; ri++) if (byName[reordered[ri]]) newCats.push(byName[reordered[ri]]);
            if (newCats.length === cats.length) cats = newCats;
        }
        var hidden = Store.getHiddenCategories ? Store.getHiddenCategories(plId, TYPE) : {};
        var firstShown = null;
        // ===== Card view: no DOM category column (Stalker series) =====
        if (Store.getViewMode && Store.getViewMode('series') === 'card') {
            var cardCatsS = [];
            for (var csi = 0; csi < cats.length; csi++) {
                var csName = cats[csi]._clean || cats[csi].title || 'Unknown';
                if (hidden[csName]) continue;
                cardCatsS.push({ id: cats[csi].id, name: csName, _catName: csName, _raw: cats[csi] });
            }
            vodCardState.series = { pl: pl, type: 'series', stalker: true, cats: cardCatsS, currentCatId: null, currentItems: [], catListEl: catListEl };
            setVodSearchCtx('series', {
                catListEl: catListEl,
                getItems: function () { return (stalkerSeriesState && stalkerSeriesState.currentItems) || []; },
                render: function (items) { chListEl._showCount = 0; renderStalkerSeriesItems(chListEl, items, pl); }
            });
            if (cardCatsS.length) loadVodCategoryCard('series', cardCatsS[0], chListEl, pl, 'series');
            else { Util.empty(chListEl); chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') })); }
            if (window.App && App.updateCardCatName) App.updateCardCatName('series');
            landCardFocusOnBar('series', null);
            return;
        }
        for (var i = 0; i < cats.length; i++) {
            (function (cat, idx) {
                var catName = cat._clean || cat.title || 'Unknown';
                if (hidden[catName]) return;
                var item = el('div', {
                    'class': 'panel-cat-item focusable',
                    'tabindex': '-1',
                    'data-cat': cat.id,
                    'data-focus-key': 'sseriescat-' + idx
                });
                item.textContent = vodCleanseCategoryName(catName);
                item._catName = catName;
                item.addEventListener('click', function () {
                    if (typeof isUiCategoryLocked === 'function' && isUiCategoryLocked(TYPE, catName, plId)) {
                        requireUiUnlock(T('ui_unlock_category'), function () { item.click(); });
                        return;
                    }
                    openStalkerSeriesCategory(cat, item, catListEl, chListEl, pl);
                });
                catListEl.appendChild(item);
                if (!firstShown) firstShown = item;
            })(cats[i], i);
        }
        if (!firstShown) { catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') })); return; }
        firstShown.classList.add('active');
        try { firstShown.click(); } catch (e) {}
        try { refreshLockIndicators(); } catch (e) {}
    }

    function openStalkerSeriesCategory(cat, itemEl, catListEl, chListEl, pl) {
        var items = catListEl.querySelectorAll('.panel-cat-item');
        for (var j = 0; j < items.length; j++) items[j].classList.remove('active');
        if (itemEl) itemEl.classList.add('active');
        if (catListEl) catListEl.setAttribute('data-cat-loaded', cat.id);
        var cached = stalkerSeriesState.itemsByCat[cat.id];
        if (cached) {
            chListEl._showCount = 0;
            stalkerSeriesState.currentItems = cached;
            renderStalkerSeriesItems(chListEl, cached, pl);
            return;
        }
        Util.empty(chListEl);
        chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading') }));
        fetchStalkerSeriesItems(pl, cat, chListEl, true);
    }

    function fetchStalkerSeriesItems(pl, cat, chListEl, allowRetry) {
        Api.stalkerSeriesItems(pl, cat.id).then(function (res) {
            if (!isStalkerSeriesActive(pl) || !isStalkerSeriesCatActive(cat.id)) return;
            var raw = (res && res.items) || [];
            var mapped = mapStalkerSeriesItems(pl, raw, cat);
            stalkerSeriesState.itemsByCat[cat.id] = mapped;
            stalkerSeriesState.currentItems = mapped;
            chListEl._showCount = 0;
            renderStalkerSeriesItems(chListEl, mapped, pl);
        })['catch'](function (e) {
            var status = e && e.status;
            var transient = (status === 429 || status === 503 || status === 504 || !status);
            if (allowRetry && transient) {
                setTimeout(function () {
                    if (!isStalkerSeriesActive(pl) || !isStalkerSeriesCatActive(cat.id)) return;
                    fetchStalkerSeriesItems(pl, cat, chListEl, false);
                }, 1200);
                return;
            }
            Util.empty(chListEl);
            chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_try_again') }));
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_series') + ' ' + stalkerErrText(e), 'err')
        });
    }

    /* A series row isn't directly playable — it carries the seriesId used to
     * fetch seasons. Keep tmdbId for later subtitle use. */
    function mapStalkerSeriesItems(pl, list, cat) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            out.push({
                id: pl.id + ':series:' + v.id,
                seriesId: v.id,
                name: v.name || ('Series ' + v.id),
                title: v.name || '',
                logo: v.logo || '',
                year: v.year || '',
                rating: v.rating || '',
                plot: v.plot || '',
                tmdbId: v.tmdbId || '',
                addedTs: parseAddedTs(v.added),
                category: (cat && cat.title) || 'Series',
                playlistId: pl.id,
                playlistName: pl.name
            });
        }
        sortVodItems(out, 'series', pl);
        return out;
    }

    function renderStalkerSeriesItems(listEl, items, pl) {
        if (Store.getViewMode && Store.getViewMode('series') === 'card') {
            renderStalkerCards(listEl, items, pl, 'series');
            return;
        }
        var PAGE_SIZE = pageStep();
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + PAGE_SIZE, items.length);
        listEl._showCount = showCount;
        for (var i = 0; i < showCount; i++) {
            (function (item, idx) {
                var row = el('div', {
                    'class': 'media-row focusable',
                    'tabindex': '-1',
                    'data-focus-key': 'sseries-' + idx,
                    'data-ch-id': item.id,
                    'data-stream-id': item.id,
                    'data-ch-type': 'series',
                    'data-playlist-name': pl.name || '',
                    'data-playlist-id': pl.id || ''
                });
                var info = el('div', { 'class': 'media-info' });
                info.appendChild(el('div', { 'class': 'media-name', 'text': (Util.cleanseDisplayName ? Util.cleanseDisplayName(item.name) : item.name) }));
                var meta = item.year ? item.year : formatRating(item.rating);
                if (meta) info.appendChild(el('div', { 'class': 'media-meta', 'text': meta }));
                row.appendChild(info);

                row._vodData = { name: item.name, title: item.name, year: item.year, rating: item.rating, plot: item.plot, stream_icon: item.logo, stream_id: item.id, category_name: item.category, _detailFetched: true };
                row._vodType = 'series';

                // Same gap as renderStalkerVodItems (see its own
                // comment) — this row opened the series-seasons modal
                // immediately on every tap, no preview step, no touch gate.
                // _vodOpen keeps the existing lock check exactly as it was;
                // only the entry point (touch gate first) changes.
                row._vodOpen = function () {
                    if (typeof isUiItemLocked === 'function' && isUiItemLocked({ type: 'stalker', stalkerKind: 'series', id: item.id, category: item.category, playlistId: pl.id }) && window.Access && !Access.isUnlocked()) {
                        requireUiUnlock(T('ui_unlock_series'), function () { openStalkerSeriesSeasons(item, pl); });
                        return;
                    }
                    openStalkerSeriesSeasons(item, pl);
                };
                var sseriesTouchGate = false;
                try { sseriesTouchGate = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eSsg) {}
                if (sseriesTouchGate) {
                    row.addEventListener('touchstart', function () {
                        row._wasFocusedPreTap = !!(window.Focus && Focus.current && Focus.current() === row);
                    }, true);
                }
                row.addEventListener('click', function () {
                    if (sseriesTouchGate && !row._wasFocusedPreTap) {
                        window._vodPinnedCard = row;
                        var infoEl = document.getElementById('seriesInfo');
                        var playBtn = document.getElementById('seriesInfoPlay');
                        if (infoEl) {
                            var bodyEl = infoEl.querySelector('.vod-info-body');
                            if (bodyEl) bodyEl.scrollTop = 0;
                        }
                        if (playBtn && window.Focus && Focus.focus) Focus.focus(playBtn);
                        return;
                    }
                    row._vodOpen();
                });
                listEl.appendChild(row);
            })(items[i], i);
        }
        if (!listEl._sseriesFocusBound) {
            listEl._sseriesFocusBound = true;
            Focus.onChange(function (prev, curr) {
                if (!curr || !curr._vodData) return;
                var activeSection = document.querySelector('.content-section.active');
                if (!activeSection || activeSection.getAttribute('data-section-content') !== 'series') return;
                updateVodInfoPanel(curr._vodData, 'series', pl);
            });
        }
        if (showCount < items.length) {
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': 'sseries-more',
                'text': T('load_more') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderStalkerSeriesItems(listEl, items, pl);
                var btn = listEl.querySelector('[data-focus-key="sseries-more"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag('series', listEl);
    }

    /* Fetch a series' seasons, then show the season/episode modal. Episodes are
     * plain numbers (the season's episodes array); playing one resolves from
     * the season cmd + that number. */
    function openStalkerSeriesSeasons(item, pl) {
        var curFocus = Focus.current();
        if (curFocus) { var fk = curFocus.getAttribute('data-focus-key'); if (fk) window._lastSeriesFocusKey = fk; }
        if (window.UI && UI.toast) UI.toast(T('loading_episodes'), null);
        Api.stalkerSeriesSeasons(pl, item.seriesId).then(function (res) {
            var seasons = (res && res.seasons) || [];
            if (!seasons.length) { if (window.UI && UI.toast) UI.toast(T('no_seasons_found'), 'err'); return; }
            showStalkerSeriesModal(item, seasons, pl);
        })['catch'](function (e) {
            if (window.UI && UI.toast) UI.toast(T('failed_to_load_seasons') + ' ' + stalkerErrText(e), 'err')
        });
    }

    /* Stalker adapter: map the season array (episodes = plain numbers, no
     * per-episode metadata) into the normalized model and hand it to the shared
     * renderer. Series-level poster/plot go in infoHeader; play resolves from
     * the season cmd + episode number. */
    function showStalkerSeriesModal(item, seasons, pl) {
        // Seasons arrive in portal order (often descending). Sort ascending by
        // season number, parsed from the name ("Season 2") or the id suffix.
        function seasonNum(s) {
            var m = String(s.name || '').match(/(\d+)/);
            if (m) return parseInt(m[1], 10);
            var idm = String(s.id || '').match(/:(\d+)$/);
            return idm ? parseInt(idm[1], 10) : 0;
        }
        var sorted = seasons.slice(0).sort(function (a, b) { return seasonNum(a) - seasonNum(b); });

        function makePlay(season, epNum) {
            return function () {
                tryPlay({
                    id: 'sseries-' + season.id + '-' + epNum,
                    seriesId: item.seriesId || '',
                    parentSeriesId: item.seriesId || '',
                    name: (item.name || '') + ' \u00b7 ' + (season.name || '') + ' E' + epNum,
                    url: '',
                    logo: season.logo || item.logo || '',
                    category: item.category || 'Series',
                    number: 0,
                    playlistId: pl.id,
                    playlistName: pl.name,
                    type: 'stalker',
                    stalkerKind: 'series',
                    stalkerCmd: season.cmd || '',
                    stalkerEpisode: epNum,
                    season: seasonNum(season),
                    episode: epNum,
                    tmdbId: item.tmdbId || ''
                });
            };
        }

        var modelSeasons = [];
        for (var s = 0; s < sorted.length; s++) {
            var season = sorted[s];
            var eps = season.episodes || [];
            var episodes = [];
            for (var e = 0; e < eps.length; e++) {
                var epNum = eps[e];
                episodes.push({
                    label: T('ui_episode') + ' ' + epNum,
                    badge: 'E' + epNum,
                    sub: season.name || T('ui_season'),
                    play: makePlay(season, epNum)
                });
            }
            modelSeasons.push({ id: season.id, name: season.name || (T('season') + ' ' + (s + 1)), episodes: episodes });
        }

        showSeriesModal({
            title: item.name || 'Series',
            prefix: 'ep',
            infoHeader: { poster: item.logo || '', year: item.year || '', rating: item.rating || '', genres: item.genres || '', plot: item.plot || '' },
            seasons: modelSeasons
        });
    }


    function isStalkerSeriesActive(pl) {
        return !!(stalkerSeriesState && pl && stalkerSeriesState.pl.id === pl.id);
    }
    function isStalkerSeriesCatActive(catId) {
        if (Store.getViewMode && Store.getViewMode('series') === 'card') {
            var sts = vodCardState.series;
            return !!(sts && String(sts.currentCatId) === String(catId));
        }
        var catListEl = $('#seriesCatList');
        if (!catListEl) return false;
        var active = catListEl.querySelector('.panel-cat-item.active');
        return !!(active && String(active.getAttribute('data-cat')) === String(catId));
    }

    /* ===== Live TV Combo Screen (channels + EPG) ===== */
    var activeCatName = null;
    var catFocusHandler = null;
    var liveChannelFocusHandler = null;
    // Handle to renderLiveInner's channel renderer + category shower, captured
    // when the guide builds so OTHER paths (e.g. Stalker lazy mode) can render
    // channels through the SAME code rather than a divergent copy. Bound to the
    // live guide closure (chListEl, paging, EPG window). Null until the guide
    // has rendered at least once.
    var liveRenderChannels = null;
    // Module-scope holder for the nested showLiveCat(name, channels), which lives
    // inside renderLiveInner's closure. wireLiveSearchAndFilter is a SIBLING function
    // and can't see that closure, so clearing the Live search threw
    // "showLiveCat is not defined". Exposed here the same way liveRenderChannels is.
    var liveShowCatFn = null;
    /* Live card-view category model (no DOM column). { cats:[{name,display,
     * channels}], currentName }. Rebuilt each live render; read by the action-bar
     * dropdown. Mirrors vodCardState. */
    var liveCardState = null;
    var liveRefreshEpgRows = null;
    // Full channel list of the currently-active live category (what the guide is filtered
    // to), so the content-lock manager can offer ALL of them, not just the ~50 rows the
    // paginated guide DOM happens to hold. Updated by renderLiveChannels.
    var liveCatChannelsRef = [];
    var liveShowCat = null;

    function renderCategories() {
        var catListEl = $('#liveCatList');
        var chListEl = $('#liveChList');
        if (!catListEl || !chListEl) return;
        Util.empty(catListEl);

        catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_2') }));

        bucketByCategory(liveOnlyChannels(), function (buckets) {
            renderLiveInner(catListEl, chListEl, buckets);
        });
    }

    function renderLiveInner(catListEl, chListEl, buckets) {
        Util.empty(catListEl); Util.empty(chListEl);

        // Stamp the active view mode on the live section wrapper (drives card-view
        // layout CSS + read by nav). Mirrors movies/series.
        setScreenViewMode('livetv', (Store.getViewMode && Store.getViewMode('live') === 'card') ? 'card' : 'list');

        // Publish handles immediately (function declarations below are hoisted),
        // so paths that prime this with empty buckets — e.g. Stalker lazy mode —
        // still get a usable renderer even though the early "no categories"
        // return below is hit. _updateLiveNowBarFn belongs in this same
        // early-publish group and was missing from it — Stalker's live channel
        // list is driven entirely through this priming path (empty buckets on
        // first call, real channels loaded per-genre afterward via the handles
        // below), so it always hit the "no categories" return further down and
        // NEVER reached the old, later assignment point. Every isTouch()-style
        // provider-agnostic function further down (updateLiveNowBarImpl
        // included) was therefore permanently unwired for Stalker: the row list
        // rendered correctly (its own handle was already published here), but
        // the "now playing" strip next to the mini player silently no-opped on
        // every call, live or forced, because there was nothing for it to call.
        // Xtream/M3U playlists have their categories upfront, so they always
        // reach the later assignment on a normal (non-priming) call and never
        // hit this gap — which is why Xtream always worked correctly.
        // Function declarations hoist within their
        // enclosing function, so referencing updateLiveNowBarImpl here, before
        // its own textual definition, is safe; everything it closes over
        // (currentCatChannels, liveEpgOffset, EPG_SLOTS/EPG_SLOT_MS) is
        // declared below but only needs to exist by the time it's actually
        // CALLED, not at this assignment.
        liveRenderChannels = renderLiveChannels;
        liveRefreshEpgRows = refreshLiveEpgRows;
        liveShowCat = showLiveCat;
        _updateLiveNowBarFn = updateLiveNowBarImpl;

        /* Touch: swipe the guide sideways to move the time window (left = later, right = earlier), the same two-hour
         * step and redraw as the Earlier / Later buttons. Only a clearly horizontal, quick swipe counts, so vertical
         * scrolling and taps are untouched. Wired once per list element. */
        function wireEpgSwipe(host) {
            if (!host || host.getAttribute('data-epg-swipe')) return;
            host.setAttribute('data-epg-swipe', '1');
            var sx = 0, sy = 0, st = 0, on = false;
            host.addEventListener('touchstart', function (ev) {
                on = !!(ev.touches && ev.touches.length === 1);
                if (!on) return;
                sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; st = Date.now();
            }, { passive: true });
            host.addEventListener('touchend', function (ev) {
                if (!on) return;
                on = false;
                try { if (!window.Mobile || !Mobile.isTouch || !Mobile.isTouch()) return; } catch (eT) { return; }
                var t = ev.changedTouches && ev.changedTouches[0];
                if (!t) return;
                var dx = t.clientX - sx, dy = t.clientY - sy;
                if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2 || Date.now() - st > 800) return;
                liveEpgOffset += dx < 0 ? 2 : -2;
                renderLiveChannels(currentCatChannels || []);
            }, { passive: true });
            host.addEventListener('touchcancel', function () { on = false; }, { passive: true });
        }
        wireEpgSwipe(chListEl);
        _liveShiftEpgFn = function (hours) {
            var cur = (window.Focus && Focus.current) ? Focus.current() : null;
            var key = cur && cur.getAttribute ? cur.getAttribute('data-focus-key') : null;
            liveEpgOffset += hours;
            renderLiveChannels(currentCatChannels || []);
            // The rows are rebuilt: put focus back on the same row (keys are row positions, so they survive).
            if (key) setTimeout(function () { try { if (Focus.focusKey) Focus.focusKey(key); } catch (e) { /* ignore */ } }, 0);
        };

        // Same gap as _updateLiveNowBarFn above, for the SAME reason,
        // found via a Playwright repro (real Chromium, real app code, faked
        // network) that isolated it precisely: focusing a genuine, freshly-
        // confirmed .live-epg-row (via a direct Focus.focusKey call) still
        // left the now-playing strip hidden. liveChannelFocusHandler — the
        // ONLY thing that calls updateLiveNowBar() on an ordinary row-to-row
        // focus change — used to be defined and registered (Focus.onChange)
        // only near the end of this function, past the same early "no
        // categories" return the comment above describes. A Stalker-only
        // session (no Xtream/M3U playlist ever driving a real, non-empty-
        // bucket call this session) therefore NEVER registered this listener
        // at all: the row list rendered and EPG data loaded fine (both
        // published early, above), but nothing was ever wired to notice a
        // focus change and update the strip for it — not "doesn't fire
        // reliably", literally never attached. Moved into this same
        // early-publish group so it's registered on every call, priming or
        // real.
        if (liveChannelFocusHandler) Focus.offChange(liveChannelFocusHandler);
        liveChannelFocusHandler = function (prev, curr) {
            if (curr && curr.classList && curr.classList.contains('live-epg-row')) {
                // Resolve by the row's unique index into currentCatChannels — ch.id is NOT
                // unique across a 21k-channel list, so an id match could return a different
                // channel (the France 3 row showing France Inter's EPG in the side box).
                var chIdx = parseInt(curr.getAttribute('data-ch-idx'), 10);
                var ch = (currentCatChannels && chIdx >= 0 && chIdx < currentCatChannels.length) ? currentCatChannels[chIdx] : null;
                if (ch) updateLiveNowBar(ch);
            } else if (prev && prev.classList && prev.classList.contains('live-epg-row')) {
                // Focus just LEFT a guide row (onto the time controls, categories, etc.).
                // Fall back to the playing channel's now/next, or hide if nothing plays.
                updateLiveNowBar();
            }
            if (curr && curr.classList && curr.classList.contains('media-row')) {
                var chId2 = curr.getAttribute('data-ch-id');
                updateLiveEpg(chId2);
            }
        };
        Focus.onChange(liveChannelFocusHandler);

        var names = [];
        for (var k in buckets) if (buckets.hasOwnProperty(k)) names.push(k);
        names = orderNamesByMode(names, 'live', Store.getActivePlaylistId());
        // Respect user-saved custom order, if any. The
        // default sort above is always applied first so any newly-added
        // categories (not in the saved order) get a predictable Latin-
        // first slot at the end.
        if (Store.applyCustomCategoryOrder) {
            names = Store.applyCustomCategoryOrder(Store.getActivePlaylistId(), 'live', names);
        }

        var CAT_PAGE_SIZE = 50;
        var catShowCount = 0;
        var currentCatChannels = [];
        var liveEpgOffset = 0;
        var livePageStart = 0;
        // EPG window constants — declared here (above the early return) so the
        // Stalker empty-bucket priming path, which returns early, still binds
        // them for the shared renderLiveChannels/renderEpgTimeBar closure.
        // Otherwise they'd be undefined and the time-bar would render 0 slots.
        // Was 4 (a 2-hour window). The two left columns (category list + channel
        // name) were widened for 26px text, which narrows the flex:1 timebar to
        // the right. 4 half-hour slots became too cramped to read, so the window
        // is now 2 slots (1 hour). Header labels and programme blocks both derive
        // their widths from EPG_SLOTS * EPG_SLOT_MS, so they follow automatically.
        // The categories column can be collapsed to a narrow rail (arrow in its header); the
        // guide then shows 4 half-hour slots (2 hours) instead of 2, using the freed width.
        // The choice is device-local (Store setting liveCatsCollapsed).
        var catsCollapsed0 = false;
        try { catsCollapsed0 = !!Store.getSettings().liveCatsCollapsed; } catch (eCC) {}
        var EPG_SLOTS = catsCollapsed0 ? 4 : 2;
        var EPG_SLOT_MS = 30 * 60 * 1000;
        function liveCatsApply(flag, rerender) {
            var cats = document.getElementById('liveCats'), tg = document.getElementById('liveCatsToggle');
            if (cats) { if (flag) cats.classList.add('cats-collapsed'); else cats.classList.remove('cats-collapsed'); }
            EPG_SLOTS = flag ? 4 : 2;
            if (tg) { var lbl = T(flag ? 'ui_expand_categories' : 'ui_collapse_categories'); tg.setAttribute('aria-label', lbl); tg.setAttribute('title', lbl); }
            if (rerender) renderLiveChannels(currentCatChannels || []);
        }
        liveCatsApply(catsCollapsed0, false);
        var liveCatsToggleEl = document.getElementById('liveCatsToggle');
        if (liveCatsToggleEl) liveCatsToggleEl.onclick = function () {
            var cEl = document.getElementById('liveCats');
            var nextFlag = !(cEl && cEl.classList.contains('cats-collapsed'));
            try { var stCC = Store.getSettings(); stCC.liveCatsCollapsed = nextFlag; Store.setSettings(stCC); } catch (eCS) {}
            liveCatsApply(nextFlag, true);
        };

        if (!names.length) {
            // Stalker priming path (empty buckets) returns here before the tail
            // wiring — attach the filter/search listeners now so they work for
            // Stalker too. Guarded internally against double-binding.
            wireLiveSearchAndFilter(catListEl, buckets);
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories') }));
            return;
        }

        // Get hidden categories (used by both list column and card state).
        var plId = Store.getActivePlaylistId();
        var hiddenCats = Store.getHiddenCategories(plId, 'live');
        // Build the hidden-filtered "All Channels" list once (shared).
        var visibleAll = [];
        for (var vai = 0; vai < ALL_CHANNELS.length; vai++) {
            var vach = ALL_CHANNELS[vai];
            // Items sniffed as VOD/series (type 'movies'/'series', e.g. from an
            // m3u_plus playlist) belong to the Movies/Series screens, not Live —
            // exclude them here so Live shows only actual channels.
            if (vach.type === 'movies' || vach.type === 'series') continue;
            var vachCat = vach.category || '';
            if (!vachCat || !hiddenCats[vachCat]) visibleAll.push(vach);
        }

        // ===== Live CARD view: no DOM category column =====
        // Hold a lightweight category model in memory (name + channel list) and
        // auto-load the first category's channels as a card grid. The action-bar
        // dropdown (App.openLiveCardCategoryPicker) reads this — no hidden column,
        // matching the movies/series refactor. Channels are already resident
        // (buckets), so unlike VOD there's no per-category fetch.
        if (Store.getViewMode && Store.getViewMode('live') === 'card') {
            var liveCats = [{ name: '__all__', display: T('all_channels'), channels: visibleAll }];
            for (var lci = 0; lci < names.length; lci++) {
                var lcName = names[lci];
                if (hiddenCats[lcName]) continue;
                liveCats.push({
                    name: lcName,
                    display: Util.cleanseDisplayName ? Util.cleanseDisplayName(lcName) : lcName,
                    channels: buckets[lcName] || []
                });
            }
            liveCardState = { cats: liveCats, currentName: null };
            liveShowCatFn = showLiveCat;
            wireLiveSearchAndFilter(catListEl, buckets);
            // Auto-load the first category (All Channels).
            showLiveCat(liveCats[0].name, liveCats[0].channels);
            if (window.App && App.updateLiveCardCatName) App.updateLiveCardCatName();
            landCardFocusOnBar('livetv', catListEl);
            return; // do NOT build the DOM category column in card view
        }

        // "All Channels" at top
        var allItem = el('div', {
            'class': 'panel-cat-item focusable',
            'tabindex': '-1',
            'data-cat': '__all__',
            'data-focus-key': 'gcat-all'
        });
        allItem.textContent = T('all_channels');
        var allCount = el('span', { 'class': 'cat-count', 'text': '' + visibleAll.length });
        allItem.appendChild(allCount);
        allItem.addEventListener('click', function () { showLiveCat('__all__', visibleAll); });
        catListEl.appendChild(allItem);

        for (var i = 0; i < names.length; i++) {
            (function (name, idx) {
                if (hiddenCats[name]) return; // Skip hidden categories entirely
                var item = el('div', {
                    'class': 'panel-cat-item focusable',
                    'tabindex': '-1',
                    'data-cat': name,
                    'data-focus-key': 'gcat-' + idx
                });
                item.textContent = Util.cleanseDisplayName ? Util.cleanseDisplayName(name) : name;
                var cnt = el('span', { 'class': 'cat-count', 'text': '' + buckets[name].length });
                item.appendChild(cnt);
                item.addEventListener('click', function () {
                    if (isUiCategoryLocked('live', name, plId)) {
                        requireUiUnlock(T('ui_unlock_category'), function () { showLiveCat(name, buckets[name]); });
                        return;
                    }
                    showLiveCat(name, buckets[name]);
                });
                item._catName = name;
                catListEl.appendChild(item);
            })(names[i], i);
        }

        // Set initial active on All Channels
        allItem.classList.add('active');

        function showLiveCat(name, channels) {
            activeCatName = name;
            if (liveCardState) {
                liveCardState.currentName = name;
                if (window.App && App.updateLiveCardCatName) App.updateLiveCardCatName();
            }
            catShowCount = 0;
            livePageStart = 0;
            _lastNowBarFocusCh = null;
            currentCatChannels = channels;
            catListEl.setAttribute('data-cat-loaded', name);
            // Update header
            var title = $('#liveCatTitle');
            var count = $('#liveCatCount');
            if (title) title.textContent = name === '__all__' ? T('all_channels') : name;
            if (count) count.textContent = channels.length + ' channels';
            // Mark active
            var items = catListEl.querySelectorAll('.panel-cat-item');
            for (var j = 0; j < items.length; j++) {
                if (items[j].getAttribute('data-cat') === name) items[j].classList.add('active');
                else items[j].classList.remove('active');
            }
            renderLiveChannels(channels);
            // Keep focus on the category item; users move right/down when they want the channel list.
        }
        // Expose to sibling wiring (wireLiveSearchAndFilter) via the module holder.
        liveShowCatFn = showLiveCat;

        // Redundant with the early publish above (same closure instance, same
        // function) — kept as a no-op reassignment so this stays the obvious
        // place to look when reading the rest of this section's wiring, since
        // updateLiveNowBarImpl is defined right below it.
        _updateLiveNowBarFn = updateLiveNowBarImpl;
        function updateLiveNowBarImpl(focusedCh, forcePlaying) {
            // Shows two programmes for the channel the user is looking at (the FOCUSED
            // guide row, falling back to the PLAYING channel). WHICH two depends on where
            // the guide's time window is scrolled:
            //   - Live view (offset 0): the current + next programme (getNowNext), labelled
            //     NOW / NEXT.
            //   - Scrolled Earlier/Later: the first + second programme IN THAT WINDOW
            //     (getProgrammesBetween over getEpgWindow()), labelled FIRST / THEN — so the
            //     box tracks what's on screen instead of lying about "now".
            // forcePlaying=true: called when a channel STARTS in the mini player — show that
            //   channel as NOW PLAYING regardless of which row is focused. This is the single
            //   entry point the mini player uses (no duplicate inline logic).
            // Both are cheap indexed lookups over one channel's already-parsed EPG — one per
            // focus/play change, no re-parse / network / IndexedDB, so no refresh cost.
            var nowTitleSide = document.getElementById('liveNowTitleSide');
            var nowTimeSide = document.getElementById('liveNowTimeSide');
            var nowLabelSide = document.getElementById('liveNowLabelSide');
            var nextTitleSide = document.getElementById('liveNextTitleSide');
            var nextTimeSide = document.getElementById('liveNextTimeSide');
            var nextLabelSide = document.getElementById('liveNextLabelSide');
            var nowSideBox = document.getElementById('liveNowSide');

            // Channel resolution priority:
            //   1. forcePlaying (a channel just started) -> the playing channel, NOW PLAYING.
            //   2. an explicitly-passed focused row (focus change) -> that row; remember it.
            //   3. no arg (render / auto-refresh): the row currently focused, else the LAST
            //      focused row we remembered, else the playing channel. Remembering the last
            //      focused row is what stops a half-hourly auto-refresh from reverting the box
            //      to the playing channel when focus is momentarily off the row.
            var ch = null;
            var isPlaying = false;
            if (forcePlaying) {
                var pCh = (window.LiveTopMiniPlayer && LiveTopMiniPlayer.currentChannel) ? LiveTopMiniPlayer.currentChannel() : null;
                if (pCh) { ch = pCh; isPlaying = true; }
            }
            if (!ch && focusedCh) { ch = focusedCh; _lastNowBarFocusCh = focusedCh; }
            if (!ch) {
                // Row currently focused? Use it (and remember it).
                var curEl = (window.Focus && Focus.current) ? Focus.current() : null;
                if (curEl && curEl.classList && curEl.classList.contains('live-epg-row')) {
                    var fIdx = parseInt(curEl.getAttribute('data-ch-idx'), 10);
                    if (currentCatChannels && fIdx >= 0 && fIdx < currentCatChannels.length) {
                        ch = currentCatChannels[fIdx];
                        _lastNowBarFocusCh = ch;
                    }
                }
            }
            if (!ch && _lastNowBarFocusCh) {
                // Not on a row right now (e.g. auto-refresh while focus is on a time button),
                // but the user was on a row — keep showing it rather than jumping to playing.
                ch = _lastNowBarFocusCh;
            }
            if (!ch) {
                var miniActive = !!(window.LiveTopMiniPlayer && LiveTopMiniPlayer.isActive && LiveTopMiniPlayer.isActive());
                var miniCh = (window.LiveTopMiniPlayer && LiveTopMiniPlayer.currentChannel) ? LiveTopMiniPlayer.currentChannel() : null;
                if (miniActive && miniCh) { ch = miniCh; isPlaying = true; }
            }

            if (!ch) {
                if (nowSideBox) nowSideBox.className = 'live-now-side live-now-side-hidden';
                _nowBarCh = null;
                return;
            }
            if (nowSideBox) nowSideBox.className = 'live-now-side';
            // GREEN opens the Catch-up page for this channel.
            _nowBarCh = ch;

            var isLiveView = (liveEpgOffset === 0);
            var first = null, second = null;
            if (isLiveView) {
                var nn = stalkerNowNext(ch.playlistId, ch);
                first = nn && nn.now ? nn.now : null;
                second = nn && nn.next ? nn.next : null;
            } else {
                var W = getEpgWindow();
                var inWin = stalkerProgrammesBetween(ch.playlistId, ch, W.winStart, W.winEnd);
                first = inWin.length > 0 ? inWin[0] : null;
                second = inWin.length > 1 ? inWin[1] : null;
            }

            // First programme.
            //  - Has EPG: show it.
            //  - No EPG while PLAYING (NOW PLAYING): show the channel name — once the mini
            //    player is open there's otherwise no way to see which channel is on, so the
            //    name is the useful thing here (not "No EPG data").
            //  - No EPG while browsing a focused row: show "No EPG data" (same wording the
            //    guide rows use); the channel name is already visible in the row.
            if (first) {
                if (nowTitleSide) nowTitleSide.textContent = first.title || (isPlaying ? Util.cleanseDisplayName(ch.name || '') : T('no_epg_data'));
                if (nowTimeSide) nowTimeSide.textContent = Util.formatTimeRange(new Date(first.start), new Date(first.stop));
            } else {
                if (nowTitleSide) nowTitleSide.textContent = isPlaying ? Util.cleanseDisplayName(ch.name || '') : T('no_epg_data');
                if (nowTimeSide) nowTimeSide.textContent = '';
            }
            // Second programme — only shown when there is one.
            if (second) {
                if (nextLabelSide) nextLabelSide.style.display = '';
                if (nextTitleSide) { nextTitleSide.style.display = ''; nextTitleSide.textContent = second.title || ''; }
                if (nextTimeSide) { nextTimeSide.style.display = ''; nextTimeSide.textContent = Util.formatTimeRange(new Date(second.start), new Date(second.stop)); }
            } else {
                if (nextLabelSide) nextLabelSide.style.display = 'none';
                if (nextTitleSide) { nextTitleSide.style.display = 'none'; nextTitleSide.textContent = ''; }
                if (nextTimeSide) { nextTimeSide.style.display = 'none'; nextTimeSide.textContent = ''; }
            }
            // Labels: honest NOW/NEXT only at the live view; neutral FIRST/THEN when the
            // window is scrolled Earlier/Later (or NOW PLAYING for the playing channel).
            if (nowLabelSide) nowLabelSide.textContent = isPlaying ? T('ui_now_playing') : (isLiveView ? T('ui_now') : T('ui_epg_first'));
            if (nextLabelSide) nextLabelSide.textContent = isLiveView ? T('ui_next') : T('ui_epg_then');
        }

        // Single source of truth for the EPG time window.
        // header slot widths, grid columns, and program block left/width are all
        // expressed as percentages of this same window. Anything that wants to
        // place something on the timeline must go through this helper so the
        // header time labels and the program blocks below them can never drift.
        function getEpgWindow() {
            var winDur = EPG_SLOTS * EPG_SLOT_MS;
            var now = new Date();
            var start = new Date(now.getTime() + liveEpgOffset * 3600000);
            // Snap to the nearest half hour so the slot boundaries match the
            // header labels (e.g. 10:30 / 11:00 / 11:30 / 12:00).
            start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
            var winStart = start.getTime();
            return { winStart: winStart, winEnd: winStart + winDur, winDur: winDur, slots: EPG_SLOTS, slotMs: EPG_SLOT_MS };
        }

        function renderEpgTimeBar() {
            var bar = document.getElementById('liveEpgTimeBar');
            if (!bar) return;
            Util.empty(bar);
            var W = getEpgWindow();
            // Each slot occupies an equal percentage of the bar. Program blocks
            // below also position by percentage of the same window, so headers
            // and blocks share the exact same pixel pipeline.
            var slotPct = (100 / W.slots);
            for (var s = 0; s < W.slots; s++) {
                var t = new Date(W.winStart + s * W.slotMs);
                bar.appendChild(el('div', {
                    'class': 'epg-time-slot',
                    'style': 'width:' + slotPct + '%;',
                    'text': Util.formatTime(t)
                }));
            }
            var prevBtn = document.getElementById('epgTimePrevSide');
            var nextBtn = document.getElementById('epgTimeNextSide');
            var pageInfo = document.getElementById('liveEpgPageInfoSide');
            if (pageInfo) {
                var label = liveEpgOffset === 0 ? 'Now' : (liveEpgOffset > 0 ? '+' + liveEpgOffset + 'h' : liveEpgOffset + 'h');
                syncEpgHint();
                pageInfo.textContent = label + ' \u2022 ' + (currentCatChannels && currentCatChannels.length ? (livePageStart + 1) + '-' + Math.min(livePageStart + CAT_PAGE_SIZE, currentCatChannels.length) : '0') + ' / ' + (currentCatChannels ? currentCatChannels.length : 0) + ' channels';
            }
            if (prevBtn) prevBtn.onclick = function () { liveEpgOffset -= 2; renderLiveChannels(currentCatChannels || []); };
            var nowBtn = document.getElementById('epgTimeNowSide');
            if (nowBtn) nowBtn.onclick = function () { liveEpgOffset = 0; renderLiveChannels(currentCatChannels || []); };
            if (nextBtn) nextBtn.onclick = function () { liveEpgOffset += 2; renderLiveChannels(currentCatChannels || []); };
            updateLiveNowBar();
        }

        // Auto-refresh timer. The EPG window snaps to
        // half-hour boundaries (10:00 / 10:30 / 11:00 ...), so when the
        // wall clock crosses one we need to re-render — otherwise the
        // "Earlier / Current / Later" labels and the time-bar slots
        // grow stale. We schedule a single timeout to the next boundary
        // rather than polling every minute.
        var epgRefreshTimer = null;
        function clearEpgRefreshTimer() {
            if (epgRefreshTimer) { clearTimeout(epgRefreshTimer); epgRefreshTimer = null; }
        }
        function scheduleNextEpgRefresh() {
            clearEpgRefreshTimer();
            var now = new Date();
            var msInHalfHour = 30 * 60 * 1000;
            // ms past the previous half-hour boundary.
            var pastBoundary = (now.getMinutes() % 30) * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
            // Schedule for the NEXT boundary + a 250ms cushion so the
            // formatTime() output is unambiguously past it. Min 5s so
            // we don't fire-storm right at a boundary moment.
            var delay = Math.max(5000, (msInHalfHour - pastBoundary) + 250);
            epgRefreshTimer = setTimeout(function () {
                epgRefreshTimer = null;
                // Only re-render if the guide is still the active section
                // — silently skip if the user navigated away.
                var sec = document.querySelector('.content-section[data-section-content="livetv"].active');
                if (sec && currentCatChannels) {
                    // Capture focus before the rebuild wipes the DOM, so the
                    // half-hour boundary re-render doesn't drop focus out from
                    // under the user. Restore if focus was inside the guide
                    // channel list OR on one of the persistent live-screen
                    // controls (mini-player expand button, the Earlier/Current/
                    // Later time controls). Those buttons survive the rebuild,
                    // but the channel-list wipe can still blur focus, so we
                    // re-apply it by key. (Previously only chListEl focus was
                    // preserved, so focus on the expand button was lost when the
                    // window rolled over.)
                    var focusKeyToRestore = null;
                    var curF = (window.Focus && Focus.current) ? Focus.current() : null;
                    if (curF && curF.getAttribute) {
                        var inList = chListEl && chListEl.contains(curF);
                        var curKey = curF.getAttribute('data-focus-key');
                        var persistentKeys = ['live-top-mini-expand', 'epg-time-prev', 'epg-time-now', 'epg-time-next', 'livetv-manage-content'];
                        var isPersistent = false;
                        for (var pk = 0; pk < persistentKeys.length; pk++) {
                            if (curKey === persistentKeys[pk]) { isPersistent = true; break; }
                        }
                        if (inList || isPersistent) {
                            focusKeyToRestore = curKey;
                        }
                    }
                    // Stalker EPG data disappeared at the 30-min
                    // boundary until the user navigated away and back:
                    // this rebuild re-renders using whatever's already cached in
                    // Epg's store — fine for Xtream, whose XMLTV fetch typically
                    // covers a wide (often 24h+) range in one go, so a boundary
                    // rollover never needs a re-fetch, just re-filtering the same
                    // data. Stalker is different: loadStalkerEpgForPage (ui.js)
                    // marks each channel epgFetched=true PERMANENTLY after its
                    // ONE per-session fetch via Api.stalkerEpg, which only
                    // returns a near-term window — so as the wall clock moves
                    // past what was originally fetched, Epg.getProgrammesBetween
                    // starts returning nothing for the new window, and nothing
                    // ever re-queues a fresh fetch for that channel again this
                    // session (that's what navigating away and back was actually
                    // fixing — it resets stalkerState, and with it epgFetched).
                    // Clear epgFetched for the active genre's channels here too,
                    // and re-trigger the fetch queue, so Stalker gets the same
                    // "boundary rollover refreshes the data" behavior Xtream
                    // already had for free.
                    if (stalkerState && stalkerState.epgFetched) {
                        try {
                            var catListElBoundary = $('#liveCatList');
                            var activeGenreEl = catListElBoundary && catListElBoundary.querySelector('.panel-cat-item.active');
                            var activeGenreId = activeGenreEl && activeGenreEl.getAttribute('data-cat');
                            if (activeGenreId) {
                                stalkerState.epgFetched = {};
                                loadStalkerEpgForPage(currentCatChannels, activeGenreId);
                            }
                        } catch (eStalkerBoundary) {}
                    }
                    renderLiveChannels(currentCatChannels);
                    if (focusKeyToRestore && window.Focus && Focus.focusKey) {
                        setTimeout(function () { Focus.focusKey(focusKeyToRestore); }, 60);
                    }
                } else {
                    // Try again later when they navigate back; do NOT
                    // recurse if not visible (would leak the timer).
                }
            }, delay);
        }

        function renderLiveChannels(channels) {
            Util.empty(chListEl);
            currentCatChannels = channels || [];
            liveCatChannelsRef = currentCatChannels;
            if (livePageStart < 0) livePageStart = 0;
            if (livePageStart >= currentCatChannels.length) {
                livePageStart = Math.max(0, Math.floor((currentCatChannels.length - 1) / CAT_PAGE_SIZE) * CAT_PAGE_SIZE);
            }
            catShowCount = Math.min(CAT_PAGE_SIZE, Math.max(0, currentCatChannels.length - livePageStart));

            // ===== Live CARD view (Option C): logo grid + persistent mini-player
            // + now/next rail. No full EPG timeline here (the full guide stays in
            // List view). Reuse makeChannelCard so OK -> tryPlay -> mini preview,
            // double-OK -> fullscreen works with zero new playback code; ch-* keys
            // are whitelisted in focusMiniExpandIfStillSafe. =====
            if (Store.getViewMode && Store.getViewMode('live') === 'card') {
                renderLiveCardGrid();
                return;
            }

            renderEpgTimeBar();

            if (livePageStart > 0) {
                var prevBtn = el('div', {
                    'class': 'epg-page-btn focusable live-page-control',
                    'tabindex': '-1',
                    'data-focus-key': 'live-prev',
                    'text': T('previous') + Math.min(CAT_PAGE_SIZE, livePageStart) + ' channels'
                });
                prevBtn.addEventListener('click', function () {
                    livePageStart = Math.max(0, livePageStart - CAT_PAGE_SIZE);
                    renderLiveChannels(currentCatChannels);
                    setTimeout(function () { Focus.focusKey('gch-' + livePageStart); }, 60);
                });
                chListEl.appendChild(prevBtn);
            }

            var pageEnd = Math.min(livePageStart + CAT_PAGE_SIZE, currentCatChannels.length);
            // Batch-prefetch this page's EPG in one pass (single re-render) so the
            // guide rows fill together rather than each lazily loading + repainting.
            if (window.Epg && Epg.prefetchChannels && pageEnd > livePageStart) {
                var gIds = [];
                for (var gp = livePageStart; gp < pageEnd; gp++) {
                    var gch = currentCatChannels[gp];
                    if (gch) gIds.push(gch.tvgId || gch.epgId);
                }
                if (gIds.length && currentCatChannels[livePageStart]) {
                    Epg.prefetchChannels(currentCatChannels[livePageStart].playlistId, gIds);
                }
            }
            // Stalker EPG was missing entirely once you scroll/page past
            // the genre's first 30 channels: loadStalkerEpgForPage was ONLY ever called once,
            // at genre-open (fetchStalkerChannels), capped internally to the
            // first STALKER_EPG_PAGE channels of the WHOLE genre — unlike the
            // Xtream prefetch immediately above, which is scoped to the
            // CURRENT PAGE and re-runs on every renderLiveChannels call
            // (including pagination). A genre with more channels than that
            // cap (very common — e.g. this provider's own AFRIQUE OTHERS has
            // 167) never got EPG for anything past the first page, and paging
            // further in never re-triggered a fetch for what's now visible.
            // Re-triggering here, scoped to the current page, matches what
            // Xtream already does for free — loadStalkerEpgForPage's own
            // epgFetched de-dupe means repeat calls for already-fetched
            // channels are cheap no-ops, so this is safe to call on every
            // render, not just the first.
            if (stalkerState && loadStalkerEpgForPage) {
                try {
                    var catListElPage = $('#liveCatList');
                    var activeGenreElPage = catListElPage && catListElPage.querySelector('.panel-cat-item.active');
                    var activeGenreIdPage = activeGenreElPage && activeGenreElPage.getAttribute('data-cat');
                    if (activeGenreIdPage) {
                        loadStalkerEpgForPage(currentCatChannels.slice(livePageStart, pageEnd), activeGenreIdPage);
                    }
                } catch (eStalkerPage) {}
            }
            for (var i = livePageStart; i < pageEnd; i++) {
                chListEl.appendChild(makeLiveChannelRow(currentCatChannels[i], i));
            }
            // Logos setting: load the first screen of rows now; the rest follow the scroll (schedulePosterScan).
            try {
                var logoRows = chListEl.querySelectorAll('.live-epg-row[data-logo]');
                for (var li = 0; li < logoRows.length && li < 12; li++) lazyLoadLogo(logoRows[li]);
                if (logoRows.length > 12) schedulePosterScan();
            } catch (eLg) {}

            if (pageEnd < currentCatChannels.length) {
                var remaining = currentCatChannels.length - pageEnd;
                var nextBtn = el('div', {
                    'class': 'epg-page-btn focusable live-page-control',
                    'tabindex': '-1',
                    'data-focus-key': 'live-next',
                    'text': T('next') + Math.min(CAT_PAGE_SIZE, remaining) + ' channels (' + remaining + ' remaining)'
                });
                nextBtn.addEventListener('click', function () {
                    livePageStart = pageEnd;
                    renderLiveChannels(currentCatChannels);
                    setTimeout(function () { Focus.focusKey('gch-' + livePageStart); }, 60);
                });
                chListEl.appendChild(nextBtn);
            }
            updateLiveNowBar();
            // Schedule next auto-refresh for the wall
            // clock crossing the next half-hour boundary, so the time
            // bar and current-programme highlight stay live.
            scheduleNextEpgRefresh();
            consumeContentFocusFlag('livetv', chListEl);
            try { refreshLockIndicators(); } catch (eLk1) {}
        }

        // ===== Live card-view grid (Option C) =====
        // Renders the current category's channels as a .ch-card logo grid (same
        // tile Home/Favourites/Search use), paginated like the list. makeChannelCard's
        // own click handler routes tryPlay -> mini preview / double-OK fullscreen.
        // The now/next rail (#liveNowSide) follows the focused card via getNowNext.
        function renderLiveCardGrid() {
            Util.empty(chListEl);
            var grid = el('div', { 'class': 'vod-grid live-card-grid' });
            var pageEnd = Math.min(livePageStart + CAT_PAGE_SIZE, currentCatChannels.length);

            if (livePageStart > 0) {
                var prevBtn = el('div', {
                    'class': 'epg-page-btn focusable live-page-control',
                    'tabindex': '-1', 'data-focus-key': 'live-prev',
                    'text': T('previous') + Math.min(CAT_PAGE_SIZE, livePageStart) + ' channels'
                });
                prevBtn.addEventListener('click', function () {
                    livePageStart = Math.max(0, livePageStart - CAT_PAGE_SIZE);
                    renderLiveChannels(currentCatChannels);
                    setTimeout(function () { Focus.focusFirstIn(chListEl); }, 60);
                });
                chListEl.appendChild(prevBtn);
            }

            for (var i = livePageStart; i < pageEnd; i++) {
                var ch = currentCatChannels[i];
                if (!ch) continue;
                grid.appendChild(makeChannelCard(ch, { liveLabelInline: true }));
            }
            chListEl.appendChild(grid);

            if (pageEnd < currentCatChannels.length) {
                var remaining = currentCatChannels.length - pageEnd;
                var nextBtn = el('div', {
                    'class': 'epg-page-btn focusable live-page-control',
                    'tabindex': '-1', 'data-focus-key': 'live-next',
                    'text': T('next') + Math.min(CAT_PAGE_SIZE, remaining) + ' channels (' + remaining + ' remaining)'
                });
                nextBtn.addEventListener('click', function () {
                    livePageStart = pageEnd;
                    renderLiveChannels(currentCatChannels);
                    setTimeout(function () { Focus.focusFirstIn(chListEl); }, 60);
                });
                chListEl.appendChild(nextBtn);
            }

            // Warm the first screen of logos (focus-driven loading covers the rest).
            warmInitialCards(grid, 18);

            // Alphabetical jump bar. Live channels are in number order and prefixed
            // with the channel number, so bucket on the name AFTER the number, and
            // jump by paging the window (livePageStart) to the target's page.
            buildAlphaAnchors(chListEl, currentCatChannels, null, 'live', {
                bucketFn: function (ch) { return alphaBucket(ch && (ch.name || ch.title), true); },
                onJump: function (idx) {
                    livePageStart = Math.floor(idx / CAT_PAGE_SIZE) * CAT_PAGE_SIZE;
                    renderLiveChannels(currentCatChannels);
                    var target = currentCatChannels[idx];
                    var key = target ? ('ch-' + target.id) : null;
                    setTimeout(function () {
                        if (key) {
                            var elc = chListEl.querySelector('[data-focus-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
                            if (elc) { Focus.focus(elc); try { elc.scrollIntoView({ block: 'center' }); } catch (e) {} return; }
                        }
                        Focus.focusFirstIn(chListEl);
                    }, 60);
                }
            });

            // Now/Next rail follows the focused card. Bind once per list element.
            if (!chListEl._liveCardFocusBound) {
                chListEl._liveCardFocusBound = true;
                Focus.onChange(function (prev, curr) {
                    if (!curr || !curr.classList || !curr.classList.contains('ch-card')) return;
                    var activeSection = document.querySelector('.content-section.active');
                    if (!activeSection || activeSection.getAttribute('data-section-content') !== 'livetv') return;
                    if (!chListEl.contains(curr)) return;
                    var chId = curr.getAttribute('data-ch-id');
                    var chObj = null;
                    for (var k = 0; k < currentCatChannels.length; k++) {
                        if (currentCatChannels[k] && String(currentCatChannels[k].id) === String(chId)) { chObj = currentCatChannels[k]; break; }
                    }
                    if (chObj) updateLiveNowBar(chObj);
                });
            }
            updateLiveNowBar();
            wireCardEpgControls();
            scheduleNextEpgRefresh();
            consumeContentFocusFlag('livetv', chListEl);
            try { refreshLockIndicators(); } catch (eLk2) {}
        }

        // Card view hides the scrollable guide time-bar (which, in List view, showed
        // the window's clock columns). So here we (a) wire the Earlier/Now/Later
        // buttons — their onclick normally lives in renderEpgTimeBar, which the card
        // path skips, leaving them dead — and (b) show an ABSOLUTE clock-time
        // reference for the window the now/next rail is describing, so a user who
        // scrolled to +2h can see they're looking at, e.g., 8:00-9:00 PM rather than
        // now. The offset persists across category switches (not reset).
        function wireCardEpgControls() {
            var prevBtn = document.getElementById('epgTimePrevSide');
            var nowBtn = document.getElementById('epgTimeNowSide');
            var nextBtn = document.getElementById('epgTimeNextSide');
            if (prevBtn) prevBtn.onclick = function () { liveEpgOffset -= 2; renderLiveChannels(currentCatChannels || []); };
            if (nowBtn) nowBtn.onclick = function () { liveEpgOffset = 0; renderLiveChannels(currentCatChannels || []); };
            if (nextBtn) nextBtn.onclick = function () { liveEpgOffset += 2; renderLiveChannels(currentCatChannels || []); };
            var pageInfo = document.getElementById('liveEpgPageInfoSide');
            if (pageInfo) {
                var win = getEpgWindow();
                // Absolute clock range for the current window, e.g. "18:00 - 19:00"
                // (24h, matching the rest of the app's time format). formatTimeRange
                // takes Date objects.
                var range = Util.formatTimeRange(new Date(win.winStart), new Date(win.winEnd));
                // At offset 0 prefix with NOW; when scrolled, show just the absolute
                // window the rail (labelled FIRST/THEN) is describing.
                pageInfo.textContent = (liveEpgOffset === 0) ? (T('ui_now') + ' \u2022 ' + range) : range;
            }
            syncEpgHint();
        }

        /* The hold-to-shift hint under the page info: only for remote-control devices (touch devices swipe). */
        function syncEpgHint() {
            var h = document.getElementById('liveEpgHintSide');
            if (!h) return;
            var touch = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch());
            h.className = touch ? 'live-epg-hint-row' : 'live-epg-hint-row live-epg-hint-on';
        }

        // showed "No EPG data" (their programmes weren't yet resident in the EPG LRU at first
        // render) pick up the freshly-loaded programmes. Focus is preserved across the
        // rebuild. Without this, only the side now/next box updated on async fill and the
        // GRID stayed empty until the user navigated away and back — which looked like the
        // whole EPG was broken. Throttled by the caller (refreshVisibleEpg).
        function refreshLiveEpgRows() {
            if (!currentCatChannels || !currentCatChannels.length) return;
            if (!chListEl) return;
            var focusedKey = null;
            var cur = (window.Focus && Focus.current) ? Focus.current() : null;
            if (cur && cur.getAttribute) focusedKey = cur.getAttribute('data-focus-key');
            renderLiveChannels(currentCatChannels);
            // Restore focus to the same row (or control) if it still exists after the rebuild.
            if (focusedKey) {
                setTimeout(function () {
                    try { if (Focus.focusKey) Focus.focusKey(focusedKey); } catch (e) {}
                }, 0);
            }
        }

        function makeLiveChannelRow(ch, idx) {
            // Percentage-based EPG layout shared with header
            // time slots via getEpgWindow(). No clientWidth reads, no per-row
            // pixel math. Headers, current-time line, and program blocks all
            // place themselves as a % of the same window, so they cannot drift.
            // Blocks are also absolutely positioned with the parent overflow
            // hidden — and since widths come from a deterministic shared
            // pipeline, neither short nor long programmes can spill into an
            // adjacent block.
            var W = getEpgWindow();
            var winStart = W.winStart;
            var winEnd = W.winEnd;
            var winDur = W.winDur;
            var nowMs = Date.now();

            var row = el('div', {
                'class': 'live-epg-row focusable',
                'tabindex': '-1',
                'data-focus-key': 'gch-' + idx,
                'data-ch-id': ch.id,
                'data-ch-idx': idx
            });

            // Channel info column
            var chCol = el('div', { 'class': 'live-epg-ch' });
            var numEl = el('div', { 'class': 'live-epg-ch-num', 'text': Util.pad(ch.number || 0, 3) });
            // small history icon under the number on channels the Catch-up page lists
            if (window.CatchupScreen && CatchupScreen.isListed && CatchupScreen.isListed(ch)) {
                var arch = document.createElement('span');
                arch.className = 'ch-arch';
                arch.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 117 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>';
                numEl.appendChild(arch);
            }
            // Optional logo above the number (Settings: Channel Logos in List View). The logo box starts as a
            // first-letter tile; the picture is loaded by lazyLoadLogo (first rows after a render, then by scroll).
            var logoOn = false;
            try { logoOn = (Store.getSettings().liveListLogos === 'on'); } catch (eLl) {}
            if (logoOn) {
                chCol.className += ' has-logo';
                var numCol = el('div', { 'class': 'live-epg-numcol' });
                var logoBox = el('div', { 'class': 'live-epg-logo' });
                logoBox.appendChild(el('div', { 'class': 'live-epg-logo-fb', 'text': (ch.name || '?').charAt(0).toUpperCase() }));
                numCol.appendChild(logoBox);
                numCol.appendChild(numEl);
                chCol.appendChild(numCol);
                if (ch.logo) row.setAttribute('data-logo', ch.logo);
            } else {
                chCol.appendChild(numEl);
            }
            chCol.appendChild(el('div', { 'class': 'live-epg-ch-name', 'text': (Util.cleanseDisplayName ? Util.cleanseDisplayName(ch.name) : (ch.name || '')) }));
            row.appendChild(chCol);

            // EPG programmes timeline
            var progs = el('div', { 'class': 'live-epg-prog-row' });
            var pList = Epg.getProgrammesBetween(ch.playlistId, ch.tvgId || ch.epgId, winStart, winEnd);

            if (!pList.length) {
                var noProg = el('div', { 'class': 'live-epg-prog', 'style': 'left:0;width:100%;top:0;bottom:0;' });
                var noInner = el('div', { 'class': 'live-epg-prog-inner' });
                noInner.appendChild(el('div', { 'class': 'live-epg-prog-title', 'text': T('no_epg_data') }));
                noProg.appendChild(noInner);
                progs.appendChild(noProg);
            } else {
                // Switched to approach (a) for narrow
                // EPG blocks per user request. Narrow blocks now RENDER
                // (as coloured bars) but their text content is hidden by
                // CSS — no truncated text bleeding across borders any
                // more. MIN_BLOCK_PCT is the absolute drop threshold;
                // NARROW_BLOCK_PCT is the threshold below which the
                // .narrow class is added so the .live-epg-prog-inner is
                // hidden via CSS. Both thresholds are percentages of the
                // 2-hour timeline window:
                //   0.5%  =  36 seconds — anything below is invisible
                //   7%    =  ~8 minutes — anything below shows as bar only
                var MIN_BLOCK_PCT = 0.5;
                var NARROW_BLOCK_PCT = 7.0;
                // Blocks between SEMI and NARROW get a
                // title-only treatment with ellipsis, instead of being
                // a bare coloured bar. User feedback: "the bigger of the
                // small epg blocks could have an ellipsis instead of
                // nothing." So now there are three tiers:
                //   width >= NARROW (7%)      -> full title + time
                //   SEMI (3.5%) <= width < 7% -> title only, ellipsis
                //   width < SEMI              -> bare coloured bar
                var SEMI_NARROW_BLOCK_PCT = 3.5;
                var placedCount = 0;
                var MAX_PROGS_PER_ROW = 8; // safety cap, 4 slots * 30min ⇒ typical 4-8 programmes
                for (var p = 0; p < pList.length && placedCount < MAX_PROGS_PER_ROW; p++) {
                    var pg = pList[p];
                    var pStart = Math.max(pg.start, winStart);
                    var pStop = Math.min(pg.stop, winEnd);
                    if (pStop <= pStart) continue;

                    var leftPct = ((pStart - winStart) / winDur) * 100;
                    var widthPct = ((pStop - pStart) / winDur) * 100;

                    // Clamp inside the timeline; blocks cannot escape the row.
                    if (leftPct < 0) { widthPct += leftPct; leftPct = 0; }
                    if (leftPct + widthPct > 100) { widthPct = 100 - leftPct; }
                    if (widthPct < MIN_BLOCK_PCT) continue;

                    var isNow = pg.start <= nowMs && pg.stop > nowMs;
                    // A programme whose stop is at/behind the wall clock has ENDED.
                    // The window snaps back to the half-hour for clean labels, so up
                    // to ~30 min of finished programmes sit to the left of "now";
                    // dim them (.past) so they read as over rather than looking like
                    // stale/incorrect data. Only meaningful in the live view.
                    var isPast = (liveEpgOffset === 0) && pg.stop <= nowMs;
                    // Narrow blocks (under ~8 min) get
                    // the .narrow class so CSS can hide their text and
                    // render them as just a coloured bar. Stops the
                    // ugly "Pl…" / "Tu peux…" truncation overflow.
                    // Middle tier gets .semi-narrow —
                    // title shown with ellipsis, time hidden.
                    var isNarrow = widthPct < SEMI_NARROW_BLOCK_PCT;
                    var isSemiNarrow = !isNarrow && widthPct < NARROW_BLOCK_PCT;
                    var pgClass = 'live-epg-prog' + (isNow ? ' now' : '') + (isPast ? ' past' : '') + (isNarrow ? ' narrow' : '') + (isSemiNarrow ? ' semi-narrow' : '');

                    var pgEl = el('div', {
                        'class': pgClass,
                        'style': 'left:' + leftPct + '%;width:' + widthPct + '%;top:0;bottom:0;',
                        // Title attribute carries the
                        // programme title + time even on narrow blocks
                        // whose inner text is hidden by CSS. Browsers
                        // show this as a tooltip on hover; harmless on
                        // platforms that ignore it.
                        'title': (pg.title || '(untitled)') + ' (' + Util.formatTimeRange(new Date(pg.start), new Date(pg.stop)) + ')'
                    });

                    var pgInner = el('div', { 'class': 'live-epg-prog-inner' });
                    pgInner.appendChild(el('div', {
                        'class': 'live-epg-prog-title',
                        'text': pg.title || '(untitled)',
                        'title': pg.title || ''
                    }));
                    // Always emit the time line so every block
                    // shows its start and end. CSS ellipsis handles narrow
                    // blocks rather than dropping the text entirely.
                    pgInner.appendChild(el('div', {
                        'class': 'live-epg-prog-time',
                        'text': Util.formatTimeRange(new Date(pg.start), new Date(pg.stop))
                    }));
                    pgEl.appendChild(pgInner);
                    progs.appendChild(pgEl);
                    placedCount++;
                }
            }
            row.appendChild(progs);

            ensureFavSet();
            if (favHas(ch.playlistId, ch.id, ch.url)) {
                chCol.appendChild(el('div', { 'class': 'media-fav', 'text': '\u2605' }));
            }
            row.addEventListener('click', function () { tryPlay(ch); });
            return row;
        }

        // liveChannelFocusHandler is defined and registered in the early-publish
        // block near the top of this function now (see the comment there) —
        // nothing left to do here.

        // Load "All Channels" by default
        activeCatName = null;

        wireLiveSearchAndFilter(catListEl, buckets);

        showLiveCat('__all__', ALL_CHANNELS);
    }

    /* Attach the live guide's category-filter and channel-search listeners.
     * Pulled out of renderLiveInner's tail so it can ALSO run on the Stalker
     * priming path, which returns early (empty buckets) before reaching the
     * tail — that early return is why the filter/search did nothing for Stalker.
     * Guarded so the listeners bind once per field even across re-renders. The
     * buckets ref is captured per call; the search falls back to ALL_CHANNELS
     * when a bucket isn't present (Stalker loads the open genre into
     * ALL_CHANNELS without bucketing). */
    function wireLiveSearchAndFilter(catListEl, buckets) {
        var catFilter = document.getElementById('liveCatFilter');
        if (catFilter && !catFilter._liveWired) {
            catFilter._liveWired = true;
            catFilter.addEventListener('input', function () {
                var q = (catFilter.value || '').toLowerCase().trim();
                var items = catListEl.querySelectorAll('.panel-cat-item');
                for (var fi = 0; fi < items.length; fi++) {
                    var text = (items[fi].textContent || '').toLowerCase();
                    items[fi].style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
                }
            });
            catFilter.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); UI.openVKeyboard(catFilter); });
        }

        var searchInput = $('#liveSearchField');
        if (searchInput && !searchInput._liveWired) {
            searchInput._liveWired = true;
            var searchDebounce = null;
            searchInput.addEventListener('input', function () {
                if (searchDebounce) clearTimeout(searchDebounce);
                searchDebounce = setTimeout(function () {
                    var query = (searchInput.value || '').toLowerCase().trim();
                    if (!query) {
                        // Reset to current category. Xtream/M3U restore from
                        // buckets; Stalker/lazy paths restore the loaded set
                        // (ALL_CHANNELS) since they don't bucket.
                        if (activeCatName === '__all__') { if (liveShowCatFn) liveShowCatFn('__all__', ALL_CHANNELS); }
                        else if (activeCatName && buckets[activeCatName]) { if (liveShowCatFn) liveShowCatFn(activeCatName, buckets[activeCatName]); }
                        else if (liveRenderChannels) liveRenderChannels(ALL_CHANNELS);
                        return;
                    }
                    // Search across the active category's channels. Xtream/M3U
                    // use per-category buckets; Stalker (and any lazy path) loads
                    // the open category's channels into ALL_CHANNELS without
                    // bucketing, so fall back to ALL_CHANNELS when there's no
                    // bucket — that's the set currently on screen.
                    var source;
                    if (activeCatName && activeCatName !== '__all__' && buckets[activeCatName] && buckets[activeCatName].length) {
                        source = buckets[activeCatName];
                    } else {
                        source = ALL_CHANNELS;
                    }
                    var results = [];
                    for (var si = 0; si < source.length && results.length < 200; si++) {
                        if (matchesSearch(source[si].name, query)) results.push(source[si]);
                    }
                    var title = $('#liveCatTitle');
                    var count = $('#liveCatCount');
                    if (title) title.textContent = T('search') + searchInput.value + '"';
                    if (count) count.textContent = results.length + ' found';
                    if (liveRenderChannels) liveRenderChannels(results);
                }, 400);
            });
        }
    }

    function updateLiveEpg() { /* removed - EPG now inline */ }

    /* ===== Movies (VOD) ===== */
    /* Stamp the active view mode ('list' | 'card') on a section's wrapper element
     * (section[data-section-content=SECTION]) as data-view-mode. One attribute drives
     * the whole screen's layout in CSS, and later JS branches and tests read it. */
    function setScreenViewMode(section, mode) {
        try {
            var sec = document.querySelector('section[data-section-content="' + section + '"]');
            if (sec) sec.setAttribute('data-view-mode', mode === 'card' ? 'card' : 'list');
        } catch (e) {}
    }

    /* ===== M3U VOD / Series (sniffed from an m3u_plus-style playlist) =====
     *
     * When parseM3U tags entries as 'movies'/'series' (via /movie/ /series/ URL
     * paths or a VOD/SERIES group-title prefix), those items are already fully
     * resident in ALL_CHANNELS with a direct .url — there is no Xtream API to
     * call. These renderers mirror the Stalker VOD path (resident items, in-memory
     * category column, shared card/list visuals) but play via the item's direct
     * URL. Series are FLAT (M3U carries no season/episode tree): a series item
     * plays on OK exactly like a movie, just filed under the Series section.
     * section is 'movies' | 'series'. */
    function m3uBuildCategories(items, kind) {
        var byCat = {};
        var order = [];
        for (var i = 0; i < items.length; i++) {
            var cat = items[i].category || 'Uncategorized';
            if (!byCat[cat]) { byCat[cat] = []; order.push(cat); }
            byCat[cat].push(items[i]);
        }
        var cats = [];
        for (var j = 0; j < order.length; j++) cats.push({ name: order[j], items: byCat[order[j]] });
        var sk = kind || 'live', provNm = [], byNm = {}, ci;
        for (ci = 0; ci < cats.length; ci++) { provNm.push(cats[ci].name); byNm[cats[ci].name] = cats[ci]; }
        var sortedNm = orderNamesByMode(provNm, sk, Store.getActivePlaylistId());
        cats = [];
        for (ci = 0; ci < sortedNm.length; ci++) cats.push(byNm[sortedNm[ci]]);
        return cats;
    }

    var m3uVodState = { movies: null, series: null };

    function cssAttr(v) { return String(v).replace(/["\\]/g, '\\$&'); }

    function renderM3UVodSection(catListEl, chListEl, pl, section) {
        Util.empty(catListEl); Util.empty(chListEl);
        var kind = (section === 'series') ? 'series' : 'movies';
        var items = m3uVodItems(kind);
        if (!items.length) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories_found') }));
            return;
        }
        var cats = m3uBuildCategories(items, kind);

        var plId = Store.getActivePlaylistId();
        var hidden = Store.getHiddenCategories ? Store.getHiddenCategories(plId, kind) : {};
        var visibleCats = [];
        for (var c = 0; c < cats.length; c++) if (!hidden[cats[c].name]) visibleCats.push(cats[c]);
        if (Store.applyCustomCategoryOrder) {
            var names = [];
            for (var n = 0; n < visibleCats.length; n++) names.push(visibleCats[n].name);
            var ordered = Store.applyCustomCategoryOrder(plId, kind, names);
            var lookup = {};
            for (var v = 0; v < visibleCats.length; v++) lookup[visibleCats[v].name] = visibleCats[v];
            var rebuilt = [];
            for (var o = 0; o < ordered.length; o++) if (lookup[ordered[o]]) rebuilt.push(lookup[ordered[o]]);
            if (rebuilt.length) visibleCats = rebuilt;
        }

        m3uVodState[kind] = { pl: pl, section: kind, cats: visibleCats, currentItems: [] };

        setVodSearchCtx(kind, {
            catListEl: catListEl,
            getItems: function () { return (m3uVodState[kind] && m3uVodState[kind].currentItems) || []; },
            render: function (list) { chListEl._showCount = 0; renderM3UVodItems(chListEl, list, pl, kind); }
        });

        function showCat(cat) {
            var rows = catListEl.querySelectorAll('.panel-cat-item');
            for (var r = 0; r < rows.length; r++) rows[r].classList.remove('active');
            var active = catListEl.querySelector('.panel-cat-item[data-cat="' + cssAttr(cat.name) + '"]');
            if (active) active.classList.add('active');
            m3uVodState[kind].currentItems = cat.items;
            chListEl._showCount = 0;
            renderM3UVodItems(chListEl, cat.items, pl, kind);
        }

        if (Store.getViewMode && Store.getViewMode(kind) === 'card') {
            var firstItems = visibleCats.length ? visibleCats[0].items : [];
            m3uVodState[kind].currentItems = firstItems;
            renderM3UVodItems(chListEl, firstItems, pl, kind);
            if (typeof landCardFocusOnBar === 'function') landCardFocusOnBar(section, catListEl);
            return;
        }

        Util.empty(catListEl);
        for (var ci = 0; ci < visibleCats.length; ci++) {
            (function (cat, idx) {
                var catRow = el('div', {
                    'class': 'panel-cat-item focusable' + (idx === 0 ? ' active' : ''),
                    'tabindex': '-1',
                    'data-focus-key': (kind === 'series' ? 'm3useriescat-' : 'm3uvodcat-') + idx,
                    'data-cat': cat.name
                });
                catRow.textContent = vodCleanseCategoryName(cat.name);
                catRow._catName = cat.name;
                catRow.addEventListener('click', function () { showCat(cat); });
                catListEl.appendChild(catRow);
            })(visibleCats[ci], ci);
        }
        if (visibleCats.length) showCat(visibleCats[0]);
        // Stamp lock glyphs on the freshly-built category list now (parity with
        // the Xtream/Stalker paths), so padlocks show immediately rather than
        // only after the first OK press.
        try { refreshLockIndicators(); } catch (e) {}
    }

    function renderM3UVodItems(listEl, items, pl, kind) {
        if (Store.getViewMode && Store.getViewMode(kind) === 'card') {
            renderM3UCards(listEl, items, pl, kind);
            return;
        }
        var PAGE_SIZE = pageStep();
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + PAGE_SIZE, items.length);
        listEl._showCount = showCount;

        for (var i = 0; i < showCount; i++) {
            (function (item, idx) {
                var row = el('div', {
                    'class': 'media-row focusable',
                    'tabindex': '-1',
                    'data-focus-key': (kind === 'series' ? 'm3useries-' : 'm3uvod-') + idx,
                    'data-ch-id': item.id,
                    'data-stream-id': item.id,
                    'data-ch-type': (kind === 'series' ? 'series' : 'vod'),
                    'data-playlist-name': pl.name || '',
                    'data-playlist-id': pl.id || ''
                });
                var info = el('div', { 'class': 'media-info' });
                info.appendChild(el('div', { 'class': 'media-name', 'text': (Util.cleanseDisplayName ? Util.cleanseDisplayName(item.name) : item.name) }));
                var meta = item.year ? item.year : formatRating(item.rating);
                if (meta) info.appendChild(el('div', { 'class': 'media-meta', 'text': meta }));
                row.appendChild(info);

                ensureFavSet();
                if (favHas(pl && pl.id, item.id, item.name)) {
                    row.appendChild(el('div', { 'class': 'media-fav', 'text': '\u2605' }));
                }

                row._vodData = { name: item.name, title: item.name, year: item.year, rating: item.rating, plot: item.plot || '', stream_icon: item.logo, stream_id: item.id, category_name: item.category, _detailFetched: true };
                row._vodType = kind;

                var histSnap = getVodHistoryMatch(item);
                if (histSnap && histSnap.progress > 0.01 && histSnap.progress < 0.98) {
                    appendVodProgressBar(row, histSnap);
                }

                // Same gap as Stalker's list view (renderStalkerVodItems/
                // renderStalkerSeriesItems) — checked after a direct question of
                // whether the earlier fix (Xtream-only, via renderVodList) covered
                // every playlist type. It didn't: M3U's own list view
                // (renderM3UVodItems) played immediately on every tap too, no
                // preview step, no touch gate — while M3U's card view
                // (renderM3UCards, below) already had it via the shared
                // makeVodCard factory, same as every other card view.
                row._vodOpen = function () {
                    applyVodHistoryToItem(item);
                    tryPlay(item);
                };
                var m3uTouchGate = false;
                try { m3uTouchGate = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eM3g) {}
                if (m3uTouchGate) {
                    row.addEventListener('touchstart', function () {
                        row._wasFocusedPreTap = !!(window.Focus && Focus.current && Focus.current() === row);
                    }, true);
                }
                row.addEventListener('click', function () {
                    // Flat direct-URL play — movies AND series (M3U series carry no
                    // season/episode tree, so OK just plays the item).
                    if (m3uTouchGate && !row._wasFocusedPreTap) {
                        window._vodPinnedCard = row;
                        var infoIdPrefix = (kind === 'series') ? 'series' : 'movie';
                        var infoEl = document.getElementById(infoIdPrefix + 'Info');
                        var playBtn = document.getElementById(infoIdPrefix + 'InfoPlay');
                        if (infoEl) {
                            var bodyEl = infoEl.querySelector('.vod-info-body');
                            if (bodyEl) bodyEl.scrollTop = 0;
                        }
                        if (playBtn && window.Focus && Focus.focus) Focus.focus(playBtn);
                        return;
                    }
                    row._vodOpen();
                });
                listEl.appendChild(row);
            })(items[i], i);
        }

        var boundFlag = (kind === 'series') ? '_m3uSeriesFocusBound' : '_m3uVodFocusBound';
        if (!listEl[boundFlag]) {
            listEl[boundFlag] = true;
            Focus.onChange(function (prev, curr) {
                if (!curr || !curr._vodData) return;
                var activeSection = document.querySelector('.content-section.active');
                var want = (kind === 'series') ? 'series' : 'movies';
                if (!activeSection || activeSection.getAttribute('data-section-content') !== want) return;
                updateVodInfoPanel(curr._vodData, want, pl);
            });
        }

        if (showCount < items.length) {
            var moreKey = (kind === 'series' ? 'm3useries-more' : 'm3uvod-more');
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': moreKey,
                'text': T('load_more_2') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderM3UVodItems(listEl, items, pl, kind);
                var btn = listEl.querySelector('[data-focus-key="' + moreKey + '"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag(kind, listEl);
    }

    function renderM3UCards(listEl, items, pl, kind) {
        Util.empty(listEl);
        var PAGE_SIZE = pageStep();
        var showCount = Math.min((listEl._showCount || 0) + PAGE_SIZE, items.length);
        listEl._showCount = showCount;
        var grid = el('div', { 'class': 'vod-grid' });
        for (var i = 0; i < showCount; i++) {
            (function (item, idx) {
                var card = makeVodCard(item, kind, { onOpen: function () {
                    applyVodHistoryToItem(item);
                    tryPlay(item);
                } });
                card._vodData = { name: item.name, title: item.name, year: item.year, rating: item.rating, plot: item.plot || '', stream_icon: item.logo, stream_id: item.id, category_name: item.category, _detailFetched: true };
                card._vodType = kind;
                grid.appendChild(card);
            })(items[i], i);
        }
        listEl.appendChild(grid);
        if (showCount < items.length) {
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable', 'tabindex': '-1',
                'data-focus-key': (kind === 'series' ? 'm3useries' : 'm3uvod') + '-cardmore',
                'text': T('load_more_2') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () { renderM3UCards(listEl, items, pl, kind); });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag(kind, listEl);
    }

    function renderMovies() {
        var catListEl = $('#movieCatList');
        var chListEl = $('#movieList');
        if (!catListEl || !chListEl) return;
        Util.empty(catListEl); Util.empty(chListEl);

        // View mode ('list' | 'card'). Stamped on the screen container so CSS and
        // later card-rendering branches can observe it. Phase 1 wires the read only;
        // both modes still render the classic list until the card path lands.
        var moviesViewMode = (Store.getViewMode ? Store.getViewMode('movies') : 'list');
        setScreenViewMode('movies', moviesViewMode);

        // VOD works with Xtream and Stalker portals (different backends).
        var plId = Store.getActivePlaylistId();
        var pl = null;
        var pls = Store.getPlaylists();
        for (var i = 0; i < pls.length; i++) if (pls[i].id === plId) { pl = pls[i]; break; }

        // Stalker portals expose all on-demand content through a single flat
        // VOD path (the portal has no separate series/episode backend). Browse
        // it lazily per-category, mirroring the live genre path.
        if (pl && pl.type === 'stalker') {
            renderStalkerVod(catListEl, chListEl, pl);
            return;
        }

        // M3U playlist with sniffed VOD (from /movie/ URLs or a VOD group-title
        // prefix). Render the resident movie items; if this M3U has none, fall
        // through to the "requires Xtream" hint below.
        if (pl && pl.type === 'm3u' && m3uVodItems('movies').length) {
            renderM3UVodSection(catListEl, chListEl, pl, 'movies');
            return;
        }

        if (!pl || pl.type !== 'xtream') {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('movies_require_an_xtream_codes_playlist') }));
            return;
        }

        catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_movie_categories') }));

        Api.xtreamVodCategories(pl.host, pl.user, pl.pass).then(function (cats) {
            // Pass canonical 'movies' (with s). The
            // earlier 'movie' string mismatched the cat manager's
            // 'movies' key, so categories hidden via Manage Categories
            // weren't actually filtered out on render. (Locks worked by
            // accident because getUiLockKey normalises 'movie'→'movies'
            // internally; getHiddenCategories did not.)
            renderVodScreen(catListEl, chListEl, cats, pl, 'movies');
        })['catch'](function () {
            Util.empty(catListEl);
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_movie_categories') }));
        });
    }

    /* ===== Series ===== */
    function renderSeries() {
        var catListEl = $('#seriesCatList');
        var chListEl = $('#seriesList');
        if (!catListEl || !chListEl) return;
        Util.empty(catListEl); Util.empty(chListEl);

        // View mode ('list' | 'card'); see renderMovies. Phase 1 wires the read only.
        var seriesViewMode = (Store.getViewMode ? Store.getViewMode('series') : 'list');
        setScreenViewMode('series', seriesViewMode);

        var plId = Store.getActivePlaylistId();
        var pl = null;
        var pls = Store.getPlaylists();
        for (var i = 0; i < pls.length; i++) if (pls[i].id === plId) { pl = pls[i]; break; }

        // Stalker portals: real series path (categories → series → seasons →
        // episodes), via the v20 server endpoints.
        if (pl && pl.type === 'stalker') {
            renderStalkerSeries(catListEl, chListEl, pl);
            return;
        }

        // M3U playlist with sniffed series (from /series/ URLs or a SERIES
        // group-title prefix). Flat list — each item plays on OK (no season tree).
        if (pl && pl.type === 'm3u' && m3uVodItems('series').length) {
            renderM3UVodSection(catListEl, chListEl, pl, 'series');
            return;
        }

        if (!pl || pl.type !== 'xtream') {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('series_require_an_xtream_codes_playlist') }));
            return;
        }

        catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_series_categories') }));

        Api.xtreamSeriesCategories(pl.host, pl.user, pl.pass).then(function (cats) {
            renderVodScreen(catListEl, chListEl, cats, pl, 'series');
        })['catch'](function () {
            Util.empty(catListEl);
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load_series_categories_2') }));
        });
    }

    /* Shared VOD/Series guide renderer */
    /* ===== Card-view VOD/Series category model (no DOM category column) =====
     *
     * WHY: IPTV playlists are huge — hundreds of categories and, in the extreme,
     * 379,000+ items. The old card view reused the list-view category COLUMN,
     * built every category as a hidden DOM node (display:none) and had the
     * action-bar picker read those hidden nodes. That built hundreds of nodes +
     * click handlers for nothing and coupled the two views. Card view now holds a
     * LIGHTWEIGHT category array in memory instead — {id, name, mergedIds} per
     * category — which is small and safe even at thousands of categories.
     *
     * SCALE SAFETY: we deliberately hold ONLY (a) the category array and (b) the
     * CURRENT category's items. We NEVER hold all items — a single array past
     * ~150k entries trips an engine array ceiling on older WebKit/JSC TV builds
     * (see GlobalSearch's bucketing note). Item DOM is paginated by _showCount,
     * exactly as list view does, so neither memory nor the DOM ever holds the
     * whole catalogue. GlobalSearch indexing stays as-is (it buckets + caps).
     *
     * Keyed by section ('movies' | 'series'). Rebuilt on each screen render. */
    var vodCardState = { movies: null, series: null };

    /* Load one category's items for card view and render the poster grid. Shared
     * by the initial auto-load and the action-bar category picker. Reuses the
     * exact fetch/dedup/sort/index logic the list-view column click uses, but
     * drives it from the in-memory category object rather than a DOM node, so no
     * category column is needed. The cat arg is a lightweight {category_id/id, name,
     * _mergedCatIds} entry from vodCardState[section].cats. */
    function loadVodCategoryCard(section, cat, chListEl, pl, type) {
        var st = vodCardState[section];
        if (!st) return;
        var catName = cat._catName || cat.name || '';
        var vodPlId = Store.getActivePlaylistId();
        // Honour category lock (same gate as the list-view column click).
        if (typeof isUiCategoryLocked === 'function' && isUiCategoryLocked(type, catName, vodPlId)) {
            requireUiUnlock(T('ui_unlock_category'), function () { loadVodCategoryCard(section, cat, chListEl, pl, type); });
            return;
        }
        st.currentCatId = (cat.category_id != null ? cat.category_id : cat.id);
        // Reflect the newly-selected category in the action-bar label immediately.
        if (window.App && App.updateCardCatName) App.updateCardCatName(section);

        // Stalker: delegate to the existing lazy per-genre loader. It fetches ONE
        // genre at a time (never multiple, to avoid the MAC-ban the lazy loader
        // exists to prevent), caches in stalkerVodState.itemsByCat, and renders
        // through renderStalkerVodItems -> renderStalkerCards (card mode). Passing
        // a null itemEl is safe — it only used the DOM node for .active marking.
        if (st.stalker) {
            if (section === 'series') openStalkerSeriesCategory(cat._raw || cat, null, st.catListEl || null, chListEl, pl);
            else openStalkerVodCategory(cat._raw || cat, null, st.catListEl || null, chListEl, pl);
            landCardFocusOnBar(section, null);
            return;
        }

        chListEl._showCount = 0;
        Util.empty(chListEl);
        chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_2') }));

        var catIds = cat._mergedCatIds && cat._mergedCatIds.length ? cat._mergedCatIds : [st.currentCatId];
        var fetchers = [];
        for (var fi = 0; fi < catIds.length; fi++) {
            fetchers.push(type === 'series' ?
                Api.xtreamSeries(pl.host, pl.user, pl.pass, catIds[fi]) :
                Api.xtreamVodStreams(pl.host, pl.user, pl.pass, catIds[fi]));
        }
        var reqCatId = st.currentCatId;
        Promise.all(fetchers).then(function (lists) {
            // Ignore a stale response if the user switched category meanwhile.
            if (!vodCardState[section] || vodCardState[section].currentCatId !== reqCatId) return;
            var merged = [];
            var seenId = {};
            for (var li = 0; li < lists.length; li++) {
                var arr = lists[li] || [];
                for (var ii = 0; ii < arr.length; ii++) {
                    var it = arr[ii];
                    if (!it) continue;
                    var idKey = (it.stream_id != null ? 's' + it.stream_id :
                                 (it.series_id != null ? 'r' + it.series_id :
                                  (it.id != null ? 'i' + it.id : 'n:' + (it.name || it.title || ''))));
                    if (seenId[idKey]) continue;
                    seenId[idKey] = true;
                    merged.push(it);
                }
            }
            sortVodItems(merged, type, pl);
            st.currentItems = merged; // ONLY the current category's items are held
            chListEl._showCount = 0;
            renderVodCards(chListEl, merged, pl, type, pageStep());
            if (typeof GlobalSearch !== 'undefined') {
                for (var si = 0; si < merged.length; si++) {
                    if (merged[si] && !merged[si].category_name && catName) merged[si].category_name = catName;
                }
                GlobalSearch.addItems(type === 'series' ? 'series' : 'movie', merged, pl.name);
            }
            // Land focus on the action bar after the first load (initial entry).
            landCardFocusOnBar(section, null);
        })['catch'](function () {
            if (!vodCardState[section] || vodCardState[section].currentCatId !== reqCatId) return;
            Util.empty(chListEl);
            chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load') }));
        });
    }

    function renderVodScreen(catListEl, chListEl, categories, pl, type) {
        Util.empty(catListEl);
        if (!categories || !categories.length) {
            catListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories_found') }));
            return;
        }

        // Sort categories alphabetically (same key as Manage Categories)
        orderCatsByMode(categories, function (c) { return c.category_name; }, type, pl);

        // Respect saved custom order for VOD too. Each
        // category is an {category_id, category_name} object — match by
        // the cleansed category_name since that's what the user reorders
        // in the Manage Categories modal. type is now canonical
        // 'movies' or 'series' (callers pass these strings, see
        // renderMovies/renderSeries above) so it can be used directly
        // as the Store key without further normalization.
        if (Store.applyCustomCategoryOrder) {
            var stPlId = Store.getActivePlaylistId();
            // Map of cleansed name -> category object
            function vodCleanseName(s) {
                return String(s || '')
                    .replace(/^(?:VOD|SRS|SERIES)\s*[-–—:]\s*/i, '')
                    .replace(/^VOD\s*[-–—:]\s*/i, '')
                    .replace(/^SRS\s*[-–—:]\s*/i, '')
                    .replace(/^SERIES\s*[-–—:]\s*/i, '');
            }
            var byName = {};
            var defaultOrderNames = [];
            for (var ci = 0; ci < categories.length; ci++) {
                var cn = vodCleanseName(categories[ci].category_name);
                if (!byName[cn]) {
                    byName[cn] = categories[ci];
                    defaultOrderNames.push(cn);
                }
            }
            var reordered = Store.applyCustomCategoryOrder(stPlId, type, defaultOrderNames);
            // Rebuild categories array in the new order
            var newCats = [];
            for (var ri = 0; ri < reordered.length; ri++) {
                if (byName[reordered[ri]]) newCats.push(byName[reordered[ri]]);
            }
            if (newCats.length === categories.length) categories = newCats;
        }

        var PAGE_SIZE = pageStep();
        var currentItems = [];
        var showCount = 0;
        var vodPlId = Store.getActivePlaylistId();
        var vodHidden = Store.getHiddenCategories(vodPlId, type);

        // Collapse categories that resolve to the same displayed name into ONE
        // row, but MERGE rather than drop: providers send near-duplicate
        // categories (e.g. "Action" and "VOD - Action", or the same name under
        // two IDs) whose content OVERLAPS but is not identical — each copy can
        // hold titles the other lacks. So group by cleansed name, keep the first
        // category object as the row representative, and collect ALL of the
        // group's category_ids on it (_mergedCatIds). The click handler fetches
        // every id in the group and unions the results (deduped by stream id), so
        // no titles are lost and overlaps don't double up. Runs unconditionally;
        // the custom-order block above only de-dupes when its rebuilt length
        // matches the original, which is false precisely when duplicates exist.
        function vodDisplayName(cat) {
            var n = (cat.category_name || 'Unknown').replace(/^VOD\s*[-–—:]\s*/i, '').replace(/^SRS\s*[-–—:]\s*/i, '').replace(/^SERIES\s*[-–—:]\s*/i, '');
            return (Util.cleanseDisplayName ? Util.cleanseDisplayName(n) : n);
        }
        var groupByName = {};
        var groupedCats = [];
        for (var di = 0; di < categories.length; di++) {
            var dkey = vodDisplayName(categories[di]).toLowerCase();
            if (groupByName[dkey]) {
                // Fold this duplicate's id into the representative's merged list.
                var rep = groupByName[dkey];
                if (categories[di].category_id != null) rep._mergedCatIds.push(categories[di].category_id);
                continue;
            }
            // First occurrence becomes the row; seed its merged-id list with its
            // own id so the click handler can treat single and merged uniformly.
            categories[di]._mergedCatIds = (categories[di].category_id != null) ? [categories[di].category_id] : [];
            groupByName[dkey] = categories[di];
            groupedCats.push(categories[di]);
        }
        categories = groupedCats;

        // ===== Card view: no DOM category column =====
        // Build a lightweight in-memory category array (id + cleansed name +
        // merged ids) and auto-load the first non-hidden category's grid. The
        // action-bar picker reads this array (see App.openCardCategoryPicker),
        // so the hidden .panel-cat-item column the old card view depended on is
        // never built. At hundreds of categories this avoids building hundreds of
        // hidden DOM nodes + click handlers on every screen render.
        var vmSection = (type === 'series') ? 'series' : 'movies';
        if (Store.getViewMode && Store.getViewMode(vmSection) === 'card') {
            var cardCats = [];
            for (var ci2 = 0; ci2 < categories.length; ci2++) {
                var c2 = categories[ci2];
                var cn2 = (c2.category_name || 'Unknown').replace(/^VOD\s*[-–—:]\s*/i, '').replace(/^SRS\s*[-–—:]\s*/i, '').replace(/^SERIES\s*[-–—:]\s*/i, '');
                if (vodHidden[cn2]) continue; // respect hidden categories
                cardCats.push({
                    category_id: c2.category_id,
                    name: vodCleanseCategoryName(cn2),
                    _catName: cn2,
                    _mergedCatIds: c2._mergedCatIds || (c2.category_id != null ? [c2.category_id] : [])
                });
            }
            vodCardState[vmSection] = { pl: pl, type: type, cats: cardCats, currentCatId: null, currentItems: [] };
            // Search/filter context: card view searches the CURRENT category's
            // items (same contract as list view's getItems).
            setVodSearchCtx(type, {
                catListEl: catListEl,
                getItems: function () { var s = vodCardState[vmSection]; return (s && s.currentItems) || []; },
                render: function (items) { chListEl._showCount = 0; renderVodCards(chListEl, items, pl, type, pageStep()); }
            });
            // Update the action-bar category label + auto-load the first category.
            if (cardCats.length) {
                loadVodCategoryCard(vmSection, cardCats[0], chListEl, pl, type);
            } else {
                Util.empty(chListEl);
                chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_categories_found') }));
            }
            // Reflect the loaded category name in the bar, and land focus there.
            if (window.App && App.updateCardCatName) App.updateCardCatName(vmSection);
            landCardFocusOnBar(vmSection, null);
            return; // do NOT build the DOM category column in card view
        }

        for (var i = 0; i < categories.length; i++) {
            (function (cat) {
                var catName = (cat.category_name || 'Unknown').replace(/^VOD\s*[-–—:]\s*/i, '').replace(/^SRS\s*[-–—:]\s*/i, '').replace(/^SERIES\s*[-–—:]\s*/i, '');
                if (vodHidden[catName]) return; // Skip hidden
                var item = el('div', {
                    'class': 'panel-cat-item focusable',
                    'tabindex': '-1',
                    'data-cat': cat.category_id,
                    'data-focus-key': type + 'cat-' + cat.category_id
                });
                item.textContent = vodCleanseCategoryName(catName);
                item._catName = catName;
                item.addEventListener('click', function () {
                    if (isUiCategoryLocked(type, catName, vodPlId)) {
                        requireUiUnlock(T('ui_unlock_category'), function () {
                            item.click();
                        });
                        return;
                    }
                    // Mark active
                    var all = catListEl.querySelectorAll('.panel-cat-item');
                    for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
                    item.classList.add('active');
                    catListEl.setAttribute('data-cat-loaded', cat.category_id);
                    // Load items for this category
                    Util.empty(chListEl);
                    chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('loading_2') }));

                    // Fetch every category id folded into this row (usually one;
                    // more when duplicate-named categories were merged) and union
                    // the results, deduped by stream/series id so overlapping
                    // titles across the duplicates don't appear twice.
                    var catIds = cat._mergedCatIds && cat._mergedCatIds.length ? cat._mergedCatIds : [cat.category_id];
                    var fetchers = [];
                    for (var fi = 0; fi < catIds.length; fi++) {
                        fetchers.push(type === 'series' ?
                            Api.xtreamSeries(pl.host, pl.user, pl.pass, catIds[fi]) :
                            Api.xtreamVodStreams(pl.host, pl.user, pl.pass, catIds[fi]));
                    }

                    Promise.all(fetchers).then(function (lists) {
                        // Union with de-dup by id (stream_id/series_id, falling
                        // back to name when no id is present).
                        var merged = [];
                        var seenId = {};
                        for (var li = 0; li < lists.length; li++) {
                            var arr = lists[li] || [];
                            for (var ii = 0; ii < arr.length; ii++) {
                                var it = arr[ii];
                                if (!it) continue;
                                var idKey = (it.stream_id != null ? 's' + it.stream_id :
                                             (it.series_id != null ? 'r' + it.series_id :
                                              (it.id != null ? 'i' + it.id : 'n:' + (it.name || it.title || ''))));
                                if (seenId[idKey]) continue;
                                seenId[idKey] = true;
                                merged.push(it);
                            }
                        }
                        currentItems = merged;
                        // Order from the playlist's Sort setting (default A-Z)
                        sortVodItems(currentItems, type, pl);
                        showCount = 0;
                        renderVodList(chListEl, currentItems, pl, type, PAGE_SIZE);
                        // Keep focus on the selected category; users move right/down when they want item rows.
                        // Index VOD items for global search. Stamp the category
                        // name (known here from the fetch context) onto each item
                        // so search results can show which category/language a
                        // title came from — the bulk stream payload only carries
                        // a category_id, so this browse path is a second source
                        // of the human-readable name.
                        if (typeof GlobalSearch !== 'undefined') {
                            for (var si = 0; si < currentItems.length; si++) {
                                if (currentItems[si] && !currentItems[si].category_name && cat.category_name) {
                                    currentItems[si].category_name = cat.category_name;
                                }
                            }
                            GlobalSearch.addItems(type === 'series' ? 'series' : 'movie', currentItems, pl.name);
                        }
                    })['catch'](function () {
                        Util.empty(chListEl);
                        chListEl.appendChild(el('div', { 'class': 'search-empty', 'text': T('failed_to_load') }));
                    });
                });
                catListEl.appendChild(item);
            })(categories[i]);
        }

        // Update info panel on focus change (debounced to avoid API hammering)
        var vodInfoTimer = null;
        var vodFocusHandler = function (prev, curr) {
            if (!curr || !curr._vodData) return;
            var activeSection = document.querySelector('.content-section.active');
            if (!activeSection) return;
            var sname = activeSection.getAttribute('data-section-content');
            if (sname !== 'movies' && sname !== 'series') return;
            // Show the basic info (poster/title/whatever we already have)
            // IMMEDIATELY so the panel tracks focus with no lag. Only the
            // network fetch for full details is debounced — and skipped
            // entirely if we've already fetched/cached this item.
            var streamNow = curr._vodData;
            updateVodInfoPanel(streamNow, curr._vodType, pl);
            if (streamNow.plot || streamNow._detailFetched) return; // cached
            if (vodInfoTimer) clearTimeout(vodInfoTimer);
            vodInfoTimer = setTimeout(function () {
                try {
                    var stream = curr._vodData;
                    // Re-check the cache flag in case a prior fetch resolved
                    // while this debounce was pending.
                    if (stream.plot || stream._detailFetched) {
                        updateVodInfoPanel(stream, curr._vodType, pl);
                        return;
                    }
                    // Fetch detailed info from Xtream API
                    var streamId = stream.stream_id || stream.series_id || '';
                    if (streamId && pl.host && pl.user) {
                        updateVodInfoPanel(stream, curr._vodType, pl); // show basic first
                        var fetchPromise;
                        if (curr._vodType === 'series' && stream.series_id) {
                            fetchPromise = Api.xtreamSeriesInfo(pl.host, pl.user, pl.pass, stream.series_id);
                        } else {
                            fetchPromise = Api.xtreamVodInfo(pl.host, pl.user, pl.pass, streamId);
                        }
                        fetchPromise
                            .then(function (resp) {
                                if (!document.body.contains(curr) || (window.Focus && Focus.current && Focus.current() !== curr)) return;
                                var info = (resp && resp.info) || (resp && resp.movie_data) || resp || {};
                                if (info) {
                                    stream.plot = info.plot || info.description || stream.plot || '';
                                    stream.cast = info.cast || info.actors || stream.cast || '';
                                    stream.director = info.director || stream.director || '';
                                    stream.genre = info.genre || stream.genre || '';
                                    stream.year = info.releasedate || info.release_date || info.year || stream.year || '';
                                    stream.duration = info.duration || info.runtime || '';
                                    stream.rating = info.rating || stream.rating || '';
                                    // Pull TMDB / IMDB IDs out of the
                                    // vod info response. These are the strongest possible
                                    // identifiers when looking up subtitles via Wyzie —
                                    // matching by tmdb_id gives an exact result, whereas
                                    // title+year searches can be ambiguous (foreign-language
                                    // remakes, sequels, etc). Xtream providers vary in
                                    // whether they populate these fields, hence the
                                    // multi-key fallback. Series info uses different keys
                                    // (info object structure differs); covered below in
                                    // the series-specific branch.
                                    stream.tmdb_id = info.tmdb_id || info.tmdb || stream.tmdb_id || null;
                                    stream.imdb_id = info.imdb_id || info.imdb || info.imdbid || stream.imdb_id || null;
                                    stream._detailFetched = true;
                                    updateVodInfoPanel(stream, curr._vodType, pl);
                                }
                            })['catch'](function () {});
                    } else {
                        updateVodInfoPanel(stream, curr._vodType, pl);
                    }
                } catch (e) {}
            }, 350);
        };
        Focus.onChange(vodFocusHandler);

        // Register this screen's search/filter context via the unified wiring
        // (bound once per field, type-agnostic). getItems returns the open
        // category's items; render re-renders the VOD list.
        setVodSearchCtx(type, {
            catListEl: catListEl,
            getItems: function () { return currentItems; },
            render: function (items) { chListEl._showCount = 0; renderVodList(chListEl, items, pl, type, PAGE_SIZE); }
        });

        // Auto-activate first category
        var firstCatItem = catListEl.querySelector('.panel-cat-item');
        if (firstCatItem) {
            firstCatItem.classList.add('active');
            try { firstCatItem.click(); } catch (e) {}
        }

        // Stamp lock glyphs on the freshly-built category list NOW. Previously the
        // only sweep ran from consumeContentFocusFlag (on CONTENT render), so locked
        // categories stayed unmarked until the user opened a category — landing on
        // Movies from the side menu showed no padlocks until an OK press.
        try { refreshLockIndicators(); } catch (e) {}

        // Card view: move focus off the hidden category column onto the action bar.
        landCardFocusOnBar((type === 'series') ? 'series' : 'movies', catListEl);
    }

    /* B4/B5: VOD resume helpers */
    function getVodHistoryMatch(ch) {
        if (!ch) return null;
        var list = Store.getVodHistory() || [];
        // Collect every id form this item could be keyed under. Cards pass the raw
        // listing item (Xtream uses stream_id, not id, and has no url yet); the play
        // path may have stored the raw id, the composite 'movies-<id>'/'series-<id>',
        // or the resolved url. Compare the union from both sides so any overlap hits.
        function idForms(o) {
            var out = {};
            var raw = o.stream_id || o.series_id || o.id || '';
            if (raw) { out[String(raw)] = 1; out['movies-' + raw] = 1; out['series-' + raw] = 1; }
            if (o.id) out[String(o.id)] = 1;                 // may already be composite
            if (o.url) out['url:' + o.url] = 1;
            return out;
        }
        var want = idForms(ch);
        // History is per playlist: the same title in another playlist must not
        // lend its progress. Raw listing items carry no playlistId, so they are
        // taken to belong to the active playlist; entries saved without one
        // (pre-1.0.3) still match any playlist.
        var wantPl = ch.playlistId || Store.getActivePlaylistId() || '';
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it) continue;
            if (wantPl && it.playlistId && it.playlistId !== wantPl) continue;
            var have = idForms(it);
            for (var k in want) { if (want.hasOwnProperty(k) && have[k]) return it; }
        }
        return null;
    }

    function applyVodHistoryToItem(ch) {
        var hist = getVodHistoryMatch(ch);
        if (!hist) return ch;
        ch.progress = hist.progress || 0;
        ch.currentTime = hist.currentTime || 0;
        ch.duration = hist.duration || 0;
        return ch;
    }

    function appendVodProgressBar(row, ch) {
        if (!ch || !ch.currentTime || ch.currentTime < 10 || !ch.duration || ch.duration <= 0) return;
        var pct = Math.round(((ch.progress || (ch.currentTime / ch.duration)) || 0) * 100);
        if (pct < 1 || pct > 98) return;
        var bar = el('div', { 'class': 'ch-progress' });
        var fill = el('div', { 'class': 'ch-progress-fill' });
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
    }

    function renderVodList(listEl, items, pl, type, pageSize) {
        // Card view: delegate to the poster-grid renderer. The classic list path
        // (everything below) is left exactly as-is. Section is movies/series; both
        // follow the 'movies'/'series' view-mode key (set together by the bundled
        // settings control, but read per-section so they can diverge later).
        var vmSection = (type === 'series') ? 'series' : 'movies';
        if (Store.getViewMode && Store.getViewMode(vmSection) === 'card') {
            renderVodCards(listEl, items, pl, type, pageSize);
            return;
        }
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + pageSize, items.length);
        listEl._showCount = showCount;

        // Touch: a tap does double duty — Focus's own capture-phase click
        // handler (focus.js) moves selection here BEFORE this row's own click
        // handler runs, and that selection change is what drives the synopsis
        // panel (vodFocusHandler below). With no D-pad "move without
        // activating" step, every tap both selected AND opened/played in the
        // same instant, so touch users could never actually read a synopsis
        // in list view. Fix: on touch, the FIRST tap on a row that wasn't
        // already selected only selects it (synopsis updates); a SECOND tap
        // on the now-selected row actually opens/plays. Captured at
        // touchstart (before Focus's click handler mutates CURRENT) so we
        // know the PRE-tap selection state. Gated entirely behind isTouch()
        // so TV/mouse/remote behaviour is completely unchanged.
        var vodTouchGate = false;
        try { vodTouchGate = !!(window.Mobile && Mobile.isTouch && Mobile.isTouch()); } catch (eVtg) {}

        for (var i = 0; i < showCount; i++) {
            var s = items[i];
            var vodId = type + '-' + (s.stream_id || s.series_id || i);
            var row = el('div', {
                'class': 'media-row focusable',
                'tabindex': '-1',
                'data-focus-key': type + '-' + i,
                'data-ch-id': vodId,
                'data-ch-type': type === 'series' ? 'series' : 'vod',
                'data-playlist-name': pl.name || '',
                'data-playlist-id': pl.id || '',
                'data-stream-id': s.stream_id || s.series_id || ''
            });
            var info = el('div', { 'class': 'media-info' });
            info.appendChild(el('div', { 'class': 'media-name', 'text': (Util.cleanseDisplayName ? Util.cleanseDisplayName(s.name || s.title || '') : (s.name || s.title || '')) }));
            var meta = s.year ? s.year : formatRating(s.rating);
            if (meta) info.appendChild(el('div', { 'class': 'media-meta', 'text': meta }));
            row.appendChild(info);

            ensureFavSet();
            if (favHas(pl && pl.id, vodId, s.name)) {
                row.appendChild(el('div', { 'class': 'media-fav', 'text': '\u2605' }));
            }

            row._vodData = s;
            row._vodType = type;

            (function (stream, rowEl) {
                if (type !== 'series') {
                    var url = pl.host.replace(/\/$/, '') + '/movie/' +
                        encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' +
                        stream.stream_id + '.' + (stream.container_extension || 'mp4');
                    var baseItem = {
                        id: 'vod-' + stream.stream_id,
                        stream_id: stream.stream_id || '',
                        name: stream.name || '',
                        url: url,
                        logo: stream.stream_icon || stream.cover || '',
                        category: 'Movies', number: 0,
                        playlistId: pl.id, playlistName: pl.name,
                        type: 'vod',
                        plot: stream.plot || '',
                        cast: stream.cast || '',
                        genre: stream.genre || stream.category_name || '',
                        rating: stream.rating || stream.rating_5based || '',
                        year: stream.year || ''
                    };
                    // Show progress bar from current history (visual only)
                    var histSnap = getVodHistoryMatch(baseItem);
                    if (histSnap && histSnap.progress > 0.01 && histSnap.progress < 0.98) {
                        appendVodProgressBar(rowEl, histSnap);
                    }
                    rowEl._basePlayItem = baseItem;
                }

                // Mirrors card view's card._vodOpen (see makeVodCard) — same
                // shape, so the shared info-panel Play button's openPinned()
                // works identically for list view once pinned (see the
                // vodTouchGate click handler below, mobile-only: "users
                // won't know to double tap" without an explicit button).
                rowEl._vodOpen = function () {
                    if (type === 'series') {
                        showSeriesEpisodes(stream, pl);
                    } else {
                        var item = rowEl._basePlayItem;
                        item.plot = stream.plot || item.plot || '';
                        item.cast = stream.cast || item.cast || '';
                        item.director = stream.director || item.director || '';
                        item.genre = stream.genre || item.genre || '';
                        item.rating = stream.rating || item.rating || '';
                        item.year = stream.year || item.year || '';
                        applyVodHistoryToItem(item);
                        tryPlay(item);
                    }
                };

                rowEl.addEventListener('click', function () {
                    // See vodTouchGate comment above: first tap on an
                    // unselected row just selects it (synopsis shows via
                    // Focus.onChange) instead of immediately opening/playing.
                    // Also pin it for the info panel's Play button — mobile
                    // list view has no visible double-tap hint, so the
                    // button is the discoverable way to actually play here.
                    //
                    // This used to only pin the row
                    // (window._vodPinnedCard) without also moving focus to
                    // the Play button, unlike card view's identical touch
                    // gate (makeVodCard, above) which does both. The button
                    // was already there the whole time — #movieInfo/
                    // #seriesInfo is the SAME sibling panel next to
                    // #movieList/#seriesList in list view, not a separate
                    // per-view-mode element — and openPinned() (in
                    // wireVodInfoPanelButtons) already reads
                    // window._vodPinnedCard generically regardless of which
                    // view pinned it. So tapping actually worked already if
                    // you knew to scroll over and tap the button yourself;
                    // it just never got highlighted to make that obvious,
                    // which is the whole reason this touch gate exists in
                    // the first place ("users won't know to double tap").
                    // Mirrors card view's handler exactly now.
                    if (vodTouchGate && !rowEl._wasFocusedPreTap) {
                        window._vodPinnedCard = rowEl;
                        // type here is canonical 'movies'/'series' (see
                        // renderVodScreen's own comment on this), but the
                        // DOM ids are singular — #movieInfo/#movieInfoPlay,
                        // not #moviesInfo/#moviesInfoPlay. Same mismatch
                        // documented elsewhere in this file (getUiLockKey
                        // normalises the other direction). Map it here
                        // rather than trust type's own spelling.
                        var infoIdPrefix = type === 'series' ? 'series' : 'movie';
                        var infoEl = document.getElementById(infoIdPrefix + 'Info');
                        var playBtn = document.getElementById(infoIdPrefix + 'InfoPlay');
                        if (infoEl) {
                            var bodyEl = infoEl.querySelector('.vod-info-body');
                            if (bodyEl) bodyEl.scrollTop = 0;
                        }
                        if (playBtn && window.Focus && Focus.focus) Focus.focus(playBtn);
                        return;
                    }
                    rowEl._vodOpen();
                });
                if (vodTouchGate) {
                    rowEl.addEventListener('touchstart', function () {
                        rowEl._wasFocusedPreTap = !!(window.Focus && Focus.current && Focus.current() === rowEl);
                    }, true);
                }
            })(s, row);

            listEl.appendChild(row);
        }

        // Load more
        if (showCount < items.length) {
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': type + '-more',
                'text': T('load_more_2') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderVodList(listEl, items, pl, type, pageSize);
                var btn = listEl.querySelector('[data-focus-key="' + type + '-more"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag(type === 'series' ? 'series' : 'movies', listEl);
    }

    /* Poster-grid renderer for Movies/Series card view — the card-mode sibling of
     * renderVodList. Same pagination and the same click routing (a movie builds the
     * identical baseItem and plays; a series opens its episode list), but it appends
     * makeVodCard tiles into a .vod-grid. Kept parallel to renderVodList rather than
     * merged so the list path stays untouched and each stays readable. */
    function renderVodCards(listEl, items, pl, type, pageSize) {
        Util.empty(listEl);
        var showCount = Math.min((listEl._showCount || 0) + pageSize, items.length);
        listEl._showCount = showCount;

        var grid = el('div', { 'class': 'vod-grid' });

        for (var i = 0; i < showCount; i++) {
            (function (s) {
                var isSeries = (type === 'series');
                var cardItem = s;
                if (!isSeries) {
                    // Build the same play item the list path builds, so a card click
                    // plays with identical url/id/meta. The card reads name/logo/year
                    // off this object.
                    var url = pl.host.replace(/\/$/, '') + '/movie/' +
                        encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' +
                        s.stream_id + '.' + (s.container_extension || 'mp4');
                    cardItem = {
                        id: 'vod-' + s.stream_id,
                        stream_id: s.stream_id || '',
                        name: s.name || s.title || '',
                        url: url,
                        logo: s.stream_icon || s.cover || '',
                        category: 'Movies', number: 0,
                        playlistId: pl.id, playlistName: pl.name,
                        type: 'vod',
                        plot: s.plot || '',
                        cast: s.cast || '',
                        genre: s.genre || s.category_name || '',
                        rating: s.rating || s.rating_5based || '',
                        year: s.year || ''
                    };
                }
                var card = makeVodCard(cardItem, type, {
                    onOpen: function (it) {
                        if (isSeries) {
                            showSeriesEpisodes(s, pl);
                        } else {
                            applyVodHistoryToItem(it);
                            tryPlay(it);
                        }
                    }
                });
                // Let the details modal reuse this exact open/play logic. For a movie
                // the modal's Play button calls it with the built play item; for a
                // series the modal's "View Episodes" CTA calls it (arg ignored).
                card._vodOpen = function () {
                    if (isSeries) { showSeriesEpisodes(s, pl); }
                    else { applyVodHistoryToItem(cardItem); tryPlay(cardItem); }
                };
                // Attach the raw stream object as the info-panel payload, exactly
                // like the list path (row._vodData = s at renderVodList). The shared
                // vodFocusHandler (bound in openXtreamVod) reads curr._vodData to
                // paint the panel and to mutate .plot/.cast/etc after the debounced
                // detail fetch — without this, focusing a card left the panel blank
                // (the Stalker card path already does the same at renderStalkerCards).
                card._vodData = s;
                card._vodType = type;
                grid.appendChild(card);
            })(items[i]);
        }

        listEl.appendChild(grid);

        // Info panel follows focus over the poster grid. Bind ONCE per list
        // element (card view renders through here; the old list-path binding in
        // renderVodScreen no longer runs in card view). Mirrors vodFocusHandler:
        // paint basic info immediately, then debounce-fetch full details once.
        if (!listEl._vodCardInfoBound) {
            listEl._vodCardInfoBound = true;
            var cardInfoTimer = null;
            Focus.onChange(function (prev, curr) {
                if (!curr || !curr._vodData) return;
                var activeSection = document.querySelector('.content-section.active');
                if (!activeSection) return;
                var sname = activeSection.getAttribute('data-section-content');
                if (sname !== 'movies' && sname !== 'series') return;
                if (!listEl.contains(curr)) return; // this handler owns only this grid
                var streamNow = curr._vodData;
                updateVodInfoPanel(streamNow, curr._vodType, pl);
                if (streamNow.plot || streamNow._detailFetched) return;
                if (cardInfoTimer) clearTimeout(cardInfoTimer);
                cardInfoTimer = setTimeout(function () {
                    try {
                        var stream = curr._vodData;
                        if (stream.plot || stream._detailFetched) { updateVodInfoPanel(stream, curr._vodType, pl); return; }
                        var streamId = stream.stream_id || stream.series_id || '';
                        if (streamId && pl.host && pl.user) {
                            var fetchPromise = (curr._vodType === 'series' && stream.series_id) ?
                                Api.xtreamSeriesInfo(pl.host, pl.user, pl.pass, stream.series_id) :
                                Api.xtreamVodInfo(pl.host, pl.user, pl.pass, streamId);
                            fetchPromise.then(function (resp) {
                                if (!document.body.contains(curr) || (window.Focus && Focus.current && Focus.current() !== curr)) return;
                                var info = (resp && resp.info) || (resp && resp.movie_data) || resp || {};
                                if (info) {
                                    stream.plot = info.plot || info.description || stream.plot || '';
                                    stream.cast = info.cast || info.actors || stream.cast || '';
                                    stream.director = info.director || stream.director || '';
                                    stream.genre = info.genre || stream.genre || '';
                                    stream.year = info.releasedate || info.release_date || info.year || stream.year || '';
                                    stream.duration = info.duration || info.runtime || '';
                                    stream.rating = info.rating || stream.rating || '';
                                    stream.tmdb_id = info.tmdb_id || info.tmdb || stream.tmdb_id || null;
                                    stream.imdb_id = info.imdb_id || info.imdb || info.imdbid || stream.imdb_id || null;
                                    stream._detailFetched = true;
                                    updateVodInfoPanel(stream, curr._vodType, pl);
                                }
                            })['catch'](function () {});
                        }
                    } catch (e) {}
                }, 350);
            });
        }

        // Warm the initially-visible posters up front (focus-only loading otherwise
        // leaves the visible grid blank past the focused card — see warmInitialCards).
        warmInitialCards(grid, 18);

        // Load more (same behaviour as the list path, appended after the grid).
        if (showCount < items.length) {
            var moreBtn = el('div', {
                'class': 'epg-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': type + '-more',
                'text': T('load_more_2') + (items.length - showCount) + ' remaining)'
            });
            moreBtn.addEventListener('click', function () {
                renderVodCards(listEl, items, pl, type, pageSize);
                var btn = listEl.querySelector('[data-focus-key="' + type + '-more"]');
                if (btn) Focus.focus(btn); else Focus.focusLastIn(listEl);
            });
            listEl.appendChild(moreBtn);
        }
        consumeContentFocusFlag(type === 'series' ? 'series' : 'movies', listEl);
        buildAlphaAnchors(listEl, items, pl, type);
    }

    /* Leading-character bucket for the alphabetical anchor bar. Digits (common when
     * providers prefix quality tags like "4K", "1080p", "720p") collapse to a single
     * "0-9" bucket keyed '#num'; A-Z map to themselves; anything else -> '#' (symbols
     * / non-Latin). Uses the same leading-whitespace/pipe cleanse the sort uses so the
     * bucket matches the visible order. */
    function alphaBucket(name, stripNum) {
        var s = (name || '').replace(/^[\s\u00A0\u200B-\u200F|\-]+/, '');
        if (stripNum) {
            // Live channel names are prefixed with the channel number (any width,
            // provider-dependent) then a separator. Strip "<digits><sep/space>" only
            // when more text follows, so a channel actually named "24"/"4K" survives.
            var m = s.match(/^(\d+)[\s.\-:|)\]]+(.+)$/);
            if (m && m[2]) s = m[2].replace(/^[\s\u00A0\u200B-\u200F|\-]+/, '');
        }
        if (!s) return '#';
        var c = s.charAt(0).toUpperCase();
        if (c >= '0' && c <= '9') return '#num';
        if (c >= 'A' && c <= 'Z') return c;
        return '#';
    }

    /* Build (or rebuild) the vertical A-Z + 0-9 jump bar for a card grid. Buckets with
     * no items are dimmed and not focusable. Selecting an anchor renders enough pages
     * to include that bucket's first item, then focuses it. items is the FULL sorted
     * list (st.currentItems); listEl._showCount tracks how much is currently rendered. */
    function buildAlphaAnchors(listEl, items, pl, type, opts) {
        opts = opts || {};
        var bucketFn = opts.bucketFn || function (it) { return alphaBucket(it && (it.name || it.title)); };
        var onJump = opts.onJump || function (idx) { jumpToAlphaIndex(listEl, items, pl, type, idx); };
        var host = listEl.parentNode; // the panel-channels column
        if (!host) return;
        var old = host.querySelector('.alpha-bar');
        if (old) old.parentNode.removeChild(old);
        if (!items || items.length < 2) return;

        var firstIndex = {};
        for (var i = 0; i < items.length; i++) {
            var b = bucketFn(items[i]);
            if (firstIndex[b] === undefined) firstIndex[b] = i;
        }

        var order = ['#num', 'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z', '#'];
        var labels = { '#num': '0-9', '#': '#' };
        var bar = el('div', { 'class': 'alpha-bar', 'data-alpha-bar': type });
        var madeAnchors = [];
        for (var k = 0; k < order.length; k++) {
            (function (bucket) {
                var has = firstIndex[bucket] !== undefined;
                var a = el('div', {
                    'class': 'alpha-anchor' + (has ? ' focusable' : ' alpha-anchor-empty'),
                    'text': labels[bucket] || bucket
                });
                if (has) {
                    a.setAttribute('tabindex', '-1');
                    a.setAttribute('data-focus-key', type + '-alpha-' + bucket);
                    a.setAttribute('data-alpha-target', firstIndex[bucket]);
                    a.addEventListener('click', function () { onJump(firstIndex[bucket]); });
                    madeAnchors.push(a);
                }
                bar.appendChild(a);
            })(order[k]);
        }
        for (var m = 0; m < madeAnchors.length; m++) {
            var upKey = m > 0 ? madeAnchors[m - 1].getAttribute('data-focus-key') : '__none__';
            var dnKey = m < madeAnchors.length - 1 ? madeAnchors[m + 1].getAttribute('data-focus-key') : '__none__';
            madeAnchors[m].setAttribute('data-focus-up', upKey);
            madeAnchors[m].setAttribute('data-focus-down', dnKey);
        }
        host.appendChild(bar);
    }

    /* Render pages until targetIndex is included, then focus that card. */
    function jumpToAlphaIndex(listEl, items, pl, type, targetIndex) {
        var step = pageStep();
        // renderVodCards renders min(_showCount + step, len). Page-align the target
        // and set _showCount so a single render call covers it.
        var need = Math.min(items.length, (Math.floor(targetIndex / step) + 1) * step);
        if ((listEl._showCount || 0) < need) {
            listEl._showCount = need - step;   // the render call adds the final step
            renderVodCards(listEl, items, pl, type, step);
        }
        var target = items[targetIndex];
        var sid = target && (target.stream_id || target.series_id || target.id || '0');
        var key = type + '-card-' + sid;
        setTimeout(function () {
            var elc = listEl.querySelector('[data-focus-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
            if (elc) { Focus.focus(elc); try { elc.scrollIntoView({ block: 'center' }); } catch (e) {} }
            else if (Focus.focusKey) Focus.focusKey(key);
        }, 30);
    }

    /* ===== VOD Info Panel ===== */
    // Build the single-letter poster fallback safely. The letter comes from a
    // user-controlled playlist name, so it must go in via textContent, never
    // string-concatenated into innerHTML (that was a DOM-XSS sink even though
    // charAt(0) caps it to one character — a leading quote/angle-bracket could
    // still break out of the wrapper markup).
    function setPosterFallback(posterEl, name) {
        var fb = document.createElement('div');
        fb.className = 'vod-poster-fallback';
        fb.textContent = String(name || '?').charAt(0) || '?';
        posterEl.innerHTML = '';
        posterEl.appendChild(fb);
    }
    function updateVodInfoPanel(data, type, pl) {
        var prefix = type === 'series' ? 'series' : 'movie';
        var token = String((data.stream_id || data.series_id || data.name || data.title || '') + '-' + type);
        // New item selected → reset the scrollable text body to the top (the poster
        // is pinned; only .vod-info-body scrolls). It may have been scrolled down on
        // the previous item via the remote-scroll feature.
        var panelEl = document.getElementById(prefix + 'Info');
        if (panelEl) {
            var bodyEl = panelEl.querySelector('.vod-info-body');
            if (bodyEl) bodyEl.scrollTop = 0;
        }
        var posterEl = document.getElementById(prefix + 'Poster');
        var titleEl = document.getElementById(prefix + 'Title');
        var metaEl = document.getElementById(prefix + 'Meta');
        var ratingEl = document.getElementById(prefix + 'Rating');
        var genreEl = document.getElementById(prefix + 'Genre');
        var descEl = document.getElementById(prefix + 'Desc');
        var castEl = document.getElementById(prefix + 'Cast');

        if (posterEl) {
            posterEl.setAttribute('data-vod-token', token);
            posterEl.innerHTML = '';
            var icon = data.stream_icon || data.cover || '';
            if (icon) {
                var img = new Image();
                img.onload = function () {
                    if (posterEl.getAttribute('data-vod-token') !== token) return;
                };
                img.onerror = function () {
                    if (posterEl.getAttribute('data-vod-token') !== token) return;
                    setPosterFallback(posterEl, data.name);
                };
                img.src = icon;
                posterEl.appendChild(img);
            } else {
                setPosterFallback(posterEl, data.name);
            }
        }
        if (titleEl) titleEl.textContent = data.name || data.title || '';
        if (metaEl) {
            var parts = [];
            if (data.year) parts.push(data.year);
            if (data.container_extension) parts.push(data.container_extension.toUpperCase());
            if (data.episode_run_time) parts.push(data.episode_run_time + ' min');
            metaEl.textContent = parts.join(' \u2022 ');
        }
        if (ratingEl) {
            var rawR = data.rating || (data.rating_5based ? (data.rating_5based * 2).toFixed(1) : '');
            ratingEl.textContent = formatRating(rawR);
        }
        if (genreEl) genreEl.textContent = data.genre || data.category_name || '';
        if (descEl) {
            // Full plot — no cap. The 300-char truncation here was for when the
            // synopsis was clamped/unscrollable; the info panel is remote-scrollable
            // now (413/415), so the whole synopsis renders and is reachable.
            descEl.textContent = data.plot || data.description || '';
        }
        if (castEl) {
            var castParts = [];
            if (data.director) castParts.push(T('ui_director') + ' ' + data.director);
            if (data.cast) castParts.push('Cast: ' + data.cast);
            castEl.textContent = castParts.join('\n');
        }
    }

    function clearVodInfoPanel(type) {
        var prefix = type === 'series' ? 'series' : 'movie';
        var ids = ['Poster', 'Title', 'Meta', 'Rating', 'Genre', 'Desc', 'Cast'];
        for (var i = 0; i < ids.length; i++) {
            var e = document.getElementById(prefix + ids[i]);
            if (e) { if (ids[i] === 'Poster') e.innerHTML = ''; else e.textContent = ''; }
        }
    }

    /* ===== Series episode selection =====
     * One renderer, fed a normalized model, used by both Xtream and Stalker.
     * Model shape:
     *   { title, prefix, infoHeader?:{poster,year,rating,genres,plot},
     *     seasons:[ { id, name, episodes:[ { label, sub?, thumb?, plot?, play() } ] } ] }
     * Seasons must already be in ascending display order. Each adapter fills the
     * per-episode metadata it has and provides the play() closure. */
    function showSeriesModal(model) {
        var modal = $('#modalLayer');
        if (!modal) return;
        Util.empty(modal);
        var seasons = model.seasons || [];
        if (!seasons.length) { UI.toast(T('no_episodes_found'), 'err'); return; }
        var prefix = model.prefix || 'ep';

        var wrap = el('div', { 'class': 'modal-wrap series-ep-modal' });
        var header = el('div', { 'class': 'modal-header' });
        header.appendChild(el('h2', { 'text': model.title || T('ui_series') }));
        wrap.appendChild(header);

        // (Series-level synopsis header removed per issue 4 — the episode modal shows only
        // the season chips + episode grid. model.infoHeader is no longer rendered here.)

        var seasonBar = el('div', { 'class': 'series-season-bar' });
        var body = el('div', { 'class': 'modal-body' });

        function renderSeason(season) {
            Util.empty(body);
            var eps = season.episodes || [];
            if (!eps.length) { body.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_episodes') })); return; }
            var grid = el('div', { 'class': 'series-ep-grid' });
            for (var ei = 0; ei < eps.length; ei++) {
                (function (ep, idx) {
                    var card = el('div', {
                        'class': 'series-ep-card focusable',
                        'tabindex': '-1',
                        'data-focus-key': prefix + '-' + season.id + '-' + idx
                    });
                    var thumb = el('div', { 'class': 'series-ep-thumb' });
                    if (ep.thumb) {
                        var img = el('img', { 'src': ep.thumb, 'alt': '' });
                        img.onerror = function () { thumb.className = 'series-ep-thumb series-ep-thumb-empty'; if (img.parentNode) img.parentNode.removeChild(img); thumb.appendChild(el('div', { 'class': 'series-ep-thumb-num', 'text': ep.label || '' })); };
                        thumb.appendChild(img);
                    } else {
                        thumb.className = 'series-ep-thumb series-ep-thumb-empty';
                        thumb.appendChild(el('div', { 'class': 'series-ep-thumb-num', 'text': ep.badge || ep.label || '' }));
                    }
                    card.appendChild(thumb);
                    var meta = el('div', { 'class': 'series-ep-meta' });
                    meta.appendChild(el('div', { 'class': 'series-ep-title', 'text': ep.label || '' }));
                    if (ep.sub) meta.appendChild(el('div', { 'class': 'series-ep-sub', 'text': ep.sub }));
                    if (ep.plot) meta.appendChild(el('div', { 'class': 'series-ep-plot', 'text': ep.plot }));
                    card.appendChild(meta);
                    card.addEventListener('click', function () {
                        // Park the restore target on THIS card's focus key so Back
                        // from the player returns focus exactly here (keys are
                        // index-based in the renderer; adapters shouldn't guess them).
                        if (UI.suspendModalForPlayback) UI.suspendModalForPlayback(prefix + '-' + season.id + '-' + idx);
                        if (ep.play) ep.play();
                    });
                    grid.appendChild(card);
                })(eps[ei], ei);
            }
            body.appendChild(grid);
        }

        function selectSeason(sId) {
            var chips = seasonBar.querySelectorAll('.series-season-chip');
            var chosen = null;
            for (var k = 0; k < seasons.length; k++) if (String(seasons[k].id) === String(sId)) { chosen = seasons[k]; break; }
            for (var i = 0; i < chips.length; i++) {
                var on = chips[i].getAttribute('data-season') === String(sId);
                chips[i].classList.toggle('active', on);
                if (on && chosen && chosen.episodes && chosen.episodes.length) {
                    chips[i].setAttribute('data-focus-down', prefix + '-' + chosen.id + '-0');
                }
            }
            if (chosen) renderSeason(chosen);
        }

        // Season selector. A chip bar is nice for a handful of seasons, but a
        // long-running series (e.g. 50 seasons) would wrap the chips into many
        // rows and eat half the modal, squeezing the episode grid. Above a
        // threshold we render a single-line <select> dropdown instead — it's
        // focusable and remote-navigable (left/right cycles seasons via the
        // SELECT handler in app.js) and takes one row regardless of count.
        var SEASON_DROPDOWN_THRESHOLD = 10;
        var useDropdown = seasons.length > SEASON_DROPDOWN_THRESHOLD;

        if (seasons.length > 1 && useDropdown) {
            // Many seasons: a button that opens the app's list picker (the SAME up/down
            // navigable modal the Language selector uses), not a chip row and not a native
            // <select>. The button shows the current season; clicking opens a scrollable,
            // remote-friendly list. One row in the modal regardless of season count.
            var selWrap = el('div', { 'class': 'series-season-select-wrap' });
            selWrap.appendChild(el('label', { 'class': 'series-season-select-label', 'text': T('season') }));
            var seasonBtn = el('button', {
                'class': 'series-season-select field focusable',
                'tabindex': '-1',
                'data-focus-key': 'season-select',
                'text': (seasons[0].name || T('season'))
            });
            var currentSeasonIdx = 0;
            seasonBtn.addEventListener('click', function () {
                var items = [];
                for (var pi = 0; pi < seasons.length; pi++) items.push(seasons[pi].name || T('season'));
                // overlay:true stacks the picker ON TOP of the episode modal instead of
                // replacing it. The non-overlay path does layer.innerHTML='' when it opens,
                // which destroyed the episode modal — so the season change then had nothing
                // live to re-render into (the "selecting a season does nothing" no-op) and
                // Back lost its focus anchor. Overlay mode leaves the episode modal in the
                // DOM (so renderSeason updates it) and restores focus locally via the
                // picker's opener, without clobbering window._lastModalOpener* — the same
                // fix the parental manager filter pickers use.
                UI.openListPicker({
                    overlay: true,
                    title: T('season'),
                    items: items,
                    selected: currentSeasonIdx,
                    onSelect: function (idx) {
                        currentSeasonIdx = idx;
                        var chosen = seasons[idx];
                        seasonBtn.textContent = chosen.name || T('season');
                        if (chosen && chosen.episodes && chosen.episodes.length) {
                            seasonBtn.setAttribute('data-focus-down', prefix + '-' + chosen.id + '-0');
                        }
                        renderSeason(chosen);
                        // Return focus to the season button after the picker closes.
                        setTimeout(function () { Focus.focusKey('season-select'); }, 120);
                    }
                });
            });
            selWrap.appendChild(seasonBtn);
            seasonBar.appendChild(selWrap);
            wrap.appendChild(seasonBar);
        } else if (seasons.length > 1) {
            for (var s = 0; s < seasons.length; s++) {
                (function (season) {
                    var chip = el('div', {
                        'class': 'series-season-chip focusable',
                        'tabindex': '-1',
                        'data-focus-key': 'season-' + season.id,
                        'data-season': season.id,
                        'text': season.name || T('season')
                    });
                    chip.addEventListener('click', function () { selectSeason(season.id); });
                    seasonBar.appendChild(chip);
                })(seasons[s]);
            }
            wrap.appendChild(seasonBar);
        }
        wrap.appendChild(body);

        var actions = el('div', { 'class': 'modal-actions' });
        var closeBtn = el('button', { 'class': 'btn focusable', 'tabindex': '-1', 'data-focus-key': 'ep-close', 'text': T('close') });
        closeBtn.addEventListener('click', function () { UI.closeModal(); });
        actions.appendChild(closeBtn);
        wrap.appendChild(actions);

        modal.appendChild(wrap);
        modal.classList.remove('hidden');
        selectSeason(seasons[0].id);
        // Keep the season button's shown value in sync with the initial season.
        if (useDropdown) {
            var sel0 = seasonBar.querySelector('.series-season-select');
            if (sel0) {
                sel0.textContent = seasons[0].name || T('season');
                var eps00 = seasons[0].episodes || [];
                if (eps00.length) sel0.setAttribute('data-focus-down', prefix + '-' + seasons[0].id + '-0');
            }
        }
        setTimeout(function () {
            if (seasons.length > 1 && useDropdown) {
                Focus.focusKey('season-select');
            } else if (seasons.length > 1) {
                Focus.focusKey('season-' + seasons[0].id);
            } else {
                var eps0 = seasons[0].episodes || [];
                if (eps0.length) Focus.focusKey(prefix + '-' + seasons[0].id + '-0');
                else Focus.focusKey('ep-close');
            }
        }, 100);
    }

    /* Xtream adapter: fetch series info, map the { "1":[eps] } shape into the
     * normalized model (rich per-episode metadata, direct-URL play). */
    function showSeriesEpisodes(series, pl) {
        var seriesId = series.series_id;
        if (!seriesId) { UI.toast(T('no_series_id'), 'err'); return; }

        var curFocus = Focus.current();
        if (curFocus) {
            var fk = curFocus.getAttribute('data-focus-key');
            if (fk) window._lastSeriesFocusKey = fk;
        }

        UI.toast(T('loading_episodes_2'), null);

        Api.xtreamSeriesInfo(pl.host, pl.user, pl.pass, seriesId).then(function (info) {
            if (!info || !info.episodes) { UI.toast(T('no_episodes_found'), 'err'); return; }
            var rawSeasons = info.episodes; // { "1": [...], "2": [...] }
            // Series-level synopsis (get_series_info wraps it under info). Used as
            // a last-resort plot for episodes when the provider gives no per-episode
            // plot, so the modal isn't blank.
            var seriesInfo = info.info || {};
            var seriesPlot = seriesInfo.plot || seriesInfo.description || seriesInfo.overview || '';
            var seasonKeys = [];
            for (var k in rawSeasons) if (rawSeasons.hasOwnProperty(k)) seasonKeys.push(k);
            seasonKeys.sort(function (a, b) { return parseInt(a) - parseInt(b); });
            if (!seasonKeys.length) { UI.toast(T('no_episodes_found'), 'err'); return; }

            function makePlay(ep, sKey, idx) {
                return function () {
                    var ext = ep.container_extension || 'mp4';
                    var url = pl.host.replace(/\/$/, '') + '/series/' +
                        encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' +
                        ep.id + '.' + ext;
                    tryPlay({
                        id: 'series-' + ep.id,
                        seriesId: series.series_id || '',
                        parentSeriesId: series.series_id || '',
                        name: (series.name || '') + ' S' + sKey + 'E' + (ep.episode_num || (idx + 1)),
                        url: url,
                        logo: series.cover || '',
                        category: 'Series',
                        number: 0,
                        season: sKey,
                        episode: (ep.episode_num || (idx + 1)),
                        playlistId: pl.id,
                        playlistName: pl.name,
                        type: 'series'
                    });
                };
            }

            var seasons = [];
            for (var si = 0; si < seasonKeys.length; si++) {
                var sKey = seasonKeys[si];
                var eps = rawSeasons[sKey] || [];
                var episodes = [];
                for (var ei = 0; ei < eps.length; ei++) {
                    var ep = eps[ei];
                    var epNum = ep.episode_num || (ei + 1);
                    var epInfo = ep.info || {};
                    var bits = [];
                    if (epInfo.duration) bits.push(epInfo.duration);
                    var epR = formatRating(epInfo.rating); if (epR) bits.push(epR);
                    if (epInfo.releasedate || epInfo.air_date) bits.push(epInfo.releasedate || epInfo.air_date);
                    // Providers vary on where the episode synopsis lives: usually
                    // info.plot, but some use info.description / info.overview, and
                    // a few put it directly on the episode object. Fall through the
                    // common per-episode keys only. Deliberately NO series-level
                    // fallback: an episode without its own plot shows no plot,
                    // rather than repeating the series synopsis on every episode.
                    var epPlot = epInfo.plot || epInfo.description || epInfo.overview ||
                                 ep.plot || ep.description || '';
                    episodes.push({
                        label: 'E' + epNum + ' · ' + (ep.title || ('Episode ' + epNum)),
                        badge: 'E' + epNum,
                        sub: bits.length ? bits.join('  ·  ') : '',
                        thumb: epInfo.movie_image || epInfo.cover_big || epInfo.cover || '',
                        plot: epPlot,
                        play: makePlay(ep, sKey, ei)
                    });
                }
                seasons.push({ id: sKey, name: T('season') + ' ' + sKey, episodes: episodes });
            }

            showSeriesModal({
                title: series.name || 'Series',
                prefix: 'ep',
                infoHeader: {
                    poster: series.cover || seriesInfo.cover || '',
                    year: seriesInfo.releaseDate || seriesInfo.releasedate || '',
                    rating: seriesInfo.rating || '',
                    genres: seriesInfo.genre || '',
                    plot: seriesPlot
                },
                seasons: seasons
            });
        })['catch'](function (err) {
            UI.toast(T('failed_to_load_episodes'), 'err');
        });
    }

    /* ===== Search ===== */
    function matchesSearch(name, query) {
        var words = query.split(/\s+/);
        var lower = (name || '').toLowerCase();
        for (var i = 0; i < words.length; i++) {
            if (words[i] && lower.indexOf(words[i]) < 0) return false;
        }
        return true;
    }

    function searchKindLabel(kind) {
        if (kind === 'live') return T('badge_live');
        if (kind === 'movie') return T('badge_movie');
        if (kind === 'series') return T('badge_series');
        return '';
    }


    function findPlaylistForSearchEntry(entry) {
        var ref = entry && entry.ref ? entry.ref : null;
        var pls = Store.getPlaylists ? Store.getPlaylists() : [];
        var pid = (entry && entry.playlistId) || (ref && ref.playlistId) || '';
        var pname = (entry && entry.playlistName) || (ref && ref.playlistName) || '';
        for (var i = 0; i < pls.length; i++) {
            if (pid && pls[i].id === pid) return pls[i];
            if (pname && pls[i].name === pname) return pls[i];
        }
        var activeId = Store.getActivePlaylistId ? Store.getActivePlaylistId() : '';
        for (var j = 0; j < pls.length; j++) if (pls[j].id === activeId) return pls[j];
        return pls.length ? pls[0] : null;
    }

    function buildSearchVodChannel(entry, idx) {
        var ref = entry.ref || {};
        var pl = findPlaylistForSearchEntry(entry);
        if (!pl) return null;
        if (entry.kind === 'movie') {
            var sid = ref.stream_id || entry.stream_id || '';
            if (!sid) return null;
            var ext = ref.container_extension || 'mp4';
            var url = pl.host.replace(/\/$/, '') + '/movie/' +
                encodeURIComponent(pl.user) + '/' + encodeURIComponent(pl.pass) + '/' + sid + '.' + ext;
            return {
                id: 'vod-' + sid,
                name: ref.name || entry.title || '',
                logo: ref.stream_icon || ref.cover || entry.logo || '',
                url: url,
                category: 'Movies',
                searchCategory: cleanseSearchCategory(entry.category || ref.category_name),
                playlistId: pl.id,
                playlistName: pl.name,
                type: 'vod',
                plot: ref.plot || ref.description || '',
                cast: ref.cast || '',
                genre: ref.genre || ref.category_name || '',
                rating: ref.rating || ref.rating_5based || '',
                year: ref.year || ''
            };
        }
        if (entry.kind === 'series') {
            var seriesId = ref.series_id || entry.series_id || '';
            return {
                id: 'series-' + (seriesId || idx),
                name: ref.name || entry.title || '',
                logo: ref.cover || ref.stream_icon || entry.logo || '',
                category: 'Series',
                searchCategory: cleanseSearchCategory(entry.category || ref.category_name),
                playlistId: pl.id,
                playlistName: pl.name,
                type: 'series',
                _seriesData: ref,
                _seriesPlaylist: pl
            };
        }
        return null;
    }

    /* Clean a category name for display beside a search result's type badge.
     * Strips the common provider prefixes ("VOD - ", "SRS - ", "SERIES - ")
     * that just repeat the content type, leaving the meaningful part (which
     * usually encodes the language, e.g. "EN | Movies" -> "EN | Movies", but
     * "VOD - AR Movies" -> "AR Movies"). Returns '' for an empty/absent name. */
    function cleanseSearchCategory(name) {
        if (!name) return '';
        var s = String(name)
            .replace(/^(?:VOD|SRS|SERIES)\s*[-–—:|]\s*/i, '')
            .replace(/^\s+|\s+$/g, '');
        // Also strip decorative/tofu glyphs so category labels match the same
        // cleansing every channel name gets (some providers put superscript/
        // symbol tags in category names too).
        return Util.cleanseDisplayName ? Util.cleanseDisplayName(s) : s;
    }

    /* Re-render the Search screen ONLY if it is the currently visible section.
     * Called when catalog indexing finishes so the transient "still indexing"
     * notice clears (or is replaced by the truncation notice) without the user
     * having to leave and re-enter Search. Uses the live field value so an
     * in-progress query is preserved. No-op if Search isn't the active section. */
    function refreshSearchIfOpen() {
        var active = document.querySelector('.content-section.active');
        if (!active || active.getAttribute('data-section-content') !== 'search') return;
        var sf = $('#searchField');
        renderSearch(sf ? sf.value : '');
    }

    function renderSearch(query) {
        var results = $('#searchResults');
        if (!results) return;
        Util.empty(results);
        query = (query || '').trim();

        // Info notices (stalker / indexing / cap / empty-state hint) render inside
        // a dedicated block wrapper — NOT as flex children of the .search-results
        // card grid — so their vertical spacing is controlled here and they don't
        // get spread out by the flex layout. The wrapper is prepended; result cards
        // (if any) follow.
        var notice = el('div', { 'class': 'search-notes' });
        results.appendChild(notice);

        var activePl = null;
        var apid = Store.getActivePlaylistId ? Store.getActivePlaylistId() : null;
        if (apid) {
            var pls = Store.getPlaylists();
            for (var pi = 0; pi < pls.length; pi++) if (pls[pi].id === apid) { activePl = pls[pi]; break; }
        }
        if (activePl && activePl.type === 'stalker') {
            notice.appendChild(el('div', { 'class': 'search-empty', 'text': T('search_note_stalker') }));
        }

        // While the movies/series catalog is still streaming into the index,
        // search only covers what has been indexed so far. Surface that as a
        // transient notice so partial results during the ~load window don't look
        // broken. Clears automatically when indexing finishes (App re-renders the
        // Search screen via UI.refreshSearchIfOpen). Distinct from the permanent
        // cap/truncation notice below — this one means "still loading", that one
        // means "loaded as much as this device holds".
        try {
            if (window.App && App.isCatalogIndexing && App.isCatalogIndexing()) {
                notice.appendChild(el('div', { 'class': 'search-note-indexing', 'text': T('search_note_indexing') }));
            }
        } catch (eIdxNote) {}

        // If a very large catalog was truncated at the parse cap, some
        // movies/series aren't in the index — surface it here so a missing
        // result doesn't look like a bug (people may not have seen the toast).
        try {
            if (typeof PerfConfig !== 'undefined' && PerfConfig.capWasHit && PerfConfig.capWasHit()) {
                notice.appendChild(el('div', { 'class': 'search-note-cap', 'text': T('search_note_cap') }));
            }
        } catch (eCapNote) {}

        if (!query) {
            notice.appendChild(el('div', { 'class': 'search-empty', 'text': T('search_live_tv_movies_and_series') }));
            return;
        }

        // A single character matches almost everything in a large catalog, so
        // GlobalSearch declines to run it (the scan would score and sort the whole
        // index to display 80 rows). Prompt rather than showing a bare "no results",
        // which would look like a bug.
        if (query.trim().length < 2) {
            notice.appendChild(el('div', { 'class': 'search-empty', 'text': T('keep_typing_enter_at_least_2') }));
            return;
        }

        // Use GlobalSearch if available, fallback to live-only
        var matches = [];
        if (typeof GlobalSearch !== 'undefined' && GlobalSearch.isReady()) {
            matches = GlobalSearch.search(query);
        } else {
            var q = query.toLowerCase();
            for (var i = 0; i < ALL_CHANNELS.length && matches.length < 80; i++) {
                if (matchesSearch(ALL_CHANNELS[i].name, q)) {
                    matches.push({ kind: 'live', title: ALL_CHANNELS[i].name, ref: ALL_CHANNELS[i], logo: ALL_CHANNELS[i].logo, category: ALL_CHANNELS[i].category, playlistName: ALL_CHANNELS[i].playlistName });
                }
            }
        }

        if (!matches.length) {
            results.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_results_for') + query + '"' }));
            return;
        }

        var grid = el('div', { 'class': 'channel-grid' });
        for (var j = 0; j < matches.length; j++) {
            var entry = matches[j];
            var ch;
            if (entry.kind === 'movie' || entry.kind === 'series') {
                ch = buildSearchVodChannel(entry, j);
                if (!ch) continue;
            } else if (entry.ref && entry.ref.id) {
                ch = entry.ref;
                if (!ch.type) ch.type = 'live';
                ch.searchCategory = cleanseSearchCategory(entry.category || ch.category);
            } else {
                ch = {
                    id: entry.id || ('search-' + j),
                    name: entry.title || '',
                    logo: entry.logo || '',
                    url: (entry.ref && entry.ref.url) || '',
                    category: entry.category || '',
                    searchCategory: cleanseSearchCategory(entry.category),
                    playlistName: entry.playlistName || '',
                    playlistId: entry.playlistId || '',
                    type: 'live',
                    number: entry.number || 0
                };
            }
            var card = makeChannelCard(ch, { liveLabelInline: entry.kind === 'live' });
            // The content-type label ("MOVIE"/"SERIES"/"LIVE") is rendered INSIDE
            // .ch-info by makeChannelCard, in the same position for every kind, so
            // search results line up regardless of type. (Previously LIVE got an
            // outer badge inserted at the card top, which sat in a different place
            // than the movie/series label and looked misaligned.)
            grid.appendChild(card);
        }
        results.appendChild(grid);
    }

    /* Removed the dead standalone EPG screen.
     * Previously: EPG_STATE + renderEpg() + renderEpgPage() rendered into
     * #epgBody (DOM ids that haven't existed in markup for a long time).
     * UI.renderEpg was never called externally and the section-switch
     * branch for name === 'epg' is unreachable (no nav-btn targets it).
     * The Live TV guide screen — renderEpgTimeBar / renderLiveChannels /
     * makeLiveChannelRow further up in this file — is the surviving EPG UI.
     */

    /* ===== Playlists ===== */
    function renderPlaylists() {
        var list = $('#plList');
        if (!list) return;
        Util.empty(list);
        var pls = Store.getPlaylists();
        var activeId = Store.getActivePlaylistId();
        if (!pls.length) {
            list.appendChild(el('div', { 'class': 'search-empty', 'text': T('no_playlists_add_one_to_get') }));
            Focus.refresh();
            return;
        }
        for (var i = 0; i < pls.length; i++) {
            (function (pl) {
                var isActive = pl.id === activeId;
                var card = el('div', {
                    'class': 'pl-card focusable' + (isActive ? ' active' : ''),
                    'tabindex': '-1',
                    'data-focus-key': 'pl-' + pl.id
                });
                var info = el('div', { 'class': 'pl-info' });
                info.appendChild(el('div', { 'class': 'pl-name', 'text': pl.name || '(unnamed)' }));
                var meta = el('div', { 'class': 'pl-meta' });
                meta.appendChild(el('span', { 'class': 'pl-type', 'text': (pl.type || 'm3u').toUpperCase() }));
                meta.appendChild(el('span', { 'text': pl.type === 'xtream' ? (pl.host || '') : (pl.url || '') }));
                info.appendChild(meta);

                // Status badge instead of inline buttons
                if (isActive) {
                    var badge = el('div', { 'class': 'pl-badge', 'text': T('active') });
                    info.appendChild(badge);
                }
                // Credentials-needed badge. MUST use the same check as the load
                // gate (App.playlistNeedsCreds) so the badge never contradicts
                // whether the playlist actually loads: an uploaded-file M3U carries
                // inline content (no url) and is complete, Stalker needs a mac, etc.
                // (A previous inline "!pl.url" check here wrongly badged every
                // content M3U as "credentials needed" even though it loaded fine —
                // the load gate was fixed but this display check was missed.)
                var cardNeedsCreds;
                if (window.App && App.playlistNeedsCreds) {
                    cardNeedsCreds = App.playlistNeedsCreds(pl);
                } else {
                    cardNeedsCreds = (pl.type === 'xtream') ? (!pl.user || !pl.pass)
                        : (pl.type === 'stalker') ? !pl.mac
                        : (pl.type === 'm3u') ? !(pl.url || (pl.content && pl.content.length))
                        : false;
                    if (pl.credsNeeded) cardNeedsCreds = true;
                }
                if (cardNeedsCreds) {
                    info.appendChild(el('div', { 'class': 'pl-badge pl-badge-creds', 'text': T('credentials_needed') }));
                }

                // Expiry display
                if (pl.expiry) {
                    var expDate = new Date(pl.expiry);
                    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                    var now = Date.now();
                    var daysLeft = Math.ceil((pl.expiry - now) / 86400000);
                    var dateStr = expDate.getDate() + ' ' + months[expDate.getMonth()] + ' ' + expDate.getFullYear();
                    var expText = daysLeft > 0 ? T('ui_expires') + ' ' + dateStr + ' (' + daysLeft + ' ' + T('ui_days') + ')' : T('ui_expired');
                    var expClass = daysLeft <= 0 ? 'pl-expiry expired' : daysLeft <= 7 ? 'pl-expiry warn' : 'pl-expiry';
                    info.appendChild(el('div', { 'class': expClass, 'text': expText, 'data-pl-expiry': pl.id }));
                }

                card.appendChild(info);

                // Per-playlist content toggles, shown UNDER the playlist details.
                // Shown for Xtream AND Stalker portals — both expose a real
                // live/movies/series split that the side menu honours. M3U is a
                // single flat file with no reliable split, so it's excluded.
                // Each chip is separately focusable; toggling persists and
                // live-updates the menu + loaded content (App.setPlaylistContent).
                if (pl.type === 'xtream' || pl.type === 'stalker') {
                    var ctNow = Store.getPlaylistContentTypes
                        ? Store.getPlaylistContentTypes(pl.id)
                        : { live: true, movies: true, series: true };
                    var toggles = el('div', { 'class': 'pl-ct-toggles' });
                    var ctDefs = [ ['live', 'Live TV'], ['movies', 'Movies'], ['series', 'Series'] ];
                    for (var t = 0; t < ctDefs.length; t++) {
                        (function (key, label) {
                            var on = !!ctNow[key];
                            // Real checkbox + label (matches the add-playlist page).
                            // The <label> is the focusable element; the inner
                            // checkbox reflects on/off state.
                            var wrap = el('label', {
                                'class': 'ct-check pl-ct-check focusable',
                                'tabindex': '-1',
                                'data-focus-key': 'plct-' + key + '-' + pl.id
                            });
                            var box = el('input', { 'type': 'checkbox' });
                            box.checked = on;
                            wrap.appendChild(box);
                            wrap.appendChild(document.createTextNode(' ' + label));
                            wrap.addEventListener('click', function (ev) {
                                if (ev && ev.preventDefault) ev.preventDefault();
                                if (ev && ev.stopPropagation) ev.stopPropagation();
                                var cur = Store.getPlaylistContentTypes(pl.id);
                                var next = { live: cur.live, movies: cur.movies, series: cur.series };
                                next[key] = !next[key];
                                if (!next.live && !next.movies && !next.series) {
                                    UI.toast(T('at_least_one_content_type_must'), 'err');
                                    return;
                                }
                                if (window.App && App.setPlaylistContent) {
                                    App.setPlaylistContent(pl.id, next);
                                }
                            });
                            toggles.appendChild(wrap);
                        })(ctDefs[t][0], ctDefs[t][1]);
                    }
                    // EPG toggle — a separate option, set apart on the right.
                    var epgOn = Store.getPlaylistEpgEnabled
                        ? Store.getPlaylistEpgEnabled(pl.id) : true;
                    var epgWrap = el('label', {
                        'class': 'ct-check pl-ct-check pl-ct-epg focusable',
                        'tabindex': '-1',
                        'data-focus-key': 'plct-epg-' + pl.id
                    });
                    var epgBox = el('input', { 'type': 'checkbox' });
                    epgBox.checked = epgOn;
                    epgWrap.appendChild(epgBox);
                    epgWrap.appendChild(document.createTextNode(' EPG'));
                    epgWrap.addEventListener('click', function (ev) {
                        if (ev && ev.preventDefault) ev.preventDefault();
                        if (ev && ev.stopPropagation) ev.stopPropagation();
                        var cur = Store.getPlaylistEpgEnabled(pl.id);
                        if (window.App && App.setPlaylistEpg) {
                            App.setPlaylistEpg(pl.id, !cur);
                        }
                    });
                    toggles.appendChild(epgWrap);
                    info.appendChild(toggles);
                }

                // On click/OK: open action sheet
                card.addEventListener('click', function () {
                    var items = [];
                    // If this is a "shell" synced from another device (creds
                    // stripped, none entered on this device yet), surface credential
                    // entry first. Uses the same check as the load gate / badge
                    // (App.playlistNeedsCreds) so all three agree: xtream needs
                    // user+pass; stalker needs mac; m3u needs url OR inline content.
                    var plNeedsCreds;
                    if (window.App && App.playlistNeedsCreds) {
                        plNeedsCreds = App.playlistNeedsCreds(pl);
                    } else {
                        plNeedsCreds = (pl.type === 'xtream') ? (!pl.user || !pl.pass)
                            : (pl.type === 'stalker') ? !pl.mac
                            : (pl.type === 'm3u') ? !(pl.url || (pl.content && pl.content.length))
                            : false;
                        if (pl.credsNeeded) plNeedsCreds = true;
                    }
                    if (plNeedsCreds) {
                        items.push({
                            label: T('act_enter_credentials'),
                            onClick: function () {
                                if (window.App && App.editPlaylist) App.editPlaylist(pl.id);
                            }
                        });
                    }
                    // EPG Refresh: re-fetch and re-merge every EPG source for
                    // this playlist (provider EPG plus any externals, honoring the
                    // external-override setting), bypassing the freshness cache.
                    items.push({
                        label: T('act_epg_refresh'),
                        onClick: function () {
                            if (window.App && App.refreshPlaylistEpg) App.refreshPlaylistEpg(pl.id);
                        }
                    });
                    if (!isActive) {
                        items.push({
                            label: T('act_set_active'),
                            onClick: function () {
                                if (window.App && App.activatePlaylist) App.activatePlaylist(pl.id);
                            }
                        });
                    }
                    items.push({
                        label: T('act_edit'),
                        onClick: function () {
                            if (window.App && App.editPlaylist) App.editPlaylist(pl.id);
                        }
                    });
                    items.push({
                        label: T('act_source_refresh'),
                        onClick: function () {
                            // Re-fetch the playlist from its source, discarding the
                            // cached channel list. Use when the provider's channels
                            // or stream URLs have changed upstream.
                            if (window.App && App.refreshPlaylist) App.refreshPlaylist(pl.id);
                        }
                    });
                    items.push({
                        label: T('act_delete'),
                        style: 'danger',
                        onClick: function () {
                            // Confirm
                            UI.openModal({
                                title: T('act_delete_source_title'),
                                body: T('act_delete_confirm') + ' "' + (pl.name || '') + '"',
                                okText: T('act_delete'), cancelText: T('cancel'),
                                onOk: function () {
                                    if (window.App && App.deletePlaylist) App.deletePlaylist(pl.id);
                                    UI.closeModal();
                                }
                            });
                        }
                    });
                    UI.openActionSheet({
                        title: pl.name || '(unnamed)',
                        body: (plNeedsCreds || pl.credsNeeded)
                            ? T('act_needs_creds')
                            : (isActive ? T('act_is_active') : T('act_choose')),
                        items: items
                    });
                });

                list.appendChild(card);
            })(pls[i]);
        }
        // ensureCoffeeCard() call removed from here — the
        // card moved to the settings section. See showSection('settings').
    }

    function ensureCoffeeCard() {
        // The card moved out of the playlists section and
        // into the settings section. It now sits at the bottom of the
        // settings list, after all other settings, as a permanent support
        // prompt — users see it while browsing preferences rather than
        // when wrangling data. The previous playlists-page placement is
        // gone entirely. As before we re-anchor on every render so
        // leftover instances are cleaned up.
        var section = document.querySelector('.content-section[data-section-content="settings"]');
        if (!section) return;
        var existing = section.querySelector('.coffee-card');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        var card = el('div', { 'class': 'coffee-card' });
        var heading = el('div', { 'class': 'coffee-heading', 'text': T('enjoying_the_app_support_development') });
        card.appendChild(heading);

        // Donate / bug-report presentation:
        //  - Everywhere: the QR plus plain-text support email. This is the
        //    only form on webOS/Tizen, which have no browser or mail client
        //    to hand a link to.
        //  - Inside the Android app only: ALSO a tappable donate link and a
        //    mailto link (MainActivity forwards http(s)/mailto to the
        //    system). Keyed on "is this the Android app", not on
        //    Mobile.isTouch(), which can misreport on generic Android boxes
        //    (see its own doc comment). The card sits last in Settings, so
        //    these links are not focusable: the QR and plain-text address are
        //    the remote path.
        var isAndroidApp = (typeof Player !== 'undefined' && Player.isAndroidWebView && Player.isAndroidWebView());

        var qr = new Image();
        qr.className = 'coffee-qr';
        qr.src = 'assets/img/donate_qr.png';
        qr.alt = 'Donate QR (donate.xtivio.vip)';
        card.appendChild(qr);
        var note = el('div', { 'class': 'coffee-note', 'text': T('scan_the_qr_with_your_phone') });
        card.appendChild(note);

        if (isAndroidApp) {
            var donateLink = el('a', {
                'class': 'coffee-link donate-link',
                'text': T('ui_donate') || 'Donate'
            });
            donateLink.setAttribute('href', 'https://donate.xtivio.vip');
            donateLink.setAttribute('target', '_blank');
            donateLink.setAttribute('rel', 'noopener noreferrer');
            card.appendChild(donateLink);
        }

        // Bug reporting — sits below the donate QR. The email is a constant
        // substituted into the translatable line so word order is free.
        var bugHeading = el('div', { 'class': 'coffee-heading bug-report-heading', 'text': T('found_a_bug_report_it') });
        card.appendChild(bugHeading);
        var bugNote = el('div', { 'class': 'coffee-note bug-report-note', 'text': T('email_us_at_bug_report', { email: 'dev@xtivio.vip' }) });
        card.appendChild(bugNote);
        if (isAndroidApp) {
            var bugLink = el('a', {
                'class': 'coffee-link bug-report-link',
                'text': 'dev@xtivio.vip'
            });
            bugLink.setAttribute('href', 'mailto:dev@xtivio.vip');
            card.appendChild(bugLink);
        }

        section.appendChild(card);
    }

    function setActivePlaylistChip(name, count) {
        var chipName = $('#activePlaylistChip');
        var chipCount = $('#channelCountChip');
        if (chipName) chipName.textContent = name || T('ui_no_playlist');
        if (chipCount) {
            // Callers may pass either a NUMBER (item count -> "N items indexed" /
            // "Indexing… N") or a pre-formatted STRING (e.g. Stalker's "N categories").
            // A string is already complete — show it as-is; only numbers get wrapped.
            if (typeof count === 'string') {
                chipCount.textContent = count;
                chipCount.classList.remove('chip-indexing');
                return;
            }
            var n = (count != null ? count : 0);
            var indexing = !!(window.App && App.isCatalogIndexing && App.isCatalogIndexing());
            // While the VOD/series catalog is still streaming into the index, the
            // count climbs in ~2000-item steps and PAUSES between kinds (movies
            // finish, then a GC gap before series start). A plain "{n} items indexed"
            // then looks either broken at 0 or frozen mid-load. Switch to an
            // "Indexing… {n}" label plus a pulsing ellipsis (.chip-indexing, CSS
            // animation) so the chip reads as ACTIVE even when the number is static
            // for a moment. Flips back to the settled "{n} items indexed" when
            // App.isCatalogIndexing() goes false (both kinds done).
            if (indexing) {
                chipCount.textContent = T('ui_n_items_indexing', { n: n });
                chipCount.classList.add('chip-indexing');
            } else {
                chipCount.textContent = T('ui_n_items', { n: n });
                chipCount.classList.remove('chip-indexing');
            }
        }
    }

    /* ===== Mini channel list (player) - paged ===== */
    var MINI_PAGE_SIZE = 50;
    var miniPage = 0;
    var miniPageInitialized = false;

    /* Focus the first or last actual channel row in the mini list, skipping the
     * Prev/Next page buttons (which also carry .mini-ch). Used after paging so
     * focus lands on a channel (top after down-paging, bottom after up-paging)
     * rather than on the page button. */
    function focusMiniChannelEdge(which) {
        var miniList = $('#miniList');
        if (!miniList) return;
        var rows = miniList.querySelectorAll('.mini-ch.focusable');
        var picked = null;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('mini-page-btn')) continue;
            picked = rows[i];
            if (which === 'first') break; // first match
            // for 'last', keep going to the final non-page row
        }
        if (picked && window.Focus && Focus.focus) Focus.focus(picked);
    }

    function refreshMiniChannels(forceRecenter) {
        var miniList = $('#miniList');
        if (!miniList) return;
        // Capture the focused row's key so an EPG-fill repaint (which rebuilds the
        // DOM) restores focus to the same channel instead of dropping it.
        var prevKey = null;
        try {
            var cf = (window.Focus && Focus.current) ? Focus.current() : null;
            if (cf && cf.getAttribute && miniList.contains(cf)) {
                prevKey = cf.getAttribute('data-focus-key');
            }
        } catch (eCap) {}
        Util.empty(miniList);
        var current = Player.currentChannel();
        var total = ALL_CHANNELS.length;
        if (!total) return;

        // Only center on current channel on first open or explicit recenter
        if (!miniPageInitialized || forceRecenter) {
            miniPageInitialized = true;
            if (current) {
                for (var ci = 0; ci < total; ci++) {
                    if (ALL_CHANNELS[ci].id === current.id) {
                        miniPage = Math.floor(ci / MINI_PAGE_SIZE);
                        break;
                    }
                }
            }
        }

        var pageStart = miniPage * MINI_PAGE_SIZE;
        var pageEnd = Math.min(pageStart + MINI_PAGE_SIZE, total);
        var totalPages = Math.ceil(total / MINI_PAGE_SIZE);

        // Page info
        if (totalPages > 1) {
            miniList.appendChild(el('div', {
                'class': 'mini-page-info',
                'text': (pageStart + 1) + '–' + pageEnd + ' of ' + total
            }));
        }

        // Prev page
        if (miniPage > 0) {
            var prevBtn = el('div', {
                'class': 'mini-ch mini-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': 'mini-prev',
                'text': T('previous_2') + MINI_PAGE_SIZE
            });
            prevBtn.addEventListener('click', function () {
                miniPage--;
                refreshMiniChannels();
                // Up-paging lands focus on the BOTTOM channel of the new page
                // (so the user continues upward naturally), not back on the
                // page button.
                setTimeout(function () { focusMiniChannelEdge('last'); }, 50);
            });
            miniList.appendChild(prevBtn);
        }

        // Channel items for this page
        var slice = ALL_CHANNELS.slice(pageStart, pageEnd);
        // Batch-prefetch this page's EPG so the now-playing lines fill together
        // (one re-render) rather than each row lazily loading + repainting.
        if (window.Epg && Epg.prefetchChannels && slice.length) {
            var preIds = [];
            for (var pf = 0; pf < slice.length; pf++) {
                preIds.push(slice[pf].tvgId || slice[pf].epgId);
            }
            Epg.prefetchChannels(slice[0].playlistId, preIds);
        }
        for (var i = 0; i < slice.length; i++) {
            (function (ch) {
                var item = el('div', {
                    'class': 'mini-ch focusable' + (current && current.id === ch.id ? ' playing' : ''),
                    'tabindex': '-1',
                    'data-focus-key': 'mini-' + ch.id
                });
                item.appendChild(el('div', { 'class': 'mini-ch-num', 'text': Util.pad(ch.number || 0, 3) }));
                var info = el('div', { 'class': 'mini-ch-info' });
                info.appendChild(el('div', { 'class': 'mini-ch-name', 'text': Util.cleanseDisplayName(ch.name || '') }));
                var nn = stalkerNowNext(ch.playlistId, ch);
                info.appendChild(el('div', { 'class': 'mini-ch-prog', 'text': nn.now ? Util.cleanseDisplayName(nn.now.title) : '' }));
                item.appendChild(info);
                item.addEventListener('click', function () {
                    Player.play(ch);
                    refreshMiniChannels();
                    // Re-focus the now-playing channel
                    Focus.focusKey('mini-' + ch.id);
                });
                miniList.appendChild(item);
            })(slice[i]);
        }

        // Next page
        if (pageEnd < total) {
            var nextBtn = el('div', {
                'class': 'mini-ch mini-page-btn focusable',
                'tabindex': '-1',
                'data-focus-key': 'mini-next',
                'text': T('next_2') + Math.min(MINI_PAGE_SIZE, total - pageEnd) + ' (' + (total - pageEnd) + ' more)'
            });
            nextBtn.addEventListener('click', function () {
                miniPage++;
                refreshMiniChannels();
                // Down-paging lands focus on the TOP channel of the new page
                // (so the user continues downward naturally), not on the page
                // button.
                setTimeout(function () { focusMiniChannelEdge('first'); }, 50);
            });
            miniList.appendChild(nextBtn);
        }

        // Restore focus to the same channel row after an EPG-fill repaint, so the
        // async/prefetch re-render never steals the user's place in the list. Only
        // when we captured a key AND aren't doing an explicit recenter (open/paging
        // set focus themselves).
        if (prevKey && !forceRecenter && window.Focus && Focus.focusKey) {
            try { Focus.focusKey(prevKey); } catch (eRes) {}
        }
    }

    /* ===== Action Sheet (dynamic button list in a modal) ===== */


    /* ===== Screen helpers ===== */
    var _lastScreenId = null;
    function showScreen(id) {
        // Switching to a different screen leaves the keyboard of the old one behind
        // otherwise (it is global, not part of any screen).
        try {
            var curScr = document.querySelector('.screen.active');
            if ((!curScr || curScr.id !== id) && UI.dismissVKeyboard) UI.dismissVKeyboard();
        } catch (eDk) {}
        var screens = $$('.screen');
        for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
        var s = document.getElementById(id);
        if (s) {
            s.classList.add('active');
            // Pinch-zoom vs the player: WebView's built-in pinch gesture is a
            // whole-WebView setting (not something CSS/JS can scope to one
            // screen), and it actually zooms right through the info overlay
            // — the overlay's own controls could visibly shift out from under
            // a finger mid-pinch. Turn it off while the player is the active
            // screen, back on everywhere else (menus/EPG keep pinch-zoom as
            // the accessibility affordance it was added for). Only fires on
            // an actual transition, not every showScreen('player') call
            // during normal playback (channel changes, etc).
            //
            // Tapping a live channel a second time while
            // it's already playing in the mini preview (first OK = mini,
            // second OK = fullscreen in tryPlay()) opened the full player
            // with audio but no video; it was fine via the mini's own
            // expand button and when opening straight from Home/hero, i.e. only
            // the path that goes through LiveTopMiniPlayer.suspend() first:
            // AndroidBridge.setZoomEnabled(false)'s own WebView scale/scroll
            // reset (zoomBy + scrollTo, added to actually fix the zoom-reset
            // bug) touches the WebView's live layout at the exact same
            // moment suspend()'s own comment describes a known, carefully-
            // ordered race — Player.stop() has to re-arm the native shutter
            // BEFORE stopExoBoundsTracking() resets the surface rect, or the
            // surface briefly renders uncovered while the WebView's CSS
            // repaint catches up. Racing a SECOND WebView-layout change
            // (mine) into that exact window plausibly corrupts the
            // fullscreen rect calculation the new Player.play() call then
            // sets the SurfaceView to — audio is unaffected since it doesn't
            // depend on the surface at all, matching exactly what was
            // observed. Deferred well past that whole sequence (250ms) only
            // when ENTERING the player, rather than trying to out-guess the
            // native timing; leaving the player (id!=='player', re-enabling
            // zoom) has no surface interaction at all and stays immediate.
            if (id !== _lastScreenId) {
                try {
                    if (window.AndroidBridge && typeof AndroidBridge.setZoomEnabled === 'function') {
                        if (id === 'player') {
                            setTimeout(function () {
                                // Guard: only apply if still actually on the
                                // player screen — if the user backed out
                                // again inside this window, _lastScreenId
                                // has already moved on and this deferred
                                // call would otherwise wrongly disable zoom
                                // on whatever screen they're on now instead.
                                if (_lastScreenId !== 'player') return;
                                try { AndroidBridge.setZoomEnabled(false); } catch (eZoomD) {}
                            }, 250);
                        } else {
                            AndroidBridge.setZoomEnabled(true);
                        }
                    }
                } catch (eZoom) {}
            }
            _lastScreenId = id;
            // Null any focus that was on the outgoing screen immediately, so a
            // keypress in the gap before focusFirstIn runs can't route to a
            // now-hidden element (the arrow handlers fall back to first-visible
            // when CURRENT is null).
            if (window.Focus && Focus.refresh) Focus.refresh();
            // Don't auto-focus on player screen — it has its own focus handling
            if (id !== 'player') {
                setTimeout(function () { Focus.focusFirstIn(s); }, 50);
            }
        }
    }
    var SECTION_FOCUS_MEMORY = {};
    var _nowBarCh = null;
    /* GREEN in the Live TV guide: open the Catch-up page on the channel shown in the Now/Next box. */
    function openCatchupForShown() {
        var ch = _nowBarCh;
        if (!ch || !window.Catchup || !Catchup.supports(ch) || !window.CatchupScreen) return false;
        CatchupScreen.openFor(ch);
        return true;
    }

    // Continuously track focus — only memorize elements inside content sections
    Focus.onChange(function(prev, curr) {
        if (curr && curr.getAttribute && curr.getAttribute('data-focus-key')) {
            var section = null;
            var p = curr.parentNode;
            while (p && p !== document.body) {
                if (p.classList && p.classList.contains('content-section')) { section = p; break; }
                p = p.parentNode;
            }
            if (section) {
                var sname = section.getAttribute('data-section-content');
                if (sname) SECTION_FOCUS_MEMORY[sname] = curr.getAttribute('data-focus-key');
            }
        }
    });


    function updatePlaylistExpiry(plId, expiryMs) {
        var el = document.querySelector('[data-pl-expiry="' + plId + '"]');
        if (!el) return;
        var daysLeft = Math.ceil((expiryMs - Date.now()) / 86400000);
        var expDate = new Date(expiryMs);
        // Same format as the card render (renderPlaylists) so the expiry text is
        // identical whether it comes from the initial render or this live-fetch
        // update: "25 Dec 2025", locale-independent (no MM/DD vs DD/MM ambiguity).
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dateStr = expDate.getDate() + ' ' + months[expDate.getMonth()] + ' ' + expDate.getFullYear();
        el.textContent = daysLeft > 0 ? T('ui_expires') + ' ' + dateStr + ' (' + daysLeft + ' ' + T('ui_days') + ')' : T('ui_expired');
        el.className = daysLeft <= 0 ? 'pl-expiry expired' : daysLeft <= 7 ? 'pl-expiry warn' : 'pl-expiry';
    }

    var _searchKbTimer = null;
    function showSection(name, resetMemory) {
        // Moving to another section (sidebar) must close the search keyboard: it is
        // a global overlay, so otherwise it stayed up covering the new section.
        try { if (UI.dismissVKeyboard) UI.dismissVKeyboard(); } catch (eDk) {}
        // Search schedules its keyboard to open shortly after the section shows; if the
        // user has already moved on, that pending open must not fire in the new section.
        if (_searchKbTimer) { clearTimeout(_searchKbTimer); _searchKbTimer = null; }
        var sections = $$('.content-section');
        var prevSection = null;

        for (var i = 0; i < sections.length; i++) {
            if (sections[i].classList.contains('active')) {
                prevSection = sections[i].getAttribute('data-section-content');
            }
            if (sections[i].getAttribute('data-section-content') === name) sections[i].classList.add('active');
            else sections[i].classList.remove('active');
        }

        // Drop focus that was on the outgoing section before it's hidden, so a
        // key in the switch gap can't act on an invisible element.
        if (window.Focus && Focus.refresh) Focus.refresh();

        // Wipe memory for incoming section if requested by sidebar click
        if (resetMemory) {
            SECTION_FOCUS_MEMORY[name] = null;
        }

        if (resetMemory) { SECTION_FOCUS_MEMORY[name] = null; }

        if (prevSection === 'livetv' && name !== 'livetv') {
            if (window.LiveTopMiniPlayer && LiveTopMiniPlayer.stop) LiveTopMiniPlayer.stop(true);
        }

        if (prevSection === 'movies' && name !== 'movies') clearVodInfoPanel('movie');
        if (prevSection === 'series' && name !== 'series') clearVodInfoPanel('series');

        var navs = $$('.nav-btn');
        for (var j = 0; j < navs.length; j++) {
            if (navs[j].getAttribute('data-section') === name) navs[j].classList.add('active');
            else navs[j].classList.remove('active');
        }

        if (name === 'home') renderHome();
        else if (name === 'favorites') {
            if (resetMemory && typeof resetFavoritesToLive === 'function') resetFavoritesToLive();
            renderFavorites();
        }
        else if (name === 'livetv') {
            var catList = document.getElementById('liveCatList');
            if (resetMemory || !catList || !catList.children.length) {
                if (isStalkerMode()) renderStalkerCategories();
                else renderCategories();
            } else {
                // Category column already built (normal re-entry): rebuild the rows
                // so now-available EPG appears (they may have rendered "No EPG data"
                // before the guide finished loading).
                try { if (!(Store.getViewMode && Store.getViewMode('live') === 'card')) refreshLiveEpgRows(); } catch (eRe) {}
            }
            // Both paths: the initial row render can miss EPG that is resident but
            // resolves through the async per-channel IDB path (first access is a
            // cache miss and returns null "now"). Those async reads fire their own
            // re-render, but to be robust across timing we also repaint once shortly
            // after entry — refreshLiveEpgRows fills the rows when data is available
            // (verified on-device). List view only; card view has no guide rows.
            try {
                if (!(Store.getViewMode && Store.getViewMode('live') === 'card')) {
                    setTimeout(function () { try { refreshLiveEpgRows(); } catch (e2) {} }, 400);
                }
            } catch (eDef) {}
            // The legacy in-guide "Now Playing" bar (DOM ids
            // liveNowCh / liveNowTitle / liveNowTime) was removed from the
            // markup. The side panel #liveNowSide is owned exclusively by
            // LiveTopMiniPlayer.play() / .stop() and updateLiveNowBar(),
            // so we no longer need to update anything from here.
            var cf1 = document.getElementById('liveCatFilter');
            if (cf1) { cf1.value = ''; var ev1 = document.createEvent('Event'); ev1.initEvent('input',true,true); cf1.dispatchEvent(ev1); }
            // Mini player is always visible in livetv section
        }
        else if (name === 'search') {
            var sf = $('#searchField');
            if (sf) sf.value = '';
            renderSearch('');
            _searchKbTimer = setTimeout(function () {
                _searchKbTimer = null;
                // Only if Search is still the section on screen.
                var act = document.querySelector('.content-section.active');
                if (!act || act.getAttribute('data-section-content') !== 'search') return;
                var sf2 = $('#searchField');
                if (sf2 && window.Focus && Focus.focus) { Focus.focus(sf2); }
                if (sf2 && UI.openVKeyboard) UI.openVKeyboard(sf2);
            }, 220);
        }
        else if (name === 'movies') {
            var mCatList = document.getElementById('movieCatList');
            if (resetMemory || !mCatList || !mCatList.children.length) renderMovies();
            var cf2 = document.getElementById('movieCatFilter');
            if (cf2) { cf2.value = ''; var ev2 = document.createEvent('Event'); ev2.initEvent('input',true,true); cf2.dispatchEvent(ev2); }
        }
        else if (name === 'series') {
            var sCatList = document.getElementById('seriesCatList');
            if (resetMemory || !sCatList || !sCatList.children.length) renderSeries();
            var cf3 = document.getElementById('seriesCatFilter');
            if (cf3) { cf3.value = ''; var ev3 = document.createEvent('Event'); ev3.initEvent('input',true,true); cf3.dispatchEvent(ev3); }
        }
        else if (name === 'sports') { if (window.Sports) Sports.enter(); }
        else if (name === 'catchup') { if (window.CatchupScreen) CatchupScreen.enter(); }
        else if (name === 'playlists') {
            renderPlaylists();
            // The external-EPG summary line lives in this section, not Settings.
            try { if (window.App && App.updateEpgSummary) App.updateEpgSummary(); } catch (eEs) {}
        }
        else if (name === 'settings') {
            // The Buy Me a Coffee card lives at the
            // bottom of the settings list now (moved out of the
            // playlists section). Re-anchor on every nav so any
            // leftover instances are cleaned up.
            ensureCoffeeCard();
        }

        var catListIds2 = { livetv: 'liveCatList', movies: 'movieCatList', series: 'seriesCatList' };
        var memKey2 = SECTION_FOCUS_MEMORY[name];

        function tryRestoreFocus(attempt) {
            var curFocused = Focus.current();
            var inSidebar = false;
            if (curFocused) {
                var sp = curFocused.parentNode;
                while (sp && sp !== document.body) {
                    if (sp.classList && sp.classList.contains('sidebar')) { inSidebar = true; break; }
                    sp = sp.parentNode;
                }
            }
            if (inSidebar || !curFocused || !document.body.contains(curFocused)) {
                var restored = false;
                // Live TV with the categories column collapsed: its rows are hidden, so neither
                // the remembered category nor the category list can take focus. Land on the first
                // channel (retry while it loads), or on the collapse arrow if there is none.
                var lcCol = (name === 'livetv') ? document.getElementById('liveCats') : null;
                if (lcCol && lcCol.classList.contains('cats-collapsed')) {
                    var chl = document.getElementById('liveChList');
                    var chTarget = chl ? chl.querySelector('.focusable') : null;
                    if (chTarget) { Focus.focus(chTarget); }
                    else if (attempt < 4) { setTimeout(function () { tryRestoreFocus(attempt + 1); }, 300); }
                    else { Focus.focusKey('livetv-cats-toggle'); }
                    return;
                }
                if (memKey2) restored = Focus.focusKey(memKey2);
                if (!restored) {
                    // Card view (Movies/Series) has NO category column — it's
                    // display:none — so the category-list target below lands on a
                    // hidden element and focus goes nowhere ("no initial focus").
                    // Land on the action bar's first button instead, falling back to
                    // the first grid card, then retrying while the async grid fills.
                    if ((name === 'movies' || name === 'series') &&
                        (Store.getViewMode && Store.getViewMode(name) === 'card')) {
                        var barId = (name === 'series' ? 'seriesCardBar' : 'movieCardBar');
                        var gridCardId = (name === 'series' ? 'seriesList' : 'movieList');
                        var barEl = document.getElementById(barId);
                        var gridCards = document.getElementById(gridCardId);
                        if (barEl && barEl.querySelector('.focusable')) {
                            Focus.focusFirstIn(barEl);
                        } else if (gridCards && gridCards.querySelector('.focusable')) {
                            Focus.focusFirstIn(gridCards);
                        } else if (attempt < 4) {
                            setTimeout(function () { tryRestoreFocus(attempt + 1); }, 300);
                        }
                        return;
                    }
                    var catId = catListIds2[name];
                    if (catId) {
                        var cl = document.getElementById(catId);
                        if (cl && cl.querySelector('.focusable')) {
                            var target = cl.querySelector('.panel-cat-item.active') || cl.querySelector('.cat-item.active') || cl.querySelector('.focusable');
                            if (target) Focus.focus(target);
                        } else if (attempt < 4) {
                            setTimeout(function () { tryRestoreFocus(attempt + 1); }, 300);
                        }
                    } else {
                        var sectionEl = document.querySelector('.content-section[data-section-content="' + name + '"]');
                        if (sectionEl) Focus.focusFirstIn(sectionEl);
                    }
                }
            }
        }
        setTimeout(function () { tryRestoreFocus(0); }, 150);
    }

    /* ===== Loading overlay ===== */
    function showLoading(msg) {
        var overlay = $('#loadingOverlay');
        if (!overlay) {
            // Create it dynamically if not in HTML
            overlay = el('div', { 'id': 'loadingOverlay', 'class': 'loading-overlay' });
            overlay.appendChild(el('div', { 'class': 'loading-spinner' }));
            overlay.appendChild(el('div', { 'class': 'loading-text', 'id': 'loadingText', 'text': msg || 'Loading...' }));
            document.getElementById('app').appendChild(overlay);
        } else {
            var txt = overlay.querySelector('.loading-text') || $('#loadingText');
            if (txt) txt.textContent = msg || 'Loading...';
        }
        overlay.classList.remove('hidden');
        overlay.style.display = '';
    }
    function hideLoading() {
        var overlay = $('#loadingOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.style.display = 'none';
        }
    }


    function refreshVodProgressBars() {
        var rows = document.querySelectorAll('.media-row');
        var row, base, bars, b;
        for (var i = 0; i < rows.length; i++) {
            row = rows[i];
            base = row._basePlayItem || row._playItem || null;
            if (!base) continue;
            applyVodHistoryToItem(base);
            bars = row.querySelectorAll('.ch-progress');
            for (b = bars.length - 1; b >= 0; b--) {
                if (bars[b] && bars[b].parentNode) bars[b].parentNode.removeChild(bars[b]);
            }
            appendVodProgressBar(row, base);
        }
    }

    function init() {
        // Search field debounced
        var sf = $('#searchField');
        if (sf) {
            SEARCH_DEBOUNCED = Util.debounce(function () { renderSearch(sf.value); }, 250);
            sf.addEventListener('input', SEARCH_DEBOUNCED);
        }

        // Bind click listeners on all search fields for magic remote
        var searchInputs = [
            document.getElementById('searchField'),
            document.getElementById('liveSearchField'),
            document.getElementById('movieSearchField'),
            document.getElementById('seriesSearchField'),
            document.getElementById('setEpgUrl'),
            document.getElementById('liveCatFilter'),
            document.getElementById('movieCatFilter'),
            document.getElementById('seriesCatFilter')
        ];
        for (var si = 0; si < searchInputs.length; si++) {
            (function (field) {
                if (field) {
                    field.addEventListener('click', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        UI.openVKeyboard(field);
                    });
                }
            })(searchInputs[si]);
        }

        // Lazy logo loading: when a channel OR VOD poster card gets focus, load its
        // image. Both card types stash the URL on data-logo and share lazyLoadLogo.
        Focus.onChange(function (prev, curr) {
            function isCard(elm) {
                return elm && elm.classList &&
                    (elm.classList.contains('ch-card') || elm.classList.contains('vod-card'));
            }
            if (isCard(curr)) {
                // Grid-aware neighborhood warming (Phase 5B): warm the focused
                // card plus a radius of rows/cols around it in all four directions,
                // so the row you scroll into next is already loading. Radius scales
                // with PerfConfig (normal 2, lite 1).
                warmAroundCard(curr);
            }
        });

        // Side clock tick
        function tickClock() {
            var c = $('#sideClock');
            if (c) c.textContent = Util.formatTime();
        }
        tickClock();
        // Clear any prior ticker before starting a new one, so a re-init
        // (re-pair / soft reload) doesn't stack duplicate intervals.
        if (clockTimer) { try { clearInterval(clockTimer); } catch (e) {} }
        clockTimer = setInterval(tickClock, 30 * 1000);
    }

    return {
        init: init,
        setChannels: setChannels,
        setStalkerMode: setStalkerMode,
        setStalkerGenres: setStalkerGenres,
        isStalkerMode: isStalkerMode,
        getStalkerAllTitle: function () {         // raw title of the portal's "All" genre ('' if none)
            var g = stalkerState && stalkerState.genres || [];
            for (var i = 0; i < g.length; i++) if (String(g[i].id) === '*') return g[i].title || '';
            return '';
        },
        stalkerErrText: stalkerErrText,
        clearItemCaches: clearItemCaches,
        alphaBucket: alphaBucket,
        getProviderCategoryNames: function (type) { return (providerCatNames[type === 'series' ? 'series' : type === 'live' ? 'live' : 'movies'] || []).slice(); },
        vodItemTs: vodItemTs,
        getStalkerChannels: getStalkerChannels,
        startStalkerLoadAll: startStalkerLoadAll,
        _stalkerAllCfg: stalkerAllCfg,
        clearStalkerMode: clearStalkerMode,
        getChannels: getChannels,
        openCatchupForShown: openCatchupForShown,
        getLiveCatChannels: function () { return liveCatChannelsRef || []; },
        renderHome: renderHome,
        renderFavorites: renderFavorites,
        renderCategories: renderCategories,
        renderMovies: renderMovies,
        renderSeries: renderSeries,
        /* Card-view category accessors (used by App.openCardCategoryPicker /
         * updateCardCatName). Read the lightweight in-memory category array — the
         * card view has no DOM category column. */
        // Same prefix/glyph cleanse the Movies and Series category columns use, so the
        // category manager can show identical text (display only; keys stay raw).
        vodCleanseCategoryName: function (s) { return vodCleanseCategoryName(s); },
        getVodCardCategories: function (section) {
            var s = vodCardState[section === 'series' ? 'series' : 'movies'];
            return s ? s.cats.slice() : [];
        },
        getVodCardActiveIndex: function (section) {
            var s = vodCardState[section === 'series' ? 'series' : 'movies'];
            if (!s || !s.cats.length) return -1;
            for (var i = 0; i < s.cats.length; i++) {
                var cid = (s.cats[i].category_id != null ? s.cats[i].category_id : s.cats[i].id);
                if (cid === s.currentCatId) return i;
            }
            return 0;
        },
        getVodCardItems: function (section) {
            var s = vodCardState[section === 'series' ? 'series' : 'movies'];
            if (!s) return [];
            // Xtream holds items on the card state; Stalker holds them on its own
            // per-genre state (the card state delegates to it).
            if (s.stalker) {
                var ss = (section === 'series') ? stalkerSeriesState : stalkerVodState;
                return (ss && ss.currentItems) ? ss.currentItems.slice() : [];
            }
            return (s.currentItems || []).slice();
        },
        getVodCardActiveName: function (section) {
            var s = vodCardState[section === 'series' ? 'series' : 'movies'];
            if (!s || !s.cats.length) return '';
            var idx = 0;
            for (var i = 0; i < s.cats.length; i++) {
                var cid = (s.cats[i].category_id != null ? s.cats[i].category_id : s.cats[i].id);
                if (cid === s.currentCatId) { idx = i; break; }
            }
            return s.cats[idx] ? s.cats[idx].name : '';
        },
        selectVodCardCategory: function (section, index) {
            var sec = (section === 'series') ? 'series' : 'movies';
            var s = vodCardState[sec];
            if (!s || index < 0 || index >= s.cats.length) return;
            var chListEl = document.getElementById(sec === 'series' ? 'seriesList' : 'movieList');
            loadVodCategoryCard(sec, s.cats[index], chListEl, s.pl, s.type);
        },
        /* Live card-view category accessors (used by App.openLiveCardCategoryPicker
         * / updateLiveCardCatName). Read the in-memory liveCardState — live card
         * view has no DOM category column. */
        getLiveCardCategories: function () {
            return liveCardState ? liveCardState.cats.slice() : [];
        },
        getLiveCardActiveIndex: function () {
            if (!liveCardState || !liveCardState.cats.length) return -1;
            for (var i = 0; i < liveCardState.cats.length; i++) {
                if (liveCardState.cats[i].name === liveCardState.currentName) return i;
            }
            return 0;
        },
        getLiveCardActiveName: function () {
            if (!liveCardState || !liveCardState.cats.length) return '';
            var idx = 0;
            for (var i = 0; i < liveCardState.cats.length; i++) {
                if (liveCardState.cats[i].name === liveCardState.currentName) { idx = i; break; }
            }
            return liveCardState.cats[idx] ? liveCardState.cats[idx].display : '';
        },
        selectLiveCardCategory: function (index) {
            if (!liveCardState || index < 0 || index >= liveCardState.cats.length) return;
            var cat = liveCardState.cats[index];
            var go = function () {
                liveCardState.currentName = cat.name;
                if (cat.loader) { cat.loader(); if (window.App && App.updateLiveCardCatName) App.updateLiveCardCatName(); }
                else if (liveShowCatFn) liveShowCatFn(cat.name, cat.channels);
            };
            // Honour category lock (same gate as the list-view column click).
            if (cat.name !== '__all__' && typeof isUiCategoryLocked === 'function' &&
                isUiCategoryLocked('live', cat.name, Store.getActivePlaylistId())) {
                requireUiUnlock(T('ui_unlock_category'), go);
                return;
            }
            go();
        },
        renderSearch: renderSearch,
        refreshSearchIfOpen: refreshSearchIfOpen,
        renderPlaylists: renderPlaylists,
        // Exposes the .fav-mark SVG markup to app.js's dynamic favorite-icon
        // refresh (which can't reach this module's local STAR_SVG constant
        // directly) so both the initial card render and the live toggle
        // update use the exact same markup.
        starSvgMarkup: function () { return STAR_SVG; },
        renderHeroFromChannel: renderHeroFromChannel,
        refreshEpgNowNext: refreshEpgNowNext,
        refreshLiveEpgRows: refreshLiveEpgRows,
        shiftLiveEpg: function (hours) { if (_liveShiftEpgFn) _liveShiftEpgFn(hours); },
        updateLiveNowBar: updateLiveNowBar,
        tryPlay: tryPlay,
        confirmRemoveFromCW: confirmRemoveFromCW,
        setActivePlaylistChip: setActivePlaylistChip,
        getChannelsCount: function () { return ALL_CHANNELS ? ALL_CHANNELS.length : 0; },
        refreshMiniChannels: refreshMiniChannels,
        updatePlaylistExpiry: updatePlaylistExpiry,
        doPlay: doPlay,
        showScreen: showScreen,
        showSection: showSection,
        showLoading: showLoading,
        hideLoading: hideLoading,
        invalidateFavSet: invalidateFavSet,
        refreshFavStars: refreshFavStars,
        refreshLockIndicators: refreshLockIndicators,
        makeLockGlyph: makeLockGlyph,
        resetFavoritesToLive: resetFavoritesToLive,
        refreshVodProgressBars: refreshVodProgressBars,
        makeChannelCard: makeChannelCard,
        makeVodCard: makeVodCard
    };
})();
