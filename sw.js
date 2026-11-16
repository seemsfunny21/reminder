const CACHE_NAME = "reminder-pwa-v11";
const APP_SHELL = ["./","./index.html","./styles.css","./premium.css?v=4","./midnight.css?v=2","./split-40-60.css?v=1","./push.js","./app.js?v=6","./manifest.webmanifest","./icon.svg"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("reminder-pwa-") && key!==CACHE_NAME).map(key=>caches.delete(key)))),
    self.clients.claim()
  ]));
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET" || new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    try{
      const network=await fetch(event.request);
      if(network.ok){
        const cache=await caches.open(CACHE_NAME);
        cache.put(event.request,network.clone()).catch(()=>{});
      }
      return network;
    }catch{
      const cached=await caches.match(event.request);
      if(cached)return cached;
      if(event.request.mode==="navigate"){
        const fallback=await caches.match("./index.html");
        if(fallback)return fallback;
      }
      return Response.error();
    }
  })());
});
// Future Web Push transport: a server needs to subscribe each device and send the push payload.
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