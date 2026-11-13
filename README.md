# Audio City Life

An accessible audio city life game, built for screen readers. Play free at https://audio-city-life.netlify.app

- The game (index.html, sounds, sw.js, manifest.json, icons) is served from this repository by GitHub Pages: https://stardew1999.github.io/Audio-city-life/
- netlify-server/ is deployed to the Netlify site (ID 6184a8fb-7a14-45bc-868c-d09fa4a9a38e). It keeps the original web address, runs the chat server at /api/live, and quietly fetches everything else from GitHub Pages. Only deploy it to Netlify when netlify-server/ changes, since each Netlify deploy uses 15 credits.
- Game updates only need a push to main. No Netlify deploy needed.
- Sounds are real recordings, CC0 or Pixabay license only.

## Free updates (no credits)
The game is played at https://play--audio-city-life.netlify.app, a Netlify *branch deploy* named "play". Branch deploys use no credits, so the game can be updated any time:
1. Make the change in this repo and push to main.
2. Zip index.html, sw.js, manifest.json, icons, sounds/, package.json, netlify/functions (from netlify-server/) and netlify-server/play-netlify.toml renamed to netlify.toml.
3. Get an upload link from the Netlify connector's deploy-site tool and run: node netlify-server/branch-upload.mjs "<proxy-path>" 6184a8fb-7a14-45bc-868c-d09fa4a9a38e play  (it reads /tmp/branchdeploy/s.zip).
Sounds load from jsDelivr (cdn.jsdelivr.net/gh/StarDew1999/Audio-city-life@main/sounds/), with the uploaded copy as a backup.
