{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 self.addEventListener('install', () => self.skipWaiting());\
self.addEventListener('activate', () => self.clients.claim());\
\
const CACHE = 'taskify-cache-v1';\
\
self.addEventListener('fetch', (event) => \{\
  if (event.request.method !== 'GET') return;\
  event.respondWith(\
    caches.open(CACHE).then(async cache => \{\
      const cached = await cache.match(event.request);\
      const fetcher = fetch(event.request).then(resp => \{\
        if (resp.ok) cache.put(event.request, resp.clone());\
        return resp;\
      \}).catch(() => cached);\
      return cached || fetcher;\
    \})\
  );\
\});\
}