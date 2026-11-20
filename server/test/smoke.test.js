'use strict';
// Starts the server and walks one pairing round trip plus an upload.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const PORT = 9700 + Math.floor(Math.random() * 90);

function call(method, p, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        const h = Object.assign({}, headers || {});
        if (data !== null && !h['content-type']) h['content-type'] = 'application/json';
        const r = http.request({ host: '127.0.0.1', port: PORT, method: method, path: p, headers: h }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, text: b }); });
        });
        r.on('error', reject); if (data !== null) r.write(data); r.end();
    });
}
let n = 0;
function check(ok, label) { if (!ok) { console.error('FAIL: ' + label); child.kill(); process.exit(1); } n++; }

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }), stdio: 'ignore' });
setTimeout(async () => {
    try {
        const c = await call('POST', '/api/pair', { deviceId: 'abcdef123456', ttl: 120000 });
        check(c.status === 200 && c.json && /^[A-Z0-9]{6}$/.test(c.json.code), 'create code');
        const code = c.json.code;
        let g = await call('GET', '/api/pair/' + code);
        check(g.json && g.json.status === 'pending', 'pending before submit');
        const s = await call('POST', '/api/pair/' + code + '/submit', { type: 'm3u', name: 'Test', url: 'https://example.com/a.m3u' });
        check(s.status === 200 && s.json && s.json.ok, 'submit');
        g = await call('GET', '/api/pair/' + code);
        check(g.json && g.json.status === 'completed' && g.json.payload && g.json.payload.name === 'Test', 'completed with payload');
        const bad = await call('POST', '/api/pair/' + code + '/submit', { type: 'm3u', name: 'x', url: 'https://example.com/b.m3u' });
        check(bad.status === 409, 'second submit refused');
        const u = await call('POST', '/api/upload', '#EXTM3U\n', { 'x-filename': 'a.m3u', 'content-type': 'text/plain' });
        check(u.status === 200 && u.json && u.json.url, 'upload');
        const home = await call('GET', '/');
        check(home.status === 200 && /Firebase|firebase/.test(home.text), 'landing page');
        check((await call('GET', '/api/subtitles')).status === 404, 'no subtitle route in the reference server');
        console.log('reference smoke test passed: ' + n + ' checks');
        child.kill();
    } catch (e) { console.error(e); child.kill(); process.exit(1); }
}, 1500);
