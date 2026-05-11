// Service Worker — Woot Alert Bot PWA
// PERF-03: Version-stamped cache name — update on each deploy
const CACHE_NAME = 'woot-bot-v6-20260511c';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/login.html',
  '/ntfy-logs.html',
  '/manifest.json'
];

// Install: cache core assets, force activate immediately
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()) // Force activate without waiting
  );
});

// Activate: aggressively delete ALL old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      console.log('[SW] Activate — clearing old caches:', keys.filter(k => k !== CACHE_NAME));
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim()) // Take control of all open tabs immediately
  );
});

// Fetch: network-first for everything, cache as fallback only
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls and auth — always network, never cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/logout' || event.request.method !== 'GET') {
    return;
  }

  // All static assets — network first, update cache, fallback to cache if offline
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
