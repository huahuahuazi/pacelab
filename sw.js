/**
 * Service Worker —— 离线缓存。
 *
 * 策略（这套组合的取舍说明）：
 *   - HTML：网络优先，失败回落缓存。保证你改了代码 push 上去，用户刷新就能拿到新版。
 *   - 静态资源（JS/CSS/图标）：缓存优先 + 后台更新。启动快，且断网可用。
 *   - 跨域（Tesseract CDN）：不拦截，走网络。引擎本身有浏览器 HTTP 缓存，不用我们管。
 *
 * 改了业务代码记得把 VERSION 往上加一位，否则用户会一直拿旧缓存。
 */

const VERSION = 'pacelab-v1.0.0';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/core.js',
  './js/plan.js',
  './js/store.js',
  './js/chart.js',
  './js/ocr.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(CORE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 第三方 CDN 不接管

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
