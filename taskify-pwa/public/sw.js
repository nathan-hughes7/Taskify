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

self.addEventListener('push', (event) => {
  event.waitUntil(handlePushEvent());
});

async function handlePushEvent() {
  let reminders = [];
  try {
    const registration = await self.registration;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const response = await fetch('/api/reminders/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) reminders = data;
      }
    }
  } catch (err) {
    console.warn('Failed to retrieve reminder payloads', err);
  }

  if (!reminders.length) {
    await self.registration.showNotification('Taskify', {
      body: 'You have an upcoming task.',
      tag: 'taskify_reminder',
    });
    return;
  }

  await Promise.all(reminders.map(async (item) => {
    const body = buildReminderBody(item);
    const tag = `taskify_${item.taskId || 'unknown'}_${item.minutes || 0}`;
    const url = item.taskId ? `/?task=${encodeURIComponent(item.taskId)}` : '/';
    await self.registration.showNotification('Taskify', {
      body,
      tag,
      data: {
        ...item,
        url,
      },
    });
  }));
}

function buildReminderBody(item) {
  const title = typeof item?.title === 'string' ? item.title : 'Task';
  const minutes = Number(item?.minutes) || 0;
  let due = null;
  if (typeof item?.dueISO === 'string') {
    const parsed = Date.parse(item.dueISO);
    if (!Number.isNaN(parsed)) due = new Date(parsed);
  }
  const timeString = due ? due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  if (minutes <= 0) {
    return timeString
      ? `${title} is due now at ${timeString}.`
      : `${title} is due now.`;
  }

  const offset = formatOffset(minutes);
  return timeString
    ? `${title} is due in ${offset} at ${timeString}.`
    : `${title} is due in ${offset}.`;
}

function formatOffset(minutes) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client && client.url === targetUrl) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
