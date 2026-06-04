# X-GIS Visual-Regression MATRIX Gate

A permanent, real-GPU **tripwire** across the render output space. X-GIS has no
large user base to crowd-source the combinatorial bug tail, so this gate is the
replacement: math-derived and human-reviewed baselines sampled across
*projection × pitch × zoom × representative data × render surface*, run
**pre-push on a real GPU** (CI has no GPU — SwiftShader only — so it cannot
raster the pipeline; see ADR-0004 and `docs/verification/STRATEGY.md`).

> It is a **tripwire, not an exhaustive gate**. A green matrix does not prove
> correctness; a red cell proves something moved. Baselines are **never
> auto-blessed** — a wrong baseline blesses a bug.

This is **Increment 1**: one manifest + one runner + the baseline-review
discipline + a non-blocking, opt-in pre-push attach. ~6 seed cells, no
committed PNG baselines yet.

---

## Files

| Path | Role |
|---|---|
| `playground/render-verify/matrix-types.ts` | Cell + oracle schema; `effectiveGate()` (the anti-blessing coercion). |
| `playground/render-verify/matrix.manifest.ts` | The declarative cell list (seed = ~6 cells). |
| `playground/render-verify/matrix-oracles.ts` | `runOracle` dispatch — reuses the existing harness (d3 ref, pixelmatch, histograms). |
| `playground/e2e/_matrix-gate.spec.ts` | The runner: drive each cell, capture, run oracles, report. Opt-in via `XGIS_MATRIX=1`. |
| `playground/render-verify/baselines/` | The **reviewed, committed** baseline corpus (only `matrix:accept` writes here). |
| `playground/e2e/__matrix__/` | Per-run **candidate** PNGs + `report.json` (gitignored scratch). |
| `scripts/matrix-accept.ts` | The one path that promotes a candidate → baseline (`matrix:accept`). |
| `scripts/matrix-report.ts` | Pretty-prints the last run's `report.json` (`matrix:report`). |

---

## Running it

```bash
# Full seed set, real GPU, headed (NOT in CI). Opt-in.
XGIS_MATRIX=1 bun precheck:matrix

# Only cells whose id or projection matches a glob (cheap iteration):
XGIS_MATRIX=1 XGIS_MATRIX_FILTER=globe-* bun precheck:matrix
XGIS_MATRIX=1 XGIS_MATRIX_FILTER=mercator  bun precheck:matrix

# Re-print the last run without re-rendering:
bun run matrix:report
```

Requirements: a **real GPU** (headed Chromium — do **not** set
`XGIS_SOFTWARE_GPU`), and the Vite dev server (the runner reuses an existing
one, else `bun run dev` is started by Playwright's `webServer`). `precheck:matrix`
clears `playground/node_modules/.vite` first so `runtime/src` edits are not
masked by the pre-bundled dep.

The matrix is **not** wired into the blocking pre-push hook. `.githooks/pre-push`
runs `bun run precheck` (vitest only). The matrix attaches to precheck only when
`--matrix` / `XGIS_MATRIX=1` is passed, so a default `git push` is byte-identical
to today.

---

## The cell schema

Each cell in `matrix.manifest.ts` is pure data:

```ts
{
  id: 'merc-seoul-z8-p60',         // stable, filesystem-safe; names the baseline + report row
  projection: 'mercator',
  zoom: 8, pitch: 60, bearing: 0,
  dataset: 'ofm_bright',           // synthetic | ofm_bright | synthetic_disc (all existing demos)
  surfaces: ['bg', 'fill', 'line'],// documentation/attribution
  camera: { center: [126.98, 37.55] },
  oracles: [                       // one or more independent failure detectors
    { kind: 'black_ratio', max: 0.02 },
    { kind: 'screenshot_diff', max: 0.025 },
  ],
  gate: 'hard',                    // hard fails the run; soft only reports
  knownStatus: 'candidate',        // green | candidate | expected_red
  note: '…why this cell exists…',
}
```

### Oracle kinds

| kind | reference | needs human bless? |
|---|---|---|
| `numeric_forward` | live GPU MVP vs CPU/d3 mirror (screen-px drift). Flat proj only — **skipped** for non-flat. | no |
| `pixel_ref` | pixelmatch vs in-page d3-geo Canvas2D render. Flat proj only — **skipped** otherwise. | no |
| `ink_family` | per-family pixel-count floor (`colorHistogram`). Catches a dropped thin/sparse layer. | no |
| `disc_fraction` | measured disc fill-fraction vs an expected band (azimuthal framing). | no |
| `black_ratio` | pure-black pixel fraction ≤ max (every pixel must have a defined source). | no |
| `label_onscreen` | placed label anchors within viewport+margin (gross mis-dispatch). | no |
| `screenshot_diff` | **committed PNG baseline** diff (`pixelDiffRatio`). | **YES** |

Math/closed-form oracles regenerate their reference every run, so they are
`green`/`hard` from day one and nothing goes stale. Only `screenshot_diff`
stores a PNG — that is the one path that needs the human gate.

### `knownStatus` and the anti-blessing coercion

`effectiveGate(cell)` (in `matrix-types.ts`, enforced by the runner) coerces a
cell to **soft** whenever `knownStatus` is `candidate` or `expected_red`,
**regardless of its declared `gate`**:

- `green` — clean tree should pass. May be `hard` (math oracle, or a reviewed baseline).
- `candidate` — baseline not yet reviewed → **forced soft**. Can only report.
- `expected_red` — documents an OPEN bug → **forced soft**. Flips green automatically when the bug is fixed.

So an unreviewed baseline or a documented bug **can never block a push**. That
is structural, not a matter of author discipline.

---

## Baseline lifecycle (the explicit review + accept step)

`screenshot_diff` cells follow a five-step lifecycle. Steps 2–3 are the
anti-blessing gate.

1. **CANDIDATE** — author adds the cell with `knownStatus: 'candidate'`. The
   first run writes `e2e/__matrix__/<id>.png`. No baseline exists yet →
   `screenshot_diff` reports `candidate-missing` (**soft**). The cell cannot
   block a push.

2. **REVIEW** — a human opens `e2e/__matrix__/<id>.png` and confirms the render
   is **CORRECT** — not merely *present*. (Use the `visual-verdict` skill /
   `playground/compare.html` against d3 / MapLibre / the expected mental model.)
   A busy-but-wrong candidate must be **rejected here** — once accepted it
   becomes the truth every future run is measured against.

3. **ACCEPT** — explicit command:

   ```bash
   bun run matrix:accept <cell.id>
   ```

   Copies `__matrix__/<id>.png` → `render-verify/baselines/<id>.png`, writes
   `<id>.meta.json` (`reviewedBy`, `reviewedAt`, `commit`), and prints the
   manual next step. It **refuses to overwrite** an existing baseline without
   `--force` (no silent rebake).

4. **GREEN / HARD** — manually edit `matrix.manifest.ts`: set the cell's
   `knownStatus: 'candidate' → 'green'`. Now the runner no longer coerces the
   gate; the cell's `screenshot_diff` is **hard**. Do this in the **same PR** as
   the new PNG so the PR reviewer sees the baseline and the green-promotion
   together. A future regression past `max` now FAILS the push.

5. **UPDATE** — when an intentional render change moves a cell, its diff FAILS.
   Re-run, eyeball the new candidate, and `matrix:accept --force` (re-review,
   re-stamp). `meta.json`'s `commit`/`reviewedAt` make a stale baseline
   auditable in `git blame`.

> **Critical rule:** `matrix:accept` is the *only* writer of `baselines/`. The
> runner never writes there. A baseline becomes truth only by an explicit human
> command **plus** a manifest `green` flip visible in the PR diff.

---

## Adding a cell

1. Append a record to `MATRIX` in `matrix.manifest.ts`. Point `dataset` at an
   existing demo (`synthetic`, `ofm_bright`, `synthetic_disc`).
2. Prefer a **math/closed-form oracle** (no stored baseline → nothing to
   bless). Use `screenshot_diff` only where no such oracle exists
   (globe, non-merc real data, high-pitch).
3. If it uses `screenshot_diff`, start it `candidate` and run the
   review→accept→green flow above. Do **not** declare a `hard` `screenshot_diff`
   cell without a reviewed baseline — the runner coerces it to soft anyway.
4. Run `XGIS_MATRIX_FILTER=<id> XGIS_MATRIX=1 bun precheck:matrix` to confirm it
   executes and the candidate PNG looks right.

---

## Status & roadmap

**Increment 1 (this):** schema + manifest (6 seed cells) + runner + oracle
dispatch + `matrix:accept`/`matrix:report` + opt-in precheck step + this doc.
No committed baselines. Non-blocking by construction.

Seed coverage: mercator anchor (Oracle-B parity), orthographic disc framing,
azimuthal `expected_red` disc, natural-earth deep-zoom real data, high-pitch
mercator, globe antimeridian, label-heavy position oracle.

**Increment 2+ (deferred):**
- Review + `matrix:accept` the candidate cells (natearth-z12, merc-z8-p60,
  globe-dateline) → flip to `green`/`hard`.
- Port the `_disc-coverage-matrix` azimuthal-family math from the harness
  worktree into `disc_fraction` (pin the exact `π/(4·aspect)` fraction).
- Globe ECEF forward-agreement numeric oracle (CPU mirror of `buildGlobeMatrix`
  — the globe analogue of Oracle-B; the long pole).
- Pitched-horizon shape invariant, seam-continuity oracle, per-projection
  inverse round-trip (`pickAt`), extrusion-under-pitch, label pitch-align.
- Promote to blocking only after baselines are reviewed (arm `XGIS_MATRIX=1` in
  the dev environment so the hook runs it; `--no-verify` still escapes).
