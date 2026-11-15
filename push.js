/* Reminder Web Push client: no service keys are ever included in the public app. */
(() => {
  "use strict";
  const API = "https://zrbmsziipzabnniqcpav.supabase.co/functions/v1/reminder-push";
  const KEY = "reminder.push.device.v1";
  let active = false;
  let timer = null;
  let loadItems = () => [];
  let configPromise = null;
  let syncPromise = null;
  const encode64 = bytes => {
    let s = ""; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
  };
  const decode64 = value => {
    const s = atob(value.replaceAll("-","+").replaceAll("_","/"));
    return Uint8Array.from(s,c=>c.charCodeAt(0));
  };
  function supported() {
    return window.isSecureContext && "serviceWorker" in navigator &&
      "PushManager" in window && "Notification" in window;
  }
  function tellState(message="") {
    window.dispatchEvent(new CustomEvent("reminderpushstate",{detail:{active,message}}));
  }
  function getCredentials() {
    try {
      const obj=JSON.parse(localStorage.getItem(KEY)||"null");
      if(obj && typeof obj.deviceId==="string" && typeof obj.token==="string")return obj;
    }catch{}
    return null;
  }
  function ensureCredentials() {
    const current=getCredentials();
    if(current)return current;
    const obj={deviceId:crypto.randomUUID(),token:encode64(crypto.getRandomValues(new Uint8Array(32)))};
    localStorage.setItem(KEY,JSON.stringify(obj));
    return obj;
  }
  async function request(action, payload={}) {
    const res=await fetch(API,{
      method:"POST",mode:"cors",cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action,...payload})
    });
    let response={};
    try{response=await res.json();}catch{}
    if(!res.ok || !response.ok)throw new Error(
      response.error || "Αδυναμία επικοινωνίας με την υπηρεσία Push ("+res.status+")"
    );
    return response;
  }
  async function config() {
    if(!configPromise)configPromise=fetch(API,{cache:"no-store"})
      .then(async response=>{
        if(!response.ok)throw new Error("Η υπηρεσία Push δεν είναι διαθέσιμη.");
        const value=await response.json();
        if(!value.vapidPublicKey)throw new Error("Δεν έχει ενεργοποιηθεί το Push.");
        return value;
      }).catch(error=>{configPromise=null;throw error;});
    return configPromise;
  }
  async function sync(items, force=false) {
    if(!supported() || Notification.permission!=="granted")return false;
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(!sub){active=false;tellState();return false;}
    const {deviceId,token}=ensureCredentials();
    const data=JSON.parse(JSON.stringify(sub));
    const reminders=items.map(r=>({
      id:r.id,title:r.title,notes:r.notes||"",date:r.date,
      time:r.time,repeat:r.repeat,enabled:r.enabled,completed:r.completed
    }));
    // Serialize outstanding sync requests to avoid stale updates reaching the server last.
    const run=async()=>{
      const response=await request("sync",{
        deviceId,token,subscription:data,
        timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Athens",
        reminders
      });
      active=true;tellState("Συνδέθηκε με το Supabase.");
      return response.scheduled;
    };
    syncPromise=(syncPromise||Promise.resolve()).catch(()=>{}).then(run);
    try{await syncPromise;return true;}
    catch(error){active=false;tellState(error.message);throw error;}
  }
  function changed(items) {
    if(!getCredentials() || Notification.permission!=="granted")return;
    clearTimeout(timer);
    const copy=JSON.parse(JSON.stringify(items));
    timer=setTimeout(()=>sync(copy).catch(err=>console.warn("Push sync failed",err)),450);
  }
  async function init(loader) {
    loadItems=loader;
    if(!supported()){tellState("Η συσκευή ή ο browser δεν υποστηρίζει Web Push.");return;}
    // Preload VAPID public key without requesting permission.
    config().catch(error=>console.warn("Push config unavailable",error));
    if(getCredentials() && Notification.permission==="granted") {
      try{await sync(loadItems());}catch(error){console.warn("Push reconnect:",error);}
    }
  }
  async function enable(items) {
    if(!supported())throw new Error("Το Push χρειάζεται υποστηριζόμενο browser και ασφαλές HTTPS.");
    // The permission request is made immediately inside the click gesture for iOS compatibility.
    const permission=Notification.permission==="default" ?
      await Notification.requestPermission() : Notification.permission;
    if(permission!=="granted")throw new Error("Δεν έχει δοθεί άδεια ειδοποιήσεων.");
    const vapid=await config();
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub)sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:decode64(vapid.vapidPublicKey)
    });
    await sync(items,true);
    return await test();
  }
  async function test() {
    const cred=getCredentials();
    if(!active || !cred)throw new Error("Ενεργοποίησε πρώτα το Push.");
    return await request("test",cred);
  }
  window.ReminderPush={init,enable,test,changed,isActive:()=>active,supported};
})();
