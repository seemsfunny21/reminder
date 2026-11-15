import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!PROJECT_URL || !SERVICE_KEY) throw new Error("Missing Supabase runtime credentials");
const db = createClient(PROJECT_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const APP_ORIGIN = "https://seemsfunny21.github.io";
const CORS = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
  "Cache-Control": "no-store"
};
function reply(data:unknown, status=200) {
  return new Response(JSON.stringify(data),{
    status, headers: { ...CORS,"Content-Type":"application/json; charset=utf-8" }
  });
}
function fail(message:string, status=400) { return reply({ok:false,error:message},status); }
function validEndpoint(urlStr:unknown) {
  if(typeof urlStr!=="string" || urlStr.length>1500)return false;
  try {
    const url=new URL(urlStr);
    const host=url.hostname.toLowerCase();
    return url.protocol==="https:" && !url.username && !url.password &&
      (host==="fcm.googleapis.com" || host.endsWith(".push.apple.com") ||
       host.endsWith(".push.services.mozilla.com"));
  } catch {return false;}
}
function validTime(s:unknown) {return typeof s==="string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s);}
function validDate(s:unknown) {
  if(typeof s!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
  const d=new Date(s+"T12:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0,10)===s;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64=/^[A-Za-z0-9_-]+$/;
const REPEAT=new Set(["once","daily","weekdays","weekly","monthly"]);
async function sha256(text:string) {
  const bytes=new TextEncoder().encode(text);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)))
    .map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function getSecret(name:string) {
  const {data,error}=await db.from("reminder_push_secrets").select("value").eq("name",name).maybeSingle();
  if(error)throw error;
  return data?.value || null;
}
async function createSecret(name:string,value:unknown) {
  const {error}=await db.from("reminder_push_secrets").upsert(
    {name,value},{onConflict:"name",ignoreDuplicates:true}
  );
  if(error)throw error;
  const stored=await getSecret(name);
  if(!stored)throw new Error("Secret storage unavailable");
  return stored;
}
let promiseSecrets:Promise<{vapid:Record<string,unknown>, cron:Record<string,unknown>}>|null=null;
async function ensureSecrets() {
  if(!promiseSecrets) promiseSecrets=(async()=>{
    let vapid=await getSecret("vapid");
    if(!vapid){
      const keys=await webpush.generateVapidKeys({extractable:true});
      const exported=await webpush.exportVapidKeys(keys);
      const publicKey=await webpush.exportApplicationServerKey(keys);
      vapid=await createSecret("vapid",{exported,publicKey});
    }
    let cron=await getSecret("cron");
    if(!cron)cron=await createSecret("cron",{token:crypto.randomUUID()+"-"+crypto.randomUUID()});
    return {vapid,cron};
  })().catch(error=>{promiseSecrets=null;throw error;});
  return await promiseSecrets;
}
async function applicationServer() {
  const {vapid}=await ensureSecrets();
  const keys=await webpush.importVapidKeys(vapid.exported as webpush.ExportedVapidKeys);
  return webpush.ApplicationServer.new({
    contactInformation:"https://seemsfunny21.github.io",
    vapidKeys:keys
  });
}
async function pushTo(device:{endpoint:string,p256dh:string,auth:string},title:string,body:string,tag:string) {
  const server=await applicationServer();
  await server.subscribe({
    endpoint:device.endpoint,
    keys:{p256dh:device.p256dh,auth:device.auth}
  }).pushTextMessage(JSON.stringify({title,body,tag}),{ttl:3600});
}
async function authorisedDevice(deviceId:unknown,token:unknown) {
  if(typeof deviceId!=="string" || !UUID.test(deviceId) ||
     typeof token!=="string" || token.length<35 || token.length>200 || !BASE64.test(token))return null;
  const {data,error}=await db.from("reminder_push_devices").select("*").eq("device_id",deviceId).maybeSingle();
  if(error)throw error;
  if(!data || data.token_hash!==await sha256(token))return null;
  return data;
}
function normalizeItem(item:unknown) {
  if(!item || typeof item!=="object")return null;
  const r=item as Record<string,unknown>;
  if(typeof r.id!=="string" || r.id.length<1 || r.id.length>110 ||
     typeof r.title!=="string" || !r.title.trim() || r.title.length>110 ||
     typeof r.notes!=="string" || r.notes.length>500 ||
     !validDate(r.date) || !validTime(r.time) || !REPEAT.has(String(r.repeat)))return null;
  return {
    reminder_id:r.id,title:r.title.trim(),notes:r.notes,
    start_date:r.date,at_time:r.time+":00",repeat_rule:r.repeat,
    enabled:r.enabled===true && r.completed!==true
  };
}
Deno.serve(async (req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  const origin=req.headers.get("Origin");
  if(origin && origin!==APP_ORIGIN)return fail("Origin not allowed",403);
  try {
    if(req.method==="GET") {
      const {vapid}=await ensureSecrets();
      return reply({ok:true,vapidPublicKey:vapid.publicKey,version:1});
    }
    if(req.method!=="POST")return fail("Method not allowed",405);
    const raw=await req.text();
    if(raw.length>110000)return fail("Request too large",413);
    let data:Record<string,unknown>;
    try{data=JSON.parse(raw);}catch{return fail("Invalid JSON");}
    if(!data || typeof data!=="object")return fail("Invalid request");
    const action=data.action;
    if(action==="dispatch") {
      const {cron}=await ensureSecrets();
      if(req.headers.get("X-Reminder-Cron-Secret")!==cron.token)return fail("Forbidden",403);
      const {data:due,error}=await db.rpc("reminder_push_claim_due");
      if(error)throw error;
      let delivered=0,failed=0;
      for(const row of (due||[]).slice(0,100)) {
        try {
          await pushTo(row,row.title,row.notes || "Ώρα για την υπενθύμισή σου!",
            "reminder-"+row.reminder_id+"-"+row.scheduled_local);
          delivered++;
        }catch(error){
          failed++;
          console.error("Reminder push failed",String(error));
          const status=(error as {response?:{status?:number}})?.response?.status;
          if(status===404 || status===410)
            await db.from("reminder_push_devices").update({enabled:false}).eq("device_id",row.device_id);
        }
      }
      return reply({ok:true,claimed:(due||[]).length,delivered,failed});
    }
    if(action==="sync") {
      const deviceId=data.deviceId, token=data.token;
      if(typeof deviceId!=="string" || !UUID.test(deviceId) ||
        typeof token!=="string" || !BASE64.test(token) || token.length<35 || token.length>200)
        return fail("Invalid device credentials");
      const sub=data.subscription as Record<string,unknown>|null;
      const keys=sub?.keys as Record<string,unknown>|undefined;
      if(!sub || !validEndpoint(sub.endpoint) || !keys ||
         typeof keys.p256dh!=="string" || !BASE64.test(keys.p256dh) || keys.p256dh.length<60 || keys.p256dh.length>150 ||
         typeof keys.auth!=="string" || !BASE64.test(keys.auth) || keys.auth.length<10 || keys.auth.length>100)
        return fail("Invalid push subscription");
      const zone=data.timezone;
      if(typeof zone!=="string" || zone.length>70)return fail("Invalid timezone");
      try{new Intl.DateTimeFormat("en-US",{timeZone:zone});}catch{return fail("Unsupported timezone");}
      const items=data.reminders;
      if(!Array.isArray(items) || items.length>100)return fail("Too many reminders");
      const normalized=items.map(normalizeItem);
      if(normalized.some(x=>!x))return fail("Invalid reminder data");
      if(new Set(normalized.map(x=>x!.reminder_id)).size!==normalized.length)
        return fail("Duplicate reminder ids");
      const existing=await authorisedDevice(deviceId,token);
      if(!existing) {
        const {data:present,error:lookupError}=await db.from("reminder_push_devices")
          .select("device_id").eq("device_id",deviceId).maybeSingle();
        if(lookupError)throw lookupError;
        if(present)return fail("Device credentials rejected",403);
      }
      const {error:upsertError}=await db.from("reminder_push_devices").upsert({
        device_id:deviceId,token_hash:await sha256(token),
        endpoint:sub.endpoint,p256dh:keys.p256dh,auth:keys.auth,
        timezone:zone,enabled:true,updated_at:new Date().toISOString()
      },{onConflict:"device_id"});
      if(upsertError)throw upsertError;
      const {data:count,error:syncError}=await db.rpc("reminder_push_sync_items",{
        p_device_id:deviceId,p_items:normalized
      });
      if(syncError)throw syncError;
      return reply({ok:true,scheduled:count});
    }
    if(action==="test") {
      const device=await authorisedDevice(data.deviceId,data.token);
      if(!device)return fail("Device credentials rejected",403);
      if(device.last_test_at && Date.now()-new Date(device.last_test_at).getTime()<45000)
        return fail("Wait before sending another test",429);
      const {error:stampError}=await db.from("reminder_push_devices")
        .update({last_test_at:new Date().toISOString()}).eq("device_id",device.device_id);
      if(stampError)throw stampError;
      await pushTo(device,"Reminder • Push ενεργό",
        "Η δοκιμαστική ειδοποίηση στάλθηκε από το Supabase, ακόμη και χωρίς ανοιχτή καρτέλα.",
        "reminder-remote-test");
      return reply({ok:true,sent:true});
    }
    return fail("Unknown action",404);
  }catch(error){
    console.error("Reminder Edge Function:",String(error));
    return fail("Temporary server error",500);
  }
});
