#!/bin/sh
# Copies the game files into dist/ for Cloudflare. Sounds load from jsDelivr, so they are not copied.
set -e
rm -rf dist && mkdir -p dist
cp index.html sw.js manifest.json icon-192.png icon-512.png dist/
cat > dist/_headers <<'H'
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
H
echo "Built dist for Cloudflare"
