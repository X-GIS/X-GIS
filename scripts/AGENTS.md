<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# scripts/

## Purpose
Developer tooling scripts and generated artefacts for the X-GIS repository. Contains six TypeScript scripts runnable via `bun` (pre-push gate, mutation tester, polygon shader snapshot capture, gap-matrix emitter, render-verify baseline-accept gate, and matrix-report pretty-printer) plus a committed gap-matrix snapshot, a Python cross-validation harness in `cross-validation/` that pins CPU projection and tile math against independent reference libraries (pyproj / mercantile / shapely), and miscellaneous planning/observation markdown files produced during debug sessions. Nothing here is imported by published packages; all scripts are development-support tooling only.

## Key Files
| File | Description |
|------|-------------|
| `precheck.ts` | Pre-push gate. Runs vitest unit suite across `compiler/src`, `blueprint/src`, `runtime/src` and optionally the Playwright projection-coverage smoke spec (`--smoke`, ~2-3 min). Wired as a git pre-push hook via `bun setup:hooks`. Parses stdout to tolerate vitest worker-IPC teardown false-failures so CI parity is exact. |
| `mutate.ts` | Zero-dependency hand-rolled mutation tester. Applies 14 operator-flip / boolean-negate / Math.max↔min mutations one at a time to a target source file, runs the specified vitest filter after each, and reports mutation score (killed / survived). Skips mutations inside comments and string literals. Usage: `bun scripts/mutate.ts <target-file> <vitest-filter>`. |
| `capture-polygon-snapshots.ts` | Polygon shader DSL baseline capture (Phase 2.5 US-010). Imports `FIXTURES` and `emitForFixture` from the runtime shader-DSL test fixtures, emits each variant's WGSL, and writes SHA-256-keyed `.wgsl` snapshot files to `runtime/src/engine/shaders/dsl/__polygon-variant-snapshots__/`. `polygon-variant-diff.test.ts` byte-diffs current emit against these snapshots to detect unintentional composer drift. Re-run after intentional DSL composer changes. |
| `emit-gap-matrix.ts` | Generates `gap-matrix.md` by cross-referencing `compiler/src/convert/spec-coverage.ts` and `runtime/src/capabilities.ts`. Produces four sections: runtime capability gaps, spec-coverage status breakdown, high-impact unsupported entries, and partial entries. Run: `bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md`. |
| `matrix-accept.ts` | Human-approved baseline acceptance gate for render-verify oracle. Copies a reviewed candidate screenshot from `playground/e2e/__matrix__/<id>.png` into the committed baseline corpus at `playground/render-verify/baselines/<id>.png`, stamps provenance metadata, and guides the user to flip the manifest status from 'candidate' to 'green'. Enforces explicit review: refuses to silently overwrite existing baselines without `--force`. |
| `matrix-report.ts` | Pretty-printer for render-verify matrix test results. Reads the cached report JSON from `playground/e2e/__matrix__/report.json` (written by `_matrix-gate.spec.ts`) and displays per-cell verdicts (PASS/FAIL/SOFT/SKIP/CANDIDATE) in a table with measured values, thresholds, and detail. Read-only; no side effects. |
| `gap-matrix.md` | Committed snapshot of the Mapbox/MapLibre spec support gap matrix. Regenerate after changing spec-coverage or capabilities tables. |
| `MUTATION_REPORT.md` | Output from a past mutation-testing session — records mutation score per target file. Session artefact; may be stale. |
| `MOBILE_LOW_ZOOM_BUG.md` | Debug observation notes for the mobile low-zoom water render failure (FLICKER class). Session artefact. |
| `OFM_BRIGHT_RENDERING_OBSERVATIONS.md` | Observations from OFM Bright style rendering comparison sessions. Session artefact. |
| `PLAN_PROGRESS.md` | Session progress tracking for multi-iter plan execution. Session artefact. |
| `RALPH_LOOP_LOG.md` | Automated log from ralph-loop execution sessions. Session artefact. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cross-validation/` | Python harness (`generate-fixtures.py`) that produces `runtime/src/__tests__/cross-validation.fixture.json` with 10 fixture sections: Mercator forward/inverse (9×9 grid), slippy-map tile math (6 cities × 8 zooms), polygon clip/containment, 5 additional projections (equirectangular/NE2/ortho/AEQD/stereo) forward+inverse, tile feature counts, country bboxes, pipeline area (clip+triangulate), Douglas-Peucker simplification, and EPSG reprojection (4326/3857/5179/5186). (see `cross-validation/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Run `bun scripts/precheck.ts` (or `bun precheck`) before every push — it mirrors exactly what the CI `test` job runs.
- Use `--smoke` flag when changing camera math, projection routing, or shader DSL — it adds the Playwright `_projection-coverage` spec.
- `mutate.ts` is intentionally zero-dependency (no Stryker per the project zero-deps rule). To add a new operator class, append a `MutationRule` entry to the `MUTATIONS` array in the file.
- After an intentional DSL composer change, re-run `capture-polygon-snapshots.ts` to refresh the WGSL baselines; do not re-run speculatively.
- After any change to `compiler/src/convert/spec-coverage.ts` or `runtime/src/capabilities.ts`, regenerate `gap-matrix.md`.
- The `*.md` observation/log files are session artefacts — do not treat them as authoritative design docs; they may be stale.
- **Never touch `cross-validation/.venv/`** — it is a uv-managed virtualenv with ~170 dependency directories. Exclude it from all file searches.

### Testing Requirements
- `precheck.ts` is the canonical local test runner. It exercises vitest on `compiler/src`, `blueprint/src`, and `runtime/src`.
- Polygon DSL drift is caught by `runtime/src/engine/shaders/dsl/polygon-variant-diff.test.ts`, which byte-diffs against the snapshots written by `capture-polygon-snapshots.ts`.
- Cross-validation fixture correctness is verified by `runtime/src/__tests__/cross-validation.test.ts`. Regenerate the fixture via `cd scripts/cross-validation && uv run generate-fixtures.py` only when a projection or tile formula intentionally changes.

### Common Patterns
- All TypeScript scripts use `#!/usr/bin/env bun` and are invoked directly: `bun scripts/<name>.ts`.
- Scripts import only `node:` built-ins and workspace-local packages — no new npm dependencies (zero-deps project rule).
- `capture-polygon-snapshots.ts` writes into a `__polygon-variant-snapshots__/` directory (double-underscore convention = generated artefact, excluded from normal listings).

## Dependencies

### Internal
- `runtime/src/engine/shaders/dsl/_polygon-fixtures` — imported by `capture-polygon-snapshots.ts`
- `compiler/src/convert/spec-coverage.ts` — imported by `emit-gap-matrix.ts`
- `runtime/src/capabilities.ts` — imported by `emit-gap-matrix.ts`
- `runtime/src/__tests__/cross-validation.fixture.json` — written by `cross-validation/generate-fixtures.py`, read by `cross-validation.test.ts`
- `playground/public/data/countries.geojson` — read by `cross-validation/generate-fixtures.py` for tile feature-count and pipeline-area fixture sections

### External
- `bun` runtime — all TypeScript scripts
- `vitest` — invoked by `precheck.ts` and `mutate.ts`
- `playwright` — smoke tier of `precheck.ts`
- `pyproj` ≥3.6, `mercantile` ≥1.2, `shapely` ≥2.0, `uv` — Python cross-validation harness only

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
