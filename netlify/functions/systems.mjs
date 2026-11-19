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

//   invest {to, credits}   offer another player today's foreign rare goods for the credits I still need today
//   investok {offer, paid} / investno {offer}   the receiving player accepts (client pays and receives) or declines
//   stance {war, mode}     attack | hold: what a defending fleet does after it wins
//   tech {tech}            next level of a technology (client has paid); technologies outlast the season
//   tick                   no-op call from the scheduled function, so wars run while everyone is offline
// Weeks: each game runs for one week. Each day is harder than the last; day 7 brings the Reflection.
// Then everything resets and players name new systems. Technologies, ship upgrades and generals carry over, and each week is a little harder.
const MAX = 5, HOUR = 3600000, DAY = 24 * HOUR, STEP = 5000, SIEGE = 30000, TRAVEL = 10000, MAX_STEPS = 1440, ONLINE = 30000;
const SEASON_DAYS = 7, CRISIS_AT = 6 * DAY, INVASIONS = [2 * DAY, 4 * DAY];
// Technologies: bought with credits and goods, kept forever. Server applies the military ones.
const TECH = { agri: 2, mine: 3, ward: 2, yard: 2, bast: 2, lance: 2 };
const BAST = 0.25, LANCE = 0.2, HOLD_BONUS = 0.1;
// Sieges and landings run live (a round every 30 seconds) while anyone on the defending side is online.
// While the whole defending side is away, the garrison digs in: a siege round every 90 minutes, landings take an hour.
const SIEGE_AWAY = 90 * 60000, LAND = 60000, LAND_AWAY = 60 * 60000;
// The Reflection: each player's mirror fleet. Its strength grows with the season, not with your fleet,
// so the galaxy wins it by standing together. Destroying a mirror fleet collapses its rift.
const REFLECT = { atk: 14, season: 0.45, regen: 0.25 };
// Against the Reflection, a world's guns grow with its civilization: x1 for a Landfall outpost up to x4 for Type II.
const kOf = (p) => (p.swarm ? 1 + 0.25 * p.swarm : [0.5, 0.7, 0.85, 1][p.dev || 0] || 0.5);
const COMMON = ["food", "water", "ore", "fuel"], RARE = ["crystal", "plasma", "spice", "alloy", "relic"], RES = [...COMMON, ...RARE];
// Base ship stats and the three upgrades per ship type (each improves 1 to 3 stats).
const SHIP = { c: { atk: 1, hull: 2, siege: 0 }, f: { atk: 3, hull: 5, siege: 1 }, d: { atk: 8, hull: 14, siege: 2 } };
const UPG = {
  c: [{ atk: 1 }, { hull: 1, atk: 1 }, { atk: 1, hull: 1, siege: 1 }],
  f: [{ atk: 2 }, { hull: 3 }, { atk: 1, hull: 2, siege: 2 }],
  d: [{ atk: 4 }, { hull: 8 }, { atk: 2, hull: 4, siege: 3 }],
};
// War exhaustion (0-100 per side) pushes a side toward peace. It grows with time at war, ships and fleets lost
// (a failed counterattack costs extra), siege damage to its worlds (more for populous worlds) and worlds lost.
// The enemy's treaties get cheaper as it rises (up to 60% off at 100); at 50+ white peace is accepted, at 100 any affordable demand must be.
const EX = { perHour: 12, ship: { c: 1, f: 2, d: 4 }, destroyed: 10, counter: 6, sev: { "Status quo.": 0.5, "Supplies run short inside the walls.": 1, "The planetary shield is breached!": 2 }, colony: 5, home: 25, discount: 0.6 };
const TERMS = { white: 0, claim: 45, reparations: 45, claimrep: 90, claims: 80, vassal: 80, annex: 100, liberate: 40 };
const FORT = { home: 3, colony: 1 }, HOME_FIRE = { player: 10, ai: 8 };
const CENTER = "center"; // wars with more than two factions fight one grand battle in central space
const START_FLEET = { c: 3, f: 1, d: 0 }; // every new player starts with a small fleet (attack 6: about half an AI fleet)
const THREAT_AT = 0.8, THREAT_WAIT = 2, THREAT_REST = 36, WARN = 12, JOIN_ODDS = { aggressive: 1, wary: 0.7, merchant: 0.4 };
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
    ships: int(s.ships, 0, 99), boost: { food: int(s.boost && s.boost.food, 0, 99), water: int(s.boost && s.boost.water, 0, 99), ore: int(s.boost && s.boost.ore, 0, 99), spec: int(s.boost && s.boost.spec, 0, 199) },
    proj: s.proj && ["dev", "swarm"].includes(s.proj.kind) ? { kind: s.proj.kind, left: int(s.proj.left, 0, 99), n: txt(s.proj.n, 40) } : null,
    renown: prev ? prev.renown || 0 : 0, doctrines: prev ? prev.doctrines || [] : [],
    fleet: prev && prev.fleet ? prev.fleet : newFleet(admiralFor(pid), START_FLEET), vassalOf: prev ? prev.vassalOf || null : null, updated: Date.now() };
}
// The same three AI empires every week, a little bigger and better armed each time.
const aiScale = (n) => 1 + 0.15 * (n - 1);
// Hourly chance an AI empire adds a ship in peacetime (doubled by day 7), and the wartime build interval.
const AI_GROW = { aggressive: 0.08, merchant: 0.04, wary: 0.06 }, AI_WARBUILD = 90 * 60000;
function newAI(n = 1) {
  return { last: Date.now(), list: AI_DEF.map((a) => { const sc = aiScale(n), fl = newFleet(a.admiral, Object.fromEntries(Object.entries(a.ships).map(([k, v]) => [k, Math.round(v * sc)])));
    fl.up = { c: Math.min(3, Math.max(0, n - 2)), f: Math.min(3, Math.max(0, n - 3)), d: Math.min(3, Math.max(0, n - 4)) };
    return { id: a.id, name: a.name, temper: a.temper, base: a.base,
    planets: a.planets.map(([n, r], i) => ({ n, r, owner: null, home: i === 0 })), res: { food: 20, water: 20, ore: 20, fuel: 20 },
    fleet: fl, opinion: {}, allies: [], overlord: null, envoyAt: {}, threat: {}, warAt: 0, buildAt: 0, annexedBy: null }; }), invadeAt: 0, warned: false, endedAt: 0 };
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
  let season = (await store.get("season", { type: "json" })) || { n: 1, start: now, chronicle: [] };
  season.chronicle ||= [];
  let ai = (await store.get("ai", { type: "json" })) || newAI(season.n);
  { const fresh = newAI(season.n); // upgrade old saves in place
    for (const k of ["invadeAt", "warned", "endedAt"]) if (ai[k] === undefined) ai[k] = fresh[k];
    for (const d of fresh.list) { const a = ai.list.find((x) => x.id === d.id); if (!a) { ai.list.push(d); continue; }
      for (const k in d) if (a[k] === undefined) a[k] = d[k];
      if (!a.fleet || !a.fleet.loc) a.fleet = newFleet(d.fleet.admiral, a.fleet && a.fleet.ships ? a.fleet.ships : d.fleet.ships); } }
  const self0 = players.find((p) => p.pid === me); if (self0) self0.seen = now;
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
  const exAdd = (w, side, n) => { w.ex ||= [0, 0]; w.ex[side] = Math.min(100, Math.round((w.ex[side] + n) * 10) / 10); return n; };
  const popOf = (owner, home) => (home ? (isAI(owner) ? 24 : (P(owner) || {}).pop || 8) : 8);
  const shipVal = (b, a) => ["c", "f", "d"].reduce((t, k) => t + Math.max(0, (b[k] || 0) - (a[k] || 0)) * EX.ship[k], 0);
  const termCost = (w, term, foeSide) => Math.round(TERMS[term] * (1 - EX.discount * ((w.ex || [0, 0])[foeSide] || 0) / 100));
  const award = (w, side, n) => { for (const x of w.sides[side]) w.score[x] = (w.score[x] || 0) + n; };
  const opinion = (a, pid, d) => { a.opinion[pid] = Math.max(-100, Math.min(100, (a.opinion[pid] ?? a.base) + d)); };
  const ev = (w, e) => { w.events.push({ ...e, t: e.t || now }); w.events = w.events.slice(-30); };
  const planetsOf = (x) => (isAI(x) ? A(x).planets.map((p, i) => ({ n: p.n, i, home: !!p.home, ok: !p.owner })) : (P(x).planets || []).map((p, i) => ({ n: p.n, i, home: p.st === "home", ok: p.st === "home" || p.st === "colony" })));
  const pdef = (owner, i) => (isAI(owner) ? 0 : ((P(owner).planets || [])[i] || {}).def || 0);
  const occupied = (w, owner, i) => w.occ.find((o) => o.owner === owner && o.i === i);
  const isRift = (x) => isAI(x) && !!(A(x) || {}).rift;
  const gone = (x) => !F(x) || (isAI(x) && !!A(x).annexedBy);
  const techOf = (x, k) => (!isAI(x) && P(x) && (P(x).techs || {})[k]) || 0;
  // Season clock: day 1 to 7. Heat rises from 0 on day 1 to 1 on day 7 and drives the AI's growth.
  const dayOf = () => Math.min(SEASON_DAYS, 1 + Math.floor((now - season.start) / DAY));
  const heat = () => Math.max(0, Math.min(1, (now - season.start) / CRISIS_AT));
  const crisisOn = () => now >= season.start + CRISIS_AT;
  // Attackers take the outer worlds first and move inward; the home world is besieged last.
  const orbitOf = (i) => (i < 4 ? i : i % 4);
  const targetOrder = (owner) => planetsOf(owner).filter((p) => p.ok).sort((a, b) => (a.home - b.home) || (orbitOf(b.i) - orbitOf(a.i)) || (b.i - a.i));
  const nextWorld = (w, owner) => targetOrder(owner).find((p) => !occupied(w, owner, p.i));
  // Defending fleets. A player who is attacked while away (offline) never chases the enemy home: after a win
  // the fleet guards the world the enemy would hit next, or posts up over the home world if badly outmatched.
  // A player who is online chooses: counterattack or hold.
  const online = (x) => !isAI(x) && !!P(x) && now - (P(x).seen || 0) < ONLINE;
  const defender = (w, x) => !isAI(x) && (w.crisis ? sideOf(w, x) === 1 : w.sides[1][0] === x);
  const sidePower = (ids) => { const fl = ids.filter((y) => !gone(y)).map((y) => F(y).fleet).filter(alive); return Math.sqrt(fl.reduce((a, f) => a + power(f), 0) * fl.reduce((a, f) => a + Math.max(0, hull(f)), 0)); };
  const outmatched = (w, x) => { const s = sideOf(w, x), mine = w.crisis ? sidePower(w.sides[s]) : sidePower([x]); return mine < 0.7 * sidePower(w.sides[1 - s]); };
  const holds = (w, x) => defender(w, x) && !(online(x) && (w.stance || {})[x] === "attack");
  const standGuard = (w, x) => { const fl = F(x).fleet; if (outmatched(w, x)) { fl.loc = { s: "dock", at: x, until: 0, post: true }; return; }
    const nw = nextWorld(w, x); fl.loc = { s: "guard", at: x, i: nw ? nw.i : 0 }; if (online(x)) (w.ask ||= {})[x] = true; };
  // Planetary guns join any battle fought over their world: the home world's batteries, or a colony's defenses.
  const guns = (owner, i) => { if (isRift(owner)) return 0; const home = isAI(owner) ? true : ((P(owner).planets || [])[i] || {}).st === "home";
    const dl = pdef(owner, i), g = home ? (isAI(owner) ? HOME_FIRE.ai : HOME_FIRE.player) * 0.6 + 3 * dl : 1.5 * dl; return g * (1 + BAST * techOf(owner, "bast")); };
  const watched = (w, owner) => isAI(owner) || (sideOf(w, owner) < 0 ? online(owner) : w.sides[sideOf(w, owner)].some(online));
  const guardSpot = (x) => { const l = F(x).fleet.loc; return l.s === "guard" ? l.i : 0; };

  const grand = (w) => w.sides[0].length + w.sides[1].length > 2;
  const launch = (w, f, s, t) => { const fl = F(f) && F(f).fleet; if (!fl || !alive(fl)) return;
    fl.loc = grand(w) ? { s: "move", from: f, to: CENTER, t0: t, t1: t + TRAVEL / 2 } : { s: "move", from: f, to: w.sides[1 - s][0], t0: t, t1: t + TRAVEL }; };
  // a third faction joining turns a war grand: every fleet still on its way heads for central space instead
  const regroup = (w, t) => { for (const s of [0, 1]) for (const f of w.sides[s]) { const fl = F(f) && F(f).fleet; if (!fl || !alive(fl)) continue;
      if (fl.loc.s === "dock" && !(fl.loc.until > t)) { if (!(defender(w, f) && holds(w, f))) launch(w, f, s, t); }
      else if (fl.loc.s === "move" && fl.loc.to !== CENTER && fl.loc.from === f) launch(w, f, s, t); } };
  const startWar = (x, y, alone) => {
    let w = warOf(x, y); if (w) return w;
    w = { id: Math.random().toString(36).slice(2, 10), sides: [[x], [y]], score: {}, occ: [], siege: {}, events: [], t: now, started: now, beaten: {}, ex: [0, 0] };
    for (const a of ai.list) if (!a.annexedBy && !a.rift) { if (mutual(a.id, y) && a.id !== x) w.sides[1].push(a.id); else if (mutual(a.id, x) && a.id !== y) w.sides[0].push(a.id); }
    if (!alone) rally(w);
    for (const a of ai.list) for (const s of [0, 1]) if (w.sides[s].includes(a.id)) for (const p of w.sides[1 - s]) if (!isAI(p)) opinion(a, p, -40);
    wars.push(w); ev(w, { kind: "war", a: x, b: y });
    for (const s of [0, 1]) for (const f of w.sides[s]) { const fl = F(f) && F(f).fleet; if (fl && alive(fl) && fl.loc.s === "dock") { if (defender(w, f) && !online(f) && outmatched(w, f)) fl.loc = { s: "dock", at: f, until: 0, post: true }; else launch(w, f, s, now); } }
    return w;
  };
  // The AI empires look after each other: when an AI fights a player, the other free AIs usually pile in.
  function rally(w) {
    if (w.crisis) return;
    for (const s of [0, 1]) {
      if (!w.sides[s].some(isAI) || !w.sides[1 - s].some((x) => !isAI(x))) continue;
      for (const a of ai.list) {
        if (a.rift || a.annexedBy || a.overlord || w.sides.flat().includes(a.id) || warOf(a.id, w.sides[1 - s][0])) continue;
        if (w.sides[1 - s].some((p) => mutual(a.id, p) || (a.opinion[p] ?? a.base) >= 40)) continue;
        if (Math.random() < JOIN_ODDS[a.temper]) { w.sides[s].push(a.id); w.rallied = (w.rallied || []).concat(a.id); }
      }
    }
  }
  const invasionTargets = () => players.filter((p) => !p.vassalOf && !live().some((w) => sideOf(w, p.pid) >= 0 && w.sides[1 - sideOf(w, p.pid)].some(isAI)));
  const nextTarget = () => invasionTargets().sort((x, y) => power(y.fleet) + 3 * (y.planets || []).length - power(x.fleet) - 3 * (x.planets || []).length)[0];
  const freeAI = () => ai.list.filter((a) => !a.rift && !a.annexedBy && !(a.overlord && P(a.overlord)));
  const tellAll = (msg, t = "scourge") => { for (const p of players) tell(p.pid, { t, msg }); };
  const homeOf = (x) => x; // every faction's fleet docks at its own system
  const goHome = (fl, x) => { fl.loc = { s: "dock", at: homeOf(x), until: now + 5 * 60000 }; };

  // ---------- real-time war simulation: one step per 30 seconds since the war was last updated ----------
  function battle(w, sideA, sideB, where, when) {
    const fa = sideA.map((x) => F(x).fleet), fb = sideB.map((x) => F(x).fleet);
    const startA = fa.reduce((s, f) => s + hull(f), 0), startB = fb.reduce((s, f) => s + hull(f), 0);
    const snap = (fl) => fl.map((f) => ({ ...f.ships }));
    const before = { a: snap(fa), b: snap(fb), ua: fa.map((f) => ({ ...f.up })), ub: fb.map((f) => ({ ...f.up })) };
    // fighting over your own world: its guns join in, and your fleet fights 10% harder on home ground
    const site = typeof where === "string" && F(where) ? where : null, gi = site ? (isAI(site) ? 0 : guardSpot(site)) : 0;
    const kx = (ids, foes) => (site && !isAI(site) && foes.some(isRift) ? 2 * kOf(P(site)) : 1);
    const gA = site && sideA.includes(site) ? guns(site, gi) * kx(sideA, sideB) : 0, gB = site && sideB.includes(site) ? guns(site, gi) * kx(sideB, sideA) : 0;
    const mult = (ids, foes) => ids.map((x) => (1 + (site === x ? HOLD_BONUS : 0)) * (foes.some(isRift) ? 1 + LANCE * techOf(x, "lance") : 1));
    const mA = mult(sideA, sideB), mB = mult(sideB, sideA);
    for (let r = 0; r < 6; r++) {
      const pa = (fa.reduce((s, f, j) => s + power(f) * mA[j], 0) + gA) * luck(), pb = (fb.reduce((s, f, j) => s + power(f) * mB[j], 0) + gB) * luck();
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
    for (const x of lose) { goHome(F(x).fleet, x); if (destroyed) w.beaten[x] = true; if (destroyed && isRift(x)) seal(w, x, win); }
    for (const x of win) if (defender(w, x) && holds(w, x) && F(x).fleet.loc.s !== "dock") standGuard(w, x);
    for (const x of win) renown(x, destroyed ? 25 : 10); for (const x of lose) renown(x, 3);
    const after = { a: snap(fa), b: snap(fb) }, sa = sideOf(w, sideA[0]), sbx = 1 - sa;
    const lossA = before.a.reduce((t, b, j) => t + shipVal(b, after.a[j]), 0), lossB = before.b.reduce((t, b, j) => t + shipVal(b, after.b[j]), 0);
    // a counterattack: the losers sortied while an enemy fleet was besieging their own worlds
    const counter = lose.some((x) => Object.values(w.siege || {}).some((sg) => sg && sg.owner === x));
    const exd = { a: exAdd(w, sa, lossA + (!aWins ? (destroyed ? EX.destroyed : 0) + (counter ? EX.counter : 0) : 0)), b: exAdd(w, sbx, lossB + (aWins ? (destroyed ? EX.destroyed : 0) + (counter ? EX.counter : 0) : 0)), counter };
    ev(w, { kind: "battle", where, a: sideA, b: sideB, before, after, win: win, destroyed, pts, t: when, exd, guns: Math.round(gA || gB) || undefined });
    for (const x of [...sideA, ...sideB]) tell(x, { t: "battle", msg: `${win.includes(x) ? "Victory" : "Defeat"}! ${win.map((y) => F(y).fleet.admiral).join(" and ")} ${destroyed ? "destroyed" : "drove off"} the fleet of ${lose.map(nameOf).join(" and ")}. ${win.includes(x) ? `+${pts} war score.` : "Your survivors limp home."}` });
  }
  function stepWar(w) {
    const when = w.t;
    const factions = w.sides.flat().filter((x) => !gone(x));
    for (const x of factions) {
      if (w.ended) break;
      const f = F(x), fl = f.fleet, s = sideOf(w, x), foes = w.sides[1 - s].filter((y) => !gone(y));
      if (!foes.length) continue;
      // Wartime shipbuilding for AI: a new ship every 90 minutes (the Reflection regrows from its rifts instead).
      if (isAI(x) && !f.rift && when - (f.buildAt || 0) > AI_WARBUILD && !f.annexedBy) { f.buildAt = when; const k = Math.random() < 0.6 ? "c" : Math.random() < 0.8 ? "f" : "d"; fl.ships[k]++; }
      if (!alive(fl)) continue;
      // each mirror hunts the empire it reflects; players go for their own mirror first
      const mineMirror = foes.find((y) => isRift(y) && A(y).mirror === x), hunted = f.rift && foes.includes(f.mirror) ? f.mirror : null;
      const target = hunted || mineMirror || foes[0];
      if (fl.loc.s === "guard") {
        if (fl.loc.at !== x) { fl.loc = { s: "dock" }; continue; }
        // raiders already over my worlds: engage them if the guns make it a fair fight
        const raiders = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "orbit" && l.at === x; });
        if (raiders.length) { const mine = power(fl) * Math.sqrt(hull(fl)) + guns(x, fl.loc.i) * 3, theirs = raiders.reduce((a, y) => a + power(F(y).fleet) * Math.sqrt(Math.max(1, hull(F(y).fleet))), 0);
          if (mine > theirs * 0.9) battle(w, [x], raiders, x, when); else fl.loc = { s: "dock", at: x, until: 0, post: true }; continue; }
        if (!holds(w, x)) { launch(w, x, s, when); continue; }
        if (outmatched(w, x)) { fl.loc = { s: "dock", at: x, until: 0, post: true }; continue; }
        const nw = nextWorld(w, x); if (nw && nw.i !== fl.loc.i) fl.loc.i = nw.i;
        continue;
      }
      if (fl.loc.s === "dock") {
        // Enemy fleet orbiting my home? Counterattack if I have a good chance (about 60%+).
        const raiders = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "orbit" && l.at === x; });
        if (raiders.length) {
          const mine = power(fl) * Math.sqrt(hull(fl)) + (defender(w, x) ? guns(x, 0) * 3 : 0), theirs = raiders.reduce((a, y) => a + power(F(y).fleet) * Math.sqrt(Math.max(1, hull(F(y).fleet))), 0);
          if (mine > theirs * 1.15) battle(w, [x], raiders, x, when);
          continue;
        }
        if ((fl.loc.until || 0) > when) continue;
        if (defender(w, x) && holds(w, x)) { if (!outmatched(w, x)) standGuard(w, x); continue; }
        const enemyField = foes.reduce((a, y) => a + (alive(F(y).fleet) ? power(F(y).fleet) : 0), 0);
        if (power(fl) >= enemyField * 0.7 || !enemyField) launch(w, x, s, when);
      } else if (fl.loc.s === "move" && fl.loc.to === CENTER) {
        if (when >= fl.loc.t1) fl.loc = { s: "rally", at: CENTER, since: fl.loc.t1 };
      } else if (fl.loc.s === "rally") {
        const here = (side) => w.sides[side].filter((y) => F(y) && alive(F(y).fleet) && F(y).fleet.loc.s === "rally");
        const mine = here(s), theirs = here(1 - s);
        // wait (up to 15s) for any fleet still flying in, so everyone fights in one battle
        const inbound = w.sides.flat().some((y) => { const l = F(y) && F(y).fleet.loc; return l && alive(F(y).fleet) && l.s === "move" && l.to === CENTER; });
        const waited = when - Math.min(...[...mine, ...theirs].map((y) => F(y).fleet.loc.since)) >= 15000;
        if (theirs.length && (!inbound || waited)) { const t = Math.max(when, ...[...mine, ...theirs].map((y) => F(y).fleet.loc.since)); battle(w, mine, theirs, CENTER, t); continue; }
        if (theirs.length) continue;
        const coming = foes.some((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "move" && l.to === CENTER; });
        if (!coming) { if (defender(w, x) && holds(w, x)) { fl.loc = { s: "move", from: CENTER, to: x, t0: when, t1: when + TRAVEL / 2, back: true }; continue; }
          fl.loc = { s: "move", from: CENTER, to: target, t0: when, t1: when + TRAVEL / 2 }; }
      } else if (fl.loc.s === "move") {
        // Opposing fleets on the same lane meet in the middle.
        const opp = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && l.s === "move" && ((l.from === fl.loc.to && l.to === fl.loc.from) || l.to === fl.loc.from); });
        const meet = opp.length ? Math.max(fl.loc.t0, ...opp.map((y) => F(y).fleet.loc.t0)) + TRAVEL / 2 : 0;
        if (opp.length && when >= meet) { battle(w, [x], opp, "mid:" + fl.loc.from + ":" + fl.loc.to, meet); for (const y of [x, ...opp]) { const l = F(y).fleet.loc; if (l.s === "move") { l.t0 = meet - TRAVEL / 2; l.t1 = meet + TRAVEL / 2; } } continue; }
        if (when >= fl.loc.t1) {
          if (fl.loc.to === x) { standGuard(w, x); continue; } // a defender flying home to stand guard
          const def = foes.filter((y) => { const l = F(y).fleet.loc; return alive(F(y).fleet) && y === fl.loc.to && (l.s === "dock" || (l.s === "guard" && l.at === y)); });
          if (def.length) { battle(w, [x], def, fl.loc.to, when); if (fl.loc.s !== "move") continue; }
          fl.loc = { s: "orbit", at: fl.loc.to };
        }
      } else if (fl.loc.s === "orbit") {
        const owner = fl.loc.at, sg = (w.siege[x] ||= { owner, planet: -1, hold: 0, progress: 0 });
        const pick = nextWorld(w, owner);
        if (!pick) continue; // everything already occupied; the fleet holds orbit
        if (sg.planet !== pick.i || sg.owner !== owner) Object.assign(sg, { owner, planet: pick.i, hold: 0, progress: 0 });
        if (!pick.home) {
          const live = watched(w, owner);
          sg.hold += STEP * (live ? 1 : LAND / LAND_AWAY); sg.last = `Holding orbit over ${pick.n}: ${Math.round(sg.hold / 1000)}s of ${LAND * (1 + pdef(owner, pick.i) / 2) / 1000}s${live ? "" : " (slowed: its defenders are away)"}.`;
          if (sg.hold >= LAND * (1 + pdef(owner, pick.i) / 2)) { w.occ.push({ by: x, owner, i: pick.i, n: pick.n, home: false, t: when }); ev(w, { kind: "occupy", by: x, owner, i: pick.i, n: pick.n, exd: exAdd(w, sideOf(w, owner), EX.colony + popOf(owner, false) / 8) }); renown(x, 8); tell(owner, { t: "occupied", msg: `${fl.admiral} has occupied ${pick.n}!` }); }
        } else {
          if (when < (sg.next || 0)) continue; sg.next = when + (watched(w, owner) ? SIEGE : SIEGE_AWAY);
          const dl = pdef(owner, pick.i), fort = FORT.home + dl, fire = ((isAI(owner) ? HOME_FIRE.ai : HOME_FIRE.player) + 3 * dl) * (1 + BAST * techOf(owner, "bast")) * (0.8 + Math.random() * 0.4);
          const shipsBefore = { ...fl.ships };
          hurt(fl, fire * (1 - ((fl.buff || {}).guard || 0)));
          const pre = sg.progress, sb = siegeBonus(fl), roll = 1 + Math.floor(Math.random() * 14), total = roll + sg.progress + sb - fort;
          let res;
          if (roll === 1) { hurt(fl, hull(fl) * 0.05); res = "Disease breaks out in the siege lines."; }
          else if (total <= 4) res = "Status quo.";
          else if (total <= 11) { sg.progress++; res = "Supplies run short inside the walls."; }
          else if (total <= 13) { sg.progress += 2; res = "The planetary shield is breached!"; }
          else res = "The defenders surrender!";
          if (total >= 14) res = "The defenders surrender!"; // reaching 14 always takes the world, whatever else happened
          sg.last = `Siege of ${pick.n}: rolled ${roll} + ${sg.progress} progress + ${siegeBonus(fl)} siege − ${fort} fort = ${total}. ${res}`;
          // ships the planet's guns (or disease) destroyed this round, for the client's animation
          const lost = Object.fromEntries(["c", "f", "d"].map((k) => [k, shipsBefore[k] - fl.ships[k]]).filter(([, n]) => n > 0));
          const broken = total < 14 && (!alive(fl) || hull(fl) < 3);
          const os = sideOf(w, owner), pop = popOf(owner, true);
          const exd = { def: exAdd(w, os, Math.round((1 + pop / 10) * (EX.sev[res] || 0) * 10) / 10), atk: exAdd(w, s, shipVal(shipsBefore, fl.ships)) };
          ev(w, { kind: "siege", by: x, owner, i: pick.i, n: pick.n, roll, total, res, fire: Math.round(fire), lost, broken, pre, sb, fort, ships: { ...fl.ships }, up: { ...fl.up }, def: dl, pop, exd }); renown(x, 2);
          if (total >= 14) { w.occ.push({ by: x, owner, i: pick.i, n: pick.n, home: true, t: when }); award(w, s, 50); renown(x, 30); ev(w, { kind: "occupy", by: x, owner, i: pick.i, n: pick.n, home: true, exd: exAdd(w, sideOf(w, owner), EX.home + popOf(owner, true) / 4) }); tell(owner, { t: "occupied", msg: `Your home world ${pick.n} has fallen to ${fl.admiral}!` });
            // an AI empire that takes a player's home world makes that player its vassal; other players can liberate them
            if (isAI(x) && !f.rift && !isAI(owner)) { makePeace(w, x, "vassal", owner); tellAll(`${nameOf(owner)} has fallen and is now a vassal of ${f.name}. Defeat ${f.name} to liberate them.`, "vassal"); }
            if (isRift(owner)) seal(w, owner, [x]);
            if (f.rift) { (season.fallen ||= {})[owner] = true; tellAll(`The Reflection has taken ${pick.n}, home of ${nameOf(owner)}.`, "crisis"); } }
          else if (!alive(fl) || hull(fl) < 3) { goHome(fl, x); tell(x, { t: "siege", msg: `The defenses of ${pick.n} shattered your fleet. It falls back to rebuild.` }); }
        }
      }
    }
    exAdd(w, 0, EX.perHour * STEP / HOUR); exAdd(w, 1, EX.perHour * STEP / HOUR);
    w.t += STEP;
  }
  // ---------- the season: a week-long galaxy that ends with the Reflection ----------
  // The Reflection: when day 7 begins, every war stops and a rift opens for each player. Out of it comes a mirror
  // of that player's fleet (same mix of ships and upgrades), but its size is set by the season, not by the player.
  // All players fight it together in one war. Destroying a mirror fleet collapses its rift; mirrors that only retreat
  // regrow from their rifts every hour.
  function mirrorFleet(p) {
    const mult = 1 + REFLECT.season * (season.n - 1), s = (p.fleet && p.fleet.ships) || START_FLEET, tot = s.c + s.f + s.d;
    const mix = tot >= 3 ? { c: s.c / tot, f: s.f / tot, d: s.d / tot } : { c: 0.5, f: 0.4, d: 0.1 }, up = { ...((p.fleet && p.fleet.up) || {}) };
    const per = ["c", "f", "d"].reduce((a, k) => a + mix[k] * shipStat({ up }, k, "atk"), 0), n = REFLECT.atk * mult / per;
    const ships = Object.fromEntries(["c", "f", "d"].map((k) => [k, Math.round(mix[k] * n)])); if (!ships.c && !ships.f && !ships.d) ships.f = 1;
    const fl = newFleet(`The Other ${p.leader && p.leader.name ? p.leader.name : nameOf(p.pid)}`, ships); fl.up = { c: 0, f: 0, d: 0, ...up }; return fl;
  }
  function spawnMirror(p) {
    const id = "ai" + (5 + (p.slot % 5)); if (A(id)) return id;
    const home = ((p.planets || []).find((q) => q.st === "home") || {}).n || "the void";
    const fl = mirrorFleet(p);
    ai.list.push({ id, name: `Reflection of ${p.sysName || p.name}`, temper: "reflection", rift: true, mirror: p.pid, slot: p.slot, base: -100,
      planets: [{ n: `Rift of ${home}`, r: "relic", owner: null, home: true }], res: {}, fleet: fl, init: { ...fl.ships }, regenAt: now,
      opinion: {}, allies: [], overlord: null, envoyAt: {}, threat: {}, warAt: 0, buildAt: 0, annexedBy: null });
    return id;
  }
  function startCrisis() {
    season.crisis = { at: now };
    for (const w of live()) { w.ended = now; w.outcome = { by: null, term: "rift" }; ev(w, { kind: "peace", term: "rift" });
      for (const x of w.sides.flat()) if (F(x)) { goHome(F(x).fleet, x); F(x).fleet.loc.until = 0; } }
    for (const p of players) if (p.vassalOf && isAI(p.vassalOf)) { /* vassals fight too */ }
    const w = { id: Math.random().toString(36).slice(2, 10), sides: [[], []], score: {}, occ: [], siege: {}, events: [], t: now, started: now, beaten: {}, ex: [0, 0], crisis: true };
    wars.push(w); ev(w, { kind: "war", a: "rift", b: "players" });
    joinCrisis(w);
    tellAll("The rifts open. Every war stops. Out of each rift comes a mirror of a player's fleet, and it is coming home. Stand together: destroy the mirror fleets to close their rifts before the week ends.", "crisis");
  }
  function joinCrisis(w) {
    const added = [];
    for (const p of players) if (!w.sides[1].includes(p.pid)) { const m = spawnMirror(p); w.sides[0].push(m); w.sides[1].push(p.pid); added.push(m, p.pid); }
    if (!added.length) return;
    // every mirror is out before anyone decides: players fight together if the whole galaxy can, or post up at home
    for (const x of added) { const s = sideOf(w, x), fl = F(x).fleet; if (!alive(fl)) continue; fl.loc = { s: "dock", at: x };
      if (s === 1 && !online(x) && outmatched(w, x)) fl.loc.post = true; else launch(w, x, s, now); }
    regroup(w, now);
  }
  function seal(w, x, by) {
    const a = A(x); a.annexedBy = "sealed"; a.sealedAt = now; a.fleet.ships = { c: 0, f: 0, d: 0 };
    for (const y of by) renown(y, 40);
    tellAll(`${by.map(nameOf).join(" and ")} destroyed ${a.name}. Its rift collapses.`, "crisis");
    const left = ai.list.filter((m) => m.rift && !m.annexedBy);
    if (!left.length) { w.ended = now; w.outcome = { by: by[0], term: "sealed" }; season.crisis.won = now;
      for (const y of w.sides.flat()) if (F(y) && !isAI(y)) { goHome(F(y).fleet, y); F(y).fleet.loc.until = 0; }
      tellAll("The last rift collapses. The Reflection is beaten. The galaxy holds its breath until the week ends.", "crisis"); }
  }
  function crisisStep() {
    if (!season.crisis) startCrisis();
    if (season.crisis.won) return;
    const w = live().find((x) => x.crisis); if (!w) return;
    for (const x of live()) if (!x.crisis) { x.ended = now; x.outcome = { by: null, term: "rift" }; } // nothing else is fought while the rifts are open
    joinCrisis(w);
    // open rifts pour out fresh ships every hour (up to the mirror's first size)
    for (const a of ai.list) if (a.rift && !a.annexedBy) while (now - a.regenAt >= HOUR) { a.regenAt += HOUR;
      for (const k of ["c", "f", "d"]) a.fleet.ships[k] = Math.min(a.init[k], a.fleet.ships[k] + Math.ceil(a.init[k] * REFLECT.regen)); }
  }
  // The week is over: record the season, hand out rewards, and reset the galaxy. Technologies, ship upgrades,
  // generals and alliances carry over; worlds, goods, fleets and wars start again, and new AI empires rise.
  function rollSeason() {
    const n = season.n, mirrors = ai.list.filter((a) => a.rift), sealed = mirrors.filter((a) => a.annexedBy === "sealed");
    const won = mirrors.length > 0 && sealed.length === mirrors.length, fallen = season.fallen || {};
    const heroes = players.filter((p) => !fallen[p.pid] && (won || sealed.some((a) => a.mirror === p.pid)));
    for (const p of players) {
      const pts = fallen[p.pid] ? 0 : won ? 2 : sealed.some((a) => a.mirror === p.pid) ? 1 : 0;
      p.techPts = (p.techPts || 0) + pts;
      p.fleet.ships = { ...START_FLEET }; p.fleet.dmg = { c: 0, f: 0, d: 0 }; p.fleet.loc = { s: "dock" };
      p.vassalOf = null; p.planets = (p.planets || []).filter((q) => q.st === "home").slice(0, 1).map((q) => ({ n: q.n, r: q.r, st: "home" }));
      Object.assign(p, { sysName: "", allies: [], dev: 0, swarm: 0, pop: 8, age: 0, unrest: 10, routes: [], accepted: [], proj: null, season: n + 1 });
      tell(p.pid, { t: "season", msg: `Week ${n} is over. ${won ? "The rifts were closed." : mirrors.length ? `${sealed.length} of ${mirrors.length} rifts were closed.` : ""} ${pts ? `You earn ${pts} technology point${pts > 1 ? "s" : ""}.` : ""} A new week begins. Your technologies, ship upgrades and general come with you.` });
    }
    const story = !mirrors.length ? `Week ${n}: the galaxy stood empty when the rifts opened.`
      : won ? `Week ${n}: ${heroes.map((p) => p.sysName || p.name).join(", ") || "the players"} closed every rift. The Reflection was beaten back.`
      : `Week ${n}: the Reflection endured. ${sealed.length} of ${mirrors.length} rifts were closed${Object.keys(fallen).length ? `, and ${Object.keys(fallen).map(nameOf).join(", ")} fell to their own mirrors` : ""}.`;
    season.chronicle.push({ n, won, sealed: sealed.length, rifts: mirrors.length, foes: ai.list.filter((a) => !a.rift).map((a) => a.name), text: story });
    const start = season.start + SEASON_DAYS * DAY;
    season = { n: n + 1, start: now - start > SEASON_DAYS * DAY ? now : start, chronicle: season.chronicle.slice(-8) };
    ai = newAI(season.n); wars = [];
    tellAll(`Week ${season.n} begins. Name your new system. The AI empires return stronger. ${story}`, "season");
  }
  while (now >= season.start + SEASON_DAYS * DAY) rollSeason();
  if (players.length && crisisOn()) crisisStep();

  // ---------- AI peacetime behavior: hourly steps ----------
  const steps = Math.min(48, Math.floor((now - ai.last) / HOUR));
  for (let s = 0; s < steps; s++) {
    const t = ai.last + HOUR, ht = Math.max(0, Math.min(1, (t - season.start) / CRISIS_AT)), dy = 1 + Math.floor((t - season.start) / DAY);
    for (const a of ai.list) {
      if (a.annexedBy || a.rift) continue;
      for (const p of a.planets) if (!p.owner) a.res[p.r] = Math.min(400, (a.res[p.r] || 0) + 3);
      for (const pl of players) if (pl.vassalOf === a.id) for (const r of ["food", "ore", "fuel"]) a.res[r] = Math.min(400, (a.res[r] || 0) + 1);
      // The AI grows faster every day of the season and in every new season; dreadnoughts appear as the week goes on.
      if (Math.random() < AI_GROW[a.temper] * (1 + ht) * Math.sqrt(aiScale(season.n))) a.fleet.ships[Math.random() < 0.12 * ht ? "d" : Math.random() < 0.7 - 0.2 * ht ? "c" : "f"]++;
      // and it refits its fleet on day 3 and day 5
      { const up = Math.min(3, Math.max(0, season.n - 2)) + (dy >= 3 ? 1 : 0) + (dy >= 5 ? 1 : 0); for (const k of ["c", "f"]) a.fleet.up[k] = Math.max(a.fleet.up[k] || 0, Math.min(3, k === "c" ? up : up - 1)); }
      for (const pl of players) { const o = a.opinion[pl.pid] ?? a.base; a.opinion[pl.pid] = o + Math.sign(a.base - o); }
      if (a.overlord || ai.endedAt || t >= season.start + CRISIS_AT || crisisOn()) continue;
      // Hostile empires wait. Once a player's fleet gets close to theirs, they threaten; if the player keeps it up, they strike first.
      for (const pl of players) {
        if (pl.vassalOf || mutual(a.id, pl.pid) || warOf(a.id, pl.pid) || (a.opinion[pl.pid] ?? a.base) > -20 || t - ((a.struck || {})[pl.pid] || 0) < THREAT_REST * HOUR) { delete a.threat[pl.pid]; continue; }
        const ratio = power(pl.fleet) / Math.max(1, power(a.fleet));
        if (ratio < THREAT_AT * 0.75) { delete a.threat[pl.pid]; continue; }
        if (ratio < THREAT_AT) continue;
        if (!a.threat[pl.pid]) { a.threat[pl.pid] = t; tell(pl.pid, { t: "threat", msg: `${a.fleet.admiral} of ${a.name} sends word: "Your fleet grows bold. Keep building and we will come for you."` }); }
        else if (t - a.threat[pl.pid] >= THREAT_WAIT * HOUR && t - (a.warAt || 0) >= 12 * HOUR) {
          delete a.threat[pl.pid]; a.warAt = t; (a.struck ||= {})[pl.pid] = t; const w = startWar(a.id, pl.pid);
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
      // joint invasions on day 3 and day 5 of every season (none once the Reflection comes)
      // a lone player only faces the day-5 invasion, from one empire
      ai.invDone ||= 0; if (players.length === 1 && ai.invDone === 0) ai.invDone = 1;
      ai.invadeAt = INVASIONS[ai.invDone] != null ? season.start + INVASIONS[ai.invDone] : 0;
      if (ai.invadeAt && !ai.warned && now >= ai.invadeAt - WARN * HOUR) { ai.warned = true; tellAll(ai.invDone === 0 && players.length > 1 ? `Spies report an AI empire massing its fleet. It will invade within ${WARN} hours. Ally with the other players now.` : `Spies report the AI empires massing their fleets together. They will invade within ${WARN} hours. Ally with the other players now.`); }
      if (ai.invadeAt && now >= ai.invadeAt && !crisisOn()) {
        const targets = invasionTargets();
        const target = [...targets].sort((x, y) => power(y.fleet) + 3 * (y.planets || []).length - power(x.fleet) - 3 * (x.planets || []).length)[0];
        const lead = target && free.filter((a) => !mutual(a.id, target.pid)).sort((x, y) => power(y.fleet) - power(x.fleet))[0];
        if (lead) {
          // the first invasion of a season is one empire; later ones bring the others along
          const first = ai.invDone === 0 || players.length === 1;
          const w = startWar(lead.id, target.pid, first); w.invasion = true;
          tellAll(`${w.sides[0].length > 1 ? "The AI empires move together! " : "An AI empire attacks! "}${w.sides[0].map(nameOf).join(", ")} ${w.sides[0].length > 1 ? "invade" : "invades"} ${nameOf(target.pid)}. Any player can join the defense from the Wars panel.`);
        }
        ai.invDone++; ai.invadeAt = INVASIONS[ai.invDone] != null ? season.start + INVASIONS[ai.invDone] : 0; ai.warned = false;
      }
    }
  }
  for (const w of live()) { let n = 0; while (!w.ended && w.t <= now && n++ < MAX_STEPS) stepWar(w); if (now - w.t > MAX_STEPS * STEP) w.t = now; }
  // AI makes peace: it enforces a demand when it can, or accepts white peace after losing its fleet.
  for (const w of live()) for (const x of w.sides.flat()) if (isAI(x) && !w.crisis && !w.ended) {
    const s = sideOf(w, x), mine = w.score[x] || 0, foe = w.sides[1 - s][0]; w.ex ||= [0, 0];
    // invasions are out for conquest: they don't settle for reparations
    if (!w.invasion && mine >= termCost(w, "reparations", 1 - s) && foe && !isAI(foe)) await makePeace(w, x, "reparations", foe, 0, ["ore", "fuel", "food"]);
    else if ((w.beaten[x] && !alive(A(x).fleet) && (w.score[foe] || 0) > mine) || w.ex[s] >= 50) w.aiWhite = true;
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
    if (term === "liberate") { const vs = players.filter((p) => p.vassalOf === target); if (!vs.length) return "They hold no player as a vassal.";
      for (const v of vs) { v.vassalOf = null; tell(v.pid, { t: "liberated", msg: `${nameOf(by)} has forced ${nameOf(target)} to set you free. You are no longer a vassal.` }); } }
    // an AI empire that falls under a player frees the players it held as vassals
    if ((term === "annex" || term === "vassal") && isAI(target) && homeHeld) for (const v of players.filter((p) => p.vassalOf === target)) { v.vassalOf = null; tell(v.pid, { t: "liberated", msg: `${nameOf(target)} has fallen to ${nameOf(by)}. You are free again.` }); }
    if (term === "annex") { if (!isAI(target)) return "Only AI empires can be annexed."; if (!homeHeld) return "Annexation needs their home world occupied."; const a = A(target); a.planets.forEach((p) => { if (!p.owner) { planets.push({ n: p.n, r: p.r, from: target }); p.owner = by; } }); a.annexedBy = by; a.fleet.ships = { c: 0, f: 0, d: 0 }; }
    w.score[by] -= termCost(w, term, 1 - s);
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
  else if (op === "tick") { /* the scheduled function: the steps above already ran */ }
  else if (op === "promote") { if (!self) fail("No system."); else if (!DOCTRINE[body.skill]) fail("Unknown doctrine."); else if (self.doctrines.length >= tierOf(self.renown)) fail("No promotion waiting.");
    else { self.doctrines.push(body.skill); general(self); out.msg = `Promoted to ${RANKS[self.doctrines.length]}.`; } }
  else if (op === "resetgen") { if (self) { self.renown = 0; self.doctrines = []; general(self); } }
  else if (op === "leave") { await store.delete(me); await store.delete("in-" + me); for (const w of live()) if (sideOf(w, me) >= 0) w.ended = now; }
  else if (op === "sync") {
    const box = await inbox(me);
    let slot = self ? self.slot : -1;
    if (slot < 0) { const taken = new Set(players.map((p) => p.slot)); for (let i = 0; i < MAX; i++) if (!taken.has(i)) { slot = i; break; } }
    if (slot < 0) { out = { full: true }; status = 409; }
    // a save from last season is stale: the client resets its system first, then syncs again
    else if (body.sys && self && (int(body.sys.season, 0, 1e6) || 1) !== season.n) out.stale = true;
    else if (body.sys && !box.length) { const rec = cleanSys(body.sys, me, slot, self); rec.season = season.n; if (self) Object.assign(self, rec); else players.push(rec); general(self || rec); }
    out.pid = me; out.slot = slot; out.inbox = box.splice(0);
  } else if (!self) fail("Open Systems first to claim a system.");
  else if (op === "war") {
    const t = ref(body.target);
    if (!F(t) || t === me || (isAI(t) && A(t).annexedBy)) fail("No such system.");
    else if (isRift(t)) fail("You are already at war with the Reflection.");
    else if (crisisOn() && !season.crisis?.won) fail("The rifts are open. Every war waits until they close.");
    else if (mutual(me, t)) fail("You can't declare war on an ally. End the alliance first.");
    else { const w = startWar(me, t); await tell(t, { t: "war", msg: `${nameOf(me)} has declared war on you! ${self.fleet.admiral} is coming.` }); out.war = w.id; }
  } else if (op === "join") {
    const w = live().find((x) => x.id === body.war); const s = w ? [0, 1].find((k) => w.sides[k].some((x) => mutual(x, me)) || (w.sides[k].some((x) => !isAI(x)) && w.sides[1 - k].every(isAI))) : undefined;
    if (!w || s === undefined || sideOf(w, me) >= 0) fail("You can join a war your ally is fighting, or any war against the AI empires.");
    else { w.sides[s].push(me); regroup(w, now); for (const x of w.sides[1 - s]) await tell(x, { t: "war", msg: `${nameOf(me)} has joined the war against you.` }); }
  } else if (op === "build") {
    const k = ["c", "f", "d"].includes(body.ship) ? body.ship : null; if (!k) fail("Unknown ship."); else { self.fleet.ships[k]++; out.msg = "The new ship joins your fleet wherever it is."; }
  } else if (op === "tech" || op === "techpt") {
    const k = TECH[body.tech] ? body.tech : null; self.techs ||= {};
    if (!k) fail("Unknown technology.");
    else if ((self.techs[k] || 0) >= TECH[k]) fail("Already at the highest level.");
    else if (op === "techpt" && !(self.techPts > 0)) fail("No technology points left.");
    else { if (op === "techpt") self.techPts--; self.techs[k] = (self.techs[k] || 0) + 1; out.msg = "Research complete. It stays with you in every season."; }
  } else if (op === "invest") {
    // Investing: I cover the foreign rare goods another player needs for today; they pay the credits I still need today.
    // Nothing moves until they accept, and it costs me no goods.
    const t = P(ref(body.to)), cr = int(body.credits, 1, 999), day = dayOf();
    if (!t || t.pid === me) fail("No such player.");
    else if (warOf(me, t.pid)) fail("You can't invest in an empire you are at war with.");
    else if ((t.offers || []).some((o) => o.from === me && o.day === day && o.season === season.n)) fail("You already offered them an investment today.");
    else { t.offers = [...(t.offers || []).filter((o) => o.season === season.n && o.day === day), { id: Math.random().toString(36).slice(2, 10), from: me, credits: cr, day, season: season.n, at: now }].slice(-4);
      tell(t.pid, { t: "invest", msg: `${nameOf(me)} offers to invest in you: today's foreign rare goods for ${cr} credits.` }); out.msg = "Investment offered. It takes effect when they accept."; }
  } else if (op === "investok" || op === "investno") {
    self.offers = (self.offers || []).filter((x) => x.season === season.n && x.day === dayOf()); // offers last until the day ends
    const o = self.offers.find((x) => x.id === body.offer);
    if (!o) fail("That offer has expired.");
    else { self.offers = self.offers.filter((x) => x !== o);
      if (op === "investok") { const paid = Math.min(o.credits, int(body.paid, 0, 999));
        tell(o.from, { t: "investpaid", credits: paid, msg: `${nameOf(me)} accepted your investment and paid you ${paid} credits.` }); out.msg = "Investment accepted."; }
      else { tell(o.from, { t: "investno", msg: `${nameOf(me)} declined your investment.` }); out.msg = "Offer declined."; } }
  } else if (op === "stance") {
    const w = live().find((x) => x.id === body.war), mode = body.mode === "attack" ? "attack" : "hold";
    if (!w || !defender(w, me)) fail("Only the defending side chooses a stance.");
    else { (w.stance ||= {})[me] = mode; if (w.ask) delete w.ask[me]; const fl = self.fleet, s = sideOf(w, me);
      if (mode === "attack" && alive(fl) && (fl.loc.s === "guard" || (fl.loc.s === "dock" && !(fl.loc.until > now)))) launch(w, me, s, now);
      if (mode === "hold" && fl.loc.s === "move" && fl.loc.from === me && !fl.loc.back) standGuard(w, me);
      out.msg = mode === "attack" ? "Your fleet goes on the attack." : "Your fleet holds position over your worlds."; }
  } else if (op === "upgrade") {
    const k = ["c", "f", "d"].includes(body.ship) ? body.ship : null; if (!k) fail("Unknown ship."); else if (self.fleet.up[k] >= 3) fail("Fully upgraded."); else { self.fleet.up[k]++; out.msg = "Upgrade installed across the fleet."; }
  } else if (op === "peace") {
    const w = live().find((x) => x.id === body.war), term = TERMS[body.term] !== undefined ? body.term : null, t = ref(body.target);
    const s = w ? sideOf(w, me) : -1, sc = w ? w.score[me] || 0 : 0; if (w) w.ex ||= [0, 0];
    if (!w || s < 0) fail("No such war.");
    else if (w.crisis) fail("The Reflection does not bargain. Destroy its fleets to close the rifts.");
    else if (!term) fail("Unknown treaty.");
    else if (term === "white") {
      const theirs = Math.max(0, ...w.sides[1 - s].map((y) => w.score[y] || 0));
      if (sc >= theirs || w.aiWhite || w.ex[1 - s] >= 50 || Object.keys(w.beaten).some((x) => sideOf(w, x) === 1 - s)) { const r = await makePeace(w, me, "white", w.sides[1 - s][0]); out.msg = "White peace signed. Everyone goes home."; }
      else { w.whiteOffer = me; out.msg = "White peace offered. They will accept once they are losing."; }
    } else if (sideOf(w, t) !== 1 - s) fail("Pick an enemy in this war.");
    else if (sc < termCost(w, term, 1 - s)) fail(`That treaty needs ${termCost(w, term, 1 - s)} war score (${TERMS[term]} before their war exhaustion). You have ${sc}.`);
    else { const r = await makePeace(w, me, term, t, int(body.planet, 0, 11), body.want); if (typeof r === "string") fail(r); else out = { ok: true, ...r, msg: "Treaty signed." }; }
  } else if (op === "ai") {
    const a = A(ref(body.ai)), act = body.act;
    if (!a || a.annexedBy) fail("No such empire.");
    else if (a.rift) fail("The Reflection has nothing to say to you.");
    else if (act === "envoy") { if (now - (a.envoyAt[me] || 0) < HOUR) fail("Your last envoy is still on the road. Try again within the hour."); else { a.envoyAt[me] = now; opinion(a, me, 5); out.msg = `${a.name} receives your envoy warmly.`; } }
    else if (act === "gift") { opinion(a, me, 8); out.msg = `${a.name} accepts your gift.`; }
    else if (act === "ally") { if ((a.opinion[me] ?? a.base) < 50) fail(`${a.name} doesn't trust you enough yet. Get their opinion to 50.`); else if (warOf(a.id, me)) fail("Make peace first."); else { if (!a.allies.includes(me)) a.allies.push(me); out.msg = `${a.name} agrees to an alliance.`; } }
    else if (act === "unally") { a.allies = a.allies.filter((x) => x !== me); opinion(a, me, -30); out.msg = `${a.name} is offended.`; }
  }

  for (const a of ai.list) if (a.overlord && !P(a.overlord)) a.overlord = null;
  for (const p of players) if (p.offers) p.offers = p.offers.filter((o) => o.season === season.n && o.day === dayOf());
  await store.setJSON("ai", ai); await store.setJSON("season", season); await store.setJSON("wars", wars.filter((w) => !w.ended || now - w.ended < HOUR));
  for (const p of players) await store.setJSON(p.pid, p);
  for (const pid in inboxes) await store.setJSON("in-" + pid, inboxes[pid]);
  const view = (a) => ({ ...a, opinion: a.opinion[me] ?? a.base, envoyAt: undefined, threat: undefined, threatens: !!(a.threat || {})[me], strikeAt: (a.threat || {})[me] ? Math.max(a.threat[me] + THREAT_WAIT * HOUR, (a.warAt || 0) + 12 * HOUR) : 0, myAlly: a.allies.includes(me) });
  const seasonView = { n: season.n, start: season.start, day: dayOf(), heat: Math.round(heat() * 100) / 100, ends: season.start + SEASON_DAYS * DAY, crisisAt: season.start + CRISIS_AT,
    crisis: season.crisis ? { at: season.crisis.at, won: season.crisis.won || 0, rifts: ai.list.filter((a) => a.rift).length, sealed: ai.list.filter((a) => a.rift && a.annexedBy).length } : null,
    invasions: INVASIONS.map((d) => season.start + d), chronicle: season.chronicle.slice(-3) };
  return Response.json({ ...out, now, season: seasonView, systems: players, ai: ai.list.map(view), scourge: { invadeAt: ai.invadeAt, endedAt: ai.endedAt, free: freeAI().length, next: !ai.endedAt && freeAI().length ? (nextTarget() || {}).pid || null : null }, rulesAI: { THREAT_AT }, ranks: { RANKS, PROMOTE, DOCTRINE }, wars: wars.filter((w) => !w.ended || now - w.ended < 10 * 60000), max: MAX, rules: { SHIP, UPG, TERMS, STEP, TRAVEL, TECH, REFLECT } }, { status, headers });
};

export const config = { path: "/api/systems" };
