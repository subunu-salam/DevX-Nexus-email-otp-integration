/* DevX NeXus service worker — additive PWA install support. */
const CACHE = 'devx-nexus-shell-v1';
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
