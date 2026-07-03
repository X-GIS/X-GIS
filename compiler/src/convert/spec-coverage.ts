// ═══ Mapbox Style Spec coverage table ═══
//
// Single source of truth for "what does the converter handle?". The
// site's /docs/mapbox-spec page renders this; the
// spec-coverage-drift.test.ts validates that every property the
// converter source actually references appears here (catches stale
// table after converter changes) and that every property declared
// here is actually referenced (catches dead table entries).
//
// Status values:
//   - 'supported'    — converter emits an xgis form AND runtime honours it
//   - 'partial'      — converter emits SOMETHING but loses information
//                      (e.g. exponential interpolate folded to linear),
//                      OR runtime gap behind the converter
//   - 'unsupported'  — converter drops with a warning OR silently
//   - 'na'           — Mapbox-specific concept with no xgis equivalent
//                      and no plan to add (e.g. `ref`, deprecated keys)
//
// Impact tier captures user-visible severity, NOT effort to fix:
//   - 'high'   — visible mismatch in common basemap styles (OFM Bright,
//                MapLibre demo) — colour / line width / labels
//   - 'medium' — visible in some styles or specific zoom ranges
//   - 'low'    — rarely-used; visual difference minor or invisible
//
// ── Parallel-work registry ──────────────────────────────────────────
// This table is ASSEMBLED from one descriptor file per section under
// `spec-coverage/` (top-level / source-types / layer-types / layer-common
// / layout-fill-line / layout-symbol / paint-background / paint-fill /
// paint-line / paint-symbol / paint-circle / paint-fill-extrusion /
// paint-raster / paint-heatmap / paint-hillshade / expressions / filters).
// A change to one section's coverage edits ONLY that descriptor file, so
// independent parity axes that touch different sections never conflict in
// this table and can be implemented in parallel (worktree fan-out). To add
// a new coverage row, append it to the matching `spec-coverage/<section>.ts`
// (NOT here). The drift / completeness / gap-matrix gates read the assembled
// `MAPBOX_COVERAGE` below, so they keep working unchanged.

import type { CoverageEntry, CoverageSection } from './spec-coverage/types'
import { TOP_LEVEL } from './spec-coverage/top-level'
import { SOURCE_TYPES } from './spec-coverage/source-types'
import { LAYER_TYPES } from './spec-coverage/layer-types'
import { LAYER_COMMON } from './spec-coverage/layer-common'
import { LAYOUT_FILL_LINE } from './spec-coverage/layout-fill-line'
import { LAYOUT_SYMBOL } from './spec-coverage/layout-symbol'
import { PAINT_BACKGROUND } from './spec-coverage/paint-background'
import { PAINT_FILL } from './spec-coverage/paint-fill'
import { PAINT_LINE } from './spec-coverage/paint-line'
import { PAINT_SYMBOL } from './spec-coverage/paint-symbol'
import { PAINT_CIRCLE } from './spec-coverage/paint-circle'
import { PAINT_FILL_EXTRUSION } from './spec-coverage/paint-fill-extrusion'
import { PAINT_RASTER } from './spec-coverage/paint-raster'
import { PAINT_HEATMAP } from './spec-coverage/paint-heatmap'
import { PAINT_HILLSHADE } from './spec-coverage/paint-hillshade'
import { EXPRESSIONS } from './spec-coverage/expressions'
import { FILTERS } from './spec-coverage/filters'

export type {
  CoverageStatus,
  CoverageImpact,
  CoverageEntry,
  CoverageSection,
} from './spec-coverage/types'

// ─── Assembled tree ───────────────────────────────────────────────────
export const MAPBOX_COVERAGE: readonly CoverageSection[] = [
  {
    id: 'top-level',
    title: 'Top-level style properties',
    description: 'Fields on the root Mapbox style object.',
    entries: TOP_LEVEL,
  },
  {
    id: 'sources',
    title: 'Source types',
    description: '`sources[id].type` values.',
    entries: SOURCE_TYPES,
  },
  {
    id: 'layers',
    title: 'Layer types',
    description: '`layer.type` values.',
    entries: LAYER_TYPES,
  },
  {
    id: 'layer-common',
    title: 'Layer common fields',
    description: 'Shared across all `layer` shapes regardless of type.',
    entries: LAYER_COMMON,
  },
  {
    id: 'layout-fill-line',
    title: 'Layout — fill / line',
    entries: LAYOUT_FILL_LINE,
  },
  {
    id: 'layout-symbol',
    title: 'Layout — symbol',
    entries: LAYOUT_SYMBOL,
  },
  {
    id: 'paint-background',
    title: 'Paint — background',
    entries: PAINT_BACKGROUND,
  },
  {
    id: 'paint-fill',
    title: 'Paint — fill',
    entries: PAINT_FILL,
  },
  {
    id: 'paint-line',
    title: 'Paint — line',
    entries: PAINT_LINE,
  },
  {
    id: 'paint-symbol',
    title: 'Paint — symbol',
    entries: PAINT_SYMBOL,
  },
  {
    id: 'paint-circle',
    title: 'Paint — circle',
    entries: PAINT_CIRCLE,
  },
  {
    id: 'paint-fill-extrusion',
    title: 'Paint — fill-extrusion',
    entries: PAINT_FILL_EXTRUSION,
  },
  {
    id: 'paint-raster',
    title: 'Paint — raster',
    entries: PAINT_RASTER,
  },
  {
    id: 'paint-heatmap',
    title: 'Paint — heatmap',
    description:
      'Heatmap layer renderer is not implemented; every property here is unsupported pending a roadmap entry.',
    entries: PAINT_HEATMAP,
  },
  {
    id: 'paint-hillshade',
    title: 'Paint — hillshade',
    description:
      'Hillshade layer renderer is not implemented; raster-dem source is recognised but produces no output.',
    entries: PAINT_HILLSHADE,
  },
  {
    id: 'expressions',
    title: 'Expression operators',
    description: 'Mapbox Style Spec v1 expression form (the bracketed `["op", …]` syntax).',
    entries: EXPRESSIONS,
  },
  {
    id: 'filters',
    title: 'Filters',
    description:
      'Legacy + expression form. Most filter operators reuse the expression infrastructure.',
    entries: FILTERS,
  },
]

/** Flat enumeration of every entry across sections, for tooling / tests. */
export function flattenCoverage(): readonly CoverageEntry[] {
  return MAPBOX_COVERAGE.flatMap((s) => s.entries)
}
