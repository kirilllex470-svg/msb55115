const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const WebSocket = require('ws');
const webpush = require('web-push');

const DATA_DIR = fs.existsSync('/data') ? '/data/' : '';
const DB_FILE = DATA_DIR + 'history.json';
const ARCHIVE_FILE = DATA_DIR + 'archive.json';
const NOTIFS_FILE = DATA_DIR + 'notifications.json';
const MAPS_FILE = DATA_DIR + 'maps.json';
const SUBS_FILE = DATA_DIR + 'subscriptions.json';
const VAPID_FILE = DATA_DIR + 'vapid.json';

let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
    try {
        vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch (e) {
        vapidKeys = webpush.generateVAPIDKeys();
    }
} else {
    vapidKeys = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch (e) {}
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

function makeTacticalIcon(size) {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable.fill(c, n, n + 1);
    }
    function crc32(buf) {
        let c = -1;
        for (let i = 0; i < buf.length; i++) {
            const b = buf.readUInt8(i);
            const idx = (c ^ b) & 0xff;
            const t = crcTable.subarray(idx, idx + 1).reduce(function(a, v) { return v; }, 0);
            c = (c >>> 8) ^ t;
        }
        return (c ^ -1) >>> 0;
    }
    function chunk(type, data) {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const t = Buffer.from(type, 'ascii');
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat(Array.of(t, data))), 0);
        return Buffer.concat(Array.of(len, t, data, crc));
    }

    const ihdr = Buffer.alloc(13, 0);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8); ihdr.writeUInt8(2, 9);

    const rowLen = 1 + size * 3;
    const raw = Buffer.alloc(size * rowLen, 0);
    const half = size / 2;

    for (let y = 0; y < size; y++) {
        const rowOff = y * rowLen;
        raw.writeUInt8(0, rowOff);
        for (let x = 0; x < size; x++) {
            const p = rowOff + 1 + x * 3;
            const dx = x - half;
            const dy = y - half;
            const r = Math.sqrt(dx * dx + dy * dy);
            let red = 15, green = 23, blue = 42;

            if (r <= half * 0.88) {
                if (r >= half * 0.82) {
                    red = 56; green = 189; blue = 248;
                } else {
                    red = 30; green = 41; blue = 59;
                    const c1 = Math.abs(dy - (-half * 0.32 + Math.abs(dx) * 0.75));
                    const c2 = Math.abs(dy - (-half * 0.05 + Math.abs(dx) * 0.75));
                    const c3 = Math.abs(dy - (half * 0.22 + Math.abs(dx) * 0.75));
                    if ((c1 <= size * 0.045 && Math.abs(dx) <= half * 0.52) ||
                        (c2 <= size * 0.045 && Math.abs(dx) <= half * 0.46) ||
                        (c3 <= size * 0.045 && Math.abs(dx) <= half * 0.38)) {
                        red = 250; green = 204; blue = 21;
                    }
                }
            }
            raw.writeUInt8(red, p);
            raw.writeUInt8(green, p + 1);
            raw.writeUInt8(blue, p + 2);
        }
    }

    const idat = zlib.deflateSync(raw);
    const sig = Buffer.from('89504e470d0a1a0a', 'hex');
    return Buffer.concat(Array.of(sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))));
}

const TACTICAL_ICON_192 = makeTacticalIcon(192);
const TACTICAL_ICON_512 = makeTacticalIcon(512);
const MANIFEST_JSON = JSON.stringify({
    name: "МСБ-55115",
    short_name: "МСБ55115",
    start_url: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: Array.of(
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
    )
});

const SW_CODE = [
    "self.addEventListener('install', function(e) { self.skipWaiting(); });",
    "self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });",
    "self.addEventListener('push', function(event) {",
    "    var data = { title: '🛑 СООБЩЕНИЕ В ЖУРНАЛЕ!', body: 'Срочно откройте журнал!' };",
    "    if (event.data) { try { data = event.data.json(); } catch (e) {} }",
    "    event.waitUntil(self.registration.showNotification(data.title, {",
    "        body: data.body,",
    "        vibrate: Array.of(800, 200, 800, 200, 800, 200, 1000),",
    "        silent: false,",
    "        requireInteraction: true,",
    "        renotify: true,",
    "        tag: 'admin-alert-' + Date.now()",
    "    }));",
    "});",
    "self.addEventListener('message', function(event) {",
    "    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {",
    "        self.registration.showNotification(event.data.title, {",
    "            body: event.data.body,",
    "            vibrate: Array.of(800, 200, 800, 200, 800, 200, 1000),",
    "            silent: false,",
    "            requireInteraction: true,",
    "            renotify: true,",
    "            tag: 'admin-alert-' + Date.now()",
    "        });",
    "    }",
    "});",
    "self.addEventListener('notificationclick', function(event) {",
    "    event.notification.close();",
    "    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {",
    "        for (var i = 0; i < clientList.length; i++) {",
    "            var cl = clientList.at(i);",
    "            if (cl && 'focus' in cl) return cl.focus();",
    "        }",
    "        if (clients.openWindow) return clients.openWindow('/');",
    "    }));",
    "});"
].join('\n');

const server = http.createServer(function(req, res) {
    const urlPath = (req.url || '/').split('?').at(0);

    if (req.method === 'GET' && urlPath === '/maps-list') {
        res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(JSON.stringify(mapsHistory));
        return;
    }

    if (req.method === 'GET' && urlPath === '/archive-data') {
        res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(JSON.stringify(archiveHistory));
        return;
    }

    if (req.method === 'POST' && urlPath === '/upload-map') {
        const chunks = new Array();
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            try {
                const bodyStr = Buffer.concat(chunks).toString('utf8');
                const msg = JSON.parse(bodyStr);
                if (msg && msg.image) {
                    saveAndBroadcastMap(msg);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, maps: mapsHistory }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ ok: false }));
                }
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false }));
            }
        });
        return;
    }

    if (urlPath === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(SW_CODE);
        return;
    }
    if (urlPath === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(MANIFEST_JSON);
        return;
    }
    if (urlPath === '/icon-192.png' || urlPath === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TACTICAL_ICON_192.length });
        res.end(TACTICAL_ICON_192);
        return;
    }
    if (urlPath === '/icon-512.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TACTICAL_ICON_512.length });
        res.end(TACTICAL_ICON_512);
        return;
    }

    fs.readFile('index.html', function(err, data) {
        if (err) { 
            res.writeHead(500); 
            res.end('Error loading index.html'); 
        } else { 
            res.writeHead(200, { 
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
            }); 
            res.end(data); 
        }
    });
});
const wss = new WebSocket.Server({ server: server, maxPayload: 20 * 1024 * 1024 });

let tableHistory = new Array(); 
let archiveHistory = {};
let notificationsHistory = new Array();
let mapsHistory = new Array();
let activeAlerts = {}; 
let streamState = { active: false, url: '' };

function getIsoDateNow() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
}

let currentActiveDay = getIsoDateNow();

if (fs.existsSync(DB_FILE)) {
    try { 
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        tableHistory = fileContent.trim() ? JSON.parse(fileContent) : new Array();
    } catch (e) { 
        tableHistory = new Array(); 
    }
}

if (fs.existsSync(ARCHIVE_FILE)) {
    try {
        const archContent = fs.readFileSync(ARCHIVE_FILE, 'utf8');
        archiveHistory = archContent.trim() ? JSON.parse(archContent) : {};
    } catch (e) {
        archiveHistory = {};
    }
}

if (tableHistory.length > 0 && !archiveHistory[currentActiveDay]) {
    archiveHistory[currentActiveDay] = tableHistory.slice();
    try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archiveHistory)); } catch (e) {}
}

setInterval(function() {
    const todayIso = getIsoDateNow();
    if (todayIso !== currentActiveDay) {
        if (tableHistory.length > 0) {
            archiveHistory[currentActiveDay] = tableHistory.slice();
            fs.writeFile(ARCHIVE_FILE, JSON.stringify(archiveHistory), function() {});
        }
        currentActiveDay = todayIso;
        tableHistory = new Array();
        fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});

        wss.clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'daily_archived', date: currentActiveDay }));
            }
        });
    }
}, 30000);

if (fs.existsSync(NOTIFS_FILE)) {
    try {
        const notifContent = fs.readFileSync(NOTIFS_FILE, 'utf8');
        notificationsHistory = notifContent.trim() ? JSON.parse(notifContent) : new Array();
        notificationsHistory.forEach(function(n) {
            if (!n.read) {
                if (!Array.isArray(activeAlerts[n.target])) activeAlerts[n.target] = new Array();
                activeAlerts[n.target].push({ id: n.id, text: n.text, sender: n.sender, readList: new Array() });
            }
        });
    } catch (e) {
        notificationsHistory = new Array();
    }
}

if (fs.existsSync(MAPS_FILE)) {
    try {
        const mapsContent = fs.readFileSync(MAPS_FILE, 'utf8');
        mapsHistory = mapsContent.trim() ? JSON.parse(mapsContent) : new Array();
    } catch (e) {
        mapsHistory = new Array();
    }
}
function saveAndBroadcastMap(msg) {
    const now = new Date();
    const timeStr = msg.time || (now.toLocaleDateString() + ' ' + now.toLocaleTimeString().slice(0, 5));
    const mapItem = {
        id: Date.now(),
        sender: msg.sender || 'АДМИН',
        target: msg.target || 'ВСЕМ',
        time: timeStr,
        image: msg.image
    };
    mapsHistory.push(mapItem);
    if (mapsHistory.length > 18) {
        mapsHistory = mapsHistory.slice(-18);
    }
    fs.writeFile(MAPS_FILE, JSON.stringify(mapsHistory), function() {});

    wss.clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'new_map', target: mapItem.target }));
        }
    });

    broadcastAlert(
        msg.sender || 'АДМИН',
        msg.color || '#8b5cf6',
        timeStr,
        msg.target || 'ВСЕМ',
        '🗺️ ЗАГРУЖЕНА НОВАЯ ВВОДНАЯ / КАРТА! Откройте раздел "ВВОДНЫЕ / КАРТА"'
    );
}

function broadcastAlert(sender, color, timeStr, target, text) {
    const notifId = Date.now() + Math.floor(Math.random() * 1000);
    const newNotif = {
        id: notifId,
        time: timeStr,
        sender: sender,
        color: color,
        target: target,
        text: text,
        read: false,
        readBy: ''
    };

    notificationsHistory.push(newNotif);
    if (notificationsHistory.length > 200) {
        notificationsHistory = notificationsHistory.slice(-200);
    }
    fs.writeFile(NOTIFS_FILE, JSON.stringify(notificationsHistory), function() {});

    if (!Array.isArray(activeAlerts[target])) {
        activeAlerts[target] = new Array();
    }
    activeAlerts[target].push({
        id: notifId,
        text: text,
        sender: sender,
        readList: new Array()
    });

    wss.clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'admin_alert',
                sender: sender,
                target: target,
                text: text,
                notif: newNotif
            }));
        }
    });

    const payload = JSON.stringify({
        title: '🛑 СООБЩЕНИЕ ДЛЯ [' + target + ']!',
        body: sender + ': ' + text
    });

    const pushOptions = { TTL: 3600, headers: { 'Urgency': 'high' } };

    pushSubscriptions.forEach(function(item, index) {
        if (target === 'ВСЕМ' || item.user === target) {
            webpush.sendNotification(item.sub, payload, pushOptions)
                .catch(function(err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        pushSubscriptions.splice(index, 1);
                        fs.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions), function() {});
                    }
                });
        }
    });
}
wss.on('connection', function(ws) {
    ws.send(JSON.stringify({ 
        type: 'init', 
        data: tableHistory, 
        notifications: notificationsHistory,
        alerts: activeAlerts,
        streamState: streamState,
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
                    pushSubscriptions.at(idx).user = msg.user;
                } else {
                    pushSubscriptions.push({ user: msg.user, sub: msg.sub });
                }
                fs.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions), function() {});
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

                const dayKey = getIsoDateNow();
                if (!Array.isArray(archiveHistory[dayKey])) {
                    archiveHistory[dayKey] = new Array();
                }
                archiveHistory[dayKey].push(newRow);
                fs.writeFile(ARCHIVE_FILE, JSON.stringify(archiveHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'new_row', row: newRow }));
                    }
                });
            }

            if (msg.type === 'upload_map' && msg.image) {
                saveAndBroadcastMap(msg);
            }

            if (msg.type === 'stream_start') {
                streamState = { active: true, url: msg.url };
                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'stream_state', streamState: streamState }));
                    }
                });
                const now = new Date();
                const timeStr = msg.time || (now.toLocaleDateString() + ' ' + now.toLocaleTimeString().slice(0, 5));
                broadcastAlert(msg.sender || 'АДМИН', msg.color || '#ef4444', timeStr, 'ВСЕМ', '🎥 НАЧАЛСЯ ВИДЕОСТРИМ МСБ-55115! Нажмите кнопку "ПЕРЕЙТИ ПО ССЫЛКЕ"');
            }

            if (msg.type === 'stream_stop') {
                streamState = { active: false, url: '' };
                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'stream_state', streamState: streamState }));
                    }
                });
            }

            if (msg.type === 'clear_history') {
                tableHistory = new Array();
                notificationsHistory = new Array();
                mapsHistory = new Array();
                activeAlerts = {};
                fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});
                fs.writeFile(NOTIFS_FILE, JSON.stringify(notificationsHistory), function() {});
                fs.writeFile(MAPS_FILE, JSON.stringify(mapsHistory), function() {});

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
                broadcastAlert(sender, color, timeStr, msg.target, msg.text);
            }

            if (msg.type === 'clear_alert') {
                const now = new Date();
                const tStr = msg.readTime || now.toLocaleTimeString().slice(0, 5);
                const whoStr = msg.readBy || 'Просмотр';
                const stamp = whoStr + ' ' + tStr;

                if (Array.isArray(activeAlerts[msg.target])) {
                    if (msg.target === 'ВСЕМ') {
                        activeAlerts[msg.target].forEach(function(a) {
                            if (!msg.notifId || a.id === msg.notifId) {
                                if (!Array.isArray(a.readList)) a.readList = new Array();
                                if (a.readList.indexOf(whoStr) === -1) a.readList.push(whoStr);
                            }
                        });
                    } else {
                        if (msg.notifId) {
                            activeAlerts[msg.target] = activeAlerts[msg.target].filter(function(a) { return a.id !== msg.notifId; });
                        } else {
                            activeAlerts[msg.target].shift();
                        }
                        if (activeAlerts[msg.target].length === 0) {
                            delete activeAlerts[msg.target];
                        }
                    }
                } else {
                    delete activeAlerts[msg.target];
                }

                let updatedReadBy = stamp;
                let marked = false;
                notificationsHistory.forEach(function(n) {
                    const match = (msg.notifId && n.id === msg.notifId) || (!msg.notifId && !marked && n.target === msg.target);
                    if (match) {
                        n.read = true;
                        if (n.target === 'ВСЕМ') {
                            if (!n.readBy) {
                                n.readBy = stamp;
                            } else if (n.readBy.indexOf(whoStr) === -1) {
                                n.readBy = n.readBy + ', ' + stamp;
                            }
                        } else {
                            n.readBy = stamp;
                        }
                        updatedReadBy = n.readBy;
                        marked = true;
                    }
                });
                fs.writeFile(NOTIFS_FILE, JSON.stringify(notificationsHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'alert_cleared',
                            target: msg.target,
                            notifId: msg.notifId || null,
                            who: whoStr,
                            readBy: updatedReadBy
                        }));
                    }
                });
            }
        } catch (e) { console.error("Ошибка:", e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
    console.log('🚀 СЕРВЕР ЗАПУЩЕН И РАБОТАЕТ! (Порт ' + PORT + ')');
});
