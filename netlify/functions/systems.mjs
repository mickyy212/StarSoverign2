// Shared "Systems" galaxy for Star Sovereign II: up to 5 players, one star system each.
// GET    /api/systems                -> { systems: [public view of every system] }
// POST   /api/systems  {id, sys}     -> saves this device's system; returns { pid, slot }
// DELETE /api/systems  {id}          -> removes this device's system (frees the slot)
// Each device keeps a secret id. Others only ever see a short public id (pid) derived from it,
// so nobody can overwrite someone else's system.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const MAX_PLAYERS = 5;
const RES = ["food", "water", "ore", "fuel", "crystal"];
const pidOf = (id) => createHash("sha256").update("ss2:" + id).digest("hex").slice(0, 12);
const cleanId = (v) => String(v || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
const int = (v, lo, hi) => Math.min(Math.max(parseInt(v, 10) || 0, lo), hi);
const pidList = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).replace(/[^a-f0-9]/g, "").slice(0, 12)).filter(Boolean).slice(0, 8);

function cleanSys(s, pid, slot) {
  s = s || {};
  const res = {};
  for (const r of RES) res[r] = int(s.res && s.res[r], 0, 1e6);
  const planets = (Array.isArray(s.planets) ? s.planets : []).slice(0, 6).map((p) => ({
    n: String(p.n || "").replace(/[^A-Za-z0-9 '-]/g, "").slice(0, 20),
    r: RES.includes(p.r) ? p.r : "food",
    st: ["home", "unknown", "explored", "colony"].includes(p.st) ? p.st : "unknown",
  }));
  const routes = (Array.isArray(s.routes) ? s.routes : []).slice(0, 8).map((t) => ({
    rid: String(t.rid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
    to: pidList([t.to])[0] || "",
    a: { r: RES.includes(t.a && t.a.r) ? t.a.r : "food", n: int(t.a && t.a.n, 1, 9) },
    b: { r: RES.includes(t.b && t.b.r) ? t.b.r : "food", n: int(t.b && t.b.n, 1, 9) },
  })).filter((t) => t.rid && t.to);
  return {
    pid, slot,
    name: String(s.name || "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 12) || "UNKNOWN",
    age: int(s.age, 0, 1e6), pop: int(s.pop, 0, 1e5), unrest: int(s.unrest, 0, 100),
    credits: int(s.credits, 0, 1e7), res, planets, routes,
    allies: pidList(s.allies),
    accepted: (Array.isArray(s.accepted) ? s.accepted : []).map((x) => String(x).replace(/[^A-Za-z0-9]/g, "").slice(0, 16)).slice(0, 16),
    updated: Date.now(),
  };
}

export default async (req) => {
  const store = getStore("systems");
  const headers = { "Cache-Control": "no-store" };
  const all = async () => {
    const { blobs } = await store.list();
    return (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
  };

  if (req.method === "GET") return Response.json({ systems: await all(), max: MAX_PLAYERS }, { headers });

  let body;
  try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const id = cleanId(body.id);
  if (id.length < 8) return new Response("Bad request", { status: 400 });
  const pid = pidOf(id);

  if (req.method === "DELETE") { await store.delete(pid); return Response.json({ ok: true }, { headers }); }

  if (req.method === "POST") {
    const existing = await store.get(pid, { type: "json" });
    let slot = existing ? existing.slot : -1;
    if (slot < 0) {
      const taken = new Set((await all()).map((s) => s.slot));
      for (let i = 0; i < MAX_PLAYERS; i++) if (!taken.has(i)) { slot = i; break; }
      if (slot < 0) return Response.json({ full: true }, { status: 409, headers });
    }
    await store.setJSON(pid, cleanSys(body.sys, pid, slot));
    return Response.json({ pid, slot }, { headers });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/systems" };
