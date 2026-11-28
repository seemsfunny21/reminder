const CACHE_NAME = "reminder-pwa-v26-credit";
const APP_SHELL = ["./","./index.html","./styles.css","./premium.css?v=4","./midnight.css?v=2","./split-40-60.css?v=8","./push.js?v=2","./app.js?v=ui-dialog-20261128","./manifest.webmanifest","./icon.svg","./hero-banner.webp"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("reminder-pwa-") && key!==CACHE_NAME).map(key=>caches.delete(key)))),
    self.clients.claim()
  ]));
});
/* Instant offline-first app shell. Every static resource is returned from
   its own saved cache; a conditional network request refreshes only changes.
   External live data, including Supabase, never passes through this worker. */
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== "GET" || url.origin !== scope.origin ||
      !url.pathname.startsWith(scope.pathname)) return;
  if (!(req.mode === "navigate" ||
        ["script", "style", "image", "font", "manifest"].includes(req.destination))) return;

  // Fresh HTML on every online launch; use the cached app only when offline.
  // This avoids the installed PWA showing yesterday's headings on a phone.
  if(req.mode === "navigate"){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      try{
        const response=await fetch(req,{cache:"no-store"});
        if(response.ok && response.type==="basic"){
          try{await cache.put("./index.html",response.clone());}catch(_){}
        }
        return response;
      }catch{
        return await cache.match("./index.html") || await cache.match("./") || Response.error();
      }
    })());
    return;
  }

  const network = fetch(req, {cache: "no-cache"}).then(async response => {
    if (response.ok && response.type === "basic") {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(req, response.clone());
      } catch (_) {}
    }
    return response;
  });
  event.waitUntil(network.then(() => {}, () => {}));

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (req.cache !== "reload" && req.cache !== "no-store") {
      const cached = await cache.match(req, {ignoreSearch: req.mode === "navigate"}) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : null);
      if (cached) return cached;
    }
    try { return await network; }
    catch {
      return await cache.match(req, {ignoreSearch: req.mode === "navigate"}) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : null) ||
        Response.error();
    }
  })());
});

// Scheduled server Web Push: display the due reminder even with the app closed.
self.addEventListener("push",event=>{
  let payload={};
  try{payload=event.data?.json()||{};}
  catch{payload={body:event.data?.text()||""};}
  event.waitUntil(self.registration.showNotification(
    typeof payload.title==="string" ? payload.title : "Υπενθυμίσεις",
    {
      body:typeof payload.body==="string"?payload.body:"Έχεις μια νέα υπενθύμιση.",
      icon:"./icon.svg",badge:"./icon.svg",
      tag:typeof payload.tag==="string"?payload.tag:"reminder-push",
      requireInteraction:true,
      timestamp:Date.now(),
      data:{url:"./"}
    }
  ));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const destination=new URL("./",self.registration.scope).href;
    const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of windows){
      if(client.url.startsWith(destination) && "focus" in client)return client.focus();
    }
    if(self.clients.openWindow)return self.clients.openWindow(destination);
  })());
});