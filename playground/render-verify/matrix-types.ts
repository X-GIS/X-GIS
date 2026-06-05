// Visual-regression MATRIX gate — cell schema (Increment 1).
//
// One declarative record per "cell" of the output space the gate samples:
// (projection × zoom × pitch × bearing × representative dataset × render
// surface). A cell is PURE DATA — zero Playwright/page imports — so the
// manifest stays framework-agnostic like fixtures.ts and can be imported
// from a Node script (matrix-accept) as well as the in-page spec.
//
// The gate is a TRIPWIRE, not an exhaustive proof. Each cell carries one or
// more *oracles* (independent failure detectors). Oracles split into two
// classes:
//   • MATH-DERIVED (numeric_forward / pixel_ref / disc_fraction / black_ratio
//     / ink_family / label_onscreen) — the reference is regenerated every run
//     from d3-geo / closed-form geometry / the live MVP. Nothing is stored,
//     so nothing can go stale and nothing needs a human to bless it. These
//     can be `hard` from day one.
//   • screenshot_diff — diffs against a committed PNG baseline. A baseline is
//     TRUTH every future run is measured against, so a WRONG baseline blesses
//     a bug. These cells start `candidate` and are coerced to `soft` by the
//     runner until a human reviews the candidate and runs `matrix:accept`.
//
// See docs/verification/MATRIX.md for the full manifest + baseline-review flow.

import type { ProjName } from './camera-map'

/** Re-export so the manifest + runner reference one ProjName source. */
export type { ProjName }

/**
 * Which representative source the cell drives into the page. Each maps to a
 * real playground demo id that already exists (verified against
 * playground/src/examples/*.xgis):
 *   synthetic      → fixture-render-verify.xgis (id `fixture_render_verify`),
 *                    host-pushes FIXTURE_SOURCES via VirtualPMTilesBackend
 *                    (the Oracle-B path) — the d3/numeric reference geometry.
 *   ofm_bright     → openfreemap-bright.xgis  (id `openfreemap_bright`),
 *                    a real-world 93-layer OpenMapTiles basemap.
 *   synthetic_disc → fixture-synth-bg-only.xgis (id `fixture_synth_bg_only`),
 *                    the SyntheticEarthSurfaceBackend solid #4488cc disc.
 */
export type Dataset = 'synthetic' | 'ofm_bright' | 'synthetic_disc'

/** Render surfaces a cell is documented to exercise. Attribution only — the
 *  surfaces a cell frames are governed by its dataset + camera; this field
 *  records intent so a reader knows which pipeline the cell guards. */
export type Surface =
  | 'bg'
  | 'fill'
  | 'line'
  | 'point'
  | 'label'
  | 'extrusion'
  | 'grid'

/** Oracle kinds. A cell may stack several; each is an independent detector. */
export type OracleKind =
  | 'pixel_ref' // pixelmatch vs in-page d3-geo Canvas2D reference (flat proj only)
  | 'numeric_forward' // live GPU MVP (getCameraDebugSnapshot) vs CPU/d3 mirror, screen-px drift
  | 'ink_family' // per-family pixel-count floor (colorHistogram); catches a dropped thin layer
  | 'disc_fraction' // measured disc fill-fraction vs an expected closed-form value (azimuthal family)
  | 'black_ratio' // pure-black pixel fraction ≤ max (every pixel must have a defined source)
  | 'screenshot_diff' // committed PNG baseline diff via pixelDiffRatio (the ONLY oracle needing human bless)
  | 'label_onscreen' // every placed label anchor within viewport+margin (gross mis-dispatch)
  | 'finite_mvp' // all 16 floats of the live camera MVP (getCameraDebugSnapshot().matrix) are finite (no NaN/Inf); projection-agnostic, no baseline
  | 'frame_stability' // frame N vs frame N+1 diff ≈0 on a settled static scene; deterministic-render guard for future invalidation/skip work (S16)

/** The ink families the synthetic fixture renders (pinned to its layer hexes,
 *  see render-verify/d3-reference.ts STYLE), plus `slate` for ofm-bright
 *  water fill (used by the antimeridian cell's fill-present check) and
 *  `disc_fill` (#4488cc) for the SyntheticEarthSurfaceBackend solid disc
 *  (used by the disc-family presence/drawCalls invariant). */
export type InkFamilyName = 'emerald' | 'rose' | 'sky' | 'amber' | 'slate' | 'disc_fill'

export interface OracleSpec {
  kind: OracleKind
  /** Per-oracle threshold; meaning depends on kind:
   *   numeric_forward → max screen-px drift
   *   pixel_ref / screenshot_diff → max mismatch ratio [0,1]
   *   black_ratio → max pure-black fraction [0,1]
   *   disc_fraction → ± tolerance around `expected` */
  max?: number
  min?: number
  /** ink_family: families that MUST produce ink, each with a min pixel ratio. */
  families?: { name: InkFamilyName; minRatio: number }[]
  /** disc_fraction: expected fill fraction (paired with `max` as ± tolerance). */
  expected?: number
}

export type Gate = 'hard' | 'soft'

export type KnownStatus =
  /** Expected to pass on a clean tree; math-oracle cells (or reviewed
   *  baselines) may be `hard`. */
  | 'green'
  /** Baseline not yet human-reviewed → the runner FORCES this cell `soft`. */
  | 'candidate'
  /** Documents an OPEN bug (e.g. un-capped azimuthal disc framing); the runner
   *  FORCES this cell `soft`. The tripwire flips green automatically when the
   *  bug is fixed — which is the signal the cell exists to give. */
  | 'expected_red'

export interface MatrixCell {
  /** Stable, filesystem-safe id. Names the baseline file + the report row. */
  id: string
  projection: ProjName
  zoom: number
  pitch: number
  bearing: number
  dataset: Dataset
  /** Documentation/attribution: which render surfaces this cell exercises. */
  surfaces: Surface[]
  /** Camera center [lon, lat] in degrees (zoom/pitch/bearing are top-level). */
  camera: { center: [number, number] }
  oracles: OracleSpec[]
  gate: Gate
  knownStatus: KnownStatus
  /** Why this cell exists / which bug or axis it guards. */
  note?: string
}

/**
 * The structural anti-blessing guarantee, enforced by the runner — NOT the
 * author. A `candidate` (unreviewed baseline) or `expected_red` (known-bug)
 * cell is coerced to `soft` regardless of its declared `gate`, so it can only
 * REPORT, never block a push. Only a `green` cell — which for a screenshot_diff
 * oracle means its baseline has been human-reviewed + accepted — may be `hard`.
 */
export function effectiveGate(cell: MatrixCell): Gate {
  if (cell.knownStatus === 'candidate' || cell.knownStatus === 'expected_red') {
    return 'soft'
  }
  return cell.gate
}
