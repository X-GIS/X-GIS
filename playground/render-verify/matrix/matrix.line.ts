// Visual-regression MATRIX gate — line fragment.
//
// Per-axis split of the single-authority MATRIX. Cylindrical-nonmerc cells (equirectangular / natural_earth / oblique_mercator). The assembler
// matrix.manifest.ts concatenates the four fragments; OracleSpec / MatrixCell
// types stay in matrix-types. Append-only: a new line cell is added HERE
// without touching the other fragments.
//
// See docs/verification/MATRIX.md for the candidate->review->accept flow.

import type { MatrixCell } from '../matrix-types'

export const MATRIX_LINE: MatrixCell[] = [
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
      {
        kind: 'ink_family',
        families: [
          { name: 'emerald', minRatio: 0.0005 },
          { name: 'sky', minRatio: 0.001 },
        ],
      },
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
      {
        kind: 'ink_family',
        families: [
          { name: 'emerald', minRatio: 0.0005 },
          { name: 'sky', minRatio: 0.001 },
        ],
      },
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

  {
    id: 'natearth-z0-p60-highpitch-weakspot',
    projection: 'natural_earth',
    zoom: 0,
    pitch: 60,
    bearing: 0,
    dataset: 'synthetic_disc',
    surfaces: ['bg'],
    camera: { center: [0, 0] },
    oracles: [{ kind: 'black_ratio', max: 0.1 }],
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
]
