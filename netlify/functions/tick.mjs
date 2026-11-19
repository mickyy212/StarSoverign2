// Scheduled every 5 minutes: steps wars, AI empires and the week's clock in every galaxy, even when no player has the game open,
// so a war declared on you while you are away really is fought while you are away.
import systems from "./systems.mjs";
import { getStore } from "@netlify/blobs";
const call = (server) => systems(new Request("http://localhost/api/systems", { method: "POST", body: JSON.stringify({ id: "scheduled-tick-0000", op: "tick", server }) }));
export default async () => {
  const list = (await getStore("servers").get("list", { type: "json" })) || [];
  for (const g of [{ id: "main" }, ...list]) await call(g.id);
};
export const config = { schedule: "*/5 * * * *" };
