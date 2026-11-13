// Roamerica on Cloudflare: serves the game for free and runs live chat in one Durable Object.
// The chat logic is the same shared core the Netlify server uses (netlify-server/lib/core.mjs).
// While some players are still on the old Netlify link, a bridge copies chat, messages, and who's online
// between the two servers, so everyone can still talk to each other.
import { handle, deliverPush, b64, unb64, json, CORS } from "../netlify-server/lib/core.mjs";

const POKE_OPS = new Set(["chat", "voice", "send", "sig"]);
const TRACK = /^[cipsubn]\//;

export class Live {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB, m TEXT, t INTEGER DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS outq (k TEXT PRIMARY KEY)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS pq (id INTEGER PRIMARY KEY AUTOINCREMENT, j TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seen (k TEXT PRIMARY KEY, t INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS rq (u TEXT, tag TEXT, at INTEGER, msg TEXT, PRIMARY KEY (u, tag))");
    this.miss = new Map(); this.lastReq = 0; this.bridgeCfg = undefined;
    this.store = this.makeStore();
    this.push = (to, msg, kind, sub) => { this.sql.exec("INSERT INTO pq (j) VALUES (?)", JSON.stringify({ to, msg, kind, sub: sub || null })); this.soon(300); };
  }
  row(k) { return this.sql.exec("SELECT v, m, t FROM kv WHERE k = ?", k).toArray()[0]; }
  cfgGet(k) { const r = this.sql.exec("SELECT v FROM cfg WHERE k = ?", k).toArray()[0]; return r ? r.v : null; }
  cfgSet(k, v) { this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES (?, ?)", k, String(v)); }
  putJSON(k, val, track) {
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v, m, t) VALUES (?, ?, NULL, ?)", k, JSON.stringify(val), Number(val && val.t) || 0);
    if (track && TRACK.test(k)) this.sql.exec("INSERT OR IGNORE INTO outq (k) VALUES (?)", k);
  }
  putBin(k, bytes, meta) { this.sql.exec("INSERT OR REPLACE INTO kv (k, v, m, t) VALUES (?, ?, ?, 0)", k, bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer, JSON.stringify(meta || {})); }
  makeStore() {
    const self = this;
    const val = (r, type) => {
      if (!r) return null;
      if (type === "arrayBuffer") return r.v instanceof ArrayBuffer ? r.v : new TextEncoder().encode(String(r.v)).buffer;
      try { return JSON.parse(typeof r.v === "string" ? r.v : new TextDecoder().decode(r.v)); } catch { return null; }
    };
    return {
      async get(k, o = {}) { let r = self.row(k); if (!r && /^[ksv]\//.test(k)) { await self.lazy(k); r = self.row(k); } return val(r, o.type); },
      async getWithMetadata(k, o = {}) { let r = self.row(k); if (!r && /^v\//.test(k)) { await self.lazy(k); r = self.row(k); } if (!r) return null; return { data: val(r, o.type), metadata: r.m ? JSON.parse(r.m) : {} }; },
      async set(k, bytes, o = {}) { self.putBin(k, bytes, o.metadata); },
      async setJSON(k, v, o = {}) { if (o.onlyIfNew && self.row(k)) return; self.putJSON(k, v, true); },
      async list({ prefix }) { return { blobs: self.sql.exec("SELECT k FROM kv WHERE k >= ? AND k < ?", prefix, prefix + "￿").toArray().map((r) => ({ key: r.k })) }; },
      async delete(k) { self.sql.exec("DELETE FROM kv WHERE k = ?", k); },
    };
  }

  // ---- bridge to the Netlify server ----
  async bridge() {
    if (this.bridgeCfg !== undefined) return this.bridgeCfg;
    this.bridgeCfg = null;
    try {
      if (this.cfgGet("bridge_off") === "1") return null;
      if (this.env.DB) { const r = await this.env.DB.prepare("SELECT v FROM cfg WHERE k = 'bridge'").first(); if (r && r.v) { const c = JSON.parse(r.v); if (c.url && c.key && !c.off) this.bridgeCfg = c; } }
    } catch {}
    return this.bridgeCfg;
  }
  async call(body) {
    const c = await this.bridge(); if (!c) return null;
    const r = await fetch(c.url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ ...body, key: c.key }) });
    if (!r.ok) throw new Error("bridge " + r.status);
    return r.json();
  }
  importItem(it, now) {
    const k = String(it.k || "");
    if (it.vd && it.v && it.v.vkey && /^v\//.test(it.v.vkey) && !this.row(it.v.vkey)) this.putBin(it.v.vkey, unb64(it.vd), { mime: it.vm || "audio/mp4" });
    if (k.startsWith("v/") && it.vd) { if (!this.row(k)) this.putBin(k, unb64(it.vd), { mime: it.vm || "audio/mp4" }); return false; }
    if (!it.v || !/^[cipsubnk]\//.test(k)) return false;
    if (k.startsWith("p/")) { if (now - it.v.t < 45000) this.putJSON(k, { ...it.v, t: now, br: 1 }, false); return false; }
    const ex = this.row(k);
    if (/^[ci]\//.test(k)) { // copy under the arrival time so players who already checked still get it
      if (ex || it.v.br || this.sql.exec("SELECT 1 FROM seen WHERE k = ?", k).toArray().length) return false;
      const nk = k.startsWith("c/") ? `c/${String(now).padStart(14, "0")}-${k.split("-").pop()}` : `i/${k.split("/")[1]}/${String(now).padStart(14, "0")}-${k.split("-").pop()}`;
      this.putJSON(nk, { ...it.v, br: 1 }, false); this.sql.exec("INSERT OR REPLACE INTO seen (k, t) VALUES (?, ?)", k, now);
      if (Math.random() < 0.05) this.sql.exec("DELETE FROM seen WHERE t < ?", now - 2 * 864e5);
      return true;
    }
    if (!ex || (Number(it.v.t) || 0) > (ex.t || 0)) this.putJSON(k, it.v, false);
    return false;
  }
  async lazy(k) {
    const c = await this.bridge(); if (!c) return;
    const m = this.miss.get(k); if (m && Date.now() - m < 600000) return;
    try { const r = await this.call({ op: "_g", keys: [k] }); const now = Date.now(); for (const it of (r && r.items) || []) this.importItem(it, now); } catch {}
    if (!this.row(k)) this.miss.set(k, Date.now());
  }
  async bridgeTick(now) {
    const c = await this.bridge(); if (!c) return;
    // 1) bring in new chat lines, messages, and who's online from Netlify
    const cur = Number(this.cfgGet("netcur")) || now - 120000;
    const r = await this.call({ op: "_x", cur });
    let fresh = false;
    for (const it of (r && r.items) || []) if (this.importItem(it, now)) fresh = true;
    if (r && r.now) this.cfgSet("netcur", r.now - 5000);
    if (fresh) this.poke();
    // 2) send what Cloudflare players wrote since last time
    const keys = this.sql.exec("SELECT k FROM outq LIMIT 150").toArray().map((x) => x.k);
    if (keys.length) {
      const items = []; let size = 0; const sent = [];
      for (const k of keys) {
        const rw = this.row(k); sent.push(k); if (!rw) continue;
        const v = JSON.parse(typeof rw.v === "string" ? rw.v : new TextDecoder().decode(rw.v));
        const it = { k, v }; const sz = (typeof rw.v === "string" ? rw.v.length : 1000);
        if (v && v.vkey) { const vr = this.row(v.vkey); if (vr && vr.v instanceof ArrayBuffer && vr.v.byteLength < 1100000) { it.vd = b64(vr.v); it.vm = (vr.m && JSON.parse(vr.m).mime) || "audio/mp4"; size += it.vd.length; } }
        items.push(it); size += sz; if (size > 2.5e6) break;
      }
      const res = await this.call({ op: "_i", items });
      if (res && res.ok) for (const k of sent) this.sql.exec("DELETE FROM outq WHERE k = ?", k);
    }
    // 3) every 10 minutes, catch up saved games, profiles, shops, and notification sign-ups
    const last = Number(this.cfgGet("bulk")) || 0;
    if (now - last > 600000) {
      const l = await this.call({ op: "_l" });
      const need = [];
      for (const [k, t] of (l && l.keys) || []) { const ex = this.row(k); if (!ex || t > (ex.t || 0)) need.push(k); }
      this.cfgSet("bulkneed", JSON.stringify(need)); this.cfgSet("bulk", now);
    }
    const need = JSON.parse(this.cfgGet("bulkneed") || "[]");
    if (need.length) {
      const batch = need.slice(0, 6);
      const g = await this.call({ op: "_g", keys: batch });
      for (const it of (g && g.items) || []) this.importItem(it, now);
      this.cfgSet("bulkneed", JSON.stringify(need.slice(batch.length)));
    }
  }

  // ---- timers: send notifications a few at a time, and run the bridge while players are on ----
  soon(ms) { this.ctx.storage.getAlarm().then((a) => { const at = Date.now() + ms; if (!a || a > at) this.ctx.storage.setAlarm(at); }).catch(() => {}); }
  async alarm() {
    const now = Date.now();
    try { this.dueReminders(now); } catch {}
    const jobs = this.sql.exec("SELECT id, j FROM pq ORDER BY id LIMIT 8").toArray();
    for (const j of jobs) { this.sql.exec("DELETE FROM pq WHERE id = ?", j.id); try { const x = JSON.parse(j.j); await deliverPush(this.store, x.to, x.msg, x.kind, x.sub); } catch {} }
    const more = this.sql.exec("SELECT COUNT(*) AS n FROM pq").one().n > 0;
    const active = now - (Number(this.cfgGet("lastreq")) || 0) < 180000;
    let next = null;
    if (active) {
      const lastB = Number(this.cfgGet("lastbridge")) || 0;
      if (now - lastB >= 20000) { this.cfgSet("lastbridge", now); try { await this.bridgeTick(now); } catch {} }
      next = now + 20000;
      if (JSON.parse(this.cfgGet("bulkneed") || "[]").length) next = now + 3000;
    }
    if (more) next = now + 1000;
    try { const r = this.sql.exec("SELECT MIN(at) AS a FROM rq").one(); if (r && r.a && (!next || r.a < next)) next = Math.max(now + 1000, r.a); } catch {}
    if (next) await this.ctx.storage.setAlarm(next);
  }
  touch() {
    const now = Date.now();
    if (now - this.lastReq > 15000) { this.lastReq = now; this.cfgSet("lastreq", now); this.soon(1500); }
  }
  poke() { for (const ws of this.ctx.getWebSockets()) { try { ws.send('{"poke":1}'); } catch {} } }

  // ---- scheduled reminders, like "your pet is hungry", sent as notifications when they come due ----
  remind(b) {
    const u = String(b.nm || "").trim().toLowerCase().slice(0, 40); if (!u) return json({ error: "bad" }, 400);
    const now = Date.now(); this.sql.exec("DELETE FROM rq WHERE u = ?", u);
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 12)) {
      const at = Number(it.at) || 0; if (at < now || at > now + 31 * 864e5) continue;
      const msg = { title: String(it.title || "Roamerica").slice(0, 60), body: String(it.body || "").replace(/[<>]/g, "").slice(0, 200), tag: String(it.tag || "r").slice(0, 20) };
      this.sql.exec("INSERT OR REPLACE INTO rq (u, tag, at, msg) VALUES (?, ?, ?, ?)", u, msg.tag, at, JSON.stringify(msg));
    }
    this.armReminders(); return json({ ok: true });
  }
  armReminders() { const r = this.sql.exec("SELECT MIN(at) AS a FROM rq").one(); if (r && r.a) this.soon(Math.max(1000, r.a - Date.now())); }
  dueReminders(now) {
    const due = this.sql.exec("SELECT u, tag, msg FROM rq WHERE at <= ? LIMIT 20", now).toArray();
    for (const d of due) { this.sql.exec("DELETE FROM rq WHERE u = ? AND tag = ?", d.u, d.tag); try { this.push(d.u, JSON.parse(d.msg), "pet"); } catch {} }
  }

  async run(bodyText) {
    let op = ""; try { op = JSON.parse(bodyText).op || ""; } catch {}
    if (op === "remind") { try { return this.remind(JSON.parse(bodyText)); } catch { return json({ error: "bad" }, 400); } }
    const res = await handle(new Request("https://live/api/live", { method: "POST", body: bodyText }), this.store, { push: this.push });
    if (POKE_OPS.has(op) && res.status === 200) this.poke();
    return res;
  }
  async fetch(req) {
    this.touch();
    const u = new URL(req.url);
    if (u.pathname === "/api/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426, headers: CORS });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (u.searchParams.get("bridge") === "off" && req.method === "POST") { const c = await this.bridge(); if (c && (await req.text()) === c.key) { this.cfgSet("bridge_off", "1"); this.bridgeCfg = null; return json({ ok: true }); } return json({ ok: false }, 403); }
    if (req.method !== "POST") return handle(req, this.store, { push: this.push });
    return this.run(await req.text());
  }
  async webSocketMessage(ws, data) {
    this.touch();
    let m; try { m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)); } catch { return; }
    if (m.ping) { ws.send('{"pong":1}'); return; }
    if (m.id == null || !m.b) return;
    let s = 500, t = '{"error":"server"}';
    try { const res = await this.run(JSON.stringify(m.b)); s = res.status; t = await res.text(); } catch {}
    try { ws.send(`{"id":${JSON.stringify(m.id)},"s":${s},"r":${t}}`); } catch {}
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {} }
  async webSocketError() {}
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/live" || u.pathname === "/api/ws") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      return env.LIVE.get(env.LIVE.idFromName("main")).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
