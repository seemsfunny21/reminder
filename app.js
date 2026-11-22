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
  let expandedId = null;
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
  // Past one-off reminders belong in the history automatically, even if the
  // user did not manually mark the underlying task as completed.
  // Keep completed=false so we never claim a task was actually performed.
  function isPastOneTime(reminder,now) {
    return reminder.enabled && !reminder.completed && reminder.repeat==="once"
      && withTime(parseDate(reminder.date),reminder.time).getTime() <= now.getTime();
  }
  function todayScheduled(reminder,now) {
    return reminder.enabled && !reminder.completed && !isPastOneTime(reminder,now) && !!occurrenceOn(reminder,now);
  }
  function toast(message) {
    const el=$("toast"); el.textContent=message; el.classList.add("show");
    clearTimeout(toastTimeout); toastTimeout=setTimeout(()=>el.classList.remove("show"),3700);
  }
  function render() {
    const now = new Date();
    $("todayLabel").textContent = now.toLocaleDateString("el-GR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
    const filtered=reminders.filter(r => {
      const pastOnce=isPastOneTime(r,now);
      if (filter==="completed") return r.completed || pastOnce;
      if (r.completed || pastOnce) return false;
      if (filter==="today") return todayScheduled(r,now);
      if (filter==="upcoming") return !!nextOccurrence(r,now);
      return true;
    }).sort((a,b)=>{
      const at=nextOrOverdue(a,now)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt=nextOrOverdue(b,now)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at-bt || a.title.localeCompare(b.title,"el");
    });
    const titles={active:"Η λίστα μου",today:"Για σήμερα",upcoming:"Προσεχώς",completed:"Έγιναν / Πέρασαν"};
    $("reminderHeading").textContent=titles[filter];
    $("visibleCount").textContent=filtered.length===1 ? "1 στοιχείο" : filtered.length+" στοιχεία";
    document.querySelectorAll("[data-filter]").forEach(button=>{
      const selected=button.dataset.filter===filter;
      button.classList.toggle("active",selected);
      if (selected) button.setAttribute("aria-current","page");
      else button.removeAttribute("aria-current");
    });
    if (!filtered.length) {
      const messages={active:"Η λίστα είναι άδεια",today:"Τίποτα για σήμερα",upcoming:"Δεν υπάρχουν επόμενες",completed:"Δεν υπάρχει ιστορικό"};
      $("reminderList").innerHTML='<div class="empty-state"><span class="empty-icon"><svg><use href="#i-bell"/></svg></span><strong>'+messages[filter]+'</strong></div>';
      return;
    }
    $("reminderList").innerHTML=filtered.map(r=>cardHtml(r,now)).join("");
  }
  function cardHtml(r,now) {
    const next=nextOrOverdue(r,now);
    const overdue=r.enabled && !r.completed && r.repeat==="once" && next && next<now;
    const state=r.completed?"Ολοκληρώθηκε":!r.enabled?"Σε παύση":overdue?"Πέρασε η ώρα":"Ενεργή";
    const muted=r.completed || !r.enabled || overdue;
    const open=expandedId===r.id;
    const category=CATEGORIES[r.category];
    const when=r.enabled||r.completed?timeLabel(next || withTime(parseDate(r.date),r.time),now):"Σε παύση";
    const readableDate=parseDate(r.date).toLocaleDateString("el-GR",{
      weekday:"long",day:"numeric",month:"long",year:"numeric"
    });
    const actionId=escapeHtml(r.id);
    const detailsId="reminder-details-"+r.id.replace(/[^A-Za-z0-9_-]/g,"-");
    const toggleTitle=r.completed?"Επαναφορά":r.enabled?"Παύση":"Ενεργοποίηση";
    const toggleIcon=r.completed||!r.enabled?"i-play":"i-pause";
    return '<article class="reminder-card'+(muted?" is-inactive":"")+(open?" is-open":"")+'">'
      +'<button type="button" class="reminder-summary" data-action="details" data-id="'+actionId+'" aria-expanded="'+open+'" aria-controls="'+detailsId+'">'
      +'<span class="reminder-icon" aria-hidden="true">'+category.icon+'</span>'
      +'<span class="reminder-overview"><strong class="reminder-title">'+escapeHtml(r.title)+'</strong>'
      +'<small class="reminder-next">'+escapeHtml(when)+'</small></span>'
      +'<svg class="reminder-chevron" aria-hidden="true"><use href="#i-arrow"/></svg>'
      +'</button>'
      +'<div class="reminder-details" id="'+detailsId+'"'+(open?"":" hidden") +'>'
      +(r.notes?'<p class="reminder-notes">'+escapeHtml(r.notes)+'</p>':"")
      +'<dl class="reminder-info">'
      +'<div><dt>Ημερομηνία</dt><dd>'+escapeHtml(readableDate)+'</dd></div>'
      +'<div><dt>Ώρα</dt><dd>'+escapeHtml(r.time)+'</dd></div>'
      +'<div><dt>Επανάληψη</dt><dd>'+REPEATS[r.repeat]+'</dd></div>'
      +'<div><dt>Κατηγορία</dt><dd>'+category.label+'</dd></div>'
      +'</dl>'
      +'<div class="reminder-detail-actions"><span class="state-tag'+(muted?" muted":"")+'">'+state+'</span>'
      +(r.repeat==="once"&&!r.completed?'<button class="detail-action" type="button" data-action="done" data-id="'+actionId+'"><svg><use href="#i-check"/></svg> Έγινε</button>':"")
      +'<button class="detail-action" type="button" data-action="toggle" data-id="'+actionId+'"><svg><use href="#'+toggleIcon+'"/></svg> '+toggleTitle+'</button>'
      +'<button class="detail-action" type="button" data-action="edit" data-id="'+actionId+'"><svg><use href="#i-edit"/></svg> Αλλαγή</button>'
      +'</div></div></article>';
  }

  // Quick reminder: all essential fields on one screen, no duplicated steps.
  function upcomingQuickDefault() {
    const candidate=new Date(Date.now()+60*60*1000);
    candidate.setMinutes(Math.ceil(candidate.getMinutes()/5)*5,0,0);
    return candidate;
  }
  function resetQuickForm() {
    const candidate=upcomingQuickDefault();
    $("quickReminderForm").reset();
    $("quickReminderTitle").value="";
    $("quickReminderDate").value=localDate(candidate);
    $("quickReminderDate").min=localDate(new Date());
    $("quickReminderTime").value=String(candidate.getHours()).padStart(2,"0")+":"+String(candidate.getMinutes()).padStart(2,"0");
  }
  function focusQuickComposer(){
    const el=$("quickComposer");
    el.classList.remove("quick-highlight");
    void el.offsetWidth;
    el.classList.add("quick-highlight");
    $("quickReminderTitle").focus({preventScroll:true});
  }
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
    const date=$("quickReminderDate").value,time=$("quickReminderTime").value;
    const day=parseDate(date);
    if(!title){toast("Γράψε τι θέλεις να θυμηθείς.");$("quickReminderTitle").focus();return;}
    if(!day||day<parseDate(localDate(new Date()))){toast("Διάλεξε σημερινή ή μελλοντική ημερομηνία.");return;}
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||withTime(day,time).getTime()<=Date.now()){
      toast("Διάλεξε μελλοντική ώρα.");return;
    }
    const record=normalize({
      id:createId(),title,date,time,notes:"",repeat:"once",category:"general",
      enabled:true,completed:false,lastFiredAt:null
    });
    if(!record){toast("Έλεγξε τα στοιχεία.");return;}
    reminders.push(record);
    expandedId=null;
    persist();filter="active";render();
    resetQuickForm();
    toast("Η υπενθύμιση αποθηκεύτηκε.");
  });
  resetQuickForm();

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
    expandedId=null;
    persist(); closeDialog(); render(); toast("Η υπενθύμιση διαγράφηκε.");
  });
  ["topAdd","floatingAdd"].forEach(id=>$(id).addEventListener("click",focusQuickComposer));
  ["closeDialog","cancelDialog"].forEach(id=>$(id).addEventListener("click",closeDialog));
  $("editorDialog").addEventListener("click",event=>{ if(event.target===$("editorDialog")) closeDialog(); });
  document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{
    filter=button.dataset.filter; expandedId=null; render();
    const pane=document.querySelector(".list-scroll");if(pane)pane.scrollTop=0;
  }));
  // Mobile swipe: move between the existing four reminder filters.
  // Keep the quick-create form, actions and dialogs immune to gestures.
  (function installReminderSwipe(){
    const surface=document.querySelector(".screen-split");
    if(!surface)return;
    const filters=["active","today","upcoming","completed"];
    let start=null,swiped=false;
    // Whole cards are swipeable; form inputs retain native controls.
    const blocked=target=>target instanceof Element && !!target.closest(
      'input,select,textarea,iframe,video,audio,[contenteditable],[data-no-swipe],[role="slider"],[role="textbox"]'
    );
    surface.addEventListener("touchstart",event=>{
      start=null;swiped=false;
      if(event.touches.length!==1||blocked(event.target)||$("editorDialog").open)return;
      const touch=event.touches[0];
      if(touch.clientX<24||touch.clientX>window.innerWidth-24)return;
      start={x:touch.clientX,y:touch.clientY,at:Date.now()};
    },{passive:true});
    surface.addEventListener("touchmove",event=>{
      if(!start||event.touches.length!==1)return;
      const touch=event.touches[0],dx=touch.clientX-start.x,dy=touch.clientY-start.y;
      if(Math.abs(dx)>22&&Math.abs(dx)>Math.abs(dy)*1.5&&event.cancelable){
        event.preventDefault(); // Do not activate a card button after swiping.
      }
    },{passive:false});
    surface.addEventListener("touchend",event=>{
      if(!start)return;
      const origin=start;start=null;
      if(event.changedTouches.length!==1||$("editorDialog").open)return;
      const touch=event.changedTouches[0];
      const dx=touch.clientX-origin.x,dy=touch.clientY-origin.y;
      if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy)*1.6||Date.now()-origin.at>1000)return;
      const pos=filters.indexOf(filter),next=pos+(dx<0?1:-1);
      if(next<0||next>=filters.length)return;
      swiped=true;
      document.querySelector('.main-nav [data-filter="'+filters[next]+'"]')?.click();
    },{passive:true});
    surface.addEventListener("click",event=>{
      if(swiped&&event.isTrusted){
        swiped=false;event.preventDefault();event.stopImmediatePropagation();
      }
    },true);
    surface.addEventListener("touchcancel",()=>{start=null;swiped=false},{passive:true});
  })();

  $("reminderList").addEventListener("click",event=>{
    const button=event.target.closest("button[data-action]");
    if (!button) return;
    const action=button.dataset.action, id=button.dataset.id;
    if (action==="new") { focusQuickComposer(); return; }
    if (action==="details") {expandedId=expandedId===id?null:id;render();return;}
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
    const embedded=window.top!==window.self;
    const supported=!!push?.supported();
    const permitted=supported&&Notification.permission==="granted";
    $("enableNotifications").textContent=active ? "Δοκιμή Push" : "Ενεργοποίηση";
    $("notificationTitle").textContent=active ? "✓ Push ενεργό" : "○ Push ανενεργό";
    $("notificationExplanation").textContent=active
      ? "Οι υπενθυμίσεις αποστέλλονται στην ώρα τους ως ειδοποιήσεις, ακόμη και με κλειστή εφαρμογή. Έλεγχος κάθε 1 λεπτό."
      : !supported ? "Ο browser δεν υποστηρίζει Web Push."
      : Notification.permission==="denied" ? "Οι ειδοποιήσεις έχουν αποκλειστεί στις ρυθμίσεις του Android."
      : embedded&&!permitted ? "Για να επιτρέψεις Push, άνοιξε την Υπενθύμιση ξεχωριστά μία φορά."
      : "Πάτησε Ενεργοποίηση για να λαμβάνεις υπενθυμίσεις με κλειστή οθόνη.";
    const standalone=$("reminderPushStandalone");
    if(standalone){
      const show=embedded&&!active;
      standalone.hidden=!show;
      standalone.style.display=show?"block":"none";
    }
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