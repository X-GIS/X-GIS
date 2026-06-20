// Coverage row + section types. Split out of ../spec-coverage.ts so each
// per-section descriptor file (top-level.ts / paint-fill.ts / expressions.ts
// / …) can import the type WITHOUT a circular dependency on the assembler
// that spreads them all together.
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

export type CoverageStatus = 'supported' | 'partial' | 'unsupported' | 'na'
export type CoverageImpact = 'high' | 'medium' | 'low'

export interface CoverageEntry {
  /** Mapbox Style Spec property name (or expression op). */
  readonly name: string
  readonly status: CoverageStatus
  readonly impact?: CoverageImpact
  /** Short note shown next to the table row. */
  readonly note?: string
  /** Source file:line where the converter (or its absence) lives. */
  readonly source?: string
}

export interface CoverageSection {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly entries: readonly CoverageEntry[]
}
