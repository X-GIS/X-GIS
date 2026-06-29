<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# shared

## Purpose
`@xgis/shared` is the dependency-free math kernel at the bottom of the X-GIS monorepo DAG. It exports the cross-package math both `@xgis/compiler` (tiler) and `@xgis/runtime` (engine) must agree on byte-for-byte: `src/ecef.ts` (WGS84/ECEF coordinate math) and `src/quantize.ts` (shared vertex quantization). Before this package existed, the tiler hand-mirrored ECEF constants from `runtime/src/engine/projection/ecef.ts`; those copies are now real imports of a single source of truth. The package has no npm dependencies by design — no engine, DOM, or compiler graph can be introduced here.

## Key Files

| File | Description |
| --- | --- |
| `src/ecef.ts` | All WGS84/ECEF math: ellipsoidal and sphere-variant forward/inverse (`lonLatToECEF`, `ecefToLonLat`, `mercatorToECEF`, `lonLatToECEFSphere`, `mercatorToECEFSphere`), per-tile anchor helper (`tileEcefCenterFromMerc`), DSFUN hi/lo f32 precision split (`dsfunSplitECEF`), ECEF→ENU rotation matrix (`ecefToENURotation`), and exported `WGS84` constants (`A`, `F`, `E2`, `RAD2DEG`). |
| `src/quantize.ts` | `quantizeAxis(axis, halfRange, invSpan)` — pure-integer vertex-position quantization into a double-u16 `[hi, lo]` pair, shared bit-for-bit by the compiler tiler and the runtime synthetic-earth packer (a divergence here is a silent CPU-side vertex-drift bug). |
| `src/index.ts` | Single barrel: `export * from './ecef'` + `export * from './quantize'`. Entry point for both consumers. |
| `README.md` | Human-readable public surface doc: why the package exists, full export table (types, forward/inverse, sphere variants, GPU-precision helpers), build instructions, and cross-references to ADR-0001, MODULES.md, and COORDINATES.md. |
| `package.json` | Workspace package `@xgis/shared` (`private: true`, `license: "MIT"`, not published). `"main"` and `"exports"` both point directly to `src/index.ts`; build output goes to `dist/`. |
| `tsconfig.json` | Composite TypeScript project (`outDir: ./dist`, `rootDir: ./src`, `types: []`), extends `../tsconfig.base.json`. |

## For AI Agents

### Working In This Directory

- **Zero-dependency constraint is absolute.** `src/ecef.ts` inlines the inverse-Mercator formula (matching `projection.ts` byte-for-byte) rather than importing it, to stay dependency-free. Never add an import from `@xgis/runtime`, `@xgis/compiler`, the DOM, or any npm package.
- **Single source of truth for ECEF/WGS84 math.** New cross-package coordinate helpers belong here, not mirrored in compiler or runtime. `runtime/src/engine/projection/ecef.ts` re-exports from this package so engine import paths remain stable — do not duplicate logic there.
- **Sphere vs. ellipsoid split is intentional.** `lonLatToECEFSphere` / `mercatorToECEFSphere` exist to maintain parity with the legacy 2D MVP pipeline (spherical Mercator basis, `E2 = 0`). The ellipsoidal and sphere variants differ by ~21 km of polar flattening. Do not collapse them until Phase 2e retires the legacy `project_geom` path.
- **`dsfunSplitECEF` precision contract:** the hi part is `Math.fround(rel)` and the lo part is `rel - hi`. The GPU reconstructs `rtc = hi + lo` (Kahan-style). Do not alter the split formula without updating the polygon/point vertex shaders in `runtime/`.
- **`ecefToENURotation` returns a column-major `Float32Array(16)`.** The 4×4 layout is intentional for direct composition with the renderer's 4×4 transforms; translation slots stay zero.
- Surgical changes only — this package is small and its exports are imported from many sites across the monorepo.

### Testing Requirements

There is no `test` npm script in `shared/` (only `build`), but a co-located characterization suite (`src/ecef.test.ts`) now pins the load-bearing numeric contracts; it runs via the root `vitest`. Correctness is also pinned by consumer tests:

- `runtime/` precision-fuzz tests (e.g. `globe-ecef-frame-consistency.test.ts`, the ECEF point-precision fuzz covering 10 000 points, sub-mm at z≥15).
- `compiler/` tiler ECEF parity tests.
- `scripts/cross-validation/` Python harness (`pyproj`/`shapely`/`mercantile`) cross-checks CPU math against reference implementations.

Run `bun run build` (calls `tsc --build`) to typecheck. `vitest` is invoked from the monorepo root; filter to ECEF-related suites when verifying changes here.

### Common Patterns

- All exports are pure functions with no side effects — inputs are numbers or `readonly` tuples, outputs are `ECEF` (`readonly [x, y, z]`) or `LonLatHeight` (`readonly [lon, lat, height]`).
- Constants (`A`, `F`, `E2`, `DEG2RAD`, `RAD2DEG`) are module-private; only `WGS84` is exported as a named const object for WGSL emission and cross-validation callers.
- No class, no state, no async — every function is a direct numeric transform.

## Dependencies

### Internal

None. `@xgis/shared` is a DAG leaf and imports nothing from other X-GIS packages.

### External

None. The package has zero npm dependencies (`package.json` lists no `dependencies` or `devDependencies`).

<!-- MANUAL: notes below this line are preserved on regeneration -->
