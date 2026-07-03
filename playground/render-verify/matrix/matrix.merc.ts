// Visual-regression MATRIX gate — merc fragment.
//
// Per-axis split of the single-authority MATRIX. Mercator cells (anchor, pitch, labels, z0+pitch strip bugs, 3D extrusion depth). The assembler
// matrix.manifest.ts concatenates the four fragments; OracleSpec / MatrixCell
// types stay in matrix-types. Append-only: a new merc cell is added HERE
// without touching the other fragments.
//
// See docs/verification/MATRIX.md for the candidate->review->accept flow.

import type { MatrixCell } from '../matrix-types'

export const MATRIX_MERC: MatrixCell[] = [
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
      { kind: 'black_ratio', max: 0.1 },
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
      { kind: 'black_ratio', max: 0.1 },
    ],
    gate: 'soft',
    knownStatus: 'expected_red',
    note: 'Known-bug axis: label pitch-align at steep tilt (p=70). Label anchors are projection-blind (flat Mercator coords re-projected by the tilted frustum → bunching/vanishing). ink_family checks some label surface ink; black_ratio guards the tilted top third. Documents the axis; upgrade to label_onscreen later. Soft tripwire.',
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
