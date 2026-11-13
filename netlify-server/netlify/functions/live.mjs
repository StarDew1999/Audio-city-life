import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const clean = (s, n = 200) => String(s == null ? "" : s).replace(/[<>]/g, "").trim().slice(0, n);
const low = (s) => clean(s, 40).toLowerCase().replace(/[^a-z0-9 _.-]/g, "").replace(/\s+/g, "_");
const pad = (t) => String(t).padStart(14, "0");
const rid = () => Math.random().toString(36).slice(2, 8);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });


const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function vapidKeys(store) {
  let k = await store.get("k/vapid", { type: "json" });
  if (!k) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    k = { jwk, pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
    await store.setJSON("k/vapid", k, { onlyIfNew: true }).catch(() => {});
    k = (await store.get("k/vapid", { type: "json" })) || k;
  }
  return k;
}
export function encryptPush(payload, p256dh, auth) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}
async function sendPush(store, to, msg, kind, subIn) {
  try {
    const sub = subIn || await store.get(`n/${to}`, { type: "json" });
    if (!sub || !sub.endpoint || !sub.keys) return;
    if (kind && sub.prefs && sub.prefs[kind] === false) return;
    const k = await vapidKeys(store);
    const aud = new URL(sub.endpoint).origin;
    const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://audio-city-life.netlify.app" }));
    const key = crypto.createPrivateKey({ key: k.jwk, format: "jwk" });
    const sig = crypto.sign("sha256", Buffer.from(head + "." + claims), { key, dsaEncoding: "ieee-p1363" });
    const body = encryptPush(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth);
    const r = await fetch(sub.endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${head}.${claims}.${b64u(sig)}, k=${k.pub}` }, body });
    if (r.status === 404 || r.status === 410) await store.delete(`n/${to}`);
  } catch {}
}
const prefsOf = (p) => { p = p || {}; return { text: p.text !== false, call: p.call !== false, job: p.job !== false, chat: p.chat !== false }; };
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

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    const qs = new URL(req.url).searchParams, v = qs.get("v");
    if (qs.get("vapid")) { const k = await vapidKeys(getStore({ name: "live", consistency: "strong" })); return json({ key: k.pub }); }
    if (v && /^v\/[0-9]{14}-[a-z0-9]{1,8}$/.test(v)) {
      const store = getStore({ name: "live", consistency: "strong" });
      const e = await store.getWithMetadata(v, { type: "arrayBuffer" });
      if (e === null) return new Response("gone", { status: 404, headers: CORS });
      return new Response(e.data, { headers: { "content-type": (e.metadata && e.metadata.mime) || "audio/mp4", "cache-control": "public, max-age=604800", ...CORS } });
    }
    return json({ ok: true, hello: "Audio City Life live service" });
  }
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const store = getStore({ name: "live", consistency: "strong" });
  const now = Date.now();
  try {
    if (b.op === "sync") {
      const id = clean(b.id, 40), nm = clean(b.nm, 40), at = clean(b.at, 40), me = low(nm);
      if (nm && b.prof && typeof b.prof === "object") { try { const pf = JSON.parse(JSON.stringify(b.prof).slice(0, 4000)); await store.setJSON(`u/${me}`, { ...pf, t: now }); } catch {} }
      if (id && nm) await store.setJSON(`p/${id}`, { nm, at, t: now, vc: b.vc ? 1 : 0, hid: b.hid ? 1 : 0 });
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
        try { const vb = await store.list({ prefix: "v/" }); old.push(...vb.blobs.map((x) => x.key).filter((k) => now - Number(k.slice(2, 16)) > 7 * 864e5)); } catch {}
        await Promise.all(old.slice(0, 100).map((k) => store.delete(k)));
      }
      return json({ now, players: pres.map(({ id, nm, at, vc }) => ({ id, nm, at, vc: vc ? 1 : 0 })), chat, inbox, sig });
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
      await store.set(vkey, Buffer.from(data, "base64"), { metadata: { mime } });
      const secs = Math.max(1, Math.min(30, Number(b.secs) || 0));
      if (b.to) {
        const to = low(b.to);
        await store.setJSON(`i/${to}/${pad(now)}-${rid()}`, { from: clean(b.nm, 40), type: b.kind === "call" ? "cl" : "text", msg: "", vkey, secs });
        if (b.kind !== "call") await notify(store, to, { title: clean(b.nm, 40), body: "Sent you a voice message in Audio City Life", tag: "t-" + low(b.nm) }, "text");
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
      const code = crypto.randomBytes(9).toString("hex");
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
      await store.setJSON(`n/${u}`, { endpoint: String(sub.endpoint).slice(0, 800), keys: { p256dh: clean(sub.keys.p256dh, 200), auth: clean(sub.keys.auth, 100) }, prefs: prefsOf(b.prefs) });
      return json({ ok: true });
    }
    if (b.op === "pushprefs") { const u = low(b.nm); const cur = u && await store.get(`n/${u}`, { type: "json" }); if (cur) { cur.prefs = prefsOf(b.prefs); await store.setJSON(`n/${u}`, cur); } return json({ ok: !!cur }); }
    if (b.op === "pushoff") { const u = low(b.nm); if (u) await store.delete(`n/${u}`); return json({ ok: true }); }
    if (b.op === "profile") { const u = low(b.nm); const prof = u ? await store.get(`u/${u}`, { type: "json" }) : null; return json({ ok: !!prof, prof }); }
    if (b.op === "send") {
      const to = low(b.to); if (!to) return json({ error: "no recipient" }, 400);
      const type = ["text", "call", "cl", "bizpay", "bizinvite", "pay", "gift", "meet", "visit", "dm"].includes(b.type) ? b.type : "text";
      await store.setJSON(`i/${to}/${pad(now)}-${rid()}`, { from: clean(b.from, 40), type, msg: clean(b.msg, 5000), st: clean(b.st, 10), cid: clean(b.cid, 20) });
      const from = clean(b.from, 40);
      if (type === "text") await notify(store, to, { title: from, body: clean(b.msg, 120), tag: "t-" + low(from) }, "text");
      else if (type === "call" && b.st === "ring") await notify(store, to, { title: from + " is calling you", body: "Open Audio City Life to answer.", tag: "call" }, "call");
      else if (type === "dm") await notify(store, to, { title: "Private message from " + from, body: clean(b.msg, 120), tag: "dm-" + low(from) }, "text");
      else if (type === "gift") await notify(store, to, { title: from + " sent you a gift", body: "Open Audio City Life to see it.", tag: "gift" }, "text");
      else if (type === "meet") await notify(store, to, { title: from + " wants to meet up", body: "Open Audio City Life to go meet them.", tag: "meet" }, "text");
      else if (type === "visit") await notify(store, to, { title: from + " rang your doorbell", body: "They stopped by your home in Audio City Life.", tag: "visit" }, "text");
      else if (type === "pay") await notify(store, to, { title: from + " sent you money", body: "$" + (parseFloat(b.msg) || 0) + " is waiting in your Audio City Life bank account.", tag: "pay" }, "text");
      else if (type === "bizinvite") await notify(store, to, { title: from, body: "Offered you a job at their shop in Audio City Life", tag: "job" }, "job");
      return json({ ok: true, now });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: "server", detail: String(e && e.message || e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/live" };
