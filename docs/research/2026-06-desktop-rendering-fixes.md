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

## Already done in-container (verified here)
- **S16 skip staleness fix** (async glyph/sprite landing + time-driven labels) — committed, build + 2569 vitest + software matrix green.
- **#3 gamma** — diagnosed as **not a bug**: sRGB-space blending is deliberate and matches the MapLibre pixel-match baseline; documented at `gpu.ts:185`. No change needed.
