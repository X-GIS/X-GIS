# PAGES.md — per-page content · flow · design

> The per-page rethink. For every page: **purpose**, **content** (what goes in),
> **flow** (section order / narrative), **design** (kit components + live demos +
> xAI signatures). Built on `DESIGN.md` (xAI system) + the kit. Honesty rules from
> `REBUILD.md §6` apply everywhere — real demos / real numbers, no vaporware.
> Demos run in-browser (compiler + runtime are client-side). Build priority at the end.

Legend — demo = **live** (runs) · **static-real** (real artifact, no live recompile) ·
**link** (points to a live tool). Kit = `ContentBand · SectionHead · Eyebrow · Card · FeatureRow · Button`.

---

## 1. Home `/` _(P1 shipped — refine)_

- **Purpose:** convince + orient in one scroll. Show, don't tell.
- **Flow:** Hero(globe, **live**) → What is X-GIS (3 cards) → How it compiles (real .xgis + **link** to compile graph) → Becomes shaders (1 IR→WGSL+GLSL, **link**) → Mapbox-compatible (175/235) → **Roadmap (NEW)** → Examples (**live** gallery) → Get started (CTAs) → Footer.
- **Add:** a **Roadmap** band (vision, "planned/in progress", no dates) — homes the future-track (custom layers/three.js). A **Why-vs** teaser linking the comparison page.
- **Design:** every band = `ContentBand`; the render is the only colour.

## 2. Docs shell `/docs/*` _(restyle)_

- **Purpose:** find anything fast; calm reading.
- **Content/flow:** left sidebar nav (Diátaxis groups), centred prose column (≤720px), right on-this-page TOC, prev/next + edit-on-GitHub footer. Docs landing `/docs` = a short "start here" with the section map.
- **Design:** kit `Eyebrow`/`SectionHead` for page headers; mono sidebar, hairline active = white; restyle the existing `Docs.astro` chrome to xAI (it's still warm-era).

## 3. Concepts `/docs/concepts/*` _(EXPAND 4 → 11)_

Each concept page = **one idea**, same template: `Eyebrow` + `SectionHead` + lead → a **diagram or live render** → tight prose in `FeatureRow`/prose → "see it" link. Template-driven so all 11 read alike.

- Existing: Pipeline · Compute paint · Projections · RTC precision _(restyle to kit)_.
- **NEW (priority order):** **Globe & 3D ⭐** (ECEF · ellipsoidal geoid · sphere↔plane · **live globe**) → **Shader IR** (one IR → WGSL+GLSL, optimizer passes; **link** /shader-dsl) → **Rendering** (WebGPU-first + WebGL2 fallback, RHI, passes) → **Tiles & sources** (PMTiles/MVT/GeoJSON) → **Labels & text** (SDF atlas, CJK, collision) → **Camera & interaction** (fly-to, globe orbit, inertia) → **Performance** (GPU arena, compute, real GPU-time).
- **Design:** each leads with a visual; the live globe / compile-graph are the heroes.

## 4. Examples `/examples` _(restyle)_

- **Purpose:** "it really renders." Proof gallery.
- **Content/flow:** a grid of **live** map cards (OFM-Bright, projections, data-driven, globe) + the `.xgis` behind each; click → full live map. Filters (projection / data type).
- **Design:** `Card` thumbnails, hairline grid, the maps carry the colour; mono captions (coords/zoom).

## 5. Shaders `/shader-dsl` _(restyle)_

- **Purpose:** the shader-IR is real + inspectable.
- **Content/flow:** intro (typed IR → WGSL/GLSL + optimizer) → the **live playground** (author → emit WGSL/GLSL → render) → example gallery (plasma/voronoi/hillshade/…) → reference.
- **Design:** split editor/preview; mono code via expressive-code; pill controls.

## 6. Blueprint `/blueprint` _(restyle)_

- **Purpose:** visual node editor for maps (no-code path).
- **Content/flow:** what it is → **live** node-editor demo → "exports .xgis".
- **Design:** dark canvas suits xAI; nodes hairline-framed.

## 7. Convert `/convert` _(restyle)_

- **Purpose:** Mapbox/MapLibre style → .xgis migration.
- **Content/flow:** paste Mapbox JSON → **live** convert → side-by-side (JSON ↔ .xgis) + coverage note (what mapped / dropped, honest) → "open in playground".
- **Design:** two-pane diff; coverage chips (supported/partial/dropped).

## 8. Blog `/blog` _(shipped — grow content)_

- **Purpose:** engineering depth → trust + SEO.
- **Content:** more posts (the compiler, the shader IR, globe math, perf war-stories). List + post template done.
- **Design:** editorial, calm prose (done).

## 9. Why X-GIS `/why` (NEW)

- **Purpose:** positioning for evaluators — "why not just Mapbox / MapLibre / deck.gl / Cesium?"
- **Content/flow:** the thesis (declarative language + real compiler + GPU + globe) → an **honest comparison table** (X-GIS vs Mapbox GL / MapLibre / deck.gl / Cesium across: declarative styling, GPU compile, 3D globe, WebGPU, custom layers[roadmap], Mapbox-compat) — mark our gaps too → "who it's for / not for".
- **Design:** the comparison table = hairline rows, white checks, no hype.

## 10. Playground `/play` (NEW — highest-leverage)

- **Purpose:** the "type-and-see" wow — author .xgis, watch the map render live.
- **Content/flow:** editor (left) ↔ live map (right) + presets + share-URL. Reuses compiler+runtime in-browser (the convert/compute pages already do).
- **Design:** full-bleed split; mono editor; the map is the hero. (This is the single most convincing demo — REBUILD.md §5.)

## 11. API `/docs/api` _(restyle + complete)_

- **Purpose:** the JS embedding surface (XGISMap).
- **Content:** install → `new XGISMap(canvas).run(src)` → the real public methods (camera, events `on()`, projections, sources). Mark Mapbox-parity stubs honestly (e.g. `addLayer` not implemented).
- **Design:** reference layout; mono signatures; honest "not implemented" tags.

## Footer / chrome _(global)_

- Footer: link columns (Docs/Community/Project), GitHub · MIT · Discord(?), mono meta. Header: ≤7 items + Blog. xAI nav (done).

## Roadmap (home band + maybe `/roadmap`)

Real direction, vision-framed (no dates): **Google-Earth-class 3D globe** (terrain · 3D-tiles · streaming · LOD · fly-to) · **Custom layers** (three.js/Babylon/raw-WebGPU interop — _not built; the engine has the seam_) · **Full Mapbox parity** (175→235) · **Embeddable engine** (@xgis/engine + @xgis/map split, in progress).

---

## Build priority

1. **P2** — Globe concept ⭐ + Roadmap band + Why page. _(identity + convince)_
2. **P3** — Playground (try-it) + Examples/Shaders/Convert restyle. _(the wow + consistency)_
3. **P4** — remaining Concepts (Shader IR→Performance) + Docs shell + API.
4. **P5** — Blog content + OG image + orphan cleanup.
5. **P6** — /ko (humanized).

Each = its own surgical PR, CI-gated, deploy-reviewed.
