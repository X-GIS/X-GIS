// ═══ IR types — hillshade / raster-dem concern (#777 Phase II) ═══
//
// The raster-dem SourceDef fields + the hillshade RenderNode paint bundle,
// factored out of render-node.ts to keep that god-file under its LOC ceiling
// (mirrors INC-1's paint-hillshade.ts / lower-bindings-hillshade.ts split). Both
// are type-only interfaces `render-node.ts` re-composes via `extends` — the
// `import type` keeps this a compile-time-erased dependency (no runtime cycle
// with property-types.ts, which the paint bundle references for HillshadeMethod).

import type { HillshadeMethod } from './property-types'

/** `type: raster-dem` DEM source fields, threaded from the source block so the
 *  (INC-3) hillshade renderer decodes elevation with the source's pack rule.
 *  Undefined for non-DEM sources. `SourceDef extends` this. */
export interface RasterDemSourceFields {
  /** DEM elevation-pack encoding — `'mapbox'` (default, Terrain-RGB),
   *  `'terrarium'` (Mapzen), or `'custom'` (the four factors below). */
  encoding?: string
  /** Native tile pixel size (256 / 512). Default 512. The DEM Sobel derivative
   *  scales by tileSize. */
  tileSize?: number
  /** `encoding: custom` elevation unpack factors:
   *  `elevation_m = R*redFactor + G*greenFactor + B*blueFactor - baseShift`
   *  (R/G/B in 0..255). Only meaningful when `encoding === 'custom'`. */
  redFactor?: number
  greenFactor?: number
  blueFactor?: number
  baseShift?: number
}

/** Hillshade DEM-relief paint axes (Mapbox `hillshade-*`). All fields are
 *  flat optional constants; an absent field means the layer didn't author
 *  that axis and the (INC-3) renderer falls back to the spec default
 *  (a no-op). Only the single-source constant form is plumbed — numberArray
 *  / colorArray multi-source (multidirectional) warns + drops at convert
 *  time. `RenderNode extends` this. Mirror of RenderNodeRasterPaint. */
export interface RenderNodeHillshadePaint {
  /** `hillshade-illumination-direction` — light azimuth (deg from N). Default 335. */
  hillshadeDirection?: number
  /** `hillshade-illumination-altitude` — light elevation (0–90°). Default 45. */
  hillshadeAltitude?: number
  /** `hillshade-illumination-anchor` = "map" flag. Default (unauthored /
   *  "viewport") = false, byte-identical to today. */
  hillshadeAnchorMap?: boolean
  /** `hillshade-exaggeration` — vertical-relief multiplier. Default 0.5. */
  hillshadeExaggeration?: number
  /** `hillshade-shadow-color` — shadow-side RGBA (0..1). Default #000000. */
  hillshadeShadow?: [number, number, number, number]
  /** `hillshade-highlight-color` — lit-side RGBA (0..1). Default #FFFFFF. */
  hillshadeHighlight?: [number, number, number, number]
  /** `hillshade-accent-color` — accent tint RGBA (0..1). Default #000000. */
  hillshadeAccent?: [number, number, number, number]
  /** `hillshade-method` — DEM gradient-shading algorithm. Default standard. */
  hillshadeMethod?: HillshadeMethod
  /** `resampling: nearest` flag. Default (unauthored / 'linear') = false. */
  hillshadeResamplingNearest?: boolean
}
