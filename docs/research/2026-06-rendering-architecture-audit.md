# X-GIS Rendering Architecture Audit & Remediation Plan

### WebGPU correctness · visual-bug inventory · Blender-architecture alignment — 2026-06-08

> Synthesis of a 9-track investigation: 5 web-research tracks (WebGPU/WGSL spec, Blender depsgraph, Blender draw-manager/EEVEE, reference libraries, WebGPU bug-class playbook) + 4 codebase-audit tracks (tiles, projection/globe, blending/OIT/depth, labels). Every code claim carries `file:line`; every external claim is cited. Target architecture: **Blender** (depsgraph + data-model + draw-manager/GPU-module + EEVEE passes).

---

## 0. Executive summary

X-GIS is **architecturally strong and unusually well-tested** — the projection matrix gate, CPU↔GPU parity tests, and 300+ `iter-NNN` regression pins mean most "bugs" are _documented, gated `expected_red` tripwires_, not silent breakage. The visual problems cluster into **five root-cause families**, three of which have a single high-leverage fix each:

| Rank  | Root-cause family                                                                   | Fix (one lever)                                                                                                                    | Effort | Visual impact                                                      |
| ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| **1** | **f32 precision** in the _view matrix_ (deep-zoom drift, antimeridian cancellation) | RTC/RTE done right: build MV in f64 on CPU → small f32 matrix on GPU (xgis already has DSFUN/ECEF — the matrix itself is the leak) | M      | **High** (kills "tiles don't line up" + seam flicker)              |
| **2** | **Forward-Z depth** across globe/extrusion frustums                                 | **Reversed-Z + `depth32float`** (clear 0, `depthCompare:"greater"`, flip projection)                                               | **S**  | High (kills z-fighting/flicker, removes `depthBias` magic numbers) |
| **3** | **`flatViewHeightCapM` table gap** (azi/stereo discs ~39% undersized)               | Add projType 4/5 cap entries                                                                                                       | **S**  | Medium (3 `expected_red` cells flip green)                         |
| **4** | **Tile-selection budget** ignores perspective (high-pitch black holes)              | Perspective-aware frustum budget / per-layer compile budget                                                                        | M      | High at pitch≥60°                                                  |
| **5** | **Gamma pipeline ambiguity** + **label flicker** (no fade / cross-tile id)          | Verify sRGB-view path; add opacity-fade + cross-tile symbol id                                                                     | M      | Medium polish                                                      |

Plus one **regression in the just-merged S16** label skip (§5.4) — narrow but worth a follow-up.

The Blender target (§4) gives a coherent _destination_: the invalidation work (S3/S14/S16) is already Blender's **depsgraph**; the next leaps are **relations-based transitive invalidation**, **authoring-vs-evaluated (CoW) state**, and an **explicit EEVEE-style frame graph** with reversed-Z and a real OIT/forward split.

---

## Part A — Libraries & specs X-GIS should reference

### A.1 Ranked library shortlist

| #   | Library               | Reference it for                                                                                                                                                                                                                                                                                            | WebGPU maturity                                                                     |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | **MapLibre GL JS**    | The functional twin. `projectTile()` per-projection shader injection; **tile subdivision (granularity ≤128) before upload so earcut triangles don't distort on the globe**; **best-in-class SDF label + GridIndex collision** (curved-symbol AABB from corners+midpoints); globe→mercator auto-switch ~z12. | WebGL today; WebGPU in maplibre-native (Birk Skyum, Dawn/wgpu-native, landing 2025) |
| 2   | **deck.gl + luma.gl** | **Camera-relative "common-space" precision** (sub-cm in pure f32 — the easiest WGSL port of RTC); luma.gl's **WebGL2/WebGPU adapter + uniform-buffer** design as the model for a backend-agnostic layer.                                                                                                    | luma.gl v9.2 full WebGPU; deck.gl layers WIP                                        |
| 3   | **CesiumJS**          | The planet-scale authority: **RTE two-float ("the miracle", ~1.35 cm error)**, **hybrid log-depth + multi-frustum**, terrain skirts. Study _algorithms_, not code.                                                                                                                                          | WebGL2 only                                                                         |
| 4   | **Babylon.js**        | **Production OIT** (depth peeling + WBOIT) and battle-tested WebGPU pipeline/bind-group patterns.                                                                                                                                                                                                           | Production WebGPU since 5.0 (2022)                                                  |
| 5   | **three.js (TSL)**    | The **node-graph → WGSL/GLSL transpile** pattern, _if_ you want one shader source across a WebGL fallback. (Not for OIT — three.js has none built-in.)                                                                                                                                                      | Mature `WebGPURenderer`                                                             |

Honorable mention: **bevy `terrain_renderer`** (UDLOD seamless terrain LOD).

### A.2 Authoritative specs / docs to keep open

- **W3C WebGPU** <https://www.w3.org/TR/webgpu/> · **WGSL** <https://www.w3.org/TR/WGSL/>
- WebGPU Fundamentals — [transparency](https://webgpufundamentals.org/webgpu/lessons/webgpu-transparency.html) · [multisampling](https://webgpufundamentals.org/webgpu/lessons/webgpu-multisampling.html)
- [wgpu wiki — sRGB color formats](https://github.com/gfx-rs/wgpu/wiki/Texture-Color-Formats-and-Srgb-conversions) · [WebGPU reversed-Z sample](https://webgpu.github.io/webgpu-samples/samples/reversedZ/)
- Cesium — [Precisions, Precisions (RTE)](https://help.agi.com/AGIComponents/html/BlogPrecisionsPrecisions.htm) · [hybrid log depth](https://cesium.com/blog/2018/05/24/logarithmic-depth/) · [WBOIT](https://cesium.com/blog/2014/03/14/weighted-blended-order-independent-transparency/)
- [McGuire & Bavoil WBOIT (JCGT 2013)](https://jcgt.org/published/0002/02/09/paper.pdf) · [LearnOpenGL Weighted Blended](https://learnopengl.com/Guest-Articles/2020/OIT/Weighted-Blended)
- [NVIDIA depth precision](https://developer.nvidia.com/blog/visualizing-depth-precision/) · [Reed: depth precision visualized](https://www.reedbeta.com/blog/depth-precision-visualized/)
- Mapbox wikis — [Text Rendering](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering) · [Collision Detection](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection) · label flicker [#6052](https://github.com/mapbox/mapbox-gl-js/issues/6052) / fade [#6692](https://github.com/mapbox/mapbox-gl-js/issues/6692)
- Blender — [Depsgraph](https://developer.blender.org/docs/features/core/depsgraph/) · [GPU module](https://developer.blender.org/docs/features/gpu/overview/) · [EEVEE deferred pipeline](https://developer.blender.org/docs/features/eevee/pipelines/deferred/) · [EEVEE-Next (4.2 LTS)](https://code.blender.org/2024/07/eevee-next-generation-in-blender-4-2-lts/)

### A.3 WebGPU correctness rules X-GIS most needs to honor

1. **NDC depth is 0..1, not GL's −1..1** — a verbatim GL projection clips near geometry + z-fights. (`mat4.perspectiveZO`).
2. **Reversed-Z needs `depth32float`** — `depth24plus` may be unorm-backed, negating the float distribution.
3. **Premultiplied-alpha must match end-to-end** — canvas `alphaMode` + blend factors (`one`/`one-minus-src-alpha`) + actual color values; mismatch = dark halos/pink fringes.
4. **sRGB is the hardware's job** — render through an `-srgb` view (via canvas `viewFormats`); blending is gamma-correct **only** into an `-srgb` target. Manual `pow(c,2.2)` double-corrects.
5. **`loadOp:"load"` on later passes** — a stray `"clear"` wipes the basemap before labels (the "labels-only frame is blank" bug).
6. **RTC/RTE for planet scale** — f32 can't hold ECEF; do the big subtraction in f64 (CPU) or as a high/low f32 split (GPU).

---

## Part B — Visual-bug inventory (audit ↔ best-practice)

### B.1 Tiles: seams / LOD / flicker

| Symptom                                                            | Code finding (`file:line`)                                                             | Root cause                                                                     | Best-practice fix                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **High-pitch black/partial viewport** (z12/p60, z15/p75, z15/p84)  | `tile-high-pitch-coverage.test.ts:186`; 300-tile frustum budget                        | budget ignores perspective foreshortening → selector hits cap and gives up     | perspective-aware budget scaling at pitch>60°; the documented top-priority hole                                 |
| **Multi-layer overzoom partial coverage**                          | `tile-catalog.ts` / `multi-layer-overzoom.test.ts`; `resetCompileBudget(1)` once/frame | per-layer compile budget shares a time component → late layers starve          | hoist budget reset; pass per-layer time-remaining                                                               |
| **Missed-tile flicker** `[FLICKER] N tiles without fallback`       | `render-loop.ts:577`; grace=240 frames                                                 | LOD-boundary race: selection at new z before GPU cache fills / ancestor loaded | **retain-parent-while-loading + overzoom** (Mapbox); already partially present via ancestor protection — extend |
| **Deep-overzoom selection collapse** (z>maxLevel+budget → 0 tiles) | `tile-pipeline-predictor.ts:52`; `globe-deep-zoom-probe.test.ts`                       | f32 tile math precision at extreme zoom                                        | cap selection to maxLevel+N (tested safe) / f64 tile math                                                       |
| **Antimeridian seam flicker** (1px water seam)                     | `shader-dsl/shaders/projections.ts:269`; `_antimeridian-seam-coincidence.test.ts`      | ref-relative f32 accumulation >0.5px at some camera states                     | **same as §B.2 precision fix**                                                                                  |
| Sub-tile dash reset / "line through Russia"                        | `sub-tile-generator.ts:303-329`                                                        | Sutherland-Hodgman synthetic edges                                             | _mitigated_ (iter-250); fragile if edge predicate regresses                                                     |

> Samplers are already correct: raster + glyph atlases use `clamp-to-edge` + linear (`raster-renderer.ts:91`, `glyph-atlas-gpu.ts:46`). Add a **half-texel inset + baked tile buffer** only if raster seams appear.

### B.2 Globe / projection (16 documented `expected_red` cells)

| Family                                                | Cells                                                                     | `file:line`                                                                | Fix                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **f32 precision collapse**                            | `natearth-seoul-z14-deepzoom`, `equirect-seoul-z16-…`, antimeridian seams | `camera.ts:183` (`_buildRTCMatrix` in f32); `view-matrix.ts:58`            | **RTC in f64 → small f32 matrix** (Cesium) and/or **deck.gl common-space shift**; consider **MapLibre globe→merc switch ~z12** as a pragmatic cap. xgis has DSFUN split-precision for _vertices_ but the **view matrix is f32** — that's the leak. |
| **`flatViewHeightCapM` gap**                          | `azi-z0-p0-disc-uncapped`, `stereo-z0-p0-disc-uncapped`, `azi-z0-p60`     | `projections-table.ts:214` (no projType 4/5 entry → falls to `WORLD_MERC`) | add 4/5 cap entries — **smallest fix, 3 cells flip green**                                                                                                                                                                                         |
| **Camera near/far singularity**                       | `merc-z0-p60/p80-strip-bug`, `natearth-z0-p60-weakspot`                   | `camera.ts:88` (`maxViewAngle` not z-gated)                                | **log-depth / reversed-Z** + z=0 perspective guard                                                                                                                                                                                                 |
| **Architectural (ADR-0002)**                          | `globe-deep-z14-geoid` (~21 km pole seam)                                 | `ecef-vertex-camera-frame.test.ts:44`                                      | geoid unification (sphere camera vs WGS84 vertices) — deferred design call                                                                                                                                                                         |
| **Label projection-blind under pitch / antimeridian** | `merc-z8-p70-label-pitchalign`, non-merc wrapped copies unlabeled z≤4     | `label-pass.ts:179`                                                        | periodic-copy label enumeration; perspective-correct label depth                                                                                                                                                                                   |

### B.3 Blending / OIT / depth / gamma

**Mostly correct** — premultiplied canvas (`gpu.ts:185`), correct WBOIT blend states (`gpu-shared.ts:33`), two past double-multiply bugs already fixed (line composite `line-renderer.ts:310`, text `text-renderer.ts:123`). Gaps:

| Gap                                 | `file:line`                                                                                                                                                        | Issue                                                                                                                                                                                            | Fix                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forward-Z, not reversed-Z**       | `gpu-shared.ts:79` (`depth24plus-stencil8`, clear 1.0, `less-equal`); `depthBias:-1` magic at `:155`                                                               | limited depth precision across globe+extrusion frustums; coplanar outlines patched with bias                                                                                                     | **reversed-Z + `depth32float`** (clear 0, `greater`, flip projection) — removes the magic bias                                                             |
| **Gamma pipeline ambiguous**        | `gpu.ts:184` (plain `getPreferredCanvasFormat`, **no `-srgb` view**); `resolved-show.ts:70` calls stored colors "sRGB unit floats" while blend path assumes linear | a plain unorm canvas does **no** hardware linear→sRGB encode; if colors are sRGB-encoded and blended directly, blending is in sRGB space → "labels look slightly bolder" / translucent darkening | **definitively verify**: pick _either_ (a) `-srgb` view + linear colors + linear blend, or (b) document sRGB-direct intentionally; don't leave it implicit |
| **OIT default-disabled**            | `bucket-scheduler.ts:271` (`isOitExtrude=false`)                                                                                                                   | WBOIT exists but translucent extrusions fall back to offscreen composite                                                                                                                         | enable WBOIT for stacked translucency, or document the opt-in                                                                                              |
| **Text/icon blend mix in one pass** | `label-pass.ts:1030` (text premult `one`, icon straight `src-alpha`)                                                                                               | unverified halo/darken risk if icon shader output ≠ declared blend                                                                                                                               | verify icon shader output is straight-alpha against premult target                                                                                         |

### B.4 Labels / SDF text

**Strong** — SDF byte-slope unified (`distance-transform.ts:216`), halo **bit-identical to MapLibre** (iter-117), paired anchor drift fixed (seq-based pairKey), bilingual corruption gated, glyph-atlas generation-tagged. Residual:

| Symptom                                    | `file:line`                               | Status                                        | Fix                                                                                           |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Label flicker/pop on pan/zoom**          | (no fade path)                            | no opacity-fade, no cross-tile symbol id      | **Mapbox opacity-fade (300 ms) + CrossTileSymbolIndex** — the canonical map-label flicker fix |
| Sub-pixel label drift vs MapLibre          | `OFM_BRIGHT_RENDERING_OBSERVATIONS.md:33` | tracked (Phase 7.3/10)                        | label hysteresis                                                                              |
| Non-merc antimeridian copies unlabeled z≤4 | `label-pass.ts:179`                       | confirmed-open (low)                          | periodic-copy enumeration                                                                     |
| Glyph mid-frame slot aliasing              | `glyph-atlas-host.ts:263`                 | mitigated (gen-tagged); fragile on call-order | runtime assert preload-before-ensure                                                          |

### B.5 ⚠️ Regression risk in the just-merged S16 label skip (verified)

`label-pass.ts:254` skips `stage.prepare()`/`iStage.prepare()` when the dispatch sig is unchanged and `consumeLabelDirty()` is false. **Verified gap:** the sig captures camera/canvas/tile-cache/labelShows, but **not** (a) async label-resource landings — glyph `onLanded` (`text-stage.ts:807`) only re-rasterizes the atlas _slot_, and `IconStage` has **no** invalidate callback, and neither tags LABEL — nor (b) **time-driven label properties** (`resolveLabelEffectiveDef` uses `elapsedMs`). On a **continuously-rendering scene with a static camera + settled tiles** (`sceneHasAnimation`), a late glyph/sprite landing or an animated text-size/color is skipped until the camera moves.

**Recommended fix (depsgraph-aligned):** treat async resource arrival as an _edit_ — route glyph `onLanded` + sprite-atlas load through a `tag(LABEL)` (so `consumeLabelDirty()` catches it); and when any active label has a time-driven shape, treat LABEL as dirty each frame (or fold an `elapsedMs` bucket into the sig). Gate: add a `frame_stability` cell on an **animated** label scene so this is caught on the real-GPU matrix.

---

## Part C — Blender-architecture alignment

X-GIS already maps cleanly onto Blender. The plan is to _complete_ the mapping.

### C.1 Depsgraph ↔ invalidation (you are here: S3/S14/S16)

| Blender                                                              | X-GIS today                          | Next                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ID_RECALC_GEOMETRY/TRANSFORM/SHADING` component tags                | `DirtyDomains` bitset                | ✅ already the component layer                                                                                                                        |
| **Over-tagging is a perf bug**                                       | S14 granular tagging                 | enforce in review (material edit must not dirty VBOs)                                                                                                 |
| One `tag(id,domain)` API; **evaluator owns clearing**                | `consumeLabelDirty()` read-and-clear | ✅ exact pattern — extend to glyph/sprite landings (§B.5)                                                                                             |
| **Relations + flush → recompute the dirty _closure_**                | binary "is anything dirty?"          | **the next leap**: per-ID dirty nodes + parent/child & source→layer→material edges so an edit recomputes only its transitive closure, not `DIRTY_ALL` |
| **CoW**: authoring vs evaluated state; renderer reads only evaluated | not separated                        | medium-term: split authoring state from GPU-evaluated state                                                                                           |
| Rebuild-topology vs re-evaluate split                                | scene rebuild = `DIRTY_ALL`          | separate "structure changed" (rare) from "property changed" (common)                                                                                  |

### C.2 Draw-manager / GPU-module ↔ backend

- **Cacheable `GPUBatch` (topology+IBO+VBOs) keyed by source geometry, invalidated only on geometry edit** — the foundation of frame-to-frame skip (xgis's VTR bundles are close; formalize the batch-cache ↔ dirty-domain link).
- **Immutable cached pipelines keyed by (shader × render-state × attachment-format)** — matches WebGPU's immutable `GPURenderPipeline`; xgis's `gpu-shared.ts` blend/depth constants are the seed.
- **Declarative shader "create-info" + host-shared structs** — define bindings + uniform layouts once as data, generate WGSL, keep CPU/GPU struct layouts in sync (xgis's shader-DSL already half-does this).
- **GPU-driven instancing** — collapse thousands of repeated symbols/markers into one instanced draw (highest-leverage for dense symbol layers).

### C.3 EEVEE passes ↔ frame graph

EEVEE's ordered pipeline to mirror as an explicit frame graph (xgis already has the linear chain `opaque→oit→translucent→points→label→compose`):

1. **Depth prepass** (depth-only, early-Z, kills overdraw) — _new; high value even in 2D for layer occlusion_
2. **Opaque** (depth write ON) — forward for 2D, **G-buffer + deferred** if many lights/3D
3. **Transparent/forward** (depth test ON, write OFF, sorted; **skip the pass entirely when empty** — EEVEE's optimization, which xgis already does via `shouldRun`)
4. **TAA accumulation** (jittered projection, converges on static view; **reset on the same invalidation signal as batch-skip**) — gives near-free high-quality AA + makes dithered transparency viable
5. **Composite / tone-map / color management** (the place to nail sRGB, §B.3)

> **Reversed-Z + depth32float** (§B.3) is the prerequisite that makes a robust depth prepass + deferred path possible across globe-scale depth.

---

## Part D — Prioritized roadmap (visual-impact-per-effort)

**Tier 1 — do first (small, high-impact, low-risk):**

1. **Reversed-Z + `depth32float`** (clear 0, `greater`, flip projection) — kills z-fighting/flicker, removes `depthBias` magic. _Touches `gpu-shared.ts`, projection build, every pipeline's `depthCompare`._
2. **`flatViewHeightCapM` projType 4/5 entries** — 3 `expected_red` cells flip green. _One table._
3. **Verify the gamma pipeline** (sRGB-view vs sRGB-direct) — resolves the label-boldness/translucent-darkening ambiguity. _Diagnosis first, then a small change._
4. **S16 follow-up** (§B.5) — tag LABEL on glyph/sprite landing + time-driven props; add an animated-label `frame_stability` cell.

**Tier 2 — high-impact, medium effort:** 5. **RTC in f64 → small f32 view matrix** (`camera.ts:183`) — the single biggest correctness win; kills deep-zoom drift + antimeridian seam flicker. Pair with **globe→merc switch ~z12** as a cap. 6. **Perspective-aware tile budget** — fixes high-pitch black holes. 7. **Label opacity-fade (300 ms) + CrossTileSymbolIndex** — kills label flicker/pop. 8. **Enable WBOIT** for stacked translucency (or document the offscreen-composite opt-in).

**Tier 3 — architectural (the Blender destination):** 9. **Relations-based transitive invalidation** (depsgraph closure, past binary dirty). 10. **Explicit EEVEE-style frame graph** with depth prepass + TAA accumulation tied to the invalidation signal. 11. **CoW authoring-vs-evaluated state split.**

---

## Appendix — sourcing caveats

- `developer.blender.org` / `code.blender.org` / `docs.blender.org/api` and the JS-rendered W3C spec pages **blocked automated fetch (403)**; those claims are corroborated via the julianeisel wiki mirror, DeepWiki's source index (file/line cites into `blender/blender`), MDN, and the official WebGPU sample/fundamentals sites. Harden depsgraph flag bits against `source/blender/depsgraph/intern/depsgraph_tag.cc` and EEVEE pass order against `source/blender/draw/engines/eevee/eevee_pipeline.*` before encoding specifics.
- The exact `depthBias`/`depthBiasSlopeScale` polygon-offset formula is described qualitatively only — not fabricated here.
