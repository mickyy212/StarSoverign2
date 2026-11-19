# Star Sovereign II, 3rd Edition

A pixel-art sci-fi roleplay game that runs in the browser. You rule a star empire for twelve turns, then face what comes for you at the end. Win to unlock the DLC, The Thal Reckoning.

## Deploy on Netlify
1. Upload everything in this repository to GitHub, including the `netlify` folder.
2. In Netlify, choose **Add new site → Import an existing project → GitHub**, then pick this repository.
3. Leave the build command empty and click **Deploy**. Netlify reads `netlify.toml` and installs the one dependency itself.

## Arcade names and the scoreboard
- On a player's first visit, the game asks for an arcade name. It is saved on that device.
- Each device keeps lifetime win rates for Easy, Normal and Hard, separately for the main story and the DLC.
- Results are sent to `/api/scores`, a Netlify Function in `netlify/functions/scores.mjs`. It stores one record per device in Netlify Blobs, so everyone sees the same scoreboard.
- Players can remove themselves from the scoreboard (Remove me, then tap again to confirm). This deletes their name and lifetime stats.
- If the function isn't available (for example, when the page is opened as a plain file), the scoreboard shows only that device.

Scores are reported by the player's browser, so a determined player could fake them. That's fine for a friendly scoreboard.

## Other features
- **Tutorial:** a guided run for each difficulty, with a tip each turn. Tutorial runs aren't saved and don't count.
- **Empire storylines:** each empire has 3 events of its own (2 appear per run) and its own voice lines on shared events.
- **Experimental button** (bottom of the start screen, off by default): turns on Quantum suicide and reveals the Narrative mode button (branching events).
- **Quantum suicide:** a final-battle option. It gives a 10% chance of +10 power. Afterwards, the next run (or the DLC, if you go straight into it) has a 1 in 3 chance of sudden quantum death.

## Achievements and credits
- **Achievements** (button next to Scoreboard): 20 in all, 10 common and 10 rare, kept on each device. A small banner appears when one unlocks.
- **Credits** for Systems multiplayer, per run: main story win 8 / 25 / 50 (Easy / Normal / Hard), loss 2 / 5 / 8; DLC win 12 / 35 / 70, loss 3 / 7 / 12; winning both back to back adds 20% of both wins. Each empire's button and the Rules show this.

## Systems multiplayer (shared galaxy: survival, trade, diplomacy and war)
- **One week per game.** Each day is harder than the last. On day 7 the Reflection comes: a mirror of every player's fleet, which all players fight together. Then everything resets and players name new systems. Technologies, ship upgrades and generals carry over, and every week starts a little harder. The in-game **Rules** button lists the exact numbers.
- **Credits needed today:** a daily guide (30 on day 1, then 50 + 5 per day, +5 per week) measured with `tools/systems-sim.mjs`. Systems pays taxes every hour; main-game runs earn the rest.
- **The world keeps turning.** `netlify/functions/tick.mjs` is a Netlify scheduled function that runs every 5 minutes, so wars, AI empires and the week's clock move on while nobody is online. Sieges slow down while the whole defending side is away.
- **Investing:** from another player's panel, offer them a day of the foreign rare goods they need in return for the credits you still need today. It costs you no goods and only happens if they accept.
- **Breaking news:** a sticker slaps onto the warning banner when an AI attack is planned or the rifts are about to open.
- The **Systems multiplayer** button opens your star system. Up to 5 players share one galaxy with 3 AI empires (`netlify/functions/systems.mjs`, Netlify Blobs store "systems").
- **Resources:**
  - Common goods (Food, Water, Ore, Fuel) come from your own planets and AI worlds.
  - Each player slot makes one rare good nobody else can: Crystal, Plasma, Spice, Alloy or Relics.
  - From the Settlement age on, your people want 1, then 2, then 3 kinds of *foreign* rare goods. You can only get those by trading, demanding them in treaties, or taking them.
- **Survival:** needs grow with each age, and shortages raise unrest; at 60%+, riots halve production. You can explore and colonize your planets, run festivals or send peacekeepers. "Reset planet" starts over and keeps your credits.
- **Trade:** pick the resources and amounts per hour, or press **Auto** to propose a swap that covers what each side is short of. Allies trade in full; otherwise 1 unit per hour is lost in transit. AI empires trade while they like you, and wars suspend trade.
- **AI empires:** Zhaal Brood (aggressive raiders), Ost Guild (merchants) and Silent Vigil (wary).
  - You raise their opinion with envoys (5 credits) and gifts (10 of a resource).
  - At opinion 50 they'll ally with you. Allied AI empires defend you and join your wars.
  - Hostile AI raid players.
- **War is real time.**
  - Every faction has one fleet under an admiral with a generated name; AI admirals are fixed (Swarm-Marshal Grisk the Devourer, Commodore Penhallow of the Gilded Fleet, Warden-Admiral Sael, Who Does Not Blink).
  - Once war is declared, fleets set out on their own, meet in the middle and fight. Battles are mostly decided by ship stats, with a little luck.
  - The losing fleet retreats home to rebuild. Destroying a fleet earns 36–65 war score.
  - Winners then siege enemy worlds, colonies first:
    - Holding orbit over a colony for 60 seconds occupies it.
    - Home worlds are heavily fortified (fort 3, and their guns damage the fleet every 30 seconds).
    - Every 30 seconds a siege die is rolled: d14 + progress + fleet siege bonus − fort. A 1 brings disease, 2–4 is status quo, 5–11 means supplies run short (+1 progress), 12–13 breaches the walls (+2 progress), and 14+ means the planet surrenders.
    - A home world that falls is worth 50 war score.
  - Ships built during a war join the fleet wherever it is. A docked fleet counterattacks an orbiting enemy when it has a good chance to win.
- **Ships:** each has attack, hull and siege, and each type has 3 upgrades costing 15, 30 and 50 credits.
  - Corvette: attack 1, hull 2. Costs 8 credits and 2 Ore.
  - Frigate: attack 3, hull 5, siege 1. Costs 20 credits, 4 Ore and 2 Fuel.
  - Dreadnought: attack 8, hull 14, siege 2. Costs 55 credits, 10 Ore and 6 Fuel.
- **Treaties** cost war score:
  - White peace is always available once you've destroyed their fleet.
  - One occupied colony costs 45 (about 70% of fleet victories earn enough).
  - Reparations cost 45, taking 30% of their stock (max 30) of what you need most.
  - Colony plus reparations costs 90.
  - With their home world occupied: every occupied colony costs 80, vassalage 80, and annexing an AI empire 100.
  - Allies in a war earn equal score.
- **Galaxy map:** tap a star once to select it and open diplomacy; tap it again to see its planets. The first time you open Systems, you name your system and your home world.
- **Animations:** trade ships fly along trade routes on the galaxy map, raids fly between stars, and invasions play out inside the target system.
- **Credits** come from finished runs, with harder difficulties paying more:
  - Main story, win / loss: Easy 8 / 2, Normal 25 / 5, Hard 50 / 8.
  - DLC, win / loss: Easy 12 / 3, Normal 35 / 7, Hard 70 / 12.
  - Going from a main-story win straight into the DLC adds 20%. Tutorial runs earn nothing.

## Co-op, the AI scourge and the road to Type II
- **Work together.** Colonies, ship upgrades, planetary defenses and every development project need rare goods from the other players in the galaxy. Costs only ask for rare goods someone actually holds (another player's specialty, or rare goods an AI empire took in a war). If you are the only player, every cost uses your own rare good, so you're never locked out. With 2 or more players, each needs the others'. Smugglers sell 3 of a foreign rare good for 25 credits as an expensive fallback.
- **Planetary defenses:** 3 levels per owned planet (Orbital guns, Shield grid, Fortress moon). Each level adds +1 fort and +3 guns to sieges of that world, and makes colonies take longer to occupy.
- **The AI scourge:**
  - The AI empires stand together. When any AI fights a player, the other free AIs usually join (aggressive always, wary 70%, merchant 40%), unless they're allied with or friendly to that player.
  - Hostile AIs leave weak players alone. Once a player's fleet reaches 80% of theirs, they send a threat. If the fleet is still that strong 2 hours later, they strike first.
  - 72 hours after the first player arrives, and then every 48 hours, the free AIs invade a player together (the strongest one not already fighting them). Every player gets a warning 12 hours before.
  - Any player can join a war against the AI empires, with or without an alliance.
  - The scourge ends when every AI empire is annexed or vassalized by players.
- **Path to Type II:**
  - Your home world develops through 4 stages: Landfall outpost, Planetary grid, Orbital industry, then Interplanetary network.
  - Each stage is a project paid in planet goods and foreign rare goods, and takes 8, 16 or 24 hours. Each stage also needs your home world to be old enough and to have enough established colonies.
  - Stages decide how many colonies you can run (1, 2, 3, then any number).
  - Colonies start at 1 output an hour and grow to 3 over 2 days.
  - After the last stage, you build a Dyson swarm in 4 segments of 12 hours each. Every segment adds +1 of each common good an hour. Finishing the Interplanetary network makes you Type I (Kardashev 1.0). The finished swarm harnesses your whole star: a Type II civilization (Kardashev 2.0), shown with a ✦ on the galaxy map.

## Warnings, leaders, generals and events
- **War warnings:** a banner at the top of Systems shows every war that is coming, worst first:
  - an AI that has threatened you, with a countdown to its attack and how to call it off (drop below 60% of its fleet);
  - a hostile AI that is watching your fleet (55% or more of theirs);
  - the next joint AI invasion within 24 hours, with its likely target.
  The banner pulses red when the danger is aimed at you. The server sends `strikeAt` on each AI and `scourge.next` (the likely target).
- **Starting fleet:** every new player starts with 3 corvettes and 1 frigate (attack 6, about half an AI fleet), so they're too small to draw AI threats at first.
- **Leader:** after naming your system you create a leader: species, look, name and title. Other players see the leader's portrait in diplomacy. Edit it from your home world or the galaxy panel.
- **General:** your leader commands your fleet as Captain, then Commodore, Admiral and Grand Admiral.
  - Renown comes from battles (win 10, destroy a fleet 25, lose 3), siege rounds (2), occupying a colony (8) and taking a home world (30).
  - Promotions come at 40, 120 and 300 renown. Each lets you pick a doctrine: Attack (+5% fleet attack) or Siege (+10% siege strength, 5% less damage from planetary guns).
  - Renown is kept on the server, so a client can't fake it. Resetting your planet resets renown and doctrines.
- **Events:** one choice event per real hour (12 events, about 2 in 3 good). Choices change food, water, ore, fuel, your rare good, people or unrest at once. Risky choices show their odds. Only 2 events are saved up: if you're away 5 hours, you get 2, not 5.

## Battle, siege and invasion animations
- **Battle box:** the replay runs at a third of real speed (about 19 seconds). Only players fighting in that battle see it.
- **Colours:** every faction flies its own colour, on the map and in battle.
  - Players by slot: cyan, green, orange, violet, pink.
  - AI empires: Zhaal red, Ost amber, Vigil silver.
  - Gold pips mark upgraded ships.
- **Grand battles:** a war with more than two factions sends every fleet to central space. The fleets wait up to 15 seconds for anyone still on the way, then fight one grand battle in a large box that names each faction.
- **Fleet power:** a single number, the square root of attack × hull. Battles are decided by attack × hull, so the higher number usually wins, and double the power almost always wins.
  - It shows on every fleet line and on both sides of the battle box.
  - Next to "Declare war" and in each war, "In a battle now: about N% to win" replays the server's battle rules 300 times with random luck. It also warns how the odds change when other AIs pile in.
- **Invasion:** while a fleet holds orbit over an undefended colony, drop pods stream down. When the colony falls, a flag in the invader's colour goes up.
- **Siege rounds** (every 30 seconds on a home world) play in a SIEGE box over the world, about 12 seconds, one captioned step at a time:
  1. The fleet opens fire, and shells hit the planet's shield.
  2. The result appears, with the siege total out of the 14 needed.
  3. The planet's guns (one turret per defense level, plus one) hit back, and every ship they destroy is boxed in red and explodes.
  4. A line shows what was lost, or "No ships lost". A shattered fleet is shown retreating.
  The box appears in the system view for anyone watching, and on the galaxy map for players in that war.

## War exhaustion
- **What it is:** each side of a war has war exhaustion from 0 to 100%, shown as two bars in every war.
- **What raises it:**
  - time at war: +12 an hour;
  - ships lost: corvette 1, frigate 2, dreadnought 4;
  - a fleet destroyed: +10;
  - a failed counterattack (your fleet sorties while your worlds are besieged, and loses): +6 more;
  - each siege round on your home world: (1 + population/10) × 0.5, 1 or 2, depending on the result;
  - a colony occupied: +6;
  - a home world taken: 25 + population/4.
- **What it does:**
  - The tired side's enemies pay less war score for treaties, up to 60% off at 100%. The treaty buttons show the new cost and what it was before.
  - At 50% or more, a side accepts white peace. Exhausted AIs give in the same way.
- **Where it shows:** battle and siege boxes show how much exhaustion each side gained, and a failed counterattack is called out.

## Your data survives updates
- **Shared galaxy:** the galaxy (every player's system, the AI empires and the wars) lives in Netlify Blobs. Blobs are stored per site, not per deploy, so pushing a new version to GitHub never wipes it.
- **Old data is upgraded, never reset:** the server fills in missing fields on old records instead of starting over.
- **On each device:** your system is also saved in the browser, along with a backup copy. Loading upgrades old saves in place and never throws them away.
- **Restoring:** if a device loses its save but keeps its arcade id, opening Systems restores the system from the server's copy (the `mine` op).
- **The one thing that does wipe it:** deleting the Netlify site, or changing the store name "systems".

## Files
- `index.html`: the whole game in one file.
- `manifest.json` and the icons: let phones add the game to the home screen.
- `netlify/functions/scores.mjs`: the scoreboard API.
- `netlify/functions/systems.mjs`: the shared Systems multiplayer galaxy API.
- `netlify/functions/tick.mjs`: scheduled every 5 minutes; keeps the galaxy running while everyone is offline.
- `package.json`: lists the one dependency, `@netlify/blobs`.
- `netlify.toml`: Netlify settings.
