self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

const CACHE = 'taskify-cache-v1';

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const fetcher = fetch(event.request)
        .then((resp) => {
          if (resp.ok) cache.put(event.request, resp.clone());
          return resp;
        })
        .catch(() => {});
      return cached || fetcher;
    })
  );
});
