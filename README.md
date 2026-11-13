# Audio City Life

An accessible audio city life game, built for screen readers. Play free at https://audio-city-life.netlify.app

- The game (index.html, sounds, sw.js, manifest.json, icons) is served from this repository by GitHub Pages: https://stardew1999.github.io/Audio-city-life/
- netlify-server/ is deployed to the Netlify site (ID 6184a8fb-7a14-45bc-868c-d09fa4a9a38e). It keeps the original web address, runs the chat server at /api/live, and quietly fetches everything else from GitHub Pages. Only deploy it to Netlify when netlify-server/ changes, since each Netlify deploy uses 15 credits.
- Game updates only need a push to main. No Netlify deploy needed.
- Sounds are real recordings, CC0 or Pixabay license only.
