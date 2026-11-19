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

## Files
- `index.html`: the whole game in one file.
- `manifest.json` and the icons: let phones add the game to the home screen.
- `netlify/functions/scores.mjs`: the scoreboard API.
- `package.json`: lists the one dependency, `@netlify/blobs`.
- `netlify.toml`: Netlify settings.
