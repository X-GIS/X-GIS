import type { RuntimeCapability } from './types'

// `raster` layer capability rows (rendered by RasterRenderer). Only place a
// raster-axis change touches the capability table.
export const rasterCapabilities: readonly RuntimeCapability[] = [
  // raster-opacity. The `constant` row is what the spec-coverage drift gate
  // resolves for this property; without it the whole property was skipped
  // there and its `supported` row passed vacuously (#2166).
  { property: 'raster-opacity', layerType: 'raster', variant: 'constant', supported: true },
  {
    property: 'raster-opacity',
    layerType: 'raster',
    variant: 'data-driven',
    supported: false,
    note: 'A per-feature expression is not authorable on a raster layer (the pinned spec marks raster-opacity data-constant — a raster tile carries no features) and resolves to 1. The other shape X-GIS files under this variant — an input-dependent binding, reading a declared input but no feature field — IS honoured: the opaque pass resolves it per frame since #2166.',
  },
  // raster-* colour adjustments — constant form applied per-show in the
  // raster fragment shader (RGB↔HSL). zoom/data-driven forms warn at
  // convert time (rare for raster colour params).
  { property: 'raster-hue-rotate', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-brightness-min', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-brightness-max', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-saturation', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-contrast', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'raster-resampling', layerType: 'raster', variant: 'constant', supported: true },
  { property: 'resampling', layerType: 'raster', variant: 'constant', supported: true },
  // raster-fade-duration (#1257): constant-only per-tile cross-fade override.
  // zoom/data-driven forms warn + drop at convert time (paint-raster.ts). No arm
  // of spec-coverage-runtime-drift.test.ts reads the zoom-interp row below (arms
  // 1/2 look at `constant`, arm 3 skips `!supported`), so its warn+drop claim is
  // owned by compiler/src/__tests__/raster-fade-duration-wiring.test.ts case (e),
  // which asserts both halves directly on the converter (#2218).
  {
    property: 'raster-fade-duration',
    layerType: 'raster',
    variant: 'constant',
    supported: true,
  },
  {
    property: 'raster-fade-duration',
    layerType: 'raster',
    variant: 'zoom-interp',
    supported: false,
    note: 'Warns and drops at convert time. The gap is not just the IR field shape: the duration is pushed once at layer rebuild, so nothing samples it per frame, and a duration that moves mid-fade makes the per-tile alpha ramp non-monotone in time. See the raster-fade-duration spec-coverage note.',
  },
]
