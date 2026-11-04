/* 오프라인 캐시. index.html/app.js를 바꾸면 CACHE 버전을 올려야 폰에 새 버전이 깔립니다. */
const CACHE = 'azura-v2';
const ASSETS = ['./', './index.html', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const cached = await c.match(e.request, {ignoreSearch: true});
    const net = fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (cached) { e.waitUntil(net); return cached; }
    const r = await net; return r || new Response('offline', {status: 503, headers: {'content-type': 'text/plain'}});
  }));
});
