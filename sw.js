const CACHE = 'ff-cache-v3';
const ASSETS = ['index.html', 'Friends Fried Set a Table.dc.html', 'FriendsFriedMiniCard.dc.html', 'leaderboard.html', 'fine-print.html', 'how-it-works.html', 'support.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'plate-pizza.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network-first: always try to fetch the latest version; fall back to cache only when offline.
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).origin !== location.origin) return; // let API/Railway calls pass through untouched
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
