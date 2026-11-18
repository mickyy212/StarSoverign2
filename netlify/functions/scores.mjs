// Shared scoreboard for Star Sovereign II.
// GET  /api/scores?me=<deviceId>  -> list of {name, life, me}
// POST /api/scores  {id, name, life} -> saves this device's lifetime record
import { getStore } from "@netlify/blobs";

const DIFFS = ["Easy", "Normal", "Hard"];
const clean = (life) => {
  const out = {};
  for (const mode of ["main", "dlc"]) {
    out[mode] = {};
    for (const d of DIFFS) {
      const r = (life && life[mode] && life[mode][d]) || {};
      const n = Math.min(Math.max(parseInt(r.n, 10) || 0, 0), 100000);
      const w = Math.min(Math.max(parseInt(r.w, 10) || 0, 0), n);
      out[mode][d] = { w, n };
    }
  }
  return out;
};

export default async (req) => {
  const store = getStore("scoreboard");
  const headers = { "Cache-Control": "no-store" };

  if (req.method === "GET") {
    const me = new URL(req.url).searchParams.get("me") || "";
    const { blobs } = await store.list();
    const rows = await Promise.all(
      blobs.map(async (b) => {
        const r = await store.get(b.key, { type: "json" });
        return r ? { name: r.name, life: r.life, me: b.key === me } : null;
      })
    );
    return Response.json(rows.filter(Boolean), { headers });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    const id = String(body.id || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
    const name = String(body.name || "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 12);
    if (id.length < 8 || name.length < 2) return new Response("Bad request", { status: 400 });
    await store.setJSON(id, { name, life: clean(body.life), updated: Date.now() });
    return Response.json({ ok: true }, { headers });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/scores" };
