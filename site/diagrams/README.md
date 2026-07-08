# Blog diagrams

Mermaid sources (`*.mmd`) for blog-post figures, pre-rendered to committed SVGs
under `../public/diagrams/` and embedded in posts as
`<figure><img src="/diagrams/<name>.svg" …></figure>`.

Why pre-rendered rather than build-time: it keeps the site build a pure static
build (no headless browser in CI, no client-side mermaid.js, no client JS at
all — matching the KaTeX "build-time only" rule), and avoids a fight with
astro-expressive-code over the ```mermaid fence.

Edit a `.mmd`, then re-render and commit both:

```sh
PUPPETEER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-*/chrome-linux/chrome ./render.sh
```

`mermaid.config.json` pins the dark theme + mono font so the SVGs sit on the
site's dark surface; `puppeteer.json` passes `--no-sandbox` for CI/containers.
