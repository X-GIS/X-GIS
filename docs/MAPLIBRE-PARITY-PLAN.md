# MapLibre / Mapbox Style-Spec Parity — Implementation Plan

Status snapshot (source of truth: `compiler/src/convert/spec-coverage.ts` +
`runtime/src/capabilities.ts`, both guarded by drift/freshness tests):

| Status | Count |
|---|---:|
| supported | 138 |
| partial | 28 |
| unsupported | 69 |
| na (no X-GIS equivalent / no plan) | 7 |
| **total spec entries** | **242** |

Plus **17 runtime value-form gaps** — properties the converter marks `supported`
but where the runtime drops a specific `zoom-interp` / `data-driven` form
(`runtimeGaps()` in `runtime/src/capabilities.ts`).

## Organizing principle

The ~114 open items are **not** 114 independent features. They cluster around a
handful of shared mechanisms. Closing one mechanism flips many properties at once.
This plan is organized by **workstream (the shared mechanism)**, ordered by
leverage. An appendix maps every individual spec entry to its workstream so
nothing is dropped.

Effort tiers: **S** ≈ ≤1 day · **M** ≈ 2–4 days · **L** ≈ 1–2 weeks · **XL** ≈ multi-week.

Verification for every workstream follows CLAUDE.md §4/§5: each item gets a
spec-coverage table flip (status → `supported`, drift test stays green) **plus**
a render verification (directional pixel-diff vs MapLibre on a fixture that
exercises the property, per the `compare-parity-pixeldiff` skill).

---

## Workstream leverage map (what unblocks the most)

| WS | Mechanism | # spec items closed | Tier |
|---|---|---:|---|
| WS-1 | Per-frame PropertyShape uniform (zoom-interp) | ~8 | M |
| WS-2 | Per-feature worker bake (data-driven) | ~7 | M–L |
| WS-3 | Sprite-atlas Batch 2 finish (icons/patterns) | ~12 | L |
| WS-4 | Map-space anchors + pitch-alignment (3D labels) | ~10 | L–XL |
| WS-5 | Heatmap renderer (Batch 3) | 6 | L |
| WS-6 | raster-dem → hillshade → terrain (Batch 4) | ~12 | XL |
| WS-7 | Raster color-adjust fragment pass | 8 | M |
| WS-8 | Style-spec `projection` field + globe transition | 1 (high leverage) | S–M |
| WS-9 | `light` keyword parsing | 1 | S |
| WS-10 | line-gradient (tiler arc-length) | 1 | L |
| WS-11 | Color/interpolate/format expression fidelity | ~5 | M–L |
| WS-12 | Per-feature sort keys / draw order | 5 | M |
| WS-13 | Text-layout extras (CJK vertical, max-angle…) | ~5 | M |
| WS-14 | Spatial + locale expressions | 7 | L |
| WS-15 | fill-extrusion ambient occlusion | 2 | M |
| WS-16 | Misc top-level / sources (fog, sky, image, video, imports, transition) | ~6 | M–L |

---

## WS-1 — Per-frame PropertyShape uniform path (zoom-interp parity) · M

**Closes:** `background-opacity` (zoom-interp), `circle-stroke-opacity` (zoom-interp),
`fill-translate` / `line-translate` / `circle-translate` / `fill-extrusion-translate`
(true per-frame zoom-interp, replacing today's last-stop approximation),
`line-dasharray` (zoom-interp), `text-opacity` (zoom-interp), `background-color`
(zoom-interp).

**Current state.** `PropertyShape<T>` (`compiler/src/ir/property-types.ts:46`) already
models `zoom-interpolated`. Per-frame resolvers exist
(`runtime/src/engine/render/paint-shape-resolve.ts:56` — `resolveNumberShape` /
`resolveColorShape` / `resolveSteppedShape`) and are already called for labels in
`render-loop-helpers.ts:62`. The uniform-staging plumbing exists in
`line-renderer.ts:508` (`writeLayerSlot`) flushed once per frame at `endFrame()`.
The gap is purely that **fill/stroke/background/circle opacity + translate axes
fold their value at convert time** instead of carrying a `PropertyShape` that the
runtime resolves each frame.

**Approach.**
1. Add dedicated `PropertyShape<number>` axes to the paint IR for: `strokeOpacity`
   (circle), `backgroundOpacity`, and promote the `*-translate` X/Y slots from
   scalar to `PropertyShape`. (`compiler/src/ir/lower.ts`, `to-property-shape.ts`).
2. Stop the convert-time alpha-fold for the non-constant forms (`paint.ts`,
   `layers-circle.ts`) — emit the shape instead.
3. Runtime: call `resolveNumberShape(shape, cameraZoom, elapsedMs).value` at the
   per-frame uniform write site and multiply into the existing uniform slot
   (`line-renderer.ts:writeLayerSlot`, polygon uniform pack, `point-renderer.ts`,
   new background uniform in `background-pass.ts`).
4. `line-dasharray` zoom-interp: add a `PropertyShape<number[]>` resolver
   (`resolveArrayShape`) and recompute the dash pattern per zoom bucket.

**Risk/trade-off.** Background currently has no per-layer uniform (screen-space
fill) — needs a small uniform addition in `background-pass.ts:59`. Bucket
classification reads opacity (`bucket-scheduler.ts:257`); the new per-frame opacity
must feed the opaque/translucent decision or a layer can mis-bucket.

**Verify.** Fixture with `["interpolate",["linear"],["zoom"],...]` on each axis;
pixel-diff at z=4,8,12,16 vs MapLibre; assert DC>0 between stops and D1<D0.

---

## WS-2 — Per-feature (data-driven) worker bake path · M–L

**Closes:** `fill-opacity` (data-driven), `text-opacity` (data-driven),
`icon-opacity` (data-driven), `icon-size` (data-driven), `symbol-sort-key`
(data-driven), `fill-pattern` / `line-pattern` / `fill-extrusion-pattern`
(data-driven sprite-name).

**Current state.** The established working pattern is `extractFeatureColors()` in
`runtime/src/data/workers/mvt-worker.ts:151` (mirrored in
`pmtiles-backend-helpers.ts`): the worker evaluates a per-feature AST once per
feature per tile and **bakes the result into a vertex/instance slot** (color packed
RGBA8→u32 at segment offset 18). The shader reads the baked value; alpha=0 means
"fall through to layer uniform." `text-color` data-driven works this way;
`text-opacity` does not because **no `extractFeatureOpacities()` exists** and
opacity is a *multiplicative* axis, not a replacement.

**Approach.**
1. **Polygon/line opacity:** add `extractFeatureOpacities()` in the worker (parallel
   to colors), bake a per-vertex `feat_opacity` (u8 in a spare lane), multiply in the
   fragment stage (`shader-dsl/shaders/polygon.ts` `fs_fill`, `line.ts` `fs_line`).
2. **Icon size/opacity data-driven:** these resolve in `label-pass.ts:464`
   (`applyFeatureExprs`) which already evaluates `sizeExpr`/`colorExpr`/`iconImageExpr`
   per feature — extend it to evaluate `iconSizeExpr` / `iconOpacityExpr` and pass to
   `dispatchIcon` (`label-pass.ts:187`). No worker change (labels evaluate on main
   thread per-feature, cached by WeakMap).
3. **symbol-sort-key data-driven:** evaluate the key expr in `applyFeatureExprs`,
   thread to the `CollisionItem.sortKey` already consumed by the collision sort
   (today it flattens to 0).
4. **Pattern data-driven sprite-name:** thread the sprite-name expression through IR
   (`lower.ts`) to a per-feature evaluated atlas-UV lookup. Heavier — needs a
   per-feature UV-bbox attribute instead of the single layer-uniform UV bbox used by
   the constant path (`paint.ts` fill-pattern Stage 2).

**Risk/trade-off.** Per-feature opacity baking enlarges the vertex stride; reuse a
spare lane where possible. Data-driven patterns need a per-feature atlas index —
verify the atlas-UV table fits an instance attribute.

**Verify.** Fixtures using `["case", ...]` / `["match", ...]` / `["get", ...]` on each
axis; per-feature pixel-diff vs MapLibre (e.g. two adjacent polygons with different
data-driven opacity must differ in the diff).

---

## WS-3 — Sprite-atlas Batch 2 completion (icons + patterns) · L

The sprite atlas itself is **done**: fetch (`sprite-atlas-host.ts`), GPU upload +
view (`sprite-atlas-gpu.ts`, bound at `@group(0) @binding(5/6)` for fill-pattern and
a standalone layout for icons), SDF-vs-raster fragment branch
(`icon-renderer.ts` + `shader-dsl/shaders/icon.ts`), and bitmap fill/line/extrude
patterns (Stage 2). The remaining gaps are icon **collision**, **fit**, **halo**,
and the **`image` expression**.

**WS-3a Icon collision queue · M** — closes `icon-allow-overlap:false`,
`icon-overlap` (`never`/`cooperative`), `icon-ignore-placement`, `icon-optional:true`,
`icon-padding`. Today every icon places; only paired-symbol drop and the line-arrow
`collide` dedupe (`icon-stage.ts:41`) exist. Add an icon-side collision bbox queue
in `label-pass.ts` / `text-collision.ts`, sharing the text collision grid so
text↔icon arbitration works (`icon-optional` / `text-optional` depend on it).

**WS-3b icon-text-fit + padding · M** — closes `icon-text-fit`,
`icon-text-fit-padding` (the **shield/badge** gap, medium impact). Needs a feedback
edge: TextStage already has glyph bbox metrics; pass the laid-out text bbox to
IconStage so the icon quad stretches to fit (`icon-renderer.ts:205` currently emits a
fixed `design_size` quad). Sequence after WS-3a (collision uses the fitted bbox).

**WS-3c `image` expression · S–M** — closes `image` (high). `iconImageExpr` already
exists on `LabelDef` (`render-node.ts:428`) and `applyFeatureExprs` evaluates it;
confirm/finish the `["image", expr]` → resolved sprite-name → `dispatchIcon` path
end-to-end and flip status. (Also verify the **`symbol (icon-only)` layer** status:
`layers.ts:59` already routes constant-string icon-only layers via `label-[""]`; the
`unsupported/high` table row looks stale — confirm and either flip to `supported` or
close the data-driven-icon-only sub-case.)

**WS-3d SDF icon halo · S** — closes `icon-halo-color` / `-width` / `-blur`. Add a
second smoothstep at `edge − haloWidth` in the SDF branch of `icon.ts`, mirroring
`fs_text`. Low impact (OFM sprites carry 0 SDF icons) but cheap once the SDF branch
exists.

**WS-3e background-pattern · S** — closes `background-pattern`. Reuse
`fs_fill_pattern` UV math in the background pass with screen/world-anchored tiling.

**Note:** data-driven pattern sprite-names are tracked in WS-2 (shared IR plumbing).

**Verify.** Shield rendering A/B against MapLibre on the OFM Bright
`highway-shield-*` layers (the canonical icon-text-fit case); dense-POI collision
A/B for WS-3a.

---

## WS-4 — Map-space anchors + pitch-alignment (3D label/offset correctness) · L–XL

**Closes:** `*-translate-anchor: map` for fill/line/circle/icon/text/fill-extrusion
(6 items), `text-pitch-alignment:map`, `icon-pitch-alignment:map`,
`circle-pitch-alignment`, `circle-pitch-scale`.

**WS-4a map-space translate · M** — viewport translate is fully wired
(`line.ts:1049` applies `clip.xy += translate*clip.w`; same for fill/circle). The
`map` anchor needs the offset applied in **world space before MVP** using the
tile-local coordinate frame, not post-MVP NDC. Add a `translateAnchorMap` flag to the
layer uniform and a pre-MVP branch in the vertex shaders.

**WS-4b pitch-alignment (ground-projected labels) · L–XL** — the hard one. Labels
are screen-space billboards by contract (`text-stage.ts:16` "never touches
projection"; `label-pass.ts`). `map` pitch-alignment requires projecting the label
anchor **and glyph-quad corners** through the camera MVP (the globe/ECEF MVP already
exists in `camera.ts:71`) and rendering glyph quads as ground-plane meshes. Scope:
`text-stage.ts` + `label-pass.ts` + the text-renderer WGSL. `circle-pitch-alignment`
/ `circle-pitch-scale` are the same idea for the point renderer (project the disc
onto the ground plane / scale radius with zoom).

**Risk/trade-off.** This is the largest non-renderer workstream. Sequence after
collision (WS-3a) since ground-projected labels still need screen-space collision
bboxes computed from the projected quad. Consider gating behind a capability flag and
keeping the billboard path as default for `viewport`/`auto` (the common case).

**Verify.** Pitched-camera (pitch=45–60°) fixture; confirm labels lie on the ground
plane and a `map`-anchored translate moves with the world, not the screen.

---

## WS-5 — Heatmap renderer (Batch 3) · L

**Closes:** `heatmap` layer + `heatmap-radius` / `-weight` / `-intensity` / `-color`
/ `-opacity` (5 props).

**Approach** (integration seams from the render-architecture survey):
1. New `HeatmapRenderer` (sibling of `PointRenderer`/`RasterRenderer`), registered on
   `XGISMap` and added to the `RenderLoopHost`.
2. New `heatmap-pass.ts` implementing `RenderPass` (`render/passes/pass.ts:24`),
   inserted into the chain in `render-loop.ts`.
3. Multi-render-target accumulation: per-feature Gaussian splat into an `r16float`
   density target (radius = `heatmap-radius` px, weight = `heatmap-weight`), then a
   separable Gaussian blur, then a density→color LUT pass driven by `heatmap-color`
   (interpolate over `heatmap-density`) and `heatmap-intensity`/`-opacity`.
4. New `shader-dsl/shaders/heatmap.ts` (`emitHeatmapWgsl`). `heatmap-density` and
   `accumulated` expressions become real inside this renderer (currently `na`).
5. Compiler: route `type:"heatmap"` layers to a `ShowCommand` kind
   (`layers.ts`, today skipped at `layers.ts:18`).

**Verify.** A/B vs MapLibre heatmap example at several zooms; check the color ramp
mapping and blur radius.

---

## WS-6 — raster-dem → hillshade → terrain (Batch 4) · XL

Today `raster-dem` source is **registered but inert** (`sources.ts:328`, warns "not
yet supported"); tiles can load as textures but nothing decodes elevation. No DEM
mesh, no Sobel, no displacement anywhere in the tree.

**WS-6a DEM decode · M** — decode `mapbox` / `terrarium` / `custom` encodings into a
single-channel elevation texture in the raster loader. Foundation for 6b + 6c.

**WS-6b hillshade renderer · L** — closes `hillshade` layer +
`hillshade-illumination-direction` / `-altitude` / `-anchor`, `-exaggeration`,
`-shadow-color` / `-highlight-color` / `-accent-color`, `-method`
(basic/combined/igor/multidirectional), `resampling` (9 props). New
`shader-dsl/shaders/hillshade.ts` computing surface normals from the DEM (Sobel) and
shading per the light params; new pass + renderer (same seams as WS-5).

**WS-6c terrain (3D ground) · XL** — closes top-level `terrain`. DEM-driven ground
mesh with elevation displacement, drape of 2D layers onto the mesh, depth integration
with existing extrusions. Largest single item; depends on 6a and reuses the
fill-extrusion depth path.

**Verify.** Hillshade A/B vs MapLibre `terrain-rgb`; terrain via the
MapLibre 3D-terrain demo with pitch.

---

## WS-7 — Raster color-adjustment fragment pass · M

**Closes:** `raster-hue-rotate`, `raster-brightness-min` / `-max`, `raster-saturation`,
`raster-contrast`, `raster-resampling` (+ `resampling` alias), `raster-fade-duration`.

**Approach.** Extend `fs_tile` (`shader-dsl/shaders/raster.ts`) with HSL
hue-rotate/saturation, linear brightness remap, and contrast, driven by new uniform
slots on `RasterRenderer` (`raster-renderer.ts:42`). `raster-resampling:nearest` adds
a second nearest-filter sampler binding (default stays linear; `linear` already
silenced). `raster-fade-duration` needs a crossfade between zoom levels — X-GIS swaps
tiles atomically today, so this is the heaviest sub-item (per-tile fade alpha during
the swap window).

**Verify.** Single-raster fixture toggling each adjustment; pixel-diff vs MapLibre.

---

## WS-8 — Style-spec `projection` field + globe transition · S–M

**Closes:** top-level `projection` (status `partial` → `supported`).

**Key finding:** all 8 projections (mercator, equirectangular, natural_earth,
orthographic, azimuthal_equidistant, stereographic, oblique_mercator, **globe**)
**already render** and are selectable via `setProjection()` /
`viewport-mode-controller.ts:68` / `?proj=`. The only gap is that the **converter
never reads the style's top-level `projection` field** (`mapbox-to-xgis.ts` warns and
drops it).

**Approach.** Parse top-level `projection` in the importer and call `setProjection()`
(same runtime path as `center`/`zoom`/`bearing`). Optionally add globe⇄mercator
transition animation (MapLibre interpolates by zoom) — the math exists
(`projections-table.ts` `promotesToGlobeWhenTilted`), only the keyframed transition is
missing. High perceived impact for low effort.

**Verify.** Import a `"projection":{"type":"globe"}` style; confirm globe renders
without `?proj=`.

---

## WS-9 — `light` keyword parsing · S

**Closes:** top-level `light` (status `partial` → `supported`).

The extrude shader already does MapLibre-equivalent directional + vertical-gradient
lighting with the default Mapbox light **baked as WGSL consts**
(`polygon.ts` `vs_main_quantized_extruded`). Gap: custom `anchor`/`intensity`/
`position`/`color` are dropped. Parse the `light` block in the importer and feed the
params as **uniforms** instead of consts (small uniform addition + shader read).

**Verify.** Custom-light fixture (non-default position/intensity); confirm wall
shading changes vs the default-light baseline.

---

## WS-10 — line-gradient (tiler arc-length tracking) · L

**Closes:** `line-gradient` + makes `line-progress` real (currently `na`).

**Prerequisite (the bulk of the work).** `geojson-vt` clipping **drops `lineMetrics`**
(`compiler/src/tiler/geojsonvt/index.ts:14`; `clip.ts` Sutherland-Hodgman). A line
spanning tiles loses the link to its original arc-length, so `line-progress` (0..1
over the *original* feature) can't be computed. Fix:
1. Tiler: preserve original-feature arc-length through clipping; emit per-clipped-
   segment `[progressStart, progressEnd]`.
2. `runtime/src/core/line-segment-build.ts:12` already carries `arc_start`/`arcTotal`
   for pattern placement — extend to interpolate a per-vertex `progress` 0..1.
3. New per-vertex `progress` attribute + a gradient LUT (emitted from the
   `line-gradient` interpolate stops) sampled in the line fragment shader.

**Scope note.** GeoJSON-source-with-`lineMetrics:true` only; PMTiles vector sources
cannot support it (no cross-tile arc-length). OFM Bright/liberty have **0** uses, so
this is low-impact insurance — sequence late.

**Verify.** GeoJSON line with `lineMetrics:true` + `line-gradient`; A/B vs MapLibre.

---

## WS-11 — Color / interpolate / format expression fidelity · M–L

**Closes:** `rgb`/`rgba` & `hsl`/`hsla` (data-driven channels), `interpolate
(cubic-bezier)` (color stops), `format` (per-span styling), `array` (type assertion).

- **rgb/rgba/hsl/hsla data-driven channels (S):** today only constant channels
  (hex-folded at convert). Route non-constant channels to the runtime evaluator
  (`evaluator.ts` already has `to_color`) so per-feature channel exprs evaluate.
- **interpolate cubic-bezier color stops (M):** numeric beziers densify to 6-sample
  piecewise-linear already; color stops still fold to pure linear. Extend the
  densify path to color (or evaluate the bezier-eased color in the runtime
  evaluator, like `interpolate_hcl`).
- **format per-span styling (L):** X-GIS labels render one style per layer; `format`
  per-span `text-color`/`font-scale`/`text-font` are dropped. True support needs
  multi-style text runs in TextStage (per-glyph style) — significant. Lower priority.
- **array type assertion (S):** add a per-element type tag or a runtime guard so the
  spec's "abort if not array" semantic holds (today it silently passes through).

**Verify.** Expression unit tests + a label fixture using `format` spans.

---

## WS-12 — Per-feature sort keys / draw order · M

**Closes:** `fill-sort-key`, `line-sort-key`, `circle-sort-key`, `symbol-z-order`,
`symbol-avoid-edges`.

X-GIS draws by layer order; these need a **per-feature sort pass** before draw.
`symbol-sort-key` already has the collision-sort hook (WS-2 makes it data-driven);
generalize that into a reusable per-feature ordering key for fill/line/circle
(stable sort of the index buffer / instance list by the resolved key).
`symbol-avoid-edges` skips labels whose bbox crosses a tile boundary — add a tile-edge
test in the label collision stage.

**Verify.** Overlapping features with differing sort keys must draw in key order
(z-order pixel check).

---

## WS-13 — Text-layout extras · M

**Closes:** `text-writing-mode` (CJK vertical, medium), `text-max-angle`,
`line-round-limit`, `text-optional`, `icon-keep-upright`.

- **text-writing-mode (M):** CJK vertical needs a per-glyph rotation/stacking path in
  TextStage (the curved-floor/vertical test files exist — partial groundwork).
- **text-max-angle (S):** per-layer override of the fixed max-angle threshold in
  line-label placement.
- **line-round-limit (S):** per-layer override of the fixed round→bevel threshold in
  the line-join logic.
- **text-optional (S):** depends on the WS-3a icon collision queue (text may drop if
  its icon can't place).
- **icon-keep-upright (S):** flip line-placed icons to face up (mirror of
  `text-keep-upright`, which is already done in `text-stage.ts:509`).

**Verify.** CJK label fixture; line-label angle/round fixtures.

---

## WS-14 — Spatial + locale expressions · L

**Closes:** `distance`, `within`, `distance-from-center`, `collator`,
`resolved-locale`, `is-supported-script`, `properties`.

- **Spatial (`distance`/`within`/`distance-from-center`) (L):** need per-feature
  geometry evaluation in the worker, with a spatial index for `distance`/`within`
  performance. `distance-from-center` needs per-feature screen-space distance.
- **Locale (`collator`/`resolved-locale`/`is-supported-script`) (M):** route
  `==`/`!=`/`in` through `Intl.Collator` when a collator is authored; today byte-exact
  compare. `is-supported-script` is a near no-op gate.
- **`properties` (S):** whole-properties-object accessor — X-GIS accesses by field
  name; add an object-literal accessor or document as unsupported-by-design.

**Verify.** Filter/expression unit tests with known geometries and locales.

---

## WS-15 — fill-extrusion ambient occlusion · M

**Closes:** `fill-extrusion-ambient-occlusion-intensity` / `-radius`.

Add a screen-space AO pass (or per-vertex AO from wall normals) over the extrusion
depth buffer; modulate wall shade by the AO term. The extrusion normal + depth path
already exists (`vs_main_ecef_extruded`).

**Verify.** Dense-building fixture; AO darkening in crevices vs MapLibre.

---

## WS-16 — Misc top-level / sources · M–L

| Item | Status today | Plan | Tier |
|---|---|---|---|
| `fog` | unsupported (low) | Depth-based post-process mix pass | M |
| `sky` | unsupported (low) | Sky dome (`sky-color`/`-atmosphere`/`-type`); pairs with globe atmosphere | M |
| `image` source | unsupported (low) | Single-image draped on a quad in the loader | S |
| `video` source | unsupported (low) | `<video>` → texture per frame; reuse image-source quad | M |
| `imports` | unsupported | Parse Mapbox v3 style-import & merge before convert | M |
| `transition` | unsupported (low) | Per-property fade-in (global + per-paint) | M |
| `metadata` | unsupported (low) | Informational — keep dropping (no-op) | — |

---

## na — no action (7)

`version`, `ref` (deprecated), `feature-state` (dynamic setter, no DSL equivalent),
and the per-layer-only camera expressions `accumulated` / `heatmap-density` /
`line-progress` / `sky-radial-progress` (these flip to real inside their owning
renderer — WS-5 / WS-10 / WS-16 — but need no standalone work).

---

## Recommended sequencing

1. **Quick high-leverage wins first:** WS-8 (projection field, S–M, big perceived
   impact), WS-9 (light, S), WS-1 (zoom-interp uniforms, M).
2. **Data-driven parity:** WS-2 (M–L) — flips the largest cluster of runtime gaps.
3. **Icons/shields:** WS-3 (L) — closes the only two `high`-impact unsupported items
   (`image` expr, icon-only/shield path) and the medium icon-collision cluster.
4. **New renderers:** WS-5 heatmap (L), then WS-6 raster-dem→hillshade→terrain (XL),
   WS-7 raster color (M).
5. **3D correctness:** WS-4 (L–XL) — map-space anchors + pitch-aligned labels.
6. **Long tail:** WS-10 line-gradient, WS-11 expressions, WS-12 sort keys, WS-13 text
   extras, WS-14 spatial/locale, WS-15 AO, WS-16 misc.

Each landed workstream: flip the affected rows in `spec-coverage.ts` /
`capabilities.ts`, keep the drift + `gap-matrix-freshness` tests green, regenerate
`scripts/gap-matrix.md` (`bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md`),
and attach a MapLibre pixel-diff for the property.

---

## Appendix — every open spec entry → workstream

**Partial (28):** light→WS-9 · projection→WS-8 · raster-dem→WS-6a · symbol-sort-key→WS-2 ·
text-overlap→WS-3a · text-pitch-alignment→WS-4b · icon-allow-overlap→WS-3a ·
icon-overlap→WS-3a · icon-optional→WS-3a · background-color→WS-1 · background-opacity→WS-1 ·
fill-antialias→(MSAA design; per-fragment AA opt-out, S, ties to polygon fs) ·
fill-translate→WS-1 · line-dasharray→WS-1 · line-translate→WS-1+WS-4a ·
line-translate-anchor→WS-4a · icon-translate→WS-2(non-const) · icon-translate-anchor→WS-4a ·
circle-blur→WS-2 · circle-stroke-opacity→WS-1 · circle-translate→WS-1+WS-4a ·
circle-translate-anchor→WS-4a · fill-extrusion-translate→WS-1 · rgb/rgba→WS-11 · hsl/hsla→WS-11 ·
interpolate(cubic-bezier)→WS-11 · format→WS-11 · array→WS-11

**Unsupported (69):** metadata(×2)→WS-16(no-op) · transition→WS-16 · fog→WS-16 · terrain→WS-6c ·
imports→WS-16 · image(source)→WS-16 · video→WS-16 · symbol(icon-only)→WS-3c · heatmap→WS-5 ·
hillshade→WS-6b · sky→WS-16 · line-round-limit→WS-13 · fill-sort-key→WS-12 · line-sort-key→WS-12 ·
circle-sort-key→WS-12 · symbol-avoid-edges→WS-12 · symbol-z-order→WS-12 · text-optional→WS-13/WS-3a ·
text-writing-mode→WS-13 · text-max-angle→WS-13 · icon-ignore-placement→WS-3a · icon-padding→WS-3a ·
icon-text-fit→WS-3b · icon-text-fit-padding→WS-3b · icon-keep-upright→WS-13 · icon-pitch-alignment→WS-4b ·
background-pattern→WS-3e · fill-translate-anchor→WS-4a · line-gradient→WS-10 · text-translate-anchor→WS-4a ·
icon-halo-color/-width/-blur→WS-3d · circle-pitch-scale→WS-4b · circle-pitch-alignment→WS-4b ·
fill-extrusion-translate-anchor→WS-4a · fill-extrusion-ambient-occlusion-intensity/-radius→WS-15 ·
raster-hue-rotate/-brightness-min/-max/-saturation/-contrast/-fade-duration/-resampling + resampling→WS-7 ·
heatmap-radius/-weight/-intensity/-color/-opacity→WS-5 ·
hillshade-illumination-direction/-altitude/-anchor/-exaggeration/-shadow-color/-highlight-color/-accent-color/-method + resampling→WS-6b ·
properties→WS-14 · image(expr)→WS-3c · collator→WS-14 · resolved-locale→WS-14 ·
is-supported-script→WS-14 · distance-from-center→WS-14 · distance→WS-14 · within→WS-14

**Runtime value-form gaps (17):** all covered by WS-1 (zoom-interp opacity/translate/dash) and
WS-2 (data-driven opacity/size/sort-key/pattern); `text-pitch-alignment` constant→WS-4b;
`raster-opacity` data-driven = N/A (raster has no per-feature dimension).
