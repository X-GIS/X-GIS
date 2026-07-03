import type { CoverageEntry } from './types'

export const PAINT_HILLSHADE: readonly CoverageEntry[] = [
  {
    name: 'hillshade-illumination-direction',
    status: 'unsupported',
    impact: 'medium',
    note: 'Hillshade renderer not implemented (raster-dem source registered but unused). Direction in degrees from N clockwise.',
  },
  {
    name: 'hillshade-illumination-altitude',
    status: 'unsupported',
    impact: 'medium',
    note: 'Light elevation angle (0–90°); no renderer.',
  },
  {
    name: 'hillshade-illumination-anchor',
    status: 'unsupported',
    impact: 'low',
    note: 'map / viewport — whether the sun follows bearing; no renderer.',
  },
  {
    name: 'hillshade-exaggeration',
    status: 'unsupported',
    impact: 'medium',
    note: 'Vertical-relief multiplier; no renderer.',
  },
  {
    name: 'hillshade-shadow-color',
    status: 'unsupported',
    impact: 'medium',
    note: 'Shadow side colour; no hillshade renderer.',
  },
  {
    name: 'hillshade-highlight-color',
    status: 'unsupported',
    impact: 'medium',
    note: 'Lit side colour; no hillshade renderer.',
  },
  {
    name: 'hillshade-accent-color',
    status: 'unsupported',
    impact: 'low',
    note: 'Per-feature accent tint; no hillshade renderer.',
  },
  {
    name: 'hillshade-method',
    status: 'unsupported',
    impact: 'low',
    note: 'basic / combined / igor / multidirectional — different DEM gradient algorithms.',
  },
  {
    name: 'resampling',
    status: 'unsupported',
    impact: 'low',
    note: 'bilinear / nearest sampling of the DEM raster; depends on hillshade renderer.',
  },
]
