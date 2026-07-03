# REBUILD.md — X-GIS site rebuild plan

> The alignment spec. Agree on THIS before writing page code. Pairs with
> `site/DESIGN.md` (the visual system). This doc = the _what / why / order_;
> DESIGN.md = the _how it looks_. Living doc — update as decisions land.

---

## 0. Why rebuild

The current site is thin and incoherent: a few concept pages, ad-hoc per-page
utility CSS, weak structure, and it _tells_ instead of _shows_. X-GIS's strongest
asset — a real compiler + a GPU map/globe engine that runs **live in the browser**
— is barely used as a selling tool. We rebuild every page from scratch on one
system, demo-forward.

## 1. Thesis

**Show, don't tell.** Every key claim is backed by a _live, interactive X-GIS
render_ in the page (globe, projections, shaders, the compile graph). The runtime
and compiler already run client-side — lean on that. **The render is the hero;**
the xAI monochrome chrome exists to make the renders pop.

Audience: developers evaluating / learning X-GIS. Goal: they _get_ it and _trust_
it within one scroll of the home page.

## 2. Design system — xAI, as-is

- Source of truth: **`site/DESIGN.md`** (pulled from getdesign.md/x.ai). Use it
  **verbatim — no improvised accents or bridges** (the orange accent + translucent
  hairline were mistakes; corrected to white + solid `#212327`).
- Near-black canvas `#0a0a0a`, white ink, white accent (emphasis via pill shape +
  weight, not hue), Inter (weight-400, negative tracking) + Geist Mono eyebrows,
  hairline elevation (no shadows), pill interactives. The muted sunset/dusk palette
  is illustrative-only (real renders), never chrome.
- Stack: **Astro** (static/layout) + **React islands** (shadcn base) for every
  interactive demo. Tailwind v4 `@theme` tokens. Never hardcode hexes in markup.

## 3. Information architecture (sitemap)

| Page                     | Purpose                                          | Status            |
| ------------------------ | ------------------------------------------------ | ----------------- |
| **Home**                 | Demo-forward promo story                         | rebuild           |
| **Docs**                 | Get started · Guides · Language · Concepts · API | restructure       |
| **Docs › Concepts**      | The depth that earns trust — EXPAND              | expand 4 → 11     |
| **Examples**             | Live map gallery                                 | restyle           |
| **Shaders** (shader-dsl) | Shader-IR showcase + playground                  | restyle           |
| **Blueprint**            | Visual node editor                               | restyle           |
| **Convert**              | Mapbox → xgis                                    | restyle           |
| **Blog**                 | Engineering notes                                | done (foundation) |
| **/ko**                  | Korean, humanized                                | later (en first)  |

**Concepts expansion** (currently Pipeline · Compute · Projections · RTC):
add **Globe & 3D ⭐**, **Shader IR**, **Rendering (WebGPU + WebGL2 fallback)**,
**Tiles & sources (PMTiles/MVT/GeoJSON)**, **Labels & text (SDF/CJK)**,
**Camera & interaction**, **Performance (GPU arena / compute)**.

## 4. Home structure (TypeScript-homepage arc → X-GIS)

TS proves its value with _concrete code_ (progressive JS→TS transforms, "TS becomes
JS"). X-GIS's analog is _code → render_: same arc, but every beat is a live map or a
real compiler artifact.

1. **Hero** — headline + subhead + CTAs + live globe (one source, cycling projections). _(exists, restyled)_
2. **What is X-GIS** — 3 cards: declarative language / GPU compiler / 3D globe.
3. **Progressive transform** ⭐ — `.xgis source → AST/IR → WGSL shader → live render`, staged (the TS "adopt gradually" analog; "show the compiler"). Reuses the compute-graph machinery.
4. **Describe your map** — side-by-side `.xgis` samples (match / interpolate-by-zoom).
5. **"xgis becomes GPU shaders"** ⭐ — `xgis → IR → WGSL` 3-column transform (direct analog of "TS becomes JS"; we have the real shader IR).
6. **Globe** — full-bleed 3D globe beat (the product identity).
7. **Mapbox-compatible** — drop-in story + spec-coverage numbers (the TS "OSS logos / adoption" analog).
8. **Examples** — live gallery teaser.
9. **Get started** — Docs / Examples / Convert CTAs. _(QuickStart exists)_
10. **Footer.**

Social proof substitute (no testimonials/surveys yet): Mapbox-spec coverage numbers,
the live examples themselves, and badges (WebGPU · 7 projections · MIT).

## 5. What to show — live-demo inventory

In-browser, real (not video/screenshot):

- **Live globe + projection cycling** — hero. _(exists)_
- **Type-and-see mini compiler** — a small editor → live render. _(to build; the hero card + the compute page have the pieces)_
- **Live compile graph** — tokens→AST→IR→routing→plan→WGSL. _(exists: /docs/concepts/compute; surface a teaser on home)_
- **Full assembled shader** — the runtime composer output. _(exists: compute stage 7b)_
- **Shader-DSL playground** — live WGSL/GLSL emit + render. _(exists: /shader-dsl)_
- **Examples** — real OFM/Mapbox-style maps. _(exists: /examples)_
- Per-concept: a diagram + a real X-GIS render.

## 6. Honest capability ledger

State only what is TRUE on the site. Verified against the codebase:

| Claim                                                           | Reality                                                                                                | Site use                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Declarative `.xgis` → GPU shaders, live                         | TRUE (compiler + runtime in-browser)                                                                   | lead with it                               |
| 3D globe / projections                                          | TRUE                                                                                                   | hero + Globe concept                       |
| WebGPU + WebGL2 fallback                                        | TRUE (RHI)                                                                                             | Rendering concept                          |
| Shader IR (WGSL + GLSL from one IR)                             | TRUE (@xgis/shader-dsl)                                                                                | "becomes shaders" beat                     |
| Mapbox-spec compatibility                                       | PARTIAL (coverage tracked)                                                                             | show real coverage %, not "100%"           |
| **Custom content on the map (three.js / Babylon / raw WebGPU)** | **NOT BUILT** — `addLayer` is a Mapbox-parity stub; no public custom-render-pass or device-sharing API | **roadmap only — do NOT claim as shipped** |

**Custom-layer / interop = a future track** (worth doing — the engine has the seam:
RHI + `beginRenderPass` + a WebGPU device → a Mapbox-`CustomLayerInterface`-style
`addCustomLayer({ render(device, pass, matrices) })` + three.js/Babylon examples).
Build it as its own feature later; only then does the site showcase it.

## 7. Build approach

1. **Tokens** — xAI `@theme` in global.css. _(done: #638, #641)_
2. **Component kit** — extract the DESIGN.md `components:` block into reusable
   Astro/React primitives: `Eyebrow` (mono-caps), `SectionHead` (Inter w400 neg-tracking),
   `ContentBand` (section rhythm), `Card` (hairline · 8px · no-shadow), `Button` (pill, done),
   `FeatureRow` (editorial), `Nav`, `Footer`. Pages compose the kit — not raw utilities per page.
3. **Pages** — rebuild page-by-page by composing the kit + React-island demos.
4. **Gate** — local `astro` build is blocked here (expressive-code/shiki env issue), so
   **CI `bun run build` is the build gate** and the **GitHub Pages deploy is the visual
   review**. Surgical, reviewable PRs; one coherent surface per PR.

## 8. Standing rules

- **x.ai DESIGN.md verbatim** — no self-invented accents/styles.
- **No vaporware** — only ship claims the codebase backs (see §6).
- **en first, /ko later**, each Korean page run through the `humanize-korean` skill.
- **Surgical, reviewable PRs**, CI-gated, deploy-reviewed.

## 9. Phasing

- **P0 — Align** (this doc) + **component kit**.
- **P1 — Home** rebuilt on the kit (the promo punch; type-and-see compiler beat).
- **P2 — Concepts** expansion (Globe first — the identity), each with a live render.
- **P3 — Examples / Shaders / Blueprint / Convert** restyle on the kit.
- **P4 — /ko** translation (humanized).
- **Future track — custom-layer / three.js·Babylon interop API**, then its showcase.

## 10. Open / to confirm

- Home section list (§4) — add/drop?
- Concepts priority order (Globe first assumed).
- "Type-and-see" home compiler — scope (full editor vs a few presets)?
- Coverage numbers to publish (need the real spec-coverage figure).
