(() => {
  "use strict";

  const STORAGE_KEY = "reminder.pwa.v1";
  const REPEATS = { once:"Μία φορά", daily:"Καθημερινά", weekdays:"Δευ.–Παρ.", weekly:"Κάθε εβδομάδα", monthly:"Κάθε μήνα" };
  const CATEGORIES = {
    general:{ label:"Γενικά", icon:"🔔" }, bike:{ label:"Ποδήλατο", icon:"🚴" },
    work:{ label:"Εργασία", icon:"💼" }, home:{ label:"Σπίτι", icon:"🏠" },
    health:{ label:"Προσωπικά", icon:"✨" }
  };
  const $ = id => document.getElementById(id);
  let reminders = loadReminders();
  let filter = "active";
  let editingId = null;
  let workerRegistration = null;
  let toastTimeout;

  function localDate(date) {
    return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");
  }
  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    const [y,m,d] = value.split("-").map(Number);
    const result = new Date(y,m-1,d);
    return result.getFullYear() === y && result.getMonth() === m-1 && result.getDate() === d ? result : null;
  }
  function withTime(date,time) {
    const [hh,mm] = time.split(":").map(Number);
    return new Date(date.getFullYear(),date.getMonth(),date.getDate(),hh,mm,0,0);
  }
  function sameDay(a,b) { return localDate(a) === localDate(b); }
  function normalize(record) {
    if (!record || typeof record !== "object" || typeof record.title !== "string" || !record.title.trim()) return null;
    const date = parseDate(record.date);
    if (!date || typeof record.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(record.time)) return null;
    return {
      id: typeof record.id === "string" && record.id ? record.id : createId(),
      title:record.title.trim().slice(0,110),
      notes:typeof record.notes === "string" ? record.notes.slice(0,500) : "",
      date:record.date, time:record.time,
      repeat:Object.hasOwn(REPEATS,record.repeat) ? record.repeat : "once",
      category:Object.hasOwn(CATEGORIES,record.category) ? record.category : "general",
      enabled:record.enabled !== false,
      completed:record.completed === true,
      lastFiredAt:Number.isFinite(record.lastFiredAt) ? record.lastFiredAt : null,
      snoozeUntil:null
    };
  }
  function createId() { return crypto.randomUUID?.() || "r-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
  function loadReminders() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value.map(normalize).filter(Boolean) : [];
    } catch { return []; }
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(reminders)); window.ReminderPush?.changed(reminders); }
    catch { toast("Η αποθήκευση απέτυχε. Έλεγξε τον χώρο ή τις ρυθμίσεις του browser."); }
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g,c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  }
  function occurrenceOn(reminder,day) {
    const start = parseDate(reminder.date);
    if (!start) return null;
    const dayStart = new Date(day.getFullYear(),day.getMonth(),day.getDate());
    if (dayStart < start) return null;
    const dayOfWeek = day.getDay();
    const lastDay = new Date(day.getFullYear(),day.getMonth()+1,0).getDate();
    const matches = reminder.repeat === "daily"
      || (reminder.repeat === "weekdays" && dayOfWeek >= 1 && dayOfWeek <= 5)
      || (reminder.repeat === "weekly" && dayOfWeek === start.getDay())
      || (reminder.repeat === "monthly" && day.getDate() === Math.min(start.getDate(),lastDay))
      || (reminder.repeat === "once" && sameDay(day,start));
    return matches ? withTime(day,reminder.time) : null;
  }
  function nextOccurrence(reminder,from = new Date()) {
    if (!reminder.enabled || reminder.completed) return null;
    for (let offset=0;offset<=35;offset++) {
      const day = new Date(from.getFullYear(),from.getMonth(),from.getDate()+offset);
      const candidate = occurrenceOn(reminder,day);
      if (candidate && candidate.getTime() > from.getTime()) return candidate;
    }
    return null;
  }
  function nextOrOverdue(reminder,from) {
    const next=nextOccurrence(reminder,from);
    if (next) return next;
    if (reminder.enabled && !reminder.completed && reminder.repeat==="once") return withTime(parseDate(reminder.date),reminder.time);
    return null;
  }
  function timeLabel(date,now = new Date()) {
    if (!date) return "Χωρίς επόμενη ημερομηνία";
    const hm=date.toLocaleTimeString("el-GR",{hour:"2-digit",minute:"2-digit"});
    if (sameDay(date,now)) return "Σήμερα, "+hm;
    const tomorrow = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
    if (sameDay(date,tomorrow)) return "Αύριο, "+hm;
    return date.toLocaleDateString("el-GR",{weekday:"short",day:"numeric",month:"short"})+" • "+hm;
  }
  function todayScheduled(reminder,now) {
    return reminder.enabled && !reminder.completed && !!occurrenceOn(reminder,now);
  }
  function toast(message) {
    const el=$("toast"); el.textContent=message; el.classList.add("show");
    clearTimeout(toastTimeout); toastTimeout=setTimeout(()=>el.classList.remove("show"),3700);
  }
  function render() {
    const now = new Date();
    $("todayLabel").textContent = now.toLocaleDateString("el-GR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
    $("statActive").textContent=reminders.filter(r=>r.enabled && !r.completed).length;
    $("statToday").textContent=reminders.filter(r=>todayScheduled(r,now)).length;
    $("statDone").textContent=reminders.filter(r=>r.completed).length;
    const filtered=reminders.filter(r => {
      if (filter==="completed") return r.completed;
      if (r.completed) return false;
      if (filter==="today") return todayScheduled(r,now);
      if (filter==="upcoming") return !!nextOccurrence(r,now);
      return true;
    }).sort((a,b)=>{
      const at=nextOrOverdue(a,now)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt=nextOrOverdue(b,now)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at-bt || a.title.localeCompare(b.title,"el");
    });
    const titles={active:"Η λίστα μου",today:"Για σήμερα",upcoming:"Προσεχώς",completed:"Ολοκληρωμένες"};
    $("reminderHeading").textContent=titles[filter];
    $("visibleCount").textContent=filtered.length===1 ? "1 υπενθύμιση" : filtered.length+" υπενθυμίσεις";
    document.querySelectorAll("[data-filter]").forEach(button=>{
      const selected=button.dataset.filter===filter;
      button.classList.toggle("active",selected);
      if (selected) button.setAttribute("aria-current","page");
      else button.removeAttribute("aria-current");
    });
    if (!filtered.length) {
      const messages={active:"Δεν έχεις υπενθυμίσεις",today:"Τίποτα για σήμερα",upcoming:"Δεν υπάρχουν επόμενες",completed:"Καμία ολοκληρωμένη"};
      $("reminderList").innerHTML='<div class="empty-state"><span class="empty-icon"><svg><use href="#i-bell"/></svg></span><strong>'+messages[filter]+'</strong></div>';
      return;
    }
    $("reminderList").innerHTML=filtered.map(r=>cardHtml(r,now)).join("");
  }
  function cardHtml(r,now) {
    const next=nextOrOverdue(r,now);
    const overdue=r.enabled && !r.completed && r.repeat==="once" && next && next<now;
    const state=r.completed ? "Ολοκληρώθηκε" : !r.enabled ? "Σε παύση" : overdue ? "Σε εκκρεμότητα" : "Ενεργή";
    const muted=r.completed || !r.enabled || overdue;
    const category=CATEGORIES[r.category];
    const when = r.enabled || r.completed ? timeLabel(next || withTime(parseDate(r.date),r.time),now) : "Σε παύση";
    const actionId=escapeHtml(r.id);
    const toggleIcon=r.completed||!r.enabled?"i-play":"i-pause";
    const toggleTitle=r.completed?"Επαναφορά":r.enabled?"Παύση":"Ενεργοποίηση";
    return '<article class="reminder-card '+(muted?"is-inactive":"")+'">'
      +'<span class="reminder-icon" aria-hidden="true">'+category.icon+'</span>'
      +'<div class="reminder-content"><h3 class="reminder-title">'+escapeHtml(r.title)+'</h3>'
      +(r.notes?'<p class="reminder-notes">'+escapeHtml(r.notes)+'</p>':"")
      +'<div class="reminder-meta"><span class="reminder-time"><svg><use href="#i-clock"/></svg>'+escapeHtml(when)+'</span>'
      +'<span><svg><use href="#i-repeat"/></svg>'+REPEATS[r.repeat]+'</span>'
      +'<span>'+category.label+'</span></div></div>'
      +'<div class="reminder-actions"><span class="state-tag '+(muted?"muted":"")+'">'+state+'</span>'
      +(r.repeat==="once"&&!r.completed?'<button class="mini-button" type="button" data-action="done" data-id="'+actionId+'" aria-label="Ολοκλήρωση" title="Ολοκλήρωση"><svg><use href="#i-check"/></svg></button>':"")
      +'<button class="mini-button" type="button" data-action="toggle" data-id="'+actionId+'" aria-label="'+toggleTitle+'" title="'+toggleTitle+'"><svg><use href="#'+toggleIcon+'"/></svg></button>'
      +'<button class="mini-button" type="button" data-action="edit" data-id="'+actionId+'" aria-label="Επεξεργασία" title="Επεξεργασία"><svg><use href="#i-edit"/></svg></button>'
      +'</div></article>';
  }

  // The quick composer stays open, so a reminder can be created without navigating.
  let quickDateWasChosen=false;
  function upcomingQuickDefault() {
    const now=new Date();
    const candidate=new Date(now.getTime()+60*60*1000);
    candidate.setMinutes(Math.ceil(candidate.getMinutes()/5)*5,0,0);
    return candidate;
  }
  function resetQuickForm() {
    const next=upcomingQuickDefault();
    $("quickReminderForm").reset();
    $("quickReminderTitle").value="";
    $("quickReminderDate").value=localDate(next);
    $("quickReminderDate").min=localDate(new Date());
    $("quickReminderTime").value=String(next.getHours()).padStart(2,"0")+":"+String(next.getMinutes()).padStart(2,"0");
    quickDateWasChosen=false;
    updateQuickCountdown();
  }
  function adjustQuickDateForTime() {
    if(quickDateWasChosen)return;
    const time=$("quickReminderTime").value;
    if(!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time))return;
    const now=new Date();
    const today=localDate(now);
    const candidate=withTime(parseDate(today),time);
    if(candidate<=now)candidate.setDate(candidate.getDate()+1);
    $("quickReminderDate").value=localDate(candidate);
  }
  function updateQuickCountdown() {
    const date=parseDate($("quickReminderDate").value);
    const time=$("quickReminderTime").value;
    const value=$("quickCountdownValue");
    const info=$("quickCountdownLabel");
    const group=$("quickCountdown");
    const valid=date && /^([01]\\d|2[0-3]):[0-5]\\d$/.test(time);
    group.classList.toggle("is-expired",!valid);
    if(!valid) {
      value.textContent="--:--";info.textContent="Επίλεξε ημερομηνία και ώρα.";
      value.setAttribute("aria-label","Δεν έχει οριστεί ώρα");
      return;
    }
    const remaining=withTime(date,time).getTime()-Date.now();
    if(remaining<=0){
      value.textContent="00:00";
      info.textContent="Επίλεξε μελλοντική ώρα";
      value.setAttribute("aria-label","Η επιλεγμένη ώρα έχει περάσει");
      group.classList.add("is-expired");
      return;
    }
    const minutes=Math.ceil(remaining/60000);
    const hh=String(Math.floor(minutes/60)).padStart(2,"0");
    const mm=String(minutes%60).padStart(2,"0");
    value.textContent=hh+":"+mm;
    info.textContent="ώρες : λεπτά";
    value.setAttribute("aria-label",Math.floor(minutes/60)+" ώρες και "+(minutes%60)+" λεπτά");
  }
  function focusQuickComposer(){
    const container=$("quickComposer");
    container.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});
    $("quickReminderTitle").focus({preventScroll:true});
    container.classList.remove("quick-highlight");
    void container.offsetWidth;
    container.classList.add("quick-highlight");
  }
  $("quickReminderDate").addEventListener("change",()=>{
    quickDateWasChosen=true;
    updateQuickCountdown();
  });
  $("quickReminderDate").addEventListener("input",updateQuickCountdown);
  $("quickReminderTime").addEventListener("input",()=>{
    adjustQuickDateForTime();updateQuickCountdown();
  });
  $("quickReminderTime").addEventListener("change",()=>{
    adjustQuickDateForTime();updateQuickCountdown();
  });
  $("quickMore").addEventListener("click",()=>{
    openDialog();
    $("reminderTitle").value=$("quickReminderTitle").value;
    $("reminderDate").value=$("quickReminderDate").value;
    $("reminderTime").value=$("quickReminderTime").value;
    $("reminderTitle").focus();
  });
  $("quickReminderForm").addEventListener("submit",event=>{
    event.preventDefault();
    const title=$("quickReminderTitle").value.trim();
    const date=$("quickReminderDate").value;
    const time=$("quickReminderTime").value;
    const day=parseDate(date);
    if(!title || !day || !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)) {
      toast("Γράψε μια υπενθύμιση και διάλεξε ημερομηνία και ώρα.");return;
    }
    if(withTime(day,time).getTime()<=Date.now()){
      updateQuickCountdown();
      toast("Διάλεξε μελλοντική ώρα.");return;
    }
    const record=normalize({
      id:createId(),title,date,time,notes:"",repeat:"once",category:"general",
      enabled:true,completed:false,lastFiredAt:null
    });
    if(!record){toast("Έλεγξε τα στοιχεία σου.");return;}
    reminders.push(record);
    persist();filter="active";render();
    resetQuickForm();
    toast("Η υπενθύμιση αποθηκεύτηκε.");
  });
  resetQuickForm();
  setInterval(updateQuickCountdown,30000);

  function openDialog(id=null) {
    const r=id ? reminders.find(item=>item.id===id) : null;
    editingId=r?.id || null;
    $("reminderForm").reset();
    $("dialogTitle").textContent=r?"Επεξεργασία":"Νέα υπενθύμιση";
    $("reminderTitle").value=r?.title || "";
    $("reminderNotes").value=r?.notes || "";
    $("reminderDate").value=r?.date || localDate(new Date());
    $("reminderTime").value=r?.time || "09:00";
    $("reminderRepeat").value=r?.repeat || "once";
    $("reminderCategory").value=r?.category || "general";
    $("deleteReminder").hidden=!r;
    $("editorDialog").showModal();
    $("reminderTitle").focus();
  }
  function closeDialog() { $("editorDialog").close(); }

  $("reminderForm").addEventListener("submit",event=>{
    event.preventDefault();
    const title=$("reminderTitle").value.trim();
    const date=$("reminderDate").value;
    const time=$("reminderTime").value;
    if (!title || !parseDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      toast("Συμπλήρωσε τίτλο, ημερομηνία και ώρα."); return;
    }
    const previous=reminders.find(r=>r.id===editingId);
    const record=normalize({
      id:editingId || createId(),title,notes:$("reminderNotes").value.trim(),
      date,time,repeat:$("reminderRepeat").value,category:$("reminderCategory").value,
      enabled:previous?.enabled ?? true,completed:previous?.completed ?? false,
      lastFiredAt:previous?.lastFiredAt ?? null
    });
    if (!record) { toast("Τα στοιχεία δεν είναι έγκυρα."); return; }
    if (previous) reminders=reminders.map(r=>r.id===editingId?record:r);
    else reminders.push(record);
    persist(); closeDialog(); filter="active"; render();
    if(!previous)resetQuickForm();
    toast(previous?"Η υπενθύμιση ενημερώθηκε.":"Η υπενθύμιση αποθηκεύτηκε.");
  });
  $("deleteReminder").addEventListener("click",()=>{
    if (!editingId) return;
    if (!confirm("Να διαγραφεί οριστικά αυτή η υπενθύμιση;")) return;
    reminders=reminders.filter(r=>r.id!==editingId);
    persist(); closeDialog(); render(); toast("Η υπενθύμιση διαγράφηκε.");
  });
  ["topAdd","floatingAdd"].forEach(id=>$(id).addEventListener("click",focusQuickComposer));
  ["closeDialog","cancelDialog"].forEach(id=>$(id).addEventListener("click",closeDialog));
  $("editorDialog").addEventListener("click",event=>{ if(event.target===$("editorDialog")) closeDialog(); });
  document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{
    filter=button.dataset.filter; render(); window.scrollTo({top:0,behavior:"smooth"});
  }));
  $("reminderList").addEventListener("click",event=>{
    const button=event.target.closest("button[data-action]");
    if (!button) return;
    const action=button.dataset.action, id=button.dataset.id;
    if (action==="new") { openDialog(); return; }
    const r=reminders.find(item=>item.id===id);
    if (!r) return;
    if (action==="edit") { openDialog(id); return; }
    if (action==="done") { r.completed=true;r.enabled=false;toast("Η υπενθύμιση ολοκληρώθηκε."); }
    if (action==="toggle") {
      if (r.completed) { r.completed=false;r.enabled=true;toast("Η υπενθύμιση επανήλθε."); }
      else { r.enabled=!r.enabled;toast(r.enabled?"Η υπενθύμιση ενεργοποιήθηκε.":"Η υπενθύμιση τέθηκε σε παύση."); }
    }
    persist();render();
  });

  $("exportButton").addEventListener("click",()=>{
    const content=JSON.stringify({version:1,exportedAt:new Date().toISOString(),reminders},null,2);
    const url=URL.createObjectURL(new Blob([content],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download="reminder-backup-"+localDate(new Date())+".json";
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast("Το αντίγραφο δημιουργήθηκε.");
  });
  $("importButton").addEventListener("click",()=>$("importFile").click());
  $("importFile").addEventListener("change",async event=>{
    const file=event.target.files?.[0];
    event.target.value="";
    if (!file) return;
    if (file.size>2_000_000) {toast("Το αρχείο είναι πολύ μεγάλο.");return;}
    try {
      const data=JSON.parse(await file.text());
      const records=Array.isArray(data)?data:data?.reminders;
      if (!Array.isArray(records)) throw new Error("bad format");
      const valid=records.map(normalize).filter(Boolean);
      if (records.length && !valid.length) throw new Error("no valid reminders");
      if (!confirm("Η εισαγωγή θα αντικαταστήσει τις υπενθυμίσεις αυτής της συσκευής. Συνέχεια;")) return;
      reminders=valid;persist();filter="active";render();toast("Εισήχθησαν "+valid.length+" υπενθυμίσεις.");
    } catch { toast("Το αρχείο δεν είναι έγκυρο αντίγραφο Reminder."); }
  });

  async function showSystemNotification(title,body,tag) {
    const registration=workerRegistration || await navigator.serviceWorker.ready;
    await registration.showNotification(title,{
      body,icon:"./icon.svg",badge:"./icon.svg",tag,renotify:false,
      data:{url:new URL("./",location.href).href}
    });
  }
  function updatePermissionUI(){
    const push=window.ReminderPush;
    const active=!!push?.isActive();
    $("enableNotifications").textContent=active ? "Δοκιμή" : "Ενεργοποίηση";
    $("notificationTitle").textContent=active ? "Push ενεργό" : "Ειδοποιήσεις";
    $("notificationExplanation").textContent=active ? "" :
      push?.supported() ? "Λήψη ακόμη και με κλειστή εφαρμογή." : "Δεν υποστηρίζονται σε αυτόν τον browser.";
    $("notificationTitle").closest(".notice")?.classList.toggle("is-active",active);
  }
  window.addEventListener("reminderpushstate",event=>{
    updatePermissionUI();
    if(event.detail?.message && !event.detail.active) console.warn("Reminder Push:",event.detail.message);
  });
  $("enableNotifications").addEventListener("click",async()=>{
    const button=$("enableNotifications");
    if(!window.ReminderPush) {toast("Η υπηρεσία Push δεν φορτώθηκε.");return;}
    button.disabled=true;
    const wasActive=window.ReminderPush.isActive();
    button.textContent="Σύνδεση...";
    try {
      if(wasActive) await window.ReminderPush.test();
      else await window.ReminderPush.enable(reminders);
      toast(wasActive ? "Η δοκιμή στάλθηκε." : "Το Push ενεργοποιήθηκε.");
    } catch(error) {
      console.error("Remote push failed",error);
      toast(error?.message || "Η ενεργοποίηση Push απέτυχε.");
    } finally {
      button.disabled=false;
      updatePermissionUI();
    }
  });

  let checking=false;
  async function checkDue() {
    if (checking || window.ReminderPush?.isActive() || !("Notification" in window) || Notification.permission!=="granted" || !("serviceWorker" in navigator)) return;
    checking=true;
    try {
      const now=Date.now();
      const day=new Date();
      const yesterday=new Date(day.getFullYear(),day.getMonth(),day.getDate()-1);
      for(const r of reminders) {
        if (!r.enabled || r.completed) continue;
        const dates=[occurrenceOn(r,yesterday),occurrenceOn(r,day)].filter(Boolean);
        for(const when of dates) {
          const target=when.getTime();
          if (now>=target && now-target<=110000 && r.lastFiredAt!==target) {
            await showSystemNotification(r.title,r.notes || "Ώρα για την υπενθύμισή σου!","reminder-"+r.id+"-"+target);
            r.lastFiredAt=target;persist();
          }
        }
      }
    } catch(error){console.warn("Reminder notification check:",error);}
    finally{checking=false;}
  }
  async function initServiceWorker(){
    if (!("serviceWorker" in navigator)) return;
    try {
      workerRegistration=await navigator.serviceWorker.register("./sw.js",{scope:"./"});
    }catch(e){console.warn("Service worker could not be registered:",e);}
  }
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden){render();checkDue();} });
  window.addEventListener("focus",()=>{render();checkDue();});
  window.addEventListener("storage",event=>{if(event.key===STORAGE_KEY){reminders=loadReminders();render();window.ReminderPush?.changed(reminders);}});
  initServiceWorker().then(()=>{window.ReminderPush?.init(()=>reminders);checkDue();});
  updatePermissionUI();render();
  setInterval(checkDue,15000);
  setInterval(()=>render(),60000);
})();