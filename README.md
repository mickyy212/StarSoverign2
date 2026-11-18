# Star Sovereign II, 3rd Edition

A pixel-art sci-fi roleplay game that runs in the browser. You rule a star empire for twelve turns, then face what comes for you at the end. Win to unlock the DLC, The Thal Reckoning.

## Play locally
Open `index.html` in any browser. No install or build step is needed.

## Deploy on Netlify
1. Push this repository to GitHub.
2. In Netlify, choose **Add new site → Import an existing project → GitHub**, then pick this repository.
3. Netlify reads `netlify.toml`. Leave the build command empty. The publish directory is the top of the repository.
4. Click **Deploy**. Every push to the main branch redeploys the site.

## What's in the repository
- `index.html`: the whole game in one file. The pixel font and all graphics are embedded.
- `manifest.json` and the icons: let phones add the game to the home screen.
- `netlify.toml`: Netlify settings.

Saves and win-rate records are kept in each player's browser (localStorage).
