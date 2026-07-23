const CACHE = "ord-caisson-drawing-v7";
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest", "./caisson-plan.png", "./sw.js", "./photo-fix.js"];
const NETWORK_FIRST_PATHS = new Set(["/", "/index.html", "/-ORD-Caisson-Inspector/", "/-ORD-Caisson-Inspector/index.html"]);
const CACHE_FIRST_PATHS = new Set(["/caisson-plan.png", "/manifest.webmanifest", "/sw.js", "/photo-fix.js"]);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request){
  const cache = await caches.open(CACHE);
  try{
    const response = await fetch(request);
    if(response.ok && request.method === "GET") cache.put(request, response.clone());
    return response;
  }catch{
    const cached = await cache.match(request);
    if(cached) return cached;
    throw new Error("Network unavailable and no cached response found.");
  }
}

async function cacheFirst(request){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if(cached) return cached;
  const response = await fetch(request);
  if(response.ok && request.method === "GET") cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  if(event.request.mode === "navigate" || NETWORK_FIRST_PATHS.has(url.pathname)){
    event.respondWith(networkFirst(event.request));
    return;
  }
  if(CACHE_FIRST_PATHS.has(url.pathname)){
    event.respondWith(cacheFirst(event.request));
    return;
  }
  event.respondWith(networkFirst(event.request));
});
