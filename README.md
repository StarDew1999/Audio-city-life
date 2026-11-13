# Roamerica

An accessible audio city life game, built for screen readers. Play free at https://audio-city-life.audiocitylife.workers.dev (the permanent home). The old Netlify links were paused in November 2026 after hitting Netlify's usage limits.

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

## Rules for every update
- Update the in-game How-to guide (guideScreen) with every change, big or small, including steps for how to use each new thing. New guide sections go at the end, just before What's new (add them to the NEW list too).
- Rewrite the WHATSNEW message in index.html with every update so it is always current: newest changes first, and drop items older than the last few updates (the How-to guide keeps the details). Players hear it on the start screen once after each update, and any time with the What's new button.
- Bump VERSION in index.html with every update, so What's new plays again for everyone.
- Test before uploading. Only real recorded sounds (CC0 or Pixabay license).

## Cloudflare (free live chat)
- `wrangler.jsonc` + `cloudflare/worker.mjs` run the game and live chat on Cloudflare Workers (free plan). Chat uses one Durable Object with a live WebSocket link; the game falls back to normal requests if the link drops.
- The chat logic is shared with Netlify in `netlify-server/lib/core.mjs`.
- While players are on both servers, a bridge copies chat lines, private messages, voice messages, who's online, saves, profiles, shops and notification sign-ups between Netlify and Cloudflare every 20 seconds. The bridge key is stored privately (Netlify env var BRIDGE_KEY and the Cloudflare D1 database acl-config), never in this repo.
- Cloudflare deploys automatically from this GitHub repo on every push to main (Workers Builds).
