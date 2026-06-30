# Engine/content split — P1 (all-draws-through-RHI) status + handoff

Companion to `engine-content-split.md` (the P0–P4 design authority) and
`render-graph-pass-scheduler.md`. This file tracks the **P1 implementation** (flip every renderer
to the single RHI Material draw path) and hands off the remaining P1.5/P1.6 + §4-seam + P2–P4 work
with the per-piece scope and the verification methodology learned along the way.

Branch: `feat/engine-content-split`.

## ⏭️ Next session — start here (ordered critical path)

P1 is ~91%: 5/6 renderers flipped (raw deleted, DC=0) + the VTR fill ROUTED for every common path
behind `__xgisVtrFillViaRhi` (default off), verified DC=0/within-noise across 7 fixtures. The clean
finish is dedicated work — do it in this order, each gated on real-GPU DC=0 + `tsc --build` + suite:

1. **Route the residuals** (they block the raw delete; the flip is a half-measure without them):
   - **Fill patterns** — author a deterministic fill-pattern fixture (a local sprite atlas via the
     `spriteUrl`/`setSpriteAtlas` path + a `fill-pattern-<sym>` fill layer through the VTR), then
     re-add `buildPatternGroundMaterial` (it was built + reverted, see git) + register
     `fillPipelinePattern{Ground,…}` in `_fillPerStyle`, verify DC=0. Extrude-pattern next.
   - **Per-variant no-pick** — register the variant `*NoPick` pipelines in `registerFillMaterials`
     (the code is in git history, reverted). VERIFY ONLY on a DEPTH-ON scene — picking forces
     sampleCount=1 and depth-OFF ground fills are non-deterministic under no-MSAA (the floor swings
     4..11; a clean DC=0 is impossible on a ground fill). Build a data-driven EXTRUDE fixture.
   - **OIT** — product decision: route the accum/revealage MRT Material (needs a named
     `'oit-revealage'` `{zero,one-minus-src}` blend + `rgba16float`/`r16float` RhiTextureFormat) OR
     formally drop the dead opt-in (`isOitExtrude` is always false).
2. **Real-world verify** — sweep OFM/Mapbox styles (the 7 fixtures are local; the Material mechanism is
   style-independent but blends/stencils in real styles are untested). Network tiles → offline fixture.
3. **Raw delete** (the flag is ALREADY flipped default-on, `ab3466f2` — Material seam is the production
   default; `__xgisVtrFillViaRhi=false` is the kill-switch). What remains is deleting the raw
   `drawIndexed` else-branch + the native fill pipelines: a `recordTileFill`-caller refactor so the VTR
   selects a Material VARIANT INDEX instead of a native pipeline (today `recordFillDraw` matches
   `pipeline === e.write`). Blocked until step 1's residuals route (they use the raw else-branch today).
4. **§4 seam** — the coupled cluster (`ShapeRegistry`/`GPUArena`/bind-group-registry → `Rhi*`,
   `RhiDevice.destroyBuffer`). Migrate together (a partial migration leaves a mixed Rhi*/raw state).
5. **P2 carve → P3 extract → P4 shell** (per `engine-content-split.md`).

## What P1 means + the gate

P1 routes EVERY primitive's draw through the RHI `Material`/`DrawItem`/`executeItems` core so
`@xgis/engine` is backend-agnostic *in fact* — the prerequisite for the P2 carve. Each renderer
increment is gated on a **real-GPU pixel-diff DC=0** (CLAUDE.md §5): render the same scene the raw
way and the RHI-routed way and confirm byte-identical output. Strict `tsc --build` + full suite green.

## Status (commits on this branch)

| Renderer | Status | Verification |
|---|---|---|
| **Point — tile** (P1.1a, `3f66c086`) | ✅ flipped, raw deleted | DC=0/304200, real GPU |
| **Point — GeoJSON/render()** (P1.2, `4853ef64`) | ✅ flipped, raw pipelines deleted (+ flat variant) | DC=0, 3 fixtures |
| **Heatmap — accum** (P1.3, `133af74e`) | ✅ flipped, raw deleted | within run-to-run noise (r16float accum is non-deterministic) |
| **Raster — render()** (P1.4, `829d5249`+`9896074b`+`0dcb3b53`) | ✅ flipped, raw deleted (+ resampling + pick MRT Materials) | DC=0, offline checker fixture |
| **Line — draws** (P1.5, `e1d399df`) | ✅ flipped, **raw deleted** (flag + raw pipelines/composite removed; LineDraper unconditional) | DC=0, fixture_translucent_stroke |
| **VTR fill** (P1.6, …`cc715b45`+`ab3466f2`) | ◐ every COMMON fill path routed; flag **flipped DEFAULT-ON** (`ab3466f2`) — Material seam is the production default, raw is the `__xgisVtrFillViaRhi=false` kill-switch. Raw-delete remains (blocked on residuals) | DC=0 default-vs-killswitch (fixture_extrude_local); 7-fixture mechanism DC=0; CI green |

Adjacent shipped on `feat/shader-dsl-glsl-compute-gpgpu` (M1–M5): shader-codegen SRP (compiler emits
neutral IR; shader-dsl is the sole emitter) + WebGL2 compute→fragment-GPGPU, with 3 real bugs the
real-GPU gate caught (the GLSL switch `break` fall-through fixed every `match()` on WebGL2).

## RHI extensions added (grow-as-needed, each with a live consumer)

- `r32uint` format + `WebGl2Device.dispatchComputeToR32UI` (M4 — WebGL2 compute dispatch).
- `RhiTextureFormat`/blend `'max'` (P1.5 — the translucent-line offscreen MAX accumulation).
- `setIndexBuffer(offset, size)` (P1.6 — the index sub-range for the VTR arena; CLOSED).
- `Material`/`PipelineVariant` gained `cullMode`, `vsEntry`, per-variant `stencil`, per-target `blend 'max'`
  + `writeMask`; `DrawItem` gained `vertexOffset/Size`, `vertex1` (slot 1), `index.offset/size`;
  `executeItems` forwards the vertex/index sub-ranges (P1.6 — the fill/extrude draw needs them).

## ⭐ Verification methodology bank (hard-won — applies to ALL real-GPU render verification here)

1. **NEVER `git stash` to make a pixel baseline while the vite dev server is live.** HMR serves a
   stale/half-built module → a spurious diff that is the harness, not the code (a phantom 1268px
   flat-rim "regression" in P1.2 — the same committed code via stash differed from the clean render by
   the same 1268px). Render the baseline from a CLEAN tree BEFORE applying the change, or toggle a
   runtime flag in-session (no rebuild).
2. **Non-deterministic renderers can't gate on DC=0.** r16float additive accumulation sums in GPU
   fragment-processing order → ~6 LSB run-to-run variation (P1.3 heatmap). Gate on
   `diff <= run-to-run noise floor` (RHI-vs-RHI run1/run2 == raw-vs-RHI), not DC=0.
3. **Network-tile renderers need a deterministic OFFLINE fixture.** raster tiles come from a CDN →
   no stable baseline. `fixture-raster-local.xgis` uses a url with NO `{z}/{x}/{y}` so every tile
   loads the same local `checker-tile.png` → byte-deterministic (P1.4).

## P1.6 VTR fill — routing DONE for every common path; flip + raw-delete remain

VTR **strokes** already route (`lineRenderer.drawSegments`, now unconditional RHI). The **fill** draw is
one `drawIndexed` method (`recordTileFill`); its body moved to `material/polygon-fill-material.ts`
(`recordFillDraw`) so the renderer stays under its size ratchet (the move NET-SHRANK the VTR). The fill
Materials live in that content module; `PipelineFactory` builds them behind `__xgisVtrFillViaRhi`
(default OFF — no extra pipelines built) and hands them to the VTR via `fillRhiState()` → `setFillRhi`
(wired from the source-manager, the main VTR setup path, defensively for unit-test stubs).

`recordFillDraw` matches the native pipeline ref the VTR selected → routes through the Material seam
(`executeItems`, arena vertex/index sub-ranges, pick MRT). Routed + verified (real-GPU, behind the flag):

| Fill path | Material | Verify (flag on vs off) |
|---|---|---|
| flat default-shader (constant fills) | `buildFlatFillMaterials` flat/ground (`pipes`) | fixture_stress 38 draws **DC=0** |
| per-style (data-driven `match()`) | live `_fillPerStyle` map (per variant, `registerFillMaterials`) | fixture_categorical 16 draws **DC=0** |
| opaque 3D extrude | `buildExtrudeMaterial` (`extrude` slot) | fixture_extrude_local 32 draws **DC=0** |
| no-pick (pointer-events:none, picking on) | `pickWriteMask:0` twins → `_fillPerStyle` + `extrude.*NoPick` | extrude **DC=0** (28); flat within-noise + by-composition |
| broad sweep | — | multi_layer 72 / filter_complex 28 DC=0 / mercator_clip 12, all maxdelta ≤ 3 |

Key findings (save the next session the debugging):
- **Extrude height rides the POLYGON_EXTRUDED vertex (slot 0), NOT a slot-1 z-buffer** — the z-buffer is
  null for extrude (the raw path binds it null); the extrude Material is 1 vertex buffer, no `vertex1`.
- **Data-driven extrude heights ALSO use the base `fillPipelineExtruded`** (height baked into the vertex
  at compile) → there is NO per-style extrude pipeline; the opaque-extrude route covers them.
- **picking is OFF by default** (`QUALITY.picking=false`); with it off the `*NoPick` pipelines ALIAS the
  pickable set → already covered. The no-pick twins only matter under `?picking=1` + pointer-events:none.
- `recordFillDraw` was confounded twice (counter=0): once because the wiring lives in `source-manager.ts`
  (not just `map.ts`), once by the wrong `cached.zBuffer` guard. Verify routing with the
  `__xgisVtrFillRhiDraws` counter, not just pixels.

**Unrouted residuals (the flip's blockers):**
- **Fill patterns** (`fs_fill_pattern`, `fillPipelinePattern{Ground,Extruded}*`) — a REAL path but NO local
  `.xgis` fixture exercises it (`fixture_pattern_multi` is a STROKE pattern; `fill-pattern-*` is OFM-Liberty
  network-only). `buildPatternGroundMaterial` was built then REVERTED (verify-before-ship — unverifiable
  locally). Needs a fill-pattern fixture (sprite atlas + `fill-pattern-<sym>`) to route + verify.
- **OIT translucent extrude** (`fillPipelineExtrudedOIT`, accum/revealage MRT) — DEAD by default
  (bucket-scheduler keeps `isOitExtrude=false`); kept for future opt-in. Custom blend (`{zero,one-minus-src}`
  revealage) is not a named Material blend yet.
- **Per-variant no-pick** (data-driven + pointer-events:none) — `registerFillMaterials` registers only the
  pickable variant pipelines; triple-niche.

**The flip (P1.6 finish) — why it is NOT a quick toggle:** `recordFillDraw` matches by NATIVE pipeline ref
(`pipeline === e.write`). Deleting the raw fill draw means the VTR must select a Material VARIANT INDEX
directly instead of a pipeline — a `recordTileFill`-caller refactor (the VTR pipeline-selection logic →
Material-resolution). It also needs (a) the residuals routed or excluded, and (b) real-world network-style
verification (the broad sweep is 7 local fixtures; OFM/Mapbox styles are untested + non-deterministic).
Flipping the flag default ON without the raw-delete keeps BOTH the native + Material pipelines (2x, until
the residuals let the native go). So: route residuals → network-verify → flip + Material-resolution
refactor → delete raw. Then the §4 seam retires the raw line + VTR paths together.

## §4 seam (Rhi* handles, the WebGL2-parity track)

The flips above are WebGPU byte-identical but still wrap raw `GPUBuffer`/`GPUBindGroup` at the draw
site (`wrapWebGpu*`). Closing the seam (resource builders CREATE via `rhi.createBuffer`/`createBindGroup`,
batches carry `Rhi*` handles, drop the draw-site wrap) is what makes them WebGL2-capable. On WebGPU
`rhi.createBuffer === device.createBuffer` (the `bufUsage` map is 1:1), so each piece is BYTE-IDENTICAL.

**The governing coupling rule (mapped 2026-06-30, workflow w6262ztgx):** a builder's buffer handle can
flip `GPUBuffer → RhiBuffer` only when (a) EVERY bind group referencing it is built via
`rhi.createBindGroup` AND (b) every RAW-fallback draw consuming it is deleted — because
`rhi.createBindGroup` needs `RhiBuffer` while raw `device.createBindGroup` needs `GPUBuffer`; one buffer
can't serve both without an unwrap shim (the non-byte-identical mixed state to avoid). Migration units, in order:

**Renderer §4-seam-readiness gate (checked 2026-06-30) — a renderer can migrate its CREATION side only
when it has NO raw-fallback draw (else the raw draw needs `GPUBuffer`):**
- **heatmap** ✅ sole-RHI → unit 1 DONE (`0e6adeda`).
- **raster** ✅ sole-RHI (`_rasterDraper` is render()'s sole path, P1.4) — ready, but texture-heavy (few buffers).
- **point / line** ✅ raw deleted (P1.1a/P1.5) — ready, but the COUPLED TRIAD (share ShapeRegistry).
- **icon** — IconDraper, no raw-fallback flag found; likely sole-RHI (confirm before migrating).
- **text** ⚠️ NOT FLIPPED — `__xgisTextViaRhi` defaults OFF (text-renderer.ts:426; raw `setPipeline`+`draw`
  at 429/455 is the default, the TextDraper at 461 is opt-in). So text needs a FLAG FLIP first (default-on
  + DC=0, exactly like the fill flip `ab3466f2`) BEFORE its §4-seam creation-side migration. This is an
  additional P1 "flip every renderer" item beyond the §4 seam.

Migration units (the buffer-bearing ones), in order:
1. **Heatmap-accum (DONE, `0e6adeda`).** Sole RHI path already (no raw accum draw),
   accum buffers + BG are private. Establishes `RhiDevice.destroyBuffer` at minimum risk. Files:
   rhi.ts (+`destroyBuffer`), rhi-webgpu.ts + rhi-webgl2.ts (impl), heatmap-renderer.ts (accum
   create/write/destroy/BG via rhi; blur/compose/ramp stay raw), heatmap-material.ts (HeatmapBatch →
   Rhi*, drop wraps). The 4 accum bufs are `base|COPY_DST` → map 1:1 (uniform/vertex/index/storage).
2. **Icon / Text (INDEPENDENT each).** Gate: confirm the raw fallback draw is deleted first; else treat
   like the triad.
3. **Point + Line + ShapeRegistry (COUPLED TRIAD).** `ShapeRegistry` (sdf-shape.ts) is shared by both.
   Order: (3a) delete point's raw `makeBindGroup` (point-renderer.ts:265-272) + flip point buffers;
   (3b) delete line's raw `createLayerBindGroup` + flip line buffers; (3c) ONLY THEN flip ShapeRegistry's
   getters `GPUBuffer → RhiBuffer` + drop the wraps (point-material.ts:54-57, line-material.ts:80).
4. **VTR / polygon cluster: GPUArena + uniform-ring + feature-data-binder + BindGroupRegistry (LAST).**
   Deeply shared; highest blast radius. Needs RHI CONTRACT EXPANSION beyond `destroyBuffer`: the arena
   buffer is `VERTEX|COPY_DST|COPY_SRC` but `RhiBufferUsage` has no `copy-src` + `bufUsage` only ORs
   COPY_DST → add `copySrc?: boolean` to `RhiBufferDesc` (additive, default false) + `RhiCommandEncoder.
   copyBufferToBuffer` (for `gpu-arena.ts` compaction) BEFORE flipping the arena, else compaction throws
   a validation error (latent — only under memory pressure / many tiles; verify on globe z10-11).

## After P1: P2 carve `@xgis/engine` → P3 extract `@xgis/map` → P4 runtime thin shell

Per `engine-content-split.md` + `render-graph-pass-scheduler.md`: data-driven `PassDef[]`, invert
`PassHost` → content-supplied `RenderNode`, the §8.5 `engine→@xgis/map import==0` ratchet. Each is a
large phase; gate every one on byte-identity + real-GPU DC=0.
