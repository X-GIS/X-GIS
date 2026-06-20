// Mapbox `raster` layer paint → xgis utilities. Per-type emitter group
// extracted from paint.ts; called by the thin dispatcher in paint.ts
// in the exact same order. Shared emitters (addOpacity /
// surfaceIgnoredPaint) live in paint-helpers.
import type { MapboxLayer } from './types'
import {
  addOpacity,
  surfaceIgnoredPaint,
} from './paint-helpers'

export function emitRasterPaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
  // raster-opacity reuses the layer-uniform `opacity` resolver path
  // every other layer type goes through — same interpolate(zoom, …)
  // + constant + data-driven shapes all work. The runtime side
  // multiplies the sampled texel by the resolved opacity in the
  // raster fragment shader so the basemap shaded-relief styles
  // (OFM Liberty's `natural_earth`) fade out at higher zooms the
  // way they do in MapLibre.
  addOpacity(out, p['raster-opacity'], warnings)
  // raster-resampling: 'linear' (default) matches X-GIS — the sampler
  // is fixed to linear. 'nearest' is a real gap (pixel-art / DEM
  // staircase rendering); suppress the spec-default warn and only
  // surface the real gap.
  const rsRaw = p['raster-resampling']
  const rs = Array.isArray(rsRaw) && rsRaw.length === 2 && rsRaw[0] === 'literal' ? rsRaw[1] : rsRaw
  const skipResamplingWarn = rs === 'linear' || rs === undefined || rs === null
  surfaceIgnoredPaint(layer.id, p, warnings, [
    'raster-hue-rotate', 'raster-brightness-min', 'raster-brightness-max',
    'raster-saturation', 'raster-contrast',
    'raster-fade-duration',
    ...(skipResamplingWarn ? [] : ['raster-resampling']),
  ])
  if (rs === 'nearest') {
    warnings.push(`Layer "${layer.id}" — raster-resampling: nearest set but X-GIS sampler is fixed to linear (Plan §4 deferred — would need a separate nearest-sampler binding). Tiles render with linear filtering regardless.`)
  }
}
