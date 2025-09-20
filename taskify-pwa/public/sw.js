self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

const CACHE = 'taskify-cache-v1';

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse && networkResponse.ok) {
          try {
            await cache.put(event.request, networkResponse.clone());
          } catch (err) {
            // Ignore cache put errors (e.g. opaque responses)
            console.warn('SW cache put failed', err);
          }
        }
        return networkResponse;
      } catch (err) {
        if (cached) return cached;
        return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
      }
    }),
  );
});
