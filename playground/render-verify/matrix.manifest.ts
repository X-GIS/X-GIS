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
      // Under-invalidation guard (S16 net). LAST so its mutate→restore window
      // never overlaps a sibling oracle. min mirrors frame_stability's 0.5%
      // "same frame?" boundary: under-invalidation makes the post-change frame
      // byte-identical to the pre-change one (diff ≈ 0 < min), while a correct
      // repaint clears it with wide margin (a needed repaint must NOT be skipped).
      { kind: 'post_change', min: 0.005 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Oracle-B parity anchor — math-derived reference, no human bless needed. post_change is the under-invalidation complement to the disc cells frame_stability.',
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
    knownStatus: 'green',
    note: 'Deep-zoom non-merc real data — no d3 oracle; relies on a reviewed PNG baseline (accepted 2026-06-10).',
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
    knownStatus: 'green',
    note: 'z0+pitch strip-vs-wedge class lives here; black-ratio + baseline tripwire (accepted 2026-06-10).',
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
    knownStatus: 'green',
    note: 'Globe seam continuity — no closed-form/d3 oracle; fill-present + baseline (accepted 2026-06-10; gate stays soft deliberately).',
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
    oracles: [
      { kind: 'label_onscreen', max: 3 },
      // S16 label-skip gate. frame_stability re-captures the settled scene: the
      // SECOND frame exercises the consumer skip (sig unchanged + LABEL clean →
      // prepare() skipped → renderer draws replayed), so a ~0 diff proves the
      // replayed labels are byte-identical to the freshly-collided ones; a stale
      // or corrupted replay fails here. post_change zooms 14→15: the sig moves →
      // full re-dispatch + re-collision → the frame MUST change, catching an
      // over-aggressive skip that under-invalidates a needed label rebuild.
      { kind: 'frame_stability', max: 0.005 },
      { kind: 'post_change', min: 0.005 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Label fidelity is position-gated (anchor-onscreen), never pixel-gated. frame_stability + post_change gate the S16 label dispatch/collision skip (replay-correct + move-rebuilds). Real-GPU only — validate on the desktop matrix.',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // INCREMENT 2 — no-baseline blind-axis expansion. Every cell below uses
  // ONLY math/closed-form/intrinsic oracles (numeric_forward, ink_family,
  // black_ratio, disc_fraction, finite_mvp) — NO screenshot_diff, so NO human
  // bless is needed. Known-bug cells are gate:'soft'+expected_red so the
  // opt-in gate still reports green overall (the runner coerces them to soft).
  // Naming/threshold notes: the design used `invariant_ink`→ink_family,
  // `coverage_black`→black_ratio, datasets fixture_synth_bg_only→synthetic_disc
  // and openfreemap_bright→ofm_bright (the schema literals). disc_fraction
  // bands are expressed in the existing symmetric `expected ± max` form (the
  // oracle was NOT changed to a [min,max] range mode — that would alter the
  // seed cells' semantics).
  // ═══════════════════════════════════════════════════════════════════════

  // ── FAMILY: cylindrical-nonmerc (equirectangular / natural_earth / oblique)
  {
    id: 'equirect-world-z2-p0-numeric',
    projection: 'equirectangular',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic',
    surfaces: ['bg', 'fill', 'line', 'grid'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'ink_family', families: [{ name: 'emerald', minRatio: 0.0005 }, { name: 'sky', minRatio: 0.001 }] },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Probe-verified equirect numeric_forward (maxErr ~6e-6 px). Guards projType-1 reproject regression; synthetic fixture gives reproducible emerald+sky ink. (black_ratio dropped: the synthetic fixture renders on a black backdrop — its ~73% black is legit empty bg, not a void.)',
  },
  {
    id: 'equirect-p30-ofm-z4',
    projection: 'equirectangular',
    zoom: 4,
    pitch: 30,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Pitch=30 equirect tilt axis on real basemap. black_ratio verifies the outside-band background fills the letterbox; ink_family proves fill not dropped under tilt.',
  },
  {
    id: 'equirect-p60-ofm-z4',
    projection: 'equirectangular',
    zoom: 4,
    pitch: 60,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'High-pitch (60°) equirect — most demanding flat-cylindrical tilt. black_ratio catches the above-horizon void. (numeric_forward dropped: the flat CPU mirror has no perspective/tilt term, so it is invalid at pitch != 0 — ink+black gate the tilt.)',
  },
  {
    id: 'equirect-seoul-z14-deepzoom',
    projection: 'equirectangular',
    zoom: 14,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: non-merc deep-zoom f32 numeric drift (~0.035–0.11px at z14–16, above the 1e-2 gate). Soft tripwire; flips green when f32 RTC precision is fixed.',
  },
  {
    id: 'equirect-antimeridian-z2-p0',
    projection: 'equirectangular',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [180, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.01 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 2756ba3e (2026-06-01, #207): antimeridian seam-wall kept on its home lobe (unwrap_lon_near_keep sign-biased fold). Was: equirect antimeridian seam flicker on cross-copy water polygons (T-junction void strip / black wedge at ±180). 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'natearth-world-z2-p0-numeric',
    projection: 'natural_earth',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic',
    surfaces: ['bg', 'fill', 'line', 'grid'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'ink_family', families: [{ name: 'emerald', minRatio: 0.0005 }, { name: 'sky', minRatio: 0.001 }] },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Probe-verified NE numeric_forward (maxErr ~6e-4 px via xgisNaturalEarth1Raw). Guards projType-2 reproject; center [0,20] avoids the OPEN antimeridian seam tear. (black_ratio dropped: synthetic black backdrop ~73% is legit empty bg, not a void.)',
  },
  {
    id: 'natearth-p30-ofm-z4',
    projection: 'natural_earth',
    zoom: 4,
    pitch: 30,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Pitch=30 NE tilt axis (variable-x-scale polynomial). ink_family + black_ratio guard the tilted NE camera path; numeric is out of probe-scope at pitch.',
  },
  {
    id: 'natearth-p60-ofm-z4',
    projection: 'natural_earth',
    zoom: 4,
    pitch: 60,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'High-pitch (60°) NE — black_ratio is primary (forgetting above-horizon sky fill on NE produces a large void); ink_family confirms tilted content rasterizes.',
  },
  {
    id: 'natearth-seoul-z14-deepzoom',
    projection: 'natural_earth',
    zoom: 14,
    pitch: 0,
    bearing: 0,
    dataset: 'synthetic',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: NE deep-zoom f32 numeric drift (phi^6 polynomial + f32 RTC mantissa loss at z14). Soft tripwire; flips green when precision is fixed.',
  },
  {
    id: 'natearth-antimeridian-z2-p0',
    projection: 'natural_earth',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [180, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.01 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 2756ba3e + 52d609c7 (2026-06-01, #207/#211): seam-wall home-lobe keep + NE-lobe wrap before polynomial eval. Was: NE antimeridian seam flicker (variable-x-scale distortion at the dateline → black wedge). 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'oblique-world-z2-p0',
    projection: 'oblique_mercator',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
      { kind: 'finite_mvp' },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Oblique baseline invariant — no probe-verified d3 ref (numeric_forward would skip). ink_family + black_ratio + finite_mvp are the no-baseline guards; center [0,20] avoids polar/antimeridian known bugs.',
  },
  {
    id: 'oblique-p30-z4',
    projection: 'oblique_mercator',
    zoom: 4,
    pitch: 30,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
      { kind: 'finite_mvp' },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Oblique pitch=30 axis. Oblique is excluded from render-loop promotion at pitch>0 historically; black_ratio catches above-horizon void, finite_mvp guards the tilted matrix.',
  },
  {
    id: 'oblique-p60-z4',
    projection: 'oblique_mercator',
    zoom: 4,
    pitch: 60,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
      { kind: 'finite_mvp' },
    ],
    gate: 'hard',
    knownStatus: 'green',
    note: 'Oblique high-pitch (60°) — most demanding tilt for the cylindrical-nonmerc family. black_ratio primary (above-horizon must be bg-filled); finite_mvp + ink_family complete the pitch sweep [0/30/60].',
  },
  {
    id: 'oblique-polar-z3',
    projection: 'oblique_mercator',
    zoom: 3,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 75] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 79fe33ba (2026-05-29, #184): singularity-only clamp (89.9999°) in the rotated frame replaces MERCATOR_LAT_LIMIT. Was: oblique polar tearing at lat 75°N (rotated antimeridian + 85.05° clamp → vertex collapse → tile tearing / fill gaps). Gated by oblique-polar-tearing.test.ts; 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'oblique-antimeridian-z2',
    projection: 'oblique_mercator',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [180, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug LIVE: oblique rotated-antimeridian tearing — the rotated-frame radian unwrap (unwrap_rad_near) never received the seam-keep fix that cured the degree-space cells (2756ba3e fixed unwrap_lon_near_keep only). ORACLE GAP (triage 2026-06-10): ink_family/black_ratio pass even with a tear — passing is vacuous. Needs a seam-continuity oracle (screenshot_diff baseline at [180,0] once the seam is fixed, or a seam-column fill-class continuity probe). Cell doubles as the live-bug tripwire meanwhile.',
  },
  {
    id: 'equirect-seoul-z16-deepzoom-ofm',
    projection: 'equirectangular',
    zoom: 16,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line', 'point'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.005 }] },
      { kind: 'black_ratio', max: 0.02 },
      // Triage 2026-06-10: ink/black pass was VACUOUS for the documented
      // 0.11px f32-RTC drift — this positional oracle (mirroring the z14
      // sibling natearth-seoul-z14-drift) makes the red non-vacuous.
      { kind: 'numeric_forward', max: 1e-2 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: z16 equirect deep-zoom 0.11px f32-RTC drift (fundamental f32 physics per the 2026-06-08 audit 4197390f). numeric_forward measures live MVP vs the CPU mirror — the drift shows as > 1e-2 px; ink/black only guard a wholly unrendered frame. Soft tripwire.',
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

  // ── FAMILY: globe (projType 7)
  {
    id: 'globe-world-z2-p0',
    projection: 'globe',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.01 }] },
      { kind: 'black_ratio', max: 0.05 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Globe world-view sanity baseline. ink_family catches a dropped fill / blank disc; black_ratio (≤5%) catches a void sphere; finite_mvp guards buildGlobeMatrix. No baseline. Soft (globe has no math ref).',
  },
  {
    id: 'globe-dateline-z2-p0-nobs',
    projection: 'globe',
    zoom: 2,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill'],
    camera: { center: [180, 0] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'slate', minRatio: 0.01 }] },
      { kind: 'black_ratio', max: 0.08 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Globe dateline axis — no-baseline companion to globe-dateline-z2-p0. ink_family asserts the Pacific fill renders across the seam; black_ratio (≤8%) asserts the seam is not a black void.',
  },
  {
    id: 'globe-deep-z13-p0',
    projection: 'globe',
    zoom: 13,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'black_ratio', max: 0.03 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Globe deep-zoom z13 Seoul (prior z10-11 OOM region, arena byte-aware eviction PR #193). black_ratio (≤3%) catches a tile-upload void; finite_mvp guards the extreme near/far orbit camera.',
  },
  {
    id: 'globe-deep-z14-geoid',
    projection: 'globe',
    zoom: 14,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'black_ratio', max: 0.03 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 5125c182 + f77722fb (2026-06-01, #208/#194): ellipsoid camera basis in globe RTC offset (sphere−ellipsoid ~21.5 km term cancels) + bg mesh unified to WGS84 ellipsoid. Was: globe z14 sphere-vs-ellipsoid geoid offset (~21 km bg-mesh-vs-tiles → seam misregistration / blank tiles). Gated by globe-ecef-frame-consistency + surface-geoid-unification tests; 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'globe-pitch-p45-z4',
    projection: 'globe',
    zoom: 4,
    pitch: 45,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [0, 20] },
    oracles: [
      { kind: 'black_ratio', max: 0.05 },
      { kind: 'finite_mvp' },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Globe pitched view (45°) — exercises buildGlobeMatrix orbit-tilt. black_ratio (≤5%) asserts the visible hemisphere is not a void; finite_mvp guards the pitch+globe matrix (near/far shifts at non-zero pitch).',
  },
  {
    id: 'globe-pole-pan-block',
    projection: 'globe',
    zoom: 3,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill'],
    camera: { center: [0, 89] },
    oracles: [
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.05 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY e4c36973 + b702fba1 + 5edb29d5 (2026-06-05, S10/S11/S12): centerLatDeg carries the true pole-ward latitude through setCenter/drag/zoom — pan-block at ±85.051129° removed (camera-center-sync.test reaches 89). Was: globe pole-reach pan-block (camera snapped back to the Mercator limit). Remaining ~5° sub-pole fill-detail gap is opt-in by design (injectPolarCaps user-driven), not a render bug — see globe-pole-z5-clean. 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'globe-pole-z5-clean',
    projection: 'globe',
    zoom: 5,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill'],
    camera: { center: [0, 90] },
    oracles: [
      { kind: 'finite_mvp' },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Globe centred on the EXACT north pole (lat 90, reachable via S10/S12 centerLatDeg). Guards that the magnified pole renders clean — the earth-surface bg fills it as Arctic-Ocean blue (geographically correct; the pole IS ocean), with NO cap-fan singularity / void. Diagnosis (2026-06-05) confirmed the apparent "wedge + dotted ring" in the zoomed-OUT z3 view is normal arctic LAND geometry + low-zoom aliasing of the 85° Mercator fill-boundary coastline compression — it spreads out and vanishes on zoom-in (this cell), so there is no pole-singularity bug. black_ratio guards against a void; finite_mvp guards the pole MVP.',
  },
  {
    id: 'globe-backface-label-p0',
    projection: 'globe',
    zoom: 3,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'label'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'label_onscreen', max: 3 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 3a49daa9 (2026-06-01, #209): horizon cull — far-hemisphere anchors (eye·normal<0) return null in makeLabelProjectors. Was: globe back-face labels rendered through the globe. Gated by render-loop-label-backface.test.ts; label_onscreen ≤3 confirmed 3× real-GPU 2026-06-09.',
  },

  // ── FAMILY: known-failure-tripwires (cross-projection confirmed-bug cells)
  {
    id: 'merc-z0-p60-strip-bug',
    projection: 'mercator',
    zoom: 0,
    pitch: 60,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    // Healthy band ≈ 0.50–0.85 (midpoint 0.675 ± 0.175); the z0+pitch strip
    // collapses the disc well below 0.50 → expected_red.
    oracles: [
      { kind: 'black_ratio', max: 0.10 },
      { kind: 'disc_fraction', expected: 0.675, max: 0.175 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: mercator z0+pitch=60 degenerates to a flat strip (project_mercator_z0_pitch_render). disc_fraction catches the collapse; black_ratio catches the above-horizon void. Soft tripwire; flips green when buildGlobeMatrix near/far is corrected at z=0.',
  },
  {
    id: 'merc-z0-p80-strip-bug',
    projection: 'mercator',
    zoom: 0,
    pitch: 80,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'black_ratio', max: 0.15 },
      { kind: 'disc_fraction', expected: 0.675, max: 0.175 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: same class as merc-z0-p60 at the steepest pitch (p=80), where the strip is most severe (disc → thin sliver). Two pitch points bound the regression curve so a partial fix is still caught. Soft tripwire.',
  },
  {
    id: 'natearth-z0-p60-highpitch-weakspot',
    projection: 'natural_earth',
    zoom: 0,
    pitch: 60,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    oracles: [
      { kind: 'black_ratio', max: 0.10 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'FIXED-BY 8b72fd85 (2026-05-29, #182): viewHeightMeters capped at WORLD_MERC in buildGlobeMatrix near/far path — z0+pitch altitude bloat removed for all cylindrical projections. Was: z0 systemic weak spot — NE z0+pitch=60 framing collapse, void above the clipped horizon. 3× real-GPU PASS 2026-06-09.',
  },
  {
    id: 'natearth-seoul-z14-drift',
    projection: 'natural_earth',
    zoom: 14,
    pitch: 0,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'fill', 'line'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'numeric_forward', max: 1e-2 },
      { kind: 'black_ratio', max: 0.02 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug: confirmed non-merc deep-zoom drift. numeric_forward at z14 NE measures live MVP vs the CPU xgisNaturalEarth1Raw mirror; deep-zoom RTC precision loss shows as drift > 1e-2px. black_ratio guards a total tile-load failure. Soft tripwire.',
  },
  {
    id: 'merc-z8-p70-label-pitchalign',
    projection: 'mercator',
    zoom: 8,
    pitch: 70,
    bearing: 0,
    dataset: 'ofm_bright',
    surfaces: ['bg', 'label'],
    camera: { center: [126.98, 37.55] },
    oracles: [
      { kind: 'ink_family', families: [{ name: 'sky', minRatio: 0.0005 }] },
      { kind: 'black_ratio', max: 0.10 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug axis: label pitch-align at steep tilt (p=70). Label anchors are projection-blind (flat Mercator coords re-projected by the tilted frustum → bunching/vanishing). ink_family checks some label surface ink; black_ratio guards the tilted top third. Documents the axis; upgrade to label_onscreen later. Soft tripwire.',
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

  // (N) 3D EXTRUSION DEPTH (#4b) — REAL-GPU ONLY (extrude doesn't raster under
  // SwiftShader). osm-style on protomaps v4 (API TileJSON) extrudes buildings
  // from `.height` at Tokyo z16 p45 — the only working extrusion path (synthetic
  // inline cannot extrude; OFM-Bright buildings are flat — verified 2026-06-09).
  // At pitch the front buildings occlude the back; a botched depth state
  // (reversed-Z / wrong compare) z-fights → frame_stability fails. black_ratio =
  // the dense city rendered. The holistic screenshot_diff depth-regression gate
  // is added once a real-GPU capture is reviewed + accepted. Candidate → soft.
  {
    id: 'osm-shinjuku-z16-p60-extrude',
    projection: 'mercator',
    zoom: 16,
    pitch: 60,
    bearing: 0,
    dataset: 'osm_style',
    surfaces: ['fill', 'line', 'label', 'extrusion'],
    camera: { center: [139.6917, 35.6895] }, // Nishi-Shinjuku skyscraper cluster
    oracles: [
      { kind: 'black_ratio', max: 0.2 },
      { kind: 'frame_stability', max: 0.02 },
      // The holistic depth-ordering gate: a reviewed baseline of the 3D
      // skyline pins WHICH building pixels win the depth test. Any
      // depth-sort / occlusion regression ("buildings behind appear in
      // front", reckoning #4) repaints whole facades → the diff fails.
      // Threshold 0.03: real network data + label AA variance at p60.
      { kind: 'screenshot_diff', max: 0.03 },
    ],
    gate: 'soft',
    knownStatus: 'green',
    note: 'Real-data 3D extrusion depth net (protomaps v4 buildings, Shinjuku z16 p60) — the only working extrusion path (synthetic inline cannot extrude, OFM buildings are flat). frame_stability catches the z-fighting a botched depth state (reversed-Z) produces; black_ratio = the dense 3D city rendered; screenshot_diff (baseline reviewed + accepted 2026-06-10: near towers occlude far, no ordering inversion) pins the depth/occlusion ordering holistically. Gate stays soft: protomaps network data.',
  },
]
