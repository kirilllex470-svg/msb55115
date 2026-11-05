const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const webpush = require('web-push');

// Если запущено на облачном сервере (есть папка /data), сохраняем файлы туда, чтобы они хранились вечно
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

const SW_CODE = [
    "self.addEventListener('install', function(e) { self.skipWaiting(); });",
    "self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });",
    "self.addEventListener('push', function(event) {",
    "    var data = { title: '🛑 СООБЩЕНИЕ АДМИНИСТРАТОРА!', body: 'Срочно откройте журнал!' };",
    "    if (event.data) { try { data = event.data.json(); } catch (e) {} }",
    "    event.waitUntil(self.registration.showNotification(data.title, {",
    "        body: data.body,",
    "        vibrate: Array.of(800, 200, 800, 200, 800, 200, 1000),",
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
    "            vibrate: Array.of(800, 200, 800, 200, 800, 200, 1000),",
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
    if (req.url && req.url.indexOf('/sw.js') === 0) {
        res.writeHead(200, { 
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(SW_CODE);
        return;
    }
    if (req.url === '/') {
        fs.readFile('index.html', function(err, data) {
            if (err) { 
                res.writeHead(500); 
                res.end('Error loading index.html'); 
            } else { 
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); 
                res.end(data); 
            }
        });
    }
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
                fs.writeFile(DB_FILE, JSON.stringify(tableHistory), function() {});

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'history_cleared' }));
                    }
                });
            }

            if (msg.type === 'admin_alert') {
                console.log('📢 АДМИН пишет для ' + msg.target + ': ' + msg.text);
                activeAlerts[msg.target] = msg.text;

                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });

                const payload = JSON.stringify({
                    title: '🛑 ТРЕВОГА ДЛЯ [' + msg.target + ']!',
                    body: 'АДМИН: ' + msg.text
                });

                const pushOptions = {
                    TTL: 3600,
                    headers: {
                        'Urgency': 'high'
                    }
                };

                console.log('📲 Отправка в шторку для телефонов (' + pushSubscriptions.length + ' шт.)...');
                pushSubscriptions.forEach(function(item, index) {
                    if (msg.target === 'ВСЕМ' || !item.user || item.user === msg.target) {
                        webpush.sendNotification(item.sub, payload, pushOptions)
                            .then(function() { console.log('---> Успешно доставлено в шторку (' + item.user + ')'); })
                            .catch(function(err) {
                                console.log('---> Ошибка доставки Push:', err.statusCode);
                                if (err.statusCode === 410 || err.statusCode === 404) {
                                    pushSubscriptions.splice(index, 1);
                                    fs.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions), function() {});
                                }
                            });
                    }
                });
            }

            if (msg.type === 'clear_alert') {
                delete activeAlerts[msg.target];
                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'alert_cleared', target: msg.target }));
                    }
                });
            }

        } catch (e) { console.error("Ошибка:", e); }
    });
});

// Автоматический выбор порта для облачного сервера или локального запуска
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
    console.log('🚀 СЕРВЕР ЗАПУЩЕН И РАБОТАЕТ! (Порт ' + PORT + ')');
});
