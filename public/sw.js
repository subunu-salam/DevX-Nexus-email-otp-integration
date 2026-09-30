/* DevX NeXus service worker — PWA install support + Web Push. */
const CACHE = 'devx-nexus-shell-v5';
const SHELL = ['/', '/index.html', '/manifest.json', '/logo.png', '/pwa-icon-192.png', '/pwa-icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(fetch(req).then(res => {
    if (res && res.ok && (req.mode === 'navigate' || req.url.endsWith('/manifest.json'))) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then(cached => cached || caches.match('/index.html'))));
});

/* ── Web Push: lands in the phone / laptop notification centre, even when the app is closed ── */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'DevX NeXus', body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'DevX NeXus';
  const opts = {
    body: d.body || 'You have a new update.',
    icon: d.icon || '/pwa-icon-192.png',
    badge: '/pwa-icon-192.png',
    tag: d.tag || 'devx-update',
    renotify: !!d.tag,
    data: { url: d.url || '/' },
    timestamp: Date.now()
  };
  /* iOS requires every push to show a notification, so this always resolves to one. */
  event.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'devx-open', url }); return c.focus(); } }
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});
self.addEventListener('pushsubscriptionchange', event => {
  /* Browser rotated the subscription: the page re-subscribes on next open (devxEnsurePush). */
});
