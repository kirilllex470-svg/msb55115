const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const WebSocket = require('ws');
const webpush = require('web-push');

const DATA_DIR = fs.existsSync('/data') ? '/data/' : '';
const DB_FILE = DATA_DIR + 'history.json';
const SUBS_FILE = DATA_DIR + 'subscriptions.json';
const VAPID_FILE = DATA_DIR + 'vapid.json';

let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
}

webpush.setVapidDetails(
    'mailto:admin@journal.local',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

let pushSubscriptions = new Array();
if (fs.existsSync(SUBS_FILE)) {
    try { 
        pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); 
    } catch (e) { 
        pushSubscriptions = new Array(); 
    }
}

function createSolidPng(size) {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c;
    }
    function crc32(buf) {
        let c = -1;
        for (let i = 0; i < buf.length; i++) {
            c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
        }
        return (c ^ -1) >>> 0;
    }
    function chunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(2, 9);
    const rowLen = size * 3 + 1;
    const raw = Buffer.alloc(rowLen * size);
    const border = Math.floor(size * 0.12);
    for (let y = 0; y < size; y++) {
        const rowOff = y * rowLen;
        raw[rowOff] = 0;
        for (let x = 0; x < size; x++) {
            const p = rowOff + 1 + x * 3;
            const isBorder = (x < border || x >= size - border || y < border || y >= size - border);
            raw[p]     = isBorder ? 59  : 30;
            raw[p + 1] = isBorder ? 130 : 41;
            raw[p + 2] = isBorder ? 246 : 59;
        }
    }
    const idat = zlib.deflateSync(raw);
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const PNG_192 = createSolidPng(192);
const PNG_512 = createSolidPng(512);
const MANIFEST_JSON = JSON.stringify({
    id: "/",
    name: "Журнал событий МСБ55115",
    short_name: "МСБ55115",
    description: "Оперативный журнал событий и оповещений МСБ55115",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
        {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
        },
        {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
        },
        {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
        }
    ]
});

const SW_CODE = [
    "self.addEventListener('install', function(e) { self.skipWaiting(); });",
    "self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });",
    "self.addEventListener('fetch', function(event) {",
    "    if (event.request.method !== 'GET') return;",
    "    event.respondWith(fetch(event.request));",
    "});",
    "self.addEventListener('push', function(event) {",
    "    var data = { title: '🛑 СООБЩЕНИЕ В ЖУРНАЛЕ!', body: 'Срочно откройте журнал!' };",
    "    if (event.data) { try { data = event.data.json(); } catch (e) {} }",
    "    event.waitUntil(self.registration.showNotification(data.title, {",
    "        body: data.body,",
    "        icon: '/icon-192.png',",
    "        vibrate: [800, 200, 800, 200, 800, 200, 1000],",
    "        silent: false,",
    "        requireInteraction: true,",
    "        renotify: true,",
    "        tag: 'admin-alert'",
    "    }));",
    "});",
    "self.addEventListener('message', function(event) {",
    "    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {",
    "        self.registration.showNotification(event.data.title, {",
    "            body: event.data.body,",
    "            icon: '/icon-192.png',",
    "            vibrate: [800, 200, 800, 200, 800, 200, 1000],",
    "            silent: false,",
    "            requireInteraction: true,",
    "            renotify: true,",
    "            tag: 'admin-alert'",
    "        });",
    "    }",
    "});",
    "self.addEventListener('notificationclick', function(event) {",
    "    event.notification.close();",
    "    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {",
    "        for (var i = 0; i < clientList.length; i++) {",
    "            if ('focus' in clientList[i]) return clientList[i].focus();",
    "        }",
    "        if (clients.openWindow) return clients.openWindow('/');",
    "    }));",
    "});"
].join('\n');


const server = http.createServer(function(req, res) {
    const rawUrl = req.url || '/';
    const qIndex = rawUrl.indexOf('?');
    const cleanUrl = qIndex !== -1 ? rawUrl.substring(0, qIndex) : rawUrl;

    if (cleanUrl === '/sw.js') {
        res.writeHead(200, { 
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(SW_CODE);
        return;
    }
    if (cleanUrl === '/manifest.json') {
        res.writeHead(200, { 
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'no-cache'
        });
        res.end(MANIFEST_JSON);
        return;
    }
    if (cleanUrl === '/icon-192.png' || cleanUrl === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_192);
        return;
    }
    if (cleanUrl === '/icon-512.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_512);
        return;
    }
    if (cleanUrl === '/' || cleanUrl === '/index.html') {
        fs.readFile('index.html', function(err, data) {
            if (err) { 
                res.writeHead(500); 
                res.end('Error loading index.html'); 
            } else { 
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); 
                res.end(data); 
            }
        });
        return;
    }
    res.writeHead(404);
    res.end('Not found');
});

const wss = new WebSocket.Server({ server: server });

let tableHistory = new Array(); 
let activeAlerts = {}; 

if (fs.existsSync(DB_FILE)) {
    try { 
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        tableHistory = fileContent.trim() ? JSON.parse(fileContent) : new Array();
    } catch (e) { 
        tableHistory = new Array(); 
    }
}
wss.on('connection', function(ws) {
    ws.send(JSON.stringify({ 
        type: 'init', 
        data: tableHistory, 
        alerts: activeAlerts,
        vapidPublicKey: vapidKeys.publicKey 
    }));

    ws.on('message', function(message) {
        try {
            const msg = JSON.parse(message.toString());

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            if (msg.type === 'save_sub' && msg.sub) {
                const idx = pushSubscriptions.findIndex(function(s) { return s.sub.endpoint === msg.sub.endpoint; });
                if (idx !== -1) {
                    pushSubscriptions[idx].user = msg.user;
                } else {
                    pushSubscriptions.push({ user: msg.user, sub: msg.sub });
                }
                fs.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions), function() {});
                console.log('✅ Телефон подключен к шторке уведомлений:', msg.user || 'Гость');
                return;
            }

            if (msg.type === 'add_row') {
                const newRow = {
                    id: Date.now(),
                    time: msg.time,
                    user: msg.user,
                    values: msg.values,
                    color: msg.color
                };
                tableHistory.push(newRow);
                fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'new_row', row: newRow }));
                    }
                });
            }

            if (msg.type === 'clear_history') {
                console.log('🗑️ АДМИН полностью очистил журнал событий');
                tableHistory = new Array();
                activeAlerts = {};
                fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'history_cleared' }));
                    }
                });
            }

            if (msg.type === 'admin_alert') {
                const sender = msg.sender || 'АДМИН';
                const color = msg.color || '#ef4444';
                const now = new Date();
                const timeStr = msg.time || (now.toLocaleDateString() + ' ' + now.toLocaleTimeString().slice(0, 5));

                console.log('📢 [' + sender + '] пишет для [' + msg.target + ']: ' + msg.text);
                activeAlerts[msg.target] = {
                    text: msg.text,
                    sender: sender
                };

                const alertRow = {
                    id: Date.now(),
                    time: timeStr,
                    user: sender,
                    color: color,
                    values: [
                        "📢 УВЕДОМЛЕНИЕ",
                        "КОМУ: " + msg.target,
                        "-",
                        "-",
                        "-",
                        "Текст: " + msg.text
                    ]
                };
                tableHistory.push(alertRow);
                fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'new_row', row: alertRow }));
                        client.send(JSON.stringify({
                            type: 'admin_alert',
                            sender: sender,
                            target: msg.target,
                            text: msg.text
                        }));
                    }
                });

                const payload = JSON.stringify({
                    title: '🛑 СООБЩЕНИЕ ДЛЯ [' + msg.target + ']!',
                    body: sender + ': ' + msg.text
                });

                const pushOptions = {
                    TTL: 3600,
                    headers: {
                        'Urgency': 'high'
                    }
                };

                console.log('📲 Отправка в шторку для телефонов (' + pushSubscriptions.length + ' шт.)...');
                pushSubscriptions.forEach(function(item, index) {
                    // Не отправляем уведомление самому себе
                    if (item.user === sender) return;

                    // Если "ВСЕМ" — шлем каждому, иначе — СТРОГО выбранному подразделению
                    const isForAll = (msg.target === 'ВСЕМ');
                    const isExactTarget = (item.user && item.user === msg.target);

                    if (isForAll || isExactTarget) {
                        webpush.sendNotification(item.sub, payload, pushOptions)
                            .then(function() { console.log('---> Доставлено в шторку (' + (item.user || 'Гость') + ')'); })
                            .catch(function(err) {
                                if (err.statusCode === 410 || err.statusCode === 404) {
                                    pushSubscriptions.splice(index, 1);
                                    fs.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions), function() {});
                                }
                            });
                    }
                });

            if (msg.type === 'clear_alert') {
                delete activeAlerts[msg.target];
                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'alert_cleared', target: msg.target }));
                    }
                });
            

        } catch (e) { console.error("Ошибка:", e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
    console.log('🚀 СЕРВЕР ЗАПУЩЕН И РАБОТАЕТ! (Порт ' + PORT + ')');
});
