// ═══ Extra background-layer drop reporter ═══
//
// A Mapbox/MapLibre style may declare more than one `background`-type
// layer (e.g. zoom-partitioned via minzoom/maxzoom for a day/night
// transition). X-GIS emits a single top-level `background { … }`
// directive, so mapbox-to-xgis.ts binds only the FIRST background
// layer (via convertBackgroundLayer) and the main per-layer loop skips
// every layer of type 'background' — including that first one, which
// was already handled. Lifted into its own file (rather than inlined
// in mapbox-to-xgis.ts, which sits within a couple lines of its
// LOC cap) so a SECOND (or later) background layer is REPORTED as
// dropped instead of silently disappearing (#2333).

import type { MapboxLayer } from './types'
import type { StyleCoverage } from './mapbox-to-xgis'

/** Called from the main per-layer loop for every layer of type
 *  'background'. `bgLayer` is the one already converted above
 *  (identity-compared against `layer`); anything else is an extra
 *  background layer that used to vanish with no diagnostic — warn and
 *  record it in coverage so it can't read as a successful "converted"
 *  entry with empty `reasons`. */
export function reportDroppedBackgroundLayer(
  layer: MapboxLayer,
  bgLayer: MapboxLayer | undefined,
  warnings: string[],
  coverage: StyleCoverage | undefined,
): void {
  if (layer === bgLayer) return // the one convertBackgroundLayer already handled
  const reason = `Background layer "${layer.id}" — a style may declare only one background layer; this one was dropped (the first background layer "${bgLayer?.id ?? '<unknown>'}" is used instead).`
  warnings.push(reason)
  if (coverage) {
    coverage.layers.push({
      layerId: layer.id,
      type: 'background',
      action: 'skipped',
      reasons: [reason],
    })
  }
}
