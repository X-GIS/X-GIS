// Visual-regression MATRIX gate — seed manifest (Increment 1).
//
// ~6 declarative cells spanning the highest-value GAP axes the inventory
// flagged (globe, disc/azimuthal, non-merc deep-zoom, high-pitch,
// antimeridian, label-heavy), anchored by one cell (0) that reuses the
// already-trusted Oracle-B math reference.
//
// This is a SKELETON, not coverage. Every cell that depends on a stored PNG
// baseline starts `knownStatus: 'candidate'` — the runner coerces those to
// `soft`, so committing this manifest cannot block anyone and cannot bless a
// wrong baseline (no PNGs are committed in this increment). Math-oracle cells
// (0, 1, 6) need no stored baseline and are `green`/`hard` from day one.
//
// To add a cell: append a record, point `dataset` at an existing demo, pick
// oracles, and follow the candidate→review→accept→green flow in
// docs/verification/MATRIX.md. Do NOT invent a `hard` screenshot_diff cell
// without a reviewed baseline — the runner will coerce it to soft anyway.

import type { MatrixCell } from './matrix-types'

export const MATRIX: MatrixCell[] = [
  // (0) ANCHOR — flat mercator, reuses the Oracle-B math oracles exactly.
  // Already-trusted: the reference is d3-geo + the live MVP, regenerated each
  // run, so no human bless is needed and it is hard from day one.
  {
    id: 'merc-europe-z4-p0',
    projection: 'mercator',
    zoom: 4,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic',
    surfaces: ['bg', 'fill', 'line', 'grid'],
    camera: { center: [2.3, 48.8] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'pixel_ref', max: 0.06 },
      {
        kind: 'ink_family',
        families: [
          { name: 'sky', minRatio: 0.001 },
          { name: 'rose', minRatio: 0.0005 },
        ],
      },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Oracle-B parity anchor — math-derived reference, no human bless needed.',
  },

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

  // (3) NON-MERC DEEP-ZOOM — real data. No d3 reference exists for natural_earth
  // at this scale, so the oracles are intrinsic (black-ratio: every pixel must
  // have a defined source) plus a committed baseline (candidate until reviewed).
  {
    id: 'natearth-seoul-z12-p0',
    projection: 'natural_earth',
    zoom: 12,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'black_ratio', max: 0.02 },
      { kind: 'screenshot_diff', max: 0.02 },
    ],
    gate: 'hard',
    knownStatus: 'candidate',
    note: 'Deep-zoom non-merc real data — no d3 oracle; relies on a reviewed PNG baseline. Soft until accepted.',
  },

  // (4) HIGH-PITCH — the tilted blind quadrant. The above-horizon void must be
  // sky-filled, not black (black-ratio), plus a committed baseline.
  {
    id: 'merc-seoul-z8-p60',
    projection: 'mercator',
    zoom: 8,
    pitch: 60,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'black_ratio', max: 0.02 },
      { kind: 'screenshot_diff', max: 0.025 },
    ],
    gate: 'hard',
    knownStatus: 'candidate',
    note: 'z0+pitch strip-vs-wedge class lives here; black-ratio + baseline tripwire. Soft until accepted.',
  },

  // (5) ANTIMERIDIAN — globe at the dateline. Globe has no flat d3 reference,
  // so the oracles are fill-present (the Pacific water fill must rasterize) +
  // a committed baseline. Declared soft AND candidate (doubly non-blocking).
  {
    id: 'globe-dateline-z2-p0',
    projection: 'globe',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill'],
    camera: { center: [180, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.01 }] },
      { kind: 'screenshot_diff', max: 0.03 },
    ],
    gate: 'soft',
    knownStatus: 'candidate',
    note: 'Globe seam continuity — no closed-form/d3 oracle; fill-present + baseline only.',
  },

  // (6) LABEL-HEAVY — position oracle, NOT pixel (labels proven unmeasurable by
  // pixel-match, per memory). Every placed anchor must land inside the
  // viewport+margin; gross mis-dispatch (a projection-blind label layer placing
  // anchors off-screen) fails here. No baseline → no bless → green from day one.
  {
    id: 'merc-seoul-z14-labels',
    projection: 'mercator',
    zoom: 14,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['label'],
    camera: { center: [126.98, 37.55] },
    oracles: [{ kind: 'label_onscreen', max: 3 }],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Label fidelity is position-gated (anchor-onscreen), never pixel-gated.',
  },
]
