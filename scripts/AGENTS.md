<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# scripts/

## Purpose
Developer tooling scripts and generated artefacts for the X-GIS repository. Contains four TypeScript scripts runnable via `bun` (pre-push gate, mutation tester, gap-matrix emitter, and a generated gap-matrix snapshot), a Python cross-validation harness in `cross-validation/` that pins CPU projection and tile math against independent reference libraries, and miscellaneous planning/observation markdown files produced during debug sessions.

## Key Files
| File | Description |
|------|-------------|
| `precheck.ts` | Pre-push gate script. Runs the vitest unit suite (`compiler/src`, `blueprint/src`, `runtime/src`) and optionally the Playwright projection-coverage smoke spec (`--smoke`). Wired as a git pre-push hook via `bun setup:hooks`. Tolerates vitest worker-IPC teardown false-failures (parses test outcome from stdout). |
| `mutate.ts` | Zero-dependency hand-rolled mutation tester. Takes a target source file and vitest filter, applies operator-flip / boolean-negate mutations one at a time, runs the test suite, and reports mutation score (killed / total). Usage: `bun scripts/mutate.ts <target-file> <vitest-filter>`. |
| `emit-gap-matrix.ts` | Generates `gap-matrix.md` by cross-referencing `compiler/src/convert/spec-coverage.ts` and `runtime/src/capabilities.ts`. Reports runtime capability gaps and compiler spec-coverage breakdown. Run: `bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md`. |
| `gap-matrix.md` | Committed snapshot of the Mapbox support gap matrix. Regenerate with `emit-gap-matrix.ts` after changing spec-coverage or capabilities tables. |
| `MUTATION_REPORT.md` | Output from a mutation-testing session — records mutation score per target file. |
| `MOBILE_LOW_ZOOM_BUG.md` | Debug observation notes for the mobile low-zoom water render failure (FLICKER class). |
| `OFM_BRIGHT_RENDERING_OBSERVATIONS.md` | Observations from OFM Bright style rendering comparison sessions. |
| `PLAN_PROGRESS.md` | Session progress tracking for multi-iter plan execution. |
| `RALPH_LOOP_LOG.md` | Automated log from ralph-loop execution sessions. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `cross-validation/` | (see `cross-validation/AGENTS.md`) Python harness that generates reference JSON fixtures using pyproj/mercantile/shapely |

## For AI Agents

### Working In This Directory
- Run `bun scripts/precheck.ts` (or `bun precheck`) before pushing — this is the same suite CI runs.
- `bun scripts/precheck.ts --smoke` adds the Playwright projection spec (~2-3 min); use before pushing changes to camera math or projection routing.
- `mutate.ts` is intentionally zero-dependency (no Stryker). Add new mutation rules to the `MUTATIONS` array inside the file when new operator classes need coverage.
- After any change to `compiler/src/convert/spec-coverage.ts` or `runtime/src/capabilities.ts`, regenerate `gap-matrix.md`.
- The markdown observation/log files (`MOBILE_LOW_ZOOM_BUG.md`, etc.) are session artefacts — do not treat them as authoritative design docs; they may be stale.

### Testing Requirements
- `precheck.ts` IS the test runner for this repo. It runs vitest on `compiler/src`, `blueprint/src`, and `runtime/src`.
- The Python cross-validation fixture is tested by `runtime/src/__tests__/cross-validation.test.ts` — if projection math changes intentionally, regenerate the fixture via `uv run generate-fixtures.py` in `scripts/cross-validation/`.

### Common Patterns
- All TypeScript scripts use `#!/usr/bin/env bun` shebang and run directly with `bun scripts/<name>.ts`.
- No npm dependencies added to scripts — they import only from `node:` built-ins and workspace packages (per project zero-deps policy).

## Dependencies

### Internal
- `compiler/src/convert/spec-coverage.ts` — `emit-gap-matrix.ts`
- `runtime/src/capabilities.ts` — `emit-gap-matrix.ts`
- `runtime/src/__tests__/cross-validation.fixture.json` — written by `cross-validation/generate-fixtures.py`

### External
- `bun` runtime (TypeScript scripts)
- `vitest` (invoked by `precheck.ts`)
- `playwright` (smoke tier of `precheck.ts`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
