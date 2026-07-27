// Runtime capability flags — per property × value-form what the
// renderer actually honours. Pairs with compiler/src/convert/
// spec-coverage.ts to detect silent drops: compiler accepts the
// property as "supported" but runtime ignores or partial-handles it.
//
// Mapping convention: layer.property:variant where variant is one of:
//   * 'constant'     — single literal value
//   * 'zoom-interp'  — interpolate-by-zoom (PropertyShape variant)
//   * 'data-driven'  — per-feature expression (case / match / get)
//
// Set to false ONLY when the runtime path drops or silently degrades
// the input. Landings flip flags true as the gaps close.
//
// ── Parallel-work registry ──────────────────────────────────────────
// The table is ASSEMBLED from one descriptor file per layer type under
// `capabilities/` (fill / line / symbol / circle / fill-extrusion /
// background / raster / heatmap / hillshade). A change to one layer type's capabilities edits
// ONLY that descriptor file, so independent axes in different layer types
// never conflict in this table and can be implemented in parallel. To add
// a new property's runtime support, append its row(s) to the matching
// `capabilities/<layerType>.ts` (NOT here). The drift / freshness gates
// read the assembled `RUNTIME_CAPABILITIES` below, so they keep working.

import type { RuntimeCapability } from './capabilities/types'
import { fillCapabilities } from './capabilities/fill'
import { lineCapabilities } from './capabilities/line'
import { symbolCapabilities } from './capabilities/symbol'
import { circleCapabilities } from './capabilities/circle'
import { fillExtrusionCapabilities } from './capabilities/fill-extrusion'
import { backgroundCapabilities } from './capabilities/background'
import { rasterCapabilities } from './capabilities/raster'
import { heatmapCapabilities } from './capabilities/heatmap'
import { hillshadeCapabilities } from './capabilities/hillshade'

export type { RuntimeCapability } from './capabilities/types'

export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  ...fillCapabilities,
  ...lineCapabilities,
  ...symbolCapabilities,
  ...circleCapabilities,
  ...fillExtrusionCapabilities,
  ...backgroundCapabilities,
  ...rasterCapabilities,
  ...heatmapCapabilities,
  ...hillshadeCapabilities,
]

/** Lookup a (layerType, property, variant) tuple. Returns undefined
 *  when not catalogued — caller may treat that as "unknown" but the
 *  drift test gates a missing entry as well. */
export function runtimeCapability(
  layerType: string,
  property: string,
  variant: RuntimeCapability['variant'],
): RuntimeCapability | undefined {
  return RUNTIME_CAPABILITIES.find(
    (c) => c.layerType === layerType && c.property === property && c.variant === variant,
  )
}

/** Subset of capability rows where the runtime is known to drop or
 *  degrade the input. Useful for surfacing the gap matrix in docs
 *  or as a regression watch list. */
export function runtimeGaps(): readonly RuntimeCapability[] {
  return RUNTIME_CAPABILITIES.filter((c) => !c.supported)
}
