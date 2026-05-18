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
// the input. Phase 3.1+ landings flip flags true as the gaps close.

export interface RuntimeCapability {
  property: string
  layerType: string
  variant: 'constant' | 'zoom-interp' | 'data-driven'
  supported: boolean
  /** When false, brief reason for the gap. */
  note?: string
}

export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  // Fill
  { property: 'fill-color',          layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'data-driven', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'data-driven', supported: false, note: 'Per-feature opacity not threaded through renderer' },
  { property: 'fill-antialias',      layerType: 'fill', variant: 'constant',    supported: false, note: 'false branch not implemented; pipeline always uses MSAA' },
  { property: 'fill-translate',      layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-translate',      layerType: 'fill', variant: 'zoom-interp', supported: false, note: 'Per-frame zoom-interp deferred; last-stop approx only' },

  // Line
  { property: 'line-color',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-blur',           layerType: 'line', variant: 'constant',    supported: true,  note: 'Strict-zero NOT honoured yet (1.5px soft fade at blur=0)' },
  { property: 'line-dasharray',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-dasharray',      layerType: 'line', variant: 'zoom-interp', supported: false, note: 'PropertyShape<array> variant pending' },
  { property: 'line-gap-width',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-gap-width',      layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-offset',         layerType: 'line', variant: 'constant',    supported: true },

  // Symbol (text)
  { property: 'text-color',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'data-driven', supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: false, note: 'Fast-path resolves constant only' },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-pitch-alignment', layerType: 'symbol', variant: 'constant',   supported: false, note: 'Runtime never projects labels onto ground plane' },

  // Symbol (icon)
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: false, note: 'Per-feature alpha attr path deferred' },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'icon-size',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Worker per-feature evaluator pending' },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Expression flattens to 0; per-feature key plumbing pending' },

  // Circle
  { property: 'circle-radius',       layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'data-driven', supported: true },

  // Fill-extrusion
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'data-driven', supported: true },
  { property: 'fill-extrusion-base',   layerType: 'fill-extrusion', variant: 'constant',    supported: true },

  // Raster
  { property: 'raster-opacity',      layerType: 'raster', variant: 'constant',    supported: true },
  { property: 'raster-opacity',      layerType: 'raster', variant: 'zoom-interp', supported: true },
] as const

/** Lookup a (layerType, property, variant) tuple. Returns undefined
 *  when not catalogued — caller may treat that as "unknown" but the
 *  drift test gates a missing entry as well. */
export function runtimeCapability(
  layerType: string,
  property: string,
  variant: RuntimeCapability['variant'],
): RuntimeCapability | undefined {
  return RUNTIME_CAPABILITIES.find(
    c => c.layerType === layerType && c.property === property && c.variant === variant,
  )
}

/** Subset of capability rows where the runtime is known to drop or
 *  degrade the input. Useful for surfacing the gap matrix in docs
 *  or as a regression watch list. */
export function runtimeGaps(): readonly RuntimeCapability[] {
  return RUNTIME_CAPABILITIES.filter(c => !c.supported)
}
