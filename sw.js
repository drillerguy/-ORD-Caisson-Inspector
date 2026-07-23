const CACHE='ord-caisson-drawing-v6';
const ASSETS=['./','./index.html','./manifest.webmanifest','./assets/caisson-plan.png','./photo-fix.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  event.respondWith((async()=>{
    const cache = await caches.open(CACHE);
    try{
      const response = await fetch(event.request);
      if(response.ok && event.request.url.startsWith(self.location.origin)) cache.put(event.request, response.clone());
      return response;
    }catch{
      const cached = await cache.match(event.request);
      if(cached) return cached;
      throw new Error('Network unavailable and no cached response found.');
    }
  })());
});
