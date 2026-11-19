// Shared "Systems" galaxy for Star Sovereign II: up to 5 player systems and 3 AI empires.
// War is real time. Every faction has one fleet under an admiral. Once war is declared, fleets move,
// meet and fight on their own; winners siege enemy worlds (a dice roll every 30 seconds, after EU4).
// The AI empires stand together. Hostile ones wait until a player's fleet nears theirs, threaten, then strike.
// Any AI war against a player pulls the other AIs in. Every few days the AIs invade a player together,
// until players annex or vassalize every AI empire and end the scourge.
// All calls: POST /api/systems {id, op, ...}
//   sync {sys?}            save my system (unless news is waiting); get galaxy, wars, my inbox
//   leave                  remove my system
//   war {target}           declare war on a player pid or an AI id
//   join {war}             join an ally's side
//   build {ship}           add a ship to my fleet (client has paid)
//   upgrade {ship}         next upgrade tier for a ship type (client has paid)
//   peace {war, term, target, planet?, want?}   white | claim | reparations | claimrep | claims | vassal | annex
//   ai {ai, act, res?}     envoy | gift | ally | unally
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const MAX = 5, HOUR = 3600000, STEP = 5000, SIEGE = 30000, TRAVEL = 10000, MAX_STEPS = 1440;
const COMMON = ["food", "water", "ore", "fuel"], RARE = ["crystal", "plasma", "spice", "alloy", "relic"], RES = [...COMMON, ...RARE];
// Base ship stats and the three upgrades per ship type (each improves 1 to 3 stats).
const SHIP = { c: { atk: 1, hull: 2, siege: 0 }, f: { atk: 3, hull: 5, siege: 1 }, d: { atk: 8, hull: 14, siege: 2 } };
const UPG = {
  c: [{ atk: 1 }, { hull: 1, atk: 1 }, { atk: 1, hull: 1, siege: 1 }],
  f: [{ atk: 2 }, { hull: 3 }, { atk: 1, hull: 2, siege: 2 }],
  d: [{ atk: 4 }, { hull: 8 }, { atk: 2, hull: 4, siege: 3 }],
};
const TERMS = { white: 0, claim: 45, reparations: 45, claimrep: 90, claims: 80, vassal: 80, annex: 100 };
const FORT = { home: 3, colony: 1 }, HOME_FIRE = { player: 10, ai: 8 };
const START_FLEET = { c: 3, f: 1, d: 0 }; // every new player starts with a small fleet (attack 6: about half an AI fleet)
const THREAT_AT = 0.8, THREAT_WAIT = 2, FIRST_INVASION = 72, INVASION_EVERY = 48, WARN = 12, JOIN_ODDS = { aggressive: 1, wary: 0.7, merchant: 0.4 };
const AI_DEF = [
  { id: "ai0", name: "Zhaal Brood", temper: "aggressive", base: -30, admiral: "Swarm-Marshal Grisk the Devourer", ships: { c: 6, f: 2, d: 0 }, planets: [["Gorr", "food"], ["Skarn", "ore"], ["Vex", "fuel"]] },
  { id: "ai1", name: "Ost Guild", temper: "merchant", base: 20, admiral: "Commodore Penhallow of the Gilded Fleet", ships: { c: 3, f: 2, d: 0 }, planets: [["Ostra", "water"], ["Penny", "food"], ["Tallow", "fuel"]] },
  { id: "ai2", name: "Silent Vigil", temper: "wary", base: 0, admiral: "Warden-Admiral Sael, Who Does Not Blink", ships: { c: 4, f: 2, d: 1 }, planets: [["Mute", "ore"], ["Hush", "water"], ["Stillwater", "food"]] },
];
// Generals: a player's leader commands the fleet and earns renown. Promotions at these totals each add one doctrine.
const RANKS = ["Captain", "Commodore", "Admiral", "Grand Admiral"], PROMOTE = [40, 120, 300];
const DOCTRINE = { atk: { atk: 0.05 }, siege: { siege: 0.10, guard: 0.05 } };
const tierOf = (renown) => PROMOTE.filter((n) => (renown || 0) >= n).length;
const ADM_FIRST = ["Kaela", "Oru", "Vexa", "Dorn", "Ilsa", "Tarek", "Mira", "Sol", "Brannoch", "Quell", "Ysolde", "Harrow"];
const ADM_LAST = ["Voss", "Thane", "Kade", "Morrow", "Ashgrave", "Rhyne", "Calder", "Nightwell", "Strand", "Vire"];
const ADM_EPI = ["the Unbroken", "Breaker of Moons", "the Last Light", "Who Burned the Tide", "of the Silent Guns", "the Iron Comet", "Storm-Born", "the Patient Blade"];
const pidOf = (id) => createHash("sha256").update("ss2:" + id).digest("hex").slice(0, 12);
const cleanId = (v) => String(v || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
const int = (v, lo, hi) => Math.min(Math.max(parseInt(v, 10) || 0, lo), hi);
const ref = (v) => String(v || "").replace(/[^a-z0-9]/g, "").slice(0, 12);
const txt = (v, n) => String(v || "").replace(/[^A-Za-z0-9 '-]/g, "").trim().slice(0, n);
const isAI = (x) => /^ai\d$/.test(x);
const hashNum = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const admiralFor = (pid) => { const h = hashNum(pid); return `Admiral ${ADM_FIRST[h % 12]} ${ADM_LAST[(h >>> 4) % 10]}, ${ADM_EPI[(h >>> 8) % 8]}`; };
const newFleet = (admiral, ships) => ({ admiral, ships: { c: 0, f: 0, d: 0, ...(ships || {}) }, dmg: { c: 0, f: 0, d: 0 }, up: { c: 0, f: 0, d: 0 }, loc: { s: "dock" } });
const shipStat = (fl, k, s) => UPG[k].slice(0, fl.up[k] || 0).reduce((a, u) => a + (u[s] || 0), SHIP[k][s]);
const power = (fl) => ["c", "f", "d"].reduce((a, k) => a + fl.ships[k] * shipStat(fl, k, "atk"), 0) * (1 + ((fl.buff || {}).atk || 0));
const hull = (fl) => ["c", "f", "d"].reduce((a, k) => a + fl.ships[k] * shipStat(fl, k, "hull"), 0) - (fl.dmg.c + fl.dmg.f + fl.dmg.d);
const siegeBonus = (fl) => Math.min(3, Math.floor(["c", "f", "d"].reduce((a, k) => a + fl.ships[k] * shipStat(fl, k, "siege"), 0) * (1 + ((fl.buff || {}).siege || 0)) / 6));
const alive = (fl) => fl && fl.ships.c + fl.ships.f + fl.ships.d > 0;
const luck = () => 0.85 + Math.random() * 0.3;
// Spread damage over ship types by their share of hull; whole ships are lost as damage passes their hull.
function hurt(fl, amount) {
  const tot = ["c", "f", "d"].reduce((a, k) => a + fl.ships[k] * shipStat(fl, k, "hull"), 0); if (!tot) return;
  for (const k of ["c", "f", "d"]) {
    if (!fl.ships[k]) continue;
    fl.dmg[k] += amount * (fl.ships[k] * shipStat(fl, k, "hull")) / tot;
    const h = shipStat(fl, k, "hull");
    while (fl.ships[k] > 0 && fl.dmg[k] >= h) { fl.ships[k]--; fl.dmg[k] -= h; }
    if (!fl.ships[k]) fl.dmg[k] = 0;
  }
}

function cleanSys(s, pid, slot, prev) {
  s = s || {};
  const res = {}; for (const r of RES) res[r] = int(s.res && s.res[r], 0, 1e6);
  const planets = (Array.isArray(s.planets) ? s.planets : []).slice(0, 12).map((p) => ({
    n: txt(p.n, 20) || "World", r: RES.includes(p.r) ? p.r : "food",
    st: ["home", "unknown", "explored", "colony"].includes(p.st) ? p.st : "unknown", from: ref(p.from) || undefined, def: int(p.def, 0, 3), age: p.age == null ? undefined : int(p.age, 0, 1e6) }));
  const routes = (Array.isArray(s.routes) ? s.routes : []).slice(0, 8).map((t) => ({
    rid: String(t.rid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16), to: ref(t.to),
    a: { r: RES.includes(t.a && t.a.r) ? t.a.r : "food", n: int(t.a && t.a.n, 1, 9) },
    b: { r: RES.includes(t.b && t.b.r) ? t.b.r : "food", n: int(t.b && t.b.n, 1, 9) } })).filter((t) => t.rid && t.to);
  return { pid, slot, name: String(s.name || "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 12) || "UNKNOWN", sysName: txt(s.sysName, 16) || "",
    age: int(s.age, 0, 1e6), dev: int(s.dev, 0, 3), swarm: int(s.swarm, 0, 4), pop: int(s.pop, 0, 1e5), unrest: int(s.unrest, 0, 100), res, planets, routes,
    allies: (Array.isArray(s.allies) ? s.allies : []).map(ref).filter(Boolean).slice(0, 10),
    accepted: (Array.isArray(s.accepted) ? s.accepted : []).map((x) => String(x).replace(/[^A-Za-z0-9]/g, "").slice(0, 16)).slice(0, 16),
    spec: RES.includes(s.spec) ? s.spec : undefined, evAt: int(s.evAt, 0, 9e12) || undefined,
    leader: s.leader ? { name: txt(s.leader.name, 20), title: txt(s.leader.title, 24),
      look: Object.fromEntries(Object.entries(s.leader.look || {}).slice(0, 10).map(([k, v]) => [String(k).replace(/[^a-z]/g, "").slice(0, 8), String(v).replace(/[^A-Za-z]/g, "").slice(0, 12)])) } : undefined, born: int(s.born, 0, 9e12) || undefined,
    ships: int(s.ships, 0, 99), boost: { food: int(s.boost && s.boost.food, 0, 99), water: int(s.boost && s.boost.water, 0, 99), spec: int(s.boost && s.boost.spec, 0, 199) },
    proj: s.proj && ["dev", "swarm"].includes(s.proj.kind) ? { kind: s.proj.kind, left: int(s.proj.left, 0, 99), n: txt(s.proj.n, 40) } : null,
    renown: prev ? prev.renown || 0 : 0, doctrines: prev ? prev.doctrines || [] : [],
    fleet: prev && prev.fleet ? prev.fleet : newFleet(admiralFor(pid), START_FLEET), vassalOf: prev ? prev.vassalOf || null : null, updated: Date.now() };
}
function newAI() {
  return { last: Date.now(), list: AI_DEF.map((a) => ({ id: a.id, name: a.name, temper: a.temper, base: a.base,
    planets: a.planets.map(([n, r], i) => ({ n, r, owner: null, home: i === 0 })), res: { food: 20, water: 20, ore: 20, fuel: 20 },
    fleet: newFleet(a.admiral, a.ships), opinion: {}, allies: [], overlord: null, envoyAt: {}, threat: {}, warAt: 0, buildAt: 0, annexedBy: null })), invadeAt: 0, warned: false, endedAt: 0 };
}

export default async (req) => {
  const store = getStore("systems");
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body; try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const id = cleanId(body.id); if (id.length < 8) return new Response("Bad request", { status: 400 });
  const me = pidOf(id), op = String(body.op || "sync"), now = Date.now();

  const keys = (await store.list()).blobs.map((b) => b.key);
  const players = (await Promise.all(keys.filter((k) => /^[a-f0-9]{12}$/.test(k)).map((k) => store.get(k, { type: "json" })))).filter(Boolean);
  for (const p of players) if (!p.fleet || !p.fleet.loc) p.fleet = newFleet(admiralFor(p.pid), p.fleet && p.fleet.ships);
  for (const p of players) if (/undefined/.test(p.fleet.admiral)) p.fleet.admiral = admiralFor(p.pid);
  const general = (p) => { p.renown ||= 0; p.doctrines ||= []; const b = { atk: 0, siege: 0, guard: 0 };
    for (const d of p.doctrines) for (const k in DOCTRINE[d] || {}) b[k] += DOCTRINE[d][k];
    p.fleet.buff = b; if (p.leader && p.leader.name) p.fleet.admiral = `${RANKS[p.doctrines.length]} ${p.leader.name}`; };
  for (const p of players) general(p);
  const renown = (x, n) => { const p = !isAI(x) && P(x); if (!p) return; const before = tierOf(p.renown); p.renown = Math.min(99999, (p.renown || 0) + n);
    if (tierOf(p.renown) > before) tell(x, { t: "promotion", msg: `${p.leader ? p.leader.name : "Your admiral"} has earned a promotion! Choose a doctrine on your home world.` }); };
  const P = (pid) => players.find((p) => p.pid === pid);
  let ai = (await store.get("ai", { type: "json" })) || newAI();
  { const fresh = newAI(); // upgrade old saves in place
    for (const k of ["invadeAt", "warned", "endedAt"]) if (ai[k] === undefined) ai[k] = fresh[k];
    for (const d of fresh.list) { const a = ai.list.find((x) => x.id === d.id); if (!a) { ai.list.push(d); continue; }
      for (const k in d) if (a[k] === undefined) a[k] = d[k];
      if (!a.fleet || !a.fleet.loc) a.fleet = newFleet(d.fleet.admiral, a.fleet && a.fleet.ships ? a.fleet.ships : d.fleet.ships); } }
  let wars = (await store.get("wars", { type: "json" })) || [];
  const inboxes = {};
  for (const p of players) inboxes[p.pid] = (await store.get("in-" + p.pid, { type: "json" })) || [];
  const inbox = async (pid) => (inboxes[pid] ||= []);
  const tell = (pid, ev) => { if (isAI(pid) || !P(pid)) return; (inboxes[pid] ||= []).push({ ...ev, at: now }); };
  const A = (x) => ai.list.find((a) => a.id === x);
  const F = (x) => (isAI(x) ? A(x) : P(x));
  const nameOf = (x) => { const f = F(x); return f ? (isAI(x) ? f.name : f.sysName || f.name) : "someone"; };
  const mutual = (x, y) => { const ax = F(x), ay = F(y); return !!(ax && ay && (ax.allies || []).includes(y) && (ay.allies || []).includes(x)); };
  const live = () => wars.filter((w) => !w.ended);
  const warOf = (x, y) => live().find((w) => (w.sides[0].includes(x) && w.sides[1].includes(y)) || (w.sides[1].includes(x) && w.sides[0].includes(y)));
  const sideOf = (w, x) => (w.sides[0].includes(x) ? 0 : w.sides[1].includes(x) ? 1 : -1);
  const award = (w, side, n) => { for (const x of w.sides[side]) w.score[x] = (w.score[x] || 0) + n; };
  const opinion = (a, pid, d) => { a.opinion[pid] = Math.max(-100, Math.min(100, (a.opinion[pid] ?? a.base) + d)); };
  const ev = (w, e) => { w.events.push({ ...e, t: e.t || now }); w.events = w.events.slice(-30); };
  const planetsOf = (x) => (isAI(x) ? A(x).planets.map((p, i) => ({ n: p.n, i, home: !!p.home, ok: !p.owner })) : (P(x).planets || []).map((p, i) => ({ n: p.n, i, home: p.st === "home", ok: p.st === "home" || p.st === "colony" })));
  const pdef = (owner, i) => (isAI(owner) ? 0 : ((P(owner).planets || [])[i] || {}).def || 0);
  const occupied = (w, owner, i) => w.occ.find((o) => o.owner === owner && o.i === i);

  const startWar = (x, y) => {
    let w = warOf(x, y); if (w) return w;
    w = { id: Math.random().toString(36).slice(2, 10), sides: [[x], [y]], score: {}, occ: [], siege: {}, events: [], t: now, started: now, beaten: {} };
    for (const a of ai.list) if (!a.annexedBy) { if (mutual(a.id, y) && a.id !== x) w.sides[1].push(a.id); else if (mutual(a.id, x) && a.id !== y) w.sides[0].push(a.id); }
    rally(w);
    for (const a of ai.list) for (const s of [0, 1]) if (w.sides[s].includes(a.id)) for (const p of w.sides[1 - s]) if (!isAI(p)) opinion(a, p, -40);
    wars.push(w); ev(w, { kind: "war", a: x, b: y });
    for (const s of [0, 1]) for (const f of w.sides[s]) { const fl = F(f) && F(f).fleet; if (fl && alive(fl) && fl.loc.s === "dock") fl.loc = { s: "move", from: f, to: w.sides[1 - s][0], t0: now, t1: now + TRAVEL }; }
    return w;
  };
  // The AI empires look after each other: when an AI fights a player, the other free AIs usually pile in.
  function rally(w) {
    for (const s of [0, 1]) {
      if (!w.sides[s].some(isAI) || !w.sides[1 - s].some((x) => !isAI(x))) continue;
      for (const a of ai.list) {
        if (a.annexedBy || a.overlord || w.sides.flat().includes(a.id) || warOf(a.id, w.sides[1 - s][0])) continue;
        if (w.sides[1 - s].some((p) => mutual(a.id, p) || (a.opinion[p] ?? a.base) >= 40)) continue;
        if (Math.random() < JOIN_ODDS[a.temper]) { w.sides[s].push(a.id); w.rallied = (w.rallied || []).concat(a.id); }
      }
    }
  }
  const invasionTargets = () => players.filter((p) => !live().some((w) => sideOf(w, p.pid) >= 0 && w.sides[1 - sideOf(w, p.pid)].some(isAI)));
  const nextTarget = () => invasionTargets().sort((x, y) => power(y.fleet) + 3 * (y.planets || []).length - power(x.fleet) - 3 * (x.planets || []).length)[0];
  const freeAI = () => ai.list.filter((a) => !a.annexedBy && !(a.overlord && P(a.overlord)));
  const tellAll = (msg, t = "scourge") => { for (const p of players) tell(p.pid, { t, msg }); };
  const homeOf = (x) => x; // every faction's fleet docks at its own system
  const goHome = (fl, x) => { fl.loc = { s: "dock", at: homeOf(x), until: now + 5 * 60000 }; };

  // ---------- real-time war simulation: one step per 30 seconds since the war was last updated ----------
  function battle(w, sideA, sideB, where, when) {
    const fa = sideA.map((x) => F(x).fleet), fb = sideB.map((x) => F(x).fleet);
    const startA = fa.reduce((s, f) => s + hull(f), 0), startB = fb.reduce((s, f) => s + hull(f), 0);
    const snap = (fl) => fl.map((f) => ({ ...f.ships }));
    const before = { a: snap(fa), b: snap(fb) };
    for (let r = 0; r < 6; r++) {
      const pa = fa.reduce((s, f) => s + power(f), 0) * luck(), pb = fb.reduce((s, f) => s + power(f), 0) * luck();
      for (const f of fb) hurt(f, (pa * hull(f)) / Math.max(1, fb.reduce((s, g) => s + hull(g), 0)));
      for (const f of fa) hurt(f, (pb * hull(f)) / Math.max(1, fa.reduce((s, g) => s + hull(g), 0)));
      const ra = fa.reduce((s, f) => s + hull(f), 0) / Math.max(1, startA), rb = fb.reduce((s, f) => s + hull(f), 0) / Math.max(1, startB);
      if (ra < 0.25 || rb < 0.25) break;
    }
    const ra = fa.reduce((s, f) => s + hull(f), 0) / Math.max(1, startA), rb = fb.reduce((s, f) => s + hull(f), 0) / Math.max(1, startB);
    const aWins = ra >= rb, win = aWins ? sideA : sideB, lose = aWins ? sideB : sideA, lr = aWins ? rb : ra;
    const destroyed = lr < 0.25, sw = sideOf(w, win[0]);
    const pts = destroyed ? 36 + Math.floor(Math.random() * 30) : 12;
    award(w, sw, pts);
    for (const x of lose) { goHome(F(x).fleet, x); if (destroyed) w.beaten[x] = true; }
    for (const x of win) renown(x, destroyed ? 25 : 10); for (const x of lose) renown(x, 3);
    ev(w, { kind: "battle", where, a: sideA, b: sideB, before, after: { a: snap(fa), b: snap(fb) }, win: win, destroyed, pts, t: when });
    for (const x of [...sideA, ...sideB]) tell(x, { t: "battle", msg: `${win.includes(x) ? "Victory" : "Defeat"}! ${win.map((y) => F(y).fleet.admiral).join(" and ")} ${destroyed ? "destroyed" : "drove off"} the fleet of ${lose.map(nameOf).join(" and ")}. ${win.includes(x) ? `+${pts} war score.` : "Your survivors limp home."}` });
  }
  function stepWar(w) {
    const when = w.t;
    const factions = w.sides.flat().filter((x) => F(x));
    for (const x of factions) {
      const f = F(x), fl = f.fleet, s = sideOf(w, x), foes = w.sides[1 - s].filter((y) => F(y));
      if (!foes.length) continue;
      // Wartime shipbuilding for AI: a new ship every 10 minutes.
      if (isAI(x) && when - (f.buildAt || 0) > 10 * 60000 && !f.annexedBy) { f.buildAt = when; const k = Math.random() < 0.6 ? "c" : Math.random() < 0.8 ? "f" : "d"; fl.ships[k]++; }
      if (!alive(fl)) continue;
      const target = foes[0];
      if (fl.loc.s === "dock") {
        // Enemy fleet orbiting my home? Counterattack if I have a good chance (about 60%+).
        const raiders = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "orbit" && l.at === x; });
        if (raiders.length) {
          const mine = power(fl) * Math.sqrt(hull(fl)), theirs = raiders.reduce((a, y) => a + power(F(y).fleet) * Math.sqrt(Math.max(1, hull(F(y).fleet))), 0);
          if (mine > theirs * 1.15) battle(w, [x], raiders, x, when);
          continue;
        }
        if ((fl.loc.until || 0) > when) continue;
        const enemyField = foes.reduce((a, y) => a + (alive(F(y).fleet) ? power(F(y).fleet) : 0), 0);
        if (power(fl) >= enemyField * 0.7 || !enemyField) fl.loc = { s: "move", from: x, to: target, t0: when, t1: when + TRAVEL };
      } else if (fl.loc.s === "move") {
        // Opposing fleets on the same lane meet in the middle.
        const opp = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "move" && ((l.from === fl.loc.to && l.to === fl.loc.from) || l.to === fl.loc.from); });
        const meet = opp.length ? Math.max(fl.loc.t0, ...opp.map((y) => F(y).fleet.loc.t0)) + TRAVEL / 2 : 0;
        if (opp.length && when >= meet) { battle(w, [x], opp, "mid:" + fl.loc.from + ":" + fl.loc.to, meet); for (const y of [x, ...opp]) { const l = F(y).fleet.loc; if (l.s === "move") { l.t0 = meet - TRAVEL / 2; l.t1 = meet + TRAVEL / 2; } } continue; }
        if (when >= fl.loc.t1) {
          const def = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && (l.s === "dock" && y === fl.loc.to); });
          if (def.length) { battle(w, [x], def, fl.loc.to, when); if (fl.loc.s === "dock") continue; }
          fl.loc = { s: "orbit", at: fl.loc.to };
        }
      } else if (fl.loc.s === "orbit") {
        const owner = fl.loc.at, sg = (w.siege[x] ||= { owner, planet: -1, hold: 0, progress: 0 });
        const pl = planetsOf(owner).filter((p) => p.ok && !occupied(w, owner, p.i));
        if (!pl.length) continue; // everything already occupied; the fleet holds orbit
        const pick = pl.find((p) => !p.home) || pl.find((p) => p.home);
        if (sg.planet !== pick.i || sg.owner !== owner) Object.assign(sg, { owner, planet: pick.i, hold: 0, progress: 0 });
        if (!pick.home) {
          const need = 60000 * (1 + pdef(owner, pick.i) / 2);
          sg.hold += STEP; sg.last = `Holding orbit over ${pick.n}: ${Math.round(sg.hold / 1000)}s of ${need / 1000}s.`;
          if (sg.hold >= need) { w.occ.push({ by: x, owner, i: pick.i, n: pick.n, home: false, t: when }); ev(w, { kind: "occupy", by: x, owner, i: pick.i, n: pick.n }); renown(x, 8); tell(owner, { t: "occupied", msg: `${fl.admiral} has occupied ${pick.n}!` }); }
        } else {
          if (when < (sg.next || 0)) continue; sg.next = when + SIEGE;
          const dl = pdef(owner, pick.i), fort = FORT.home + dl, fire = ((isAI(owner) ? HOME_FIRE.ai : HOME_FIRE.player) + 3 * dl) * (0.8 + Math.random() * 0.4);
          hurt(fl, fire * (1 - ((fl.buff || {}).guard || 0)));
          const roll = 1 + Math.floor(Math.random() * 14), total = roll + sg.progress + siegeBonus(fl) - fort;
          let res;
          if (roll === 1) { hurt(fl, hull(fl) * 0.05); res = "Disease breaks out in the siege lines."; }
          else if (total <= 4) res = "Status quo.";
          else if (total <= 11) { sg.progress++; res = "Supplies run short inside the walls."; }
          else if (total <= 13) { sg.progress += 2; res = "The planetary shield is breached!"; }
          else res = "The defenders surrender!";
          sg.last = `Siege of ${pick.n}: rolled ${roll} + ${sg.progress} progress + ${siegeBonus(fl)} siege − ${fort} fort = ${total}. ${res}`;
          ev(w, { kind: "siege", by: x, owner, i: pick.i, roll, total, res, fire: Math.round(fire) }); renown(x, 2);
          if (total >= 14) { w.occ.push({ by: x, owner, i: pick.i, n: pick.n, home: true, t: when }); award(w, s, 50); renown(x, 30); ev(w, { kind: "occupy", by: x, owner, i: pick.i, n: pick.n, home: true }); tell(owner, { t: "occupied", msg: `Your home world ${pick.n} has fallen to ${fl.admiral}!` }); }
          else if (!alive(fl) || hull(fl) < 3) { goHome(fl, x); tell(x, { t: "siege", msg: `The defenses of ${pick.n} shattered your fleet. It falls back to rebuild.` }); }
        }
      }
    }
    w.t += STEP;
  }
  // ---------- AI peacetime behavior: hourly steps ----------
  const steps = Math.min(48, Math.floor((now - ai.last) / HOUR));
  for (let s = 0; s < steps; s++) {
    for (const a of ai.list) {
      if (a.annexedBy) continue;
      for (const p of a.planets) if (!p.owner) a.res[p.r] = Math.min(400, (a.res[p.r] || 0) + 3);
      if (Math.random() < (a.temper === "aggressive" ? 0.5 : 0.3)) a.fleet.ships[Math.random() < 0.7 ? "c" : "f"]++;
      for (const pl of players) { const o = a.opinion[pl.pid] ?? a.base; a.opinion[pl.pid] = o + Math.sign(a.base - o); }
      if (a.overlord || ai.endedAt) continue;
      const t = ai.last + HOUR;
      // Hostile empires wait. Once a player's fleet gets close to theirs, they threaten; if the player keeps it up, they strike first.
      for (const pl of players) {
        if (mutual(a.id, pl.pid) || warOf(a.id, pl.pid) || (a.opinion[pl.pid] ?? a.base) > -20) { delete a.threat[pl.pid]; continue; }
        const ratio = power(pl.fleet) / Math.max(1, power(a.fleet));
        if (ratio < THREAT_AT * 0.75) { delete a.threat[pl.pid]; continue; }
        if (ratio < THREAT_AT) continue;
        if (!a.threat[pl.pid]) { a.threat[pl.pid] = t; tell(pl.pid, { t: "threat", msg: `${a.fleet.admiral} of ${a.name} sends word: "Your fleet grows bold. Keep building and we will come for you."` }); }
        else if (t - a.threat[pl.pid] >= THREAT_WAIT * HOUR && t - (a.warAt || 0) >= 12 * HOUR) {
          delete a.threat[pl.pid]; a.warAt = t; const w = startWar(a.id, pl.pid);
          tell(pl.pid, { t: "war", msg: `${a.name} strikes first! ${w.sides[0].map(nameOf).join(" and ")} declare war on you.` });
          break;
        }
      }
    }
    ai.last += HOUR;
  }
  if (now - ai.last > 48 * HOUR) ai.last = now;
  // The scourge: every few days the free AI empires invade a player together. It ends when none are free.
  if (players.length && !ai.endedAt) {
    const free = freeAI();
    if (!free.length) { ai.endedAt = now; tellAll("The last AI empire bows to the players. The AI scourge is ended. The galaxy is yours."); }
    else {
      if (!ai.invadeAt) ai.invadeAt = now + FIRST_INVASION * HOUR;
      if (!ai.warned && now >= ai.invadeAt - WARN * HOUR) { ai.warned = true; tellAll(`Spies report the AI empires massing their fleets together. They will invade within ${WARN} hours. Ally with the other players now.`); }
      if (now >= ai.invadeAt) {
        const targets = invasionTargets();
        const target = [...targets].sort((x, y) => power(y.fleet) + 3 * (y.planets || []).length - power(x.fleet) - 3 * (x.planets || []).length)[0];
        const lead = target && free.filter((a) => !mutual(a.id, target.pid)).sort((x, y) => power(y.fleet) - power(x.fleet))[0];
        if (lead) {
          const w = startWar(lead.id, target.pid); w.invasion = true;
          tellAll(`The AI empires move together! ${w.sides[0].map(nameOf).join(", ")} invade ${nameOf(target.pid)}. Any player can join the defense from the Wars panel.`);
        }
        ai.invadeAt = now + INVASION_EVERY * HOUR; ai.warned = false;
      }
    }
  }
  for (const w of live()) { let n = 0; while (w.t <= now && n++ < MAX_STEPS) stepWar(w); if (now - w.t > MAX_STEPS * STEP) w.t = now; }
  // AI makes peace: it enforces a demand when it can, or accepts white peace after losing its fleet.
  for (const w of live()) for (const x of w.sides.flat()) if (isAI(x)) {
    const s = sideOf(w, x), mine = w.score[x] || 0, foe = w.sides[1 - s][0];
    if (mine >= TERMS.reparations && foe && !isAI(foe)) await makePeace(w, x, "reparations", foe, 0, ["ore", "fuel", "food"]);
    else if (w.beaten[x] && !alive(A(x).fleet) && (w.score[foe] || 0) > mine) w.aiWhite = true;
  }

  async function makePeace(w, by, term, target, planet, want) {
    const s = sideOf(w, by), tgt = F(target);
    const myOcc = w.occ.filter((o) => sideOf(w, o.by) === s && o.owner === target);
    const homeHeld = myOcc.some((o) => o.home);
    const take = (o) => { if (isAI(target)) A(target).planets[o.i].owner = by; else { const p = tgt.planets[o.i]; if (p) { tgt.planets = tgt.planets.filter((q) => q !== p); tell(target, { t: "ceded", planet: p.n, msg: `By treaty, ${p.n} now belongs to ${nameOf(by)}.` }); } } };
    const got = {}, planets = [];
    if (term === "claim" || term === "claimrep") { const o = myOcc.find((q) => !q.home && q.i === planet) || myOcc.find((q) => !q.home); if (!o) return "Occupy one of their colonies first."; const p = isAI(target) ? A(target).planets[o.i] : tgt.planets[o.i]; planets.push({ n: p.n, r: p.r, from: target }); take(o); }
    if (term === "reparations" || term === "claimrep") {
      const order = [...(Array.isArray(want) ? want.filter((r) => RES.includes(r)) : []), ...RES];
      let picked = 0; for (const r of order) { if (picked >= 4 || got[r]) continue; const n = Math.min(30, Math.floor(((tgt.res || {})[r] || 0) * 0.3)); if (n > 0) { got[r] = n; tgt.res[r] -= n; picked++; } }
      tell(target, { t: "reparations", res: got, msg: `You pay war reparations to ${nameOf(by)}.` });
    }
    if (term === "claims") { if (!homeHeld) return "Taking several worlds needs their home world occupied."; for (const o of myOcc.filter((q) => !q.home)) { const p = isAI(target) ? A(target).planets[o.i] : tgt.planets[o.i]; if (p) planets.push({ n: p.n, r: p.r, from: target }); } for (const o of myOcc.filter((q) => !q.home).sort((a, b) => b.i - a.i)) take(o); }
    if (term === "vassal") { if (!homeHeld) return "Vassalage needs their home world occupied."; if (isAI(target)) A(target).overlord = by; else tgt.vassalOf = by; tell(target, { t: "vassal", msg: `You are now a vassal of ${nameOf(by)} and pay tribute every hour.` }); }
    if (term === "annex") { if (!isAI(target)) return "Only AI empires can be annexed."; if (!homeHeld) return "Annexation needs their home world occupied."; const a = A(target); a.planets.forEach((p) => { if (!p.owner) { planets.push({ n: p.n, r: p.r, from: target }); p.owner = by; } }); a.annexedBy = by; a.fleet.ships = { c: 0, f: 0, d: 0 }; }
    w.score[by] -= TERMS[term];
    w.ended = now; w.outcome = { by, term, target, got, planets };
    for (const x of w.sides.flat()) { if (F(x)) goHome(F(x).fleet, x), (F(x).fleet.loc.until = 0); }
    ev(w, { kind: "peace", by, term, target });
    for (const x of w.sides.flat()) if (x !== by) tell(x, { t: "peace", msg: `Peace: ${nameOf(by)} imposes ${term === "white" ? "a white peace" : term === "claimrep" ? "a claim and reparations" : term} on ${nameOf(target)}.` });
    if (!isAI(by) && by !== me) tell(by, { t: "spoils", res: got, planets, msg: `Peace signed. Spoils: ${planets.map((p) => p.n).join(", ") || "none"}.` });
    return { got, planets };
  }

  let out = { ok: true }, status = 200;
  const self = P(me);
  const fail = (msg) => { out = { ok: false, msg }; };

  if (op === "mine") { out.mine = self || null; }
  else if (op === "promote") { if (!self) fail("No system."); else if (!DOCTRINE[body.skill]) fail("Unknown doctrine."); else if (self.doctrines.length >= tierOf(self.renown)) fail("No promotion waiting.");
    else { self.doctrines.push(body.skill); general(self); out.msg = `Promoted to ${RANKS[self.doctrines.length]}.`; } }
  else if (op === "resetgen") { if (self) { self.renown = 0; self.doctrines = []; general(self); } }
  else if (op === "leave") { await store.delete(me); await store.delete("in-" + me); for (const w of live()) if (sideOf(w, me) >= 0) w.ended = now; }
  else if (op === "sync") {
    const box = await inbox(me);
    let slot = self ? self.slot : -1;
    if (slot < 0) { const taken = new Set(players.map((p) => p.slot)); for (let i = 0; i < MAX; i++) if (!taken.has(i)) { slot = i; break; } }
    if (slot < 0) { out = { full: true }; status = 409; }
    else if (body.sys && !box.length) { const rec = cleanSys(body.sys, me, slot, self); if (self) Object.assign(self, rec); else players.push(rec); general(self || rec); }
    out.pid = me; out.slot = slot; out.inbox = box.splice(0);
  } else if (!self) fail("Open Systems first to claim a system.");
  else if (op === "war") {
    const t = ref(body.target);
    if (!F(t) || t === me || (isAI(t) && A(t).annexedBy)) fail("No such system.");
    else if (mutual(me, t)) fail("You can't declare war on an ally. End the alliance first.");
    else { const w = startWar(me, t); await tell(t, { t: "war", msg: `${nameOf(me)} has declared war on you! ${self.fleet.admiral} is coming.` }); out.war = w.id; }
  } else if (op === "join") {
    const w = live().find((x) => x.id === body.war); const s = w ? [0, 1].find((k) => w.sides[k].some((x) => mutual(x, me)) || (w.sides[k].some((x) => !isAI(x)) && w.sides[1 - k].every(isAI))) : undefined;
    if (!w || s === undefined || sideOf(w, me) >= 0) fail("You can join a war your ally is fighting, or any war against the AI empires.");
    else { w.sides[s].push(me); const fl = self.fleet; if (alive(fl) && fl.loc.s === "dock") fl.loc = { s: "move", from: me, to: w.sides[1 - s][0], t0: now, t1: now + TRAVEL }; for (const x of w.sides[1 - s]) await tell(x, { t: "war", msg: `${nameOf(me)} has joined the war against you.` }); }
  } else if (op === "build") {
    const k = ["c", "f", "d"].includes(body.ship) ? body.ship : null; if (!k) fail("Unknown ship."); else { self.fleet.ships[k]++; out.msg = "The new ship joins your fleet wherever it is."; }
  } else if (op === "upgrade") {
    const k = ["c", "f", "d"].includes(body.ship) ? body.ship : null; if (!k) fail("Unknown ship."); else if (self.fleet.up[k] >= 3) fail("Fully upgraded."); else { self.fleet.up[k]++; out.msg = "Upgrade installed across the fleet."; }
  } else if (op === "peace") {
    const w = live().find((x) => x.id === body.war), term = TERMS[body.term] !== undefined ? body.term : null, t = ref(body.target);
    const s = w ? sideOf(w, me) : -1, sc = w ? w.score[me] || 0 : 0;
    if (!w || s < 0) fail("No such war.");
    else if (!term) fail("Unknown treaty.");
    else if (term === "white") {
      const theirs = Math.max(0, ...w.sides[1 - s].map((y) => w.score[y] || 0));
      if (sc >= theirs || w.aiWhite || Object.keys(w.beaten).some((x) => sideOf(w, x) === 1 - s)) { const r = await makePeace(w, me, "white", w.sides[1 - s][0]); out.msg = "White peace signed. Everyone goes home."; }
      else { w.whiteOffer = me; out.msg = "White peace offered. They will accept once they are losing."; }
    } else if (sideOf(w, t) !== 1 - s) fail("Pick an enemy in this war.");
    else if (sc < TERMS[term]) fail(`That treaty needs ${TERMS[term]} war score. You have ${sc}.`);
    else { const r = await makePeace(w, me, term, t, int(body.planet, 0, 11), body.want); if (typeof r === "string") fail(r); else out = { ok: true, ...r, msg: "Treaty signed." }; }
  } else if (op === "ai") {
    const a = A(ref(body.ai)), act = body.act;
    if (!a || a.annexedBy) fail("No such empire.");
    else if (act === "envoy") { if (now - (a.envoyAt[me] || 0) < HOUR) fail("Your last envoy is still on the road. Try again within the hour."); else { a.envoyAt[me] = now; opinion(a, me, 5); out.msg = `${a.name} receives your envoy warmly.`; } }
    else if (act === "gift") { opinion(a, me, 8); out.msg = `${a.name} accepts your gift.`; }
    else if (act === "ally") { if ((a.opinion[me] ?? a.base) < 50) fail(`${a.name} doesn't trust you enough yet. Get their opinion to 50.`); else if (warOf(a.id, me)) fail("Make peace first."); else { if (!a.allies.includes(me)) a.allies.push(me); out.msg = `${a.name} agrees to an alliance.`; } }
    else if (act === "unally") { a.allies = a.allies.filter((x) => x !== me); opinion(a, me, -30); out.msg = `${a.name} is offended.`; }
  }

  for (const a of ai.list) if (a.overlord && !P(a.overlord)) a.overlord = null;
  await store.setJSON("ai", ai); await store.setJSON("wars", wars.filter((w) => !w.ended || now - w.ended < HOUR));
  for (const p of players) await store.setJSON(p.pid, p);
  for (const pid in inboxes) await store.setJSON("in-" + pid, inboxes[pid]);
  const view = (a) => ({ ...a, opinion: a.opinion[me] ?? a.base, envoyAt: undefined, threat: undefined, threatens: !!(a.threat || {})[me], strikeAt: (a.threat || {})[me] ? Math.max(a.threat[me] + THREAT_WAIT * HOUR, (a.warAt || 0) + 12 * HOUR) : 0, myAlly: a.allies.includes(me) });
  return Response.json({ ...out, now, systems: players, ai: ai.list.map(view), scourge: { invadeAt: ai.invadeAt, endedAt: ai.endedAt, free: freeAI().length, next: !ai.endedAt && freeAI().length ? (nextTarget() || {}).pid || null : null }, rulesAI: { THREAT_AT }, ranks: { RANKS, PROMOTE, DOCTRINE }, wars: wars.filter((w) => !w.ended || now - w.ended < 10 * 60000), max: MAX, rules: { SHIP, UPG, TERMS, STEP, TRAVEL } }, { status, headers });
};

export const config = { path: "/api/systems" };
