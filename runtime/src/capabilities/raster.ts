import type { RuntimeCapability } from './types'

// `raster` layer capability rows (rendered by RasterRenderer). Only place a
// raster-axis change touches the capability table.
export const rasterCapabilities: readonly RuntimeCapability[] = [
  { property: 'raster-opacity',         layerType: 'raster', variant: 'data-driven', supported: false, note: 'Data-driven not applicable to raster tiles' },
  // raster-* colour adjustments — constant form applied per-show in the
  // raster fragment shader (RGB↔HSL). zoom/data-driven forms warn at
  // convert time (rare for raster colour params).
  { property: 'raster-hue-rotate',      layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-brightness-min',  layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-brightness-max',  layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-saturation',      layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-contrast',        layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-resampling',      layerType: 'raster', variant: 'constant', supported: true },
  { property: 'resampling',             layerType: 'raster', variant: 'constant', supported: true },
]
