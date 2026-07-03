// ═══ Demo Definitions — Procedural SDF geometry (population circles, billboard/flat points). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_PROCEDURAL: Record<string, Demo> = {
  procedural_circles: {
    name: 'Population Circles',
    tag: 'point',
    description:
      'Data-driven SDF circles — per-feature radius from sqrt(pop_max), evaluated on CPU',
    source: load('procedural-circles.xgis'),
  },

  sdf_points: {
    name: 'SDF Points',
    tag: 'point',
    description:
      'Billboard markers (8px) + flat coverage (300km) — right-click drag to pitch and compare',
    source: load('sdf-points.xgis'),
  },
}
