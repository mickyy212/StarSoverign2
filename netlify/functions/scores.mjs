// Shared scoreboard for Star Sovereign II. The server is the bank: each device's latest 20 runs are kept in
// Netlify Blobs (store "scoreboard"), which outlive every deploy, and only the admin can clear them.
// GET    /api/scores?me=<deviceId>            -> {rows:[{name, life, runs, me}], clearedAt}
// POST   /api/scores {id, name, runs:[{m,d,w,t}]} -> adds new runs (by time, no duplicates), keeps the latest 20
// POST   /api/scores {id, name}               -> renames
// POST   /api/scores {op:"clear", pass}       -> admin: clears the whole scoreboard (admin password from the Systems admin)
// DELETE /api/scores {id}                     -> removes this device from the scoreboard
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const DIFFS = ["Easy", "Normal", "Hard"], KEEP = 20;
const pidOf = (id) => createHash("sha256").update("ss2:" + id).digest("hex").slice(0, 12);
const hashPass = (pw) => pidOf("admin-pass:" + pw);
const cleanRun = (r) => ({ m: r && r.m === "dlc" ? "dlc" : "main", d: DIFFS.includes(r && r.d) ? r.d : "Normal", w: r && r.w ? 1 : 0, t: Math.min(Math.max(parseInt(r && r.t, 10) || 0, 0), 9e12) });
// win/played per mode and difficulty, from the latest runs
const lifeOf = (runs) => { const z = () => ({ Easy: { w: 0, n: 0 }, Normal: { w: 0, n: 0 }, Hard: { w: 0, n: 0 } }), o = { main: z(), dlc: z() };
  for (const r of runs) { o[r.m][r.d].n++; o[r.m][r.d].w += r.w; } return o; };
const cleanId = (v) => String(v || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);

export default async (req) => {
  const store = getStore("scoreboard");
  const headers = { "Cache-Control": "no-store" };
  const meta = (await store.get("_meta", { type: "json" })) || { clearedAt: 0 };

  if (req.method === "GET") {
    const me = new URL(req.url).searchParams.get("me") || "";
    const { blobs } = await store.list();
    const rows = await Promise.all(blobs.filter((b) => b.key !== "_meta").map(async (b) => {
      const r = await store.get(b.key, { type: "json" }); if (!r) return null;
      const runs = Array.isArray(r.runs) ? r.runs : null;
      // records from before the 20-run board keep their old totals until that device finishes a new run
      return { name: r.name, life: runs ? lifeOf(runs) : r.life, runs: runs ? runs.length : null, me: b.key === me };
    }));
    return Response.json({ rows: rows.filter(Boolean), clearedAt: meta.clearedAt || 0, keep: KEEP }, { headers });
  }

  if (req.method === "POST") {
    let body; try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    if (body.op === "clear") { // admin only: same password as the Systems admin (default 1234)
      const sys = getStore("systems"), now = Date.now();
      const adm = (await sys.get("admin", { type: "json" })) || { pass: hashPass("1234"), fails: [] };
      adm.fails = (adm.fails || []).filter((t) => now - t < 10 * 60000);
      if (adm.fails.length >= 5) return Response.json({ ok: false, msg: "Too many wrong passwords. Try again in 10 minutes." }, { headers });
      if (hashPass(String(body.pass || "").slice(0, 40)) !== adm.pass) { adm.fails.push(now); await sys.setJSON("admin", adm); return Response.json({ ok: false, msg: "Wrong password." }, { headers }); }
      const { blobs } = await store.list(); for (const b of blobs) await store.delete(b.key);
      await store.setJSON("_meta", { clearedAt: now });
      return Response.json({ ok: true, msg: "The scoreboard was cleared.", clearedAt: now }, { headers });
    }
    const id = cleanId(body.id), name = String(body.name || "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 12);
    if (id.length < 8 || name.length < 2) return new Response("Bad request", { status: 400 });
    const rec = (await store.get(id, { type: "json" })) || { name, runs: [] };
    if (!Array.isArray(rec.runs)) rec.runs = []; // an old lifetime-only record starts its 20-run history now
    const seen = new Set(rec.runs.map((r) => r.t));
    // runs finished before the last clear don't come back
    const add = (Array.isArray(body.runs) ? body.runs : []).slice(-KEEP).map(cleanRun).filter((r) => r.t > (meta.clearedAt || 0) && !seen.has(r.t));
    rec.runs = [...rec.runs, ...add].sort((a, b) => a.t - b.t).slice(-KEEP);
    rec.name = name; rec.updated = Date.now(); delete rec.life;
    if (rec.runs.length || (await store.get(id, { type: "json" }))) await store.setJSON(id, rec);
    return Response.json({ ok: true, runs: rec.runs.length, clearedAt: meta.clearedAt || 0 }, { headers });
  }

  if (req.method === "DELETE") {
    let body; try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    const id = cleanId(body.id); if (id.length < 8) return new Response("Bad request", { status: 400 });
    await store.delete(id);
    return Response.json({ ok: true }, { headers });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/scores" };
