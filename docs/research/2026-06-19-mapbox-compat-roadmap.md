# Mapbox style-compat completion roadmap (2026-06-19)

Goal: implement ALL remaining Mapbox Style Spec gaps. Authority = `compiler/src/convert/spec-coverage.ts` (the coverage table; `spec-coverage-drift.test.ts` keeps it honest). Open GitHub issues (#421/420/415/414/413/402/399) are render-PARITY bugs, NOT missing features — tracked separately.

Sequenced because the gaps are heterogeneous: a few are 1-converter routes; most "big" ones are **missing render SUBSYSTEMS** (no renderer exists), each multi-day + needing real-GPU verification (CI/vitest has no GPU — the repo's #1 verification constraint). Each phase: design → implement → **real-GPU A/B vs MapLibre** → CI structural test where possible → PR (owner review; no blind autonomous merge of render code).

## Phase S — Surgical gaps (converter + small runtime, CI-gateable) — IN PROGRESS
Branch `feat/mapbox-surgical-gaps`. Done in ulw parallel batches on disjoint files.
- Batch 1 (Workflow `wf_84fdb483`): `$type`/`$id` legacy filters → geometry-type/id; `circle-translate`(+anchor)+`circle-blur`; `line-translate`(+anchor).
- Batch 2 (next): `icon-translate`(+anchor); opt-out flags `fill-antialias:false`, `fill-extrusion-vertical-gradient:false`; `text-translate-anchor` map mode; `pitch` expression identifier; `line-round-limit`/`text-max-angle`/`icon-padding` per-layer overrides; `*-sort-key`/`symbol-z-order` per-feature draw order.
- Batch 3 (careful, #419 boundary): icon collision policies — `icon-allow-overlap:false`/`icon-overlap:never`/`icon-ignore-placement`/`icon-optional` wired onto the #417 IconStage collide AABB, preserving #419's pairKey path + adding sort-order determinism. Real-GPU.

## Phase R — Render subsystems (new GPU pipelines), SEQUENTIAL, real-GPU each
1. **hillshade** — raster-dem source ALREADY registered (sources.ts:57, unused). DEM decode → per-texel normal/gradient → illumination shader (`hillshade-illumination-direction/-altitude/-anchor`, `-exaggeration`, `-shadow/-highlight/-accent-color`, `-method` basic/combined/igor/multidir). New raster-dem render path. Verify vs MapLibre hillshade.
2. **terrain** (3D) — raster-dem → terrain mesh + vertex displacement; existing tiles drape onto it. Integrates with the 3D globe target. Largest; depends on hillshade's DEM decode. `terrain` top-level + `raster-dem`.
3. **heatmap** — accumulation pass (additive blend → offscreen R16F) + Gaussian blur + `heatmap-density`→color ramp; `heatmap-radius/-weight/-intensity/-color/-opacity` + `accumulated`/`heatmap-density` exprs. New layer renderer + MRT.
4. **line-gradient** — PREREQ: tiler must track each clipped segment's [progressStart,progressEnd] of original arc-length (geojsonvt currently ignores lineMetrics, geojsonvt/index.ts:14 + sources.ts:406) → per-vertex line-progress attr → gradient LUT in line fragment. GeoJSON-source-with-lineMetrics only (PMTiles can't). `["line-progress"]`.
5. **sky / fog** — sky dome (`sky-type`/`sky-atmosphere-*`/`sky-color`) + Mapbox v3 distance fog (depth-based post-process mix). Lower priority.
6. **text-writing-mode** (CJK vertical) — per-glyph rotation pipeline in text-stage. medium.
7. **light keyword parsing** — shader already bakes Mapbox defaults; parse custom `light` (anchor/intensity/position/color) and feed the extrude shader. Small once the others land.

## Out / NA
`feature-state`, `ref`, `accumulated` (heatmap-internal), `imports` (v3 style-import), `projection` (mercator-centric), `image`/`video` sources. `metadata`/`transition` (informational/low). `properties` expr (object accessor — no xgis equiv).

## Discipline (locked)
Every render phase verified on a real GPU before PR. Converter gaps gated by compiler vitest + spec-coverage drift/completeness. No blind autonomous merge of render-pipeline code. One subsystem per focused session.

## Phase R — grounded per-subsystem plans (scoped 2026-06-19, read-only Workflow wf_4f25f3e6; full detail in that task output)

### Terrain / DEM elevation + hillshade (greenfield runtime subsystem, plus converter wiring) — **multi-session**
- files (~15): D:\X-GIS\runtime\src\engine\render\terrain-renderer.ts (NEW), D:\X-GIS\runtime\src\engine\shader-dsl\shaders\terrain.ts (NEW), D:\X-GIS\runtime\src\data\dem-decode.ts (NEW), D:\X-GIS\runtime\src\data\tile-select.ts (MODIFY: add loadDEMTexture), D:\X-GIS\runtime\src\engine\shader-dsl\shaders\ecef.ts (REUSE as-is, no change), D:\X-GIS\runtime\src\engine\shader-dsl\index.ts (MODIFY: export emitTerrainWgsl), D:\X-GIS\runtime\src\engine\render\passes\opaque-pass.ts (MODIFY: invoke terrainRenderer.render before raster), vector for drape — phase 2) …
- PREREQ: DEM decode module: no runtime decoder exists; the only copy of the pack formulas is a compiler WARNING STRING (sources.ts:361). Must implement mapbox=(R*256+G+B/256)*0.1-10000 and terrarium=R*256+G+B/256-32768 as a runtime function (GPU sid
- PREREQ: Byte-exact DEM texture load: loadImageTexture (tile-select.ts:710-749) uses bare createImageBitmap(blob) + copyExternalImageToTexture into rgba8unorm. Browser default applies colorSpaceConversion + premultiplyAlpha which corrupts Terrain-RG
- PREREQ: Real-GPU visual safety net: per project memory, forward 3D is gated on the Phase-3 real-GPU visual matrix; CI is no-GPU SwiftShader (compile/compute only). Terrain is the exact bug archetype unit tests miss (3D x projection-crossing x deep-
- VERIFY: CI (no-GPU SwiftShader) ONLY compile-gates the WGSL + runs CPU math; it CANNOT judge displaced 3D pixels. Layered plan: (1) CPU/compile gates in vitest — (a) new terrain WGSL emits and pipeline-compiles under SwiftShader (mirror existing shader-compile gates); (b) DEM-decode parity test: feed known 
- RISK: Drape is the largest unknown and touches the hottest VS path. Option (a) re-threading every VS through a height texture risks regressing the f32 flat-parity / DSFUN precision work (#392) and the raste
- RISK: f32 vertex jitter at deep zoom: raster VS f32 reprojection is ~1m (raster.ts:118-121) — fine for texture, but for terrain GEOMETRY the same f32 height+position may show as visible vertex shimmer under

### Heatmap render layer (runtime WebGPU pass + offscreen R16F accumulation + Gaussian blur + density→color compose) and compiler converter (un-SKIP the heatmap layer, flip spec-coverage). Phase R item 3 of the Mapbox-compat roadmap. — **large**
- files (~17): D:\X-GIS\runtime\src\engine\render\heatmap-renderer.ts (NEW), D:\X-GIS\runtime\src\engine\render\passes\heatmap-pass.ts (NEW), D:\X-GIS\runtime\src\engine\shader-dsl\shaders\heatmap-accum.ts (NEW), D:\X-GIS\runtime\src\engine\shader-dsl\shaders\heatmap-blur.ts (NEW), D:\X-GIS\runtime\src\engine\shader-dsl\shaders\heatmap-compose.ts (NEW), heatmapBlur R16F fields + alloc + destroy), D:\X-GIS\runtime\src\engine\render\scene-view.ts (MODIFY :26-44,:52-65 — add hasHeatmap), D:\X-GIS\runtime\src\engine\render-loop.ts (MODIFY :505-508 — insert heatmapPass.execute between points & labels; :488-style ensure) …
- PREREQ: NONE blocking. line-gradient's tiler arc-length (roadmap :17) is NOT a prereq — heatmap reads point features, not line-progress. Independent of Phase R items 1/2/4.
- PREREQ: Decision needed (cheap): scope to GeoJSON-source / direct-layer points first (the map.ts:2394 Point/MultiPoint fork). Tile-sourced (xgvt) heatmaps add the addTilePoint/flushTilePoints path (point-renderer.ts:313/318) — defer to a follow-up 
- PREREQ: Confirm `accumulated` stays OUT (roadmap :23 lists it Out/NA, heatmap-internal). heatmap-density IS in-scope (it is the compose-ramp input).
- VERIFY: CI (no-GPU, what gates merge): (1) WGSL compile-parity — the three new shader-dsl emitters must compile under SwiftShader exactly like ensureOverdrawCompose does today (pipeline-factory builds the module; existing render-gate spec compiles all shaders). (2) Converter unit tests: a style with a heatm
- RISK: 3-pass pipeline (accum->blur x2 separable->compose) is net-new — no Gaussian blur primitive exists anywhere in the codebase. Blur is the highest-uncertainty piece; structurally it is two more full-scr
- RISK: Per-frame allocation hazard (render-loop.ts:120-126 forbids it): heatmapAccum/heatmapBlur textures + bind groups must be lazily allocated & resized in RenderTargets.ensure (mirror overdrawAccumTexture

### line-gradient (Mapbox paint.line-gradient via ["line-progress"]) — compiler GeoJSON tiler arc-length tracking + runtime line shader gradient LUT — **multi-session**
- files (~19): types.ts, convert.ts, clip.ts, tile.ts, transform.ts, index.ts, encode-mvt.ts, geojson-tiling-worker.ts …
- PREREQ: PREREQ-1 (the bulk): GeoJSON-vt clip stage must carry an ORIGINAL-feature progress channel. Today convert.ts:122-124 sets out.size/start/end but clip.ts:170-176 newSlice copies size/start/end VERBATIM and intersectX/Y (clip.ts:195-213) inte
- PREREQ: PREREQ-2: defeat the stride-2 drop. convert.ts/clip.ts pack stride-3 [x,y,z] but tile.ts:70,128 emit stride-2 [x,y] and transform.ts:24,32 read stride-2 (z consumed at tile.ts:126 for simplification then dropped). A progress channel needs a
- PREREQ: PREREQ-3: bypass or extend the MVT convergence. geojson-tiling-worker.ts:134 encodeMVT converges the GeoJSON path onto MVT PBF (encode-mvt.ts:164-204 writeGeometry emits only MoveTo/LineTo/ClosePath integer dx/dy). MVT geometry CANNOT carry
- VERIFY: CI only compile-gates WGSL (SwiftShader, no visual GPU) so CI catches: (1) tiler unit tests — a new geojsonvt progress-tracking test that clips a known LineString across a tile boundary and asserts each clipped vertex carries the correct [progressStart,progressEnd] fraction of the ORIGINAL arc (fail
- RISK: MVT convergence is the structural blocker: any side-channel/bypass for progress diverges the GeoJSON tile format from the shared PMTiles decoder (geojson-tiling-worker.ts:134) — blast radius is the wh
- RISK: Stride change in geojsonvt is invasive: tile.ts/transform.ts/encode-mvt all assume stride-2 post-tile; adding a channel risks the geojson-vt oracle-parity tests (types.ts:1-8 — the port is verified ag

### Render pass-graph (runtime/src/engine/render) + Mapbox converter (compiler/src/convert) — a new SkyPass (colour-only dome/gradient, before opaque) and a deferred AtmospherePass/FogPass (screen-space, after labels), plus the converter IR/coverage wiring to stop dropping `sky`/`fog`. — **large**
- files (~15): sky.ts (NEW — emitSkyWgsl DSL module, clone of overdraw-compose.ts), sky-pass.ts (NEW — SkyPass RenderPass singleton, inserted between bucket 0 and 1), pipeline-factory.ts (NEW ensureSky() lazy pipeline + skyBindGroupLayout, model on ensureOverdrawCompose() at :373-393), :390), render-loop.ts (insert skyPass.execute between :493 and :496), pass.ts (no change — RenderPass contract already fits), frame-context.ts (FOG ONLY — add a sampleable depth view field if fog is attempted), render-targets.ts (FOG ONLY — add TEXTURE_BINDING to depth, or a separate depth32float sampleable target, :104-109) …
- PREREQ: FOG ONLY — depth-readback infrastructure: the scene depth texture is RENDER_ATTACHMENT-only (render-targets.ts:104-109) and the last geometry pass DISCARDS depth (points-pass.ts:40 depthStoreOp:'discard'). depth24plus is not a sampleable de
- PREREQ: MSAA/resolve ownership: the label pass currently owns the final swapchain resolve (label-pass.ts:1097, points-pass.ts:28 `resolveTarget: ctx.useResolve ? ctx.screenView`). A post-label fog/atmosphere pass becomes the NEW last colour writer 
- PREREQ: Globe geoid split: an atmosphere pass 'depth-tested against the globe' (VISION.md:186) must pick a consistent sphere-vs-ellipsoid reference (~21km, the #407/#360 class) or it misaligns at the limb. Sky-dome-on-flat sidesteps this; globe atm
- VERIFY: CI only compile-gates WGSL (SwiftShader, no raster) — so correctness lives in real-GPU A/B. Layered plan: (1) Unit/CI: add emitSkyWgsl() (and emitFogWgsl() if fog) to playground/e2e/_wgsl-compile-gate.spec.ts allVariants() (:50-53) — proves the emitted WGSL compiles with zero errors on every push (t
- RISK: Sky dome is SURGICAL-to-MEDIUM and ships independently; FOG is the heavy half (depth-readback infra + resolve-ownership transfer + geoid reference) and is correctly deferred per VISION §7. Conflating 
- RISK: Resolve-ownership transfer for a post-label fog pass is NOT a free insert (label-pass.ts:1097 currently owns resolveTarget; opaque-pass.ts:44-45 resolveOwner chain). Getting this wrong = MSAA never re

### runtime text label layout + shaping pipeline (runtime/src/engine/text) and the Mapbox→X-GIS symbol-layer converter (compiler/src/convert + compiler/src/ir) — **medium**
- files (~9): text-stage.ts, text-wrap.ts, layers-symbol.ts, spec-coverage.ts, lower-label.ts, render-node.ts, text-writing-mode-max-angle-warn.test.ts, text-vertical-writing.test.ts (NEW) …
- PREREQ: NONE for the GPU path: the per-glyph rotate+offset renderer primitive already exists and is exercised by the curved-line path (text-renderer.ts:295-312, 255-256, 326-329). NO new uniforms, NO new bind groups, NO WGSL change — the shader is 
- PREREQ: Decide multi-mode array semantics: Mapbox text-writing-mode is an ORDERED array (e.g. ['horizontal','vertical']) where the engine picks per-label by fit; the minimal faithful subset is: array contains 'vertical' AND label is point-placement
- PREREQ: Confirm scope is POINT labels only. Mapbox applies writing-mode to point/point-like placement; line labels stay on the existing along-curve path (addCurvedLineLabel, text-stage.ts:466/1137-1317). No line-label change.
- VERIFY: Layered, because CI has NO GPU (SwiftShader only compile-gates WGSL). (1) UNIT/compiler (CI-green): new compiler/src/__tests__/text-writing-mode-convert.test.ts asserts text-writing-mode:['vertical'] now emits utility label-writing-mode-vertical and lowers to LabelDef.writingMode==='vertical' (paral
- RISK: Layout-cache collision (HIGH if missed): layoutCacheKey/_isCacheable (text-stage.ts:833-857) have no writingMode term — a vertical and horizontal label with identical text/size/halo would alias to the
- RISK: Bilingual bearingY trap (HIGH — documented, has bitten before, AGENTS.md:33 + project_pbf_glyph_bearingy_2026_05_22): vertical advance/centering must derive from slot height/advanceWidth, NOT bearingY

### Compiler style-conversion (`compiler/src/convert`) + runtime polygon-extrude render path (`runtime/src/engine/shader-dsl/shaders/polygon.ts` + `runtime/src/engine/render/vector-tile-renderer.ts`). The Mapbox top-level `light` keyword: parse it in the compiler (currently warned-and-dropped) and thread anchor/intensity/position/color into the extrude shader, which today bakes those values as hardcoded WGSL `let` consts. — **medium**
- files (~8): mapbox-to-xgis.ts, spec-coverage.ts, toplevel-sky-lights-models-warn-coverage.test.ts, polygon.ts, uniform-layout-consistency.test.ts, vector-tile-renderer.ts, renderer-types.ts, *.wgsl
- PREREQ: NONE that block the map-anchor cut. The lighting MATH already exists end-to-end in polygon.ts:608-647; the uniform-threading PATTERN (style value -> ShowCommand field -> EXPECTED_F32_OFFSET -> uniformF32[n] write) is well-trodden (fill_tran
- PREREQ: FOR anchor:viewport ONLY (deferrable): a per-frame recompute hook. The light direction becomes camera-relative (rotated by bearing/pitch each frame), so it cannot be a compile-time const and must be recomputed in the renderer per frame from
- PREREQ: DECISION REQUIRED before coding: transport route. (a) attach resolved light to every fill-extrusion ShowCommand at convert time (simplest, duplicates the global onto each layer, reuses the exact ResolvedShow/renderer-types pattern) vs (b) a
- VERIFY: CI ONLY COMPILE-GATES WGSL (SwiftShader, no real GPU) — so CI cannot judge the lit pixels; it can only enforce the contracts. CI gate (must pass): (1) `uniform-layout-consistency.test.ts` after updating EXPECTED_F32_OFFSET + raising the <=192 size guard to <=224 + matching CPU uniformF32[] writes — 
- RISK: Snapshot regen is MANDATORY and easy to forget: __polygon-variant-snapshots__/*.wgsl pin exact WGSL bytes; the US-010 byte-equal drift gate fails until all ~8 are regenerated after the const->uniform 
- RISK: WGSL vec3/vec4 16-byte alignment trap: light_dir(vec3)+intensity(f32) packs cleanly into ONE vec4; light_color(vec3)+pad into a SECOND vec4 = +8 f32 / +32 bytes, struct 192->224. If packed as loose f3

