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
    note: 'The single-pass fragment renders the nearest 3×3 decoded-height field; linear decoded-height smoothing is the documented two-pass upgrade.',
  },
]
