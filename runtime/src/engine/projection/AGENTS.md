<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# projection

## Purpose
Camera math and the seven map projections. `projection.ts` is the CPU side: `mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `azimuthalEquidistant`, `stereographic`, `obliqueMercator` (projType 0–6) — each a `{ forward, inverse }` pair used for tile selection, bounds, and label anchoring. `globe.ts` adds the SEPARATE true-3D sphere mode (projType 7). `camera.ts` owns zoom/pan/bearing/pitch, the MVP matrix, and log-depth FC. The GPU does projection in-shader (WGSL); the CPU-side mirror of those WGSL functions is now GENERATED from the shader DSL (`../shader-dsl/cpu-projections.ts`, lowered from the IR in `../shader-dsl/projections.ts`) and the automated parity check compares it against the CPU formulas. (The hand-maintained `projection-wgsl-mirror.ts` was deleted — see `../shader-dsl/AGENTS.md`.)

## Key Files
| File | Description |
|------|-------------|
| `projection.ts` | CPU forward/inverse for all 7 projections + `MERCATOR_LAT_LIMIT`, `getProjection`. Inverse fns hold an "in-range or NaN" contract (guard div-by-zero at antipode). |
| `camera.ts` | `Camera` — zoom/pan/bearing/pitch, MVP, meters-per-pixel, log-depth FC (`computeLogDepthFc`), `buildGlobeMatrix` hookup. |
| `globe.ts` | True-3D globe (projType 7) — real sphere with pitch as orbit, vs the flat 2D azimuthal discs (3/4/5) that "lay on their side" when pitched. |
| `../shader-dsl/cpu-projections.ts` | GENERATED cpu-f64 mirror of WGSL `proj_*` (`projectWgsl`, `projectGeomWgsl`, …) — replaces the deleted `projection-wgsl-mirror.ts`. Lowered from `../shader-dsl/projections.ts`; the parity check pins CPU `projection.ts` against it. |
| `reprojector.ts` | Currently UNUSED 2-pass equirect→target resampler, preserved for a future RTT approach. No test coverage — keep inverse fns faithful to `projection.ts` on any edit. |

## For AI Agents

### Working In This Directory
- **CPU↔GPU parity is the central contract here and a documented recurring bug class.** `engine/shaders/projection.ts` (WGSL) is the source of truth; the generated cpu-f64 lowering (`../shader-dsl/cpu-projections.ts`, from `../shader-dsl/projections.ts`) mirrors it in TS; `projection.ts` is the CPU implementation. A formula change touches the WGSL string + the DSL graph (which regenerates the cpu mirror) + `projection.ts` (Mercator clamp, Natural Earth poly, ortho back-face have each drifted before).
- Flat azimuthal projections (ortho/azimuthal/stereo, 3/4/5) are correct 2D projections — do not "fix" their pitch behavior; the true globe is projType 7 in `globe.ts`.
- Inverse functions must return NaN (not garbage) outside their valid domain — tile selection relies on the "in-range or NaN" contract.
- z=0 + high-pitch and polar/dateline tile selection are known open weak spots; verify against the projection e2e suite, not just unit math.

### Testing Requirements
- Extensive: `projection-wgsl-consistency.test.ts` (CPU `projection.ts` ↔ generated cpu-f64 parity), `projection-forward-edge.test.ts`, `projection-inverse-roundtrip.test.ts`, `camera*.test.ts` (fuzz, z0-probe, coverage), `globe*.test.ts`, `log-depth.test.ts`, `mercator-clamp.test.ts`, `oblique-mercator-tile-mismatch.test.ts`, `polar-tile-pyramid-gap.test.ts`, `world-copy-projection.test.ts`. Add a parity test for any new/changed projection.

### Common Patterns
- `{ name, forward, inverse }` projection objects; antipode/div-by-zero guards; DSFUN-friendly meter outputs; log-depth FC computed from the far plane.

## Dependencies

### Internal
- `loader/geojson` (`lonLatToMercator`), `gpu/gpu-shared` (`WORLD_MERC`, `TILE_PX`), `gpu/gpu` (DPR), `shaders/log-depth`.

### External
- None (pure math).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
