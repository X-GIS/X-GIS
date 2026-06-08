# Desktop-only rendering fixes — execution plans
### Real-GPU-gated items from the 2026-06 rendering audit (run with `XGIS_MATRIX=1 bun precheck:matrix`)

These two changes **cannot be responsibly completed in a GPU-less container** — their correctness is only visible on real-GPU rendering (framing on a headed disc; depth ordering on 3D extrusions). Each is mechanical given the pins below; do them with the matrix gate + a visual check.

---

## #2 — `flatViewHeightCapM` azi/stereo cap (3 `expected_red` cells → green)

**Why deferred:** two in-repo sources disagree on whether `WORLD_MERC` is correct for azimuthal_equidistant(4)/stereographic(5). `projections-table.ts:210-213` says it's intentional ("forward maps lon±90 past the rim"); the matrix manifest says it under-frames (~0.239 vs healthy ~0.589). There is **no correct azi/stereo cap encoded anywhere** — `globeAltitude` (`globe.ts:122`) shares the same `flatViewHeightCapM`, so both flat and pitched paths are broken identically. The manifest warns that guessing a constant "blesses a framing bug," so this needs a **headed-render framing review**.

**Single change site:** `runtime/src/engine/projection/projections-table.ts:214`
```ts
export function flatViewHeightCapM(projType: number, worldMercM: number): number {
  return projType === 3 ? 2 * EARTH_R_M : worldMercM   // ← add 4/5 cases
}
```

**Candidate caps (pick visually):** the cap is a z0 view-HEIGHT in metres; the disc's useful limb should land at the canvas edge like ortho's `2R` does.
- **azimuthal_equidistant (4):** `r = R·c`. Full world (c≤180°) → radius `πR` → diameter `2πR`. Hemisphere (c≤90°) → radius `(π/2)R` → diameter `πR`. → try cap `Math.PI * EARTH_R_M` (hemisphere) first.
- **stereographic (5):** `r = 2R·tan(c/2)`, diverges at the antipode. Hemisphere (c≤90°) → `r=2R` → diameter `4R`. → try cap `4 * EARTH_R_M`.

**Procedure:**
1. Set candidate caps. `XGIS_MATRIX=1 XGIS_MATRIX_FILTER='azi-*' bun precheck:matrix` (and `stereo-*`).
2. Open `playground/e2e/__matrix__/azi-z0-p0-disc-uncapped.png` — adjust the multiplier until the disc frames like `ortho-z0-p0-disc` (limb at the canvas edge, no large black surround).
3. Re-check the pitched cell `azi-z0-p60-disc-pitched` (shares the cap via `globeAltitude` — should improve for free).
4. Once visually correct, in `matrix.manifest.ts` flip those cells `knownStatus: 'expected_red' → 'green'` and tighten `disc_fraction.expected/max` to the measured value. Same for `azi-ofm-z2`, `stereo-ofm-z2`.
5. `bun run build` + full `precheck:matrix`.

---

## #4 — Correct WebGPU `[0,1]` depth + reversed-Z (z-fighting / extrusion depth)

**Why deferred:** behavior-changing across **every** pipeline's depth state; the synthetic matrix cells are flat 2D (single depth plane, ground layers use `depthCompare:'always'`) so they **do not exercise depth** — only 3D extrusion + globe on real GPU validate it. No local signal.

**Two bugs, one fix:**
1. **GL-range projection** — `camera-helpers.ts:45` `perspectiveMatrix` emits the OpenGL `z∈[-1,1]` mapping (`(far+near)*nf`, `2*far*near*nf`). WebGPU clips to `z∈[0,1]`, so the near half of the frustum is mathematically wrong (latently invisible for flat 2D; a real cause of the extrusion coplanar/z-fight issues + the `depthBias:-1` magic at `gpu-shared.ts:155`).
2. **Forward-Z low precision** across globe/extrusion depth.

**The fix = a reversed-Z `[0,1]` perspective** (near→1, far→0; best float-depth distribution; the modern standard).

**Exact change sites:**

| Site | Change |
|---|---|
| `camera-helpers.ts:45` `perspectiveMatrix` | Replace the depth row with the **reversed-Z [0,1]** form. For finite far: row2 `= near/(far-near)` (or `0` for infinite-far reversed-Z), row3 `= far*near/(far-near)` (or `near` for infinite far). Verify against `webgpu-samples/reversedZ`. **NB:** also audit `buildGlobeMatrix` (globe.ts) if it builds its own perspective. |
| `render-targets.ts:106,147` + `gpu-shared.ts:79,90,111,125` | `depth24plus-stencil8` → **`depth32float-stencil8`** (true float depth — required for reversed-Z precision). |
| `opaque-pass.ts:102`, `points-pass.ts:40` | `depthClearValue: 1.0` → **`0.0`**. |
| `gpu-shared.ts:80,91,143,243` | `depthCompare: 'less-equal'` → **`'greater-equal'`**. Ground `'always'` stays `'always'`. |
| `gpu-shared.ts:149-158` (`DEPTH_READ_ONLY` coplanar outline) | Flip `depthBias`/`depthBiasSlopeScale` sign **`-1 → +1`** ("toward camera" is now larger depth). Re-tune or ideally remove once precision is fixed. |
| Any reversed depth read in WGSL (fog/depth-based effects, if any) | Invert depth comparisons/reconstruction. Grep `frag_depth`, `position.z`, depth-sampling. |

**Validation (desktop):**
1. `bun run build` + `XGIS_MATRIX=1 bun precheck:matrix` — confirm flat cells still pass (necessary, not sufficient).
2. **Visual on 3D content** — an extruded-buildings demo (OFM Bright at high pitch, z14+): buildings must occlude correctly, no z-fighting on coplanar roofs/walls, the "lake hidden under landuse" class stays fixed.
3. **Add a depth-ordering matrix cell** (overlapping extrusions where front must occlude back, verified by a pixel-colour oracle) so this is gated going forward.
4. Globe at high zoom — terrain/extrusions across the large frustum should stop flickering.

> If any single site is missed, geometry inverts/disappears on real GPU — do them as one atomic change and validate visually before pushing.

---

## #4b — Depth-ordering matrix oracle (the gate for #4)

**Why real-GPU only (measured, not assumed):** I spiked this in-container — flat synthetic countries fill **56.75%** emerald under SwiftShader, but the **same geometry extruded renders 0.00% emerald / 2.48% non-black**. So **the 3D extrude pipeline does not raster under SwiftShader** — this oracle cannot be validated in CI/software-GPU and must be built + validated on the real-GPU desktop, alongside #4. Build it *before* flipping #4 so it gates the reversed-Z change.

**What it proves:** two overlapping extruded features (NEAR taller, FAR shorter) at the same lon/lat, viewed at pitch — NEAR must occlude FAR. A botched reversed-Z (wrong compare/clear/format/sign) flips or breaks occlusion → the oracle fails. The current renderer occludes correctly (`opaque-pass.ts:174-215` two-phase, `less-equal` + depth write), so it passes today and gates against the regression. `frame_stability` already catches the *temporal* half (z-fighting flicker); `depth_order` adds the *static* occlusion-color check.

**Implementation (no engine changes — fixture + oracle only):**
1. **Fixture** — `playground/render-verify/fixtures.ts`: add `EXTRUDES` = two same-footprint polygons with `properties.height` 50 (near) / 20 (far) and distinct fill colors; export into `FIXTURE_SOURCES`.
2. **Demo** — a DEDICATED `.xgis` (do NOT touch `fixture-render-verify.xgis` — the other synthetic cells share it). New `fixture-extrude.xgis` with two layers (`buildings_near` filter `.name=="near"` blue-400, `buildings_far` filter `.name=="far"` blue-600), both `fill-extrusion-height-[.height]`. Register a `synthetic_extrude` dataset + DEMO_ID in `_matrix-gate.spec.ts`.
3. **Oracle kind** — `matrix-types.ts`: add `'depth_order'` to `OracleKind` and an optional `config?: { nearColor; farColor; pixelRegions }` to `OracleSpec`.
4. **Detector** — `matrix-oracles.ts` `runDepthOrder()`: sample a 3×3 interior region at the NEAR top-face; pass when ≥80% of samples match `nearColor` (±20/ch) AND 0% match `farColor`. (Sample interior, not edges, to avoid AA fuzz.)
5. **Cell** — `matrix.manifest.ts`: `merc-extrude-occlu` (mercator z5 p30 bearing0 center [0,0]), `dataset: 'synthetic_extrude'`, oracles `depth_order` + `frame_stability` + `black_ratio`. **`gate: 'soft'` initially** (pixel-color occlusion is precision-sensitive); promote to `hard` after several stable real-GPU runs.
6. Validate: `XGIS_MATRIX=1 XGIS_MATRIX_FILTER='merc-extrude-*' bun precheck:matrix` — confirm green on the current (correct) renderer, then keep it green through the #4 reversed-Z change.

---

## Already done in-container (verified here)
- **S16 skip staleness fix** (async glyph/sprite landing + time-driven labels) — committed, build + 2569 vitest + software matrix green.
- **#3 gamma** — diagnosed as **not a bug**: sRGB-space blending is deliberate and matches the MapLibre pixel-match baseline; documented at `gpu.ts:185`. No change needed.

## Investigated and intentionally NOT done in-container
- **Depth-ordering oracle (#4b)** — extrude pipeline doesn't raster under SwiftShader (measured above), so it can only be validated on real GPU; full design above, build it with #4.
- **High-pitch tile coverage** — the documented holes (z12/p60, z15/p75, z15/p84) are **already mitigated** by the 2026-05-04 camera-tile injection (`tile-select.ts:426-498`); `tile-high-pitch-coverage.test.ts`'s `KNOWN_FAIL_AT` set is empty and all assertions pass. The remaining "near-first DFS" refactor is a quality change to *working* code with a broad regression surface (GPU-cache thrash, convergence perf, 5+ pinned tests) — deliberately not undertaken unprompted.

