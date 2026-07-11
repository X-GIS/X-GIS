# #599 — globe vector great-circle drape, re-implemented on RHI + render-graph

**Status:** design LOCKED (2026-07-11) — ready for implementation. Maintainer decision: re-implement **approach B (texture-drape)** in full. Approach A (tiler subdivision) rejected as a partial-only mitigation.

**Design decisions (locked 2026-07-11).** The two open questions are resolved:

1. **Per-tile RenderTarget for I1** — the simplest bake target (one offscreen RT per visible globe tile). A tile **atlas** (one RT, many tiles packed) is an **I3 optimisation** that bounds the per-frame RT count; it is NOT an I1 prerequisite. Rationale: get the bake→drape pixel correct first on the simplest target, then bound cost.
2. **`VectorDrapeRenderer` SHARES the raster grid drape material** (the new-renderer-zero principle from §"Architecture") — it swaps ONLY the sampled texture source (the baked offscreen RT instead of a fetched raster tile). The fine-grid sphere projection + log-depth + world-copy fan-out are reused unchanged, so drape fidelity is inherited from the proven raster path rather than re-derived.

## Problem (grounded)

`map/src/render/vector-tile-renderer.ts:2220` sets the **ECEF-MVP directly** on the ECEF-DSFUN tile vertices (`:139`). A vector-tile triangle whose vertices span far-apart lon/lat is therefore projected as a **planar** triangle — its interior cuts a flat chord _under_ the curved sphere. Visible as faceting on large polygons/lines crossing a great circle at low globe zoom.

Raster tiles do **not** have this bug: `map/src/render/raster-renderer.ts` drapes them onto the sphere via `routeToSphereSelector` + `globeVisibleTiles` + the raster **grid** shader — the drape mesh is a finely-tessellated tile grid, so each quad is small and follows the curve. The vector path lacks this because it projects the _geometry's own_ vertices, not a fine grid.

## Why B, and why the old PoC does not rebase

The approach was previously **decided** as texture-drape (memory `project_globe_texture_drape_2026_06_24`: "bake vector tile→texture, drape dense sphere"). A PoC landed and was reverted in `5fe8cd64` (2026-06-25) **to unblock RHI #581**.

The `feat/globe-vector-drape` branch **no longer exists** (local or remote). The PoC survives only as the reverted commit. It is **not rebasable** — it predates three architecture shifts:

1. **RHI abstraction** (#581) — raw WebGPU → `RhiDevice`/`Material`.
2. **Engine-content-split** (#714/#781) — the PoC's files (`runtime/src/engine/render/{opaque-pass,raster-renderer,vector-tile-renderer,material/raster-material}.ts`) **moved to `@xgis/map`**.
3. **Render-graph redesign** — `RenderLoop` + `FrameContext` + `RenderTargets` + the 6-`RenderPass` model.

So B is a **fresh implementation on today's stack**, guided by the PoC as a reference. Recover the reference with:
`git show 5fe8cd64^:runtime/src/engine/render/passes/opaque-pass.ts` (and the raster-renderer / vtr drape hunks) — then adapt `runtime/engine → @xgis/map`, raw-WebGPU → RHI, ad-hoc passes → render-graph `RenderPass`.

## Architecture on the current stack

Reuse the raster globe-drape; add only the vector→texture bake in front of it.

```
visible globe tiles ─┐
                     │  (per tile, ONCE per tile/zoom — cached)
   BAKE PASS ────────┤  render the tile's vector geometry (polygon/line/point
   (offscreen RT)    │  fill+outline) into a tile-local 2D texture using a flat
                     │  tile-space ortho MVP — i.e. the tile as MapLibre draws it.
                     ▼
   DRAPE PASS ───────►  feed the baked tile textures into the SAME fine-grid
   (reuse raster)       sphere drape the raster path already runs
                        (routeToSphereSelector + globeVisibleTiles + grid VS).
```

- **Bake** — an offscreen `RenderTarget` per visible globe tile (or a tile atlas to bound RT count). The vector renderers (polygon/line/point/text) already draw in a 2D tile/Mercator basis; the bake reuses them with a tile-local ortho projection, no ECEF. Output = a raster-equivalent tile texture.
- **Drape** — the baked texture is draped exactly like a raster tile: the raster grid VS projects a fine tile-grid onto the sphere (no chords). Cleanest reuse is a `VectorDrapeRenderer` that shares the raster grid drape material and just swaps the sampled texture source (baked RT instead of a fetched raster tile).
- **Only on the globe** (`projType === 7` / `routeToSphereSelector`). Flat/Mercator vector rendering is unchanged (byte-identical) — the bake+drape path is gated behind the sphere route.

## Increments (author phase — each build + real-GPU verified)

- **I1 — offscreen tile-bake infra.** Bake ONE vector tile (fill + line/outline) into a per-tile offscreen colour RT in tile-local ortho. Verify: GPU readback shows the tile content (headed). Grounded plan (research 2026-07-11, `vector-tile-renderer.ts` = VTR):
  - **New thin entry point.** Add `bakeTileToTexture(layers, tileZoom, sizePx)` to VTR, modeled on the fills-only sibling `renderFillsRhi` (`:704`) + `renderLinesRhi` (`:908`) — VTR already carries purpose-built siblings, this is one more. It must **not** call `camera.getViewForProjection(...)`. The three existing draw entries all do (`render` `:2090`→`:2220`, `renderFillsRhi` `:762`→`:765`, `renderLinesRhi` `:1082`→`:1085`) and overwrite `B.set.mvp` with a perspective-RTC matrix + compute `cam_h/cam_l` camera-relative (`:3708-3722`) — those two facts are the exact blockers that forbid reusing them. Reuse the cached pipelines + bind groups (`cached.fill*`, `cached.outlineSegment*`, `cached.lineSegment*`) unchanged.
  - **Uniform injection — shader needs NO change.** The flat-Mercator arm already consumes tile-local coords (`polygon.ts:347-382`, `line.ts:323-341`). Set: `proj_params.x = 0` (enters that arm), `cam_h = cam_l = (0,0)` → `relLocal = local_merc − cam = local_merc` (pure tile-local 0..extent; line `cornerLocal` is already camera-relative so 0 leaves it tile-local), per-tile `tile_origin_merc` + `tile_extent_m`, and `B.set.mvp = ortho([0, tile_extent_m]² → NDC)` (y south→north +). `tile_extent_m = TWO_PI_R_EARTH / 2^tileZoom` is both the ortho range and the uniform.
  - **Offscreen RT.** `device.createTexture({ format, usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC })` per the `line-renderer.ts:304 ensureOffscreen()` bake pattern; lifecycle via `RenderTargets` (`@xgis/rhi-webgpu`). One-shot `beginRenderPass` into it.
  - **Verify (headed GPU readback — no RHI wrapper exists).** Copy the raw `copyTextureToBuffer` + `mapAsync` readback from `interaction-controller.ts:200-217`; assert the RT holds fill/line pixels (non-clear coverage in the tile footprint).
  - **Scope.** Include fill + line/outline (both flat-arm tile-local). Exclude point (external `PointRenderer`, own MVP — defer) and text/label (screen-space `label-pass.ts` — never tile-local). PoC precedent: `vtr.bakeTileToTexture(cachedLayersAt(z,x,y), z, 512)` existed pre-revert (`5fe8cd64^` `opaque-pass.ts:182`).
- **I2 — drape the baked textures** via the raster grid globe path. Verify: a globe vector tile renders curved (no chord) — 4×4 diff vs the flat-chord baseline (DC>0 at the chord region).
- **I3 — cache.** Bake only on tile-set / zoom change, not per-frame (the PoC had `_globe-cache.spec`). Verify: pan/zoom loop issues zero re-bakes at a fixed tile set.
- **I4 — restore the ~14 globe e2e specs** (recover from `5fe8cd64^`, adapt to the new arch): `_globe-{artifact-ab,baseline,cache,drape-realpath,multidrape,subrect,grid-ab,iso,…}`.
- **I5 — gate + A/B.** Great-circle-crossing triangle renders as a curve, not a chord; parity vs a MapLibre globe where available.

## Risks / open questions

- **Per-frame cost** — N offscreen RTs. Bound via a tile atlas + I3 caching. Measure the added pass cost post-render-graph.
- **Ellipsoid−sphere 21.5 km discrepancy** — the drape mesh is the _sphere_ (E2=0); the raster path already carries this note (`raster-renderer.ts:24`). Match its anchor handling so vector and raster drapes register.
- **World copies** — the bake+drape must fan out across visible world copies like the flat path (`enumerateWorldCopies`).
- **MSAA / resolve ownership** — the drape pass composites after the vector passes; follow the heatmap/overdraw-compose single-sample-after-resolve strategy to avoid the resolve-ownership hazard.
- **Text/labels** — screen-space labels are NOT draped (they billboard); only fill/line/point content bakes. Labels stay on the existing globe label path.

## Verification (the mandated gate)

The ~14 globe visual e2e (headed, real-GPU) are the gate — a headless session can build + GPU-readback the bake (I1) and diff the drape (I2) but the full fidelity gate is headed. Directional pixel-diff (§5): great-circle triangle curved-not-chord, and flat/Mercator vector rendering byte-identical (DC=0) off the globe.
