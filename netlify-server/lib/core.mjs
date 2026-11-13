// Shared Roamerica live server. Runs on Netlify (with Netlify Blobs) and on Cloudflare (Durable Object store).
// The store is anything with: get(key,{type}), getWithMetadata(key,{type}), set(key,bytes,{metadata}), setJSON(key,val,opts), list({prefix}), delete(key).
const crypto = globalThis.crypto;
const enc = new TextEncoder();
const clean = (s, n = 200) => String(s == null ? "" : s).replace(/[<>]/g, "").trim().slice(0, n);
const low = (s) => clean(s, 40).toLowerCase().replace(/[^a-z0-9 _.-]/g, "").replace(/\s+/g, "_");
const pad = (t) => String(t).padStart(14, "0");
const rid = () => Math.random().toString(36).slice(2, 8);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
let PUSH = null;
export { clean, low, pad, json, CORS };

const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b64 = (b) => { let s = ""; const x = u8(b); for (let i = 0; i < x.length; i += 0x8000) s += String.fromCharCode.apply(null, x.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const r = atob(String(s)); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
const b64u = (b) => b64(typeof b === "string" ? enc.encode(b) : b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return unb64(s); };
export { b64, unb64 };

async function vapidKeys(store) {
  let k = await store.get("k/vapid", { type: "json" });
  if (!k) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const jwk = { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d };
    k = { jwk, pub: b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))) };
    await store.setJSON("k/vapid", k, { onlyIfNew: true }).catch(() => {});
    k = (await store.get("k/vapid", { type: "json" })) || k;
  }
  return k;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
export async function encryptPush(payload, p256dh, auth) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  const ua = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const ck = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, ck, cat(enc.encode(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, body);
}
const JWT = new Map();
async function vapidAuth(store, aud) {
  const c = JWT.get(aud); if (c && c.exp > Date.now() + 3600e3) return c.h;
  const k = await vapidKeys(store);
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp, sub: "https://audio-city-life.netlify.app" }));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.jwk.x, y: k.jwk.y, d: k.jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  const h = `vapid t=${head}.${claims}.${b64u(new Uint8Array(sig))}, k=${k.pub}`;
  JWT.set(aud, { h, exp: exp * 1000 }); return h;
}
export async function sendPush(store, to, msg, kind, subIn) {
  if (PUSH) return PUSH(to, msg, kind, subIn);
  return deliverPush(store, to, msg, kind, subIn);
}
export async function deliverPush(store, to, msg, kind, subIn) {
  try {
    const sub = subIn || await store.get(`n/${to}`, { type: "json" });
    if (!sub || !sub.endpoint || !sub.keys) return;
    if (kind && sub.prefs && sub.prefs[kind] === false) return;
    const auth = await vapidAuth(store, new URL(sub.endpoint).origin);
    const body = await encryptPush(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth);
    const r = await fetch(sub.endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: auth }, body });
    if (r.status === 404 || r.status === 410) await store.delete(`n/${to}`);
  } catch {}
}
const prefsOf = (p) => { p = p || {}; return { text: p.text !== false, call: p.call !== false, job: p.job !== false, chat: p.chat !== false, pet: p.pet !== false }; };
async function activeNow(store, to) {
  const pl = await store.list({ prefix: "p/" }); const now = Date.now();
  const all = await Promise.all(pl.blobs.map((x) => store.get(x.key, { type: "json" })));
  return all.some((p) => p && low(p.nm) === to && now - p.t < 25000 && !p.hid);
}
async function notify(store, to, msg, kind) { if (!(await activeNow(store, to))) await sendPush(store, to, msg, kind); }
async function notifyChat(store, fromName, body) {
  try {
    const me = low(fromName), now = Date.now();
    const l = await store.list({ prefix: "n/" });
    const pl = await store.list({ prefix: "p/" });
    const pres = (await Promise.all(pl.blobs.map((x) => store.get(x.key, { type: "json" })))).filter((p) => p && now - p.t < 25000 && !p.hid).map((p) => low(p.nm));
    await Promise.all(l.blobs.slice(0, 200).map(async (x) => {
      const u = x.key.slice(2); if (u === me || pres.includes(u)) return;
      const sub = await store.get(x.key, { type: "json" });
      if (!sub || !sub.prefs || sub.prefs.chat === false) return;
      if (sub.lastChat && now - sub.lastChat < 120000) return;
      sub.lastChat = now; await store.setJSON(x.key, sub);
      await sendPush(store, u, { title: fromName + " in Player chat", body: body, tag: "chat" }, "chat", sub);
    }));
  } catch {}
}


// ---- Bridge between the Netlify server and the Cloudflare server, so players on both chat together ----
const tOfKey = (k) => (k.startsWith("c/") ? Number(k.slice(2, 16)) : k.startsWith("i/") ? Number(k.split("/")[2].slice(0, 14)) : 0);
async function voiceOf(store, vkey) {
  try { const e = await store.getWithMetadata(vkey, { type: "arrayBuffer" }); if (!e || !e.data || e.data.byteLength > 1100000) return null; return { d: b64(e.data), m: (e.metadata && e.metadata.mime) || "audio/mp4" }; } catch { return null; }
}
export async function bridgeOp(store, b, now) {
  if (b.op === "_x") { // new chat lines, inbox messages and who is online, since a time
    const cur = Number(b.cur) || now - 60000;
    const [ch, ib, pl] = await Promise.all([store.list({ prefix: "c/" }), store.list({ prefix: "i/" }), store.list({ prefix: "p/" })]);
    const keys = [...ch.blobs, ...ib.blobs].map((x) => x.key).filter((k) => tOfKey(k) > cur).sort().slice(-200);
    const items = []; let size = 0;
    for (const k of keys) {
      const v = await store.get(k, { type: "json" }); if (!v || v.br) continue;
      const it = { k, v };
      if (v.vkey && size < 3e6) { const vd = await voiceOf(store, v.vkey); if (vd) { it.vd = vd.d; it.vm = vd.m; size += vd.d.length; } }
      items.push(it);
    }
    for (const x of pl.blobs) { const v = await store.get(x.key, { type: "json" }); if (v && !v.br && now - v.t < 45000) items.push({ k: x.key, v }); }
    return { now, items };
  }
  if (b.op === "_l") { // list saved games, profiles, shops and notification sign-ups with their times
    const out = [];
    for (const pre of ["s/", "u/", "b/", "n/", "k/"]) { const l = await store.list({ prefix: pre }); for (const x of l.blobs) { const v = await store.get(x.key, { type: "json" }); if (v) out.push([x.key, Number(v.t) || 0]); } }
    return { now, keys: out };
  }
  if (b.op === "_g") { // get some keys
    const items = []; let size = 0;
    for (const k of (b.keys || []).slice(0, 40)) {
      if (size > 4e6) break;
      if (k.startsWith("v/")) { const vd = await voiceOf(store, k); if (vd) { items.push({ k, vd: vd.d, vm: vd.m }); size += vd.d.length; } continue; }
      const v = await store.get(k, { type: "json" }); if (v) { items.push({ k, v }); size += JSON.stringify(v).length; }
    }
    return { items };
  }
  if (b.op === "_i") { // write items from the other server
    let n = 0;
    for (const it of (b.items || []).slice(0, 300)) {
      const k = String(it.k || ""); if (!/^[cipsubn]\//.test(k)) continue;
      if (it.vd && it.v && it.v.vkey && /^v\//.test(it.v.vkey)) { const ex = await store.get(it.v.vkey, { type: "arrayBuffer" }); if (!ex) await store.set(it.v.vkey, unb64(it.vd), { metadata: { mime: it.vm || "audio/mp4" } }); }
      if (k.startsWith("p/")) { if (it.v && now - it.v.t < 45000) { await store.setJSON(k, { ...it.v, t: now, br: 1 }); n++; } continue; }
      const ex = await store.get(k, { type: "json" });
      if (/^[ci]\//.test(k)) { // copy under the arrival time so players who already checked still get it
        if (ex || (await store.get("z/" + k, { type: "json" }))) continue;
        const nk = k.startsWith("c/") ? `c/${pad(now)}-${k.split("-").pop()}` : `i/${k.split("/")[1]}/${pad(now)}-${k.split("-").pop()}`;
        await store.setJSON(nk, { ...it.v, br: 1 }); await store.setJSON("z/" + k, { t: now }); n++; continue;
      }
      if (!ex || (Number(it.v && it.v.t) || 0) > (Number(ex.t) || 0)) { await store.setJSON(k, it.v); n++; }
    }
    return { ok: true, n };
  }
  return { error: "bad bridge op" };
}

export async function handle(req, store, opts = {}) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    const qs = new URL(req.url).searchParams, v = qs.get("v");
    if (qs.get("vapid")) { const k = await vapidKeys(store); return json({ key: k.pub }); }
    if (v && /^v\/[0-9]{14}-[a-z0-9]{1,8}$/.test(v)) {
      const e = await store.getWithMetadata(v, { type: "arrayBuffer" });
      if (e === null) return new Response("gone", { status: 404, headers: CORS });
      return new Response(e.data, { headers: { "content-type": (e.metadata && e.metadata.mime) || "audio/mp4", "cache-control": "public, max-age=604800", ...CORS } });
    }
    return json({ ok: true, hello: "Roamerica live service" });
  }
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const now = Date.now();
  PUSH = opts.push || null;
  try {
    if (b.op === "sync") {
      const id = clean(b.id, 40), nm = clean(b.nm, 40), at = clean(b.at, 40), me = low(nm);
      if (nm && b.prof && typeof b.prof === "object") { try { const pf = JSON.parse(JSON.stringify(b.prof).slice(0, 4000)); await store.setJSON(`u/${me}`, { ...pf, t: now }); } catch {} }
      if (id && nm) await store.setJSON(`p/${id}`, { nm, at, t: now, vc: b.vc === 2 ? 2 : b.vc ? 1 : 0, hid: b.hid ? 1 : 0, act: clean(b.act, 60) });
      const since = Number(b.since) || now, isince = Number(b.isince) || now - 7 * 864e5;
      const [pl, ch, ib, sg] = await Promise.all([
        store.list({ prefix: "p/" }),
        store.list({ prefix: "c/" }),
        me ? store.list({ prefix: `i/${me}/` }) : Promise.resolve({ blobs: [] }),
        id ? store.list({ prefix: `g/${id}/` }) : Promise.resolve({ blobs: [] }),
      ]);
      const sig = (await Promise.all(sg.blobs.map((x) => store.get(x.key, { type: "json" }).then((v) => { store.delete(x.key).catch(() => {}); return v; })))).filter((v) => v && now - v.t < 60000);
      const all = (await Promise.all(pl.blobs.map((x) => store.get(x.key, { type: "json" }).then((v) => (v ? { key: x.key, id: x.key.slice(2), ...v } : { key: x.key, t: 0 })))));
      const pres = all.filter((p) => p.nm && now - p.t < (p.hid ? 75000 : 45000) && p.id !== id);
      const chatKeys = ch.blobs.map((x) => x.key).filter((k) => Number(k.slice(2, 16)) > since).sort().slice(-30);
      const chat = (await Promise.all(chatKeys.map((k) => store.get(k, { type: "json" }).then((v) => (v ? { ...v, t: Number(k.slice(2, 16)) } : null))))).filter(Boolean);
      const inKeys = ib.blobs.map((x) => x.key).filter((k) => Number(k.split("/")[2].slice(0, 14)) > isince).sort().slice(-50);
      const inbox = (await Promise.all(inKeys.map((k) => store.get(k, { type: "json" }).then((v) => (v ? { ...v, t: Number(k.split("/")[2].slice(0, 14)) } : null))))).filter(Boolean);
      if (Math.random() < 0.1) {
        const old = [
          ...all.filter((p) => now - p.t > 6e5).map((p) => p.key),
          ...ch.blobs.map((x) => x.key).filter((k) => now - Number(k.slice(2, 16)) > 36e5),
          ...ib.blobs.map((x) => x.key).filter((k) => now - Number(k.split("/")[2].slice(0, 14)) > 7 * 864e5),
        ];
        try { const zb = await store.list({ prefix: "z/" }); for (const x of zb.blobs.slice(0, 50)) { const z = await store.get(x.key, { type: "json" }); if (!z || now - z.t > 2 * 864e5) old.push(x.key); } } catch {}
        try { const vb = await store.list({ prefix: "v/" }); old.push(...vb.blobs.map((x) => x.key).filter((k) => now - Number(k.slice(2, 16)) > 7 * 864e5)); } catch {}
        await Promise.all(old.slice(0, 100).map((k) => store.delete(k)));
      }
      return json({ now, players: pres.map(({ id, nm, at, vc, act }) => ({ id, nm, at, vc: vc === 2 ? 2 : vc ? 1 : 0, act: act || "" })), chat, inbox, sig });
    }
    if (b.op === "chat") {
      const msg = clean(b.msg, 5000); if (!msg) return json({ error: "empty" }, 400);
      await store.setJSON(`c/${pad(now)}-${rid()}`, { nm: clean(b.nm, 40), at: clean(b.at, 40), msg, id: clean(b.id, 40) });
      await notifyChat(store, clean(b.nm, 40), msg.slice(0, 120));
      const ments = [...new Set((msg.match(/@([A-Za-z0-9 _.-]{1,40}?)(?=[\s,.!?:;]|$)/g) || []).map((x) => low(x.slice(1))))].slice(0, 5);
      for (const u of ments) if (u && u !== low(b.nm)) await notify(store, u, { title: clean(b.nm, 40) + " mentioned you", body: msg.slice(0, 120), tag: "mention" }, "chat");
      return json({ ok: true, now });
    }
    if (b.op === "voice") {
      const data = String(b.data || ""); if (!data || data.length > 1400000) return json({ error: "too big" }, 400);
      const mime = /^audio\/[a-z0-9.+-]+(;.*)?$/i.test(b.mime || "") ? String(b.mime).split(";")[0] : "audio/mp4";
      const vkey = `v/${pad(now)}-${rid()}`;
      await store.set(vkey, unb64(data), { metadata: { mime } });
      const secs = Math.max(1, Math.min(30, Number(b.secs) || 0));
      if (b.to) {
        const to = low(b.to);
        await store.setJSON(`i/${to}/${pad(now)}-${rid()}`, { from: clean(b.nm, 40), type: b.kind === "call" ? "cl" : "text", msg: "", vkey, secs });
        if (b.kind !== "call") await notify(store, to, { title: clean(b.nm, 40), body: "Sent you a voice message in Roamerica", tag: "t-" + low(b.nm) }, "text");
      } else {
        await store.setJSON(`c/${pad(now)}-${rid()}`, { nm: clean(b.nm, 40), at: clean(b.at, 40), msg: "", id: clean(b.id, 40), vkey, secs });
        await notifyChat(store, clean(b.nm, 40), "Sent a voice message");
      }
      return json({ ok: true, now, vkey });
    }
    if (b.op === "csave") {
      const u = low(b.u), h = String(b.h || ""); const data = String(b.data || "");
      if (!u || !/^[a-f0-9]{64}$/.test(h) || !data || data.length > 900000) return json({ error: "bad" }, 400);
      const cur = await store.get(`s/${u}`, { type: "json" });
      if (cur && cur.h !== h) return json({ ok: false, error: "taken" });
      await store.setJSON(`s/${u}`, { h, data, t: now });
      return json({ ok: true, t: now });
    }
    if (b.op === "cload") {
      const u = low(b.u), h = String(b.h || "");
      const cur = await store.get(`s/${u}`, { type: "json" });
      if (!cur || cur.h !== h) return json({ ok: false });
      return json({ ok: true, data: cur.data, t: cur.t });
    }
    if (b.op === "bizset") {
      const owner = clean(b.owner, 40), key = low(owner); if (!key) return json({ error: "no owner" }, 400);
      await store.setJSON(`b/${key}`, { owner, name: clean(b.name, 40), type: clean(b.type, 20), t: now });
      return json({ ok: true });
    }
    if (b.op === "bizlist") {
      const l = await store.list({ prefix: "b/" });
      const shops = (await Promise.all(l.blobs.slice(0, 60).map((x) => store.get(x.key, { type: "json" })))).filter((v) => v && now - v.t < 30 * 864e5);
      return json({ shops });
    }
    if (b.op === "xfer") {
      const data = String(b.data || ""); if (!data || data.length > 900000) return json({ error: "bad" }, 400);
      const code = [...crypto.getRandomValues(new Uint8Array(9))].map((x) => x.toString(16).padStart(2, "0")).join("");
      await store.setJSON(`x/${code}`, { data, t: now });
      return json({ ok: true, code });
    }
    if (b.op === "xget") {
      const code = String(b.code || "").replace(/[^a-z0-9]/g, "").slice(0, 40);
      const cur = code && await store.get(`x/${code}`, { type: "json" });
      if (!cur || now - cur.t > 30 * 864e5) return json({ ok: false });
      return json({ ok: true, data: cur.data });
    }
    if (b.op === "sig") {
      const to = clean(b.to, 40), from = clean(b.from, 40); if (!to || !from) return json({ error: "bad" }, 400);
      const data = String(b.data || "").slice(0, 20000);
      await store.setJSON(`g/${to}/${pad(now)}-${rid()}`, { from, kind: clean(b.kind, 10), data, t: now });
      return json({ ok: true });
    }
    if (b.op === "pushsub") {
      const u = low(b.nm), sub = b.sub || {};
      if (!u || !/^https:\/\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: "bad" }, 400);
      await store.setJSON(`n/${u}`, { endpoint: String(sub.endpoint).slice(0, 800), keys: { p256dh: clean(sub.keys.p256dh, 200), auth: clean(sub.keys.auth, 100) }, prefs: prefsOf(b.prefs), t: now });
      return json({ ok: true });
    }
    if (b.op === "pushprefs") { const u = low(b.nm); const cur = u && await store.get(`n/${u}`, { type: "json" }); if (cur) { cur.prefs = prefsOf(b.prefs); cur.t = now; await store.setJSON(`n/${u}`, cur); } return json({ ok: !!cur }); }
    if (b.op === "pushoff") { const u = low(b.nm); if (u) await store.delete(`n/${u}`); return json({ ok: true }); }
    if (b.op === "homeowners") { // which players live in a home, by home key
      const hk = clean(b.hk, 40); if (!hk) return json({ owners: [] });
      const l = await store.list({ prefix: "u/" }); const owners = [];
      for (const x of l.blobs.slice(0, 400)) { const v = await store.get(x.key, { type: "json" }); if (v && v.hk === hk && now - (v.t || 0) < 60 * 864e5) owners.push({ nm: clean(v.nm, 40), rent: !!v.rent }); if (owners.length >= 25) break; }
      return json({ owners });
    }
    if (b.op === "profile") { const u = low(b.nm); const prof = u ? await store.get(`u/${u}`, { type: "json" }) : null; return json({ ok: !!prof, prof }); }
    if (b.op === "send") {
      const to = low(b.to); if (!to) return json({ error: "no recipient" }, 400);
      const type = ["text", "call", "cl", "bizpay", "bizinvite", "pay", "gift", "meet", "visit", "dm", "party", "ride", "rideok", "ridego", "rideno", "fare", "rel"].includes(b.type) ? b.type : "text";
      await store.setJSON(`i/${to}/${pad(now)}-${rid()}`, { from: clean(b.from, 40), type, msg: clean(b.msg, 5000), st: clean(b.st, 10), cid: clean(b.cid, 20) });
      const from = clean(b.from, 40);
      if (type === "text") await notify(store, to, { title: from, body: clean(b.msg, 120), tag: "t-" + low(from) }, "text");
      else if (type === "call" && b.st === "ring") await notify(store, to, { title: from + " is calling you", body: "Open Roamerica to answer.", tag: "call" }, "call");
      else if (type === "dm") await notify(store, to, { title: "Private message from " + from, body: clean(b.msg, 120), tag: "dm-" + low(from) }, "text");
      else if (type === "gift") await notify(store, to, { title: from + " sent you a gift", body: "Open Roamerica to see it.", tag: "gift" }, "text");
      else if (type === "meet") await notify(store, to, { title: from + " wants to meet up", body: "Open Roamerica to go meet them.", tag: "meet" }, "text");
      else if (type === "visit") { const vm = String(b.msg || ""); const VT = { "sleep|": [" wants to sleep over", "Open Roamerica and go home to say yes or no."], "decor|": [" wants to help decorate your home", "Open Roamerica and go home to say yes or no."], "sleepok|": [" said yes to your sleepover", "Visit their home in Roamerica to sleep over."], "decorok|": [" said yes to your decorating", "You painted their room in Roamerica."], "no|": [" said no thanks", "Maybe next time."], "ride|": [" needs a ride", "Open Roamerica to accept the ride or say no."], "rideok|": [" is on the way to pick you up", "Open Roamerica for your ride."], "rideno|": [" can't give you a ride right now", "Try a taxi or ask someone else."], "ridepay|": [" paid you for the ride", "Thanks for driving in Roamerica!"] }; const key = Object.keys(VT).find((k) => vm.startsWith(k)); const pair = key ? VT[key] : null; await notify(store, to, { title: from + (pair ? pair[0] : " rang your doorbell"), body: pair ? pair[1] : "They stopped by your home in Roamerica.", tag: "visit" }, "text"); }
      else if (type === "pay") await notify(store, to, { title: from + " sent you money", body: "$" + (parseFloat(b.msg) || 0) + " is waiting in your Roamerica bank account.", tag: "pay" }, "text");
      else if (type === "rel") { const k = String(b.msg || "").split("|")[0]; const T = { ask: "asked you out on a date!", propose: "proposed to you!", wed: "invited you to your wedding!", date: "took you on a date", kid: "adopted a child for your family", askyes: "said yes to dating you!", propyes: "said yes! You are engaged!", wedyes: "said I do! You are married!" }[k]; if (T) await notify(store, to, { title: from + " " + T, body: "Open Roamerica to see it.", tag: "rel" }, "text"); }
      else if (type === "party") await notify(store, to, { title: from + " invited you to a party", body: "Open Roamerica to go.", tag: "meet" }, "text");
      else if (type === "ride") await notify(store, to, { title: from + " offered you a ride", body: "Open Roamerica to get in.", tag: "ride" }, "text");
      else if (type === "bizinvite") await notify(store, to, { title: from, body: "Offered you a job at their shop in Roamerica", tag: "job" }, "job");
      return json({ ok: true, now });
    }
    if (b.op && b.op[0] === "_" ) {
      if (!opts.bridgeKey || b.key !== opts.bridgeKey) return json({ error: "no" }, 403);
      return json(await bridgeOp(store, b, now));
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: "server", detail: String(e && e.message || e).slice(0, 200) }, 500);
  }
};

