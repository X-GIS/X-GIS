// Visual-regression MATRIX gate — disc fragment.
//
// Per-axis split of the single-authority MATRIX. Disc-azimuthal cells (orthographic / azimuthal_equidistant / stereographic). The assembler
// matrix.manifest.ts concatenates the four fragments; OracleSpec / MatrixCell
// types stay in matrix-types. Append-only: a new disc cell is added HERE
// without touching the other fragments.
//
// See docs/verification/MATRIX.md for the candidate->review->accept flow.

import type { MatrixCell } from '../matrix-types'

export const MATRIX_DISC: MatrixCell[] = [
  // (1) DISC — azimuthal framing. The disc-fraction oracle is a PRESENCE +
  // framing tripwire, not an exact-fraction assertion: a wide band catches the
  // catastrophic failures (disc absent → 0, or framing collapse flooding the
  // whole canvas → ~1). The exact closed-form fraction (π/(4·aspect)) is left
  // for a future increment to pin against a reviewed reference — asserting an
  // unverified constant here would risk blessing a framing bug.
{
    id: 'ortho-z0-p0-disc',
    projection: 'orthographic',
    zoom: 0,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Band centered on the MEASURED clean-tree value (88.3% at z0 ortho,
    // 1024×768) with a wide tolerance: this is a presence/framing tripwire,
    // not an exact-fraction assertion. It catches the catastrophic failures —
    // disc absent (→0) or under-framed to a strip (drops far below 0.76) — the
    // very class cell `azi-z0-p0-disc-uncapped` documents. The exact
    // closed-form fraction is deferred to a future increment (reviewed ref).
    oracles: [{ kind: 'disc_fraction', expected: 0.88, max: 0.12 }],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Orthographic disc framing tripwire — band centered on the measured clean value (≈88%); catches disc-absent / under-framed collapse.',
  },

  // (2) DISC EXPECTED-RED — documents the un-capped azimuthal_equidistant
  // framing gap (flatViewHeightCapM table has no azi entry → it under-frames).
  // Coerced to soft by the runner; flips green automatically when fixed.
{
    id: 'azi-z0-p0-disc-uncapped',
    projection: 'azimuthal_equidistant',
    zoom: 0,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Same band as the orthographic disc cell: azimuthal_equidistant SHOULD
    // frame like orthographic. If it under-frames (the documented cap-table
    // gap), the measured fraction falls below the band and this cell goes red —
    // but it is `expected_red`, so the runner coerces it to SOFT (reports, never
    // blocks). When the cap table covers azi and it frames correctly, the cell
    // passes and can be promoted to green.
    oracles: [{ kind: 'disc_fraction', expected: 0.88, max: 0.12 }],
    gate: 'hard',
    knownStatus: 'expected_red',
    note: 'flatViewHeightCapM table gap: azimuthal_equidistant under-frames vs orthographic. Soft tripwire; flips green when the cap table covers azi.',
  },

  // ── FAMILY: disc-azimuthal (orthographic / azimuthal_equidistant / stereographic)
{
    id: 'stereo-z0-p0-disc-uncapped',
    projection: 'stereographic',
    zoom: 0,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Healthy target ≈ π/(4·aspect) ≈ 0.589; un-capped stereo (flatViewHeightCapM
    // has no stereo entry → WORLD_MERC fall-through) measures ≈0.239, well below
    // the expected ± tol band → expected_red.
    oracles: [
      { kind: 'disc_fraction', expected: 0.589, max: 0.08 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: flatViewHeightCapM has no stereographic entry → falls through to WORLD_MERC, under-frames the disc (≈0.239 vs ≈0.589). Soft tripwire; flips green when the cap table covers stereo.',
  },

{
    id: 'ortho-z0-p60-promote-globe',
    projection: 'orthographic',
    zoom: 0,
    pitch: 60,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Foreshortened disc — no closed-form point. Symmetric band [0.02, 0.589]
    // expressed as midpoint 0.30 ± 0.28: PRESENT (>0.02) and smaller than the
    // unpitched healthy target (<0.589). A blank frame or an un-foreshortened
    // disc both fall outside the band.
    oracles: [
      { kind: 'disc_fraction', expected: 0.30, max: 0.28 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Ortho z0 pitch=60 triggers promote-to-globe (projType 3 tilted → 7 + globeMode). Sane-range disc_fraction (present but foreshortened) + finite_mvp guard the globe-mode matrix. Soft (range gate is a tripwire).',
  },

{
    id: 'ortho-z2-p0-content',
    projection: 'orthographic',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Ortho z2 frames the disc IDENTICALLY to z0 (the 2R cap binds at both) — a
    // near-full-canvas disc (~88% fill), NOT a shrunken circle. Band mirrors
    // ortho-z0-p0-disc; black_ratio ~0.15 = the 4:3 canvas corners outside the disc.
    oracles: [
      { kind: 'disc_fraction', expected: 0.88, max: 0.12 },
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.15 },
      { kind: 'frame_stability', max: 0.005 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Ortho z2 p0 — non-z0 framing path. Disc frames like z0 (~88%); finite_mvp + black_ratio (≤15%, disc corners) guard the cap-table switch at low non-zero zoom.',
  },

{
    id: 'azi-z0-p60-disc-pitched',
    projection: 'azimuthal_equidistant',
    zoom: 0,
    pitch: 60,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Compounded defect (un-capped + pitched): measured fraction ≈ small. Floor
    // band 0.10 ± 0.09 (presence floor 0.01, below the healthy 0.589 target).
    oracles: [
      { kind: 'disc_fraction', expected: 0.10, max: 0.09 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY b6be8c11 (2026-06-01, #206): flatViewHeightCapM threaded into the tilted-azimuthal (globeOrtho) path — pitched framing now continuous with the flat path across the pitch=0 boundary. Was: azi z0 pitch=60 stacked the cap gap with pitch foreshortening (disc ~3× oversized vs flat). Base azi cap-table gap still red in azi-z0-p0-disc-uncapped. Pinned by azimuthal-disc-pitch-framing.test.ts; 3× real-GPU PASS 2026-06-09.',
  },

{
    id: 'ortho-ofm-z2-p0-content',
    projection: 'orthographic',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.15 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Real-data ortho z2 — full pipeline (bg+fill+line) under disc projection. ink_family catches a dropped layer; black_ratio (≤15%; the 4:3 disc-corner void is unavoidable) catches disc-interior void; finite_mvp guards the matrix. numeric_forward correctly omitted (throws for ortho).',
  },

{
    id: 'azi-ofm-z2-p0-content',
    projection: 'azimuthal_equidistant',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.05 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug LIVE but ZOOM-GATED (triage 2026-06-10): the azi cap gap (projType 4 → WORLD_MERC fall-through, projections-table.ts) never binds at z2 — black_ratio ≤5% passes VACUOUSLY here. The cap-gap red is held by azi-z0-p0-disc-uncapped (z0, where it binds). Stays expected_red until either the cap table covers azi or this cell gains a z0 disc_fraction probe (expected 0.589, max 0.08).',
  },

{
    id: 'stereo-ofm-z2-p0-content',
    projection: 'stereographic',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.05 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug LIVE but ZOOM-GATED (triage 2026-06-10): stereo column of the cap gap (projType 5 uncapped, same code site as azi) never binds at z2 — black_ratio passes VACUOUSLY here. The cap-gap red is held by stereo-z0-p0-disc-uncapped (z0). Stays expected_red until either the cap table covers stereo or this cell gains a z0 disc_fraction probe (expected 0.589, max 0.08).',
  },

{
    id: 'ortho-z0-p0-finite-mvp',
    projection: 'orthographic',
    zoom: 0,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'finite_mvp' },
      { kind: 'ink_family', families: [{ name: 'disc_fill', minRatio: 0.10 }] },
      { kind: 'frame_stability', max: 0.005 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Dedicated finite_mvp + invariant_ink (disc_fill #4488cc) for ortho z0 p0 — decoupled from disc_fraction so camera-matrix NaN/Inf is reported independently of framing geometry. Math-only, hard-green.',
  },

{
    id: 'ortho-z0-p0-disc-finite-mvp',
    projection: 'orthographic',
    zoom: 0,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'finite_mvp' },
      { kind: 'disc_fraction', expected: 0.88, max: 0.12 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 837d34ca (2026-06-03): getCameraDebugSnapshot().matrix computed with the render\'s per-projType view-height cap (projType 3 → 2·EARTH_R) — snapshot no longer reports a different camera than the GPU rendered. Was: disc/globe coord-readout NaN (NaN/Inf in the ortho MVP snapshot). finite_mvp + disc_fraction PASS 3× real-GPU 2026-06-09.',
  },
]
