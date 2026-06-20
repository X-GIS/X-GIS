// Visual-regression MATRIX gate — globe fragment.
//
// Per-axis split of the single-authority MATRIX. Globe (projType 7) cells. The assembler
// matrix.manifest.ts concatenates the four fragments; OracleSpec / MatrixCell
// types stay in matrix-types. Append-only: a new globe cell is added HERE
// without touching the other fragments.
//
// See docs/verification/MATRIX.md for the candidate->review->accept flow.

import type { MatrixCell } from '../matrix-types'

export const MATRIX_GLOBE: MatrixCell[] = [
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
]
