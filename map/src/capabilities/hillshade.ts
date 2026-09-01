import type { RuntimeCapability } from './types'

// `hillshade` layer capability rows (#777 Phase II — rendered by the
// HillshadeRenderer/HillshadePass DEM-relief pipeline: raster-dem decode →
// 3×3 Sobel → the full MapLibre v5 method set). Constant paint only —
// zoom-interp / data-driven hillshade forms warn + drop at convert time.
// Only place a hillshade-axis change touches the capability table.
export const hillshadeCapabilities: readonly RuntimeCapability[] = [
  {
    property: 'hillshade-illumination-direction',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'Single scalar + multidirectional numberArray (up to 4 sources; MapLibre repeat-last padding). Azimuth prefolds +180° and the viewport-anchor bearing per source.',
  },
  {
    property: 'hillshade-illumination-altitude',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'Single scalar + multidirectional numberArray (up to 4 sources).',
  },
  {
    property: 'hillshade-illumination-anchor',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'viewport (default) folds the camera bearing into every light azimuth per frame; map anchors the light(s) to data space.',
  },
  {
    property: 'hillshade-exaggeration',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
  },
  {
    property: 'hillshade-shadow-color',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'Single colour + multidirectional colorArray (up to 4 sources), premultiplied at pack time.',
  },
  {
    property: 'hillshade-highlight-color',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'Single colour + multidirectional colorArray (up to 4 sources), premultiplied at pack time.',
  },
  {
    property: 'hillshade-accent-color',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'Used by the standard model only (MapLibre parity).',
  },
  {
    property: 'hillshade-method',
    layerType: 'hillshade',
    variant: 'constant',
    supported: true,
    note: 'All five MapLibre v5 models implemented in fs_hillshade: standard / basic / combined / igor / multidirectional.',
  },
  {
    property: 'resampling',
    layerType: 'hillshade',
    variant: 'constant',
    supported: false,
    note: 'Not selectable — but `resampling` never selected the DEM sampler anyway. The DEM is RGB-packed and decoded in the fragment, so bilinear filtering would corrupt the decode and the draper binds one nearest sampler for every hillshade layer; MapLibre binds its DEM nearest for BOTH values too, and applies the flag to the texture filter on the Sobel-derivative output of its prepare pass instead (maplibre-gl 5.24.0, dist/maplibre-gl-dev.js lines 64424 / 64443 / 64453). X-GIS shades single-pass from that nearest DEM, so the relief is flat across each DEM texel — the MapLibre `nearest` look — and the spec-default linear is never rendered; an explicitly authored linear warns at convert time (#2166). Making linear real is a 4-tap blend of the DECODED heights before the Sobel plus a material-key axis and a renderer setter (#2215) — still SINGLE-PASS, not a sampler flag. The compiler emits resamplingNearest end to end and no hillshade runtime code reads it.',
  },
]
