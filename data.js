// طبقة البيانات: تربط الصفحة بـ Supabase بنفس الواجهة اللي يستخدمها كود الصفحة
// (collection / doc / onSnapshot / set / update / delete) + رفع الصور + تسجيل الدخول.
(function(){
  const CFG = window.SAFSAF_CONFIG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
  const BUCKET = CFG.bucket || "product-images";
  let UID = null, loaded = false;
  const cache = {};            // kind -> Map(id -> data)
  const colSubs = {};          // kind -> Set(cb)
  const docSubs = {};          // "kind/id" -> Set(cb)
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const mapOf = k => (cache[k] ||= new Map());

  function docSnap(kind, id, pending){
    const d = mapOf(kind).get(id);
    return { id, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: !!pending } };
  }
  function colSnap(kind){
    const docs = [...mapOf(kind).entries()].map(([id, d]) => ({ id, exists: true, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function notify(kind, id, pending){
    if (!loaded) return;
    (colSubs[kind] || []).forEach(cb => { try { cb(colSnap(kind)); } catch(e){ console.error(e); } });
    const ids = id ? [id] : [...Object.keys(docSubs)].filter(k => k.startsWith(kind + "/")).map(k => k.slice(kind.length + 1));
    ids.forEach(i => (docSubs[kind + "/" + i] || []).forEach(cb => { try { cb(docSnap(kind, i, pending)); } catch(e){ console.error(e); } }));
  }
  function notifyAll(){ const kinds = new Set([...Object.keys(colSubs), ...Object.keys(cache), ...Object.keys(docSubs).map(k => k.split("/")[0])]); kinds.forEach(k => notify(k)); }

  async function loadAll(){
    const rows = []; let from = 0;
    for(;;){
      const { data, error } = await sb.from("items").select("kind,id,data").range(from, from + 999);
      if (error) throw error;
      rows.push(...data); if (data.length < 1000) break; from += 1000;
    }
    Object.keys(cache).forEach(k => cache[k].clear());
    rows.forEach(r => mapOf(r.kind).set(r.id, r.data));
    loaded = true; notifyAll();
  }
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  async function write(kind, id, data){
    const prev = mapOf(kind).get(id);
    mapOf(kind).set(id, data); notify(kind, id, true);
    const { error } = await sb.from("items").upsert({ owner: UID, kind, id, data, updated_at: new Date().toISOString() }, { onConflict: "owner,kind,id" });
    if (error){ if (prev === undefined) mapOf(kind).delete(id); else mapOf(kind).set(id, prev); notify(kind, id); throw err("unavailable", error.message); }
    notify(kind, id);
  }
  async function remove(kind, id){
    const prev = mapOf(kind).get(id);
    mapOf(kind).delete(id); notify(kind, id);
    const { error } = await sb.from("items").delete().match({ owner: UID, kind, id });
    if (error){ if (prev !== undefined) mapOf(kind).set(id, prev); notify(kind, id); throw err("unavailable", error.message); }
  }
  function docRef(kind, id){
    return {
      id, path: kind + "/" + id,
      get: async () => docSnap(kind, id),
      set: d => write(kind, id, JSON.parse(JSON.stringify(d))),
      update: d => { const cur = mapOf(kind).get(id); if (cur === undefined) return Promise.reject(err("invalid_argument", "document does not exist")); return write(kind, id, { ...cur, ...JSON.parse(JSON.stringify(d)) }); },
      delete: () => remove(kind, id),
      onSnapshot(cb){ const k = kind + "/" + id; (docSubs[k] ||= new Set()).add(cb); if (loaded) setTimeout(() => cb(docSnap(kind, id)), 0); return () => docSubs[k].delete(cb); }
    };
  }
  const db = {
    collection: kind => ({
      path: kind,
      doc: id => docRef(kind, id || rid()),
      add: async d => { const r = docRef(kind, rid()); await r.set(d); return r; },
      onSnapshot(cb){ (colSubs[kind] ||= new Set()).add(cb); if (loaded) setTimeout(() => cb(colSnap(kind)), 0); return () => colSubs[kind].delete(cb); }
    }),
    doc: path => { const [kind, id] = path.split("/"); return docRef(kind, id); }
  };

  const assets = {
    async upload(blob, opts){
      const type = (opts && opts.type) || blob.type || "image/jpeg";
      const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[type] || "jpg";
      const path = UID + "/" + rid() + "." + ext;
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false, cacheControl: "31536000" });
      if (error) throw err(/size|large/i.test(error.message) ? "too_large" : "upstream_error", error.message);
      return { id: path, url: imgUrl(path), sizeBytes: blob.size, contentType: type };
    },
    async delete(id){ if (!id || !id.includes("/")) return { deleted: false }; await sb.storage.from(BUCKET).remove([id]); return { deleted: true }; }
  };
  function imgUrl(id){ if (!id) return ""; if (/^https?:/.test(id)) return id; if (!id.includes("/")) return ""; return sb.storage.from(BUCKET).getPublicUrl(id).data.publicUrl; }

  let channel = null;
  function listen(){
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("items-" + UID)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: "owner=eq." + UID }, p => {
        if (p.eventType === "DELETE"){ const o = p.old || {}; if (o.kind && o.id){ mapOf(o.kind).delete(o.id); notify(o.kind, o.id); } else loadAll().catch(()=>{}); }
        else { const n = p.new; mapOf(n.kind).set(n.id, n.data); notify(n.kind, n.id); }
      }).subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && UID) loadAll().catch(()=>{}); });

  // استيراد نسخة احتياطية (من الصفحة القديمة داخل Claude)
  async function importBackup(json, onProgress){
    const map = {};
    const imgs = Object.entries(json.images || {});
    for (let i = 0; i < imgs.length; i++){
      const [oldId, dataUrl] = imgs[i];
      onProgress && onProgress("رفع الصور " + (i + 1) + " من " + imgs.length);
      const blob = await (await fetch(dataUrl)).blob();
      map[oldId] = (await assets.upload(blob, { type: blob.type || "image/jpeg" })).id;
    }
    const rows = (json.items || []).map(it => {
      const data = { ...it.data };
      if (it.kind === "products" && data.image) data.image = map[data.image] || null;
      return { owner: UID, kind: it.kind, id: it.id, data, updated_at: new Date().toISOString() };
    });
    onProgress && onProgress("حفظ " + rows.length + " سجل…");
    for (let i = 0; i < rows.length; i += 200){
      const { error } = await sb.from("items").upsert(rows.slice(i, i + 200), { onConflict: "owner,kind,id" });
      if (error) throw err("unavailable", error.message);
    }
    await loadAll();
    return { rows: rows.length, images: imgs.length };
  }
  function exportBackup(){
    const items = []; Object.entries(cache).forEach(([kind, m]) => m.forEach((data, id) => items.push({ kind, id, data })));
    return { app: "safsaf", version: 1, exportedAt: new Date().toISOString(), items, images: {} };
  }

  // تسجيل الدخول
  let booted = false;
  async function boot(session, onReady){
    if (booted) return; booted = true; UID = session.user.id;
    await loadAll(); listen(); onReady && onReady();
  }
  window.SafsafData = {
    sb, db, assets, imgUrl, importBackup, exportBackup,
    get uid(){ return UID; },
    async start(onReady, onNeedLogin){
      const { data: { session } } = await sb.auth.getSession();
      if (session) await boot(session, onReady); else onNeedLogin();
      sb.auth.onAuthStateChange((ev, s) => { if (s && !booted) boot(s, onReady); if (ev === "SIGNED_OUT") location.reload(); });
    },
    async signIn(email, password){ const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error; },
    async signOut(){ await sb.auth.signOut(); }
  };
})();
