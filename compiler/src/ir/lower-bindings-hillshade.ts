// ═══ AST → IR Lowering: HILLSHADE-concern binding handlers (#777 Phase II) ═══
//
// Mirror of the raster colour-adjustment arms in lower-bindings-paint.ts:
// each `hillshade-*` utility the converter (paint-hillshade.ts) emits lowers
// into a flat field on the shared LayerAccumulator. emit-commands then folds
// those into the optional `paintShapes.hillshade` bundle the (future INC-3)
// renderer reads. Only single-source constant forms exist here — the
// converter already warned + dropped numberArray / colorArray multi-source
// (multidirectional) and non-constant forms, so every value that reaches a
// handler is a resolved constant.
//
// Kept in its own module (not lower-bindings-paint.ts) so the nine hillshade
// axes stay cohesive and the paint module stays under the LOC ceiling.

import { resolveColor } from '../tokens/colors'
import { hexToRgba } from './render-node'
import type { HillshadeMethod } from './property-types'
import type { BindingHandler } from './lower-bindings'

const HILLSHADE_METHODS: readonly HillshadeMethod[] = [
  'standard',
  'basic',
  'combined',
  'igor',
  'multidirectional',
]

/** Parse a hillshade colour fragment (`#rrggbb` or a named colour) into a
 *  0..1 RGBA tuple. `resolveColor` maps named colours + hex-shorthand to a
 *  canonical hex; the converter always emits a validated lowercase hex, so
 *  the resolveColor path is the defensive fallback for a hand-authored
 *  `.xgis` source that used a colour name. */
function parseHillshadeColor(fragment: string): [number, number, number, number] | null {
  const hex = fragment.startsWith('#') ? fragment : resolveColor(fragment)
  if (!hex) return null
  return hexToRgba(hex)
}

// ── Utility-form arms (no binding) ──

/** All `hillshade-*` plain-utility arms. Longest-prefix names are matched
 *  first within this list (direction / altitude before the illumination
 *  anchor flag has no overlap; the three colour prefixes are disjoint). */
export const hillshadeConstUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('hillshade-illumination-direction-'),
    apply: (c) => {
      const n = parseFloat(c.name.slice('hillshade-illumination-direction-'.length))
      if (!isNaN(n)) c.acc.hillshadeDirection = n
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-illumination-altitude-'),
    apply: (c) => {
      const n = parseFloat(c.name.slice('hillshade-illumination-altitude-'.length))
      if (!isNaN(n)) c.acc.hillshadeAltitude = n
      return true
    },
  },
  {
    // hillshade-illumination-anchor = map → world-space (data) light anchor
    // flag. Emitted ONLY for anchor=map (viewport is the byte-identical
    // default that emits nothing). Mirror of raster-resampling-nearest.
    match: (c) => c.name === 'hillshade-illumination-anchor-map',
    apply: (c) => {
      c.acc.hillshadeAnchorMap = true
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-exaggeration-'),
    apply: (c) => {
      const n = parseFloat(c.name.slice('hillshade-exaggeration-'.length))
      if (!isNaN(n)) c.acc.hillshadeExaggeration = n
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-shadow-color-'),
    apply: (c) => {
      const rgba = parseHillshadeColor(c.name.slice('hillshade-shadow-color-'.length))
      if (rgba) c.acc.hillshadeShadow = rgba
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-highlight-color-'),
    apply: (c) => {
      const rgba = parseHillshadeColor(c.name.slice('hillshade-highlight-color-'.length))
      if (rgba) c.acc.hillshadeHighlight = rgba
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-accent-color-'),
    apply: (c) => {
      const rgba = parseHillshadeColor(c.name.slice('hillshade-accent-color-'.length))
      if (rgba) c.acc.hillshadeAccent = rgba
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('hillshade-method-'),
    apply: (c) => {
      const m = c.name.slice('hillshade-method-'.length)
      if ((HILLSHADE_METHODS as readonly string[]).includes(m)) {
        c.acc.hillshadeMethod = m as HillshadeMethod
      }
      return true
    },
  },
  {
    // resampling: nearest → nearest-filter the decoded DEM height field.
    // Emitted ONLY for nearest (linear is the byte-identical default).
    // Mirror of raster-resampling-nearest.
    match: (c) => c.name === 'hillshade-resampling-nearest',
    apply: (c) => {
      c.acc.hillshadeResamplingNearest = true
      return true
    },
  },
]
