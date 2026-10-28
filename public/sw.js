/* Gulf Mover service worker — app-shell only.
 *
 * Privacy rule: NOTHING from the API, authentication, storage or edge functions is
 * cached, and no response for another origin is touched. Only same-origin static
 * build assets (content-hashed under /assets/) and the HTML shell are cached so the
 * installed PWA opens quickly and shows an honest offline notice when there is no
 * network. Bookings, tickets and payments always come live from the server.
 */
const CACHE = 'gm-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase, payment providers: never intercepted
  if (url.pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|mp3)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(request, copy)); }
      return res;
    })));
    return;
  }
  if (request.mode === 'navigate') {
    // Network first for pages; the cached shell is only a fallback when offline.
    event.respondWith(fetch(request).catch(() => caches.match('/')));
  }
});
