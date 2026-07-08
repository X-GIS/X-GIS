#!/usr/bin/env bash
# Render every Mermaid source in this directory to a committed SVG under
# ../public/diagrams/. Diagrams are PRE-RENDERED (not built at site-build time)
# so the site build stays a pure static build — no headless browser in CI, no
# client-side mermaid.js, and no conflict with astro-expressive-code over the
# ```mermaid fence. Re-run this after editing a .mmd; commit the .svg alongside.
#
# Needs a Chromium for the (one-off) render. mermaid-cli drives puppeteer; point
# it at any local Chrome/Chromium via PUPPETEER_EXECUTABLE_PATH. In the X-GIS
# dev container the Playwright Chromium works:
#   PUPPETEER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-*/chrome-linux/chrome ./render.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${PUPPETEER_EXECUTABLE_PATH:?set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary}"
export PUPPETEER_SKIP_DOWNLOAD=1
out=../public/diagrams
mkdir -p "$out"
for f in *.mmd; do
  name="${f%.mmd}"
  bunx @mermaid-js/mermaid-cli -i "$f" -o "$out/$name.svg" \
    -b transparent -c mermaid.config.json -p puppeteer.json
  echo "rendered $out/$name.svg"
done
