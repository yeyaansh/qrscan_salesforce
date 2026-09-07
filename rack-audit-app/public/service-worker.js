const CACHE = "rack-audit-shell-v1";
const SHELL_FILES = [
  "/",
  "/css/style.css",
  "/js/api.js",
  "/js/state.js",
  "/js/camera.js",
  "/js/qrscanner.js",
  "/js/signature.js",
  "/js/geolocation.js",
  "/js/app.js",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// App shell (HTML/CSS/JS) is cache-first so the app opens instantly and
// works offline; API calls always go to the network since they carry live
// Salesforce/Mongo data.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
