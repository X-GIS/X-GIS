import type { RuntimeCapability } from './types'

// `raster` layer capability rows (rendered by RasterRenderer). Only place a
// raster-axis change touches the capability table.
export const rasterCapabilities: readonly RuntimeCapability[] = [
  { property: 'raster-opacity',      layerType: 'raster', variant: 'data-driven', supported: false, note: 'Data-driven not applicable to raster tiles' },
]
