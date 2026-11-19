// Scheduled every 5 minutes: steps wars, AI empires and the season even when no player has the game open,
// so a war declared on you while you are away really is fought while you are away.
import systems from "./systems.mjs";
export default async () => {
  await systems(new Request("http://localhost/api/systems", { method: "POST", body: JSON.stringify({ id: "scheduled-tick-0000", op: "tick" }) }));
};
export const config = { schedule: "*/5 * * * *" };
