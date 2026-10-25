// App-shell cache so the app opens without signal on the trail. Map tiles are
// cached opportunistically (only what was already viewed), capped in size.
const SHELL = 'turanaplo-shell-v3';
const TILES = 'turanaplo-tiles-v1';
const MAX_TILES = 1500;
const FILES = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'data/places-hu.json',
  'js/icons.js', 'js/geo.js', 'js/db.js', 'js/exif.js', 'js/places.js', 'js/catalog.js', 'js/heading.js', 'js/tracker.js',
  'js/ui.js', 'js/map.js', 'js/app.js',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isTile = (url) => /(^|\.)tile\.(openstreetmap|opentopomap|waymarkedtrails)\.org$|^tiles\.openfreemap\.org$/.test(url.hostname);

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') { c.put(e.request, res.clone()); trimTiles(c); }
      return res;
    }));
    return;
  }
  // App files: network first, revalidating past the 10-minute HTTP cache of
  // GitHub Pages so an update shows up on the next open; cache as offline fallback.
  if (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
