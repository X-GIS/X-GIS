# Hillshade + raster-dem — #777 Phase II design

**Status:** design → implementation (branch `feat/hillshade-777-phase-ii`)
**Authority for scope:** issue #777 Phase II (II1–II6); spec = `@maplibre/maplibre-gl-style-spec` 24.8.5 (`$version: 8`).
**Parity reference:** MapLibre GL JS `main` — `src/data/dem_data.ts`, `src/webgl/draw/draw_hillshade.ts`, `src/webgl/program/hillshade_program.ts`, `src/shaders/glsl/hillshade{,_prepare}.*.glsl`.

This closes the largest single unsupported cluster in the gap-matrix: the `hillshade` layer + 9 `hillshade-*` paint rows (all `unsupported`) and flips `raster-dem` (`partial`→`supported`). It is also a headline example in both the Mapbox and MapLibre galleries ("Add hillshading").

---

## 1. Architectural thesis — hillshade IS a raster-dem tile draw

Recon (5-lane, 2026-07-18) confirmed X-GIS already has a complete, production raster-tile pipeline:
converter → `SourceManager` (`{_tileUrl}` marker) → `RasterRenderer` (own tile-selection + LRU + parent-fallback +
WGS84-ellipsoid ECEF anchor) → engine-RHI `RasterDraper` (`Material`) → DSL `raster.ts` (`vs_tile` procedural
grid, per-projection dispatch, pole caps). **A hillshade tile is structurally a raster tile with a different
fragment shader.** So the design is _reuse, not rebuild_:

| Concern                                                         | Reuse                                                       | New                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Tile fetch / LRU / parent-fallback / ellipsoid anchor           | `RasterRenderer` machine (copy)                             | `HillshadeRenderer` (new file, keep <800 LOC) |
| Draw seam (engine `Material`, no raw WebGPU)                    | `RasterDraper` pattern                                      | `HillshadeDraper`                             |
| Vertex: procedural grid, globe/flat/oblique dispatch, pole caps | `vs_tile` (`raster.ts`) — **share verbatim**                | —                                             |
| Fragment                                                        | —                                                           | `fs_hillshade` (DEM decode → Sobel → shade)   |
| Uniform packing                                                 | `reflect()`-driven slot pattern (`raster-uniform-slots.ts`) | `hillshade-uniform-slots.ts`                  |
| Converter paint plumbing                                        | raster `addRasterScalar` constant-form precedent            | `emitHillshadePaint`                          |

**Consequence:** globe / azimuthal / stereographic / oblique support is inherited for free by reusing `vs_tile`
(the projection dispatch is single-authority in `shaders/dsl/projections.ts`). Do NOT re-derive the ECEF anchor
(the ~21.5 km split-brain lesson) — `vs_tile` already anchors on the WGS84 ellipsoid.

Factor `vs_tile` (+ the pole-cap fan) out of `raster.ts` into a shared export, or parameterise
`buildRasterModule` so raster and hillshade share ONE vertex authority. Prefer a shared export
(`buildTileGridVertex(...)`) so a projection fix lands once.

---

## 2. DEM decode — RGBA8 + in-shader unpack (D2)

The RHI has no `r16uint`/float-32 sampling format (`rhi.ts`), and DEM tiles arrive as PNG (RGBA8) with
RGB-packed elevation. So DEM stays `rgba8unorm` and is decoded in the fragment (MapLibre does the same).

`unpack = vec4(redFactor, greenFactor, blueFactor, baseShift)`, texel channels scaled to 0–255:

```
elevation_m = R*redFactor + G*greenFactor + B*blueFactor - baseShift        // R,G,B ∈ [0,255]
```

| encoding             | redFactor          | greenFactor   | blueFactor         | baseShift   |
| -------------------- | ------------------ | ------------- | ------------------ | ----------- |
| **mapbox** (default) | 6553.6             | 25.6          | 0.1                | 10000.0     |
| **terrarium**        | 256.0              | 1.0           | 0.00390625 (1/256) | 32768.0     |
| **custom**           | source `redFactor` | `greenFactor` | `blueFactor`       | `baseShift` |

- WGSL `textureSample` returns normalised [0,1] → multiply by 255 before the dot (mirror MapLibre's `texture()*255`).
- **Sample the DEM NEAREST for the raw fetch** — bilinear over packed RGB corrupts the decode. The `resampling`
  paint prop toggles nearest/linear over the _decoded_ height field (see §3), not the raw texel fetch.

Thread `encoding` + `tileSize` (and `redFactor/greenFactor/blueFactor/baseShift` for `custom`) from the
`raster-dem` source through the DSL — today `sources.ts:368-415` drops all of these (emits only type+url).

---

## 3. Shading — single draped pass (D3), method scope (D4)

Epic II2 scopes hillshade as a **raster-style draped pass (reuse RasterDraper)** — a single pass, NOT MapLibre's
two-pass prepare→draw. So `fs_hillshade` computes the derivative in-shader per fragment:

1. Decode the centre elevation + the 8-neighbour 3×3 stencil (`uv ± dem_texel_size`), NEAREST taps.
2. Sobel derivative (MapLibre `hillshade_prepare.fragment.glsl` weights):
   `deriv.x = (c+2f+i) − (a+2d+g)`, `deriv.y = (g+2h+i) − (a+2b+c)`, scaled by
   `tileSize / pow(2, exaggeration_zoom + 28.2562 − zoom)` where the zoom-exaggeration term is
   `(zoom−15)*k`, `k = 0.4 (z<2) | 0.35 (z<4.5) | 0.3 (else)`, clamped to 0 at/above z15.
3. Latitude correction (MapLibre `hillshade.fragment.glsl`): divide `deriv` by
   `cos(radians(mix(latBottom, latTop, v)))` — the Mercator vertical-exaggeration correction.
4. Method math (`u_method`) — **MVP ships `standard` (default, mandatory for byte-parity) + `basic`**:
   - **standard (0):** MapLibre legacy. `slope=atan(0.625*len(deriv))`, intensity=`exaggeration`,
     `base=1.875−intensity*1.75`, scaled-slope power curve; `accent_color=(1−cos(scaledSlope))*u_accent*clamp(intensity*2,0,1)`,
     `shade=|mod((aspect+azimuth)/π+0.5, 2)−1|`, `shade_color=mix(shadow,highlight,shade)*sin(scaledSlope)*clamp(intensity*2,0,1)`,
     out = `accent_color*(1−shade_color.a)+shade_color`. Uses accent; ignores altitude.
   - **basic (4):** GDAL Lambert. `deriv*=exaggeration*2`, `cang=(sinAlt−(deriv.y*cosAz*cosAlt−deriv.x*sinAz*cosAlt))/sqrt(1+dot(deriv,deriv))`,
     `shade=clamp(cang,0,1)`, out = `shade>0.5 ? highlight*(2*shade−1) : shadow*(1−2*shade)`. Uses altitude.
   - `azimuth = direction_rad + π`; **anchor** (§4).
   - `combined`/`igor`/`multidirectional` → warn + fall back to `basic` (documented residual).
5. **`resampling`:** `nearest` → per-DEM-texel flat shading (blocky, matches MapLibre `nearest`). `linear`
   (spec default) → bilinearly blend the _decoded_ neighbour heights before the Sobel (NOT the packed bytes),
   recovering MapLibre's smooth look without a second pass.

**Single-source constant forms only (D5):** `direction`/`altitude` scalars, `shadow`/`highlight`/`accent`
single colours. numberArray/colorArray multi-source (→ `multidirectional`) is a follow-up. Zoom-interp via
`interpolateZoomCall` is optional; constant + warn-on-non-constant is the MVP (raster `addRasterScalar` precedent).

**Tile-edge seams:** an 8-neighbour tap at a tile edge reads outside `[0,1]` uv; CLAMP_TO_EDGE returns the edge
texel → a ≤1-DEM-texel flat seam. This is _exactly_ MapLibre's pre-backfill state (its self-seeded border). The
cross-tile 1px border backfill (MapLibre's `backfillBorder` + `needsHillshadePrepare` re-flag) is the genuinely
new infra with no raster precedent and is **deferred** — documented as the `hillshade` partial residual.

**Upgrade path (out of MVP scope):** a two-pass prepare (DEM→derivative FBO) + cross-tile backfill is where
MapLibre-exact smoothness and seamless edges would land, and is the natural host for the future `terrain` drape
(II6). MVP single-pass is the right-sized closure that makes the gallery example render.

---

## 4. Illumination anchor (D6 lighting), draw slot

- **anchor = map:** azimuth is data-space (north) — no bearing term.
- **anchor = viewport** (spec default): `azimuth += camera.bearingRadians` so the light stays fixed to the screen
  as the map rotates. Compute per-frame in the renderer (uniform), mirror `hillshade_program.ts:90-97`.

**Draw slot:** MapLibre draws hillshade in the translucent pass, interleaved by layer order. Raster in X-GIS draws
back-most in `opaque-pass` `isFirst` — too early (opaque fills would occlude the relief). MVP adds a dedicated
`HillshadePass` slotted in `PASS_CHAIN_ORDER` **after `translucent`, before `points`** (relief over fills, under
labels — correct for the canonical relief-overlay usage and the gallery example). This touches:
`pass-order.ts` (`PASS_CHAIN_ORDER` + `RHI_TWIN_MISSING` until the WebGL2 twin ports it), `pass-chain.ts`
(`PASSES` map), and `pass-order-parity.test.ts`. **Validate the slot against the real demo render** (grounding
loop): if relief is occluded, the slot is wrong. Arbitrary per-declaration-order interleaving is a follow-up.

---

## 5. Coverage 3-way sync (CLAUDE.md §12 — do NOT flip silently)

Flipping the rows is a THREE-way sync gated by three drift tests:

1. **spec-coverage descriptors:** `spec-coverage/paint-hillshade.ts` (9 rows `unsupported`→`supported`/`partial`;
   rewrite the STALE notes — current notes call direction a scalar, omit method default `standard`, mislabel
   `resampling` as `bilinear/nearest` vs spec `linear/nearest`), `spec-coverage/layer-types.ts` (`hillshade` row),
   `spec-coverage/source-types.ts` (`raster-dem` `partial`→`supported`). Refresh drifted `source:` line refs.
2. **RUNTIME_CAPABILITIES:** CREATE `runtime/src/capabilities/hillshade.ts` (`readonly RuntimeCapability[]`) and
   wire the import + spread into `capabilities.ts`. **Mandatory** — flipping 9 paint props to `supported` without
   capability rows adds ~9 orphans and breaches the `<3` orphan ceiling in `spec-coverage-runtime-drift.test.ts`.
   (`hillshade` layer-type + `raster-dem` are already in `NON_RENDERABLE`; the 9 paint names are NOT.)
3. **gap-matrix:** regenerate `bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md` (STDOUT redirect, gated
   byte-exact by `gap-matrix-freshness.test.ts`).

Plus the compiler drift gate: `spec-coverage-drift.test.ts` `readConverterSource()` scans a HARD-CODED file list —
**add the new hillshade converter emitter file to that list**, or its `paint['hillshade-…']` refs are invisible
and the `supported` rows become orphans → test fails. Also move `hillshade` out of `SKIP_REASONS` (`layers.ts`)
into a real `registerLayerConverter('hillshade', …)`; the drift gate recognises both shapes.

---

## 6. Verification (CLAUDE.md §5 mandatory) + gates

- **Deterministic DEM fixture:** commit a static Terrain-RGB PNG under `playground/public/` (e.g. `/dem-fixture.png`),
  reference it templatelessly (no `{z}/{x}/{y}`) from a `type: raster-dem` `.xgis` source — clone
  `fixture-raster-local.xgis`. In-page self-calibration of expected values (clone `_raster-gl2-gate.spec.ts:34-52`)
  so fixture-art edits can't silently rot the gate.
- **CI-gateable gate:** `_hillshade-gl2-gate.spec.ts` — WebGL2 `?forcegl2=1` + `gl.readPixels`, self-calibrating,
  asserts backend explicitly (`__xgisActiveBackend`, `ctx.rhi.backend`, `gl.getError()===0`). SwiftShader-safe.
  **Add it BY NAME to `.github/workflows/test.yml:589`** (hard-coded list, no glob — else it never runs in CI).
- **Real-GPU A/B (local, mandatory before claiming parity):** MapLibre compare-runner on a matching `style.json`
  (mapbox-encoding DEM) → directional pixel-diff (DC>0, D1<D0) + 16-split full-res read of the diff. Measure the
  same-code noise floor first (globe ~14% DC). This is NOT CI-gateable (SwiftShader can't raster) — local/pre-push.
- **Converter tests:** fail-before probes (clone `background-pattern-convert.test.ts`) — replace `sky-layer-skip`'s
  mirror `hillshade` skip assertions with emit + warning assertions.
- **Uniform byte-equality:** clone `raster-frame-uniform.test.ts` for `writeHillshadeFrameUniform`.
- **Full merge gate:** FULL `bun run test` (vitest — NOT just precheck; precheck skips `map/src`) → `bun run build`
  (typecheck authority; TS6133) → `tsc -p runtime/tsconfig.json` → BOTH loc ratchets (`map/src/loc-ceiling-ratchet`
  - `runtime/src/engine/architecture-invariants`) → drift gates → CI green.

---

## 7. Increments (each = one commit on the branch)

- **INC-1 — converter + source threading (CPU-only, tightest gates).** raster-dem source threads `encoding` +
  `tileSize` (+ custom factors) through the DSL. Un-skip `hillshade`, `registerLayerConverter`, `emitHillshadePaint`
  (constant forms + warn-on-non-constant), utility-registry rows + `lower-bindings` → ShowAccumulator fields.
  Fail-before converter tests. NO coverage flip yet (renderer absent).
- **INC-2 — DSL shader + uniforms.** Share `vs_tile`; author `fs_hillshade` (decode → Sobel → standard+basic);
  `hillshade-uniform-slots.ts`; WGSL+GLSL emit goldens; shader-dsl vitest.
- **INC-3 — runtime renderer + pass.** `HillshadeRenderer` + `HillshadeDraper` (mirror raster; DEM nearest fetch);
  `source-manager` routes `raster-dem` → hillshade path (+ guard so a plain `raster` layer never draws a DEM as
  colour); `HillshadePass` + pass-order wiring; `map.ts` owner field; uniform packer + byte-equality test.
- **INC-4 — coverage 3-way sync.** Flip descriptors; create `capabilities/hillshade.ts`; add converter file to
  `spec-coverage-drift` scan list; regenerate gap-matrix. All drift gates green.
- **INC-5 — fixtures + gates.** Local Terrain-RGB DEM PNG + `.xgis` demo; compare-runner style.json; `_hillshade-gl2-gate`
  spec; add to `test.yml:589`.
- **INC-6 — verify + full gate + PR.** Real-GPU A/B vs MapLibre (DC>0, D1<D0, 16-split); full merge gate; PR; CI.
  File the `terrain` epic issue (II6) as the two-pass-prepare + vertex-displacement follow-up.

**Exit proof:** converter tests red→green · shader emit goldens stable · uniform byte-equality · all drift gates
green · real-GPU A/B DC>0 & D1<D0 vs MapLibre on the DEM fixture · full local gate + CI green.
