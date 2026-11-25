/* backup-ui.js - Settings > Backup and Restore dialogs. Logic and file access live in backup.js. */
var BackupUI = (function () {
    'use strict';

    var B = function () { return window.XtivioBackup; };

    function passwordInput(placeholder) {
        var wrap = document.createElement('div');
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'field focusable';
        inp.setAttribute('readonly', 'readonly');
        inp.setAttribute('data-focus-key', 'bk-pass-input');
        inp.setAttribute('data-focus-down', 'modal-ok');
        inp.setAttribute('placeholder', placeholder);
        inp._realValue = '';
        inp._isPassword = true;
        inp._maskFn = function () {
            var real = inp._realValue || '', masked = '';
            for (var i = 0; i < real.length; i++) masked += '•';
            inp.value = masked;
        };
        inp.addEventListener('click', function () { if (UI.openVKeyboard) UI.openVKeyboard(inp); });
        wrap.appendChild(inp);
        return { wrap: wrap, input: inp };
    }

    function errText(code) {
        if (code === 'badfile') return T('bk_err_badfile');
        if (code === 'newer') return T('bk_err_newer');
        if (code === 'password') return T('bk_err_password');
        if (code === 'permission') return T('bk_err_perm');
        return T('bk_err_io');
    }

    /* ---------------- Back up ---------------- */
    function startBackup() {
        var b = B();
        if (!b.hasCrypto()) { chooseWhere(''); return; }
        var pi = passwordInput(T('bk_pw_ph'));
        UI.openModal({
            title: T('bk_backup'), body: T('bk_pw_body'), bodyEl: pi.wrap,
            okText: T('ap_continue'), cancelText: T('cancel'),
            onOk: function () { chooseWhere(pi.input._realValue || ''); }
        });
    }

    function chooseWhere(password) {
        var b = B(), caps = b.caps(), items = [];
        b.build(password).then(function (text) {
            var name = b.fileName();
            function toFolder(retry) {
                b.saveFolder(name, text).then(function (r) {
                    if (r.ok) { UI.toast(T('bk_saved', { name: r.name }), 'ok'); return; }
                    if (r.code === 'permission' && !retry) {
                        b.askAccess().then(function (a) { if (a && a.ok && a.files === 'granted') toFolder(true); else UI.toast(T('bk_err_perm'), 'err'); });
                        return;
                    }
                    UI.toast(errText(r.code), 'err');
                });
            }
            if (!caps.picker) { toFolder(false); return; }
            items.push({ label: T('bk_choose_place'), onClick: function () {
                b.savePicker(name, text).then(function (r) {
                    if (r.ok) UI.toast(T('bk_saved', { name: r.name || name }), 'ok');
                    else if (r.code !== 'cancelled') UI.toast(errText(r.code), 'err');
                });
            } });
            items.push({ label: T('bk_to_folder'), onClick: function () { toFolder(false); } });
            UI.openActionSheet({ title: T('bk_backup'), body: T('bk_where'), items: items });
        }, function () { UI.toast(T('bk_err_io'), 'err'); });
    }

    /* ---------------- Restore ---------------- */
    function startRestore() {
        var b = B(), caps = b.caps(), items = [];
        if (caps.picker) items.push({ label: T('bk_choose_file'), onClick: function () {
            b.pickFile().then(function (r) {
                if (r.ok) gotText(r.text);
                else if (r.code !== 'cancelled') UI.toast(errText(r.code), 'err');
            });
        } });
        items.push({ label: T('bk_from_folder'), onClick: listFolder });
        if (caps.files === 'ask') items.push({ label: T('bk_allow'), onClick: function () {
            b.askAccess().then(function (a) {
                if (a && a.ok && a.files === 'granted') listFolder(); else UI.toast(T('bk_err_perm'), 'err');
            });
        } });
        UI.openActionSheet({ title: T('bk_restore'), body: T('bk_from'), items: items });
    }

    function listFolder() {
        var b = B();
        b.listFolder().then(function (r) {
            var files = (r && r.ok && r.files) || [];
            if (!files.length) { UI.toast(r && r.ok === false ? errText(r.code) : T('bk_none_found'), r && r.ok === false ? 'err' : null); return; }
            files.sort(function (x, y) { return (y.mod || 0) - (x.mod || 0); });
            var names = [];
            for (var i = 0; i < files.length; i++) names.push(files[i].name);
            UI.openListPicker({
                title: T('bk_from_folder'), items: names, selected: 0,
                onSelect: function (idx) {
                    b.readFile(files[idx].id).then(function (rd) {
                        if (rd.ok) gotText(rd.text); else UI.toast(errText(rd.code), 'err');
                    });
                }
            });
        });
    }

    function gotText(text) {
        var b = B(), r = b.inspect(text);
        if (!r.ok) { UI.toast(errText(r.code), 'err'); return; }
        if (!r.encrypted) { b.open(text, '').then(function (bk) { chooseMode(bk); }, function (e) { UI.toast(errText(e && e.message), 'err'); }); return; }
        askPassword(text);
    }

    function askPassword(text) {
        var b = B(), pi = passwordInput(T('bk_password'));
        UI.openModal({
            title: T('bk_restore'), body: T('bk_pw_enter_body'), bodyEl: pi.wrap,
            okText: T('ap_continue'), cancelText: T('cancel'),
            onOk: function () {
                b.open(text, pi.input._realValue || '').then(function (bk) { chooseMode(bk); }, function (e) {
                    UI.toast(errText(e && e.message), 'err');
                    if (e && e.message === 'password') setTimeout(function () { askPassword(text); }, 60);
                });
            }
        });
    }

    function chooseMode(bk) {
        var b = B(), c = bk.counts || {}, d = '';
        try { d = bk.created ? new Date(bk.created).toLocaleDateString() : ''; } catch (e) { d = ''; }
        var body = T('bk_mode_body', { date: d, playlists: String(c.playlists || 0), favorites: String(c.favorites || 0) }) + '\n\n' + T('bk_mode_hint');
        function run(mode) {
            var res;
            try { res = b.apply(bk, mode); } catch (e) { UI.toast(T('bk_err_io'), 'err'); return; }
            UI.toast(T('bk_restored'), 'ok');
            setTimeout(function () { try { window.location.reload(); } catch (e2) {} }, 1200);
        }
        UI.openActionSheet({
            title: T('bk_restore'), body: body,
            items: [
                { label: T('bk_merge'), onClick: function () { run('merge'); } },
                { label: T('bk_replace'), style: 'danger', onClick: function () { run('replace'); } }
            ]
        });
    }

    /* ---------------- Settings row ---------------- */
    function openMenu() {
        UI.openActionSheet({
            title: T('bk_title'), body: T('bk_menu_body'),
            items: [
                { label: T('bk_backup'), onClick: startBackup },
                { label: T('bk_restore'), onClick: startRestore }
            ]
        });
    }

    function bindSettings() {
        var row = document.getElementById('setBackupRow'), btn = document.getElementById('setBackup');
        if (!row || !btn) return;
        if (!window.XtivioBackup || !XtivioBackup.isAvailable()) { row.style.display = 'none'; return; }
        row.style.display = '';
        btn.textContent = T('bk_open');
        btn.addEventListener('click', openMenu);
    }

    return { bindSettings: bindSettings, openMenu: openMenu };
})();
